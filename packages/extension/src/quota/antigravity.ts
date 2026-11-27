/**
 * Antigravity（agy）订阅额度：
 * 仅通过官方 `agy -p /usage --output-format json` CLI 查询（严禁直连 `cloudcode-pa.googleapis.com`
 * 等内部 HTTP 接口），兼容系统 Keyring（macOS Keychain / Windows Credential Manager / Linux Secret
 * Service）、本地 OAuth 自动续期与企业/ADC 认证，并把 Gemini 池 / Claude+GPT 池 / 独立模型池的
 * 5 小时与每周窗口归一化成视图模型。
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuotaView, QuotaWindowView } from '@harness-deck/shared';
import { parseEpochMs, rec, roundPercent, type QuotaServiceOptions, type Rec } from './util.ts';

const GROUP_MODELS_PREFIX = /^Models within this group:\s*/iu;
/** 与其它提供方一致：成功结果缓存 5 分钟。 */
export const ANTIGRAVITY_CACHE_MS = 300_000;
const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER = 2 * 1024 * 1024;

interface InFlightQuotaResult {
  readonly view?: QuotaView;
  readonly reasons: readonly string[];
}

/** 成功结果按 CLI 路径 + `.gemini` 目录缓存；并发同 key 请求共享同一在途 Promise。 */
const cache = new Map<string, { readonly at: number; readonly value: QuotaView }>();
const inFlight = new Map<string, Promise<InFlightQuotaResult>>();
let cacheGeneration = 0;

export function clearAntigravityQuotaCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
}

function geminiDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), '.gemini');
}

/**
 * 标准共享池的 bucketId → Webview 侧翻译键；
 * 独立模型池（如 `gemini-argon-wtu-weekly` / `Gemini 4 Argon`）保留服务端分组名，避免与主 Gemini 池冲突。
 */
function poolLabel(bucketId: string, groupName: string, bucketDisplayName: string): string {
  if (/^3p-(?:5h|weekly)$/iu.test(bucketId)) return '3p';
  if (/^gemini-(?:5h|weekly)$/iu.test(bucketId)) return 'gemini';
  return groupName.trim() || bucketDisplayName.trim() || bucketId;
}

function readGroupModels(group: Rec | undefined): readonly string[] | undefined {
  if (Array.isArray(group?.models)) {
    const models = group.models.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
    if (models.length > 0) return models;
  }
  if (typeof group?.description !== 'string') return undefined;
  const trimmed = group.description.trim();
  if (!GROUP_MODELS_PREFIX.test(trimmed)) return undefined;
  const models = trimmed
    .replace(GROUP_MODELS_PREFIX, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return models.length > 0 ? models : undefined;
}

function readWindows(json: Rec): QuotaWindowView[] {
  const rawGroups = Array.isArray(json.groups) ? json.groups : [];
  const groups =
    rawGroups.length > 0
      ? rawGroups
      : Array.isArray(json.buckets) && json.buckets.length > 0
        ? [{ buckets: json.buckets }]
        : [];
  const seen = new Set<string>();
  const windows: QuotaWindowView[] = [];
  for (const rawGroup of groups) {
    const group = rec(rawGroup);
    const groupName =
      (typeof group?.displayName === 'string' && group.displayName) ||
      (typeof group?.name === 'string' && group.name) ||
      '';
    const models = readGroupModels(group);
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const rawBucket of buckets) {
      const bucket = rec(rawBucket);
      // 被限流时不生效的窗口（例如 weekly 打满后 5 小时窗口 disabled）不展示。
      if (bucket?.disabled === true) continue;
      const bucketId =
        (typeof bucket?.bucketId === 'string' && bucket.bucketId) ||
        (typeof bucket?.id === 'string' && bucket.id) ||
        '';
      const bucketDisplayName =
        (typeof bucket?.displayName === 'string' && bucket.displayName) ||
        (typeof bucket?.name === 'string' && bucket.name) ||
        '';
      const rawWindow =
        (typeof bucket?.window === 'string' && bucket.window) ||
        (typeof bucket?.refreshWindowLabel === 'string' && bucket.refreshWindowLabel) ||
        (typeof bucket?.refresh_window_label === 'string' && bucket.refresh_window_label) ||
        '';
      const rawResetTime = bucket?.resetTime ?? bucket?.reset_time;
      const rawFraction = bucket?.remainingFraction ?? bucket?.remaining_fraction;
      let fraction: number | undefined;
      if (typeof rawFraction === 'number' && Number.isFinite(rawFraction)) {
        fraction = rawFraction;
      } else if (rawFraction === undefined && bucketId && (rawWindow || rawResetTime !== undefined)) {
        // Go proto3 / encoding/json `omitempty` 在剩余额度恰好为 0 时会省略 remainingFraction / remaining_fraction
        fraction = 0;
      }
      if (fraction === undefined) continue;
      const remaining = Math.min(1, Math.max(0, fraction));
      const label = poolLabel(bucketId, groupName, bucketDisplayName);
      const kind = /week|7d/iu.test(rawWindow) || /weekly/iu.test(bucketId) ? 'weekly' : 'session';
      const key = `${kind}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const remainingPercent = roundPercent(remaining * 100);
      const usedPercent = roundPercent(100 - remainingPercent);
      // 未消耗额度（remainingFraction === 1）时服务端返回的是 `now + window` 的滑动占位时间，不展示倒计时。
      const resetsAt = remaining < 1 ? parseEpochMs(rawResetTime) : undefined;
      windows.push({
        kind,
        label,
        ...(models ? { models } : {}),
        usedPercent,
        remainingPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    }
  }
  return windows;
}

/** 解析 `agy -p /usage --output-format json` 的标准输出为统一 `QuotaView`。 */
export function parseAntigravityUsageCliOutput(stdout: string, now = Date.now()): QuotaView | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let root: Rec | undefined;
  try {
    root = rec(JSON.parse(trimmed));
  } catch {
    // 兼容前置/尾随日志行：从最后一行向前寻找合法 JSON 对象
    const lines = trimmed.split(/\r?\n/u);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line || !line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        const candidate = rec(JSON.parse(line));
        if (candidate && (candidate.command !== undefined || candidate.groups !== undefined || candidate.data !== undefined)) {
          root = candidate;
          break;
        }
      } catch {
        // ignore non-JSON line
      }
    }
  }
  if (!root) return undefined;
  if (typeof root.status === 'string' && root.status.toUpperCase() === 'ERROR') {
    return undefined;
  }
  const command = rec(root.command);
  const data = rec(command?.data) ?? rec(root.data) ?? root;
  const windows = readWindows(data);
  if (windows.length === 0) return undefined;
  return { windows, queriedAt: now };
}

async function hasAntigravityStateOnDisk(
  env: Readonly<Record<string, string | undefined>>,
  rawTokenJson?: string,
): Promise<boolean> {
  if (rawTokenJson?.trim()) return true;
  if (env.AGY_ADC_AUTH?.trim()) return true;
  try {
    await access(geminiDir(env));
    return true;
  } catch {
    return false;
  }
}

function defaultRunAgyUsageCli(options: {
  readonly command: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...options.env, NO_COLOR: '1' };
  return new Promise<string | undefined>((resolve, reject) => {
    execFile(
      options.command,
      ['-p', '/usage', '--output-format', 'json'],
      {
        cwd: tmpdir(),
        env,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BUFFER,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout));
      },
    );
  });
}

async function queryViaCli(params: {
  readonly cliCommand: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly runCliUsage?: QuotaServiceOptions['runCliUsage'];
  readonly onDebug?: (detail: string) => void;
}): Promise<QuotaView | undefined> {
  const { cliCommand, env, now, runCliUsage, onDebug } = params;
  const cliCacheKey = `cli:${cliCommand}\0${geminiDir(env)}`;
  const cached = cache.get(cliCacheKey);
  if (cached && now() - cached.at < ANTIGRAVITY_CACHE_MS) return cached.value;

  let pending = inFlight.get(cliCacheKey);
  if (!pending) {
    const generation = cacheGeneration;
    const runner = runCliUsage ?? defaultRunAgyUsageCli;
    let created: Promise<InFlightQuotaResult>;
    const run = async (): Promise<InFlightQuotaResult> => {
      const reasons: string[] = [];
      try {
        const stdout = await runner({ command: cliCommand, env });
        if (!stdout?.trim()) {
          reasons.push('cli-empty-output');
          return { reasons };
        }
        const view = parseAntigravityUsageCliOutput(stdout, now());
        if (!view) {
          reasons.push('cli-empty-windows');
          return { reasons };
        }
        if (generation === cacheGeneration) {
          cache.set(cliCacheKey, { at: now(), value: view });
        }
        return { view, reasons };
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
        reasons.push(code ? `cli-error-${code}` : 'cli-failed');
        return { reasons };
      }
    };
    created = run().finally(() => {
      if (inFlight.get(cliCacheKey) === created) {
        inFlight.delete(cliCacheKey);
      }
    });
    inFlight.set(cliCacheKey, created);
    pending = created;
  }

  const result = await pending;
  if (!result.view && onDebug) {
    for (const reason of result.reasons) onDebug(reason);
  }
  return result.view;
}

/** 查询 Antigravity 订阅额度；仅通过官方 `agy -p /usage --output-format json` CLI 获取。 */
export async function queryAntigravityQuota(options: QuotaServiceOptions = {}): Promise<QuotaView | undefined> {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const cliCommand = options.cliCommand?.trim();

  if (!cliCommand) {
    options.onDebug?.('cli-unavailable');
    return undefined;
  }

  if (!(await hasAntigravityStateOnDisk(env, options.rawTokenJson))) {
    options.onDebug?.('disk-token-missing');
    return undefined;
  }

  return await queryViaCli({
    cliCommand,
    env,
    now,
    ...(options.runCliUsage ? { runCliUsage: options.runCliUsage } : {}),
    ...(options.onDebug ? { onDebug: options.onDebug } : {}),
  });
}

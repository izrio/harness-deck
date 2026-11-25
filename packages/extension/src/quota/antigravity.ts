/**
 * Antigravity（agy）订阅额度：
 * 1. 优先读取 OAuth 凭据直连 Cloud Code `retrieveUserQuotaSummary`（低延迟、不启子进程）；
 * 2. 若凭据托管在系统 Keyring（macOS Keychain / Windows Credential Manager / Linux Secret Service）、
 *    本地 `access_token` 已过期需 CLI 自动续期、使用企业/ADC 认证或直连受限时，在调用方明确授予
 *    `cliCommand` 的前提下回退调用官方 `agy -p /usage --output-format json`，把 Gemini 池 /
 *    Claude+GPT 池 / 独立模型池的 5 小时与每周窗口归一化成视图模型。
 */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuotaView, QuotaWindowView } from '@harness-deck/shared';
import { createProxyAwareFetch } from '../providers/proxyFetch.ts';
import { parseEpochMs, rec, roundPercent, type QuotaServiceOptions, type Rec } from './util.ts';

const PRIMARY_HOST = 'https://daily-cloudcode-pa.googleapis.com';
const FALLBACK_HOST = 'https://cloudcode-pa.googleapis.com';
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
/** 服务端按 User-Agent 的 CLI 版本做分组门控；缺少版本时只返回 3p 池，漏掉 Gemini 与独立模型池。 */
const DEFAULT_CLI_VERSION = '1.5.14';
const GROUP_MODELS_PREFIX = /^Models within this group:\s*/iu;
/** 与其它提供方一致：成功结果缓存 5 分钟。 */
export const ANTIGRAVITY_CACHE_MS = 300_000;
const TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 30_000;
const CLI_MAX_BUFFER = 2 * 1024 * 1024;
const CREDENTIAL_FILES = ['antigravity-cli/antigravity-oauth-token', 'jetski-standalone-oauth-token'] as const;

interface InFlightQuotaResult {
  readonly view?: QuotaView;
  readonly reasons: readonly string[];
}

/** 成功结果按 token+UA 缓存（token 只作内存 key）；并发同 key 请求共享同一在途 Promise。 */
const cache = new Map<string, { readonly at: number; readonly value: QuotaView }>();
const inFlight = new Map<string, Promise<InFlightQuotaResult>>();
let cacheGeneration = 0;

export function clearAntigravityQuotaCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
}

function userAgent(clientVersion?: string): string {
  const version = clientVersion?.trim();
  return `antigravity/cli/${version && /^\d+\.\d+/u.test(version) ? version : DEFAULT_CLI_VERSION}`;
}

function geminiDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), '.gemini');
}

type TokenParseResult =
  | { readonly kind: 'valid'; readonly accessToken: string }
  | { readonly kind: 'present-unusable'; readonly reason: 'expired' | 'missing-access' }
  | { readonly kind: 'invalid' };

/** 从单份 Antigravity OAuth 凭据 JSON 提取未过期的 access_token；返回状态以区分「有效/过期/缺少access_token/无结构」。 */
function parseAccessTokenFromRaw(raw: string, now: number): TokenParseResult {
  let json: Rec | undefined;
  try {
    json = rec(JSON.parse(raw));
  } catch {
    return { kind: 'invalid' };
  }
  const token = rec(json?.token);
  if (!token) return { kind: 'invalid' };
  const accessToken = token.access_token;
  const refreshToken =
    (typeof token.refresh_token === 'string' && token.refresh_token.trim()) ||
    (typeof token.refreshToken === 'string' && token.refreshToken.trim()) ||
    (typeof json?.refresh_token === 'string' && json.refresh_token.trim()) ||
    (typeof json?.refreshToken === 'string' && json.refreshToken.trim()) ||
    '';
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    return refreshToken ? { kind: 'present-unusable', reason: 'missing-access' } : { kind: 'invalid' };
  }
  const expiry = parseEpochMs(token.expiry);
  if (expiry !== undefined && expiry <= now) {
    return { kind: 'present-unusable', reason: 'expired' };
  }
  return { kind: 'valid', accessToken: accessToken.trim() };
}

/** 依次尝试 CLI / IDE 的凭据文件；若 CLI 主凭据文件存在且含有效结构但 access_token 已过期，不回退 IDE 凭据以免多账号切换时串号。 */
async function readAccessToken(
  env: Readonly<Record<string, string | undefined>>,
  now: number,
  allowIdeFallback = true,
  onDebug?: (detail: string) => void,
): Promise<string | undefined> {
  const files = allowIdeFallback ? CREDENTIAL_FILES : [CREDENTIAL_FILES[0]];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    let raw: string;
    try {
      raw = await readFile(join(geminiDir(env), file), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseAccessTokenFromRaw(raw, now);
    if (parsed.kind === 'valid') return parsed.accessToken;
    if (i === 0 && parsed.kind === 'present-unusable') {
      onDebug?.(parsed.reason === 'expired' ? 'disk-primary-expired' : 'disk-primary-missing-access');
      return undefined;
    }
  }
  onDebug?.('disk-token-missing');
  return undefined;
}

/** 主域失败时重试备用域；任何失败都返回 undefined 并记录非敏感诊断原因。 */
async function requestQuota(
  fetchFn: ReturnType<typeof createProxyAwareFetch>,
  token: string,
  ua: string,
  onDebug?: (detail: string) => void,
): Promise<Rec | undefined> {
  for (const host of [PRIMARY_HOST, FALLBACK_HOST]) {
    try {
      const response = await fetchFn(`${host}${QUOTA_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': ua,
        },
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        onDebug?.(`${host} http-${response.status}`);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const json = rec(await response.json());
      if (json) return json;
      onDebug?.(`${host} invalid-json`);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      onDebug?.(`${host} ${msg}`);
    }
  }
  return undefined;
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

async function queryViaCliFallback(params: {
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

/** 查询 Antigravity 订阅额度；直连 OAuth 优先，不可用且传入 `cliCommand` 时回退官方 `agy -p /usage --output-format json`。 */
export async function queryAntigravityQuota(options: QuotaServiceOptions = {}): Promise<QuotaView | undefined> {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const cliCommand = options.cliCommand?.trim();

  // 若先前已通过 CLI 回退拿到有效缓存且当前未命中有效直连 token，直接复用 5 分钟缓存避免重复检测
  const debugReasons: string[] = [];
  const collectDebug = (detail: string): void => {
    debugReasons.push(detail);
  };

  let token: string | undefined;
  if (options.rawTokenJson !== undefined) {
    const parsed = parseAccessTokenFromRaw(options.rawTokenJson, now());
    if (parsed.kind === 'valid') {
      token = parsed.accessToken;
    } else if (parsed.kind === 'present-unusable') {
      collectDebug(`raw-token-${parsed.reason}`);
    } else {
      collectDebug('raw-token-invalid');
    }
  } else {
    token = await readAccessToken(env, now(), options.allowIdeFallback !== false, collectDebug);
  }

  if (token) {
    const ua = userAgent(options.clientVersion);
    const cacheKey = `${token}\0${ua}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.at < ANTIGRAVITY_CACHE_MS) return cached.value;

    let pending = inFlight.get(cacheKey);
    if (!pending) {
      const fetchFn = options.fetchImpl ?? createProxyAwareFetch(options.getHttpProxy);
      const generation = cacheGeneration;
      let created: Promise<InFlightQuotaResult>;
      const run = async (): Promise<InFlightQuotaResult> => {
        const reasons: string[] = [];
        const json = await requestQuota(fetchFn, token, ua, (detail) => reasons.push(detail));
        if (!json) return { reasons };
        const windows = readWindows(json);
        if (windows.length === 0) {
          reasons.push('empty-windows');
          return { reasons };
        }
        const view: QuotaView = { windows, queriedAt: now() };
        if (generation === cacheGeneration) {
          cache.set(cacheKey, { at: now(), value: view });
        }
        return { view, reasons };
      };
      created = run().finally(() => {
        if (inFlight.get(cacheKey) === created) {
          inFlight.delete(cacheKey);
        }
      });
      inFlight.set(cacheKey, created);
      pending = created;
    }

    const result = await pending;
    if (result.view) return result.view;
    debugReasons.push(...result.reasons);
  }

  if (cliCommand && (await hasAntigravityStateOnDisk(env, options.rawTokenJson))) {
    const cliView = await queryViaCliFallback({
      cliCommand,
      env,
      now,
      ...(options.runCliUsage ? { runCliUsage: options.runCliUsage } : {}),
      onDebug: collectDebug,
    });
    if (cliView) return cliView;
  }

  if (options.onDebug) {
    for (const reason of debugReasons) options.onDebug(reason);
  }
  return undefined;
}

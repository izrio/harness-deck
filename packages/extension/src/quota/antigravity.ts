/**
 * Antigravity（agy）订阅额度：读取 Antigravity CLI 落盘的 OAuth 凭据，
 * 调用 Cloud Code 的 `retrieveUserQuotaSummary`，把 Gemini 池 / Claude+GPT 池的
 * 5 小时与每周窗口归一化成视图模型。
 *
 * 凭据：`~/.gemini/antigravity-cli/antigravity-oauth-token`（CLI 登录），
 *       备用 `~/.gemini/jetski-standalone-oauth-token`（IDE 登录）。
 * 约定：只读不写、不自行刷新 token；过期即视为不可用，提示用户重新运行 `agy`。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { QuotaView, QuotaWindowView } from '@harness-deck/shared';
import { createProxyAwareFetch } from '../providers/proxyFetch.ts';
import { parseEpochMs, rec, roundPercent, type QuotaServiceOptions, type Rec } from './util.ts';

const PRIMARY_HOST = 'https://daily-cloudcode-pa.googleapis.com';
const FALLBACK_HOST = 'https://cloudcode-pa.googleapis.com';
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
/** 服务端按 User-Agent 的 CLI 版本做分组门控；缺少版本时只返回 3p 池，漏掉 Gemini 与独立模型池。 */
const DEFAULT_CLI_VERSION = '1.5.13';
const GROUP_MODELS_PREFIX = /^Models within this group:\s*/iu;
/** 与其它提供方一致：成功结果缓存 5 分钟。 */
export const ANTIGRAVITY_CACHE_MS = 300_000;
const TIMEOUT_MS = 20_000;
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
  const groups = Array.isArray(json.groups) ? json.groups : [];
  const seen = new Set<string>();
  const windows: QuotaWindowView[] = [];
  for (const rawGroup of groups) {
    const group = rec(rawGroup);
    const groupName = typeof group?.displayName === 'string' ? group.displayName : '';
    const models = readGroupModels(group);
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const rawBucket of buckets) {
      const bucket = rec(rawBucket);
      // 被限流时不生效的窗口（例如 weekly 打满后 5 小时窗口 disabled）不展示。
      if (bucket?.disabled === true) continue;
      const fraction = bucket?.remainingFraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue;
      const remaining = Math.min(1, Math.max(0, fraction));
      const bucketId = typeof bucket?.bucketId === 'string' ? bucket.bucketId : '';
      const bucketDisplayName = typeof bucket?.displayName === 'string' ? bucket.displayName : '';
      const label = poolLabel(bucketId, groupName, bucketDisplayName);
      const kind = bucket?.window === 'weekly' ? 'weekly' : 'session';
      const key = `${kind}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const remainingPercent = roundPercent(remaining * 100);
      const usedPercent = roundPercent(100 - remainingPercent);
      // 未消耗额度（remainingFraction === 1）时服务端返回的是 `now + window` 的滑动占位时间，不展示倒计时。
      const resetsAt = remaining < 1 ? parseEpochMs(bucket?.resetTime) : undefined;
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

/** 查询 Antigravity 订阅额度；无凭据、凭据过期、请求失败或无有效窗口都返回 undefined。 */
export async function queryAntigravityQuota(options: QuotaServiceOptions = {}): Promise<QuotaView | undefined> {
  const now = options.now ?? Date.now;
  let token: string | undefined;
  if (options.rawTokenJson !== undefined) {
    const parsed = parseAccessTokenFromRaw(options.rawTokenJson, now());
    if (parsed.kind === 'valid') {
      token = parsed.accessToken;
    } else if (parsed.kind === 'present-unusable') {
      options.onDebug?.(`raw-token-${parsed.reason}`);
    } else {
      options.onDebug?.('raw-token-invalid');
    }
  } else {
    token = await readAccessToken(options.env ?? process.env, now(), options.allowIdeFallback !== false, options.onDebug);
  }
  if (!token) return undefined;

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
  if (!result.view && options.onDebug) {
    for (const reason of result.reasons) options.onDebug(reason);
  }
  return result.view;
}

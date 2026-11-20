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
const TIMEOUT_MS = 10_000;
const CREDENTIAL_FILES = ['antigravity-cli/antigravity-oauth-token', 'jetski-standalone-oauth-token'] as const;

/** 成功结果按 token+UA 缓存（token 只作内存 key）。 */
const cache = new Map<string, { readonly at: number; readonly value: QuotaView }>();

export function clearAntigravityQuotaCache(): void {
  cache.clear();
}

function userAgent(clientVersion?: string): string {
  const version = clientVersion?.trim();
  return `antigravity/cli/${version && /^\d+\.\d+/u.test(version) ? version : DEFAULT_CLI_VERSION}`;
}

function geminiDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.HOME ?? env.USERPROFILE ?? homedir(), '.gemini');
}

/** 依次尝试 CLI / IDE 的凭据文件；过期或缺失时跳过。 */
async function readAccessToken(env: Readonly<Record<string, string | undefined>>, now: number): Promise<string | undefined> {
  for (const file of CREDENTIAL_FILES) {
    let raw: string;
    try {
      raw = await readFile(join(geminiDir(env), file), 'utf8');
    } catch {
      continue;
    }
    let json: Rec | undefined;
    try {
      json = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    const token = rec(json?.token);
    const accessToken = token?.access_token;
    if (typeof accessToken !== 'string' || !accessToken.trim()) continue;
    const expiry = parseEpochMs(token?.expiry);
    if (expiry !== undefined && expiry <= now) continue;
    return accessToken.trim();
  }
  return undefined;
}

/** 主域失败时重试备用域；任何失败都返回 undefined。 */
async function requestQuota(
  fetchFn: ReturnType<typeof createProxyAwareFetch>,
  token: string,
  ua: string,
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
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const json = rec(await response.json());
      if (json) return json;
    } catch {
      // 换下一个域重试
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
  const token = await readAccessToken(options.env ?? process.env, now());
  if (!token) return undefined;

  const ua = userAgent(options.clientVersion);
  const cacheKey = `${token}\0${ua}`;
  const cached = cache.get(cacheKey);
  if (cached && now() - cached.at < ANTIGRAVITY_CACHE_MS) return cached.value;

  const fetchFn = options.fetchImpl ?? createProxyAwareFetch(options.getHttpProxy);
  const json = await requestQuota(fetchFn, token, ua);
  if (!json) return undefined;
  const windows = readWindows(json);
  if (windows.length === 0) return undefined;

  const view: QuotaView = { windows, queriedAt: now() };
  cache.set(cacheKey, { at: now(), value: view });
  return view;
}

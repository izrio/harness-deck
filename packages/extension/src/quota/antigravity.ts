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
/** 与其它提供方一致：成功结果缓存 5 分钟。 */
export const ANTIGRAVITY_CACHE_MS = 300_000;
const TIMEOUT_MS = 10_000;
const CREDENTIAL_FILES = ['antigravity-cli/antigravity-oauth-token', 'jetski-standalone-oauth-token'] as const;

/** 成功结果按 token 缓存（token 只作内存 key）。 */
const cache = new Map<string, { readonly at: number; readonly value: QuotaView }>();

export function clearAntigravityQuotaCache(): void {
  cache.clear();
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
async function requestQuota(fetchFn: ReturnType<typeof createProxyAwareFetch>, token: string): Promise<Rec | undefined> {
  for (const host of [PRIMARY_HOST, FALLBACK_HOST]) {
    try {
      const response = await fetchFn(`${host}${QUOTA_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'antigravity',
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

/** bucketId 前缀 → Webview 侧翻译用的池标识。 */
function poolLabel(bucketId: string, groupName: string): string {
  if (bucketId.startsWith('3p')) return '3p';
  if (bucketId.startsWith('gemini')) return 'gemini';
  return groupName;
}

function readWindows(json: Rec): QuotaWindowView[] {
  const groups = Array.isArray(json.groups) ? json.groups : [];
  const seen = new Set<string>();
  const windows: QuotaWindowView[] = [];
  for (const rawGroup of groups) {
    const group = rec(rawGroup);
    const groupName = typeof group?.displayName === 'string' ? group.displayName : '';
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const rawBucket of buckets) {
      const bucket = rec(rawBucket);
      // 被限流时不生效的窗口（例如 weekly 打满后 5 小时窗口 disabled）不展示。
      if (bucket?.disabled === true) continue;
      const fraction = bucket?.remainingFraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue;
      const remaining = Math.min(1, Math.max(0, fraction));
      const bucketId = typeof bucket?.bucketId === 'string' ? bucket.bucketId : '';
      const label = poolLabel(bucketId, groupName);
      const kind = bucket?.window === 'weekly' ? 'weekly' : 'session';
      const key = `${kind}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const usedPercent = roundPercent((1 - remaining) * 100);
      const resetsAt = parseEpochMs(bucket?.resetTime);
      windows.push({
        kind,
        label,
        usedPercent,
        remainingPercent: roundPercent(100 - usedPercent),
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

  const cached = cache.get(token);
  if (cached && now() - cached.at < ANTIGRAVITY_CACHE_MS) return cached.value;

  const fetchFn = options.fetchImpl ?? createProxyAwareFetch(options.getHttpProxy);
  const json = await requestQuota(fetchFn, token);
  if (!json) return undefined;
  const windows = readWindows(json);
  if (windows.length === 0) return undefined;

  const view: QuotaView = { windows, queriedAt: now() };
  cache.set(token, { at: now(), value: view });
  return view;
}

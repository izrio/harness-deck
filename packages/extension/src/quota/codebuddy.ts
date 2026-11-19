/**
 * CodeBuddy 订阅额度：用控制台会话 Cookie 调用计费接口。
 *
 * CodeBuddy CLI 的登录令牌保存在系统钥匙串 / 加密存储里，插件无法读取，因此这里只支持
 * 用户手动提供控制台 Cookie（与社区工具一致）：
 *   1. 环境变量 `CODEBUDDY_COOKIE`
 *   2. 文件 `~/.codebuddy/usage-cookie`
 * Cookie 从 `https://www.codebuddy.cn/profile/usage` 的 DevTools 复制（至少含 `session`、`session_2`）。
 * 没配置或查询失败时不返回数据，前端据此隐藏用量标识。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { QuotaView, QuotaWindowView } from '@harness-deck/shared';
import { createProxyAwareFetch } from '../providers/proxyFetch.ts';
import { normalizeUtilization, parseEpochMs, rec, roundPercent, type QuotaServiceOptions, type Rec } from './util.ts';

const DOMESTIC_BASE = 'https://www.codebuddy.cn';
const INTERNATIONAL_BASE = 'https://www.codebuddy.ai';
/** CLI 的 internal 区域（`CODEBUDDY_INTERNET_ENVIRONMENT=internal`）走腾讯云入口。 */
const INTERNAL_BASE = 'https://copilot.tencent.com';
/** 计费网关要求浏览器 UA，普通 UA 会直接 401。 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const CODEBUDDY_CACHE_MS = 300_000;
const TIMEOUT_MS = 10_000;

const cache = new Map<string, { readonly at: number; readonly value: QuotaView }>();

export function clearCodebuddyQuotaCache(): void {
  cache.clear();
}

/** 环境变量优先，其次数据目录里的 cookie 文件；裸值自动补 `session=`。 */
async function readCookie(env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  let raw = env.CODEBUDDY_COOKIE?.trim();
  if (!raw) {
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    raw = await readFile(join(home, '.codebuddy', 'usage-cookie'), 'utf8')
      .then((text) => text.trim())
      .catch(() => undefined);
  }
  if (!raw) return undefined;
  return raw.includes('=') ? raw : `session=${raw}`;
}

function baseUrls(env: Readonly<Record<string, string | undefined>>): string[] {
  const explicit = env.CODEBUDDY_BASE_URL?.trim();
  if (explicit) return [explicit.replace(/\/+$/u, '')];
  const list: string[] = [];
  if ((env.CODEBUDDY_INTERNET_ENVIRONMENT ?? '').trim().toLowerCase() === 'internal') list.push(INTERNAL_BASE);
  list.push(DOMESTIC_BASE, INTERNATIONAL_BASE);
  return [...new Set(list)];
}

function headers(cookie: string): Record<string, string> {
  return { accept: 'application/json', cookie, 'user-agent': BROWSER_UA, 'content-type': 'application/json' };
}

function pickNumber(source: Rec | undefined, keys: readonly string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function pickEpoch(source: Rec | undefined, ...keys: readonly string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const parsed = parseEpochMs(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** 一组用量里的已用百分比：优先直接给百分比，否则按 已用/总量 或 剩余/总量 换算。 */
function readPercent(source: Rec): number | undefined {
  const direct = normalizeUtilization(
    source.usedPercent ?? source.used_percent ?? source.usagePercent ?? source.usage_percent ?? source.percent ?? source.utilization,
  );
  if (direct !== undefined) return direct;
  const total = pickNumber(source, ['total', 'totalCredits', 'total_credits', 'quota', 'limit', 'totalQuota', 'total_amount']);
  if (total === undefined || total <= 0) return undefined;
  const used = pickNumber(source, ['used', 'usedCredits', 'used_credits', 'usage', 'usedQuota', 'used_amount']);
  if (used !== undefined) return roundPercent((used / total) * 100);
  const remaining = pickNumber(source, ['remaining', 'remainingCredits', 'remaining_credits', 'left', 'available', 'remain']);
  if (remaining !== undefined) return roundPercent((1 - remaining / total) * 100);
  return undefined;
}

function windowFrom(source: Rec, label: string, now: number, skipExpired: boolean): QuotaWindowView | undefined {
  const usedPercent = readPercent(source);
  if (usedPercent === undefined) return undefined;
  const resetsAt = pickEpoch(source, 'resetTime', 'reset_at', 'resetAt', 'expire', 'expiresAt', 'expire_time', 'expires_at', 'endTime', 'end_time');
  if (skipExpired && resetsAt !== undefined && resetsAt <= now) return undefined;
  return {
    kind: 'cycle',
    label,
    usedPercent,
    remainingPercent: roundPercent(100 - usedPercent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function readName(source: Rec): string {
  for (const key of ['name', 'packageName', 'package_name', 'title', 'displayName', 'display_name']) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 宽容解析计费响应：响应结构没有公开文档，顶层和 `data` 里都可能放字段；
 * 周期包数组（`packages` / `periods` / `resources`）里有命名条目时追加对应窗口，过期的跳过。
 */
function readWindows(json: Rec, now: number): QuotaWindowView[] {
  const roots: Rec[] = [json];
  const data = json.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = rec(item);
      if (r) roots.push(r);
    }
  } else {
    const r = rec(data);
    if (r) roots.push(r);
  }

  const seen = new Set<string>();
  const windows: QuotaWindowView[] = [];
  const add = (w: QuotaWindowView | undefined) => {
    if (!w || seen.has(w.label)) return;
    seen.add(w.label);
    windows.push(w);
  };

  for (const root of roots) add(windowFrom(root, '', now, false));
  for (const root of roots) {
    for (const key of ['packages', 'periods', 'resources']) {
      const list = root[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const r = rec(item);
        if (!r) continue;
        add(windowFrom(r, readName(r), now, true));
      }
    }
  }
  return windows;
}

function extractEnterpriseId(raw: unknown): string | undefined {
  const o = rec(raw);
  if (!o) return undefined;
  for (const key of ['enterpriseId', 'enterprise_id']) {
    const value = o[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const first = Array.isArray(o.data) ? rec(o.data[0]) : undefined;
  for (const key of ['enterpriseId', 'enterprise_id', 'id']) {
    const value = first?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const id = o.id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

async function queryBase(
  fetchFn: ReturnType<typeof createProxyAwareFetch>,
  base: string,
  cookie: string,
  now: number,
): Promise<QuotaView | undefined> {
  let enterpriseId: string | undefined;
  try {
    const response = await fetchFn(`${base}/console/accounts`, {
      method: 'GET',
      headers: headers(cookie),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) enterpriseId = extractEnterpriseId(await response.json());
    else await response.body?.cancel().catch(() => undefined);
  } catch {
    // 企业列表只是补充信息，失败时继续用不带 enterpriseId 的请求
  }

  try {
    const response = await fetchFn(`${base}/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify(enterpriseId ? { enterpriseId } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const json = rec(await response.json());
    if (!json) return undefined;
    const windows = readWindows(json, now);
    if (windows.length === 0) return undefined;
    return { windows, queriedAt: now };
  } catch {
    return undefined;
  }
}

/** 查询 CodeBuddy 订阅额度；没配 Cookie 或所有区域都查不到时返回 undefined。 */
export async function queryCodebuddyQuota(options: QuotaServiceOptions = {}): Promise<QuotaView | undefined> {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const cookie = await readCookie(env);
  if (!cookie) return undefined;

  const cached = cache.get(cookie);
  if (cached && now() - cached.at < CODEBUDDY_CACHE_MS) return cached.value;

  const fetchFn = options.fetchImpl ?? createProxyAwareFetch(options.getHttpProxy);
  for (const base of baseUrls(env)) {
    const view = await queryBase(fetchFn, base, cookie, now());
    if (view) {
      cache.set(cookie, { at: now(), value: view });
      return view;
    }
  }
  return undefined;
}

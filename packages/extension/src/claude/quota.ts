/**
 * Claude 官方订阅额度查询：读取本机 Claude Code 的 OAuth 凭据，调用 `/api/oauth/usage`，
 * 把 5 小时 / 每周（含按模型的每周）窗口归一化成视图模型，供 Webview 的用量标识展示。
 *
 * 安全约定：token 只在本模块内读取并放进 Authorization 头；不进日志、不进视图模型、不发往 Webview。
 * 不自行刷新 token（刷新会让命令行里的 Claude Code 凭据失配），过期或失效时直接视为查不到。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaView, QuotaWindowView } from '@harness-deck/shared';
import { createProxyAwareFetch } from '../providers/proxyFetch.ts';
import type { QuotaServiceOptions } from '../quota/util.ts';
import { resolveClaudeConfigDir } from './sessions.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** 过快轮询可能被服务端限流，成功后缓存 5 分钟。 */
export const QUOTA_CACHE_MS = 300_000;
const TIMEOUT_MS = 10_000;

type Rec = Record<string, unknown>;

export type { QuotaServiceOptions };

/** 成功结果按 token 缓存（token 只作内存 key，不出现在返回值里）。 */
const cache = new Map<string, { readonly at: number; readonly value: QuotaView }>();

export function clearQuotaCache(): void {
  cache.clear();
}

const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined);

/** 兼容 0–1 的比例与 0–100 的百分数，钳制到 0–100 并保留一位小数。 */
function normalizeUtilization(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  const percent = raw <= 1 ? raw * 100 : raw;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

function parseEpochMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function makeWindow(kind: QuotaWindowView['kind'], label: string, raw: unknown): QuotaWindowView | undefined {
  const o = rec(raw);
  const usedPercent = normalizeUtilization(o?.percent ?? o?.utilization);
  if (usedPercent === undefined) return undefined;
  const severityValue = o?.severity;
  const severity = severityValue === 'warning' || severityValue === 'critical' || severityValue === 'normal' ? severityValue : undefined;
  return {
    kind,
    label,
    usedPercent,
    remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
    ...(o ? { resetsAt: parseEpochMs(o.resets_at), severity, isActive: typeof o.is_active === 'boolean' ? o.is_active : undefined } : {}),
  };
}

/** 顶层字段可能带 undefined；避免把 `severity: undefined` 等写进视图模型。 */
function compactWindow(w: QuotaWindowView): QuotaWindowView {
  return {
    kind: w.kind,
    label: w.label,
    usedPercent: w.usedPercent,
    remainingPercent: w.remainingPercent,
    ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
    ...(w.severity !== undefined ? { severity: w.severity } : {}),
    ...(w.isActive !== undefined ? { isActive: w.isActive } : {}),
  };
}

/** 新结构优先（limits[]），没有可用条目时回退旧的平铺字段。 */
function readWindows(json: Rec): QuotaWindowView[] {
  const seen = new Set<string>();
  const windows: QuotaWindowView[] = [];
  const add = (w: QuotaWindowView | undefined) => {
    if (!w) return;
    const key = `${w.kind}:${w.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    windows.push(compactWindow(w));
  };

  const limits = Array.isArray(json.limits) ? json.limits : [];
  for (const raw of limits) {
    const o = rec(raw);
    const kind = o?.kind;
    if (kind === 'session') add(makeWindow('session', '', o));
    else if (kind === 'weekly_all') add(makeWindow('weekly', '', o));
    else if (kind === 'weekly_scoped') {
      const displayName = rec(rec(o?.scope)?.model)?.display_name;
      add(makeWindow('weeklyModel', typeof displayName === 'string' ? displayName : '', o));
    }
  }
  if (windows.length === 0) {
    add(makeWindow('session', '', json.five_hour));
    add(makeWindow('weekly', '', json.seven_day));
    add(makeWindow('weeklyModel', 'Opus', json.seven_day_opus));
    add(makeWindow('weeklyModel', 'Sonnet', json.seven_day_sonnet));
  }
  return windows;
}

async function readOfficialToken(env: Readonly<Record<string, string | undefined>>, now: number): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(resolveClaudeConfigDir(env), '.credentials.json'), 'utf8');
  } catch {
    return undefined;
  }
  let json: Rec | undefined;
  try {
    json = rec(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const oauth = rec(json?.claudeAiOauth);
  if (!oauth || typeof oauth.subscriptionType !== 'string' || !oauth.subscriptionType.trim()) return undefined;
  const expiresAt = parseEpochMs(oauth.expiresAt);
  if (expiresAt === undefined || expiresAt <= now) return undefined;
  const token = oauth.accessToken;
  return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

/** 查询官方订阅额度；任何凭据缺失、请求失败或结构无法识别都返回 undefined（前端据此隐藏标识）。 */
export async function queryClaudeQuota(options: QuotaServiceOptions = {}): Promise<QuotaView | undefined> {
  const now = options.now ?? Date.now;
  const token = await readOfficialToken(options.env ?? process.env, now());
  if (!token) return undefined;

  const cached = cache.get(token);
  if (cached && now() - cached.at < QUOTA_CACHE_MS) return cached.value;

  const fetchFn = options.fetchImpl ?? createProxyAwareFetch(options.getHttpProxy);
  let response: Response;
  try {
    response = await fetchFn(USAGE_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-code/',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }

  let json: Rec | undefined;
  try {
    json = rec(await response.json());
  } catch {
    return undefined;
  }
  if (!json) return undefined;
  const windows = readWindows(json);
  if (windows.length === 0) return undefined;

  const extra = rec(json.extra_usage) ?? rec(json.extraUsage);
  const extraPercent = extra?.is_enabled === false ? undefined : normalizeUtilization(extra?.utilization);
  const view: QuotaView = {
    windows,
    ...(extraPercent !== undefined
      ? { extraUsage: { usedPercent: extraPercent, remainingPercent: Math.round((100 - extraPercent) * 10) / 10 } }
      : {}),
    queriedAt: now(),
  };
  cache.set(token, { at: now(), value: view });
  return view;
}

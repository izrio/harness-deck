/**
 * 订阅额度查询的公共工具：解析凭据里的时间、归一百分比。
 * 各提供方服务（claude / antigravity / codebuddy）共用这些纯函数。
 */
import type { FetchLike } from '../providers/proxyFetch.ts';

export type Rec = Record<string, unknown>;

export interface QuotaServiceOptions {
  /** 环境变量（测试里可注入临时 HOME / 区域 / Cookie）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly getHttpProxy?: () => string | undefined;
  /** 已探测到的底层 CLI 版本号（例如 Antigravity 的 `1.5.13`，用于构造合规的 User-Agent）。 */
  readonly clientVersion?: string;
  /** 注入 fetch 实现（测试用），默认按宿主代理配置创建。 */
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  /** 直接传入该账号槽位的 OAuth 凭据 JSON（例如 Antigravity 多账号切换时避免误读磁盘或 IDE 备用凭据）。 */
  readonly rawTokenJson?: string;
  /** 读取 Antigravity 磁盘凭据时是否允许回退 IDE 独立凭据文件（多账号隔离时应为 false）。 */
  readonly allowIdeFallback?: boolean;
  /** 非敏感失败原因诊断回调（严禁包含任何 token / cookie / 认证头原文）。 */
  readonly onDebug?: (detail: string) => void;
}

export const rec = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;

/** 把 epoch 秒 / 毫秒 / RFC3339（含纳秒）统一解析成 epoch ms。 */
export function parseEpochMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string' && raw.trim()) {
    // Antigravity 的 expiry 带纳秒（2026-11-19T23:22:39.239248724+08:00），V8 只认到毫秒，先截断。
    const trimmed = raw.trim().replace(/(\.\d{3})\d+/u, '$1');
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 0–100 之间保留一位小数。 */
export function roundPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** 兼容 0–1 的比例与 0–100 的百分数。 */
export function normalizeUtilization(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return roundPercent(raw <= 1 ? raw * 100 : raw);
}

/**
 * 官方账号池与智能体渠道路由（官方渠道 ↔ 第三方服务商）的纯逻辑存储层。
 *
 * 安全约束：
 * - 写入 `harnessDeck.accounts` 的只包含非敏感元数据（id、backendId、label、isolateSessions、region、createdAt）。
 * - 所有 API Key、Usage Cookie、Antigravity 凭据槽位快照全部存于宿主 SecretStorage，绝不进入设置文件。
 */
import { randomUUID } from 'node:crypto';
import type {
  AccountConfig,
  AccountRegion,
  BackendChannelBinding,
  ProviderConfig,
} from '@harness-deck/shared';
import { providerForBackend } from '../providers/ProviderStore.ts';

export const ACCOUNT_API_KEY_SECRET_PREFIX = 'harnessDeck.account.apiKey.';
export const ACCOUNT_COOKIE_SECRET_PREFIX = 'harnessDeck.account.usageCookie.';
export const ACCOUNT_SLOT_SECRET_PREFIX = 'harnessDeck.account.slot.';
export const SYSTEM_ACCOUNT_PREFIX = 'system:';

export function systemAccountId(backendId: string): string {
  return `${SYSTEM_ACCOUNT_PREFIX}${backendId}`;
}

export function isSystemAccountId(accountId: string | undefined): boolean {
  return typeof accountId === 'string' && accountId.startsWith(SYSTEM_ACCOUNT_PREFIX);
}

export function accountApiKeySecretKey(accountId: string): string {
  return `${ACCOUNT_API_KEY_SECRET_PREFIX}${accountId}`;
}

export function accountCookieSecretKey(accountId: string): string {
  return `${ACCOUNT_COOKIE_SECRET_PREFIX}${accountId}`;
}

export function accountSlotSecretKey(accountId: string): string {
  return `${ACCOUNT_SLOT_SECRET_PREFIX}${accountId}`;
}

export function normalizeAccountId(rawId: string): string {
  return rawId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function cleanRegion(raw: unknown): AccountRegion | undefined {
  return raw === 'cn' || raw === 'ai' || raw === 'internal' ? raw : undefined;
}

export function cleanTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 40))
        .filter(Boolean),
    ),
  ).slice(0, 12);
  return out.length > 0 ? out : undefined;
}

export function cleanNotes(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().slice(0, 300);
  return trimmed || undefined;
}

/** 脱敏展示密钥（如 `sk-12...abcd`），绝不泄露完整内容。 */
export function maskSecretValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return '••••••••';
  const head = trimmed.slice(0, Math.min(6, Math.floor(trimmed.length / 3)));
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

/** 解析设置 `harnessDeck.accounts` 中的官方账号配置列表。 */
export function parseAccountsSetting(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AccountConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const backendId = typeof obj.backendId === 'string' ? obj.backendId.trim() : '';
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    if (!backendId || !label) continue;
    const rawId = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : '';
    const id = rawId && !isSystemAccountId(rawId) ? normalizeAccountId(rawId) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const isolateSessions = obj.isolateSessions === true ? true : undefined;
    const region = cleanRegion(obj.region);
    const tags = cleanTags(obj.tags);
    const notes = cleanNotes(obj.notes);
    const disabled = obj.disabled === true ? true : undefined;
    const createdAt =
      typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) && obj.createdAt > 0
        ? Math.round(obj.createdAt)
        : Date.now();
    out.push({
      id,
      backendId,
      label,
      ...(isolateSessions ? { isolateSessions: true } : {}),
      ...(region ? { region } : {}),
      ...(tags ? { tags } : {}),
      ...(notes ? { notes } : {}),
      ...(disabled ? { disabled: true } : {}),
      createdAt,
    });
  }
  return out;
}

/** 解析设置 `harnessDeck.backendChannels` 中的智能体渠道路由映射。 */
export function parseBackendChannelsSetting(raw: unknown): Record<string, BackendChannelBinding> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, BackendChannelBinding> = {};
  for (const [rawKey, val] of Object.entries(raw as Record<string, unknown>)) {
    const backendId = rawKey.trim();
    if (!backendId || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const obj = val as Record<string, unknown>;
    if (obj.mode === 'provider') {
      const providerId = typeof obj.providerId === 'string' ? obj.providerId.trim() : '';
      if (providerId) {
        out[backendId] = { mode: 'provider', providerId };
      }
    } else if (obj.mode === 'official') {
      const accountId = typeof obj.accountId === 'string' && obj.accountId.trim() ? obj.accountId.trim() : undefined;
      out[backendId] = accountId ? { mode: 'official', accountId } : { mode: 'official' };
    }
  }
  return out;
}

export interface UpsertAccountInput {
  readonly id?: string;
  readonly backendId: string;
  readonly label: string;
  readonly isolateSessions?: boolean;
  readonly region?: AccountRegion;
  readonly tags?: readonly string[];
  readonly notes?: string;
  readonly disabled?: boolean;
}

/** 新增或更新一条官方账号配置（不能覆写 system: 默认账号）。 */
export function upsertAccountSetting(
  existing: readonly AccountConfig[],
  input: UpsertAccountInput,
  now = Date.now,
): { readonly accounts: AccountConfig[]; readonly account: AccountConfig } {
  const backendId = input.backendId.trim();
  const label = input.label.trim();
  const requestedId = input.id?.trim() && !isSystemAccountId(input.id) ? normalizeAccountId(input.id) : '';
  const prev = requestedId ? existing.find((a) => a.id === requestedId) : undefined;

  let id = prev?.id ?? (requestedId || normalizeAccountId(`${backendId}-${label}`) || `${backendId}-${randomUUID().slice(0, 8)}`);
  if (!prev && existing.some((a) => a.id === id)) {
    let suffix = 2;
    while (existing.some((a) => a.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const nextTags = input.tags !== undefined ? cleanTags(input.tags) : prev?.tags;
  const nextNotes = input.notes !== undefined ? cleanNotes(input.notes) : prev?.notes;
  const nextDisabled = input.disabled !== undefined ? (input.disabled ? true : undefined) : prev?.disabled;

  const account: AccountConfig = {
    id,
    backendId: prev?.backendId ?? backendId,
    label,
    ...(input.isolateSessions === true ? { isolateSessions: true } : {}),
    ...(cleanRegion(input.region) ? { region: cleanRegion(input.region) } : {}),
    ...(nextTags ? { tags: nextTags } : {}),
    ...(nextNotes ? { notes: nextNotes } : {}),
    ...(nextDisabled ? { disabled: true } : {}),
    createdAt: prev?.createdAt ?? now(),
  };

  const accounts = prev
    ? existing.map((a) => (a.id === id ? account : a))
    : [...existing, account];

  return { accounts, account };
}

/** 切换自定义官方账号的禁用态。 */
export function toggleAccountDisabledSetting(
  existing: readonly AccountConfig[],
  id: string,
  disabled: boolean,
): { readonly accounts: AccountConfig[]; readonly target?: AccountConfig } {
  const target = existing.find((a) => a.id === id);
  if (!target) return { accounts: [...existing] };
  const updated: AccountConfig = {
    id: target.id,
    backendId: target.backendId,
    label: target.label,
    ...(target.isolateSessions ? { isolateSessions: true } : {}),
    ...(target.region ? { region: target.region } : {}),
    ...(target.tags ? { tags: target.tags } : {}),
    ...(target.notes ? { notes: target.notes } : {}),
    ...(disabled ? { disabled: true } : {}),
    createdAt: target.createdAt,
  };
  return {
    accounts: existing.map((a) => (a.id === id ? updated : a)),
    target: updated,
  };
}

/** 删除一条自定义官方账号，并把引用该账号的渠道路由安全回退到本机默认官方账号。 */
export function deleteAccountSetting(
  existing: readonly AccountConfig[],
  channels: Readonly<Record<string, BackendChannelBinding>>,
  id: string,
): {
  readonly accounts: AccountConfig[];
  readonly channels: Record<string, BackendChannelBinding>;
  readonly removed?: AccountConfig;
} {
  const removed = existing.find((a) => a.id === id);
  const accounts = existing.filter((a) => a.id !== id);
  const nextChannels: Record<string, BackendChannelBinding> = { ...channels };
  if (removed) {
    const binding = nextChannels[removed.backendId];
    if (binding?.mode === 'official' && binding.accountId === removed.id) {
      nextChannels[removed.backendId] = { mode: 'official', accountId: systemAccountId(removed.backendId) };
    }
  }
  return { accounts, channels: nextChannels, ...(removed ? { removed } : {}) };
}

/** 设置某个智能体的当前渠道路由（官方账号 或 第三方服务商）。 */
export function setBackendChannelSetting(
  channels: Readonly<Record<string, BackendChannelBinding>>,
  backendId: string,
  binding: BackendChannelBinding,
): Record<string, BackendChannelBinding> {
  const cleanId = backendId.trim();
  if (!cleanId) return { ...channels };
  if (binding.mode === 'provider') {
    const pid = binding.providerId.trim();
    if (!pid) return { ...channels };
    return { ...channels, [cleanId]: { mode: 'provider', providerId: pid } };
  }
  const aid = binding.accountId?.trim();
  return {
    ...channels,
    [cleanId]: aid ? { mode: 'official', accountId: aid } : { mode: 'official', accountId: systemAccountId(cleanId) },
  };
}

/**
 * 解析某个智能体最终生效的渠道路由：
 * 1. 若用户显式配置了 `backendChannels[backendId]`，校验目标服务商/账号仍有效；
 * 2. 若未显式配置，兼容旧版 `providers[].boundBackendIds`（有绑定则走该服务商，否则走官方本机默认账号）。
 */
export function resolveBackendChannel(
  backendId: string,
  channels: Readonly<Record<string, BackendChannelBinding>>,
  providers: readonly ProviderConfig[],
  accounts: readonly AccountConfig[],
): BackendChannelBinding {
  const explicit = channels[backendId] ?? (backendId === 'pi' ? channels['oh-my-pi'] : undefined);
  if (explicit) {
    if (explicit.mode === 'provider') {
      const target = providers.find((p) => p.id === explicit.providerId);
      if (target) return { mode: 'provider', providerId: target.id };
      return { mode: 'official', accountId: systemAccountId(backendId) };
    }
    const targetAccountId = explicit.accountId?.trim();
    if (!targetAccountId || isSystemAccountId(targetAccountId)) {
      return { mode: 'official', accountId: systemAccountId(backendId) };
    }
    const found = accounts.find((a) => a.id === targetAccountId && a.backendId === backendId);
    return { mode: 'official', accountId: found ? found.id : systemAccountId(backendId) };
  }

  const legacyProvider = providerForBackend(providers, backendId);
  if (legacyProvider) {
    return { mode: 'provider', providerId: legacyProvider.id };
  }
  return { mode: 'official', accountId: systemAccountId(backendId) };
}

/**
 * 返回某个智能体当前是否实际使用第三方服务商：
 * 仅当渠道路由为 `provider` 时返回对应 `ProviderConfig`；切回 `official` 时返回 `undefined`。
 */
export function effectiveProviderForBackend(
  backendId: string,
  channels: Readonly<Record<string, BackendChannelBinding>>,
  providers: readonly ProviderConfig[],
  accounts: readonly AccountConfig[],
): ProviderConfig | undefined {
  const binding = resolveBackendChannel(backendId, channels, providers, accounts);
  if (binding.mode !== 'provider') return undefined;
  return providers.find((p) => p.id === binding.providerId);
}

/**
 * 返回某个智能体当前激活的官方账号 id（当路由为 `provider` 时返回 undefined）。
 */
export function activeOfficialAccountId(
  backendId: string,
  channels: Readonly<Record<string, BackendChannelBinding>>,
  providers: readonly ProviderConfig[],
  accounts: readonly AccountConfig[],
): string | undefined {
  const binding = resolveBackendChannel(backendId, channels, providers, accounts);
  if (binding.mode !== 'official') return undefined;
  return binding.accountId ?? systemAccountId(backendId);
}

/**
 * 跨会话与跨工具的账号/渠道及模型隔离存储层（纯逻辑，不依赖 `vscode`）。
 *
 * 隔离层级：
 * 1. **工具间隔离（Cross-Tool）**：每个底层（`backendId`）拥有独立的渠道路由、服务商模型映射与临时配置作用域，
 *    即使两个工具同时绑定同一个第三方服务商，在工具 A 中切换模型或渠道也不会影响工具 B。
 * 2. **会话间隔离（Per-Session）**：
 *    - 每个会话 `(backendId, sessionId)` 独立记录生效的渠道绑定（官方账号或第三方服务商），并支持草稿标签 `tabKey`
 *      在首条消息生成真实 `sessionId` 以及 `pending:*` 重键时无损迁移；
 *    - `ScopedProviderModelRegistry` 按 `(backendId, sessionId?, providerId)` 分层记录服务商模型选择，
 *      让本机 `ProviderProxy` 按请求路径里的作用域精准映射每个工具/每个会话的模型，互不串扰。
 */
import type { AccountConfig, BackendChannelBinding, ProviderConfig } from '@harness-deck/shared';
import { isSystemAccountId, resolveBackendChannel, systemAccountId } from './AccountStore.ts';

export const SESSION_CHANNELS_STORAGE_KEY = 'harnessDeck.sessionChannels';
const MAX_PERSISTED_SESSION_ENTRIES = 500;
const SCOPE_SEP = '::';

export interface SessionScopeRef {
  readonly backendId: string;
  readonly sessionId?: string;
}

export interface PersistedSessionChannelEntry {
  readonly binding: BackendChannelBinding;
  readonly updatedAt: number;
}

export type SessionChannelRecord = Readonly<Record<string, PersistedSessionChannelEntry>>;

/** 生成 `(backendId, sessionId)` 复合存储键。 */
export function sessionCompositeKey(backendId: string, sessionId: string): string {
  return `${backendId.trim()}${SCOPE_SEP}${sessionId.trim()}`;
}

/** 构造传给本机 `ProviderProxy` 的路径作用域标识（同时隔离不同工具与不同会话）。 */
export function buildProviderProxyScope(backendId: string, sessionId?: string): string {
  const cleanBackend = backendId.trim();
  const cleanSession = sessionId?.trim();
  return cleanSession ? `${cleanBackend}${SCOPE_SEP}${cleanSession}` : cleanBackend;
}

/** 解析 `ProviderProxy` 路径里的作用域标识，还原 `backendId` 与可选 `sessionId`。 */
export function parseProviderProxyScope(scope: string | undefined): SessionScopeRef | undefined {
  const trimmed = scope?.trim();
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf(SCOPE_SEP);
  if (idx < 0) return { backendId: trimmed };
  const backendId = trimmed.slice(0, idx).trim();
  const sessionId = trimmed.slice(idx + SCOPE_SEP.length).trim();
  if (!backendId) return undefined;
  return sessionId ? { backendId, sessionId } : { backendId };
}

/** 把渠道绑定规整为可比较的稳定值。 */
export function normalizeChannelBinding(
  backendId: string,
  binding: BackendChannelBinding,
): BackendChannelBinding {
  if (binding.mode === 'provider') {
    return { mode: 'provider', providerId: binding.providerId.trim() };
  }
  const aid = binding.accountId?.trim();
  return {
    mode: 'official',
    accountId: aid || systemAccountId(backendId),
  };
}

/** 判断两个渠道绑定是否等价。 */
export function isSameChannelBinding(
  backendId: string,
  a: BackendChannelBinding | undefined,
  b: BackendChannelBinding | undefined,
): boolean {
  if (!a || !b) return false;
  const na = normalizeChannelBinding(backendId, a);
  const nb = normalizeChannelBinding(backendId, b);
  if (na.mode !== nb.mode) return false;
  if (na.mode === 'provider' && nb.mode === 'provider') {
    return na.providerId === nb.providerId;
  }
  if (na.mode === 'official' && nb.mode === 'official') {
    return na.accountId === nb.accountId;
  }
  return false;
}

/** 校验某条会话级渠道绑定在当前服务商与账号列表下是否仍有效，失效则返回 undefined（交由默认渠道兜底）。 */
export function validateChannelBinding(
  backendId: string,
  binding: BackendChannelBinding | undefined,
  providers: readonly ProviderConfig[],
  accounts: readonly AccountConfig[],
): BackendChannelBinding | undefined {
  if (!binding) return undefined;
  if (binding.mode === 'provider') {
    const pid = binding.providerId.trim();
    const target = providers.find((p) => p.id === pid);
    return target ? { mode: 'provider', providerId: target.id } : undefined;
  }
  const aid = binding.accountId?.trim();
  if (!aid || isSystemAccountId(aid)) {
    return { mode: 'official', accountId: systemAccountId(backendId) };
  }
  const found = accounts.find((a) => a.id === aid && a.backendId === backendId);
  return found ? { mode: 'official', accountId: found.id } : undefined;
}

/** 解析持久化的 `harnessDeck.sessionChannels` 映射表。 */
export function parseSessionChannelsRecord(raw: unknown): Record<string, PersistedSessionChannelEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PersistedSessionChannelEntry> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || !trimmedKey.includes(SCOPE_SEP) || !val || typeof val !== 'object' || Array.isArray(val)) {
      continue;
    }
    const obj = val as Record<string, unknown>;
    const rawBinding = (obj.binding && typeof obj.binding === 'object' ? obj.binding : obj) as Record<string, unknown>;
    let binding: BackendChannelBinding | undefined;
    if (rawBinding.mode === 'provider') {
      const providerId = typeof rawBinding.providerId === 'string' ? rawBinding.providerId.trim() : '';
      if (providerId) binding = { mode: 'provider', providerId };
    } else if (rawBinding.mode === 'official') {
      const accountId =
        typeof rawBinding.accountId === 'string' && rawBinding.accountId.trim() ? rawBinding.accountId.trim() : undefined;
      binding = accountId ? { mode: 'official', accountId } : { mode: 'official' };
    }
    if (!binding) continue;
    const updatedAt =
      typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
        ? Math.round(obj.updatedAt)
        : 0;
    out[trimmedKey] = { binding, updatedAt };
  }
  return out;
}

/** 解析或裁剪通用按会话持久化的模型记录（保持最近 `maxEntries` 条，避免状态无限膨胀）。 */
export function pruneSessionRecord<T extends { readonly updatedAt?: number }>(
  record: Readonly<Record<string, T>>,
  maxEntries = MAX_PERSISTED_SESSION_ENTRIES,
): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= maxEntries) return { ...record };
  entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export interface SessionChannelStoreOptions {
  readonly load: () => unknown;
  readonly save: (record: SessionChannelRecord) => void;
  readonly now?: () => number;
}

/**
 * 按 `(backendId, sessionId)` 及草稿标签 `tabKey` 隔离存储会话级账号/服务商渠道。
 */
export class SessionChannelStore {
  private readonly sessionBindings = new Map<string, PersistedSessionChannelEntry>();
  /** 尚未发出首条消息的空白标签上的临时渠道绑定（按 tabKey 隔离）。 */
  private readonly draftTabBindings = new Map<string, { readonly backendId: string; readonly binding: BackendChannelBinding }>();
  private readonly now: () => number;

  constructor(private readonly options: SessionChannelStoreOptions) {
    this.now = options.now ?? Date.now;
    const restored = parseSessionChannelsRecord(options.load());
    for (const [k, v] of Object.entries(restored)) {
      this.sessionBindings.set(k, v);
    }
  }

  /** 读取某个会话显式绑定的渠道（未显式绑定时返回 undefined）。 */
  getSessionBinding(backendId: string, sessionId: string | undefined): BackendChannelBinding | undefined {
    const sid = sessionId?.trim();
    if (!sid) return undefined;
    return this.sessionBindings.get(sessionCompositeKey(backendId, sid))?.binding;
  }

  /** 读取某个草稿标签显式绑定的渠道（若切换了底层则自动忽略）。 */
  getDraftTabBinding(tabKey: string | undefined, backendId: string): BackendChannelBinding | undefined {
    const key = tabKey?.trim();
    if (!key) return undefined;
    const entry = this.draftTabBindings.get(key);
    if (!entry || entry.backendId !== backendId) return undefined;
    return entry.binding;
  }

  /** 是否已为指定会话或草稿标签显式固定了渠道。 */
  hasExplicitBinding(backendId: string, ref?: { readonly sessionId?: string; readonly tabKey?: string }): boolean {
    if (ref?.sessionId && this.sessionBindings.has(sessionCompositeKey(backendId, ref.sessionId))) {
      return true;
    }
    if (ref?.tabKey) {
      const draft = this.draftTabBindings.get(ref.tabKey.trim());
      if (draft && draft.backendId === backendId) return true;
    }
    return false;
  }

  /** 解析指定会话/标签最终生效的渠道：优先会话绑定 -> 草稿标签绑定 -> 工具默认渠道。 */
  resolveEffectiveChannel(params: {
    readonly backendId: string;
    readonly sessionId?: string;
    readonly tabKey?: string;
    readonly backendChannels: Readonly<Record<string, BackendChannelBinding>>;
    readonly providers: readonly ProviderConfig[];
    readonly accounts: readonly AccountConfig[];
  }): BackendChannelBinding {
    const { backendId, sessionId, tabKey, backendChannels, providers, accounts } = params;
    const rawSession = this.getSessionBinding(backendId, sessionId);
    const validSession = validateChannelBinding(backendId, rawSession, providers, accounts);
    if (validSession) return validSession;

    if (!sessionId) {
      const rawDraft = this.getDraftTabBinding(tabKey, backendId);
      const validDraft = validateChannelBinding(backendId, rawDraft, providers, accounts);
      if (validDraft) return validDraft;
    }

    return resolveBackendChannel(backendId, backendChannels, providers, accounts);
  }

  /** 为已存在的会话设置专属渠道并持久化（`pending:*` 暂存内存，待重键为真实 id 时落盘）。 */
  setSessionChannel(backendId: string, sessionId: string, binding: BackendChannelBinding): void {
    const cleanSid = sessionId.trim();
    if (!cleanSid) return;
    const normalized = normalizeChannelBinding(backendId, binding);
    this.sessionBindings.set(sessionCompositeKey(backendId, cleanSid), {
      binding: normalized,
      updatedAt: this.now(),
    });
    if (!cleanSid.startsWith('pending:')) {
      this.persist();
    }
  }

  /** 为尚未发出首条消息的草稿标签设置专属渠道。 */
  setDraftTabChannel(tabKey: string, backendId: string, binding: BackendChannelBinding): void {
    const cleanKey = tabKey.trim();
    if (!cleanKey) return;
    this.draftTabBindings.set(cleanKey, {
      backendId: backendId.trim(),
      binding: normalizeChannelBinding(backendId, binding),
    });
  }

  clearDraftTab(tabKey: string | undefined): void {
    const cleanKey = tabKey?.trim();
    if (cleanKey) this.draftTabBindings.delete(cleanKey);
  }

  /**
   * 空白标签发出首条消息并获得 `sessionId` 时调用：
   * - 若草稿标签有显式渠道选择，则无损迁移给该会话；
   * - 否则把 `fallbackBinding`（工具当前默认渠道）固化快照给该会话，
   *   确保之后修改工具默认渠道或在其他会话切号不会篡改已创建会话的账号/服务商。
   */
  commitDraftToSession(
    backendId: string,
    sessionId: string,
    tabKey: string | undefined,
    fallbackBinding: BackendChannelBinding,
  ): BackendChannelBinding {
    const cleanSid = sessionId.trim();
    const existing = this.getSessionBinding(backendId, cleanSid);
    const draft = this.getDraftTabBinding(tabKey, backendId);
    if (tabKey) this.draftTabBindings.delete(tabKey.trim());
    if (existing) return existing;
    const chosen = normalizeChannelBinding(backendId, draft ?? fallbackBinding);
    this.setSessionChannel(backendId, cleanSid, chosen);
    return chosen;
  }

  /** 临时会话 key（如 Claude/CodeBuddy 的 `pending:*`）转为真实 `sessionId` 时无损迁移渠道绑定。 */
  rekeySession(backendId: string, oldSessionId: string, newSessionId: string): boolean {
    const oldKey = sessionCompositeKey(backendId, oldSessionId);
    const newKey = sessionCompositeKey(backendId, newSessionId);
    if (oldKey === newKey) return false;
    const existing = this.sessionBindings.get(oldKey);
    if (!existing) return false;
    this.sessionBindings.delete(oldKey);
    if (!this.sessionBindings.has(newKey)) {
      this.sessionBindings.set(newKey, { binding: existing.binding, updatedAt: this.now() });
    }
    if (!newSessionId.startsWith('pending:')) {
      this.persist();
    }
    return true;
  }

  /** 删除某个第三方服务商时清理指向它的过期会话/草稿绑定。 */
  pruneProvider(providerId: string): boolean {
    let changed = false;
    for (const [k, entry] of [...this.sessionBindings.entries()]) {
      if (entry.binding.mode === 'provider' && entry.binding.providerId === providerId) {
        this.sessionBindings.delete(k);
        changed = true;
      }
    }
    for (const [tabKey, entry] of [...this.draftTabBindings.entries()]) {
      if (entry.binding.mode === 'provider' && entry.binding.providerId === providerId) {
        this.draftTabBindings.delete(tabKey);
      }
    }
    if (changed) this.persist();
    return changed;
  }

  /** 删除某个官方账号时清理指向它的过期会话/草稿绑定。 */
  pruneAccount(backendId: string, accountId: string): boolean {
    const prefix = `${backendId.trim()}${SCOPE_SEP}`;
    let changed = false;
    for (const [k, entry] of [...this.sessionBindings.entries()]) {
      if (k.startsWith(prefix) && entry.binding.mode === 'official' && entry.binding.accountId === accountId) {
        this.sessionBindings.delete(k);
        changed = true;
      }
    }
    for (const [tabKey, entry] of [...this.draftTabBindings.entries()]) {
      if (entry.backendId === backendId && entry.binding.mode === 'official' && entry.binding.accountId === accountId) {
        this.draftTabBindings.delete(tabKey);
      }
    }
    if (changed) this.persist();
    return changed;
  }

  private persist(): void {
    const persistable: Record<string, PersistedSessionChannelEntry> = {};
    for (const [k, v] of this.sessionBindings.entries()) {
      const idx = k.indexOf(SCOPE_SEP);
      const sid = idx >= 0 ? k.slice(idx + SCOPE_SEP.length) : '';
      if (!sid || sid.startsWith('pending:')) continue;
      persistable[k] = v;
    }
    this.options.save(pruneSessionRecord(persistable));
  }
}

/**
 * 分层作用域的服务商模型选择注册表（供 `ProviderProxy` 使用）：
 * - 第一级：`(backendId, sessionId, providerId)` —— 同工具内不同会话完全隔离；
 * - 第二级：`(backendId, providerId)` —— 不同工具间完全隔离；
 * - 绝不在无作用域的情况下让工具 A 的模型覆盖工具 B 的模型。
 */
export class ScopedProviderModelRegistry {
  private readonly bySession = new Map<string, string>();
  private readonly byBackend = new Map<string, string>();
  private readonly fallbackByProvider = new Map<string, string>();

  private sessionKey(backendId: string, sessionId: string, providerId: string): string {
    return `${backendId.trim()}${SCOPE_SEP}${sessionId.trim()}${SCOPE_SEP}${providerId.trim()}`;
  }

  private backendKey(backendId: string, providerId: string): string {
    return `${backendId.trim()}${SCOPE_SEP}${providerId.trim()}`;
  }

  set(providerId: string, model: string, scope?: SessionScopeRef): void {
    const pid = providerId.trim();
    const m = model.trim();
    if (!pid || !m) return;
    if (scope?.backendId?.trim()) {
      const bid = scope.backendId.trim();
      const sid = scope.sessionId?.trim();
      if (sid) {
        this.bySession.set(this.sessionKey(bid, sid, pid), m);
      } else {
        this.byBackend.set(this.backendKey(bid, pid), m);
      }
      // 仅在该工具尚无工具级兜底时写入，避免覆盖其他会话
      if (!this.byBackend.has(this.backendKey(bid, pid))) {
        this.byBackend.set(this.backendKey(bid, pid), m);
      }
      return;
    }
    this.fallbackByProvider.set(pid, m);
  }

  /** 为某工具显式更新默认模型（仅用于无 sessionId 的单进程工具激活会话同步）。 */
  setBackendActive(backendId: string, providerId: string, model: string): void {
    const bid = backendId.trim();
    const pid = providerId.trim();
    const m = model.trim();
    if (!bid || !pid || !m) return;
    this.byBackend.set(this.backendKey(bid, pid), m);
  }

  /** 供 `ProviderProxy` 根据请求路径里的 `scope` 解析精确模型。 */
  resolve(providerId: string, rawScope?: string): string | undefined {
    const pid = providerId.trim();
    if (!pid) return undefined;
    const parsed = parseProviderProxyScope(rawScope);
    if (parsed) {
      if (parsed.sessionId) {
        const exact = this.bySession.get(this.sessionKey(parsed.backendId, parsed.sessionId, pid));
        if (exact) return exact;
      }
      const backendMatch = this.byBackend.get(this.backendKey(parsed.backendId, pid));
      if (backendMatch) return backendMatch;
      // 带明确作用域但该工具未选过模型时，直接返回 undefined（由服务商 defaultModel 兜底），绝不串读其他工具的模型
      return undefined;
    }
    return this.fallbackByProvider.get(pid);
  }

  rekeySession(backendId: string, oldSessionId: string, newSessionId: string): void {
    const bid = backendId.trim();
    const oldPrefix = `${bid}${SCOPE_SEP}${oldSessionId.trim()}${SCOPE_SEP}`;
    const newPrefix = `${bid}${SCOPE_SEP}${newSessionId.trim()}${SCOPE_SEP}`;
    if (oldPrefix === newPrefix) return;
    for (const [k, model] of [...this.bySession.entries()]) {
      if (!k.startsWith(oldPrefix)) continue;
      const pid = k.slice(oldPrefix.length);
      this.bySession.delete(k);
      const nextKey = `${newPrefix}${pid}`;
      if (!this.bySession.has(nextKey)) {
        this.bySession.set(nextKey, model);
      }
    }
  }

  deleteProvider(providerId: string): void {
    const suffix = `${SCOPE_SEP}${providerId.trim()}`;
    this.fallbackByProvider.delete(providerId.trim());
    for (const k of [...this.bySession.keys()]) {
      if (k.endsWith(suffix)) this.bySession.delete(k);
    }
    for (const k of [...this.byBackend.keys()]) {
      if (k.endsWith(suffix)) this.byBackend.delete(k);
    }
  }
}

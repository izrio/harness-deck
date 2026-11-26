/**
 * IM 双向聊天机器人总编排器（企微 / 飞书 / 钉钉 / Telegram）：
 * - 统一管理 4 个平台的长连接/长轮询生命周期、凭据安全存储（SecretStore）与脱敏视图投影
 * - 提供 6 位一次性配对码（`/pair <码>`）与可选白名单访问控制、群聊 `@机器人` 保护
 * - 同步当前活动会话并支持 `/help`、`/status`、`/new`、`/stop`、`/sessions`、`/switch` 指令
 * - 监听 HostToWebview 事件流，实现跨所有底层（dsh / Claude / Pi / ZCode / Codex / CodeBuddy / ACP）的流式回复与审批/提问双向交互
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  HostSnapshot,
  HostToWebview,
  ImBotBoundUserView,
  ImBotChannelView,
  ImBotFeishuDomain,
  ImBotPairingView,
  ImBotPlatform,
  ImBotsState,
  Item,
  ItemsPatch,
  PendingInteraction,
  WebviewToHost,
} from '@harness-deck/shared';
import type { KeyValueStore, SecretStore } from '../../host/HostPlatform.ts';
import { DingTalkBotAdapter } from './DingTalkBotAdapter.ts';
import { FeishuBotAdapter } from './FeishuBotAdapter.ts';
import { TelegramBotAdapter } from './TelegramBotAdapter.ts';
import { WeComBotAdapter } from './WeComBotAdapter.ts';
import {
  IM_BOT_PLATFORMS,
  type ImBotAdapter,
  type ImBotAdapterCallbacks,
  type ImBotAdapterStatus,
  type ImBotChannelCredentials,
  type ImBotInboundMessage,
  type ImBotReplyContext,
  type ImBotStreamHandle,
  type WebSocketFactory,
} from './types.ts';

const IM_BOTS_STORAGE_KEY = 'harnessDeck.remote.imBots';
const IM_BOT_SECRET_PREFIX = 'harnessDeck.imBot.secret.';
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 6;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const DEDUP_TTL_MS = 5 * 60 * 1000;
const UNAUTH_HINT_COOLDOWN_MS = 60 * 1000;

interface StoredChannelConfig {
  readonly enabled: boolean;
  readonly appId?: string;
  readonly domain?: ImBotFeishuDomain;
  readonly apiBase?: string;
  readonly allowlist: readonly string[];
  readonly requireMentionInGroup: boolean;
}

interface StoredImBotsState {
  readonly channels: Record<ImBotPlatform, StoredChannelConfig>;
  readonly boundUsers: readonly ImBotBoundUserView[];
}

export interface ImBotChannelPatch {
  readonly platform: ImBotPlatform;
  readonly enabled?: boolean;
  readonly appId?: string;
  readonly secret?: string;
  readonly domain?: ImBotFeishuDomain;
  readonly apiBase?: string;
  readonly allowlist?: readonly string[];
  readonly requireMentionInGroup?: boolean;
}

export interface ImBotManagerOptions {
  readonly globalState: KeyValueStore;
  readonly secrets: SecretStore;
  readonly locale: () => 'zh' | 'en';
  readonly isWindowFocused: () => boolean;
  readonly getSnapshot: () => HostSnapshot | undefined;
  readonly ensureBackendStarted: () => void;
  readonly dispatchMessage: (message: WebviewToHost) => void;
  readonly onStateChange: () => void;
  readonly log: (line: string) => void;
  readonly adapterFactory?: (
    credentials: ImBotChannelCredentials,
    callbacks: ImBotAdapterCallbacks,
  ) => ImBotAdapter;
  readonly fetchImpl?: typeof fetch;
  readonly createWebSocket?: WebSocketFactory;
  readonly now?: () => number;
}

interface ActiveTurnReply {
  readonly platform: ImBotPlatform;
  readonly ctx: ImBotReplyContext;
  readonly handle: ImBotStreamHandle;
  readonly baselineItemIds: ReadonlySet<string>;
  sawRunning: boolean;
  startedAt: number;
  lastRenderedText: string;
  settleTimer?: ReturnType<typeof setTimeout>;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

interface ActivePairing {
  readonly code: string;
  readonly expiresAt: number;
  readonly platform?: ImBotPlatform;
  failedAttempts: number;
}

function defaultChannelConfig(platform: ImBotPlatform): StoredChannelConfig {
  return {
    enabled: false,
    ...(platform === 'feishu' ? { domain: 'feishu' as const } : {}),
    allowlist: [],
    requireMentionInGroup: true,
  };
}

function parseStoredState(raw: unknown): StoredImBotsState {
  const channels = {} as Record<ImBotPlatform, StoredChannelConfig>;
  const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawChannels =
    rawObj.channels && typeof rawObj.channels === 'object'
      ? (rawObj.channels as Record<string, unknown>)
      : {};

  for (const platform of IM_BOT_PLATFORMS) {
    const base = defaultChannelConfig(platform);
    const entry =
      rawChannels[platform] && typeof rawChannels[platform] === 'object'
        ? (rawChannels[platform] as Record<string, unknown>)
        : {};
    const allowlist = Array.isArray(entry.allowlist)
      ? Array.from(
          new Set(
            entry.allowlist
              .filter((v): v is string => typeof v === 'string')
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        )
      : [];
    const domain: ImBotFeishuDomain | undefined =
      platform === 'feishu' ? (entry.domain === 'lark' ? 'lark' : 'feishu') : undefined;
    const appId = typeof entry.appId === 'string' && entry.appId.trim() ? entry.appId.trim() : undefined;
    const apiBase =
      platform === 'telegram' && typeof entry.apiBase === 'string' && entry.apiBase.trim()
        ? entry.apiBase.trim()
        : undefined;
    channels[platform] = {
      enabled: entry.enabled === true,
      ...(appId ? { appId } : {}),
      ...(domain ? { domain } : {}),
      ...(apiBase ? { apiBase } : {}),
      allowlist,
      requireMentionInGroup:
        typeof entry.requireMentionInGroup === 'boolean'
          ? entry.requireMentionInGroup
          : base.requireMentionInGroup,
    };
  }

  const boundUsers: ImBotBoundUserView[] = [];
  if (Array.isArray(rawObj.boundUsers)) {
    for (const item of rawObj.boundUsers) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const platform = obj.platform as ImBotPlatform;
      if (!IM_BOT_PLATFORMS.includes(platform)) continue;
      if (typeof obj.userId !== 'string' || !obj.userId.trim()) continue;
      const userId = obj.userId.trim();
      const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `${platform}:${userId}`;
      boundUsers.push({
        id,
        platform,
        userId,
        ...(typeof obj.userName === 'string' && obj.userName.trim() ? { userName: obj.userName.trim() } : {}),
        ...(typeof obj.chatId === 'string' && obj.chatId.trim() ? { chatId: obj.chatId.trim() } : {}),
        ...(obj.chatType === 'single' || obj.chatType === 'group' ? { chatType: obj.chatType } : {}),
        boundAt: typeof obj.boundAt === 'number' ? obj.boundAt : Date.now(),
        lastActiveAt: typeof obj.lastActiveAt === 'number' ? obj.lastActiveAt : Date.now(),
      });
    }
  }

  return { channels, boundUsers };
}

function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    out += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  }
  return out;
}

function safeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 格式化审批或提问卡片为清晰的 Markdown 文本。 */
export function formatInteractionForIm(interaction: PendingInteraction, locale: 'zh' | 'en'): string {
  if (interaction.kind === 'approval') {
    const lines: string[] = [];
    lines.push(
      locale === 'zh'
        ? `⚠️ **需要审批：${interaction.toolName}**`
        : `⚠️ **Approval Required: ${interaction.toolName}**`,
    );
    if (interaction.reason) lines.push(interaction.reason);
    if (interaction.subject) {
      lines.push(`> \`${interaction.subject.slice(0, 400)}\``);
    }
    if (interaction.dirtyFiles.length > 0) {
      lines.push(
        locale === 'zh'
          ? `未保存文件：${interaction.dirtyFiles.join(', ')}`
          : `Unsaved files: ${interaction.dirtyFiles.join(', ')}`,
      );
    }
    lines.push('');
    if (locale === 'zh') {
      lines.push('请直接回复：');
      lines.push('- `1` 或 `允许` — 允许本次');
      if (interaction.allowAlways) {
        lines.push(`- \`2\` 或 \`始终允许\` — ${interaction.allowAlways}`);
        lines.push('- `3` 或 `拒绝` — 拒绝执行');
      } else {
        lines.push('- `2` 或 `拒绝` — 拒绝执行');
      }
    } else {
      lines.push('Reply directly:');
      lines.push('- `1` or `allow` — Allow once');
      if (interaction.allowAlways) {
        lines.push(`- \`2\` or \`always\` — ${interaction.allowAlways}`);
        lines.push('- `3` or `reject` — Reject');
      } else {
        lines.push('- `2` or `reject` — Reject');
      }
    }
    return lines.join('\n');
  }

  const lines: string[] = [];
  lines.push(locale === 'zh' ? '❓ **代理提问**' : '❓ **Agent Question**');
  interaction.questions.forEach((q, qIdx) => {
    const prefix = interaction.questions.length > 1 ? `${qIdx + 1}. ` : '';
    const title = q.header ? `[${q.header}] ${q.question}` : q.question;
    lines.push(`${prefix}**${title}**`);
    if (q.detail) {
      const clipped = q.detail.length > 800 ? `${q.detail.slice(0, 800)}\n…` : q.detail;
      lines.push(clipped);
    }
    q.options.forEach((opt, optIdx) => {
      lines.push(`${optIdx + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
    });
    if (qIdx < interaction.questions.length - 1) lines.push('');
  });
  lines.push('');
  if (locale === 'zh') {
    const hasMulti = interaction.questions.some((q) => q.multiSelect);
    lines.push(
      hasMulti
        ? '请回复选项编号（单选如 `1`，多选如 `1,2`）或直接输入自定义回答；回复 `取消` 可取消。'
        : '请回复选项编号（如 `1`）或直接输入自定义回答；回复 `取消` 可取消。',
    );
  } else {
    lines.push('Reply with option number(s) (e.g. `1` or `1,2`) or custom text, or `cancel` to dismiss.');
  }
  return lines.join('\n');
}

/** 解析用户对审批请求的文本回复。 */
export function parseApprovalReply(
  text: string,
  hasAllowAlways: boolean,
): 'allow' | 'allowAlways' | 'reject' | undefined {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === '1' ||
    normalized === 'y' ||
    normalized === 'yes' ||
    normalized === 'ok' ||
    normalized === 'allow' ||
    normalized === '允许' ||
    normalized === '同意' ||
    normalized === '批准' ||
    normalized === '通过' ||
    normalized === '允许本次'
  ) {
    return 'allow';
  }
  if (
    hasAllowAlways &&
    (normalized === '2' ||
      normalized === 'a' ||
      normalized === 'always' ||
      normalized === 'allow always' ||
      normalized === '始终允许' ||
      normalized === '总是允许' ||
      normalized === '永远允许')
  ) {
    return 'allowAlways';
  }
  if (
    normalized === (hasAllowAlways ? '3' : '2') ||
    normalized === 'n' ||
    normalized === 'no' ||
    normalized === 'reject' ||
    normalized === 'deny' ||
    normalized === 'cancel' ||
    normalized === '拒绝' ||
    normalized === '不同意' ||
    normalized === '取消'
  ) {
    return 'reject';
  }
  return undefined;
}

/** 解析用户对提问卡片的文本回复。 */
export function parseQuestionReply(
  interaction: Extract<PendingInteraction, { readonly kind: 'question' }>,
  text: string,
): Extract<WebviewToHost, { type: 'answerQuestion' }>['payload'] {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === '取消' || lower === 'cancel') {
    return { id: interaction.id, cancelled: true };
  }

  const parseSingle = (
    q: (typeof interaction.questions)[number],
    part: string,
  ): { readonly id: string; readonly selected: string[]; readonly custom?: string } => {
    const clean = part.trim();
    if (!clean) {
      const fallback = q.options[0]?.label;
      return { id: q.id, selected: fallback ? [fallback] : [] };
    }
    // 尝试解析编号列表（如 "1"、"1,2"、"1 3"、"1、2"）
    const tokens = clean.split(/[\s,，、]+/u).filter(Boolean);
    if (tokens.length > 0 && tokens.every((tok) => /^\d+$/u.test(tok))) {
      const picked: string[] = [];
      for (const tok of tokens) {
        const idx = Number(tok) - 1;
        const opt = q.options[idx];
        if (opt && !picked.includes(opt.label)) {
          picked.push(opt.label);
        }
      }
      if (picked.length > 0) {
        return {
          id: q.id,
          selected: q.multiSelect ? picked : [picked[0]!],
        };
      }
    }
    // 精确匹配选项文本
    const exact = q.options.find((o) => o.label.toLowerCase() === clean.toLowerCase());
    if (exact) {
      return { id: q.id, selected: [exact.label] };
    }
    return { id: q.id, selected: [], custom: clean };
  };

  if (interaction.questions.length === 1) {
    return {
      id: interaction.id,
      answers: [parseSingle(interaction.questions[0]!, trimmed)],
    };
  }

  const parts = trimmed.split(/\r?\n|[;；]/u).map((s) => s.trim()).filter(Boolean);
  return {
    id: interaction.id,
    answers: interaction.questions.map((q, idx) => parseSingle(q, parts[idx] ?? '')),
  };
}

export class ImBotManager {
  private state: StoredImBotsState;
  private readonly secretsCache = new Map<ImBotPlatform, string>();
  private readonly adapters = new Map<ImBotPlatform, ImBotAdapter>();
  private readonly statuses = new Map<ImBotPlatform, ImBotAdapterStatus>();
  private readonly platformQueues = new Map<ImBotPlatform, Promise<void>>();
  private readonly lastMessageAt = new Map<ImBotPlatform, number>();
  private readonly seenMessages = new Map<string, number>();
  private readonly lastUnauthHint = new Map<string, number>();
  private readonly lastActiveCtx = new Map<ImBotPlatform, ImBotReplyContext>();

  private pairing: ActivePairing | undefined;
  private pairingExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  // 对话与交互状态镜像（来自 HostToWebview 广播）
  private mirroredSessionKey = '';
  private mirroredItemOrder: string[] = [];
  private mirroredItems = new Map<string, Item>();
  private mirroredRunning = false;
  private mirroredInteractions: readonly PendingInteraction[] = [];
  private readonly notifiedInteractionIds = new Set<string>();
  private activeReply: ActiveTurnReply | undefined;
  private disposed = false;

  constructor(private readonly options: ImBotManagerOptions) {
    this.state = parseStoredState(options.globalState.get<unknown>(IM_BOTS_STORAGE_KEY));
    for (const platform of IM_BOT_PLATFORMS) {
      this.statuses.set(platform, { status: 'stopped' });
    }
  }

  private enqueuePlatform<T>(platform: ImBotPlatform, task: () => Promise<T>): Promise<T> {
    const prev = this.platformQueues.get(platform) ?? Promise.resolve();
    const result = prev.then(task, task);
    this.platformQueues.set(
      platform,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /** 启动时加载本机密钥并自动拉起已启用的机器人连接。 */
  async restoreEnabled(): Promise<void> {
    await this.loadAllSecrets();
    if (this.disposed) return;
    this.options.onStateChange();
    await Promise.all(
      IM_BOT_PLATFORMS.map((p) =>
        this.enqueuePlatform(p, async () => {
          if (!this.disposed && this.state.channels[p].enabled) {
            await this.syncAdapter(p);
          }
        }),
      ),
    );
  }

  getState(): ImBotsState {
    const now = (this.options.now ?? Date.now)();
    if (this.pairing && now >= this.pairing.expiresAt) {
      this.pairing = undefined;
    }

    const channels = {} as Record<ImBotPlatform, ImBotChannelView>;
    for (const platform of IM_BOT_PLATFORMS) {
      const cfg = this.state.channels[platform];
      const st = this.statuses.get(platform) ?? { status: 'stopped' };
      const lastMsg = this.lastMessageAt.get(platform);
      channels[platform] = {
        platform,
        enabled: cfg.enabled,
        status: st.status,
        ...(cfg.appId ? { appId: cfg.appId } : {}),
        hasSecret: Boolean(this.secretsCache.get(platform)),
        ...(cfg.domain ? { domain: cfg.domain } : {}),
        ...(cfg.apiBase ? { apiBase: cfg.apiBase } : {}),
        allowlist: cfg.allowlist,
        requireMentionInGroup: cfg.requireMentionInGroup,
        ...(st.botName ? { botName: st.botName } : {}),
        ...(st.lastConnectedAt !== undefined ? { lastConnectedAt: st.lastConnectedAt } : {}),
        ...(lastMsg !== undefined ? { lastMessageAt: lastMsg } : {}),
        ...(st.error ? { error: st.error } : {}),
      };
    }

    const pairing: ImBotPairingView | undefined = this.pairing
      ? {
          code: this.pairing.code,
          expiresAt: this.pairing.expiresAt,
          ...(this.pairing.platform ? { platform: this.pairing.platform } : {}),
        }
      : undefined;

    return {
      channels,
      boundUsers: this.state.boundUsers,
      ...(pairing ? { pairing } : {}),
    };
  }

  async updateChannel(patch: ImBotChannelPatch): Promise<ImBotsState> {
    return await this.enqueuePlatform(patch.platform, async () => {
      const platform = patch.platform;
      const prev = this.state.channels[platform];

      let credentialsChanged = false;
      if (patch.secret !== undefined) {
        const trimmed = patch.secret.trim();
        const key = `${IM_BOT_SECRET_PREFIX}${platform}`;
        if (trimmed) {
          await this.options.secrets.store(key, trimmed);
          this.secretsCache.set(platform, trimmed);
        } else {
          await this.options.secrets.delete(key);
          this.secretsCache.delete(platform);
        }
        credentialsChanged = true;
      }

      const nextAppId =
        patch.appId !== undefined ? (patch.appId.trim() || undefined) : prev.appId;
      const nextDomain: ImBotFeishuDomain | undefined =
        platform === 'feishu' ? (patch.domain ?? prev.domain ?? 'feishu') : undefined;
      const nextApiBase =
        platform === 'telegram'
          ? patch.apiBase !== undefined
            ? patch.apiBase.trim() || undefined
            : prev.apiBase
          : undefined;
      const nextAllowlist =
        patch.allowlist !== undefined
          ? Array.from(new Set(patch.allowlist.map((s) => s.trim()).filter(Boolean)))
          : prev.allowlist;
      const nextEnabled = patch.enabled !== undefined ? patch.enabled : prev.enabled;
      const nextRequireMention =
        patch.requireMentionInGroup !== undefined ? patch.requireMentionInGroup : prev.requireMentionInGroup;

      if (
        nextAppId !== prev.appId ||
        nextDomain !== prev.domain ||
        nextApiBase !== prev.apiBase
      ) {
        credentialsChanged = true;
      }

      this.state = {
        ...this.state,
        channels: {
          ...this.state.channels,
          [platform]: {
            enabled: nextEnabled,
            ...(nextAppId ? { appId: nextAppId } : {}),
            ...(nextDomain ? { domain: nextDomain } : {}),
            ...(nextApiBase ? { apiBase: nextApiBase } : {}),
            allowlist: nextAllowlist,
            requireMentionInGroup: nextRequireMention,
          },
        },
      };
      await this.persistState();

      if (nextEnabled !== prev.enabled || (nextEnabled && credentialsChanged)) {
        await this.syncAdapter(platform, credentialsChanged);
      } else {
        this.options.onStateChange();
      }
      return this.getState();
    });
  }

  generatePairing(platform?: ImBotPlatform): ImBotPairingView {
    const now = (this.options.now ?? Date.now)();
    const code = generatePairingCode();
    const expiresAt = now + PAIRING_TTL_MS;
    this.pairing = {
      code,
      expiresAt,
      ...(platform ? { platform } : {}),
      failedAttempts: 0,
    };
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = setTimeout(() => {
      this.pairingExpiryTimer = undefined;
      if (this.pairing && (this.options.now ?? Date.now)() >= this.pairing.expiresAt) {
        this.pairing = undefined;
        this.options.onStateChange();
      }
    }, PAIRING_TTL_MS + 50);
    this.pairingExpiryTimer.unref?.();
    this.options.onStateChange();
    return {
      code,
      expiresAt,
      ...(platform ? { platform } : {}),
    };
  }

  clearPairing(): void {
    if (this.pairingExpiryTimer) {
      clearTimeout(this.pairingExpiryTimer);
      this.pairingExpiryTimer = undefined;
    }
    this.pairing = undefined;
    this.options.onStateChange();
  }

  async revokeBoundUser(id: string): Promise<boolean> {
    const next = this.state.boundUsers.filter((u) => u.id !== id);
    if (next.length === this.state.boundUsers.length) return false;
    this.state = { ...this.state, boundUsers: next };
    await this.persistState();
    this.options.onStateChange();
    return true;
  }

  async testChannel(platform: ImBotPlatform): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return await this.enqueuePlatform(platform, async () => {
      const existing = this.adapters.get(platform);
      if (existing) {
        return await existing.testConnection();
      }
      const creds = this.credentialsFor(platform);
      const missing = this.validateCredentials(creds);
      if (missing) return { ok: false, detail: missing };
      const temp = this.createAdapter(creds, {
        onMessage: () => undefined,
        onStatusChange: () => undefined,
        log: this.options.log,
      });
      return await temp.testConnection();
    });
  }

  /** 观察 HostToWebview 广播流，驱动流式回复与审批/提问双向推送。 */
  observeHostMessage(message: HostToWebview): void {
    if (this.disposed) return;

    if (message.type === 'snapshot') {
      const snap = message.payload;
      this.mirroredSessionKey = snap.session.id ?? '';
      this.mirroredItemOrder = snap.items.map((it) => it.id);
      this.mirroredItems = new Map(snap.items.map((it) => [it.id, it]));
      const wasRunning = this.mirroredRunning;
      this.mirroredRunning = snap.session.running;
      this.handleInteractionsUpdate(snap.interactions);
      this.handleTurnProgress(wasRunning, snap.session.running);
      return;
    }

    if (message.type === 'items') {
      this.applyItemsPatch(message.payload);
      this.handleTurnProgress(this.mirroredRunning, this.mirroredRunning);
      return;
    }

    if (message.type === 'session') {
      const wasRunning = this.mirroredRunning;
      this.mirroredRunning = message.payload.running;
      if ((message.payload.id ?? '') !== this.mirroredSessionKey) {
        this.mirroredSessionKey = message.payload.id ?? '';
      }
      this.handleTurnProgress(wasRunning, message.payload.running);
      return;
    }

    if (message.type === 'interactions') {
      this.handleInteractionsUpdate(message.payload);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearPairing();
    this.clearActiveReplyTimers();
    this.activeReply = undefined;
    const stops = [...this.adapters.values()].map((adapter) =>
      adapter.stop().catch(() => undefined),
    );
    this.adapters.clear();
    await Promise.all(stops);
  }

  private async loadAllSecrets(): Promise<void> {
    await Promise.all(
      IM_BOT_PLATFORMS.map(async (platform) => {
        try {
          const val = await this.options.secrets.get(`${IM_BOT_SECRET_PREFIX}${platform}`);
          if (val?.trim()) {
            this.secretsCache.set(platform, val.trim());
          } else {
            this.secretsCache.delete(platform);
          }
        } catch {
          // ignore secret store read error
        }
      }),
    );
  }

  private credentialsFor(platform: ImBotPlatform): ImBotChannelCredentials {
    const cfg = this.state.channels[platform];
    const secret = this.secretsCache.get(platform);
    return {
      platform,
      ...(cfg.appId ? { appId: cfg.appId } : {}),
      ...(secret ? { secret } : {}),
      ...(cfg.domain ? { domain: cfg.domain } : {}),
      ...(cfg.apiBase ? { apiBase: cfg.apiBase } : {}),
    };
  }

  private validateCredentials(creds: ImBotChannelCredentials): string | undefined {
    const zh = this.options.locale() === 'zh';
    if (creds.platform === 'telegram') {
      if (!creds.secret) return zh ? '请先填写 Telegram Bot Token' : 'Missing Telegram Bot Token';
      return undefined;
    }
    if (!creds.appId || !creds.secret) {
      if (creds.platform === 'wecom') {
        return zh ? '请先填写企业微信 Bot ID 与 Secret' : 'Missing WeCom Bot ID or Secret';
      }
      if (creds.platform === 'feishu') {
        return zh ? '请先填写飞书 App ID 与 App Secret' : 'Missing Feishu App ID or App Secret';
      }
      return zh ? '请先填写钉钉 Client ID 与 Client Secret' : 'Missing DingTalk Client ID or Client Secret';
    }
    return undefined;
  }

  private createAdapter(creds: ImBotChannelCredentials, callbacks: ImBotAdapterCallbacks): ImBotAdapter {
    if (this.options.adapterFactory) {
      return this.options.adapterFactory(creds, callbacks);
    }
    switch (creds.platform) {
      case 'wecom':
        return new WeComBotAdapter(
          {
            botId: creds.appId ?? '',
            secret: creds.secret ?? '',
            ...(this.options.createWebSocket ? { createWebSocket: this.options.createWebSocket } : {}),
            ...(this.options.now ? { now: this.options.now } : {}),
          },
          callbacks,
        );
      case 'feishu':
        return new FeishuBotAdapter(
          {
            appId: creds.appId ?? '',
            appSecret: creds.secret ?? '',
            domain: creds.domain ?? 'feishu',
            ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
            ...(this.options.createWebSocket ? { createWebSocket: this.options.createWebSocket } : {}),
            ...(this.options.now ? { now: this.options.now } : {}),
          },
          callbacks,
        );
      case 'dingtalk':
        return new DingTalkBotAdapter(
          {
            clientId: creds.appId ?? '',
            clientSecret: creds.secret ?? '',
            ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
            ...(this.options.createWebSocket ? { createWebSocket: this.options.createWebSocket } : {}),
            ...(this.options.now ? { now: this.options.now } : {}),
          },
          callbacks,
        );
      case 'telegram':
        return new TelegramBotAdapter(
          {
            botToken: creds.secret ?? '',
            ...(creds.apiBase ? { apiBase: creds.apiBase } : {}),
            ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
            ...(this.options.now ? { now: this.options.now } : {}),
          },
          callbacks,
        );
    }
  }

  private async syncAdapter(platform: ImBotPlatform, restart = false): Promise<void> {
    const existing = this.adapters.get(platform);
    const cfg = this.state.channels[platform];

    if (!cfg.enabled || restart) {
      if (existing) {
        this.adapters.delete(platform);
        await existing.stop();
      }
      if (!cfg.enabled) {
        this.statuses.set(platform, { status: 'stopped' });
        this.options.onStateChange();
        return;
      }
    }

    if (this.adapters.has(platform)) return;

    const creds = this.credentialsFor(platform);
    const missing = this.validateCredentials(creds);
    if (missing) {
      this.statuses.set(platform, { status: 'error', error: missing });
      this.options.onStateChange();
      return;
    }

    const adapter = this.createAdapter(creds, {
      onMessage: (msg) => {
        void this.handleInboundMessage(msg);
      },
      onStatusChange: (status) => {
        if (this.adapters.get(platform) !== adapter && status.status !== 'stopped') return;
        this.statuses.set(platform, status);
        this.options.onStateChange();
      },
      log: this.options.log,
    });
    this.adapters.set(platform, adapter);
    await adapter.start();
  }

  private async handleInboundMessage(msg: ImBotInboundMessage): Promise<void> {
    if (this.disposed) return;
    const now = (this.options.now ?? Date.now)();
    const dedupKey = `${msg.platform}:${msg.messageId}`;
    this.pruneSeenMessages(now);
    if (this.seenMessages.has(dedupKey)) return;
    this.seenMessages.set(dedupKey, now);

    const cfg = this.state.channels[msg.platform];
    const text = msg.text.trim();
    if (!text) return;

    const isPairCommand = /^\/pair(?:\s+|$)/iu.test(text);
    if (msg.chatType === 'group' && cfg.requireMentionInGroup && !msg.mentionedBot && !isPairCommand) {
      return;
    }

    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return;

    // 1. 配对指令（优先于授权校验）
    if (isPairCommand) {
      const code = text.replace(/^\/pair\s*/iu, '').trim().toUpperCase();
      await this.handlePairCommand(adapter, msg, code);
      return;
    }

    // 2. 授权校验（已配对用户或手动白名单）
    const authorized = this.isAuthorized(msg.platform, msg.senderId, msg.chatId);
    if (!authorized) {
      const hintKey = `${msg.platform}:${msg.senderId}`;
      const lastHint = this.lastUnauthHint.get(hintKey) ?? 0;
      if (now - lastHint >= UNAUTH_HINT_COOLDOWN_MS) {
        this.lastUnauthHint.set(hintKey, now);
        const zh = this.options.locale() === 'zh';
        await adapter.sendMessage(
          msg.chatId,
          zh
            ? '🔒 当前账号尚未授权。请在 Halo「设置 → 手机远程互通 → IM 机器人」中点击「生成配对码」，然后在此发送 `/pair <配对码>` 完成绑定。'
            : '🔒 Unauthorized user. Generate a pairing code in Halo Settings → Mobile Remote → IM Bots, then send `/pair <code>` here.',
          msg.replyContext,
        );
      }
      return;
    }

    // 记录活跃时间与上下文
    this.lastMessageAt.set(msg.platform, now);
    this.lastActiveCtx.set(msg.platform, msg.replyContext);
    await this.touchBoundUser(msg, now);

    // 3. 内置斜杠指令
    if (text.startsWith('/')) {
      const handled = await this.handleSlashCommand(adapter, msg, text);
      if (handled) return;
    }

    // 4. 若当前有待处理的审批或提问卡片，优先作为交互响应解析
    const pending = this.currentPendingInteractions();
    if (pending.length > 0) {
      await this.handleInteractionReply(adapter, msg, pending[0]!, text);
      return;
    }

    // 5. 普通对话：发送到 Halo 当前活动会话并双向流式回传
    await this.handleChatPrompt(adapter, msg, text);
  }

  private async handlePairCommand(
    adapter: ImBotAdapter,
    msg: ImBotInboundMessage,
    code: string,
  ): Promise<void> {
    const zh = this.options.locale() === 'zh';
    const now = (this.options.now ?? Date.now)();
    if (!code) {
      await adapter.sendMessage(
        msg.chatId,
        zh ? '用法：`/pair <6位配对码>`' : 'Usage: `/pair <6-char-code>`',
        msg.replyContext,
      );
      return;
    }
    if (!this.pairing || now >= this.pairing.expiresAt) {
      this.pairing = undefined;
      this.options.onStateChange();
      await adapter.sendMessage(
        msg.chatId,
        zh
          ? '配对码不存在或已过期，请在 Halo 设置中重新生成。'
          : 'Pairing code is missing or expired. Please generate a new one in Halo Settings.',
        msg.replyContext,
      );
      return;
    }
    if (this.pairing.platform && this.pairing.platform !== msg.platform) {
      await adapter.sendMessage(
        msg.chatId,
        zh ? '该配对码仅限指定平台使用。' : 'This pairing code is restricted to another platform.',
        msg.replyContext,
      );
      return;
    }
    if (!safeEqualText(code, this.pairing.code)) {
      this.pairing.failedAttempts += 1;
      if (this.pairing.failedAttempts >= PAIRING_MAX_ATTEMPTS) {
        this.clearPairing();
        await adapter.sendMessage(
          msg.chatId,
          zh
            ? '配对码错误次数过多已自动作废，请在 Halo 重新生成。'
            : 'Too many failed attempts; pairing code revoked.',
          msg.replyContext,
        );
        return;
      }
      const left = PAIRING_MAX_ATTEMPTS - this.pairing.failedAttempts;
      await adapter.sendMessage(
        msg.chatId,
        zh ? `配对码不正确（剩余 ${left} 次尝试）。` : `Invalid pairing code (${left} attempts left).`,
        msg.replyContext,
      );
      return;
    }

    // 验证成功：作废一次性配对码并持久化绑定
    this.clearPairing();
    const id = `${msg.platform}:${msg.senderId}`;
    const existingIdx = this.state.boundUsers.findIndex((u) => u.id === id);
    const record: ImBotBoundUserView = {
      id,
      platform: msg.platform,
      userId: msg.senderId,
      ...(msg.senderName ? { userName: msg.senderName } : {}),
      chatId: msg.chatId,
      chatType: msg.chatType,
      boundAt: existingIdx >= 0 ? this.state.boundUsers[existingIdx]!.boundAt : now,
      lastActiveAt: now,
    };
    const nextUsers =
      existingIdx >= 0
        ? this.state.boundUsers.map((u, i) => (i === existingIdx ? record : u))
        : [record, ...this.state.boundUsers];
    this.state = { ...this.state, boundUsers: nextUsers };
    this.lastActiveCtx.set(msg.platform, msg.replyContext);
    await this.persistState();
    this.options.onStateChange();

    await adapter.sendMessage(
      msg.chatId,
      zh
        ? '✅ 授权绑定成功！现在你可以直接发消息与 Halo 编程代理双向聊天。\n\n常用指令：`/status` 状态 · `/new` 新建对话 · `/stop` 停止生成 · `/sessions` 会话列表 · `/help` 帮助'
        : '✅ Paired successfully! You can now chat with Halo directly.\n\nCommands: `/status` · `/new` · `/stop` · `/sessions` · `/help`',
      msg.replyContext,
    );
  }

  private async handleSlashCommand(
    adapter: ImBotAdapter,
    msg: ImBotInboundMessage,
    text: string,
  ): Promise<boolean> {
    const zh = this.options.locale() === 'zh';
    const [rawCmd, ...rest] = text.split(/\s+/u);
    const cmd = (rawCmd ?? '').toLowerCase();
    const arg = rest.join(' ').trim();

    if (cmd === '/help') {
      await adapter.sendMessage(
        msg.chatId,
        zh
          ? [
              '**Halo IM 机器人指令**',
              '- 直接发送文本：向当前会话发消息（与 IDE / 手机端实时同步）',
              '- `/status`：查看当前智能体、模型、工作区与会话状态',
              '- `/new`：新建一段空白会话',
              '- `/stop`：立即停止当前正在生成的回复',
              '- `/sessions`：列出最近会话（带序号）',
              '- `/switch <序号或会话ID>`：切换到指定会话',
              '- 审批/提问出现时：直接回复 `允许`/`始终允许`/`拒绝` 或选项编号',
            ].join('\n')
          : [
              '**Halo IM Bot Commands**',
              '- Send any text: chat with the active Halo session (synced with IDE & Mobile)',
              '- `/status`: show active backend, model, workspace, and session status',
              '- `/new`: start a new session',
              '- `/stop`: interrupt the running turn',
              '- `/sessions`: list recent sessions',
              '- `/switch <index|id>`: switch to a session',
              '- When approval/question appears: reply `allow`/`always`/`reject` or option number',
            ].join('\n'),
        msg.replyContext,
      );
      return true;
    }

    if (cmd === '/status') {
      const snap = this.options.getSnapshot();
      const backend =
        snap?.backends.items.find((b) => b.id === snap.backends.active)?.name ??
        snap?.backends.active ??
        '-';
      const model = snap?.models.current?.model ?? '-';
      const workspace = snap?.backends.workspace ?? snap?.session.folder ?? '-';
      const sessionTitle = snap?.session.title || (zh ? '新对话' : 'New chat');
      const running = snap?.session.running ? (zh ? '运行中' : 'Running') : (zh ? '空闲' : 'Idle');
      const pendingCount = snap?.interactions.length ?? 0;
      await adapter.sendMessage(
        msg.chatId,
        zh
          ? [
              '**Halo 当前状态**',
              `- 智能体：${backend}`,
              `- 模型：${model}`,
              `- 工作区：${workspace}`,
              `- 会话：${sessionTitle}`,
              `- 状态：${running}${pendingCount > 0 ? `（待处理交互 ${pendingCount} 项）` : ''}`,
            ].join('\n')
          : [
              '**Halo Status**',
              `- Agent: ${backend}`,
              `- Model: ${model}`,
              `- Workspace: ${workspace}`,
              `- Session: ${sessionTitle}`,
              `- State: ${running}${pendingCount > 0 ? ` (${pendingCount} pending interaction)` : ''}`,
            ].join('\n'),
        msg.replyContext,
      );
      return true;
    }

    if (cmd === '/new') {
      this.options.ensureBackendStarted();
      this.finalizeActiveReplySilently();
      this.options.dispatchMessage({ type: 'newSession', payload: {} });
      await adapter.sendMessage(
        msg.chatId,
        zh ? '✨ 已新建对话，请直接发送你的问题。' : '✨ Started a new session. Send your prompt anytime.',
        msg.replyContext,
      );
      return true;
    }

    if (cmd === '/stop') {
      this.options.dispatchMessage({ type: 'interrupt', payload: {} });
      await adapter.sendMessage(
        msg.chatId,
        zh ? '🛑 已发送停止生成指令。' : '🛑 Interrupt requested.',
        msg.replyContext,
      );
      return true;
    }

    if (cmd === '/sessions') {
      const snap = this.options.getSnapshot();
      const list = (snap?.sessions ?? []).slice(0, 10);
      if (list.length === 0) {
        await adapter.sendMessage(
          msg.chatId,
          zh ? '暂无历史会话。发送 `/new` 或直接发消息开始新对话。' : 'No recent sessions found.',
          msg.replyContext,
        );
        return true;
      }
      const currentId = snap?.session.id;
      const lines = [zh ? '**最近会话**（用 `/switch 序号` 切换）' : '**Recent Sessions** (use `/switch <n>`)'];
      list.forEach((s, idx) => {
        const mark = s.id === currentId ? (zh ? ' ← 当前' : ' ← active') : '';
        const run = s.running ? ' ⏳' : '';
        lines.push(`${idx + 1}. ${s.title}${run}${mark}`);
      });
      await adapter.sendMessage(msg.chatId, lines.join('\n'), msg.replyContext);
      return true;
    }

    if (cmd === '/switch') {
      if (!arg) {
        await adapter.sendMessage(
          msg.chatId,
          zh ? '用法：`/switch <序号或会话ID>`（可先发送 `/sessions` 查看列表）' : 'Usage: `/switch <index|sessionId>`',
          msg.replyContext,
        );
        return true;
      }
      const snap = this.options.getSnapshot();
      const list = snap?.sessions ?? [];
      let target = list.find((s) => s.id === arg);
      if (!target && /^\d+$/u.test(arg)) {
        const idx = Number(arg) - 1;
        target = list[idx];
      }
      if (!target) {
        await adapter.sendMessage(
          msg.chatId,
          zh ? `未找到对应会话：${arg}` : `Session not found: ${arg}`,
          msg.replyContext,
        );
        return true;
      }
      this.options.ensureBackendStarted();
      this.finalizeActiveReplySilently();
      this.options.dispatchMessage({ type: 'switchSession', payload: { sessionId: target.id } });
      await adapter.sendMessage(
        msg.chatId,
        zh ? `🔄 已切换到会话：**${target.title}**` : `🔄 Switched to session: **${target.title}**`,
        msg.replyContext,
      );
      return true;
    }

    // 其他未知 `/` 命令（可能是底层代理自带的斜杠命令如 /compact、/review），透传给代理处理
    return false;
  }

  private async handleInteractionReply(
    adapter: ImBotAdapter,
    msg: ImBotInboundMessage,
    interaction: PendingInteraction,
    text: string,
  ): Promise<void> {
    const zh = this.options.locale() === 'zh';
    const commandId = `im_${randomUUID()}`;

    if (interaction.kind === 'approval') {
      const decision = parseApprovalReply(text, Boolean(interaction.allowAlways));
      if (!decision) {
        await adapter.sendMessage(
          msg.chatId,
          zh
            ? `当前有待处理审批（${interaction.toolName}），请回复 \`允许\`（1）${interaction.allowAlways ? '、`始终允许`（2）' : ''} 或 \`拒绝\`（${interaction.allowAlways ? '3' : '2'}）。`
            : `Pending approval (${interaction.toolName}). Reply \`allow\` (1)${interaction.allowAlways ? ', `always` (2)' : ''}, or \`reject\` (${interaction.allowAlways ? '3' : '2'}).`,
          msg.replyContext,
        );
        return;
      }
      this.options.dispatchMessage({
        type: 'respondApproval',
        commandId,
        payload: { id: interaction.id, decision },
      });
      const label =
        decision === 'allow'
          ? zh ? '✅ 已允许本次操作，代理继续执行…' : '✅ Allowed once. Continuing…'
          : decision === 'allowAlways'
            ? zh ? '✅ 已始终允许此类操作，代理继续执行…' : '✅ Always allowed. Continuing…'
            : zh ? '🛑 已拒绝该操作。' : '🛑 Rejected.';
      await adapter.sendMessage(msg.chatId, label, msg.replyContext);
      return;
    }

    const payload = parseQuestionReply(interaction, text);
    this.options.dispatchMessage({
      type: 'answerQuestion',
      commandId,
      payload,
    });
    const label =
      'cancelled' in payload
        ? zh ? '已取消该提问。' : 'Question cancelled.'
        : zh ? '✅ 已提交回答，代理继续执行…' : '✅ Answer submitted. Continuing…';
    await adapter.sendMessage(msg.chatId, label, msg.replyContext);
  }

  private async handleChatPrompt(
    adapter: ImBotAdapter,
    msg: ImBotInboundMessage,
    text: string,
  ): Promise<void> {
    this.options.ensureBackendStarted();
    // 同步当前快照作为本轮基线，确保只提取本轮新产生的助手输出
    const snap = this.options.getSnapshot();
    if (snap) {
      this.mirroredSessionKey = snap.session.id ?? '';
      this.mirroredItemOrder = snap.items.map((it) => it.id);
      this.mirroredItems = new Map(snap.items.map((it) => [it.id, it]));
      this.mirroredRunning = snap.session.running;
      this.mirroredInteractions = snap.interactions;
    }

    // 若上一轮 IM 回复尚未收尾，先静默结束旧 handle
    if (this.activeReply) {
      this.clearActiveReplyTimers();
      const prev = this.activeReply;
      this.activeReply = undefined;
      if (prev.lastRenderedText) {
        void prev.handle.finish(prev.lastRenderedText).catch(() => undefined);
      }
    }

    const baselineItemIds = new Set(this.mirroredItemOrder);
    const initialHint =
      msg.platform === 'wecom'
        ? this.options.locale() === 'zh'
          ? '⏳ 思考中…'
          : '⏳ Thinking…'
        : undefined;
    const handle = await adapter.beginReply(msg.replyContext, initialHint);

    const active: ActiveTurnReply = {
      platform: msg.platform,
      ctx: msg.replyContext,
      handle,
      baselineItemIds,
      sawRunning: false,
      startedAt: (this.options.now ?? Date.now)(),
      lastRenderedText: '',
    };
    this.activeReply = active;

    // 兜底：若 10 分钟后仍未观察到结束信号则清理，避免内存泄漏
    active.fallbackTimer = setTimeout(() => {
      if (this.activeReply === active) {
        void this.finishActiveReply();
      }
    }, 10 * 60 * 1000);
    active.fallbackTimer.unref?.();

    this.options.dispatchMessage({
      type: 'sendMessage',
      commandId: `im_${randomUUID()}`,
      payload: { text, includeActive: false },
    });
  }

  private applyItemsPatch(patch: ItemsPatch): void {
    if (patch.reset) {
      this.mirroredSessionKey = patch.sessionKey;
      this.mirroredItems = new Map(patch.upsert.map((it) => [it.id, it]));
      this.mirroredItemOrder = [...patch.order];
      return;
    }
    if (this.mirroredSessionKey && patch.sessionKey && patch.sessionKey !== this.mirroredSessionKey) {
      // 会话刚从空 key 绑定为真实 sessionId，兼容平滑切换
      this.mirroredSessionKey = patch.sessionKey;
    }
    for (const item of patch.upsert) {
      this.mirroredItems.set(item.id, item);
    }
    this.mirroredItemOrder = [...patch.order];
  }

  private handleInteractionsUpdate(interactions: readonly PendingInteraction[]): void {
    this.mirroredInteractions = interactions;
    // 若当前存在待处理审批或提问，暂停本轮流式收口计时器，避免在用户批准前提前结束回复流
    if (interactions.length > 0 && this.activeReply?.settleTimer) {
      clearTimeout(this.activeReply.settleTimer);
      this.activeReply.settleTimer = undefined;
    }
    const currentIds = new Set(interactions.map((it) => it.id));
    for (const id of [...this.notifiedInteractionIds]) {
      if (!currentIds.has(id)) this.notifiedInteractionIds.delete(id);
    }

    for (const interaction of interactions) {
      if (this.notifiedInteractionIds.has(interaction.id)) continue;
      this.notifiedInteractionIds.add(interaction.id);
      void this.pushInteractionToIm(interaction);
    }
  }

  private async pushInteractionToIm(interaction: PendingInteraction): Promise<void> {
    const text = formatInteractionForIm(interaction, this.options.locale());

    // 优先推送到正在等待的 IM 对话窗口；剥离 reqId 以免企业微信在活动流式会话中误发 finish: true 提前关闭原流
    if (this.activeReply) {
      const adapter = this.adapters.get(this.activeReply.platform);
      if (adapter) {
        const { reqId: _omitReqId, ...midTurnCtx } = this.activeReply.ctx;
        await adapter.sendMessage(this.activeReply.ctx.chatId, text, midTurnCtx);
        return;
      }
    }

    // 否则在 IDE 不在前台时，主动推送给已连接且近期活跃的已绑定 IM 聊天窗口（剥离过期 reqId，走主动推送接口）
    if (this.options.isWindowFocused()) return;
    for (const [platform, adapter] of this.adapters.entries()) {
      if (adapter.getStatus().status !== 'connected') continue;
      const ctx = this.lastActiveCtx.get(platform);
      if (ctx) {
        const { reqId: _omitReqId, ...proactiveCtx } = ctx;
        await adapter.sendMessage(ctx.chatId, text, proactiveCtx);
        continue;
      }
      const bound = this.state.boundUsers.find((u) => u.platform === platform && u.chatId);
      if (bound?.chatId) {
        await adapter.sendMessage(bound.chatId, text);
      }
    }
  }

  private handleTurnProgress(wasRunning: boolean, isRunning: boolean): void {
    const active = this.activeReply;
    if (!active) return;

    const { text, hasStreamingAssistant, hasNewOutput } = this.extractTurnOutput(active.baselineItemIds);
    if (isRunning || hasStreamingAssistant) {
      active.sawRunning = true;
    }

    if (text && text !== active.lastRenderedText) {
      active.lastRenderedText = text;
      void active.handle.update(text).catch((err) => {
        this.options.log(`[IM Bot:${active.platform}] stream update error: ${String(err)}`);
      });
    }

    const hasPendingInteractions = this.mirroredInteractions.length > 0;
    const turnSettled =
      !hasPendingInteractions &&
      ((wasRunning && !isRunning) ||
        (active.sawRunning && !isRunning && !hasStreamingAssistant) ||
        (!isRunning && hasNewOutput && !hasStreamingAssistant));

    if (turnSettled) {
      if (active.settleTimer) clearTimeout(active.settleTimer);
      active.settleTimer = setTimeout(() => {
        if (this.activeReply === active && !this.mirroredRunning && this.mirroredInteractions.length === 0) {
          void this.finishActiveReply();
        }
      }, 250);
      active.settleTimer.unref?.();
    } else if (active.settleTimer && (isRunning || hasPendingInteractions)) {
      clearTimeout(active.settleTimer);
      active.settleTimer = undefined;
    }
  }

  private extractTurnOutput(baselineItemIds: ReadonlySet<string>): {
    readonly text: string;
    readonly hasStreamingAssistant: boolean;
    readonly hasNewOutput: boolean;
  } {
    const zh = this.options.locale() === 'zh';
    const assistantParts: string[] = [];
    const notices: string[] = [];
    const runningTools: string[] = [];
    let changedFilesCount = 0;
    let hasStreamingAssistant = false;
    let hasNewOutput = false;

    for (const id of this.mirroredItemOrder) {
      if (baselineItemIds.has(id)) continue;
      const item = this.mirroredItems.get(id);
      if (!item) continue;
      if (item.kind === 'assistant') {
        if (item.streaming) hasStreamingAssistant = true;
        if (item.markdown.trim()) {
          assistantParts.push(item.markdown.trim());
          hasNewOutput = true;
        }
      } else if (item.kind === 'activity' && item.status === 'running') {
        runningTools.push(item.tool);
      } else if (item.kind === 'changes') {
        changedFilesCount += item.files.length;
      } else if (item.kind === 'notice' && item.level === 'error') {
        notices.push(item.text);
        hasNewOutput = true;
      }
    }

    if (assistantParts.length > 0) {
      const blocks = [assistantParts.join('\n\n')];
      if (changedFilesCount > 0 && !hasStreamingAssistant && !this.mirroredRunning) {
        blocks.push(
          zh
            ? `---\n📝 本轮共改动 ${changedFilesCount} 个文件`
            : `---\n📝 Modified ${changedFilesCount} file(s)`,
        );
      }
      if (notices.length > 0) {
        blocks.push(notices.map((n) => `⚠️ ${n}`).join('\n'));
      }
      return { text: blocks.join('\n\n'), hasStreamingAssistant, hasNewOutput };
    }

    if (notices.length > 0) {
      return {
        text: notices.map((n) => `⚠️ ${n}`).join('\n'),
        hasStreamingAssistant,
        hasNewOutput: true,
      };
    }

    if (runningTools.length > 0) {
      const latest = runningTools[runningTools.length - 1]!;
      return {
        text: zh ? `⏳ 正在执行 ${latest}…` : `⏳ Running ${latest}…`,
        hasStreamingAssistant,
        hasNewOutput: false,
      };
    }

    return { text: '', hasStreamingAssistant, hasNewOutput };
  }

  private async finishActiveReply(): Promise<void> {
    const active = this.activeReply;
    if (!active) return;
    this.clearActiveReplyTimers();
    this.activeReply = undefined;

    const { text } = this.extractTurnOutput(active.baselineItemIds);
    const zh = this.options.locale() === 'zh';
    const finalText = text || active.lastRenderedText || (zh ? '本轮已完成。' : 'Turn completed.');
    try {
      await active.handle.finish(finalText);
    } catch (error) {
      this.options.log(`[IM Bot:${active.platform}] finish reply error: ${String(error)}`);
    }
  }

  private finalizeActiveReplySilently(): void {
    this.clearActiveReplyTimers();
    this.activeReply = undefined;
  }

  private clearActiveReplyTimers(): void {
    if (this.activeReply?.settleTimer) {
      clearTimeout(this.activeReply.settleTimer);
      this.activeReply.settleTimer = undefined;
    }
    if (this.activeReply?.fallbackTimer) {
      clearTimeout(this.activeReply.fallbackTimer);
      this.activeReply.fallbackTimer = undefined;
    }
  }

  private currentPendingInteractions(): readonly PendingInteraction[] {
    const live = this.options.getSnapshot()?.interactions;
    return live && live.length > 0 ? live : this.mirroredInteractions;
  }

  private isAuthorized(platform: ImBotPlatform, senderId: string, chatId: string): boolean {
    if (this.state.boundUsers.some((u) => u.platform === platform && u.userId === senderId)) {
      return true;
    }
    const allow = this.state.channels[platform].allowlist;
    return allow.includes(senderId) || allow.includes(chatId);
  }

  private async touchBoundUser(msg: ImBotInboundMessage, now: number): Promise<void> {
    const id = `${msg.platform}:${msg.senderId}`;
    const idx = this.state.boundUsers.findIndex((u) => u.id === id);
    if (idx < 0) return;
    const prev = this.state.boundUsers[idx]!;
    // 超过 30 秒或聊天上下文变更时再落盘，避免频繁写 globalState
    if (
      now - prev.lastActiveAt < 30_000 &&
      prev.chatId === msg.chatId &&
      (!msg.senderName || prev.userName === msg.senderName)
    ) {
      return;
    }
    const updated: ImBotBoundUserView = {
      ...prev,
      ...(msg.senderName ? { userName: msg.senderName } : {}),
      chatId: msg.chatId,
      chatType: msg.chatType,
      lastActiveAt: now,
    };
    this.state = {
      ...this.state,
      boundUsers: this.state.boundUsers.map((u, i) => (i === idx ? updated : u)),
    };
    await this.persistState();
    this.options.onStateChange();
  }

  private pruneSeenMessages(now: number): void {
    if (this.seenMessages.size < 200) return;
    for (const [key, ts] of this.seenMessages.entries()) {
      if (now - ts > DEDUP_TTL_MS) this.seenMessages.delete(key);
    }
  }

  private async persistState(): Promise<void> {
    await this.options.globalState.update(IM_BOTS_STORAGE_KEY, this.state);
  }
}

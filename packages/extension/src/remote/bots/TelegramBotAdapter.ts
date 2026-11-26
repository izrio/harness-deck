/**
 * Telegram Bot 长轮询双向聊天适配器：
 * - 零公网 IP：通过 `getUpdates` 长轮询实时接收消息，支持自定义 API 代理根地址
 * - 自动校验 `getMe` 获取机器人用户名，用于在群聊中精准识别 `@bot` 提及与回复
 * - 支持 `sendChatAction('typing')`、`sendMessage` + 节流 `editMessageText` 流式更新与超长消息自动分段
 */
import {
  computeReconnectDelay,
  splitMarkdownChunks,
  type ImBotAdapter,
  type ImBotAdapterCallbacks,
  type ImBotAdapterStatus,
  type ImBotReplyContext,
  type ImBotStreamHandle,
} from './types.ts';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_STREAM_THROTTLE_MS = 1_200;
const TELEGRAM_MAX_CHUNK_CHARS = 3_900;
const TELEGRAM_POLL_TIMEOUT_SEC = 25;

export interface TelegramBotAdapterOptions {
  readonly botToken: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly pollTimeoutSec?: number;
  readonly reconnectBaseMs?: number;
  readonly now?: () => number;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly date?: number;
    readonly text?: string;
    readonly from?: {
      readonly id: number;
      readonly is_bot?: boolean;
      readonly username?: string;
      readonly first_name?: string;
      readonly last_name?: string;
    };
    readonly chat: {
      readonly id: number;
      readonly type: 'private' | 'group' | 'supergroup' | 'channel';
    };
    readonly reply_to_message?: {
      readonly from?: {
        readonly is_bot?: boolean;
        readonly username?: string;
      };
    };
  };
}

export class TelegramBotAdapter implements ImBotAdapter {
  readonly platform = 'telegram' as const;

  private status: ImBotAdapterStatus = { status: 'stopped' };
  private running = false;
  private abortController: AbortController | undefined;
  private pollOffset = 0;
  private botUsername: string | undefined;
  private errorAttempt = 0;

  constructor(
    private readonly options: TelegramBotAdapterOptions,
    private readonly callbacks: ImBotAdapterCallbacks,
  ) {}

  getStatus(): ImBotAdapterStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.cleanToken()) {
      this.setStatus({ status: 'error', error: 'Missing Telegram Bot Token' });
      return;
    }
    this.running = true;
    this.errorAttempt = 0;
    this.setStatus({ status: 'connecting' });
    void this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = undefined;
    this.setStatus({ status: 'stopped' });
  }

  async beginReply(ctx: ImBotReplyContext, initialText?: string): Promise<ImBotStreamHandle> {
    let replyMsgId: number | undefined;
    let lastSentAt = 0;
    let lastContent = '';
    let finished = false;
    const now = this.options.now ?? Date.now;

    void this.sendChatAction(ctx.chatId, 'typing');

    const sendOrEdit = async (text: string): Promise<void> => {
      if (replyMsgId !== undefined) {
        const edited = await this.editMessage(ctx.chatId, replyMsgId, text);
        if (edited) {
          lastSentAt = now();
          lastContent = text;
          return;
        }
      }
      const created = await this.sendSingleMessage(
        ctx.chatId,
        text,
        replyMsgId === undefined ? ctx.messageId : undefined,
      );
      if (created !== undefined) {
        replyMsgId = created;
        lastSentAt = now();
        lastContent = text;
      }
    };

    if (initialText?.trim()) {
      await sendOrEdit(initialText.trim());
    }

    return {
      update: async (markdown: string) => {
        if (finished) return;
        const trimmed = markdown.trim();
        if (!trimmed || trimmed === lastContent) return;
        if (now() - lastSentAt < TELEGRAM_STREAM_THROTTLE_MS) return;
        const clipped =
          trimmed.length > TELEGRAM_MAX_CHUNK_CHARS
            ? `${trimmed.slice(0, TELEGRAM_MAX_CHUNK_CHARS)}\n\n…`
            : trimmed;
        await sendOrEdit(clipped);
      },
      finish: async (markdown: string) => {
        if (finished) return;
        finished = true;
        const chunks = splitMarkdownChunks(markdown || '已完成。', TELEGRAM_MAX_CHUNK_CHARS);
        await sendOrEdit(chunks[0]!);
        for (const extra of chunks.slice(1)) {
          await this.sendSingleMessage(ctx.chatId, extra);
        }
      },
    };
  }

  async sendMessage(chatId: string, text: string, ctx?: ImBotReplyContext): Promise<void> {
    const chunks = splitMarkdownChunks(text, TELEGRAM_MAX_CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i += 1) {
      await this.sendSingleMessage(chatId, chunks[i]!, i === 0 ? ctx?.messageId : undefined);
    }
  }

  async testConnection(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.cleanToken()) {
      return { ok: false, detail: 'Missing Bot Token' };
    }
    try {
      const me = await this.callApi<{ readonly username?: string; readonly first_name?: string }>('getMe', {});
      const name = me.username ? `@${me.username}` : me.first_name || 'OK';
      return { ok: true, detail: name };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.botUsername) {
          const me = await this.callApi<{ readonly username?: string }>('getMe', {});
          if (!this.running) return;
          this.botUsername = me.username?.trim();
          this.errorAttempt = 0;
          const now = (this.options.now ?? Date.now)();
          this.setStatus({
            status: 'connected',
            lastConnectedAt: now,
            ...(this.botUsername ? { botName: `@${this.botUsername}` } : {}),
          });
          this.callbacks.log(
            `[IM Bot:telegram] Connected${this.botUsername ? ` as @${this.botUsername}` : ''}`,
          );
        }

        const timeoutSec = this.options.pollTimeoutSec ?? TELEGRAM_POLL_TIMEOUT_SEC;
        this.abortController = new AbortController();
        const updates = await this.callApi<readonly TelegramUpdate[]>(
          'getUpdates',
          {
            offset: this.pollOffset,
            timeout: timeoutSec,
            allowed_updates: ['message'],
          },
          this.abortController.signal,
          (timeoutSec + 10) * 1000,
        );
        this.abortController = undefined;
        if (!this.running) return;

        if (this.status.status !== 'connected') {
          this.errorAttempt = 0;
          this.setStatus({
            status: 'connected',
            lastConnectedAt: (this.options.now ?? Date.now)(),
            ...(this.botUsername ? { botName: `@${this.botUsername}` } : {}),
          });
        }

        for (const update of updates) {
          if (update.update_id >= this.pollOffset) {
            this.pollOffset = update.update_id + 1;
          }
          this.dispatchUpdate(update);
        }
      } catch (error) {
        this.abortController = undefined;
        if (!this.running) return;
        const msg = error instanceof Error ? error.message : String(error);
        this.errorAttempt += 1;
        this.callbacks.log(`[IM Bot:telegram] Poll error: ${msg}`);
        this.setStatus({
          status: 'reconnecting',
          error: msg,
          ...(this.status.lastConnectedAt ? { lastConnectedAt: this.status.lastConnectedAt } : {}),
          ...(this.botUsername ? { botName: `@${this.botUsername}` } : {}),
        });
        const delay = computeReconnectDelay(this.errorAttempt - 1, this.options.reconnectBaseMs);
        await this.sleepAbortable(delay);
      }
    }
  }

  private dispatchUpdate(update: TelegramUpdate): void {
    const msg = update.message;
    if (!msg || !msg.text || !msg.from || msg.from.is_bot) return;

    const chatType: 'single' | 'group' = msg.chat.type === 'private' ? 'single' : 'group';
    const rawText = msg.text;
    let mentionedBot = false;
    let cleanedText = rawText.trim();

    if (chatType === 'group') {
      const escapedUser = this.botUsername
        ? this.botUsername.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        : undefined;
      if (escapedUser) {
        const mentionRe = new RegExp(`@${escapedUser}\\b`, 'iu');
        if (mentionRe.test(rawText)) {
          mentionedBot = true;
          cleanedText = rawText.replace(new RegExp(`@${escapedUser}\\b`, 'giu'), '').trim();
        }
      }
      if (
        !mentionedBot &&
        msg.reply_to_message?.from?.is_bot &&
        (!this.botUsername ||
          msg.reply_to_message.from.username?.toLowerCase() === this.botUsername.toLowerCase())
      ) {
        mentionedBot = true;
      }
      // `/command@botUsername args` 形式
      if (escapedUser && cleanedText.startsWith('/')) {
        cleanedText = cleanedText.replace(new RegExp(`^(/[a-z0-9_]+)@${escapedUser}\\b`, 'iu'), '$1');
      }
    }

    if (!cleanedText) return;

    const senderId = String(msg.from.id);
    const senderName =
      msg.from.username
        ? `@${msg.from.username}`
        : [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || undefined;
    const chatId = String(msg.chat.id);
    const messageId = String(msg.message_id);

    this.callbacks.onMessage({
      platform: 'telegram',
      messageId,
      senderId,
      ...(senderName ? { senderName } : {}),
      chatId,
      chatType,
      mentionedBot,
      text: cleanedText,
      replyContext: {
        platform: 'telegram',
        chatId,
        chatType,
        senderId,
        ...(senderName ? { senderName } : {}),
        messageId,
      },
      timestamp: msg.date ? msg.date * 1000 : (this.options.now ?? Date.now)(),
    });
  }

  private cleanToken(): string {
    return this.options.botToken.trim().replace(/^bot/iu, '');
  }

  private apiRoot(): string {
    const raw = this.options.apiBase?.trim();
    if (raw && /^https?:\/\//iu.test(raw)) {
      return raw.replace(/\/+$/u, '');
    }
    return DEFAULT_TELEGRAM_API_BASE;
  }

  private async callApi<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<T> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const url = `${this.apiRoot()}/bot${this.cleanToken()}/${method}`;
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: combinedSignal,
    });
    const json = (await res.json()) as { readonly ok?: boolean; readonly result?: T; readonly description?: string };
    if (!res.ok || !json.ok) {
      throw new Error(json.description || `Telegram API HTTP ${res.status}`);
    }
    return json.result as T;
  }

  private async sendChatAction(chatId: string, action: 'typing'): Promise<void> {
    try {
      await this.callApi('sendChatAction', { chat_id: chatId, action });
    } catch {
      // ignore
    }
  }

  private async sendSingleMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<number | undefined> {
    try {
      const result = await this.callApi<{ readonly message_id?: number }>('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(replyToMessageId && /^\d+$/u.test(replyToMessageId)
          ? { reply_parameters: { message_id: Number(replyToMessageId) } }
          : {}),
      });
      return result.message_id;
    } catch (error) {
      this.callbacks.log(`[IM Bot:telegram] sendMessage failed: ${String(error)}`);
      return undefined;
    }
  }

  private async editMessage(chatId: string, messageId: number, text: string): Promise<boolean> {
    try {
      await this.callApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
      });
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.toLowerCase().includes('message is not modified')) return true;
      return false;
    }
  }

  private async sleepAbortable(ms: number): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      const ac = new AbortController();
      this.abortController = ac;
      const timer = setTimeout(() => {
        if (this.abortController === ac) this.abortController = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      ac.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private setStatus(next: ImBotAdapterStatus): void {
    this.status = next;
    this.callbacks.onStatusChange(next);
  }
}

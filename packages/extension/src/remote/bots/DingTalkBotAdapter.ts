/**
 * 钉钉企业自建机器人 Stream 模式长连接适配器：
 * - 零公网 IP：调用 `POST https://api.dingtalk.com/v1.0/gateway/connections/open` 订阅 `/v1.0/im/bot/messages/get`
 * - 自动应答 `SYSTEM/ping`（原样回传 `opaque`）、处理 `SYSTEM/disconnect` 平滑重连、即时 ACK `CALLBACK` 帧
 * - 优先通过入站 `sessionWebhook` 回复 Markdown；过期或主动推送时自动回退到钉钉 OpenAPI（`accessToken`）
 */
import WebSocket from 'ws';
import {
  computeReconnectDelay,
  rawDataToBuffer,
  splitMarkdownChunks,
  stripLeadingMentions,
  type ImBotAdapter,
  type ImBotAdapterCallbacks,
  type ImBotAdapterStatus,
  type ImBotReplyContext,
  type ImBotSocketLike,
  type ImBotStreamHandle,
  type WebSocketFactory,
} from './types.ts';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const DINGTALK_BOT_TOPIC = '/v1.0/im/bot/messages/get';
const DINGTALK_MAX_CHUNK_CHARS = 3_800;

export interface DingTalkBotAdapterOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly createWebSocket?: WebSocketFactory;
  readonly reconnectBaseMs?: number;
  readonly now?: () => number;
}

interface DingTalkStreamFrame {
  readonly specVersion?: string;
  readonly type?: string;
  readonly headers?: {
    readonly messageId?: string;
    readonly topic?: string;
    readonly contentType?: string;
  };
  readonly data?: string;
}

interface DingTalkBotCallbackData {
  readonly msgId?: string;
  readonly senderStaffId?: string;
  readonly senderId?: string;
  readonly senderNick?: string;
  readonly conversationId?: string;
  readonly conversationType?: string; // '1' = single, '2' = group
  readonly isInAtList?: boolean;
  readonly robotCode?: string;
  readonly sessionWebhook?: string;
  readonly sessionWebhookExpiredTime?: number;
  readonly msgtype?: string;
  readonly text?: { readonly content?: string };
}

export class DingTalkBotAdapter implements ImBotAdapter {
  readonly platform = 'dingtalk' as const;

  private status: ImBotAdapterStatus = { status: 'stopped' };
  private socket: ImBotSocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private running = false;
  private cachedToken: { readonly token: string; readonly expiresAt: number } | undefined;

  constructor(
    private readonly options: DingTalkBotAdapterOptions,
    private readonly callbacks: ImBotAdapterCallbacks,
  ) {}

  getStatus(): ImBotAdapterStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.options.clientId.trim() || !this.options.clientSecret.trim()) {
      this.setStatus({ status: 'error', error: 'Missing DingTalk Client ID or Client Secret' });
      return;
    }
    this.running = true;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearReconnectTimer();
    const ws = this.socket;
    this.socket = undefined;
    if (ws) {
      try {
        ws.close(1000, 'Bot stopped');
      } catch {
        // ignore
      }
    }
    this.setStatus({ status: 'stopped' });
  }

  async beginReply(ctx: ImBotReplyContext): Promise<ImBotStreamHandle> {
    let finished = false;
    return {
      // 钉钉 sessionWebhook 不支持原地编辑，静默等待本轮完成或审批事件再推送，避免刷屏
      update: async () => undefined,
      finish: async (markdown: string) => {
        if (finished) return;
        finished = true;
        await this.sendMessage(ctx.chatId, markdown || '已完成。', ctx);
      },
    };
  }

  async sendMessage(chatId: string, text: string, ctx?: ImBotReplyContext): Promise<void> {
    const chunks = splitMarkdownChunks(text, DINGTALK_MAX_CHUNK_CHARS);
    const now = (this.options.now ?? Date.now)();
    const hasValidSessionWebhook =
      Boolean(ctx?.sessionWebhook) &&
      (!ctx?.sessionWebhookExpiredTime || ctx.sessionWebhookExpiredTime - now > 10_000);

    for (const chunk of chunks) {
      if (hasValidSessionWebhook && ctx?.sessionWebhook) {
        const ok = await this.postSessionWebhook(ctx.sessionWebhook, chunk);
        if (ok) continue;
      }
      await this.sendViaOpenApi(chatId, chunk, ctx);
    }
  }

  async testConnection(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.options.clientId.trim() || !this.options.clientSecret.trim()) {
      return { ok: false, detail: 'Missing Client ID or Client Secret' };
    }
    try {
      const token = await this.fetchAccessToken(true);
      return token ? { ok: true, detail: 'Authenticated' } : { ok: false, detail: 'Failed to obtain access token' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.clearReconnectTimer();
    this.setStatus({
      status: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      ...(this.status.lastConnectedAt ? { lastConnectedAt: this.status.lastConnectedAt } : {}),
    });

    let wsUrl: string;
    try {
      wsUrl = await this.openGatewayConnection();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.callbacks.log(`[IM Bot:dingtalk] Gateway registration failed: ${msg}`);
      this.scheduleReconnect(msg);
      return;
    }

    if (!this.running) return;
    const factory = this.options.createWebSocket ?? ((u: string) => new WebSocket(u));
    let ws: ImBotSocketLike;
    try {
      ws = factory(wsUrl);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = ws;

    ws.on('open', () => {
      if (this.socket !== ws || !this.running) return;
      this.reconnectAttempt = 0;
      const now = (this.options.now ?? Date.now)();
      this.setStatus({ status: 'connected', lastConnectedAt: now });
      this.callbacks.log('[IM Bot:dingtalk] Stream WebSocket connected');
    });

    ws.on('message', (raw) => {
      if (this.socket !== ws || !this.running) return;
      let frame: DingTalkStreamFrame;
      try {
        frame = JSON.parse(rawDataToBuffer(raw).toString('utf8')) as DingTalkStreamFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on('error', (err) => {
      if (this.socket !== ws || !this.running) return;
      this.callbacks.log(`[IM Bot:dingtalk] WebSocket error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      if (!this.running) return;
      const text = reason?.toString('utf8') || `code ${code}`;
      this.scheduleReconnect(`WebSocket closed (${text})`);
    });
  }

  private handleFrame(frame: DingTalkStreamFrame): void {
    const messageId = frame.headers?.messageId;
    const topic = frame.headers?.topic;

    if (frame.type === 'SYSTEM') {
      if (topic === 'ping' && messageId) {
        this.sendAck(messageId, frame.data ?? '{}');
      } else if (topic === 'disconnect') {
        if (messageId) this.sendAck(messageId, '{}');
        try {
          this.socket?.close(1000, 'Server requested disconnect');
        } catch {
          // ignore
        }
      }
      return;
    }

    if (frame.type !== 'CALLBACK') return;
    if (messageId) {
      this.sendAck(messageId, '{}');
    }
    if (topic !== DINGTALK_BOT_TOPIC || !frame.data) return;

    let payload: DingTalkBotCallbackData;
    try {
      payload = JSON.parse(frame.data) as DingTalkBotCallbackData;
    } catch {
      return;
    }

    const senderId = (payload.senderStaffId || payload.senderId || '').trim();
    const chatId = (payload.conversationId || senderId).trim();
    const rawText = payload.text?.content ?? '';
    const chatType: 'single' | 'group' = payload.conversationType === '2' ? 'group' : 'single';
    const text = chatType === 'group' ? stripLeadingMentions(rawText) : rawText.trim();
    if (!senderId || !chatId || !text) return;

    const msgId = (payload.msgId || messageId || `dt_${Date.now()}`).trim();
    const mentionedBot = chatType === 'group' ? payload.isInAtList !== false : false;

    this.callbacks.onMessage({
      platform: 'dingtalk',
      messageId: msgId,
      senderId,
      ...(payload.senderNick ? { senderName: payload.senderNick } : {}),
      chatId,
      chatType,
      mentionedBot,
      text,
      replyContext: {
        platform: 'dingtalk',
        chatId,
        chatType,
        senderId,
        ...(payload.senderNick ? { senderName: payload.senderNick } : {}),
        messageId: msgId,
        ...(payload.sessionWebhook ? { sessionWebhook: payload.sessionWebhook } : {}),
        ...(payload.sessionWebhookExpiredTime !== undefined
          ? { sessionWebhookExpiredTime: payload.sessionWebhookExpiredTime }
          : {}),
        ...(payload.robotCode ? { robotCode: payload.robotCode } : {}),
      },
      timestamp: (this.options.now ?? Date.now)(),
    });
  }

  private sendAck(messageId: string, data: string): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try {
      this.socket.send(
        JSON.stringify({
          code: 200,
          headers: {
            contentType: 'application/json',
            messageId,
          },
          message: 'OK',
          data,
        }),
      );
    } catch {
      // ignore
    }
  }

  private async openGatewayConnection(): Promise<string> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = (this.options.apiBase ?? DINGTALK_API_BASE).replace(/\/+$/u, '');
    const res = await fetchFn(`${base}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        clientId: this.options.clientId.trim(),
        clientSecret: this.options.clientSecret.trim(),
        subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_BOT_TOPIC }],
        ua: 'halo-im-bot/1.0',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as { readonly endpoint?: string; readonly ticket?: string; readonly message?: string };
    if (!json.endpoint || !json.ticket) {
      throw new Error(json.message || 'Invalid DingTalk gateway response');
    }
    const sep = json.endpoint.includes('?') ? '&' : '?';
    return `${json.endpoint}${sep}ticket=${encodeURIComponent(json.ticket)}`;
  }

  private async postSessionWebhook(sessionWebhook: string, markdown: string): Promise<boolean> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    try {
      const title = markdown.split('\n')[0]?.replace(/^[#*\s`>]+/u, '').slice(0, 40) || 'Halo';
      const res = await fetchFn(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title, text: markdown },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetchAccessToken(forceRefresh = false): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt - now > 120_000) {
      return this.cachedToken.token;
    }
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = (this.options.apiBase ?? DINGTALK_API_BASE).replace(/\/+$/u, '');
    const res = await fetchFn(`${base}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        appKey: this.options.clientId.trim(),
        appSecret: this.options.clientSecret.trim(),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`DingTalk auth HTTP ${res.status}`);
    const json = (await res.json()) as { readonly accessToken?: string; readonly expireIn?: number; readonly message?: string };
    if (!json.accessToken) throw new Error(json.message || 'Missing accessToken');
    const ttlMs = Math.max(60, json.expireIn ?? 7200) * 1000;
    this.cachedToken = { token: json.accessToken, expiresAt: now + ttlMs };
    return json.accessToken;
  }

  private async sendViaOpenApi(chatId: string, markdown: string, ctx?: ImBotReplyContext): Promise<void> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = (this.options.apiBase ?? DINGTALK_API_BASE).replace(/\/+$/u, '');
    const token = await this.fetchAccessToken();
    const robotCode = ctx?.robotCode || this.options.clientId.trim();
    const title = markdown.split('\n')[0]?.replace(/^[#*\s`>]+/u, '').slice(0, 40) || 'Halo';
    const msgParam = JSON.stringify({ title, text: markdown });

    if (ctx?.chatType === 'group') {
      await fetchFn(`${base}/v1.0/robot/groupMessages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          msgParam,
          msgKey: 'sampleMarkdown',
          openConversationId: chatId,
          robotCode,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      return;
    }

    const userId = ctx?.senderId || chatId;
    await fetchFn(`${base}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode,
        userIds: [userId],
        msgKey: 'sampleMarkdown',
        msgParam,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    this.reconnectAttempt += 1;
    const delay = computeReconnectDelay(this.reconnectAttempt - 1, this.options.reconnectBaseMs);
    this.setStatus({
      status: 'reconnecting',
      error: reason,
      ...(this.status.lastConnectedAt ? { lastConnectedAt: this.status.lastConnectedAt } : {}),
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setStatus(next: ImBotAdapterStatus): void {
    this.status = next;
    this.callbacks.onStatusChange(next);
  }
}

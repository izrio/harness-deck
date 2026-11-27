/**
 * 企业微信智能机器人 WebSocket 长连接适配器（`wss://openws.work.weixin.qq.com`）：
 * - 零公网 IP / 免加解密，主动向外建立长连接并通过 `aibot_subscribe` 完成 `Bot ID + Secret` 鉴权
 * - 支持 `ping`/`pong` 心跳保活、指数退避自动重连
 * - 支持 `aibot_msg_callback` 收消息、`aibot_respond_msg` 原生流式输出（`finish: false -> true`）与 `aibot_send_msg` 主动发送
 */
import { randomUUID } from 'node:crypto';
import { createProxyAwareWebSocket } from '../../providers/proxyFetch.ts';
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

export const DEFAULT_WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';
const WECOM_HEARTBEAT_MS = 30_000;
const WECOM_STREAM_THROTTLE_MS = 600;
const WECOM_MAX_CHUNK_CHARS = 3_800;

export interface WeComBotAdapterOptions {
  readonly botId: string;
  readonly secret: string;
  readonly wsUrl?: string;
  readonly createWebSocket?: WebSocketFactory;
  readonly heartbeatMs?: number;
  readonly reconnectBaseMs?: number;
  readonly now?: () => number;
}

interface WeComFrame {
  readonly cmd?: string;
  readonly headers?: { readonly req_id?: string };
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly body?: Record<string, unknown>;
}

function extractWeComText(body: Record<string, unknown>): string {
  const msgtype = typeof body.msgtype === 'string' ? body.msgtype : 'text';
  if (msgtype === 'text') {
    const textObj = body.text as Record<string, unknown> | undefined;
    return typeof textObj?.content === 'string' ? textObj.content : '';
  }
  if (msgtype === 'voice') {
    const voiceObj = body.voice as Record<string, unknown> | undefined;
    return typeof voiceObj?.content === 'string' ? voiceObj.content : '';
  }
  if (msgtype === 'mixed') {
    const mixedObj = body.mixed as Record<string, unknown> | undefined;
    const items = Array.isArray(mixedObj?.msg_item) ? mixedObj.msg_item : [];
    const parts: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (obj.msgtype === 'text') {
        const t = obj.text as Record<string, unknown> | undefined;
        if (typeof t?.content === 'string' && t.content.trim()) parts.push(t.content.trim());
      }
    }
    return parts.join('\n');
  }
  return '';
}

export class WeComBotAdapter implements ImBotAdapter {
  readonly platform = 'wecom' as const;

  private status: ImBotAdapterStatus = { status: 'stopped' };
  private socket: ImBotSocketLike | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private running = false;
  private subscribeReqId: string | undefined;

  constructor(
    private readonly options: WeComBotAdapterOptions,
    private readonly callbacks: ImBotAdapterCallbacks,
  ) {}

  getStatus(): ImBotAdapterStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.options.botId.trim() || !this.options.secret.trim()) {
      this.setStatus({ status: 'error', error: 'Missing WeCom Bot ID or Secret' });
      return;
    }
    this.running = true;
    this.reconnectAttempt = 0;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    const ws = this.socket;
    this.socket = undefined;
    this.subscribeReqId = undefined;
    if (ws) {
      try {
        ws.close(1000, 'Bot stopped');
      } catch {
        // ignore
      }
    }
    this.setStatus({ status: 'stopped' });
  }

  async beginReply(ctx: ImBotReplyContext, initialText?: string): Promise<ImBotStreamHandle> {
    const streamId = `stream_${randomUUID().replace(/-/gu, '').slice(0, 16)}`;
    let lastSentAt = 0;
    let lastContent = '';
    let finished = false;
    const now = this.options.now ?? Date.now;

    const sendStreamFrame = (content: string, finish: boolean): boolean => {
      if (!ctx.reqId) return false;
      const ok = this.sendJson({
        cmd: 'aibot_respond_msg',
        headers: { req_id: ctx.reqId },
        body: {
          ...(ctx.chatId ? { chatid: ctx.chatId } : {}),
          msgtype: 'stream',
          stream: {
            id: streamId,
            finish,
            content,
          },
        },
      });
      if (ok) {
        lastSentAt = now();
        lastContent = content;
      }
      return ok;
    };

    if (initialText?.trim() && ctx.reqId) {
      sendStreamFrame(initialText.trim(), false);
    }

    return {
      update: async (markdown: string) => {
        if (finished || !ctx.reqId) return;
        const trimmed = markdown.trim();
        if (!trimmed || trimmed === lastContent) return;
        if (now() - lastSentAt < WECOM_STREAM_THROTTLE_MS) return;
        const clipped =
          trimmed.length > WECOM_MAX_CHUNK_CHARS
            ? `${trimmed.slice(0, WECOM_MAX_CHUNK_CHARS)}\n\n…`
            : trimmed;
        sendStreamFrame(clipped, false);
      },
      finish: async (markdown: string) => {
        if (finished) return;
        finished = true;
        const chunks = splitMarkdownChunks(markdown || '已完成。', WECOM_MAX_CHUNK_CHARS);
        if (ctx.reqId) {
          const sentFirst = sendStreamFrame(chunks[0]!, true);
          if (sentFirst) {
            for (const extra of chunks.slice(1)) {
              await this.sendMessage(ctx.chatId, extra);
            }
            return;
          }
        }
        for (const chunk of chunks) {
          await this.sendMessage(ctx.chatId, chunk);
        }
      },
    };
  }

  async sendMessage(chatId: string, text: string, ctx?: ImBotReplyContext): Promise<void> {
    const chunks = splitMarkdownChunks(text, WECOM_MAX_CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i += 1) {
      const content = chunks[i]!;
      if (i === 0 && ctx?.reqId) {
        const sent = this.sendJson({
          cmd: 'aibot_respond_msg',
          headers: { req_id: ctx.reqId },
          body: {
            ...(chatId ? { chatid: chatId } : {}),
            msgtype: 'stream',
            stream: {
              id: `msg_${randomUUID().replace(/-/gu, '').slice(0, 12)}`,
              finish: true,
              content,
            },
          },
        });
        if (sent) continue;
      }
      if (!chatId) continue;
      this.sendJson({
        cmd: 'aibot_send_msg',
        headers: { req_id: `send_${randomUUID().replace(/-/gu, '').slice(0, 12)}` },
        body: {
          chatid: chatId,
          msgtype: 'markdown',
          markdown: { content },
        },
      });
    }
  }

  async testConnection(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.options.botId.trim() || !this.options.secret.trim()) {
      return { ok: false, detail: 'Missing Bot ID or Secret' };
    }
    if (this.status.status === 'connected' && this.socket?.readyState === 1) {
      return { ok: true, detail: 'Connected' };
    }
    const url = this.options.wsUrl ?? DEFAULT_WECOM_WS_URL;
    const factory = this.options.createWebSocket ?? createProxyAwareWebSocket();
    return await new Promise((resolve) => {
      let settled = false;
      const done = (res: { readonly ok: boolean; readonly detail?: string }, ws?: ImBotSocketLike) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws?.close(1000, 'Test done');
        } catch {
          // ignore
        }
        resolve(res);
      };
      const ws = factory(url);
      const reqId = `sub_${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
      const timer = setTimeout(() => done({ ok: false, detail: 'Connection timeout' }, ws), 8_000);
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            cmd: 'aibot_subscribe',
            headers: { req_id: reqId },
            body: {
              bot_id: this.options.botId.trim(),
              secret: this.options.secret.trim(),
            },
          }),
        );
      });
      ws.on('message', (raw) => {
        try {
          const frame = JSON.parse(rawDataToBuffer(raw).toString('utf8')) as WeComFrame;
          if (frame.headers?.req_id === reqId || frame.cmd === 'aibot_subscribe' || frame.errcode !== undefined) {
            if ((frame.errcode ?? 0) === 0) {
              done({ ok: true, detail: 'Authenticated' }, ws);
            } else {
              done({ ok: false, detail: frame.errmsg || `errcode ${String(frame.errcode)}` }, ws);
            }
          }
        } catch {
          // ignore non-json
        }
      });
      ws.on('error', (err) => done({ ok: false, detail: err.message }, ws));
      ws.on('close', (code) => done({ ok: false, detail: `Closed (${code})` }, ws));
    });
  }

  private connect(): void {
    if (!this.running) return;
    this.clearTimers();
    this.setStatus({
      status: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      ...(this.status.lastConnectedAt ? { lastConnectedAt: this.status.lastConnectedAt } : {}),
    });

    const url = this.options.wsUrl ?? DEFAULT_WECOM_WS_URL;
    const factory = this.options.createWebSocket ?? createProxyAwareWebSocket();
    let ws: ImBotSocketLike;
    try {
      ws = factory(url);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.handleDisconnect(msg);
      return;
    }
    this.socket = ws;
    let lastError: string | undefined;

    ws.on('open', () => {
      if (this.socket !== ws || !this.running) return;
      lastError = undefined;
      const reqId = `sub_${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
      this.subscribeReqId = reqId;
      this.sendJson({
        cmd: 'aibot_subscribe',
        headers: { req_id: reqId },
        body: {
          bot_id: this.options.botId.trim(),
          secret: this.options.secret.trim(),
        },
      });
    });

    ws.on('message', (raw) => {
      if (this.socket !== ws || !this.running) return;
      let frame: WeComFrame;
      try {
        frame = JSON.parse(rawDataToBuffer(raw).toString('utf8')) as WeComFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    });

    ws.on('error', (err) => {
      if (this.socket !== ws || !this.running) return;
      lastError = err.message || String(err);
      this.callbacks.log(`[IM Bot:wecom] WebSocket error: ${lastError}`);
    });

    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.clearHeartbeat();
      if (!this.running) return;
      const reasonText = reason?.toString('utf8').trim();
      const detail = reasonText ? `WebSocket closed (${reasonText})` : (lastError || `WebSocket closed (code ${code})`);
      this.handleDisconnect(detail);
    });
  }

  private handleFrame(frame: WeComFrame): void {
    const reqId = frame.headers?.req_id;
    // 1. 认证订阅应答
    if (
      this.subscribeReqId &&
      (reqId === this.subscribeReqId || (frame.cmd === 'aibot_subscribe' && frame.errcode !== undefined))
    ) {
      this.subscribeReqId = undefined;
      if ((frame.errcode ?? 0) === 0) {
        this.reconnectAttempt = 0;
        const now = (this.options.now ?? Date.now)();
        this.setStatus({ status: 'connected', lastConnectedAt: now });
        this.startHeartbeat();
        this.callbacks.log('[IM Bot:wecom] Authenticated and connected');
      } else {
        const err = frame.errmsg || `Auth failed (errcode ${String(frame.errcode)})`;
        this.setStatus({ status: 'error', error: err });
        this.callbacks.log(`[IM Bot:wecom] Subscribe rejected: ${err}`);
        try {
          this.socket?.close(4001, 'Auth failed');
        } catch {
          // ignore
        }
      }
      return;
    }

    // 2. 心跳回应
    if (frame.cmd === 'pong' || (frame.cmd === 'ping' && frame.errcode === 0)) {
      return;
    }

    // 3. 入站消息回调
    if (frame.cmd === 'aibot_msg_callback' && frame.body) {
      const body = frame.body;
      const from = body.from as Record<string, unknown> | undefined;
      const senderId =
        (typeof from?.userid === 'string' && from.userid.trim()) ||
        (typeof body.userid === 'string' && body.userid.trim()) ||
        '';
      if (!senderId) return;
      const senderName =
        (typeof from?.name === 'string' && from.name.trim()) ||
        (typeof body.username === 'string' && body.username.trim()) ||
        undefined;
      const rawChatType = typeof body.chattype === 'string' ? body.chattype : '';
      const roomId = typeof body.roomid === 'string' && body.roomid.trim() ? body.roomid.trim() : undefined;
      const chatId =
        (typeof body.chatid === 'string' && body.chatid.trim()) ||
        roomId ||
        senderId;
      const chatType: 'single' | 'group' =
        rawChatType === 'group' || Boolean(roomId) ? 'group' : 'single';
      const rawText = extractWeComText(body);
      const text = chatType === 'group' ? stripLeadingMentions(rawText) : rawText.trim();
      if (!text) return;
      const messageId =
        (typeof body.msgid === 'string' && body.msgid.trim()) ||
        reqId ||
        `wecom_${randomUUID()}`;

      // 企业微信智能机器人仅在单聊或群聊 @机器人 时触发 aibot_msg_callback
      const mentionedBot = chatType === 'group' ? true : false;
      this.callbacks.onMessage({
        platform: 'wecom',
        messageId,
        senderId,
        ...(senderName ? { senderName } : {}),
        chatId,
        chatType,
        mentionedBot,
        text,
        replyContext: {
          platform: 'wecom',
          chatId,
          chatType,
          senderId,
          ...(senderName ? { senderName } : {}),
          ...(reqId ? { reqId } : {}),
          messageId,
        },
        timestamp: (this.options.now ?? Date.now)(),
      });
      return;
    }

    // 4. 进入会话事件 -> 回复简洁欢迎提示
    if (frame.cmd === 'aibot_event_callback' && reqId && frame.body) {
      const event = frame.body.event as Record<string, unknown> | undefined;
      if (event?.eventtype === 'enter_chat') {
        this.sendJson({
          cmd: 'aibot_respond_welcome_msg',
          headers: { req_id: reqId },
          body: {
            msgtype: 'text',
            text: { content: 'Halo 编程助手已就绪。发送 /pair <配对码> 完成授权绑定，或发送 /help 查看指令。' },
          },
        });
      }
    }
  }

  private sendJson(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const intervalMs = this.options.heartbeatMs ?? WECOM_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({
        cmd: 'ping',
        headers: { req_id: `ping_${randomUUID().replace(/-/gu, '').slice(0, 8)}` },
      });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private handleDisconnect(reason: string): void {
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
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
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

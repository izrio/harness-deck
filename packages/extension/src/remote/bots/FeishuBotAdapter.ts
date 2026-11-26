/**
 * 飞书 / Lark 企业自建应用 WebSocket 长连接适配器：
 * - 零公网 IP：调用 `POST /callback/ws/endpoint` 获取动态 `wss://` 接入点与心跳间隔
 * - 原生 PBBP2 Protobuf 二进制帧收发、分片重组、3 秒内即时 ACK 与定期 CONTROL Ping 保活
 * - 使用 `tenant_access_token` 发送交互式 Markdown 卡片并支持 `PATCH` 节流流式更新
 */
import WebSocket from 'ws';
import type { ImBotFeishuDomain } from '@harness-deck/shared';
import {
  decodeFeishuPbFrame,
  encodeFeishuPbFrame,
  FEISHU_FRAME_METHOD_CONTROL,
  FEISHU_FRAME_METHOD_DATA,
  getFeishuHeader,
  type FeishuPbFrame,
} from './feishuProtobuf.ts';
import {
  computeReconnectDelay,
  rawDataToBuffer,
  splitMarkdownChunks,
  type ImBotAdapter,
  type ImBotAdapterCallbacks,
  type ImBotAdapterStatus,
  type ImBotReplyContext,
  type ImBotSocketLike,
  type ImBotStreamHandle,
  type WebSocketFactory,
} from './types.ts';

const FEISHU_STREAM_THROTTLE_MS = 1_100;
const FEISHU_MAX_CHUNK_CHARS = 10_000;
const DEFAULT_PING_INTERVAL_SEC = 120;

export function feishuBaseUrl(domain: ImBotFeishuDomain = 'feishu'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

export interface FeishuBotAdapterOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain?: ImBotFeishuDomain;
  readonly fetchImpl?: typeof fetch;
  readonly createWebSocket?: WebSocketFactory;
  readonly reconnectBaseMs?: number;
  readonly now?: () => number;
}

interface FeishuEndpointResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: {
    readonly URL?: string;
    readonly ClientConfig?: {
      readonly PingInterval?: number;
      readonly ReconnectInterval?: number;
    };
  };
}

interface FeishuEventEnvelope {
  readonly header?: {
    readonly event_id?: string;
    readonly event_type?: string;
  };
  readonly event?: {
    readonly sender?: {
      readonly sender_type?: string;
      readonly sender_id?: {
        readonly open_id?: string;
        readonly user_id?: string;
        readonly union_id?: string;
      };
    };
    readonly message?: {
      readonly message_id?: string;
      readonly chat_id?: string;
      readonly chat_type?: string;
      readonly message_type?: string;
      readonly content?: string;
      readonly mentions?: readonly {
        readonly key?: string;
        readonly name?: string;
      }[];
    };
  };
}

function parseFeishuMessageText(
  messageType: string,
  contentRaw: string,
  mentions?: readonly { readonly key?: string }[],
): string {
  let text = '';
  try {
    const parsed = JSON.parse(contentRaw) as Record<string, unknown>;
    if (messageType === 'text' && typeof parsed.text === 'string') {
      text = parsed.text;
    } else if (messageType === 'post') {
      const lines: string[] = [];
      if (typeof parsed.title === 'string' && parsed.title.trim()) lines.push(parsed.title.trim());
      const content = Array.isArray(parsed.content) ? parsed.content : [];
      for (const row of content) {
        if (!Array.isArray(row)) continue;
        const rowParts: string[] = [];
        for (const node of row) {
          if (!node || typeof node !== 'object') continue;
          const n = node as Record<string, unknown>;
          if (typeof n.text === 'string') rowParts.push(n.text);
        }
        if (rowParts.length > 0) lines.push(rowParts.join(''));
      }
      text = lines.join('\n');
    }
  } catch {
    text = contentRaw;
  }

  if (mentions && mentions.length > 0) {
    for (const m of mentions) {
      if (m.key) {
        text = text.split(m.key).join('');
      }
    }
  }
  return text.replace(/@_user_\d+\s*/gu, '').trim();
}

function buildFeishuMarkdownCard(markdown: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: 'markdown',
        content: markdown,
      },
    ],
  });
}

export class FeishuBotAdapter implements ImBotAdapter {
  readonly platform = 'feishu' as const;

  private status: ImBotAdapterStatus = { status: 'stopped' };
  private socket: ImBotSocketLike | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private running = false;
  private serviceId = 0;
  private seqCounter = 1n;
  private pingIntervalSec = DEFAULT_PING_INTERVAL_SEC;
  private cachedToken: { readonly token: string; readonly expiresAt: number } | undefined;
  private readonly chunkCache = new Map<string, { readonly parts: (Buffer | undefined)[]; readonly updatedAt: number }>();

  constructor(
    private readonly options: FeishuBotAdapterOptions,
    private readonly callbacks: ImBotAdapterCallbacks,
  ) {}

  getStatus(): ImBotAdapterStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.options.appId.trim() || !this.options.appSecret.trim()) {
      this.setStatus({ status: 'error', error: 'Missing Feishu App ID or App Secret' });
      return;
    }
    this.running = true;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.chunkCache.clear();
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

  async beginReply(ctx: ImBotReplyContext, initialText?: string): Promise<ImBotStreamHandle> {
    let replyMsgId: string | undefined;
    let lastSentAt = 0;
    let lastContent = '';
    let finished = false;
    const now = this.options.now ?? Date.now;

    const sendOrPatch = async (markdown: string): Promise<void> => {
      const content = buildFeishuMarkdownCard(markdown);
      if (replyMsgId) {
        const patched = await this.patchCardMessage(replyMsgId, content);
        if (patched) {
          lastSentAt = now();
          lastContent = markdown;
          return;
        }
      }
      const createdId = await this.postCardMessage(ctx.chatId, content, ctx.messageId);
      if (createdId) {
        replyMsgId = createdId;
        lastSentAt = now();
        lastContent = markdown;
      }
    };

    if (initialText?.trim()) {
      await sendOrPatch(initialText.trim());
    }

    return {
      update: async (markdown: string) => {
        if (finished) return;
        const trimmed = markdown.trim();
        if (!trimmed || trimmed === lastContent) return;
        if (now() - lastSentAt < FEISHU_STREAM_THROTTLE_MS) return;
        const clipped =
          trimmed.length > FEISHU_MAX_CHUNK_CHARS
            ? `${trimmed.slice(0, FEISHU_MAX_CHUNK_CHARS)}\n\n…`
            : trimmed;
        await sendOrPatch(clipped);
      },
      finish: async (markdown: string) => {
        if (finished) return;
        finished = true;
        const chunks = splitMarkdownChunks(markdown || '已完成。', FEISHU_MAX_CHUNK_CHARS);
        await sendOrPatch(chunks[0]!);
        for (const extra of chunks.slice(1)) {
          await this.postCardMessage(ctx.chatId, buildFeishuMarkdownCard(extra));
        }
      },
    };
  }

  async sendMessage(chatId: string, text: string, ctx?: ImBotReplyContext): Promise<void> {
    const chunks = splitMarkdownChunks(text, FEISHU_MAX_CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i += 1) {
      await this.postCardMessage(
        chatId,
        buildFeishuMarkdownCard(chunks[i]!),
        i === 0 ? ctx?.messageId : undefined,
      );
    }
  }

  async testConnection(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.options.appId.trim() || !this.options.appSecret.trim()) {
      return { ok: false, detail: 'Missing App ID or App Secret' };
    }
    try {
      const token = await this.fetchTenantAccessToken(true);
      return token ? { ok: true, detail: 'Authenticated' } : { ok: false, detail: 'Failed to obtain token' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.clearTimers();
    this.setStatus({
      status: this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      ...(this.status.lastConnectedAt ? { lastConnectedAt: this.status.lastConnectedAt } : {}),
    });

    let wsUrl: string;
    try {
      const endpoint = await this.fetchWsEndpoint();
      wsUrl = endpoint.url;
      this.pingIntervalSec = endpoint.pingIntervalSec;
      const parsed = new URL(wsUrl);
      this.serviceId = Number(parsed.searchParams.get('service_id') ?? '0') || 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.callbacks.log(`[IM Bot:feishu] Endpoint bootstrap failed: ${msg}`);
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
      this.sendPingFrame();
      this.startHeartbeat();
      this.callbacks.log('[IM Bot:feishu] WebSocket long connection established');
    });

    ws.on('message', (raw) => {
      if (this.socket !== ws || !this.running) return;
      const buf = rawDataToBuffer(raw);
      let frame: FeishuPbFrame;
      try {
        frame = decodeFeishuPbFrame(buf);
      } catch (error) {
        this.callbacks.log(`[IM Bot:feishu] Failed to decode PBBP2 frame: ${String(error)}`);
        return;
      }
      this.handlePbFrame(frame);
    });

    ws.on('error', (err) => {
      if (this.socket !== ws || !this.running) return;
      this.callbacks.log(`[IM Bot:feishu] WebSocket error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.clearHeartbeat();
      if (!this.running) return;
      const text = reason?.toString('utf8') || `code ${code}`;
      this.scheduleReconnect(`WebSocket closed (${text})`);
    });
  }

  private handlePbFrame(frame: FeishuPbFrame): void {
    const typeHeader = getFeishuHeader(frame.headers, 'type');

    if (frame.method === FEISHU_FRAME_METHOD_CONTROL) {
      if (typeHeader === 'pong' && frame.payload && frame.payload.length > 0) {
        try {
          const cfg = JSON.parse(frame.payload.toString('utf8')) as { readonly PingInterval?: number };
          if (typeof cfg.PingInterval === 'number' && cfg.PingInterval >= 10 && cfg.PingInterval !== this.pingIntervalSec) {
            this.pingIntervalSec = cfg.PingInterval;
            this.startHeartbeat();
          }
        } catch {
          // ignore
        }
      }
      return;
    }

    if (frame.method !== FEISHU_FRAME_METHOD_DATA) return;

    // 必须尽快 ACK（官方要求 3 秒内返回），避免飞书网关重试投递
    this.sendAckFrame(frame);

    const payload = this.reassemblePayload(frame);
    if (!payload || payload.length === 0) return;

    if (typeHeader && typeHeader !== 'event') return;

    let envelope: FeishuEventEnvelope;
    try {
      envelope = JSON.parse(payload.toString('utf8')) as FeishuEventEnvelope;
    } catch {
      return;
    }

    if (envelope.header?.event_type !== 'im.message.receive_v1') return;
    const msg = envelope.event?.message;
    const sender = envelope.event?.sender;
    if (!msg || !sender) return;
    // 忽略机器人自身发出的消息
    if (sender.sender_type === 'app' || sender.sender_type === 'bot') return;

    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || '';
    const chatId = msg.chat_id ?? '';
    const messageId = msg.message_id ?? envelope.header?.event_id ?? '';
    if (!senderId || !chatId || !messageId) return;

    const chatType: 'single' | 'group' = msg.chat_type === 'p2p' ? 'single' : 'group';
    const mentionedBot = Boolean(msg.mentions && msg.mentions.length > 0);
    const text = parseFeishuMessageText(msg.message_type ?? 'text', msg.content ?? '', msg.mentions);
    if (!text) return;

    this.callbacks.onMessage({
      platform: 'feishu',
      messageId,
      senderId,
      chatId,
      chatType,
      mentionedBot,
      text,
      replyContext: {
        platform: 'feishu',
        chatId,
        chatType,
        senderId,
        messageId,
      },
      timestamp: (this.options.now ?? Date.now)(),
    });
  }

  private reassemblePayload(frame: FeishuPbFrame): Buffer | undefined {
    const sum = Number(getFeishuHeader(frame.headers, 'sum') ?? '1') || 1;
    const seq = Number(getFeishuHeader(frame.headers, 'seq') ?? '0') || 0;
    const msgId = getFeishuHeader(frame.headers, 'message_id');
    const chunk = frame.payload ?? Buffer.alloc(0);

    if (sum <= 1 || !msgId) return chunk;

    const now = (this.options.now ?? Date.now)();
    // 清理 15 秒前未拼完的分片
    for (const [k, entry] of this.chunkCache.entries()) {
      if (now - entry.updatedAt > 15_000) this.chunkCache.delete(k);
    }

    let entry = this.chunkCache.get(msgId);
    if (!entry || entry.parts.length !== sum) {
      entry = { parts: Array<Buffer | undefined>(sum).fill(undefined), updatedAt: now };
      this.chunkCache.set(msgId, entry);
    }
    entry.parts[seq] = chunk;
    if (entry.parts.every((p) => p !== undefined)) {
      this.chunkCache.delete(msgId);
      return Buffer.concat(entry.parts as Buffer[]);
    }
    return undefined;
  }

  private sendAckFrame(incoming: FeishuPbFrame): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    const ackPayload = Buffer.from(JSON.stringify({ code: 200 }), 'utf8');
    const ack = encodeFeishuPbFrame({
      ...incoming,
      headers: [...incoming.headers, { key: 'biz_rt', value: '1' }],
      payload: ackPayload,
    });
    try {
      this.socket.send(ack);
    } catch {
      // ignore
    }
  }

  private sendPingFrame(): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    const frame = encodeFeishuPbFrame({
      seqId: this.seqCounter++,
      logId: 0n,
      service: this.serviceId,
      method: FEISHU_FRAME_METHOD_CONTROL,
      headers: [{ key: 'type', value: 'ping' }],
    });
    try {
      this.socket.send(frame);
    } catch {
      // ignore
    }
  }

  private async fetchWsEndpoint(): Promise<{ readonly url: string; readonly pingIntervalSec: number }> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = feishuBaseUrl(this.options.domain);
    const res = await fetchFn(`${base}/callback/ws/endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        locale: 'zh',
      },
      body: JSON.stringify({
        AppID: this.options.appId.trim(),
        AppSecret: this.options.appSecret.trim(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as FeishuEndpointResponse;
    if ((json.code ?? 0) !== 0 || !json.data?.URL) {
      throw new Error(json.msg || `code ${String(json.code)}`);
    }
    const ping = json.data.ClientConfig?.PingInterval;
    return {
      url: json.data.URL,
      pingIntervalSec: typeof ping === 'number' && ping >= 10 ? ping : DEFAULT_PING_INTERVAL_SEC,
    };
  }

  private async fetchTenantAccessToken(forceRefresh = false): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt - now > 120_000) {
      return this.cachedToken.token;
    }
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = feishuBaseUrl(this.options.domain);
    const res = await fetchFn(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.options.appId.trim(),
        app_secret: this.options.appSecret.trim(),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Feishu auth HTTP ${res.status}`);
    const json = (await res.json()) as {
      readonly code?: number;
      readonly msg?: string;
      readonly tenant_access_token?: string;
      readonly expire?: number;
    };
    if ((json.code ?? 0) !== 0 || !json.tenant_access_token) {
      throw new Error(json.msg || `Feishu auth error ${String(json.code)}`);
    }
    const ttlMs = Math.max(60, json.expire ?? 7200) * 1000;
    this.cachedToken = { token: json.tenant_access_token, expiresAt: now + ttlMs };
    return json.tenant_access_token;
  }

  private async postCardMessage(
    chatId: string,
    cardContent: string,
    replyToMessageId?: string,
  ): Promise<string | undefined> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = feishuBaseUrl(this.options.domain);
    const token = await this.fetchTenantAccessToken();

    const url = replyToMessageId
      ? `${base}/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
      : `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const body = replyToMessageId
      ? { msg_type: 'interactive', content: cardContent }
      : { receive_id: chatId, msg_type: 'interactive', content: cardContent };

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.callbacks.log(`[IM Bot:feishu] Send message failed: HTTP ${res.status}`);
      return undefined;
    }
    const json = (await res.json()) as { readonly code?: number; readonly data?: { readonly message_id?: string } };
    if ((json.code ?? 0) !== 0) {
      this.callbacks.log(`[IM Bot:feishu] Send message error code=${String(json.code)}`);
      return undefined;
    }
    return json.data?.message_id;
  }

  private async patchCardMessage(messageId: string, cardContent: string): Promise<boolean> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    const base = feishuBaseUrl(this.options.domain);
    try {
      const token = await this.fetchTenantAccessToken();
      const res = await fetchFn(`${base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: cardContent }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { readonly code?: number };
      return (json.code ?? 0) === 0;
    } catch {
      return false;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendPingFrame();
    }, this.pingIntervalSec * 1000);
    this.heartbeatTimer.unref?.();
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

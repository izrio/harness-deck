/**
 * IM 双向聊天机器人公共协议与工具类型（零 vscode 耦合，VS Code 与 JetBrains Sidecar 共用）。
 */
import type { ImBotConnectionStatus, ImBotFeishuDomain, ImBotPlatform } from '@harness-deck/shared';
import type WebSocket from 'ws';

export const IM_BOT_PLATFORMS: readonly ImBotPlatform[] = ['wecom', 'feishu', 'dingtalk', 'telegram'];

export interface ImBotReplyContext {
  readonly platform: ImBotPlatform;
  readonly chatId: string;
  readonly chatType: 'single' | 'group';
  readonly senderId: string;
  readonly senderName?: string;
  /** 企业微信回调请求 ID（用于 `aibot_respond_msg` 绑定当前对话）。 */
  readonly reqId?: string;
  /** 飞书 / Telegram 原消息 ID（用于直接回复该条消息）。 */
  readonly messageId?: string;
  /** 钉钉 Stream 回调下发的临时会话 Webhook。 */
  readonly sessionWebhook?: string;
  /** 钉钉 `sessionWebhook` 过期时间戳（epoch ms）。 */
  readonly sessionWebhookExpiredTime?: number;
  /** 钉钉机器人编码（OpenAPI 主动发送兜底）。 */
  readonly robotCode?: string;
}

export interface ImBotInboundMessage {
  readonly platform: ImBotPlatform;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly chatId: string;
  readonly chatType: 'single' | 'group';
  readonly mentionedBot: boolean;
  readonly text: string;
  readonly replyContext: ImBotReplyContext;
  readonly timestamp: number;
}

export interface ImBotStreamHandle {
  /** 流式增量更新（传入当前累计完整 Markdown；底层按平台能力节流更新或忽略）。 */
  update(markdown: string): Promise<void>;
  /** 结束本次回复并输出最终完整内容（超长内容自动分段发送）。 */
  finish(markdown: string): Promise<void>;
}

export interface ImBotAdapterStatus {
  readonly status: ImBotConnectionStatus;
  readonly error?: string;
  readonly lastConnectedAt?: number;
  readonly botName?: string;
}

export interface ImBotAdapter {
  readonly platform: ImBotPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ImBotAdapterStatus;
  beginReply(ctx: ImBotReplyContext, initialText?: string): Promise<ImBotStreamHandle>;
  sendMessage(chatId: string, text: string, ctx?: ImBotReplyContext): Promise<void>;
  testConnection(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
}

export interface ImBotAdapterCallbacks {
  readonly onMessage: (message: ImBotInboundMessage) => void;
  readonly onStatusChange: (status: ImBotAdapterStatus) => void;
  readonly log: (line: string) => void;
}

/** 供单测注入的最小 WebSocket 抽象（兼容 `ws` 实例）。 */
export interface ImBotSocketLike {
  readonly readyState: number;
  send(data: string | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type WebSocketFactory = (url: string, headers?: Record<string, string>) => ImBotSocketLike;

export interface ImBotChannelCredentials {
  readonly platform: ImBotPlatform;
  readonly appId?: string;
  readonly secret?: string;
  readonly domain?: ImBotFeishuDomain;
  readonly apiBase?: string;
}

/** 将过长 Markdown 按段落/换行边界安全切分，避免触发各 IM 平台单条消息长度限制。 */
export function splitMarkdownChunks(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [''];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.4)) {
      splitAt = remaining.lastIndexOf('\n', maxChars);
    }
    if (splitAt < Math.floor(maxChars * 0.4)) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

/** 规范化并清理群聊消息前导 `@机器人` 提及文本。 */
export function stripLeadingMentions(text: string): string {
  return text
    .replace(/^(?:@\S+\s+)+/u, '')
    .replace(/^\s+/u, '')
    .trim();
}

/** 计算指数退避重连延迟（ms），带上限保护。 */
export function computeReconnectDelay(attempt: number, baseMs = 1_500, maxMs = 30_000): number {
  const exp = Math.min(attempt, 6);
  return Math.min(maxMs, baseMs * 2 ** exp);
}

/** 将 `ws.RawData` 统一转为 `Buffer`。 */
export function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data), 'utf8');
}

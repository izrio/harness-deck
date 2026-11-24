/**
 * 轻量级 Chrome DevTools Protocol (CDP) WebSocket 客户端（零 Playwright 依赖，复用 extension 内置 `ws`）：
 * - 负责 JSON-RPC 请求/响应关联、超时清理与事件订阅；
 * - 支持在单测中注入自定义 WebSocket 工厂，无需真实浏览器即可完整验证协议逻辑。
 */
import WebSocket from 'ws';

export interface CdpSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
}

export type CdpSocketFactory = (wsUrl: string) => CdpSocketLike;

interface PendingCall {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(private readonly socket: CdpSocketLike) {
    socket.on('message', (raw) => {
      this.handleMessage(raw);
    });
    socket.on('close', () => {
      this.handleClose('CDP connection closed');
    });
    socket.on('error', (error) => {
      this.handleClose(`CDP socket error: ${error.message}`);
    });
  }

  static connect(
    wsUrl: string,
    options?: {
      readonly timeoutMs?: number;
      readonly socketFactory?: CdpSocketFactory;
    },
  ): Promise<CdpClient> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const factory = options?.socketFactory ?? ((url: string) => new WebSocket(url));

    return new Promise<CdpClient>((resolve, reject) => {
      const socket = factory(wsUrl);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to CDP: ${wsUrl}`));
      }, timeoutMs);

      socket.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });

      socket.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      socket.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP socket closed before opening: ${wsUrl}`));
      });
    });
  }

  get connected(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.connected) {
      return Promise.reject(new Error(`CDP not connected (method: ${method})`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify(params ? { id, method, params } : { id, method });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out (${method})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.socket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    let set = this.eventListeners.get(method);
    if (!set) {
      set = new Set();
      this.eventListeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.eventListeners.delete(method);
      }
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.handleClose('CDP client closed');
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const call = this.pending.get(parsed.id);
      if (!call) return;
      this.pending.delete(parsed.id);
      clearTimeout(call.timer);
      const err = parsed.error as { message?: string; code?: number } | undefined;
      if (err) {
        call.reject(new Error(err.message ? `CDP error (${err.code ?? -1}): ${err.message}` : 'Unknown CDP error'));
      } else {
        call.resolve((parsed.result as Record<string, unknown> | undefined) ?? {});
      }
      return;
    }

    if (typeof parsed.method === 'string') {
      const listeners = this.eventListeners.get(parsed.method);
      if (!listeners || listeners.size === 0) return;
      const params = (parsed.params as Record<string, unknown> | undefined) ?? {};
      for (const listener of listeners) {
        try {
          listener(params);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
    this.closeListeners.clear();
  }
}

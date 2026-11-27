/**
 * 云端 Halo 无头宿主代理客户端：
 * - 运行在本地 Node 宿主进程（VS Code Extension Host / JetBrains Sidecar / Desktop 内嵌宿主），
 *   彻底绕开 Webview 的严格 CSP（`default-src 'none'`），让三端一致直连云端环境
 * - 支持 `/api/pair` 换取 `hd_device_session` Cookie、WSS `/ws` 长连、心跳保活与指数退避重连
 */
import { WebSocket } from 'ws';
import type {
  CloudEnvironmentStatus,
  HostToWebview,
  RemoteScope,
  WebviewToHost,
} from '@harness-deck/shared';
import { REMOTE_COOKIE_NAME } from './DeviceAuthStore.ts';
import type { FetchLike } from '../providers/proxyFetch.ts';

const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export interface PairCloudHostResult {
  readonly ok: true;
  readonly cookieValue: string;
  readonly device: { readonly id: string; readonly name: string; readonly scope: RemoteScope };
}

export interface PairCloudHostError {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

/** 从 HTTP `Set-Cookie` 响应头中提取 `hd_device_session` 的值。 */
export function extractDeviceSessionCookie(headers: Headers): string | undefined {
  const rawList: string[] = [];
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    rawList.push(...getSetCookie.call(headers));
  } else {
    const single = headers.get('set-cookie');
    if (single) rawList.push(single);
  }

  const prefix = `${REMOTE_COOKIE_NAME}=`;
  for (const header of rawList) {
    for (const segment of header.split(/,(?=[^;]+=)/u)) {
      const firstPart = segment.split(';')[0]?.trim() ?? '';
      if (!firstPart.startsWith(prefix)) continue;
      const rawVal = firstPart.slice(prefix.length).trim();
      if (!rawVal) continue;
      try {
        return decodeURIComponent(rawVal);
      } catch {
        return rawVal;
      }
    }
  }
  return undefined;
}

/** 向远端 Halo Server 发起一次性配对码核验，换取长期设备会话 Cookie。 */
export async function pairWithCloudHost(options: {
  readonly endpointUrl: string;
  readonly code: string;
  readonly deviceName: string;
  readonly fetchImpl?: FetchLike;
}): Promise<PairCloudHostResult | PairCloudHostError> {
  const fetchFn = options.fetchImpl ?? fetch;
  const base = options.endpointUrl.replace(/\/+$/u, '');
  const pairUrl = `${base}/api/pair`;
  try {
    const res = await fetchFn(pairUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        code: options.code.trim(),
        deviceName: options.deviceName.trim() || 'Halo IDE',
      }),
    });

    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore non-json error body
    }

    if (!res.ok || body.ok !== true) {
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const error =
        typeof body.error === 'string'
          ? body.error
          : reason
            ? `Pairing failed (${reason})`
            : `HTTP ${res.status}`;
      return { ok: false, error, ...(reason ? { reason } : {}) };
    }

    const cookieValue = extractDeviceSessionCookie(res.headers);
    if (!cookieValue) {
      return { ok: false, error: 'Missing session cookie in pairing response' };
    }

    const dev = (body.device ?? {}) as Record<string, unknown>;
    const scope: RemoteScope =
      dev.scope === 'owner' ? 'owner' : dev.scope === 'read-only' ? 'read-only' : 'operate';
    return {
      ok: true,
      cookieValue,
      device: {
        id: typeof dev.id === 'string' ? dev.id : 'cloud',
        name: typeof dev.name === 'string' ? dev.name : options.deviceName,
        scope,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildCloudWsUrl(endpointUrl: string): string {
  const parsed = new URL(endpointUrl);
  const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${parsed.host}/ws`;
}

export interface CloudHostConnectionOptions {
  readonly envId: string;
  readonly endpointUrl: string;
  readonly cookieValue: string;
  readonly createWebSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
  readonly onMessage: (message: HostToWebview) => void;
  readonly onStatusChange: (status: CloudEnvironmentStatus, error?: string) => void;
  readonly log?: (line: string) => void;
}

export class CloudHostConnection {
  private ws: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private disposed = false;
  private status: CloudEnvironmentStatus = 'connecting';
  private lastError: string | undefined;

  constructor(private readonly options: CloudHostConnectionOptions) {}

  get envId(): string {
    return this.options.envId;
  }

  get currentStatus(): CloudEnvironmentStatus {
    return this.status;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  start(): void {
    if (this.disposed) return;
    this.reconnectAttempt = 0;
    this.openSocket('connecting');
  }

  send(message: WebviewToHost): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    const socket = this.ws;
    this.ws = undefined;
    if (socket) {
      try {
        socket.removeAllListeners();
        // 挂兜底 error 监听，避免 CONNECTING 态关闭时抛出未捕获 'error' 事件崩溃宿主进程
        socket.on('error', () => undefined);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, 'Client disconnected');
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      } catch {
        // ignore
      }
    }
  }

  private setStatus(next: CloudEnvironmentStatus, error?: string): void {
    this.status = next;
    this.lastError = error;
    this.options.onStatusChange(next, error);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private openSocket(initialStatus: 'connecting' | 'reconnecting'): void {
    if (this.disposed) return;
    this.clearTimers();
    this.setStatus(initialStatus);

    const base = this.options.endpointUrl.replace(/\/+$/u, '');
    const wsUrl = buildCloudWsUrl(base);
    const headers: Record<string, string> = {
      Cookie: `${REMOTE_COOKIE_NAME}=${encodeURIComponent(this.options.cookieValue)}`,
      Origin: base,
    };
    const socket = this.options.createWebSocket
      ? this.options.createWebSocket(wsUrl, headers)
      : new WebSocket(wsUrl, {
          headers,
          handshakeTimeout: 12_000,
        });
    this.ws = socket;

    let fatalAuthError: string | undefined;

    socket.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      if (code === 401 || code === 403) {
        fatalAuthError = code === 401 ? 'Unauthorized (device revoked or expired)' : 'Forbidden (host/origin rejected)';
      } else {
        fatalAuthError = undefined;
      }
      res.resume();
    });

    socket.on('open', () => {
      if (this.disposed || this.ws !== socket) return;
      this.reconnectAttempt = 0;
      this.setStatus('connected');
      this.options.log?.(`云端环境已连接：${base}`);

      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
          } catch {
            // ignore
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();

      // 建连后立刻请求远端完整快照
      this.send({ type: 'ready', payload: {} });
    });

    socket.on('message', (raw) => {
      if (this.disposed || this.ws !== socket) return;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return;
        const msg = parsed as { type?: unknown };
        if (msg.type === 'pong') return;
        this.options.onMessage(parsed as HostToWebview);
      } catch {
        // 忽略格式异常消息
      }
    });

    socket.on('error', (err) => {
      if (this.disposed || this.ws !== socket) return;
      const msg = err.message || '';
      if (!fatalAuthError) {
        if (/\b401\b/u.test(msg)) {
          fatalAuthError = 'Unauthorized (device revoked or expired)';
        } else if (/\b403\b/u.test(msg)) {
          fatalAuthError = 'Forbidden (host/origin rejected)';
        }
      }
      this.options.log?.(`云端环境连接异常（${base}）：${msg}`);
    });

    socket.on('close', (code, reasonBuf) => {
      if (this.disposed || this.ws !== socket) return;
      this.clearTimers();
      this.ws = undefined;

      const reasonText = reasonBuf ? reasonBuf.toString('utf8') : '';
      if (code === 4001 || fatalAuthError) {
        this.setStatus('error', fatalAuthError ?? (reasonText || 'Device revoked'));
        return;
      }

      const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
      this.reconnectAttempt += 1;
      this.setStatus('reconnecting', reasonText || undefined);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.openSocket('reconnecting');
      }, delay);
      this.reconnectTimer.unref?.();
    });
  }
}

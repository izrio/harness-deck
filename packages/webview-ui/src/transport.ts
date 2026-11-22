/**
 * 移动端 WebSocket 传输与连接监督器（HD-22 / HD-23 / HD-26 / HD-27）：
 * - 单一重试 owner + 指数抖动退避（1s–30s）+ 15s 心跳探测
 * - 页面切回前台（visibilitychange）与恢复联网（online）立即探测重连
 * - 从 URL `#code=` 提取一次性配对码并立即清理地址栏，换取 HttpOnly 会话 Cookie
 */
import type { HostToWebview, RemoteRouteKind, RemoteScope, WebviewToHost } from '@harness-deck/shared';

export type TransportStatus =
  | 'ide'
  | 'checking'
  | 'unauthenticated'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline';

export interface MobileDeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly scope: RemoteScope;
}

export interface RemoteRouteEntry {
  readonly kind: RemoteRouteKind;
  readonly url: string;
}

export interface TransportState {
  readonly mode: 'ide' | 'mobile-web';
  readonly status: TransportStatus;
  readonly device?: MobileDeviceInfo;
  readonly vapidPublicKey?: string;
  readonly routes: readonly RemoteRouteEntry[];
  readonly suggestedRoute?: RemoteRouteEntry;
  readonly pendingPairCode?: string;
  readonly error?: string;
  readonly reconnectAttempt: number;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export const WS_HEARTBEAT_MS = 15_000;
export const WS_PONG_TIMEOUT_MS = 30_000;
export const WS_BASE_BACKOFF_MS = 1_000;
export const WS_MAX_BACKOFF_MS = 30_000;
export const WS_REVOKED_CODE = 4001;

const ROUTES_STORAGE_KEY = 'harness-deck:remote-routes';
const WS_OPEN_STATE = 1;

export function computeReconnectDelayMs(attempt: number, randomValue: number = Math.random()): number {
  const clamped = Math.max(0, Math.min(attempt, 6));
  const base = Math.min(WS_MAX_BACKOFF_MS, WS_BASE_BACKOFF_MS * 2 ** clamped);
  const jitter = 0.8 + Math.max(0, Math.min(1, randomValue)) * 0.4;
  return Math.round(base * jitter);
}

export function extractPairCodeFromHash(hash: string): string | undefined {
  const clean = hash.replace(/^#/u, '');
  if (!clean) return undefined;
  const params = new URLSearchParams(clean);
  const code = params.get('code')?.trim();
  return code || undefined;
}

export function detectDefaultDeviceName(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPhone/iu.test(userAgent)) return 'iPhone Safari';
  if (/iPad/iu.test(userAgent)) return 'iPad Safari';
  if (/Android/iu.test(userAgent)) return /Chrome/iu.test(userAgent) ? 'Android Chrome' : 'Android Browser';
  if (/Mac/iu.test(userAgent)) return 'Mac Browser';
  if (/Windows/iu.test(userAgent)) return 'Windows Browser';
  return 'Mobile Browser';
}

export function isIdeWebviewEnvironment(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function';
}

export interface ConnectionSupervisorDeps {
  readonly wsUrl: () => string;
  readonly createSocket: (url: string) => SocketLike;
  readonly onHostMessage: (message: HostToWebview) => void;
  readonly onStatusChange?: (status: TransportStatus, attempt: number) => void;
  readonly onRevoked?: () => void;
  readonly isOnline?: () => boolean;
  readonly isVisible?: () => boolean;
  readonly random?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class ConnectionSupervisor {
  private socket: SocketLike | undefined;
  private reconnectTimer: unknown;
  private heartbeatTimer: unknown;
  private pongTimeoutTimer: unknown;
  private status: TransportStatus = 'offline';
  private attempt = 0;
  private disposed = false;
  private started = false;

  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly random: () => number;

  constructor(private readonly deps: ConnectionSupervisorDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = deps.random ?? (() => Math.random());
  }

  getStatus(): TransportStatus {
    return this.status;
  }

  getAttempt(): number {
    return this.attempt;
  }

  start(): void {
    if (this.disposed) return;
    this.started = true;
    this.connect();
  }

  stop(nextStatus: TransportStatus = 'offline'): void {
    this.started = false;
    this.clearTimers();
    const sock = this.socket;
    this.socket = undefined;
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onclose = null;
      sock.onerror = null;
      try {
        sock.close(1000, 'Client disconnected');
      } catch {
        // ignore close error
      }
    }
    this.attempt = 0;
    this.setStatus(nextStatus);
  }

  dispose(): void {
    this.disposed = true;
    this.stop('offline');
  }

  reconnectNow(): void {
    if (this.disposed || !this.started) return;
    if (this.socket && this.socket.readyState === WS_OPEN_STATE) return;
    this.clearReconnectTimer();
    this.attempt = 0;
    this.connect();
  }

  notifyVisibility(visible: boolean): void {
    if (this.disposed || !this.started) return;
    if (this.socket && this.socket.readyState === WS_OPEN_STATE) {
      this.sendRaw({ type: 'visibility', payload: { visible } });
      if (visible) {
        this.sendPing();
      }
      return;
    }
    if (visible) {
      this.reconnectNow();
    }
  }

  notifyOnline(): void {
    if (this.disposed || !this.started) return;
    this.reconnectNow();
  }

  sendMessage(message: WebviewToHost): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN_STATE) return false;
    this.sendRaw(message);
    return true;
  }

  private setStatus(next: TransportStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.deps.onStatusChange?.(next, this.attempt);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer !== undefined) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pongTimeoutTimer !== undefined) {
      this.clearTimer(this.pongTimeoutTimer);
      this.pongTimeoutTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
  }

  private connect(): void {
    if (this.disposed || !this.started) return;
    this.clearTimers();

    if (this.deps.isOnline && !this.deps.isOnline()) {
      this.setStatus('offline');
      return;
    }

    if (this.socket) {
      const stale = this.socket;
      this.socket = undefined;
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      try {
        stale.close(1000, 'Reconnecting');
      } catch {
        // ignore
      }
    }

    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    let sock: SocketLike;
    try {
      sock = this.deps.createSocket(this.deps.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;

    sock.onopen = () => {
      if (this.socket !== sock || this.disposed) return;
      this.attempt = 0;
      this.setStatus('connected');
      this.startHeartbeat();
      const visible = this.deps.isVisible ? this.deps.isVisible() : true;
      this.sendRaw({ type: 'visibility', payload: { visible } });
      this.sendRaw({ type: 'ready', payload: {} });
    };

    sock.onmessage = (event) => {
      if (this.socket !== sock || this.disposed) return;
      this.resetPongTimeout();
      let parsed: unknown;
      try {
        parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if ((parsed as { type?: unknown }).type === 'pong') return;
      this.deps.onHostMessage(parsed as HostToWebview);
    };

    sock.onerror = () => {
      // onclose handles retry transition
    };

    sock.onclose = (event) => {
      if (this.socket !== sock) return;
      this.socket = undefined;
      this.clearHeartbeatTimers();
      if (this.disposed || !this.started) {
        this.setStatus('offline');
        return;
      }
      if (event?.code === WS_REVOKED_CODE) {
        this.started = false;
        this.attempt = 0;
        this.setStatus('unauthenticated');
        this.deps.onRevoked?.();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = undefined;
      if (!this.socket || this.socket.readyState !== WS_OPEN_STATE || this.disposed) return;
      this.sendPing();
      this.startHeartbeat();
    }, WS_HEARTBEAT_MS);
  }

  private sendPing(): void {
    this.sendRaw({ type: 'ping' });
    if (this.pongTimeoutTimer === undefined) {
      this.pongTimeoutTimer = this.setTimer(() => {
        this.pongTimeoutTimer = undefined;
        if (this.socket) {
          try {
            this.socket.close(4002, 'Heartbeat timeout');
          } catch {
            // ignore
          }
        }
      }, WS_PONG_TIMEOUT_MS);
    }
  }

  private resetPongTimeout(): void {
    if (this.pongTimeoutTimer !== undefined) {
      this.clearTimer(this.pongTimeoutTimer);
      this.pongTimeoutTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.started) return;
    if (this.deps.isOnline && !this.deps.isOnline()) {
      this.setStatus('offline');
      return;
    }
    this.setStatus('reconnecting');
    const delay = computeReconnectDelayMs(this.attempt, this.random());
    this.attempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private sendRaw(data: unknown): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN_STATE) return;
    try {
      this.socket.send(JSON.stringify(data));
    } catch {
      // ignore send errors; close event triggers retry
    }
  }
}

export function saveKnownRoutes(routes: readonly RemoteRouteEntry[]): void {
  try {
    window.localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(routes));
  } catch {
    // ignore storage quota errors
  }
}

export function loadKnownRoutes(): readonly RemoteRouteEntry[] {
  try {
    const raw = window.localStorage.getItem(ROUTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RemoteRouteEntry =>
        Boolean(item) &&
        typeof item === 'object' &&
        ((item as RemoteRouteEntry).kind === 'lan' ||
          (item as RemoteRouteEntry).kind === 'tailscale' ||
          (item as RemoteRouteEntry).kind === 'tunnel') &&
        typeof (item as RemoteRouteEntry).url === 'string',
    );
  } catch {
    return [];
  }
}

const ROUTE_PRIORITY: Readonly<Record<RemoteRouteKind, number>> = {
  lan: 0,
  tailscale: 1,
  tunnel: 2,
};

/** 按 LAN -> Tailscale -> 自定义隧道 顺序探测除当前入口外首个可达的备用路由（HD-26）。 */
export async function probeFallbackRoute(
  routes: readonly RemoteRouteEntry[],
  currentOrigin: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RemoteRouteEntry | undefined> {
  const normalizedCurrent = currentOrigin.replace(/\/+$/u, '').toLowerCase();
  const candidates = [...routes]
    .filter((r) => r.url.replace(/\/+$/u, '').toLowerCase() !== normalizedCurrent)
    .sort((a, b) => ROUTE_PRIORITY[a.kind] - ROUTE_PRIORITY[b.kind]);

  for (const route of candidates) {
    try {
      const target = `${route.url.replace(/\/+$/u, '')}/api/health`;
      const res = await fetchImpl(target, {
        method: 'GET',
        cache: 'no-store',
        mode: 'cors',
      });
      if (res.ok) return route;
    } catch {
      // 当前候选不可达，继续尝试下一路由
    }
  }
  return undefined;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/gu, '+').replace(/_/gu, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

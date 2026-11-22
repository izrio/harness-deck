/**
 * 宿主传输抽象（HD-22）：
 * - IDE 模式（VS Code / JetBrains JCEF）：走 `acquireVsCodeApi()` 与 `window.addEventListener('message')`
 * - 手机浏览器 / PWA 模式：走 `WebSocketTransport` + `ConnectionSupervisor` + `localStorage`
 */
import { useSyncExternalStore } from 'react';
import type { BackendView, HostToWebview, WebviewToHost, WorkbenchModule } from '@harness-deck/shared';
import {
  ConnectionSupervisor,
  extractPairCodeFromHash,
  isIdeWebviewEnvironment,
  loadKnownRoutes,
  probeFallbackRoute,
  saveKnownRoutes,
  urlBase64ToUint8Array,
  type MobileDeviceInfo,
  type RemoteRouteEntry,
  type SocketLike,
  type TransportState,
} from './transport.ts';

export type { MobileDeviceInfo, RemoteRouteEntry, TransportState, TransportStatus } from './transport.ts';
export { ConnectionSupervisor, computeReconnectDelayMs, detectDefaultDeviceName, extractPairCodeFromHash, probeFallbackRoute } from './transport.ts';

/** Webview 本地保存的状态（输入框草稿等），刷新和隐藏后仍在。 */
export interface PersistedState {
  readonly draft?: string;
  /** 其他标签的草稿，键是标签的 key。 */
  readonly drafts?: Readonly<Record<string, string>>;
  /** 用户拖动设定的输入框高度（px）；没有时随内容自动增高。 */
  readonly inputHeight?: number | undefined;
  /** 会话改动栏是否展开（旧版本保存的；现在用 dockOpen）。 */
  readonly changesOpen?: boolean;
  /** 输入框上方状态栏里展开的那一项。 */
  readonly dockOpen?: 'todos' | 'changes' | undefined;
  /** 被隐藏时的会话改动签名；改动变化后重新显示。 */
  readonly changesDismissed?: string;
  /** 工作台当前选中的顶层模块。 */
  readonly activeModule?: WorkbenchModule;
  /** 会话模块左侧按项目分组面板是否展开。 */
  readonly sessionsSidebarOpen?: boolean;
  /** 上次选中的智能体，用于在冷启动收到 Host 快照前立即显示正确的智能体名称而不回退到 DeepSeek。 */
  readonly activeBackend?: { readonly id: string; readonly name: string; readonly kind?: BackendView['kind'] };
}

const MOBILE_STATE_KEY = 'harness-deck:mobile-persisted-state';

/** 第一次用到时才取（acquireVsCodeApi 每个页面只能调一次；测试里没有它）。 */
let cachedVsCodeApi: ReturnType<typeof acquireVsCodeApi<PersistedState>> | undefined;
function getVsCodeApi(): ReturnType<typeof acquireVsCodeApi<PersistedState>> | undefined {
  if (!isIdeWebviewEnvironment()) return undefined;
  return (cachedVsCodeApi ??= acquireVsCodeApi<PersistedState>());
}

/** 这些消息带一次性 commandId；宿主在 5 分钟内忽略重复 id（HD-16）。 */
const IDEMPOTENT_TYPES: ReadonlySet<WebviewToHost['type']> = new Set([
  'sendMessage',
  'respondApproval',
  'answerQuestion',
  'runScheduleNow',
]);

function newCommandId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function stampCommandId(message: WebviewToHost): WebviewToHost {
  if (!IDEMPOTENT_TYPES.has(message.type)) return message;
  const existing = 'commandId' in message ? message.commandId : undefined;
  return { ...message, commandId: existing ?? newCommandId() } as WebviewToHost;
}

const transportListeners = new Set<() => void>();
let supervisor: ConnectionSupervisor | undefined;
let messageHandler: ((message: HostToWebview) => void) | undefined;

let transportState: TransportState = {
  mode: isIdeWebviewEnvironment() ? 'ide' : 'mobile-web',
  status: isIdeWebviewEnvironment() ? 'ide' : 'checking',
  routes: typeof window !== 'undefined' ? loadKnownRoutes() : [],
  reconnectAttempt: 0,
};

function updateTransportState(patch: Partial<TransportState>): void {
  transportState = { ...transportState, ...patch };
  for (const listener of transportListeners) listener();
}

export function getTransportState(): TransportState {
  return transportState;
}

export function useTransportState(): TransportState {
  return useSyncExternalStore(
    (listener) => {
      transportListeners.add(listener);
      return () => transportListeners.delete(listener);
    },
    () => transportState,
  );
}

function buildWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function ensureSupervisor(): ConnectionSupervisor {
  if (!supervisor) {
    supervisor = new ConnectionSupervisor({
      wsUrl: buildWsUrl,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onHostMessage: (msg) => messageHandler?.(msg),
      onStatusChange: (status, attempt) => {
        if (status === 'connected') {
          updateTransportState({ status, reconnectAttempt: attempt, suggestedRoute: undefined });
          return;
        }
        updateTransportState({ status, reconnectAttempt: attempt });
        if (
          (status === 'reconnecting' || status === 'offline') &&
          attempt >= 2 &&
          transportState.routes.length > 1 &&
          typeof window !== 'undefined'
        ) {
          void probeFallbackRoute(transportState.routes, window.location.origin).then((route) => {
            if (route && transportState.status !== 'connected') {
              updateTransportState({ suggestedRoute: route });
            }
          });
        }
      },
      onRevoked: () => {
        updateTransportState({
          device: undefined,
          status: 'unauthenticated',
          error: 'revoked',
        });
      },
      isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
      isVisible: () => (typeof document !== 'undefined' ? !document.hidden : true),
    });
  }
  return supervisor;
}

async function checkMobileSession(): Promise<void> {
  if (typeof window === 'undefined') return;

  const pairCode = extractPairCodeFromHash(window.location.hash);
  if (pairCode) {
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    } catch {
      // ignore
    }
    updateTransportState({ pendingPairCode: pairCode });
  }

  updateTransportState({ mode: 'mobile-web', status: 'checking', error: undefined });
  try {
    const res = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) {
      updateTransportState({ status: 'unauthenticated' });
      return;
    }
    const data = (await res.json()) as {
      authenticated?: boolean;
      device?: MobileDeviceInfo;
      vapidPublicKey?: string;
      routes?: RemoteRouteEntry[];
    };
    const routes = Array.isArray(data.routes) ? data.routes : loadKnownRoutes();
    if (routes.length > 0) saveKnownRoutes(routes);
    if (data.authenticated && data.device) {
      updateTransportState({
        device: data.device,
        ...(data.vapidPublicKey ? { vapidPublicKey: data.vapidPublicKey } : {}),
        routes,
        error: undefined,
      });
      ensureSupervisor().start();
    } else {
      updateTransportState({
        device: undefined,
        ...(data.vapidPublicKey ? { vapidPublicKey: data.vapidPublicKey } : {}),
        routes,
        status: 'unauthenticated',
      });
    }
  } catch (error) {
    updateTransportState({
      status: 'unauthenticated',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function pairWithHost(
  code: string,
  deviceName: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly remainingAttempts?: number }> {
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), deviceName: deviceName.trim() || 'Mobile Browser' }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      reason?: string;
      remainingAttempts?: number;
      device?: MobileDeviceInfo;
      vapidPublicKey?: string;
      routes?: RemoteRouteEntry[];
    };
    if (!res.ok || !data.ok || !data.device) {
      return {
        ok: false,
        reason: data.reason ?? 'invalid',
        ...(data.remainingAttempts !== undefined ? { remainingAttempts: data.remainingAttempts } : {}),
      };
    }
    const routes = Array.isArray(data.routes) ? data.routes : [];
    if (routes.length > 0) saveKnownRoutes(routes);
    updateTransportState({
      mode: 'mobile-web',
      device: data.device,
      ...(data.vapidPublicKey ? { vapidPublicKey: data.vapidPublicKey } : {}),
      routes,
      pendingPairCode: undefined,
      error: undefined,
    });
    ensureSupervisor().start();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'network' };
  }
}

export async function logoutMobileDevice(): Promise<void> {
  supervisor?.stop('unauthenticated');
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // ignore network failure on logout
  }
  updateTransportState({ device: undefined, status: 'unauthenticated', error: undefined });
}

export function reconnectMobileTransport(): void {
  if (isIdeWebviewEnvironment()) return;
  if (transportState.device) {
    ensureSupervisor().reconnectNow();
  } else {
    void checkMobileSession();
  }
}

export async function registerMobilePush(vapidPublicKey: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const keyBytes = urlBase64ToUint8Array(vapidPublicKey);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes as unknown as BufferSource,
    });
  }
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return false;
  postToHost({
    type: 'registerWebPushSubscription',
    payload: {
      endpoint: json.endpoint,
      keys: { p256dh, auth },
    },
  });
  return true;
}

export async function unregisterMobilePush(): Promise<void> {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const endpoint = subscription?.endpoint;
      if (subscription) {
        await subscription.unsubscribe();
      }
      postToHost({
        type: 'unregisterWebPushSubscription',
        payload: endpoint ? { endpoint } : {},
      });
      return;
    } catch {
      // fall through
    }
  }
  postToHost({ type: 'unregisterWebPushSubscription', payload: {} });
}

/** 启动宿主通信通道（IDE 模式走 postMessage，浏览器模式走 WS + ConnectionSupervisor）。 */
export function startHostBridge(onMessage: (message: HostToWebview) => void): () => void {
  messageHandler = onMessage;
  if (isIdeWebviewEnvironment()) {
    cachedVsCodeApi = undefined;
    updateTransportState({ mode: 'ide', status: 'ide', reconnectAttempt: 0 });
    const onWindowMessage = (event: MessageEvent<HostToWebview>) => onMessage(event.data);
    window.addEventListener('message', onWindowMessage);
    postToHost({ type: 'ready', payload: {} });
    return () => {
      window.removeEventListener('message', onWindowMessage);
      if (messageHandler === onMessage) messageHandler = undefined;
    };
  }

  const onVisibilityChange = () => {
    supervisor?.notifyVisibility(!document.hidden);
  };
  const onOnline = () => {
    supervisor?.notifyOnline();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  void checkMobileSession();

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', onOnline);
    supervisor?.dispose();
    supervisor = undefined;
    if (messageHandler === onMessage) messageHandler = undefined;
  };
}

/** 向 Extension Host 发消息。 */
export function postToHost(message: WebviewToHost): void {
  const stamped = stampCommandId(message);
  const api = getVsCodeApi();
  if (api) {
    api.postMessage(stamped);
    return;
  }
  supervisor?.sendMessage(stamped);
}

export function loadState(): PersistedState {
  const api = getVsCodeApi();
  if (api) {
    return api.getState() ?? {};
  }
  try {
    const raw = window.localStorage.getItem(MOBILE_STATE_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : {};
  } catch {
    return {};
  }
}

export function saveState(patch: Partial<PersistedState>): void {
  const api = getVsCodeApi();
  if (api) {
    api.setState({ ...loadState(), ...patch });
    return;
  }
  try {
    window.localStorage.setItem(MOBILE_STATE_KEY, JSON.stringify({ ...loadState(), ...patch }));
  } catch {
    // ignore storage errors
  }
}

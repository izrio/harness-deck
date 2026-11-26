/**
 * 宿主内嵌 HTTP/WS 远程桥接服务器（HD-23 / HD-26 / HD-27）：
 * - 默认关闭；开启后托管 `dist/webview`、PWA 清单、配对接口 `/api/pair` 与鉴权 WebSocket `/ws`
 * - 严格校验 `Host`/`Origin`（防 DNS Rebinding）、`HttpOnly; SameSite=Strict` Cookie 与 `ScopeGuard`
 * - 支持局域网直连、Tailscale HTTPS 反代（`tailscale serve`）与 BYO 自定义隧道入口
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  parseWebviewMessage,
  type HostIdeKind,
  type HostToWebview,
  type RemoteQuickTunnelView,
  type RemoteRouteKind,
  type RemoteScope,
  type RemoteState,
  type RemoteTailscaleView,
  type RemoteWslNatInfo,
  type WebviewToHost,
} from '@harness-deck/shared';
import type { ClientHub } from '../host/ClientHub.ts';
import type { KeyValueStore } from '../host/HostPlatform.ts';
import { isWslEnvironment } from '../runtime/wsl.ts';
import {
  DeviceAuthStore,
  parseCookieHeader,
  REMOTE_COOKIE_NAME,
  REMOTE_SESSION_MAX_AGE_SEC,
} from './DeviceAuthStore.ts';
import {
  buildWslPortProxyCommand,
  hasMatchingPortProxyRule,
  mergeLanInterfaces,
  probeWslHostNetwork,
  type WslHostNetworkProbe,
  type WslHostNetworkSnapshot,
} from './NetworkInterfaces.ts';
import { HandoffManager, PairingManager } from './PairingManager.ts';
import type { PushService } from './PushService.ts';
import { QuickTunnelManager, type QuickTunnelExec, type QuickTunnelSpawn } from './QuickTunnelService.ts';
import { authorizeRemoteMessage, isAllowedHostHeader, isAllowedOriginHeader } from './ScopeGuard.ts';
import {
  configureTailscaleServe,
  normalizeTunnelUrl,
  probeTailscaleStatus,
  type TailscaleExec,
} from './TailscaleService.ts';

const REMOTE_CONFIG_KEY = 'harnessDeck.remote.config';
export const DEFAULT_REMOTE_PORT = 37890;
const MAX_PAIR_BODY_BYTES = 16 * 1024;
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;

interface StoredRemoteConfig {
  readonly enabled: boolean;
  readonly port?: number;
  readonly selectedHost?: string;
  readonly scope: RemoteScope;
  readonly tunnelUrl?: string;
  readonly tailscaleDnsName?: string;
  readonly tailscaleServeUrl?: string;
}

function parseRemoteConfig(raw: unknown): StoredRemoteConfig {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, scope: 'operate' };
  }
  const obj = raw as Record<string, unknown>;
  const port =
    typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port >= 1024 && obj.port <= 65535
      ? obj.port
      : undefined;
  return {
    enabled: obj.enabled === true,
    ...(port !== undefined ? { port } : {}),
    ...(typeof obj.selectedHost === 'string' && obj.selectedHost.trim()
      ? { selectedHost: obj.selectedHost.trim() }
      : {}),
    scope: obj.scope === 'read-only' ? 'read-only' : 'operate',
    ...(typeof obj.tunnelUrl === 'string' && normalizeTunnelUrl(obj.tunnelUrl)
      ? { tunnelUrl: normalizeTunnelUrl(obj.tunnelUrl) }
      : {}),
    ...(typeof obj.tailscaleDnsName === 'string' && obj.tailscaleDnsName.trim()
      ? { tailscaleDnsName: obj.tailscaleDnsName.trim() }
      : {}),
    ...(typeof obj.tailscaleServeUrl === 'string' && normalizeTunnelUrl(obj.tailscaleServeUrl)
      ? { tailscaleServeUrl: normalizeTunnelUrl(obj.tailscaleServeUrl) }
      : {}),
  };
}

function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    default:
      return 'application/octet-stream';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_PAIR_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  return await new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        rejectBody(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = text ? JSON.parse(text) : {};
        resolveBody(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined);
      } catch {
        resolveBody(undefined);
      }
    });
    req.on('error', (err) => rejectBody(err));
  });
}

function renderMobileHtml(hostKind: HostIdeKind, locale: 'zh' | 'en'): string {
  const safeLang = locale === 'zh' ? 'zh-CN' : 'en';
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: http: https:",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
  return `<!doctype html>
<html lang="${safeLang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#18181b">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/icon-192.svg">
<link rel="apple-touch-icon" href="/icon-192.svg">
<link rel="stylesheet" href="/index.css">
<title>Halo</title>
<script>
window.__HARNESS_DECK_HOST__ = ${JSON.stringify(hostKind)};
window.__HARNESS_DECK_CLIENT_SURFACE__ = 'mobile-web';
</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="/index.js"></script>
</body>
</html>`;
}

const FALLBACK_MANIFEST = JSON.stringify({
  name: 'Halo',
  short_name: 'Halo',
  start_url: '/',
  display: 'standalone',
  background_color: '#18181b',
  theme_color: '#18181b',
});

const FALLBACK_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));`;

export interface RemoteBridgeServerOptions {
  readonly hostKind: HostIdeKind;
  readonly globalState: KeyValueStore;
  readonly clientHub: ClientHub;
  readonly deviceAuth: DeviceAuthStore;
  readonly pushService: PushService;
  readonly webviewDistRoot?: string;
  readonly port?: number;
  readonly bindHost?: string;
  readonly locale: () => 'zh' | 'en';
  readonly onWebviewMessage: (message: WebviewToHost, clientId: string) => void;
  readonly onStateChange: () => void;
  readonly log: (line: string) => void;
  readonly tailscaleExec?: TailscaleExec;
  readonly quickTunnelExec?: QuickTunnelExec;
  readonly quickTunnelSpawn?: QuickTunnelSpawn;
  readonly wslNetworkProbe?: WslHostNetworkProbe;
  readonly now?: () => number;
}

export class RemoteBridgeServer {
  private readonly pairing: PairingManager;
  private readonly handoffs: HandoffManager;
  private readonly quickTunnel: QuickTunnelManager;
  private config: StoredRemoteConfig;
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private listeningPort: number | undefined;
  private tailscale: RemoteTailscaleView | undefined;
  private wslHostNetwork: WslHostNetworkSnapshot | undefined;
  private wslProbeInFlight: Promise<void> | undefined;
  private errorMessage: string | undefined;
  private pairingExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RemoteBridgeServerOptions) {
    this.pairing = new PairingManager(options.now);
    this.handoffs = new HandoffManager(options.now);
    this.quickTunnel = new QuickTunnelManager({
      ...(options.quickTunnelExec ? { exec: options.quickTunnelExec } : {}),
      ...(options.quickTunnelSpawn ? { spawn: options.quickTunnelSpawn } : {}),
      onStateChange: () => options.onStateChange(),
      log: options.log,
    });
    this.config = parseRemoteConfig(options.globalState.get<unknown>(REMOTE_CONFIG_KEY));
    // WSL 环境下后台静默预探测一次 Windows 宿主机局域网网卡（不阻塞扩展激活；单测绑定 loopback 时跳过）
    const bindHost = this.options.bindHost;
    const isLoopbackBind = bindHost === '127.0.0.1' || bindHost === '::1';
    if (!isLoopbackBind && (this.options.wslNetworkProbe || (process.platform === 'linux' && isWslEnvironment()))) {
      void this.refreshNetwork(true);
    }
  }

  get isRunning(): boolean {
    return Boolean(this.server?.listening);
  }

  get port(): number | undefined {
    return this.listeningPort;
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  async restoreIfEnabled(): Promise<void> {
    if (this.config.enabled) {
      await this.start();
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteState> {
    this.config = { ...this.config, enabled };
    await this.persistConfig();
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
    this.options.onStateChange();
    return this.getState();
  }

  async updateConfig(patch: {
    readonly selectedHost?: string;
    readonly scope?: RemoteScope;
    readonly tunnelUrl?: string;
  }): Promise<RemoteState> {
    const nextTunnel =
      patch.tunnelUrl !== undefined ? normalizeTunnelUrl(patch.tunnelUrl) : this.config.tunnelUrl;
    this.config = {
      ...this.config,
      ...(patch.selectedHost !== undefined
        ? patch.selectedHost.trim()
          ? { selectedHost: patch.selectedHost.trim() }
          : {}
        : this.config.selectedHost
          ? { selectedHost: this.config.selectedHost }
          : {}),
      ...(patch.scope ? { scope: patch.scope } : {}),
      ...(nextTunnel ? { tunnelUrl: nextTunnel } : {}),
    };
    if (patch.selectedHost === '') {
      const { selectedHost: _omit, ...rest } = this.config;
      this.config = rest;
    }
    if (patch.tunnelUrl !== undefined && !nextTunnel) {
      const { tunnelUrl: _omit, ...rest } = this.config;
      this.config = rest;
    }
    await this.persistConfig();
    this.options.onStateChange();
    return this.getState();
  }

  async generatePairing(options: {
    readonly scope?: RemoteScope;
    readonly routeKind?: RemoteRouteKind;
  } = {}): Promise<RemoteState> {
    if (!this.config.enabled) {
      await this.setEnabled(true);
    } else if (!this.isRunning) {
      await this.start();
    }
    await this.refreshNetwork(false);
    const routeKind = options.routeKind ?? 'lan';
    const scope = options.scope ?? this.config.scope;
    const baseUrl = this.resolvePairingBaseUrl(routeKind);
    const view = this.pairing.generate({ scope, baseUrl, routeKind });
    this.schedulePairingExpiry(view.expiresAt);
    this.options.onStateChange();
    return this.getState();
  }

  /** 重新探测 WSL 宿主机局域网网卡与 Windows portproxy 状态。 */
  async refreshNetwork(notify = true): Promise<RemoteState> {
    const bindHost = this.options.bindHost;
    const isLoopbackBind = bindHost === '127.0.0.1' || bindHost === '::1';
    if (!this.options.wslNetworkProbe && isLoopbackBind) {
      return this.getState();
    }
    const probe = this.options.wslNetworkProbe ?? probeWslHostNetwork;
    if (!this.wslProbeInFlight) {
      this.wslProbeInFlight = (async () => {
        try {
          const snapshot = await probe();
          if (snapshot) {
            this.wslHostNetwork = snapshot;
          }
        } catch {
          // 探测失败时保留已有本机网卡，不影响服务运行
        } finally {
          this.wslProbeInFlight = undefined;
        }
      })();
    }
    await this.wslProbeInFlight;
    if (notify) {
      this.options.onStateChange();
    }
    return this.getState();
  }

  clearPairing(): RemoteState {
    this.pairing.clear();
    if (this.pairingExpiryTimer) {
      clearTimeout(this.pairingExpiryTimer);
      this.pairingExpiryTimer = undefined;
    }
    this.options.onStateChange();
    return this.getState();
  }

  async revokeDevice(deviceId: string): Promise<RemoteState> {
    this.handoffs.revokeForDevice(deviceId);
    await this.options.deviceAuth.revokeDevice(deviceId);
    this.options.clientHub.disconnectDevice(deviceId, 4001, 'Device revoked');
    this.options.onStateChange();
    return this.getState();
  }

  async updateDevice(
    deviceId: string,
    patch: { readonly name?: string; readonly scope?: RemoteScope },
  ): Promise<{ readonly state: RemoteState; readonly affectedClientIds: readonly string[] }> {
    const updated = await this.options.deviceAuth.updateDevice(deviceId, patch);
    const affectedClientIds =
      updated && patch.scope ? this.options.clientHub.updateDeviceScope(deviceId, updated.scope) : [];
    this.options.onStateChange();
    return { state: this.getState(), affectedClientIds };
  }

  async disconnectAllRemote(): Promise<RemoteState> {
    this.pairing.clear();
    this.handoffs.clear();
    this.options.clientHub.disconnectAllRemote(4000, 'Emergency disconnect');
    this.options.onStateChange();
    return this.getState();
  }

  async probeQuickTunnel(): Promise<RemoteQuickTunnelView> {
    return await this.quickTunnel.probe();
  }

  async setQuickTunnelEnabled(enabled: boolean): Promise<RemoteQuickTunnelView> {
    if (!enabled) {
      await this.quickTunnel.stop(true);
      return (
        this.quickTunnel.getView() ?? {
          installed: true,
          status: 'stopped',
        }
      );
    }
    if (!this.config.enabled) {
      await this.setEnabled(true);
    } else if (!this.isRunning) {
      await this.start();
    }
    const port = this.listeningPort ?? this.options.port ?? 0;
    if (!port) {
      return { installed: true, status: 'error', error: 'Remote bridge is not running' };
    }
    return await this.quickTunnel.start(port);
  }

  async probeTailscale(): Promise<RemoteTailscaleView> {
    this.tailscale = await probeTailscaleStatus(this.options.tailscaleExec);
    if (this.tailscale.dnsName || this.tailscale.serveUrl) {
      const nextDns = this.tailscale.dnsName;
      const nextServe = this.tailscale.serveUrl;
      if (nextDns !== this.config.tailscaleDnsName || nextServe !== this.config.tailscaleServeUrl) {
        this.config = {
          ...this.config,
          ...(nextDns ? { tailscaleDnsName: nextDns } : {}),
          ...(nextServe ? { tailscaleServeUrl: nextServe } : {}),
        };
        await this.persistConfig();
      }
    }
    this.options.onStateChange();
    return this.tailscale;
  }

  async configureTailscaleServe(
    enabled: boolean,
  ): Promise<{ readonly ok: boolean; readonly manualCommand: string; readonly error?: string }> {
    if (enabled) {
      if (!this.config.enabled) {
        await this.setEnabled(true);
      } else if (!this.isRunning) {
        await this.start();
      }
    }
    const port = this.listeningPort ?? this.options.port ?? 0;
    if (!port) {
      return { ok: false, manualCommand: 'tailscale serve --bg http://127.0.0.1:<port>', error: 'Remote bridge is not running' };
    }
    const result = await configureTailscaleServe(port, enabled, this.options.tailscaleExec);
    await this.probeTailscale();
    return result;
  }

  private resolveLanInterfaces() {
    return mergeLanInterfaces(undefined, this.wslHostNetwork?.windowsInterfaces ?? []);
  }

  private buildWslNatInfo(
    selectedHost: string,
    localAddresses: ReadonlySet<string>,
    wslAddress: string | undefined,
  ): RemoteWslNatInfo | undefined {
    const snapshot = this.wslHostNetwork;
    if (!snapshot || !wslAddress) return undefined;
    const isWindowsHostIp = snapshot.windowsInterfaces.some((item) => item.address === selectedHost);
    if (!isWindowsHostIp || localAddresses.has(selectedHost)) return undefined;
    const port = this.listeningPort ?? this.options.port ?? this.config.port ?? DEFAULT_REMOTE_PORT;
    return {
      active: true,
      wslAddress,
      windowsAddress: selectedHost,
      portProxyConfigured: hasMatchingPortProxyRule(snapshot.portProxyRules, port, wslAddress, selectedHost),
      setupCommand: buildWslPortProxyCommand(port, wslAddress),
    };
  }

  getRoutes(): readonly { readonly kind: RemoteRouteKind; readonly url: string }[] {
    const routes: { kind: RemoteRouteKind; url: string }[] = [];
    if (this.listeningPort) {
      const { candidates, preferredAddress } = this.resolveLanInterfaces();
      const host =
        this.config.selectedHost && candidates.some((c) => c.address === this.config.selectedHost)
          ? this.config.selectedHost
          : preferredAddress;
      routes.push({ kind: 'lan', url: `http://${host}:${this.listeningPort}` });
    }
    const qtUrl = this.quickTunnel.getUrl();
    if (qtUrl) {
      routes.push({ kind: 'quick-tunnel', url: qtUrl });
    }
    if (this.tailscale?.serveUrl && this.tailscale.serveEnabled) {
      routes.push({ kind: 'tailscale', url: this.tailscale.serveUrl });
    }
    if (this.config.tunnelUrl) {
      routes.push({ kind: 'tunnel', url: this.config.tunnelUrl });
    }
    return routes;
  }

  /** 返回推送外链优先使用的完整会话地址（外网 HTTPS 优先，退化到 LAN）。 */
  buildSessionUrl(sessionId?: string): string | undefined {
    if (!this.isRunning) return undefined;
    const base =
      this.quickTunnel.getUrl() ??
      (this.tailscale?.serveEnabled ? this.tailscale.serveUrl : undefined) ??
      this.config.tunnelUrl ??
      this.getRoutes().find((r) => r.kind === 'lan')?.url;
    if (!base) return undefined;
    const cleanBase = base.replace(/\/+$/u, '');
    return sessionId ? `${cleanBase}/?session=${encodeURIComponent(sessionId)}` : `${cleanBase}/`;
  }

  getState(): RemoteState {
    const { candidates, preferredAddress, localAddresses, wslAddress } = this.resolveLanInterfaces();
    const selectedHost =
      this.config.selectedHost && candidates.some((c) => c.address === this.config.selectedHost)
        ? this.config.selectedHost
        : preferredAddress;
    const wslNat = this.buildWslNatInfo(selectedHost, localAddresses, wslAddress);
    const connectedDevices = this.options.clientHub.connectedDeviceIds();
    const pairing = this.pairing.current();
    const quickTunnel = this.quickTunnel.getView();
    return {
      enabled: this.config.enabled,
      running: this.isRunning,
      ...(this.listeningPort !== undefined ? { port: this.listeningPort } : {}),
      bindHost: this.options.bindHost ?? '0.0.0.0',
      interfaces: candidates,
      selectedHost,
      scope: this.config.scope,
      connectedClients: this.options.clientHub.remoteClientCount(),
      devices: this.options.deviceAuth.listViews(connectedDevices),
      ...(pairing ? { pairing } : {}),
      ...(this.tailscale ? { tailscale: this.tailscale } : {}),
      ...(quickTunnel ? { quickTunnel } : {}),
      ...(this.config.tunnelUrl ? { tunnelUrl: this.config.tunnelUrl } : {}),
      push: this.options.pushService.getConfig(),
      ...(wslNat ? { wslNat } : {}),
      ...(this.errorMessage ? { error: this.errorMessage } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    this.errorMessage = undefined;
    await Promise.all([
      this.options.pushService.ensureVapidKeys(),
      this.refreshNetwork(false),
    ]);

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      this.handleWsUpgrade(req, socket, head, wss);
    });

    const bindHost = this.options.bindHost ?? '0.0.0.0';
    const preferredPort = this.options.port ?? this.config.port ?? DEFAULT_REMOTE_PORT;

    const listenOn = (targetPort: number): Promise<void> =>
      new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(targetPort, bindHost, () => {
          server.removeListener('error', rejectListen);
          resolveListen();
        });
      });

    try {
      await listenOn(preferredPort);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 仅在 IDE 默认端口冲突时回退到系统分配端口；显式指定端口失败则直接报错
      if (this.options.port === undefined && preferredPort !== 0 && code === 'EADDRINUSE') {
        try {
          await listenOn(0);
        } catch (fallbackErr) {
          this.errorMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.options.log(`启动远程桥接失败：${this.errorMessage}`);
          wss.close();
          return;
        }
      } else {
        this.errorMessage = error instanceof Error ? error.message : String(error);
        this.options.log(`启动远程桥接失败：${this.errorMessage}`);
        wss.close();
        return;
      }
    }

    const addr = server.address();
    this.listeningPort = typeof addr === 'object' && addr ? addr.port : undefined;
    if (this.options.port === undefined && this.listeningPort && this.config.port !== this.listeningPort && this.listeningPort === preferredPort) {
      this.config = { ...this.config, port: this.listeningPort };
      await this.persistConfig();
    }
    this.server = server;
    this.wss = wss;
    this.options.log(`远程桥接已监听 ${bindHost}:${String(this.listeningPort)}`);
  }

  async stop(): Promise<void> {
    this.pairing.clear();
    this.handoffs.clear();
    await this.quickTunnel.stop(false);
    if (this.pairingExpiryTimer) {
      clearTimeout(this.pairingExpiryTimer);
      this.pairingExpiryTimer = undefined;
    }
    this.options.clientHub.disconnectAllRemote(4000, 'Remote bridge disabled');
    const wss = this.wss;
    const server = this.server;
    this.wss = undefined;
    this.server = undefined;
    this.listeningPort = undefined;
    this.errorMessage = undefined;

    if (wss) {
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'Server stopped');
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
    }
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  private async persistConfig(): Promise<void> {
    await this.options.globalState.update(REMOTE_CONFIG_KEY, this.config);
  }

  private resolvePairingBaseUrl(routeKind: RemoteRouteKind): string {
    if (routeKind === 'quick-tunnel' && this.quickTunnel.getUrl()) {
      return this.quickTunnel.getUrl()!;
    }
    if (routeKind === 'tailscale' && this.tailscale?.serveUrl) {
      return this.tailscale.serveUrl;
    }
    if (routeKind === 'tunnel' && this.config.tunnelUrl) {
      return this.config.tunnelUrl;
    }
    const port = this.listeningPort ?? 0;
    // 绑定到具体地址（如 127.0.0.1 或某张网卡）时，配对链接必须使用该地址，否则手机无法访问
    const bindHost = this.options.bindHost;
    if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
      const host = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
      return `http://${host}:${port}`;
    }
    const { candidates, preferredAddress } = this.resolveLanInterfaces();
    const host =
      this.config.selectedHost && candidates.some((c) => c.address === this.config.selectedHost)
        ? this.config.selectedHost
        : preferredAddress;
    return `http://${host}:${port}`;
  }

  private schedulePairingExpiry(expiresAt: number): void {
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    const delay = Math.max(50, expiresAt - (this.options.now?.() ?? Date.now()) + 20);
    this.pairingExpiryTimer = setTimeout(() => {
      this.pairingExpiryTimer = undefined;
      if (!this.pairing.current()) {
        this.options.onStateChange();
      }
    }, delay);
    this.pairingExpiryTimer.unref?.();
  }

  private allowedHostsAndOrigins(): {
    readonly hosts: Set<string>;
    readonly origins: Set<string>;
  } {
    const hosts = new Set<string>(['localhost', '127.0.0.1', '::1']);
    const { candidates } = this.resolveLanInterfaces();
    for (const c of candidates) {
      hosts.add(c.address.toLowerCase());
    }
    if (this.config.selectedHost) {
      hosts.add(this.config.selectedHost.toLowerCase());
    }
    const tailscaleDns = this.tailscale?.dnsName ?? this.config.tailscaleDnsName;
    if (tailscaleDns) {
      hosts.add(tailscaleDns.toLowerCase());
    }
    const origins = new Set<string>();
    if (this.config.tunnelUrl) {
      try {
        const parsed = new URL(this.config.tunnelUrl);
        hosts.add(parsed.hostname.toLowerCase());
        origins.add(parsed.origin.toLowerCase());
      } catch {
        // ignore
      }
    }
    const tailscaleServeUrl = this.tailscale?.serveUrl ?? this.config.tailscaleServeUrl;
    if (tailscaleServeUrl) {
      origins.add(tailscaleServeUrl.toLowerCase());
    }
    const quickTunnelUrl = this.quickTunnel.getUrl();
    if (quickTunnelUrl) {
      try {
        const parsed = new URL(quickTunnelUrl);
        hosts.add(parsed.hostname.toLowerCase());
        origins.add(parsed.origin.toLowerCase());
      } catch {
        // ignore
      }
    }
    return { hosts, origins };
  }

  private isRequestAuthorizedHost(req: IncomingMessage): boolean {
    const { hosts, origins } = this.allowedHostsAndOrigins();
    if (!isAllowedHostHeader(req.headers.host, hosts)) return false;
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    return isAllowedOriginHeader(originHeader, hosts, origins);
  }

  private isSecureRequest(req: IncomingMessage): boolean {
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0]?.trim().toLowerCase() === 'https') {
      return true;
    }
    return Boolean((req.socket as { encrypted?: boolean }).encrypted);
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isRequestAuthorizedHost(req)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden Host or Origin' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/api/health') {
      const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const corsHeaders: Record<string, string> = originHeader
        ? { 'Access-Control-Allow-Origin': originHeader, Vary: 'Origin' }
        : {};
      sendJson(res, 200, { ok: true, pairingActive: Boolean(this.pairing.current()) }, corsHeaders);
      return;
    }

    if (method === 'GET' && pathname === '/api/auth/session') {
      const cookies = parseCookieHeader(req.headers.cookie);
      const device = this.options.deviceAuth.verifyCookie(cookies[REMOTE_COOKIE_NAME]);
      if (!device) {
        sendJson(res, 200, { authenticated: false, routes: this.getRoutes() });
        return;
      }
      sendJson(res, 200, {
        authenticated: true,
        device: { id: device.id, name: device.name, scope: device.scope },
        vapidPublicKey: this.options.pushService.getVapidPublicKey(),
        routes: this.getRoutes(),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/pair') {
      let body: Record<string, unknown> | undefined;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 413, { ok: false, error: 'Payload too large' });
        return;
      }
      const code = typeof body?.code === 'string' ? body.code : '';
      const deviceName = typeof body?.deviceName === 'string' ? body.deviceName : 'Mobile Browser';
      const verified = this.pairing.verify(code);
      if (!verified.ok) {
        sendJson(res, 401, {
          ok: false,
          reason: verified.reason,
          ...(verified.remainingAttempts !== undefined ? { remainingAttempts: verified.remainingAttempts } : {}),
        });
        this.options.onStateChange();
        return;
      }
      const { device, cookieValue } = await this.options.deviceAuth.issueDevice(deviceName, verified.scope);
      const secure = this.isSecureRequest(req) ? '; Secure' : '';
      const cookie = `${REMOTE_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${REMOTE_SESSION_MAX_AGE_SEC}${secure}`;
      this.options.onStateChange();
      sendJson(
        res,
        200,
        {
          ok: true,
          device: { id: device.id, name: device.name, scope: device.scope },
          vapidPublicKey: this.options.pushService.getVapidPublicKey(),
          routes: this.getRoutes(),
        },
        { 'Set-Cookie': cookie },
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/handoff') {
      const cookies = parseCookieHeader(req.headers.cookie);
      const device = this.options.deviceAuth.verifyCookie(cookies[REMOTE_COOKIE_NAME]);
      if (!device) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      const ticket = this.handoffs.issue(device.id);
      sendJson(res, 200, { ok: true, token: ticket.token, expiresAt: ticket.expiresAt });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/handoff/redeem') {
      let body: Record<string, unknown> | undefined;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 413, { ok: false, error: 'Payload too large' });
        return;
      }
      const token = typeof body?.token === 'string' ? body.token : '';
      const redeemed = this.handoffs.redeem(token);
      if (!redeemed.ok) {
        sendJson(res, 401, { ok: false, reason: 'expired' });
        return;
      }
      const issued = await this.options.deviceAuth.issueAdditionalCookie(redeemed.deviceId);
      if (!issued) {
        sendJson(res, 401, { ok: false, reason: 'revoked' });
        return;
      }
      const secure = this.isSecureRequest(req) ? '; Secure' : '';
      const cookie = `${REMOTE_COOKIE_NAME}=${encodeURIComponent(issued.cookieValue)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${REMOTE_SESSION_MAX_AGE_SEC}${secure}`;
      this.options.onStateChange();
      sendJson(
        res,
        200,
        {
          ok: true,
          device: { id: issued.device.id, name: issued.device.name, scope: issued.device.scope },
          vapidPublicKey: this.options.pushService.getVapidPublicKey(),
          routes: this.getRoutes(),
        },
        { 'Set-Cookie': cookie },
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const cookies = parseCookieHeader(req.headers.cookie);
      const device = this.options.deviceAuth.verifyCookie(cookies[REMOTE_COOKIE_NAME]);
      if (device) {
        await this.revokeDevice(device.id);
      }
      const secure = this.isSecureRequest(req) ? '; Secure' : '';
      sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': `${REMOTE_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` },
      );
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/pair' || pathname === '/index.html') {
      const html = renderMobileHtml(this.options.hostKind, this.options.locale());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : html);
      return;
    }

    await this.serveStaticAsset(pathname, method === 'HEAD', res);
  }

  private async serveStaticAsset(pathname: string, isHead: boolean, res: ServerResponse): Promise<void> {
    const cleanRel = pathname.replace(/^\/+/u, '');
    if (!cleanRel || cleanRel.includes('\0')) {
      res.writeHead(404);
      res.end();
      return;
    }

    const root = this.options.webviewDistRoot;
    if (root) {
      const resolvedRoot = resolve(root);
      const target = resolve(resolvedRoot, cleanRel);
      if (target.startsWith(`${resolvedRoot}${sep}`)) {
        try {
          const data = await readFile(target);
          res.writeHead(200, {
            'Content-Type': contentTypeFor(target),
            'Cache-Control': cleanRel === 'sw.js' || cleanRel === 'manifest.webmanifest' ? 'no-cache' : 'public, max-age=300',
          });
          res.end(isHead ? undefined : data);
          return;
        } catch {
          // fall through to built-in fallbacks / 404
        }
      }
    }

    if (cleanRel === 'manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(isHead ? undefined : FALLBACK_MANIFEST);
      return;
    }
    if (cleanRel === 'sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(isHead ? undefined : FALLBACK_SW);
      return;
    }
    if (cleanRel === 'icon-192.svg') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#18181b"/><path d="M18 20h28v6H18zm0 10h20v6H18zm0 10h28v6H18z" fill="#3b82f6"/></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      res.end(isHead ? undefined : svg);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private handleWsUpgrade(
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.isRequestAuthorizedHost(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    const device = this.options.deviceAuth.verifyCookie(cookies[REMOTE_COOKIE_NAME]);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = `remote:${device.id}:${randomUUID()}`;
      this.options.deviceAuth.touchDevice(device.id);

      const unregister = this.options.clientHub.registerClient({
        id: clientId,
        surface: 'mobile-web',
        scope: device.scope,
        deviceId: device.id,
        visible: true,
        send: (msg: HostToWebview) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
          }
        },
        close: (code, reason) => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(code, reason);
          }
        },
      });

      this.options.onStateChange();

      ws.on('message', (rawData) => {
        this.options.deviceAuth.touchDevice(device.id);
        let rawObj: unknown;
        try {
          const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
          rawObj = JSON.parse(text);
        } catch {
          return;
        }
        if (rawObj && typeof rawObj === 'object') {
          const obj = rawObj as { type?: unknown; payload?: { visible?: unknown } };
          if (obj.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            return;
          }
          if (obj.type === 'visibility') {
            this.options.clientHub.setClientVisible(clientId, obj.payload?.visible !== false);
            return;
          }
        }
        const parsed = parseWebviewMessage(rawObj);
        if (!parsed) return;

        const liveScope = this.options.clientHub.getClient(clientId)?.scope ?? this.options.deviceAuth.getDevice(device.id)?.scope ?? device.scope;
        const auth = authorizeRemoteMessage(liveScope, parsed);
        if (!auth.ok) {
          this.options.clientHub.sendTo(clientId, {
            type: 'toast',
            payload: { level: 'error', text: auth.reason },
          });
          return;
        }

        if (parsed.type === 'registerWebPushSubscription') {
          void this.options.deviceAuth.setPushSubscription(device.id, parsed.payload).then(() => {
            this.options.onStateChange();
          });
          return;
        }
        if (parsed.type === 'unregisterWebPushSubscription') {
          void this.options.deviceAuth.setPushSubscription(device.id, undefined).then(() => {
            this.options.onStateChange();
          });
          return;
        }

        this.options.onWebviewMessage(parsed, clientId);
      });

      ws.on('close', () => {
        unregister();
        this.options.onStateChange();
      });

      ws.on('error', () => {
        unregister();
        this.options.onStateChange();
      });
    });
  }
}

export function fallbackWebviewDistRoot(baseDir: string): string {
  return join(baseDir, 'webview');
}

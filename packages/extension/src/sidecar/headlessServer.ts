/**
 * 脱离 IDE 的独立守护进程模式（HD-28）：
 * - 通过 `--headless-server <configRoot> <projectPath>` 启动常驻无头宿主与 HTTP/WS 远程桥接
 * - 使用单实例锁 + 运行状态文件（`headless-server.json`）支持 `status` / `stop` 查看与启停
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteRouteKind, RemoteScope, RemoteState } from '@harness-deck/shared';
import { createHarnessHostRuntime, type HarnessHostRuntime } from '../host/HarnessHostRuntime.ts';
import type { HostPlatform } from '../host/HostPlatform.ts';
import { noWorkbench } from '../vm/workbench.ts';
import { FileKeyValueStore, FileSettingsStore, workspaceStateFilePath } from './fileStores.ts';
import { acquireSchedulerLock } from './schedulerLock.ts';

export type HeadlessTunnelMode = 'none' | 'quick' | 'tailscale';

export interface HeadlessServerOptions {
  readonly configRoot: string;
  readonly projectPath: string;
  readonly port?: number;
  readonly bindHost?: string;
  readonly webviewDistRoot?: string;
  readonly generatePairingOnStart?: boolean;
  /** 配对默认作用域：普通模式为 `operate`，云端无头宿主（`--cloud` / `--scope owner`）使用 `owner`。 */
  readonly scope?: RemoteScope;
  /** 启动时自动开启的公网入口类型。 */
  readonly tunnel?: HeadlessTunnelMode;
  /** 自定义公网入口 URL（如 Named Cloudflare Tunnel / frp / 反代域名）。 */
  readonly publicUrl?: string;
  readonly log?: (line: string) => void;
}

export interface HeadlessServerStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly port?: number;
  readonly projectPath?: string;
  readonly startedAt?: number;
  readonly pairingUrl?: string;
}

export interface HeadlessServerHandle {
  readonly runtime: HarnessHostRuntime;
  readonly getState: () => RemoteState | undefined;
  readonly stop: () => Promise<void>;
}

function serverLockDir(configRoot: string): string {
  return join(configRoot, 'headless-server-lock');
}

function serverInfoPath(configRoot: string): string {
  return join(configRoot, 'headless-server.json');
}

function resolveDefaultWebviewRoot(): string | undefined {
  if (typeof __dirname === 'string') return join(__dirname, 'webview');
  if (process.argv[1]) return join(dirname(process.argv[1]), 'webview');
  return undefined;
}

export async function readHeadlessServerStatus(configRoot: string): Promise<HeadlessServerStatus> {
  try {
    const raw = await readFile(serverInfoPath(configRoot), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    if (!pid) return { running: false };
    try {
      process.kill(pid, 0);
    } catch {
      return { running: false };
    }
    return {
      running: true,
      pid,
      ...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
      ...(typeof parsed.projectPath === 'string' ? { projectPath: parsed.projectPath } : {}),
      ...(typeof parsed.startedAt === 'number' ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.pairingUrl === 'string' ? { pairingUrl: parsed.pairingUrl } : {}),
    };
  } catch {
    return { running: false };
  }
}

export async function stopHeadlessServer(configRoot: string): Promise<boolean> {
  const status = await readHeadlessServerStatus(configRoot);
  if (!status.running || !status.pid) return false;
  try {
    process.kill(status.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export async function runHeadlessServer(options: HeadlessServerOptions): Promise<HeadlessServerHandle | undefined> {
  const { configRoot, projectPath } = options;
  const log = options.log ?? (() => undefined);
  await mkdir(join(configRoot, 'storage'), { recursive: true });
  await mkdir(serverLockDir(configRoot), { recursive: true });

  const lock = await acquireSchedulerLock(serverLockDir(configRoot));
  if (!lock) {
    log('another headless server is already running');
    return undefined;
  }

  const globalState = await FileKeyValueStore.open(join(configRoot, 'global-state.json'), { watchExternal: true });
  const workspaceState = await FileKeyValueStore.open(workspaceStateFilePath(configRoot, projectPath));
  const settings = await FileSettingsStore.open(join(configRoot, 'settings.json'));
  const secrets = new Map<string, string>();

  // 独立守护进程复用 FileKeyValueStore，但提供显式环境变量兜底密钥读取（HD-28）
  const secretKeyFallback = (key: string): string | undefined => {
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 8).toUpperCase();
    return process.env[`HARNESS_DECK_SECRET_${digest}`] ?? secrets.get(key);
  };

  const webviewDistRoot = options.webviewDistRoot ?? resolveDefaultWebviewRoot();
  const platform: HostPlatform = {
    hostKind: 'jetbrains',
    extensionVersion: 'headless-server',
    storageRoot: join(configRoot, 'storage'),
    ...(webviewDistRoot ? { webviewDistRoot } : {}),
    schedulerLockDir: configRoot,
    globalState,
    workspaceState,
    settings,
    secrets: {
      get: async (key) => secretKeyFallback(key),
      store: async (key, value) => void secrets.set(key, value),
      delete: async (key) => void secrets.delete(key),
      onDidChange: () => () => undefined,
    },
    workbench: noWorkbench,
    envLanguage: () => 'en',
    isWorkspaceTrusted: () => true,
    onDidGrantWorkspaceTrust: () => () => undefined,
    isWindowFocused: () => false,
    workspaceFolders: () => [{ name: projectPath.split(/[\\/]/u).pop() ?? projectPath, path: projectPath }],
    postToWebview: () => undefined,
    isWebviewVisible: () => false,
    focusChatView: async () => undefined,
    openWorkbenchPanel: () => undefined,
    log,
    runtimeLog: (line, stream) => log(`[${stream}] ${line}`),
    showLogs: () => undefined,
    openHostSettings: () => undefined,
    onStatusUpdate: () => undefined,
    openExternal: async () => false,
    resolveExternalOrigin: async (origin) => origin,
    writeClipboard: async () => undefined,
    showMessage: async () => undefined,
    pickQuickItem: async () => undefined,
    withCancellableProgress: async (_title, task) => task(() => undefined),
    pickOpenDialog: async () => [],
    openProjectWindow: async () => undefined,
    runInTerminal: async () => undefined,
  };

  const runtime = createHarnessHostRuntime(platform, {
    ...(options.port !== undefined ? { remotePort: options.port } : {}),
    ...(options.bindHost ? { remoteBindHost: options.bindHost } : {}),
  });

  const pairingScope: RemoteScope = options.scope ?? 'operate';
  let activeRouteKind: RemoteRouteKind = 'lan';

  if (options.publicUrl?.trim()) {
    await runtime.updateRemoteConfig?.({ tunnelUrl: options.publicUrl.trim(), scope: pairingScope });
    activeRouteKind = 'tunnel';
  } else if (pairingScope !== 'operate') {
    await runtime.updateRemoteConfig?.({ scope: pairingScope });
  }

  if (options.tunnel === 'quick') {
    const qt = await runtime.setQuickTunnelEnabled?.(true);
    if (qt?.status === 'running' && qt.url) {
      activeRouteKind = 'quick-tunnel';
      log(`quick tunnel ready: ${qt.url}`);
    } else {
      log(`quick tunnel unavailable (${qt?.error ?? 'not installed'}), falling back to ${activeRouteKind}`);
    }
  } else if (options.tunnel === 'tailscale') {
    const ts = await runtime.configureTailscaleServe?.(true);
    if (ts?.ok) {
      activeRouteKind = 'tailscale';
    } else {
      log(`tailscale serve unavailable (${ts?.error ?? 'failed'}), falling back to ${activeRouteKind}`);
    }
  }

  if (options.generatePairingOnStart !== false) {
    await runtime.generateRemotePairing?.({ scope: pairingScope, routeKind: activeRouteKind });
  } else {
    runtime.handleWebviewMessage({ type: 'setRemoteEnabled', payload: { enabled: true } });
  }

  const writeServerInfo = async (): Promise<void> => {
    const state = runtime.getRemoteState?.();
    await writeFile(
      serverInfoPath(configRoot),
      JSON.stringify(
        {
          pid: process.pid,
          projectPath,
          startedAt: Date.now(),
          ...(state?.port !== undefined ? { port: state.port } : {}),
          ...(state?.pairing?.url ? { pairingUrl: state.pairing.url } : {}),
        },
        null,
        2,
      ),
      'utf8',
    );
  };

  await writeServerInfo();
  const state = runtime.getRemoteState?.();
  log(`headless server listening on port ${String(state?.port ?? 'unknown')}`);
  if (state?.pairing?.url) {
    log(`pairing URL: ${state.pairing.url}`);
  }

  const onRefreshPairing = (): void => {
    void runtime.generateRemotePairing?.({ scope: pairingScope, routeKind: activeRouteKind }).then(async (next) => {
      await writeServerInfo();
      if (next.pairing?.url) {
        log(`refreshed pairing URL: ${next.pairing.url}`);
      }
    });
  };
  if (process.platform !== 'win32') {
    process.on('SIGUSR1', onRefreshPairing);
  }

  let stopped = false;
  const keepAlive = setInterval(() => undefined, 60_000);
  keepAlive.unref?.();

  return {
    runtime,
    getState: () => runtime.getRemoteState?.(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(keepAlive);
      if (process.platform !== 'win32') {
        process.off('SIGUSR1', onRefreshPairing);
      }
      await runtime.dispose();
      settings.dispose();
      globalState.dispose();
      workspaceState.dispose();
      await rm(serverInfoPath(configRoot), { force: true }).catch(() => undefined);
      await lock.release();
      log('headless server stopped');
    },
  };
}

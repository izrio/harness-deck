import { afterEach, describe, expect, it } from 'vitest';
import type { HostSnapshot, HostToWebview, WebviewToHost } from '@harness-deck/shared';
import { ClientHub } from '../src/host/ClientHub.ts';
import type { HostPlatform, KeyValueStore, SecretStore } from '../src/host/HostPlatform.ts';
import { createHarnessHostRuntime } from '../src/host/HarnessHostRuntime.ts';
import { CloudEnvironmentStore, parseCloudPairingInput } from '../src/remote/CloudEnvironmentStore.ts';
import { CloudHostConnection, pairWithCloudHost } from '../src/remote/CloudHostClient.ts';
import { DeviceAuthStore } from '../src/remote/DeviceAuthStore.ts';
import { PushService } from '../src/remote/PushService.ts';
import { RemoteBridgeServer } from '../src/remote/RemoteBridgeServer.ts';
import { authorizeRemoteMessage } from '../src/remote/ScopeGuard.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

class MemoryKVStore implements KeyValueStore {
  readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }
}

class MemorySecretStore implements SecretStore {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  onDidChange(): () => void {
    return () => undefined;
  }
}

function makeSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1.0.0', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: 'Remote Session', running: false }], active: 't1' },
    session: {
      title: 'Remote Session',
      folder: 'colab-workspace',
      running: false,
      hasOlder: false,
      loadingOlder: false,
      sync: 'idle',
    },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: { items: [{ id: 'dsh', name: 'DeepSeek', kind: 'dsh' }], active: 'dsh' },
    ...overrides,
  };
}

function createFakePlatform(
  posted: HostToWebview[],
  onPost?: (msg: HostToWebview) => void,
): { readonly platform: HostPlatform; readonly kv: MemoryKVStore; readonly secrets: MemorySecretStore } {
  const kv = new MemoryKVStore();
  const wsKv = new MemoryKVStore();
  const secrets = new MemorySecretStore();
  const settingsMap = new Map<string, unknown>();
  const platform: HostPlatform = {
    hostKind: 'vscode',
    extensionVersion: '0.19.0',
    storageRoot: '/tmp/halo-cloud-test',
    globalState: kv,
    workspaceState: wsKv,
    settings: {
      get: <T>(key: string, fallback: T): T => (settingsMap.has(key) ? (settingsMap.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) settingsMap.delete(key);
        else settingsMap.set(key, value);
      },
      getHttpProxy: () => undefined,
      onDidChange: () => () => undefined,
    },
    secrets,
    workbench: noWorkbench,
    envLanguage: () => 'zh-cn',
    isWorkspaceTrusted: () => true,
    onDidGrantWorkspaceTrust: () => () => undefined,
    isWindowFocused: () => true,
    workspaceFolders: () => [{ name: 'local-repo', path: '/local/local-repo' }],
    postToWebview: (msg) => {
      posted.push(msg);
      onPost?.(msg);
    },
    isWebviewVisible: () => true,
    focusChatView: async () => undefined,
    openWorkbenchPanel: () => undefined,
    log: () => undefined,
    runtimeLog: () => undefined,
    showLogs: () => undefined,
    openHostSettings: () => undefined,
    onStatusUpdate: () => undefined,
    openExternal: async () => true,
    resolveExternalOrigin: async (o) => o,
    writeClipboard: async () => undefined,
    showMessage: async () => undefined,
    pickQuickItem: async () => undefined,
    withCancellableProgress: async (_title, task) => task(() => undefined),
    pickOpenDialog: async () => [],
    openProjectWindow: async () => undefined,
    runInTerminal: async () => undefined,
  };
  return { platform, kv, secrets };
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

describe('parseCloudPairingInput', () => {
  it('解析 Cloudflare Quick Tunnel 配对链接并推断 colab 类型', () => {
    const parsed = parseCloudPairingInput('https://calm-fox-123.trycloudflare.com/pair#code=secretCode99');
    expect(parsed).toEqual({
      endpointUrl: 'https://calm-fox-123.trycloudflare.com',
      pairingCode: 'secretCode99',
      inferredProvider: 'colab',
      suggestedName: 'Colab · calm-fox-123',
    });
  });

  it('解析无协议本地地址与显式配对码', () => {
    const parsed = parseCloudPairingInput('127.0.0.1:37890', 'manual-code');
    expect(parsed?.endpointUrl).toBe('http://127.0.0.1:37890');
    expect(parsed?.pairingCode).toBe('manual-code');
    expect(parsed?.inferredProvider).toBe('linux');
  });

  it('拒绝非法协议或空字符串', () => {
    expect(parseCloudPairingInput('')).toBeUndefined();
    expect(parseCloudPairingInput('ftp://example.com/pair#code=123')).toBeUndefined();
  });
});

describe('CloudEnvironmentStore', () => {
  it('元数据存 globalState，会话 Cookie 仅存 SecretStore', async () => {
    const kv = new MemoryKVStore();
    const secrets = new MemorySecretStore();
    const store = new CloudEnvironmentStore(kv, secrets, () => 1_700_000_000_000);

    const added = await store.add(
      {
        name: 'Colab CPU',
        endpointUrl: 'https://demo.trycloudflare.com/pair#code=abc',
        provider: 'colab',
      },
      'dev1.topsecret',
    );

    expect(added.endpointUrl).toBe('https://demo.trycloudflare.com');
    expect(JSON.stringify(kv.get('harnessDeck.cloudEnvironments'))).not.toContain('topsecret');
    expect(await store.getCookie(added.id)).toBe('dev1.topsecret');
    expect(store.toViews(added.id, 'connected')[0]).toMatchObject({
      id: added.id,
      name: 'Colab CPU',
      status: 'connected',
      hasCredentials: true,
    });

    await store.remove(added.id);
    expect(store.list()).toHaveLength(0);
    expect(await store.getCookie(added.id)).toBeUndefined();
  });
});

describe('ScopeGuard owner 作用域', () => {
  it('owner 允许云端无头管理操作，而 operate / read-only 保持拦截', () => {
    const openProjMsg: WebviewToHost = {
      type: 'openProject',
      payload: { path: '/content/drive/MyDrive/workspace', inPlace: true },
    };
    const addCloudMsg: WebviewToHost = {
      type: 'addCloudEnvironment',
      payload: { pairingUrlOrEndpoint: 'https://example.com/pair#code=1' },
    };

    expect(authorizeRemoteMessage('owner', openProjMsg).ok).toBe(true);
    expect(authorizeRemoteMessage('operate', openProjMsg).ok).toBe(false);
    expect(authorizeRemoteMessage('read-only', openProjMsg).ok).toBe(false);
    expect(authorizeRemoteMessage('operate', addCloudMsg).ok).toBe(false);
  });
});

describe('CloudHostConnection 与 HarnessHostRuntime 云代理集成', () => {
  it('通过 RemoteBridgeServer(owner) 完成配对、长连、快照合并、切换云端目录与切回本地', async () => {
    const serverKv = new MemoryKVStore();
    const receivedOnServer: WebviewToHost[] = [];
    let resolveServerOpenProject: ((msg: WebviewToHost) => void) | undefined;
    const serverOpenProjectPromise = new Promise<WebviewToHost>((resolve) => {
      resolveServerOpenProject = resolve;
    });

    const serverHub = new ClientHub({
      hostKind: 'jetbrains',
      postToIde: () => undefined,
      isIdeVisible: () => false,
    });
    const deviceAuth = new DeviceAuthStore(serverKv);
    const pushService = new PushService(serverKv, deviceAuth, { isWindowFocused: () => false });
    const bridge = new RemoteBridgeServer({
      hostKind: 'jetbrains',
      globalState: serverKv,
      clientHub: serverHub,
      deviceAuth,
      pushService,
      port: 0,
      bindHost: '127.0.0.1',
      locale: () => 'zh',
      onWebviewMessage: (msg, clientId) => {
        receivedOnServer.push(msg);
        if (msg.type === 'ready') {
          serverHub.sendTo(clientId, {
            type: 'snapshot',
            payload: makeSnapshot({
              projects: {
                currentPath: '/content/drive/MyDrive/repo-a',
                recent: [
                  { path: '/content/drive/MyDrive/repo-a', name: 'repo-a', lastOpenedAt: 2, isCurrent: true },
                  { path: '/content/drive/MyDrive/repo-b', name: 'repo-b', lastOpenedAt: 1 },
                ],
                configs: {},
              },
            }),
          });
        } else if (msg.type === 'openProject') {
          resolveServerOpenProject?.(msg);
        }
      },
      onStateChange: () => undefined,
      log: () => undefined,
    });
    cleanups.push(() => bridge.stop());

    const remoteState = await bridge.generatePairing({ scope: 'owner', routeKind: 'lan' });
    expect(remoteState.pairing?.url).toContain('/pair#code=');
    const pairingUrl = remoteState.pairing!.url;

    // 1. 直接验证 pairWithCloudHost + CloudHostConnection
    const parsed = parseCloudPairingInput(pairingUrl)!;
    const directPair = await pairWithCloudHost({
      endpointUrl: parsed.endpointUrl,
      code: parsed.pairingCode!,
      deviceName: 'Test IDE',
    });
    expect(directPair.ok).toBe(true);
    if (!directPair.ok) return;
    expect(directPair.device.scope).toBe('owner');

    let resolveDirectSnapshot: ((msg: HostToWebview) => void) | undefined;
    const directSnapshotPromise = new Promise<HostToWebview>((resolve) => {
      resolveDirectSnapshot = resolve;
    });
    const directConn = new CloudHostConnection({
      envId: 'direct',
      endpointUrl: parsed.endpointUrl,
      cookieValue: directPair.cookieValue,
      onMessage: (msg) => {
        if (msg.type === 'snapshot') resolveDirectSnapshot?.(msg);
      },
      onStatusChange: () => undefined,
    });
    cleanups.push(() => directConn.dispose());
    directConn.start();
    const directSnap = await directSnapshotPromise;
    expect(directSnap.type).toBe('snapshot');
    directConn.dispose();

    // 2. 通过本地 HarnessHostRuntime 完成「添加云环境 → 自动连云 → 合并本地+云端项目 → 切换云端目录 → 切回本地」
    const freshPairing = (await bridge.generatePairing({ scope: 'owner', routeKind: 'lan' })).pairing!.url;
    const posted: HostToWebview[] = [];
    let resolveConnectedSnapshot: ((snap: HostSnapshot) => void) | undefined;
    const connectedSnapshotPromise = new Promise<HostSnapshot>((resolve) => {
      resolveConnectedSnapshot = resolve;
    });
    let resolveLocalRestored: ((snap: HostSnapshot) => void) | undefined;
    const localRestoredPromise = new Promise<HostSnapshot>((resolve) => {
      resolveLocalRestored = resolve;
    });

    let seenCloudSnapshot = false;
    const { platform } = createFakePlatform(posted, (msg) => {
      if (msg.type === 'snapshot') {
        if (msg.payload.projects?.activeEnvironment?.kind === 'cloud' && !seenCloudSnapshot) {
          seenCloudSnapshot = true;
          resolveConnectedSnapshot?.(msg.payload);
        } else if (seenCloudSnapshot && msg.payload.projects?.activeEnvironment?.kind === 'local') {
          resolveLocalRestored?.(msg.payload);
        }
      }
    });

    const localRuntime = createHarnessHostRuntime(platform, { remoteBindHost: '127.0.0.1' });
    cleanups.push(() => localRuntime.dispose());

    localRuntime.handleWebviewMessage({
      type: 'addCloudEnvironment',
      payload: {
        name: 'Colab CPU',
        provider: 'colab',
        pairingUrlOrEndpoint: freshPairing,
        connectNow: true,
      },
    });

    const cloudSnap = await connectedSnapshotPromise;
    expect(cloudSnap.session.title).toBe('Remote Session');
    expect(cloudSnap.projects?.activeEnvironment).toMatchObject({
      kind: 'cloud',
      name: 'Colab CPU',
      status: 'connected',
      remoteProjectPath: '/content/drive/MyDrive/repo-a',
    });
    // 本地项目列表在云端快照里保持可见，方便一键切回本地
    expect(cloudSnap.projects?.recent.some((p) => p.path === '/local/local-repo')).toBe(true);
    expect(cloudSnap.projects?.cloudRecent?.map((p) => p.name)).toEqual(['repo-a', 'repo-b']);

    // 在云环境中切换远端子目录，应转发给远端 openProject(inPlace: true)
    localRuntime.handleWebviewMessage({
      type: 'switchCloudProject',
      payload: { path: '/content/drive/MyDrive/repo-b' },
    });
    const forwardedOpen = await serverOpenProjectPromise;
    expect(forwardedOpen).toEqual({
      type: 'openProject',
      payload: { path: '/content/drive/MyDrive/repo-b', inPlace: true },
    });

    // 断开云环境，应立刻恢复本地快照
    localRuntime.handleWebviewMessage({ type: 'disconnectCloudEnvironment', payload: {} });
    const restoredLocalSnap = await localRestoredPromise;
    expect(restoredLocalSnap.projects?.activeEnvironment?.kind).toBe('local');
    expect(receivedOnServer.some((m) => m.type === 'ready')).toBe(true);
  });
});

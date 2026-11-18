import { afterEach, describe, expect, it } from 'vitest';
import type { HostSnapshot, HostToWebview, RuntimeStatus } from '@harness-deck/shared';
import type { BackendHost } from '../src/backend/host.ts';
import type { BackendProfile, ChatBackendController, RunningBackend } from '../src/backend/types.ts';
import { createHarnessHostRuntime, type HarnessHostRuntime } from '../src/host/HarnessHostRuntime.ts';
import type {
  HostPlatform,
  KeyValueStore,
  QuickPickOption,
  SecretStore,
  SettingsStore,
  StatusBarSnapshot,
} from '../src/host/HostPlatform.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

class MemoryKVStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.map.delete(key);
      return;
    }
    this.map.set(key, value);
  }
}

class MemorySettingsStore implements SettingsStore {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<(changedKeys: ReadonlySet<string>) => void>();

  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string, defaultValue: T): T {
    if (!this.values.has(key)) return defaultValue;
    return this.values.get(key) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    const changed = new Set([key]);
    for (const listener of this.listeners) {
      listener(changed);
    }
  }

  getHttpProxy(): string | undefined {
    return undefined;
  }

  onDidChange(listener: (changedKeys: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  private readonly listeners = new Set<(key: string) => void>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    for (const listener of this.listeners) listener(key);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
    for (const listener of this.listeners) listener(key);
  }

  onDidChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function makeSnapshot(profileId: string, overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '0.2.2', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: `${profileId}-tab-1`, title: '新对话', running: false }], active: `${profileId}-tab-1` },
    session: { id: `${profileId}-sess-1`, title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: { items: [{ id: profileId, name: profileId, kind: profileId === 'dsh' ? 'dsh' : 'acp' }], active: profileId },
    ...overrides,
  };
}

interface FakeBackendInstance {
  readonly profile: BackendProfile;
  readonly host: BackendHost;
  status: RuntimeStatus;
  running: boolean;
  startCount: number;
  restartCount: number;
  stopCount: number;
  disposeCount: number;
  readonly switchedSessions: string[];
  readonly workspacePaths: string[];
  emitSnapshot: (patch: Partial<HostSnapshot>) => void;
  postDirect: (msg: HostToWebview) => void;
  observe: (opts: {
    readonly sessionId?: string;
    readonly title: string;
    readonly running: boolean;
    readonly sync?: string;
    readonly interactionIds?: readonly string[];
    readonly hasTurnOutput?: boolean;
  }) => void;
  readonly backend: RunningBackend;
}

function createFakePlatform(opts: {
  initialSettings?: Readonly<Record<string, unknown>>;
  initialGlobalState?: Readonly<Record<string, unknown>>;
  initialWorkspaceState?: Readonly<Record<string, unknown>>;
  windowFocused?: boolean;
  webviewVisible?: boolean;
} = {}) {
  const globalState = new MemoryKVStore();
  const workspaceState = new MemoryKVStore();
  const settings = new MemorySettingsStore(opts.initialSettings);
  const secrets = new MemorySecretStore();
  const posted: HostToWebview[] = [];
  const statusUpdates: StatusBarSnapshot[] = [];
  const shownMessages: { level: string; message: string; actions?: readonly string[] }[] = [];

  for (const [k, v] of Object.entries(opts.initialGlobalState ?? {})) {
    void globalState.update(k, v);
  }
  for (const [k, v] of Object.entries(opts.initialWorkspaceState ?? {})) {
    void workspaceState.update(k, v);
  }

  let webviewVisible = opts.webviewVisible ?? true;
  let windowFocused = opts.windowFocused ?? true;

  const platform: HostPlatform = {
    hostKind: 'vscode',
    extensionVersion: '0.3.1',
    storageRoot: '/tmp/harness-deck-test',
    globalState,
    workspaceState,
    settings,
    secrets,
    workbench: noWorkbench,
    envLanguage: () => 'zh-cn',
    isWorkspaceTrusted: () => true,
    onDidGrantWorkspaceTrust: () => () => undefined,
    isWindowFocused: () => windowFocused,
    workspaceFolders: () => [{ path: '/repo/alpha', name: 'alpha' }],
    postToWebview: (message) => {
      posted.push(message);
    },
    isWebviewVisible: () => webviewVisible,
    focusChatView: async () => undefined,
    openWorkbenchPanel: () => undefined,
    log: () => undefined,
    runtimeLog: () => undefined,
    showLogs: () => undefined,
    openHostSettings: () => undefined,
    onStatusUpdate: (state) => {
      statusUpdates.push(state);
    },
    openExternal: async () => true,
    resolveExternalOrigin: async (origin) => origin,
    writeClipboard: async () => undefined,
    showMessage: async (level, message, actions) => {
      shownMessages.push({ level, message, actions });
      return undefined;
    },
    pickQuickItem: async <T extends QuickPickOption>(_items: readonly T[]) => undefined,
    withCancellableProgress: async (_title, task) => task(() => undefined),
    pickOpenDialog: async () => [],
    openProjectWindow: async () => undefined,
    runInTerminal: async () => undefined,
  };

  return {
    platform,
    globalState,
    workspaceState,
    settings,
    posted,
    statusUpdates,
    shownMessages,
    setWebviewVisible: (next: boolean) => {
      webviewVisible = next;
    },
    setWindowFocused: (next: boolean) => {
      windowFocused = next;
    },
  };
}

function createFakeBackendFactory() {
  const created: FakeBackendInstance[] = [];
  const byId = new Map<string, FakeBackendInstance[]>();

  const createBackend = (profile: BackendProfile, host: BackendHost): RunningBackend => {
    let currentSnapshot = makeSnapshot(profile.id);
    const instance: FakeBackendInstance = {
      profile,
      host,
      status: { kind: 'idle' },
      running: false,
      startCount: 0,
      restartCount: 0,
      stopCount: 0,
      disposeCount: 0,
      switchedSessions: [],
      workspacePaths: [],
      emitSnapshot: (patch) => {
        currentSnapshot = {
          ...currentSnapshot,
          ...patch,
          backends: host.controllerOptions().backends?.() ?? currentSnapshot.backends,
        };
      },
      postDirect: (msg) => {
        host.controllerOptions().post(msg);
      },
      observe: (obs) => {
        instance.running = obs.running;
        currentSnapshot = {
          ...currentSnapshot,
          session: {
            ...currentSnapshot.session,
            id: obs.sessionId ?? currentSnapshot.session.id,
            title: obs.title,
            running: obs.running,
          },
          backends: host.controllerOptions().backends?.() ?? currentSnapshot.backends,
        };
        host.controllerOptions().onSessionObserve?.({
          sessionId: obs.sessionId,
          title: obs.title,
          running: obs.running,
          sync: obs.sync ?? 'live',
          interactionIds: obs.interactionIds ?? [],
          hasTurnOutput: obs.hasTurnOutput,
        });
      },
      backend: {
        profile,
        controller: {} as ChatBackendController,
        start: () => {
          instance.startCount += 1;
          instance.status = { kind: 'connected', version: '1.0.0', newerThanTested: false };
          host.onStatus(instance.status);
        },
        restart: () => {
          instance.restartCount += 1;
          instance.status = { kind: 'connected', version: '1.0.0', newerThanTested: false };
          host.onStatus(instance.status);
        },
        currentStatus: () => instance.status,
        stop: async () => {
          instance.stopCount += 1;
          instance.status = { kind: 'idle' };
          controller.dispose();
        },
      },
    };

    const controller: ChatBackendController = {
      handle: async (message) => {
        if (message.type === 'switchSession') {
          instance.switchedSessions.push(message.payload.sessionId);
        }
      },
      snapshot: () => ({
        ...currentSnapshot,
        backends: host.controllerOptions().backends?.() ?? currentSnapshot.backends,
      }),
      peekSnapshot: () => ({
        ...currentSnapshot,
        backends: host.controllerOptions().backends?.() ?? currentSnapshot.backends,
      }),
      modelState: () => currentSnapshot.models,
      askAboutSelection: async () => undefined,
      pinActiveEditor: () => undefined,
      workspaceChanged: () => undefined,
      localeChanged: () => undefined,
      appearanceChanged: () => undefined,
      preferencesChanged: () => undefined,
      backendsChanged: () => {
        const next = host.controllerOptions().backends?.();
        if (next) {
          host.controllerOptions().post({ type: 'backends', payload: next });
        }
      },
      providersChanged: () => undefined,
      projectsChanged: () => undefined,
      extensionsChanged: () => undefined,
      setWorkspace: (path) => {
        instance.workspacePaths.push(path);
      },
      renameSession: async () => undefined,
      configureApiKey: async () => undefined,
      setRuntimeStatus: (status) => {
        instance.status = status;
      },
      dispose: () => {
        instance.disposeCount += 1;
      },
    };

    (instance.backend as { controller: ChatBackendController }).controller = controller;
    created.push(instance);
    const list = byId.get(profile.id) ?? [];
    list.push(instance);
    byId.set(profile.id, list);
    return instance.backend;
  };

  return { createBackend, created, byId };
}

async function flushAsync(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('HarnessHostRuntime 多智能体常驻保活与默认启动持久化', () => {
  const runtimes: HarnessHostRuntime[] = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      const rt = runtimes.pop();
      if (rt) await rt.dispose();
    }
  });

  it('启动时默认启动设置中的 defaultBackend，未配置时回退到已保存的默认智能体', async () => {
    const { platform: p1 } = createFakePlatform({
      initialSettings: { defaultBackend: 'claude' },
      initialGlobalState: { 'harnessDeck.backend': 'zcode' },
    });
    const f1 = createFakeBackendFactory();
    const rt1 = createHarnessHostRuntime(p1, { createBackend: f1.createBackend });
    runtimes.push(rt1);
    await flushAsync();

    expect(f1.created.map((b) => b.profile.id)).toEqual(['claude']);
    expect(f1.created[0]?.startCount).toBe(1);

    const backends1 = f1.created[0]?.host.controllerOptions().backends?.();
    expect(backends1?.active).toBe('claude');
    expect(backends1?.defaultBackend).toBe('claude');

    const { platform: p2 } = createFakePlatform({
      initialGlobalState: { 'harnessDeck.backend': 'zcode' },
    });
    const f2 = createFakeBackendFactory();
    const rt2 = createHarnessHostRuntime(p2, { createBackend: f2.createBackend });
    runtimes.push(rt2);
    await flushAsync();

    expect(f2.created.map((b) => b.profile.id)).toEqual(['zcode']);
    const backends2 = f2.created[0]?.host.controllerOptions().backends?.();
    expect(backends2?.active).toBe('zcode');
    expect(backends2?.defaultBackend).toBe('zcode');
  });

  it('切换智能体时保留已有进程不停止、切回直接复用，且后台任务状态不污染前台并持续上报 WorkbenchHub', async () => {
    const env = createFakePlatform({
      initialSettings: { defaultBackend: 'dsh' },
    });
    const factory = createFakeBackendFactory();
    const runtime = createHarnessHostRuntime(env.platform, { createBackend: factory.createBackend });
    runtimes.push(runtime);
    await flushAsync();

    const dsh = factory.byId.get('dsh')?.[0];
    expect(dsh).toBeDefined();
    expect(dsh?.startCount).toBe(1);

    // 模拟 dsh 正在运行一个会话
    dsh?.observe({ sessionId: 'dsh-s1', title: 'DSH 重构任务', running: true, hasTurnOutput: true });
    await flushAsync();

    // 在设置中切换并选中 claude：不仅启动 claude，同时把默认智能体持久化为 claude
    runtime.handleWebviewMessage({ type: 'selectBackend', payload: { id: 'claude' } });
    await flushAsync();

    expect(dsh?.stopCount).toBe(0);
    expect(dsh?.disposeCount).toBe(0);
    const claude = factory.byId.get('claude')?.[0];
    expect(claude).toBeDefined();
    expect(claude?.startCount).toBe(1);
    expect(factory.created).toHaveLength(2);

    // 设置持久化为 claude
    expect(env.settings.get('defaultBackend', '')).toBe('claude');
    expect(env.globalState.get('harnessDeck.backend')).toBe('claude');
    expect(env.workspaceState.get('harnessDeck.backend')).toBe('claude');

    // BackendsState 反映 dsh 处于 alive + running（后台保活且执行中），claude 为 active + defaultBackend
    const latestBackendsMsg = [...env.posted].reverse().find((m) => m.type === 'backends');
    expect(latestBackendsMsg?.type).toBe('backends');
    if (latestBackendsMsg?.type === 'backends') {
      expect(latestBackendsMsg.payload.active).toBe('claude');
      expect(latestBackendsMsg.payload.defaultBackend).toBe('claude');
      const dshView = latestBackendsMsg.payload.items.find((i) => i.id === 'dsh');
      const claudeView = latestBackendsMsg.payload.items.find((i) => i.id === 'claude');
      expect(dshView?.alive).toBe(true);
      expect(dshView?.running).toBe(true);
      expect(claudeView?.alive).toBe(true);
      expect(Boolean(claudeView?.running)).toBe(false);
    }

    // 后台中的 dsh 直接发出的对话流消息不应推给前台 Webview；Workbench 状态仍会同步更新
    const postedBeforeBg = env.posted.length;
    dsh?.postDirect({
      type: 'items',
      payload: { sessionKey: 'dsh-s1', reset: false, order: [], upsert: [] },
    });
    const postedSlice = env.posted.slice(postedBeforeBg);
    expect(postedSlice.some((m) => m.type === 'items')).toBe(false);

    // 后台中的 dsh 更新运行态并完成任务，Workbench 总览仍能收到它并更新 running=false
    dsh?.observe({ sessionId: 'dsh-s1', title: 'DSH 重构任务', running: false, hasTurnOutput: true });
    await flushAsync();
    const latestWorkbench = [...env.posted].reverse().find((m) => m.type === 'workbench');
    expect(latestWorkbench?.type).toBe('workbench');
    if (latestWorkbench?.type === 'workbench') {
      expect(latestWorkbench.payload.overview.running.some((r) => r.sessionId === 'dsh-s1' || r.id === 'run-sess:dsh:dsh-s1')).toBe(false);
    }

    // 通过工作台会话切换回 dsh（临时跳转），不会重建 dsh，也不会覆盖默认启动智能体 claude
    runtime.handleWebviewMessage({
      type: 'openProjectSession',
      payload: { projectPath: '/repo/alpha', backendId: 'dsh', sessionId: 'dsh-s1' },
    });
    await flushAsync();

    expect(factory.byId.get('dsh')).toHaveLength(1);
    expect(dsh?.startCount).toBe(1);
    expect(dsh?.stopCount).toBe(0);
    expect(claude?.stopCount).toBe(0);
    expect(dsh?.switchedSessions).toContain('dsh-s1');
    expect(env.settings.get('defaultBackend', '')).toBe('claude');
    expect(env.globalState.get('harnessDeck.backend')).toBe('claude');

    const backendsAfterJump = dsh?.host.controllerOptions().backends?.();
    expect(backendsAfterJump?.active).toBe('dsh');
    expect(backendsAfterJump?.defaultBackend).toBe('claude');

    // 销毁运行时会统一停止所有保活中的后端实例
    await runtime.dispose();
    expect(dsh?.stopCount).toBe(1);
    expect(claude?.stopCount).toBe(1);
  });
});

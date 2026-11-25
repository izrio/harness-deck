/**
 * Webview 端的状态：Host 推送的快照和增量合并在这里。
 * Host 是唯一的状态来源，这里只做缓存和按 id 的增量合并。
 */
import { useSyncExternalStore } from 'react';
import { loadState, postToHost, saveState } from './vscode.ts';
import type {
  AccountsState,
  AppearanceState,
  BrowserConsoleProperty,
  BrowserDomElement,
  BrowserState,
  ClientSurface,
  CommandView,
  DiffContentData,
  DiffRef,
  ConnectionState,
  ContextState,
  ExtensionsState,
  FileCandidate,
  HostIdeKind,
  Locale,
  HostToWebview,
  Item,
  MarkdownPreviewData,
  ModelState,
  PendingInteraction,
  PermissionState,
  PreferencesState,
  ProjectsState,
  PromptImage,
  ProviderModelItem,
  ProvidersState,
  QuotaView,
  RemoteScope,
  RemoteState,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  BackendsState,
  TabsState,
  TerminalState,
  WorkbenchModule,
  WorkbenchState,
  WorkspaceState,
} from '@harness-deck/shared';

export type SettingsTab =
  | 'appearance'
  | 'notifications'
  | 'remote'
  | 'agents'
  | 'accounts'
  | 'providers'
  | 'skills'
  | 'mcp'
  | 'session'
  | 'commands'
  | 'projects'
  | 'other';

export type RightPanelTab = 'files' | 'git' | 'terminal' | 'browser';

export interface BrowserFrameEvent {
  readonly data: string;
  readonly format?: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
  readonly timestamp: number;
}

export interface BrowserInspectEvent {
  readonly mode: 'hover' | 'select';
  readonly element?: BrowserDomElement;
}

export interface BrowserNetworkBodyEvent {
  readonly requestId: string;
  readonly body?: string;
  readonly base64Encoded?: boolean;
  readonly error?: string;
}

export interface BrowserConsoleObjectEvent {
  readonly requestId: string;
  readonly objectId: string;
  readonly properties?: readonly BrowserConsoleProperty[];
  readonly error?: string;
}

export interface BrowserConsoleCompletionsEvent {
  readonly requestId: string;
  readonly prefix: string;
  readonly items: readonly string[];
}

export interface QuotaFetchResult {
  readonly requestId: number;
  readonly quota?: QuotaView;
  readonly error?: string;
}

const MAX_QUOTA_RESULTS = 16;

export interface Toast {
  readonly id: number;
  readonly level: 'info' | 'error';
  readonly text: string;
}

export interface ViewState {
  readonly hostKind: HostIdeKind;
  readonly clientSurface: ClientSurface;
  readonly clientScope: RemoteScope;
  readonly ready: boolean;
  readonly runtime: RuntimeStatus;
  readonly connection: ConnectionState;
  readonly sessions: readonly SessionListItem[];
  readonly tabs: TabsState;
  /** 可选的底层和当前底层。 */
  readonly backends: BackendsState;
  /** 第三方编程套餐与自定义模型服务商及智能体绑定。 */
  readonly providers: ProvidersState;
  /** 各智能体官方渠道多账号管理与渠道路由状态。 */
  readonly accounts: AccountsState;
  /** 技能（SKILL.md）与统一 MCP 服务器状态。 */
  readonly extensions: ExtensionsState;
  /** 最近一次「从接口获取模型」的结果。 */
  readonly providerFetchResult?: {
    readonly requestId: number;
    readonly models: readonly ProviderModelItem[];
    readonly error?: string;
  };
  /** 最近一次官方订阅额度查询结果；`quota` 缺失表示不可用。 */
  readonly quotaFetchResult?: QuotaFetchResult;
  /** 按 requestId 索引的近期订阅额度查询结果，防止并发或乱序回包互相覆盖。 */
  readonly quotaFetchResults: Readonly<Record<number, QuotaFetchResult>>;
  readonly session: SessionHeader;
  readonly sessionKey: string;
  readonly items: readonly Item[];
  readonly models: ModelState;
  /** 当前会话等待处理的审批和提问。 */
  readonly interactions: readonly PendingInteraction[];
  readonly permissions: PermissionState;
  readonly workspace: WorkspaceState;
  readonly context: ContextState;
  readonly locale: Locale;
  readonly commands: readonly CommandView[];
  /** 最近一次 `@` 补全的结果。 */
  readonly fileCandidates: { readonly requestId: number; readonly items: readonly FileCandidate[] };
  /** 右侧面板「文件」标签页的工作区文件列表与加载态。 */
  readonly panelFiles: { readonly requestId: number; readonly items: readonly FileCandidate[]; readonly loading: boolean };
  readonly toasts: readonly Toast[];
  /**
   * 把一段文字放进输入框；`n` 每次递增，输入框据此更新。
   * replace：「编辑后重发」和示例任务，换掉输入框里的内容；restore：消息没发出去，放回原文，输入框里已经新写的内容保留在后面。
   */
  readonly prefill: { readonly text: string; readonly n: number; readonly mode: 'replace' | 'restore' };
  /** Host 通过文件选择器传入的图片列表；`n` 每次递增，输入框据此追加。 */
  readonly pendingImages: { readonly images: readonly PromptImage[]; readonly n: number };
  /** Host 通过文件选择器传入的新建任务附件路径；`n` 每次递增，新建任务弹窗据此追加 `@path`。 */
  readonly pendingTaskFiles: { readonly paths: readonly string[]; readonly n: number };
  /** 按运行时缓存的模型与权限目录（新建任务切换运行时时动态拉取并缓存）。 */
  readonly backendModelsCache: Readonly<
    Record<
      string,
      {
        readonly requestId: number;
        readonly models: ModelState;
        readonly permissions?: PermissionState;
      }
    >
  >;
  /** Host 要求聚焦输入框的次数，组件据此触发聚焦。 */
  readonly focusRequests: number;
  readonly appearance: AppearanceState;
  readonly preferences: PreferencesState;
  readonly projects: ProjectsState;
  readonly workbench: WorkbenchState;
  readonly activeModule: WorkbenchModule;
  readonly moduleExplicit: boolean;
  readonly pendingCreateTask: boolean;
  readonly inspectScheduleRuleId?: string;
  readonly rightPanelOpen: boolean;
  readonly rightPanelTab: RightPanelTab;
  readonly rightPanelWidth?: number;
  readonly rightPanelExplicit: boolean;
  readonly settingsOpen: boolean;
  readonly settingsTab: SettingsTab;
  readonly markdownPreview?: MarkdownPreviewData & { readonly loading?: boolean };
  readonly diffContent?: DiffContentData;
  readonly remote?: RemoteState;
  readonly terminal: TerminalState;
  readonly browser: BrowserState;
  readonly fileSavedResult?: { readonly path: string; readonly ok: boolean; readonly error?: string; readonly n: number };
  readonly draftGeneratedResult?: {
    readonly requestId: number;
    readonly kind: 'commit' | 'pr';
    readonly message?: string;
    readonly title?: string;
    readonly body?: string;
    readonly error?: string;
  };
  /** 图片内容缓存：`local:<localId>` 或 attachmentId → data URL；'loading' 读取中，'error' 读不到。 */
  readonly images: Readonly<Record<string, string>>;
  /** 正在打开的 Diff：`key` 是 DiffRef 的 JSON，对应的行显示加载中。 */
  readonly openingDiff?: { readonly token: number; readonly key: string };
}

const emptyWorkbench: WorkbenchState = {
  overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
  schedules: [],
  agents: [],
  tasks: { items: [], autoRun: true },
  sessionGroups: [],
};

function readInitialBackends(): BackendsState {
  if (typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi !== 'function') {
    return { items: [], active: 'dsh' };
  }
  try {
    const saved = loadState().activeBackend;
    if (saved?.id && saved.name) {
      return {
        items: [{ id: saved.id, name: saved.name, kind: saved.kind ?? 'acp' }],
        active: saved.id,
      };
    }
  } catch {
    // ignore
  }
  return { items: [], active: 'dsh' };
}

function persistActiveBackend(backends: BackendsState | undefined): void {
  if (!backends) return;
  const current = backends.items.find((b) => b.id === backends.active);
  if (!current) return;
  try {
    saveState({ activeBackend: { id: current.id, name: current.name, kind: current.kind } });
  } catch {
    // 测试环境中 acquireVsCodeApi 未必已就绪，忽略本地持久化异常
  }
}

function readInitialHostKind(): HostIdeKind {
  return (globalThis as { __HARNESS_DECK_HOST__?: unknown }).__HARNESS_DECK_HOST__ === 'jetbrains' ? 'jetbrains' : 'vscode';
}

function readInitialClientSurface(): ClientSurface {
  return (globalThis as { __HARNESS_DECK_CLIENT_SURFACE__?: unknown }).__HARNESS_DECK_CLIENT_SURFACE__ === 'mobile-web'
    ? 'mobile-web'
    : 'ide';
}

const emptyBrowser: BrowserState = {
  status: 'stopped',
  url: 'about:blank',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  viewportWidth: 1024,
  viewportHeight: 720,
  viewportPreset: 'responsive',
  aiEnabled: true,
  consoleLogs: [],
};

const initialState: ViewState = {
  hostKind: readInitialHostKind(),
  clientSurface: readInitialClientSurface(),
  clientScope: 'operate',
  ready: false,
  runtime: { kind: 'idle' },
  connection: 'idle',
  sessions: [],
  tabs: { items: [], active: '' },
  backends: readInitialBackends(),
  providers: { items: [], protocolGatewayEnabled: false },
  accounts: { items: [], channels: {} },
  extensions: { skills: { items: [] }, mcp: { servers: [] } },
  quotaFetchResults: {},
  session: { title: '', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
  sessionKey: '',
  items: [],
  models: { options: [] },
  interactions: [],
  permissions: { options: [] },
  workspace: { dirtyFiles: 0 },
  context: { includeActiveByDefault: true, pinned: [] },
  locale: 'zh',
  commands: [],
  fileCandidates: { requestId: -1, items: [] },
  panelFiles: { requestId: -1, items: [], loading: false },
  toasts: [],
  prefill: { text: '', n: 0, mode: 'replace' },
  pendingImages: { images: [], n: 0 },
  pendingTaskFiles: { paths: [], n: 0 },
  backendModelsCache: {},
  focusRequests: 0,
  appearance: {},
  preferences: {
    language: 'auto',
    includeActiveEditor: true,
    showTurnChanges: false,
    fetchQuota: true,
    schedulePermission: 'danger-full-access',
    notifications: {
      enabled: true,
      onlyWhenUnfocused: true,
      onAttention: true,
      onTurnComplete: true,
      onUnexpectedExit: true,
      onScheduledComplete: true,
    },
    advanced: {
      dshPath: '',
      dshProfile: 'web',
      backendTrace: false,
    },
    chatCommands: [],
  },
  projects: { recent: [], configs: {} },
  workbench: emptyWorkbench,
  activeModule: 'sessions',
  moduleExplicit: false,
  pendingCreateTask: false,
  rightPanelOpen: false,
  rightPanelTab: 'files',
  rightPanelExplicit: false,
  settingsOpen: false,
  settingsTab: 'appearance',
  terminal: { sessions: [] },
  browser: emptyBrowser,
  images: {},
};

let state: ViewState = initialState;
const listeners = new Set<() => void>();
const terminalOutputListeners = new Set<(event: { readonly id: string; readonly data: string; readonly reset?: boolean }) => void>();
const terminalBuffers = new Map<string, string>();
const MAX_LOCAL_TERM_BUF = 128 * 1024;

export function subscribeTerminalOutput(
  listener: (event: { readonly id: string; readonly data: string; readonly reset?: boolean }) => void,
): () => void {
  terminalOutputListeners.add(listener);
  return () => terminalOutputListeners.delete(listener);
}

export function getTerminalBuffer(id: string): string {
  return terminalBuffers.get(id) ?? '';
}

const browserFrameListeners = new Set<(frame: BrowserFrameEvent) => void>();
let lastBrowserFrame: BrowserFrameEvent | undefined;
const browserInspectListeners = new Set<(event: BrowserInspectEvent) => void>();
const browserNetworkBodyListeners = new Set<(event: BrowserNetworkBodyEvent) => void>();
const browserClipboardListeners = new Set<(text: string) => void>();
const browserConsoleObjectListeners = new Set<(event: BrowserConsoleObjectEvent) => void>();
const browserConsoleCompletionsListeners = new Set<(event: BrowserConsoleCompletionsEvent) => void>();

export function subscribeBrowserFrame(listener: (frame: BrowserFrameEvent) => void): () => void {
  browserFrameListeners.add(listener);
  return () => browserFrameListeners.delete(listener);
}

export function getLastBrowserFrame(): BrowserFrameEvent | undefined {
  return lastBrowserFrame;
}

export function subscribeBrowserInspect(listener: (event: BrowserInspectEvent) => void): () => void {
  browserInspectListeners.add(listener);
  return () => browserInspectListeners.delete(listener);
}

export function subscribeBrowserNetworkBody(listener: (event: BrowserNetworkBodyEvent) => void): () => void {
  browserNetworkBodyListeners.add(listener);
  return () => browserNetworkBodyListeners.delete(listener);
}

export function subscribeBrowserClipboard(listener: (text: string) => void): () => void {
  browserClipboardListeners.add(listener);
  return () => browserClipboardListeners.delete(listener);
}

export function subscribeBrowserConsoleObject(listener: (event: BrowserConsoleObjectEvent) => void): () => void {
  browserConsoleObjectListeners.add(listener);
  return () => browserConsoleObjectListeners.delete(listener);
}

export function subscribeBrowserConsoleCompletions(
  listener: (event: BrowserConsoleCompletionsEvent) => void,
): () => void {
  browserConsoleCompletionsListeners.add(listener);
  return () => browserConsoleCompletionsListeners.delete(listener);
}
let toastId = 0;
let nextPanelSearchId = 1_000_000;
const pendingPanelSearchIds = new Set<number>();

function set(next: Partial<ViewState>): void {
  // 读屏按 <html lang> 选发音：界面语言变了要跟着改
  if (next.locale && next.locale !== state.locale && typeof document !== 'undefined') document.documentElement.lang = next.locale === 'zh' ? 'zh-CN' : 'en';
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getState(): ViewState {
  return state;
}

export function useView<T>(selector: (state: ViewState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state),
  );
}

/** 字体设置先在本地生效，Host 写完设置后会再推送一次。 */
export function setAppearanceLocal(appearance: ViewState['appearance']): void {
  set({ appearance });
}

/** 通用偏好先在本地生效，Host 写完设置后会再推送一次。 */
export function setPreferencesLocal(preferences: PreferencesState): void {
  set({ preferences });
}

export function setProjectsLocal(projects: ProjectsState): void {
  set({ projects });
}

/** 本地协议转换网关开关先在本地生效，Host 写完设置并启停网关后会推送完整 ProvidersState。 */
export function setProtocolGatewayLocal(enabled: boolean): void {
  set({
    providers: {
      ...state.providers,
      protocolGatewayEnabled: enabled,
      ...(enabled ? {} : { protocolGatewayOrigin: undefined }),
    },
  });
}

export function setExtensionsLocal(extensions: ExtensionsState): void {
  set({ extensions });
}

export function setActiveModule(activeModule: WorkbenchModule, inspectScheduleRuleId?: string): void {
  if (activeModule === 'changes') {
    setRightPanelOpen(true, 'git');
    return;
  }
  const resolved: WorkbenchModule = activeModule === 'schedules' ? 'tasks' : activeModule;
  set({
    activeModule: resolved,
    moduleExplicit: true,
    pendingCreateTask: false,
    settingsOpen: false,
    markdownPreview: undefined,
    diffContent: undefined,
    inspectScheduleRuleId,
  });
  try {
    saveState({ activeModule: resolved });
  } catch {
    // 测试环境中 acquireVsCodeApi 未必已就绪，忽略本地持久化异常
  }
}

export function requestCreateTask(): void {
  set({
    activeModule: 'tasks',
    moduleExplicit: true,
    pendingCreateTask: true,
    settingsOpen: false,
    markdownPreview: undefined,
    diffContent: undefined,
  });
  try {
    saveState({ activeModule: 'tasks' });
  } catch {
    // ignore in test env
  }
}

export function consumePendingCreateTask(): void {
  if (state.pendingCreateTask) {
    set({ pendingCreateTask: false });
  }
}

export function setRightPanelOpen(open: boolean, tab?: RightPanelTab): void {
  const nextTab = tab ?? state.rightPanelTab;
  set({
    rightPanelOpen: open,
    rightPanelTab: nextTab,
    rightPanelExplicit: true,
    ...(open ? { settingsOpen: false } : {}),
  });
  try {
    saveState({ rightPanelOpen: open, rightPanelTab: nextTab });
  } catch {
    // ignore in test env
  }
}

export function toggleRightPanel(): void {
  setRightPanelOpen(!state.rightPanelOpen);
}

export function setRightPanelTab(tab: RightPanelTab): void {
  set({ rightPanelTab: tab, rightPanelOpen: true, rightPanelExplicit: true });
  try {
    saveState({ rightPanelOpen: true, rightPanelTab: tab });
  } catch {
    // ignore in test env
  }
}

export function setRightPanelWidth(width: number | undefined): void {
  const normalized = width !== undefined && Number.isFinite(width) ? Math.round(width) : undefined;
  set({ rightPanelWidth: normalized });
  try {
    saveState({ rightPanelWidth: normalized });
  } catch {
    // ignore in test env
  }
}

export function requestPanelFiles(query: string): void {
  const requestId = ++nextPanelSearchId;
  pendingPanelSearchIds.add(requestId);
  set({ panelFiles: { ...state.panelFiles, loading: true } });
  postToHost({ type: 'searchFiles', payload: { requestId, query } });
}

function normalizeSettingsTab(tab: SettingsTab | 'interface' | 'extensions'): SettingsTab {
  if (tab === 'interface') return 'appearance';
  if (tab === 'extensions') return 'skills';
  return tab;
}

export function openSettingsPage(tab?: SettingsTab | 'interface' | 'extensions'): void {
  set({ settingsOpen: true, markdownPreview: undefined, diffContent: undefined, ...(tab ? { settingsTab: normalizeSettingsTab(tab) } : {}) });
}

export function setSettingsTab(settingsTab: SettingsTab | 'interface' | 'extensions'): void {
  set({ settingsTab: normalizeSettingsTab(settingsTab) });
}

export function closeSettingsPage(): void {
  set({ settingsOpen: false });
}

export function toggleSettingsPage(): void {
  const nextOpen = !state.settingsOpen;
  set({ settingsOpen: nextOpen, ...(nextOpen ? { markdownPreview: undefined, diffContent: undefined } : {}) });
}

export function requestMarkdownPreview(path: string): void {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const title = slash >= 0 ? path.slice(slash + 1) : path;
  set({ markdownPreview: { path, title, loading: true } });
  postToHost({ type: 'previewMarkdown', payload: { path } });
}

export function closeMarkdownPreview(): void {
  set({ markdownPreview: undefined });
}

export function closeDiffContent(): void {
  set({ diffContent: undefined });
}

/** 图片在缓存里的键。 */
export function imageKey(image: { readonly attachmentId?: string; readonly localId?: string }): string | undefined {
  return image.attachmentId ?? (image.localId ? `local:${image.localId}` : undefined);
}

/** 记下本地图片（粘贴或拖进来的），发送中的回显用它显示。 */
export function registerLocalImage(localId: string, dataUrl: string): void {
  set({ images: { ...state.images, [`local:${localId}`]: dataUrl } });
}

/** 向 Host 读取 dsh 保存的图片；已经在读或读过时不重复请求。 */
export function requestImage(attachmentId: string): void {
  if (state.images[attachmentId] !== undefined) return;
  set({ images: { ...state.images, [attachmentId]: 'loading' } });
  postToHost({ type: 'loadImage', payload: { attachmentId } });
}

/** Webview 自己发出的提示（例如粘贴的图片不能用）。 */
export function showToast(level: 'info' | 'error', text: string): void {
  applyHostMessage({ type: 'toast', payload: { level, text } });
}

let diffToken = 0;
/** 超过这个时间 Host 还没回复，就不再显示加载中（Host 那边仍会打开）。 */
const DIFF_SPINNER_LIMIT_MS = 20_000;

/** 打开 Diff：对应的行显示加载中，直到 Host 打开（或放弃）。 */
export function openDiff(ref: DiffRef, post: (token: number) => void): void {
  const token = ++diffToken;
  set({ openingDiff: { token, key: diffKey(ref) } });
  post(token);
  setTimeout(() => {
    if (state.openingDiff?.token === token) set({ openingDiff: undefined });
  }, DIFF_SPINNER_LIMIT_MS);
}

export function diffKey(ref: DiffRef): string {
  return JSON.stringify(ref);
}

export function requestPrefill(text: string, mode: 'replace' | 'restore' = 'replace'): void {
  set({ prefill: { text, n: state.prefill.n + 1, mode } });
}

export function dismissToast(id: number): void {
  set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
}

/** 应用一条 Host 消息。 */
export function applyHostMessage(message: HostToWebview): void {
  switch (message.type) {
    case 'snapshot': {
      const p = message.payload;
      let resolvedModule = state.activeModule;
      let resolvedRightPanelOpen = state.rightPanelOpen;
      let resolvedRightPanelTab = state.rightPanelTab;
      let resolvedRightPanelWidth = state.rightPanelWidth;
      if (!state.moduleExplicit) {
        let savedMod: WorkbenchModule | undefined;
        try {
          savedMod = loadState().activeModule;
        } catch {
          savedMod = undefined;
        }
        if (savedMod === 'changes') {
          resolvedModule = p.workbench !== undefined ? 'overview' : 'sessions';
          if (!state.rightPanelExplicit) {
            resolvedRightPanelOpen = true;
            resolvedRightPanelTab = 'git';
          }
        } else if (savedMod === 'schedules') {
          resolvedModule = 'tasks';
        } else {
          resolvedModule = savedMod ?? (p.workbench !== undefined ? 'overview' : 'sessions');
        }
      }
      if (!state.rightPanelExplicit) {
        try {
          const persisted = loadState();
          if (persisted.rightPanelOpen !== undefined) resolvedRightPanelOpen = persisted.rightPanelOpen;
          if (persisted.rightPanelTab !== undefined) resolvedRightPanelTab = persisted.rightPanelTab;
          if (typeof persisted.rightPanelWidth === 'number' && Number.isFinite(persisted.rightPanelWidth)) {
            resolvedRightPanelWidth = persisted.rightPanelWidth;
          }
        } catch {
          // ignore
        }
      }
      const resolvedBackends = p.backends ?? state.backends;
      persistActiveBackend(p.backends);
      set({
        ...(p.hostKind ? { hostKind: p.hostKind } : {}),
        ...(p.clientSurface ? { clientSurface: p.clientSurface } : {}),
        ...(p.clientScope ? { clientScope: p.clientScope } : {}),
        ready: true,
        runtime: p.runtime,
        connection: p.connection,
        sessions: p.sessions,
        tabs: p.tabs ?? { items: [], active: '' },
        backends: resolvedBackends,
        session: p.session,
        sessionKey: p.session.id ?? '',
        items: p.items,
        models: p.models,
        interactions: p.interactions,
        permissions: p.permissions,
        workspace: p.workspace,
        context: p.context,
        locale: p.locale,
        commands: p.commands,
        appearance: p.appearance ?? {},
        activeModule: resolvedModule,
        rightPanelOpen: resolvedRightPanelOpen,
        rightPanelTab: resolvedRightPanelTab,
        ...(resolvedRightPanelWidth !== undefined ? { rightPanelWidth: resolvedRightPanelWidth } : {}),
        ...(p.preferences ? { preferences: p.preferences } : {}),
        ...(p.providers ? { providers: p.providers } : {}),
        ...(p.accounts ? { accounts: p.accounts } : {}),
        ...(p.extensions ? { extensions: p.extensions } : {}),
        ...(p.projects ? { projects: p.projects } : {}),
        ...(p.workbench ? { workbench: p.workbench } : {}),
        ...(p.remote !== undefined ? { remote: p.remote } : {}),
        ...(p.terminal ? { terminal: p.terminal } : {}),
        ...(p.browser ? { browser: p.browser } : {}),
      });
      return;
    }
    case 'runtimeStatus':
      set({ runtime: message.payload });
      return;
    case 'connection':
      set({ connection: message.payload });
      return;
    case 'sessions':
      set({ sessions: message.payload });
      return;
    case 'tabs':
      set({ tabs: message.payload });
      return;
    case 'backends':
      persistActiveBackend(message.payload);
      set({ backends: message.payload });
      return;
    case 'providers':
      set({ providers: message.payload });
      return;
    case 'accounts':
      set({ accounts: message.payload });
      return;
    case 'accountLoginProgress':
      set({
        accounts: {
          ...state.accounts,
          ...(message.payload ? { loginProgress: message.payload } : { loginProgress: undefined }),
        },
      });
      return;
    case 'extensions':
      set({ extensions: message.payload });
      return;
    case 'providerModelsFetched':
      set({ providerFetchResult: message.payload });
      return;
    case 'quotaFetched': {
      const payload = message.payload;
      const nextMap: Record<number, QuotaFetchResult> = {
        ...state.quotaFetchResults,
        [payload.requestId]: payload,
      };
      const keys = Object.keys(nextMap);
      if (keys.length > MAX_QUOTA_RESULTS) {
        const sorted = keys.map(Number).sort((a, b) => a - b);
        for (const oldKey of sorted.slice(0, sorted.length - MAX_QUOTA_RESULTS)) {
          delete nextMap[oldKey];
        }
      }
      const nextLatest =
        !state.quotaFetchResult || payload.requestId >= state.quotaFetchResult.requestId
          ? payload
          : state.quotaFetchResult;
      set({ quotaFetchResult: nextLatest, quotaFetchResults: nextMap });
      return;
    }
    case 'session':
      set({ session: message.payload });
      return;
    case 'models':
      set({ models: message.payload });
      return;
    case 'interactions':
      set({ interactions: message.payload });
      return;
    case 'permissions':
      set({ permissions: message.payload });
      return;
    case 'workspace':
      set({ workspace: message.payload });
      return;
    case 'context':
      set({ context: message.payload });
      return;
    case 'locale':
      set({ locale: message.payload });
      return;
    case 'appearance':
      set({ appearance: message.payload });
      return;
    case 'preferences':
      set({ preferences: message.payload });
      return;
    case 'projects':
      set({ projects: message.payload });
      return;
    case 'workbench':
      set({ workbench: message.payload });
      return;
    case 'switchWorkbenchModule':
      setActiveModule(message.payload.module);
      return;
    case 'markdownPreview':
      if (state.markdownPreview?.path === message.payload.path) {
        set({ markdownPreview: message.payload });
      }
      return;
    case 'diffContent':
      set({ diffContent: message.payload, openingDiff: undefined, settingsOpen: false, markdownPreview: undefined });
      return;
    case 'remote':
      set({ remote: message.payload });
      return;
    case 'navigateToSession':
      set({
        activeModule: 'sessions',
        moduleExplicit: true,
        settingsOpen: false,
        markdownPreview: undefined,
        diffContent: undefined,
      });
      return;
    case 'imageData':
      set({ images: { ...state.images, [message.payload.attachmentId]: message.payload.dataUrl ?? 'error' } });
      return;
    case 'diffOpened':
      if (state.openingDiff?.token === message.payload.token) set({ openingDiff: undefined });
      return;
    case 'commands':
      set({ commands: message.payload });
      return;
    case 'fileCandidates':
      if (pendingPanelSearchIds.has(message.payload.requestId)) {
        pendingPanelSearchIds.delete(message.payload.requestId);
        if (message.payload.requestId >= state.panelFiles.requestId) {
          set({ panelFiles: { requestId: message.payload.requestId, items: message.payload.items, loading: false } });
        }
        return;
      }
      if (message.payload.requestId >= state.fileCandidates.requestId) {
        set({ fileCandidates: message.payload });
      }
      return;
    case 'items': {
      const patch = message.payload;
      if (patch.reset) {
        set({ sessionKey: patch.sessionKey, items: patch.upsert });
        return;
      }
      // 不属于当前会话的增量（切换会话的瞬间）直接丢弃，等下一次 reset
      if (patch.sessionKey !== state.sessionKey) return;
      const byId = new Map(state.items.map((item) => [item.id, item]));
      for (const item of patch.upsert) byId.set(item.id, item);
      set({ items: patch.order.map((id) => byId.get(id)).filter((item): item is Item => item !== undefined) });
      return;
    }
    case 'toast': {
      const toast = { id: ++toastId, ...message.payload };
      set({ toasts: [...state.toasts, toast].slice(-3) });
      // 普通提示自动消失；错误留着，直到用户关掉（最多同时 3 条，新的把旧的顶掉）
      if (message.payload.level !== 'error') setTimeout(() => dismissToast(toast.id), 4_000);
      return;
    }
    case 'focusComposer':
      set({ activeModule: 'sessions', moduleExplicit: true, settingsOpen: false, focusRequests: state.focusRequests + 1 });
      return;
    case 'attachImages': {
      const nextImages = { ...state.images };
      for (const image of message.payload.images) {
        nextImages[`local:${image.localId}`] = `data:${image.mediaType};base64,${image.data}`;
      }
      set({
        images: nextImages,
        pendingImages: { images: message.payload.images, n: state.pendingImages.n + 1 },
      });
      return;
    }
    case 'taskFilesPicked':
      set({
        pendingTaskFiles: { paths: message.payload.paths, n: state.pendingTaskFiles.n + 1 },
      });
      return;
    case 'backendModelsFetched': {
      const { backendId, requestId, models, permissions } = message.payload;
      const prev = state.backendModelsCache[backendId];
      if (prev && requestId < prev.requestId) return;
      set({
        backendModelsCache: {
          ...state.backendModelsCache,
          [backendId]: {
            requestId,
            models,
            ...(permissions ? { permissions } : {}),
          },
        },
      });
      return;
    }
    case 'restoreDraft':
      requestPrefill(message.payload.text, 'restore');
      return;
    case 'fileSaved':
      set({
        fileSavedResult: {
          ...message.payload,
          n: (state.fileSavedResult?.n ?? 0) + 1,
        },
      });
      return;
    case 'sourceControlDraftGenerated':
      set({ draftGeneratedResult: message.payload });
      return;
    case 'terminalState':
      set({ terminal: message.payload });
      return;
    case 'terminalOutput': {
      const { id, data, reset } = message.payload;
      if (reset) {
        terminalBuffers.set(id, data);
      } else {
        const next = (terminalBuffers.get(id) ?? '') + data;
        terminalBuffers.set(id, next.length > MAX_LOCAL_TERM_BUF ? next.slice(next.length - MAX_LOCAL_TERM_BUF) : next);
      }
      for (const listener of terminalOutputListeners) listener(message.payload);
      return;
    }
    case 'browserState':
      set({ browser: message.payload });
      return;
    case 'browserFrame':
      lastBrowserFrame = message.payload;
      for (const listener of browserFrameListeners) listener(message.payload);
      return;
    case 'browserInspectResult':
      for (const listener of browserInspectListeners) listener(message.payload);
      return;
    case 'browserNetworkBody':
      for (const listener of browserNetworkBodyListeners) listener(message.payload);
      return;
    case 'browserClipboardData':
      for (const listener of browserClipboardListeners) listener(message.payload.text);
      return;
    case 'browserConsoleObject':
      for (const listener of browserConsoleObjectListeners) listener(message.payload);
      return;
    case 'browserConsoleCompletions':
      for (const listener of browserConsoleCompletionsListeners) listener(message.payload);
      return;
    case 'sessionCheckpoints':
      if (state.session.id === message.payload.sessionId) {
        set({
          session: {
            ...state.session,
            checkpoints: message.payload.turns,
          },
        });
      }
      return;
  }
}

/** 仅供测试：恢复初始状态。 */
export function resetStoreForTests(): void {
  state = initialState;
  pendingPanelSearchIds.clear();
  terminalBuffers.clear();
  lastBrowserFrame = undefined;
}

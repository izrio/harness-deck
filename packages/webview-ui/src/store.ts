/**
 * Webview 端的状态：Host 推送的快照和增量合并在这里。
 * Host 是唯一的状态来源，这里只做缓存和按 id 的增量合并。
 */
import { useSyncExternalStore } from 'react';
import { loadState, postToHost, saveState } from './vscode.ts';
import type {
  AppearanceState,
  CommandView,
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
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  BackendsState,
  TabsState,
  WorkbenchModule,
  WorkbenchState,
  WorkspaceState,
} from '@harness-deck/shared';

export type SettingsTab =
  | 'appearance'
  | 'notifications'
  | 'agents'
  | 'providers'
  | 'skills'
  | 'mcp'
  | 'session'
  | 'commands'
  | 'projects'
  | 'other';

export interface Toast {
  readonly id: number;
  readonly level: 'info' | 'error';
  readonly text: string;
}

export interface ViewState {
  readonly hostKind: HostIdeKind;
  readonly ready: boolean;
  readonly runtime: RuntimeStatus;
  readonly connection: ConnectionState;
  readonly sessions: readonly SessionListItem[];
  readonly tabs: TabsState;
  /** 可选的底层和当前底层。 */
  readonly backends: BackendsState;
  /** 第三方编程套餐与自定义模型服务商及智能体绑定。 */
  readonly providers: ProvidersState;
  /** 技能（SKILL.md）与统一 MCP 服务器状态。 */
  readonly extensions: ExtensionsState;
  /** 最近一次「从接口获取模型」的结果。 */
  readonly providerFetchResult?: {
    readonly requestId: number;
    readonly models: readonly ProviderModelItem[];
    readonly error?: string;
  };
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
  readonly toasts: readonly Toast[];
  /**
   * 把一段文字放进输入框；`n` 每次递增，输入框据此更新。
   * replace：「编辑后重发」和示例任务，换掉输入框里的内容；restore：消息没发出去，放回原文，输入框里已经新写的内容保留在后面。
   */
  readonly prefill: { readonly text: string; readonly n: number; readonly mode: 'replace' | 'restore' };
  /** Host 通过文件选择器传入的图片列表；`n` 每次递增，输入框据此追加。 */
  readonly pendingImages: { readonly images: readonly PromptImage[]; readonly n: number };
  /** Host 要求聚焦输入框的次数，组件据此触发聚焦。 */
  readonly focusRequests: number;
  readonly appearance: AppearanceState;
  readonly preferences: PreferencesState;
  readonly projects: ProjectsState;
  readonly workbench: WorkbenchState;
  readonly activeModule: WorkbenchModule;
  readonly moduleExplicit: boolean;
  readonly inspectScheduleRuleId?: string;
  readonly historyOpen: boolean;
  readonly settingsOpen: boolean;
  readonly settingsTab: SettingsTab;
  readonly markdownPreview?: MarkdownPreviewData & { readonly loading?: boolean };
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

const initialState: ViewState = {
  hostKind: readInitialHostKind(),
  ready: false,
  runtime: { kind: 'idle' },
  connection: 'idle',
  sessions: [],
  tabs: { items: [], active: '' },
  backends: readInitialBackends(),
  providers: { items: [], protocolGatewayEnabled: false },
  extensions: { skills: { items: [] }, mcp: { servers: [] } },
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
  toasts: [],
  prefill: { text: '', n: 0, mode: 'replace' },
  pendingImages: { images: [], n: 0 },
  focusRequests: 0,
  appearance: {},
  preferences: {
    language: 'auto',
    includeActiveEditor: true,
    showTurnChanges: false,
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
  historyOpen: false,
  settingsOpen: false,
  settingsTab: 'appearance',
  images: {},
};

let state: ViewState = initialState;
const listeners = new Set<() => void>();
let toastId = 0;

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
  set({
    activeModule,
    moduleExplicit: true,
    historyOpen: false,
    settingsOpen: false,
    markdownPreview: undefined,
    inspectScheduleRuleId,
  });
  try {
    saveState({ activeModule });
  } catch {
    // 测试环境中 acquireVsCodeApi 未必已就绪，忽略本地持久化异常
  }
}

function normalizeSettingsTab(tab: SettingsTab | 'interface' | 'extensions'): SettingsTab {
  if (tab === 'interface') return 'appearance';
  if (tab === 'extensions') return 'skills';
  return tab;
}

export function openHistoryPage(): void {
  set({ historyOpen: true, settingsOpen: false, markdownPreview: undefined });
}

export function closeHistoryPage(): void {
  set({ historyOpen: false });
}

export function toggleHistoryPage(): void {
  const nextOpen = !state.historyOpen;
  set({ historyOpen: nextOpen, ...(nextOpen ? { settingsOpen: false, markdownPreview: undefined } : {}) });
}

export function openSettingsPage(tab?: SettingsTab | 'interface' | 'extensions'): void {
  set({ settingsOpen: true, historyOpen: false, markdownPreview: undefined, ...(tab ? { settingsTab: normalizeSettingsTab(tab) } : {}) });
}

export function setSettingsTab(settingsTab: SettingsTab | 'interface' | 'extensions'): void {
  set({ settingsTab: normalizeSettingsTab(settingsTab) });
}

export function closeSettingsPage(): void {
  set({ settingsOpen: false });
}

export function toggleSettingsPage(): void {
  const nextOpen = !state.settingsOpen;
  set({ settingsOpen: nextOpen, ...(nextOpen ? { historyOpen: false, markdownPreview: undefined } : {}) });
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
      if (!state.moduleExplicit) {
        let savedMod: WorkbenchModule | undefined;
        try {
          savedMod = loadState().activeModule;
        } catch {
          savedMod = undefined;
        }
        resolvedModule = savedMod ?? (p.workbench !== undefined ? 'overview' : 'sessions');
      }
      const resolvedBackends = p.backends ?? state.backends;
      persistActiveBackend(p.backends);
      set({
        ...(p.hostKind ? { hostKind: p.hostKind } : {}),
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
        ...(p.preferences ? { preferences: p.preferences } : {}),
        ...(p.providers ? { providers: p.providers } : {}),
        ...(p.extensions ? { extensions: p.extensions } : {}),
        ...(p.projects ? { projects: p.projects } : {}),
        ...(p.workbench ? { workbench: p.workbench } : {}),
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
    case 'extensions':
      set({ extensions: message.payload });
      return;
    case 'providerModelsFetched':
      set({ providerFetchResult: message.payload });
      return;
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
    case 'navigateToSession':
      set({ activeModule: 'sessions', moduleExplicit: true, historyOpen: false, settingsOpen: false, markdownPreview: undefined });
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
      set({ activeModule: 'sessions', moduleExplicit: true, historyOpen: false, settingsOpen: false, focusRequests: state.focusRequests + 1 });
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
    case 'restoreDraft':
      requestPrefill(message.payload.text, 'restore');
      return;
  }
}

/** 仅供测试：恢复初始状态。 */
export function resetStoreForTests(): void {
  state = initialState;
}

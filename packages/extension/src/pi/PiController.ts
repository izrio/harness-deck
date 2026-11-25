/**
 * Pi Coding Agent 原生控制器（`pi --mode rpc`）：
 * 基于 `pi --mode rpc` NDJSON 双向协议实现完整的 `ChatBackendController` 接口：
 * - 支持 `prompt`、`steer`（运行中插队）、`abort`、`new_session`、`switch_session`、`set_session_name`；
 * - 支持 `get_available_models`、`set_model`、`set_thinking_level`、`get_commands`、`get_messages`；
 * - 支持 `extension_ui_request`（`confirm` -> 审批卡片，`select`/`input`/`editor` -> 提问卡片，`notify` -> Toast）；
 * - 支持多标签页、历史 `.jsonl` 会话扫描与切换、文件改动统计与 Diff、以及工作台无人值守/编程式会话启动。
 */
import { isAbsolute, resolve } from 'node:path';
import { deriveTurns } from '@harness-deck/shared';
import type {
  BackendsState,
  ChangedFileView,
  CommandView,
  ConnectionState,
  DiffRef,
  HostSnapshot,
  ImageView,
  Item,
  ModelOption,
  ModelState,
  PermissionState,
  PromptImage,
  ProviderConfig,
  RuntimeStatus,
  SessionChangesView,
  SessionHeader,
  SessionListItem,
  TabsState,
  WebviewToHost,
} from '@harness-deck/shared';
import { wholeFile, type StoredSession } from '../acp/AcpController.ts';
import { isPathInsideProject } from '../projects/ProjectService.ts';
import {
  renderDelay,
  type ChatBackendController,
  type ControllerHostOptions,
  type CrossProjectSession,
  type ProgrammaticSessionRequest,
} from '../backend/types.ts';
import { formatSkillsPromptCatalog, skillsForBackend } from '../extensions/skillService.ts';
import { getLocale, t } from '../i18n.ts';
import {
  CONTEXT_OPEN,
  isTemplate,
  parseSlash,
  pluginCommands,
  splitContext,
  templatePrompt,
  withContext,
  type ContextAttachment,
  type TemplateName,
} from '../vm/context.ts';
import { reverseToolDiffs } from '../vm/diffs.ts';
import { EditorContext, type GatherOptions } from '../vm/EditorContext.ts';
import { displayPath } from '../vm/paths.ts';
import { attachPickedPaths } from '../vm/pickedFiles.ts';
import { TabsModel } from '../vm/TabsModel.ts';
import { ViewPublisher, type ControllerView } from '../vm/ViewPublisher.ts';
import { noWorkbench, type Workbench } from '../vm/workbench.ts';
import type { PiLink } from './connection.ts';
import { PiInteractionManager } from './interactions.ts';
import { PiSessionProjection } from './projection.ts';
import { readPiSessionMessagesFromDisk, scanPiSessions, type PiDiskSession } from './sessions.ts';

export interface PiPreferredModel {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface PiRpcState {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly isStreaming?: boolean;
  readonly thinkingLevel?: string;
  readonly model?: {
    readonly provider?: string;
    readonly id?: string;
    readonly name?: string;
    readonly contextWindow?: number;
  };
}

export interface PiControllerOptions extends ControllerHostOptions {
  readonly workspacePath: string;
  readonly restartRuntime: () => void;
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly loadSessions: () => readonly StoredSession[] | undefined;
  readonly saveSessions: (sessions: readonly StoredSession[]) => void;
  readonly loadPreferredModel?: () => PiPreferredModel | undefined;
  readonly savePreferredModel?: (preferred: PiPreferredModel) => void;
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  readonly piAgentDir?: () => string | undefined;
  readonly signInHint?: string;
  readonly boundProvider?: () => ProviderConfig | undefined;
  readonly onProviderModelSelected?: (providerId: string, model: string) => void;
}

interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
  readonly images: readonly PromptImage[];
}

const MAX_TITLE = 60;

const PI_THINKING_EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Max (xhigh)' },
] as const;

const PI_MODES: readonly { readonly id: string; readonly zh: string; readonly en: string }[] = [
  { id: 'auto', zh: '标准开发（Agent）', en: 'Agent (Default)' },
  { id: 'plan', zh: '计划模式（Plan）', en: 'Plan Mode' },
];

export class PiController implements ChatBackendController {
  private link: PiLink | undefined;
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private activeId: string | undefined;
  /** 当前 `pi --mode rpc` 子进程内部挂载的活跃 sessionId。 */
  private rpcSessionId: string | undefined;
  private workspacePath: string;
  private readonly projections = new Map<string, PiSessionProjection>();
  private readonly sessionPaths = new Map<string, string>();
  private readonly loadedSessions = new Set<string>();
  private readonly loading = new Set<string>();
  private diskSessions: PiDiskSession[] = [];
  private stored: StoredSession[];
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private queueCounter = 0;
  private modelOptions: ModelOption[] = [];
  private selectedModel: PiPreferredModel | undefined;
  private draftMode = 'auto';
  private agentCommands: CommandView[] = [];
  private readonly skillCatalogInjected = new Set<string>();
  private readonly editorContext: EditorContext;
  private readonly tabs: TabsModel;
  private readonly interactions: PiInteractionManager;
  private readonly publisher: ViewPublisher;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PiControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.stored = [...(options.loadSessions() ?? [])];
    this.selectedModel = options.loadPreferredModel?.();
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
    this.editorContext = new EditorContext(
      () => this.workbench,
      () => this.options.includeActiveEditor?.() ?? true,
      () => this.workspacePath,
    );
    this.interactions = new PiInteractionManager(() => this.scheduleRender());
    this.tabs = new TabsModel({
      keyPrefix: 'pi-tab',
      load: () => this.options.loadOpenTabs?.(),
      save: (ids) => this.options.saveOpenTabs?.(ids),
      onActivate: (sessionId) => this.setActive(sessionId),
      onClose: (tab) => tab.sessionId && this.interactions.clear(tab.sessionId),
      onChange: () => this.scheduleRender(),
    });
    this.tabs.restore(this.activeId);
  }

  private get workbench(): Workbench {
    return this.options.workbench ?? noWorkbench;
  }

  setLink(link: PiLink | undefined, initialState?: PiRpcState): void {
    this.link = link;
    this.connection = link ? 'connected' : 'idle';
    this.options.post({ type: 'connection', payload: this.connection });
    this.rpcSessionId = initialState?.sessionId;
    if (initialState?.sessionId && initialState.sessionFile) {
      this.sessionPaths.set(initialState.sessionId, initialState.sessionFile);
    }
    this.loadedSessions.clear();
    this.loading.clear();
    this.interactions.clear();

    if (link) {
      void (async () => {
        await Promise.all([this.refreshCatalogs(initialState), this.refreshDiskSessions()]);
        if (this.activeId) {
          await this.openExisting(this.activeId);
        }
      })();
    }
    this.scheduleRender();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    this.options.post({ type: 'runtimeStatus', payload: status });
    this.scheduleRender();
  }

  onEvent(event: Record<string, unknown>): void {
    const targetSessionId = this.rpcSessionId ?? this.activeId;
    if (!targetSessionId) return;
    const projection = this.projectionFor(targetSessionId);
    const wasRunning = projection.running;
    projection.applyEvent(event);
    if (wasRunning && !projection.running && event.type === 'agent_end') {
      void this.refreshDiskSessions();
      void this.drainQueue(targetSessionId);
    }
    this.scheduleRender();
  }

  onUiRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.interactions.handleUiRequest(this.rpcSessionId ?? this.activeId, request);
  }

  onUiNotify(request: Record<string, unknown>): void {
    const method = typeof request.method === 'string' ? request.method : '';
    if (method === 'notify' && typeof request.message === 'string' && request.message.trim()) {
      const level = request.notifyType === 'error' ? 'error' : 'info';
      this.toast(level, request.message.trim());
    } else if (method === 'setTitle' && typeof request.title === 'string' && request.title.trim()) {
      const sid = this.rpcSessionId ?? this.activeId;
      if (sid) {
        this.remember(sid, request.title.trim(), true);
        this.scheduleRender();
      }
    }
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.interactions.clear();
  }

  private buildSnapshot(view: ControllerView, includeWorkbench: boolean): HostSnapshot {
    return {
      runtime: this.runtime,
      connection: this.connection,
      sessions: view.sessions,
      tabs: view.tabs,
      session: { ...view.session, turns: deriveTurns(view.items, view.session.running) },
      items: view.items,
      models: view.models,
      interactions: view.interactions,
      permissions: view.permissions,
      workspace: view.workspace,
      context: view.context,
      commands: view.commands,
      locale: getLocale(),
      appearance: this.options.appearance?.() ?? {},
      ...(this.options.preferences ? { preferences: this.options.preferences() } : {}),
      backends: this.backends(),
      ...(this.options.providers ? { providers: this.options.providers() } : {}),
      ...(this.options.accounts ? { accounts: this.options.accounts() } : {}),
      ...(this.options.projects ? { projects: this.options.projects() } : {}),
      ...(this.options.extensions ? { extensions: this.options.extensions() } : {}),
      ...(includeWorkbench && this.options.workbenchState ? { workbench: this.options.workbenchState() } : {}),
    };
  }

  snapshot(): HostSnapshot {
    const view = this.compute();
    this.publisher.reset(view);
    return this.buildSnapshot(view, true);
  }

  peekSnapshot(): HostSnapshot {
    return this.buildSnapshot(this.compute(), false);
  }

  modelState(): ModelState {
    return this.buildModelState();
  }

  allWorkspaceSessions(): readonly CrossProjectSession[] {
    const waiting = this.interactions.sessionsWaiting();
    const byId = new Map<string, CrossProjectSession>();
    for (const s of this.diskSessions) {
      byId.set(s.id, {
        id: s.id,
        title: this.titleOf(s.id),
        cwd: s.cwd,
        updatedAt: s.updatedAt,
        running: this.projections.get(s.id)?.running ?? false,
        ...(waiting.has(s.id) ? { needsAttention: true } : {}),
      });
    }
    for (const s of this.stored) {
      if (!byId.has(s.id)) {
        byId.set(s.id, {
          id: s.id,
          title: s.title,
          cwd: '',
          updatedAt: s.updatedAt,
          running: this.projections.get(s.id)?.running ?? false,
          ...(waiting.has(s.id) ? { needsAttention: true } : {}),
        });
      }
    }
    return [...byId.values()].filter((s) => !this.options.isHiddenSession?.(s.id));
  }

  async startProgrammaticSession(req: ProgrammaticSessionRequest): Promise<string | undefined> {
    const link = await this.waitForLink(20_000);
    if (!link) {
      this.toast('error', t('notConnected'));
      return undefined;
    }
    this.tabs.openNew();
    const sessionId = await this.createBackendSession(link);
    if (!sessionId) return undefined;

    this.activeId = sessionId;
    this.options.saveActiveSessionId(sessionId);
    this.tabs.setCurrentSession(sessionId);
    if (req.title?.trim()) {
      this.remember(sessionId, req.title.trim(), true);
      await link.request('set_session_name', { name: req.title.trim() }).catch(() => undefined);
    }
    if (req.model?.model) {
      await this.selectModel(req.model.provider ?? 'anthropic', req.model.model, req.model.reasoningEffort);
    }
    if (req.prompt?.trim()) {
      if (!req.title?.trim()) this.remember(sessionId, req.prompt.trim());
      void this.dispatchSend(link, sessionId, req.prompt.trim(), []);
    }
    this.scheduleRender();
    return sessionId;
  }

  latestAssistantText(sessionId: string): string | undefined {
    const items = this.projections.get(sessionId)?.snapshotItems() ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === 'assistant' && item.markdown.trim()) return item.markdown.trim();
    }
    return undefined;
  }

  workspaceChanged(): void {
    this.scheduleRender();
  }

  localeChanged(): void {
    this.options.post({ type: 'locale', payload: getLocale() });
    this.scheduleRender();
  }

  appearanceChanged(): void {
    this.options.post({ type: 'appearance', payload: this.options.appearance?.() ?? {} });
  }

  preferencesChanged(): void {
    if (this.options.preferences) {
      this.options.post({ type: 'preferences', payload: this.options.preferences() });
    }
  }

  backendsChanged(): void {
    this.options.post({ type: 'backends', payload: this.backends() });
  }

  providersChanged(): void {
    if (this.options.providers) {
      this.options.post({ type: 'providers', payload: this.options.providers() });
    }
    this.scheduleRender();
  }

  accountsChanged(): void {
    if (this.options.accounts) {
      this.options.post({ type: 'accounts', payload: this.options.accounts() });
    }
    this.scheduleRender();
  }

  projectsChanged(): void {
    if (this.options.projects) {
      this.options.post({ type: 'projects', payload: this.options.projects() });
    }
  }

  extensionsChanged(): void {
    if (this.options.extensions) {
      this.options.post({ type: 'extensions', payload: this.options.extensions() });
    }
    this.scheduleRender();
  }

  setWorkspace(path: string): void {
    if (path === this.workspacePath) return;
    this.workspacePath = path;
    this.editorContext.clearPinned();
    this.interactions.clear();
    this.stored = [...(this.options.loadSessions() ?? [])];
    this.diskSessions = [];
    this.loadedSessions.clear();
    this.loading.clear();
    this.activeId = this.options.loadActiveSessionId();
    this.projections.clear();
    this.tabs.restore(this.activeId);
    // 工作区目录变更时重启 `pi --mode rpc` 子进程使其 cwd 对准新目录
    this.options.restartRuntime();
    this.scheduleRender();
  }

  async askAboutSelection(template: TemplateName): Promise<void> {
    const attachment = this.editorContext.active();
    if (!attachment) {
      this.toast('info', t('context.none'));
      return;
    }
    await this.send(templatePrompt(template, ''), {
      includeActive: false,
      extra: [attachment],
      diagnostics: template === 'fix',
    });
  }

  pinActiveEditor(): void {
    if (!this.editorContext.pinActive()) {
      this.toast('info', t('context.none'));
      return;
    }
    this.scheduleRender();
    this.options.post({ type: 'focusComposer', payload: {} });
  }

  async renameSession(explicitTitle?: string): Promise<void> {
    const sessionId = this.activeId;
    if (!sessionId) {
      this.toast('info', t('rename.needsSession'));
      return;
    }
    const title =
      explicitTitle !== undefined
        ? explicitTitle
        : await this.workbench.input({ title: t('rename.title'), value: this.titleOf(sessionId) });
    if (!title?.trim()) return;
    const trimmed = title.trim();
    this.remember(sessionId, trimmed, true);
    if (this.link && this.rpcSessionId === sessionId) {
      await this.link.request('set_session_name', { name: trimmed }).catch(() => undefined);
    }
    this.scheduleRender();
  }

  async configureApiKey(): Promise<void> {
    this.toast('info', this.options.signInHint ?? t('pi.signIn'));
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.options.post({ type: 'snapshot', payload: this.snapshot() });
        return;
      case 'sendMessage': {
        const accepted = await this.send(message.payload.text, {
          includeActive: message.payload.includeActive ?? true,
          images: message.payload.images ?? [],
        });
        if (!accepted) this.options.post({ type: 'restoreDraft', payload: { text: message.payload.text } });
        return;
      }
      case 'searchFiles': {
        let items: { path: string; kind: 'file' | 'directory' }[] = [];
        try {
          items = await this.workbench.findFiles(message.payload.query);
        } catch (error) {
          this.options.log(`文件搜索失败：${describe(error)}`);
        }
        this.options.post({
          type: 'fileCandidates',
          payload: { requestId: message.payload.requestId, items: items.slice(0, 50) },
        });
        return;
      }
      case 'removeAttachment':
        this.editorContext.unpin(message.payload.id);
        this.scheduleRender();
        return;
      case 'queueAction':
        await this.queueAction(message.payload);
        return;
      case 'renameSession':
        return this.renameSession(message.payload.title);
      case 'configureApiKey':
        return this.configureApiKey();
      case 'selectFolder':
        this.options.selectFolder?.();
        return;
      case 'interrupt':
        await this.interrupt();
        return;
      case 'newSession':
        this.tabs.openNew();
        return;
      case 'switchSession':
        this.tabs.open(message.payload.sessionId);
        return;
      case 'activateTab':
        this.tabs.activate(message.payload.key);
        return;
      case 'closeTab':
        this.tabs.close(message.payload.key);
        return;
      case 'selectModel':
        return this.selectModel(message.payload.provider, message.payload.model, message.payload.reasoningEffort);
      case 'openExternal':
        this.options.openExternal(message.payload.url);
        return;
      case 'restartRuntime':
        this.options.restartRuntime();
        return;
      case 'showLogs':
        this.options.showLogs();
        return;
      case 'openWebUI':
        this.toast('info', t('acp.noWebUI', 'Pi'));
        return;
      case 'respondApproval': {
        const outcome = this.interactions.respondApproval(message.payload.id, message.payload.decision);
        if (!outcome.ok && outcome.error) {
          this.toast('info', outcome.error);
        }
        return;
      }
      case 'answerQuestion': {
        if (!this.interactions.answerQuestion(message.payload)) {
          this.toast('info', t('question.ended'));
        }
        return;
      }
      case 'openDiff':
        try {
          await this.openDiff(message.payload.ref);
        } finally {
          if (message.payload.token !== undefined) {
            this.options.post({ type: 'diffOpened', payload: { token: message.payload.token } });
          }
        }
        return;
      case 'openFile': {
        const { path, startLine, endLine } = message.payload;
        return this.workbench.openFile(
          this.absolute(path),
          startLine ? { startLine, ...(endLine ? { endLine } : {}) } : undefined,
        );
      }
      case 'selectPermission': {
        const nextPreset = message.payload.preset;
        if (nextPreset === this.draftMode) return;
        this.draftMode = nextPreset;
        if (this.activeId && this.projections.get(this.activeId)?.running) {
          const info = PI_MODES.find((m) => m.id === nextPreset);
          const displayName = info ? (getLocale() === 'zh' ? info.zh : info.en) : nextPreset;
          this.toast('info', t('permission.nextTurn', displayName));
        }
        this.scheduleRender();
        return;
      }
      case 'saveAll':
        return this.workbench.saveAll();
      case 'openSettings':
        this.options.openSettings?.();
        return;
      case 'setAppearance':
        try {
          await this.options.setAppearance?.(message.payload);
        } catch (error) {
          this.toast('error', t('appearance.failed', describe(error)));
          this.appearanceChanged();
        }
        return;
      case 'setPreferences':
        try {
          await this.options.setPreferences?.(message.payload);
        } catch (error) {
          this.toast('error', t('preferences.failed', describe(error)));
          this.preferencesChanged();
        }
        return;
      case 'loadImage':
        this.options.post({ type: 'imageData', payload: { attachmentId: message.payload.attachmentId } });
        return;
      case 'pickFiles': {
        const picked = await this.options.pickFiles?.();
        attachPickedPaths(picked, this.editorContext, {
          post: (msg) => this.options.post(msg),
          toast: (level, text) => this.toast(level, text),
          scheduleRender: () => this.scheduleRender(),
        });
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- 会话生命周期

  private setActive(sessionId: string | undefined): void {
    this.tabs.setCurrentSession(sessionId);
    if (sessionId === this.activeId) return;
    this.activeId = sessionId;
    this.options.saveActiveSessionId(sessionId);
    if (sessionId) void this.openExisting(sessionId);
    this.scheduleRender();
  }

  private async openExisting(sessionId: string): Promise<void> {
    if (this.loadedSessions.has(sessionId) || this.loading.has(sessionId)) return;
    const link = this.link;
    if (!link) return;
    this.loading.add(sessionId);
    this.scheduleRender();

    try {
      const sessionPath = this.resolveSessionPath(sessionId);
      const rpcBusy = Boolean(this.rpcSessionId && this.projections.get(this.rpcSessionId)?.running);
      const projection = this.projectionFor(sessionId);

      if (this.rpcSessionId === sessionId) {
        const msgs = await link.request('get_messages');
        projection.applyMessagesSnapshot(msgs);
        this.loadedSessions.add(sessionId);
      } else if (sessionPath && !rpcBusy) {
        await link.request('switch_session', { sessionPath });
        this.rpcSessionId = sessionId;
        const msgs = await link.request('get_messages');
        projection.applyMessagesSnapshot(msgs);
        this.loadedSessions.add(sessionId);
      } else if (sessionPath) {
        // RPC 子进程正在另一个会话流式回复中：直接从磁盘 `.jsonl` 读取预览，不打断运行中的会话
        const diskMsgs = await readPiSessionMessagesFromDisk(sessionPath);
        projection.applyMessagesSnapshot(diskMsgs);
        this.loadedSessions.add(sessionId);
      }
    } catch (error) {
      this.options.log(`打开 Pi 会话 ${sessionId} 失败：${describe(error)}`);
      this.toast('error', t('acp.loadFailed', describe(error)));
    } finally {
      this.loading.delete(sessionId);
      this.scheduleRender();
    }
  }

  private async createBackendSession(link: PiLink): Promise<string | undefined> {
    try {
      await link.request('new_session');
      const state = await link.request<PiRpcState>('get_state');
      const sessionId = state?.sessionId;
      if (!sessionId) throw new Error('missing sessionId in get_state');
      this.rpcSessionId = sessionId;
      if (state.sessionFile) {
        this.sessionPaths.set(sessionId, state.sessionFile);
      }
      this.loadedSessions.add(sessionId);
      const projection = this.projectionFor(sessionId);
      projection.setContextWindow(state.model?.contextWindow);
      await this.applySelectedModelToLink(link);
      return sessionId;
    } catch (error) {
      this.options.log(`新建 Pi 会话失败：${describe(error)}`);
      this.toast('error', t('acp.newFailed', this.describeAuthOrError(error)));
      return undefined;
    }
  }

  private async ensureRpcOnSession(link: PiLink, sessionId: string): Promise<void> {
    if (this.rpcSessionId === sessionId) return;
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return;
    await link.request('switch_session', { sessionPath });
    this.rpcSessionId = sessionId;
  }

  private resolveSessionPath(sessionId: string): string | undefined {
    return this.sessionPaths.get(sessionId) ?? this.diskSessions.find((s) => s.id === sessionId)?.sessionPath;
  }

  private async refreshDiskSessions(): Promise<void> {
    try {
      const extraProjects = this.options.projects?.().recent.map((p) => p.path) ?? [];
      this.diskSessions = await scanPiSessions(this.workspacePath, this.options.piAgentDir?.(), extraProjects);
      for (const s of this.diskSessions) {
        if (!this.sessionPaths.has(s.id)) {
          this.sessionPaths.set(s.id, s.sessionPath);
        }
      }
      this.scheduleRender();
    } catch (error) {
      this.options.log(`扫描 Pi 历史会话跳过：${describe(error)}`);
    }
  }

  private async refreshCatalogs(initialState?: PiRpcState): Promise<void> {
    const link = this.link;
    if (!link) return;
    const [modelsRes, commandsRes] = await Promise.all([
      link.request<unknown>('get_available_models').catch(() => undefined),
      link.request<unknown>('get_commands').catch(() => undefined),
    ]);

    this.modelOptions = parsePiModels(modelsRes);
    if (!this.selectedModel) {
      if (initialState?.model?.provider && initialState.model.id) {
        this.selectedModel = {
          provider: initialState.model.provider,
          model: initialState.model.id,
          ...(initialState.thinkingLevel ? { effort: initialState.thinkingLevel } : {}),
        };
      } else if (this.modelOptions[0]) {
        const first = this.modelOptions[0];
        this.selectedModel = {
          provider: first.provider,
          model: first.model,
          ...(first.defaultEffort ? { effort: first.defaultEffort } : {}),
        };
      }
    } else {
      await this.applySelectedModelToLink(link);
    }

    this.agentCommands = parsePiCommands(commandsRes);
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 消息发送、插队与中断

  async send(text: string, options: GatherOptions & { images?: readonly PromptImage[] } = {}): Promise<boolean> {
    const slash = parseSlash(text);
    if (slash?.name === 'new') {
      this.tabs.openNew();
      return slash.args.trim() ? this.send(slash.args, options) : true;
    }
    if (slash?.name === 'plan') {
      const nextMode =
        slash.args.trim() === 'off' ? 'auto' : this.draftMode === 'plan' && !slash.args.trim() ? 'auto' : 'plan';
      this.draftMode = nextMode;
      this.scheduleRender();
      return slash.args.trim() && slash.args.trim() !== 'off' ? this.send(slash.args, options) : true;
    }

    let prompt = text;
    let attachments: ContextAttachment[];
    if (slash && isTemplate(slash.name)) {
      attachments = this.editorContext.gather({ ...options, diagnostics: options.diagnostics ?? slash.name === 'fix' });
      if (attachments.length === 0 && !slash.args.trim()) {
        this.toast('info', t('template.needsContext', slash.name));
        return false;
      }
      prompt = templatePrompt(slash.name, slash.args);
    } else {
      attachments = slash ? [] : this.editorContext.gather(options);
    }

    const full = withContext(prompt, attachments, this.workspacePath);
    const link = this.link;
    if (!link) {
      this.toast('error', t('notConnected'));
      return false;
    }

    let sessionId = this.activeId;
    if (!sessionId) {
      sessionId = await this.createBackendSession(link);
      if (!sessionId) return false;
      this.activeId = sessionId;
      this.options.saveActiveSessionId(sessionId);
      this.tabs.setCurrentSession(sessionId);
      this.remember(sessionId, prompt || t('acp.image'));
    }

    this.editorContext.clearPinned();
    const projection = this.projectionFor(sessionId);
    const images = options.images ?? [];
    const anyRpcStreaming = Boolean(this.rpcSessionId && this.projections.get(this.rpcSessionId)?.running);
    if (projection.running || (anyRpcStreaming && this.rpcSessionId !== sessionId)) {
      const queue = this.queues.get(sessionId) ?? [];
      queue.push({ id: `q${++this.queueCounter}`, text: full, images });
      this.queues.set(sessionId, queue);
      this.scheduleRender();
      return true;
    }

    await this.dispatchSend(link, sessionId, full, images);
    return true;
  }

  private async dispatchSend(
    link: PiLink,
    sessionId: string,
    text: string,
    images: readonly PromptImage[],
  ): Promise<void> {
    const projection = this.projectionFor(sessionId);
    projection.addUserMessage(
      text,
      images.map((img): ImageView => ({
        localId: img.localId,
        mediaType: img.mediaType,
        ...(img.name ? { name: img.name } : {}),
      })),
    );
    projection.startTurn(Date.now());
    this.scheduleRender();

    let wireText = this.enrichPromptWithSkills(sessionId, text);
    if (this.draftMode === 'plan') {
      wireText = `[Plan Mode: Inspect and propose a clear step-by-step plan first without modifying files.]\n\n${wireText}`;
    }

    const rpcImages = images.map((img) => ({
      type: 'image',
      data: img.data,
      mimeType: img.mediaType,
    }));

    try {
      await this.ensureRpcOnSession(link, sessionId);
      await link.request('prompt', {
        message: wireText,
        ...(rpcImages.length > 0 ? { images: rpcImages } : {}),
      });
      this.remember(sessionId, this.titleOf(sessionId));
    } catch (error) {
      projection.endTurn(Date.now(), 'failed', this.describeAuthOrError(error));
      this.scheduleRender();
    }
  }

  private async drainQueue(finishedSessionId: string): Promise<void> {
    const link = this.link;
    if (!link) return;
    // 优先排空刚结束会话的队列，其次检查其他排队会话
    const candidateIds = [finishedSessionId, ...this.queues.keys()];
    for (const sid of candidateIds) {
      const next = this.queues.get(sid)?.shift();
      if (next) {
        await this.dispatchSend(link, sid, next.text, next.images);
        return;
      }
    }
  }

  private async interrupt(): Promise<void> {
    const sessionId = this.activeId;
    if (!sessionId || !this.link) return;
    this.interactions.clear(sessionId);
    if (this.rpcSessionId === sessionId) {
      await this.link.request('abort').catch(() => undefined);
    }
    const projection = this.projections.get(sessionId);
    if (projection?.running) {
      projection.endTurn(Date.now(), 'cancelled');
    }
    this.scheduleRender();
  }

  private async queueAction(payload: Extract<WebviewToHost, { type: 'queueAction' }>['payload']): Promise<void> {
    const sessionId = this.activeId;
    const queue = sessionId ? this.queues.get(sessionId) : undefined;
    if (!sessionId || !queue) return;
    const index = queue.findIndex((q) => q.id === payload.itemId);
    if (index < 0) return;

    if (payload.action === 'remove') {
      queue.splice(index, 1);
    } else if (payload.action === 'edit') {
      const original = queue[index]!;
      const at = original.text.lastIndexOf(`\n\n${CONTEXT_OPEN}\n`);
      const text = at >= 0 ? `${payload.text}${original.text.slice(at)}` : payload.text;
      queue[index] = { ...original, text };
    } else if (payload.action === 'send') {
      const [item] = queue.splice(index, 1);
      if (!item) return;
      const running = this.projections.get(sessionId)?.running ?? false;
      if (!running && this.link) {
        this.scheduleRender();
        await this.dispatchSend(this.link, sessionId, item.text, item.images);
        return;
      }
      queue.unshift(item);
    } else if (payload.action === 'steer') {
      const [item] = queue.splice(index, 1);
      if (!item) return;
      if (this.link && this.rpcSessionId === sessionId && (this.projections.get(sessionId)?.running ?? false)) {
        try {
          const rpcImages = item.images.map((img) => ({
            type: 'image',
            data: img.data,
            mimeType: img.mediaType,
          }));
          await this.link.request('steer', {
            message: item.text,
            ...(rpcImages.length > 0 ? { images: rpcImages } : {}),
          });
          this.projectionFor(sessionId).addUserMessage(item.text);
          this.scheduleRender();
          return;
        } catch {
          // 退回到排在队首
        }
      }
      queue.unshift(item);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模型与思考档位

  private buildModelState(): ModelState {
    const bound = this.options.boundProvider?.();
    const boundOpts: ModelOption[] =
      bound && bound.models.length > 0
        ? bound.models.map((m) => {
            const efforts = (m.efforts ?? []).map((e) => ({ id: e, name: e }));
            return {
              provider: bound.id,
              model: m.id,
              name: m.name || m.id,
              group: bound.name,
              efforts,
              ...(efforts[0] ? { defaultEffort: efforts[0].id } : {}),
            };
          })
        : [];

    const existingKeys = new Set(boundOpts.map((o) => `${o.provider}/${o.model}`));
    const mergedCatalog = [
      ...boundOpts,
      ...this.modelOptions.filter((o) => !existingKeys.has(`${o.provider}/${o.model}`)),
    ];

    if (mergedCatalog.length === 0) {
      return { needsApiKey: !bound, options: [] };
    }

    const defaultFromBound: PiPreferredModel | undefined =
      bound && (bound.defaultModel || bound.models[0]?.id)
        ? { provider: bound.id, model: bound.defaultModel ?? bound.models[0]!.id }
        : undefined;
    const fallbackFirst: PiPreferredModel = {
      provider: mergedCatalog[0]!.provider,
      model: mergedCatalog[0]!.model,
      ...(mergedCatalog[0]!.defaultEffort ? { effort: mergedCatalog[0]!.defaultEffort } : {}),
    };
    const current: PiPreferredModel =
      this.selectedModel && (bound ? this.selectedModel.provider === bound.id : true)
        ? this.selectedModel
        : (defaultFromBound ?? fallbackFirst);

    const exists = mergedCatalog.some((o) => o.provider === current.provider && o.model === current.model);
    const options = exists
      ? mergedCatalog
      : [
          {
            provider: current.provider,
            model: current.model,
            name: current.model,
            group: current.provider,
            efforts: PI_THINKING_EFFORTS,
          },
          ...mergedCatalog,
        ];

    return {
      options,
      current: {
        provider: current.provider,
        model: current.model,
        ...(current.effort ? { reasoningEffort: current.effort } : {}),
      },
    };
  }

  private async selectModel(provider: string, model: string, effort?: string): Promise<void> {
    const bound = this.options.boundProvider?.();
    if (bound && provider === bound.id) {
      this.options.onProviderModelSelected?.(bound.id, model);
    }
    this.selectedModel = { provider, model, ...(effort ? { effort } : {}) };
    this.options.savePreferredModel?.(this.selectedModel);
    if (this.link) {
      await this.applySelectedModelToLink(this.link);
    }
    this.scheduleRender();
  }

  private async applySelectedModelToLink(link: PiLink): Promise<void> {
    const sel = this.selectedModel;
    if (!sel) return;
    const setRes = await link
      .request<{ contextWindow?: number }>('set_model', { provider: sel.provider, modelId: sel.model })
      .catch(() => undefined);
    if (setRes?.contextWindow && this.activeId) {
      this.projectionFor(this.activeId).setContextWindow(setRes.contextWindow);
    }
    if (sel.effort) {
      await link.request('set_thinking_level', { level: sel.effort }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- Diff 与视图计算

  private async openDiff(ref: DiffRef): Promise<void> {
    if (ref.kind === 'session') return this.openSessionDiff(ref.path);
    if (ref.kind !== 'tool' || !this.activeId) return;
    const diffs = this.projections.get(this.activeId)?.diffsOf(ref.callId) ?? [];
    const diff = diffs[0];
    if (!diff) {
      this.toast('info', t('diff.noRecord'));
      return;
    }
    const path = this.absolute(diff.path);
    const current = await this.workbench.readFile(path);
    const created = diff.oldText === null;
    if (diffs.length > 1 && current !== undefined) {
      const samePathDiffs = diffs.filter((d) => this.absolute(d.path) === path);
      const reversed = reverseToolDiffs(current, samePathDiffs);
      if (reversed !== undefined) {
        await this.workbench.openDiff({
          kind: 'contents',
          path,
          before: created ? '' : reversed,
          created,
          scope: 'turn',
        });
        return;
      }
    }
    const whole = wholeFile(diff, current);
    await this.workbench.openDiff({
      kind: 'contents',
      path,
      before: whole ?? diff.oldText ?? '',
      ...(whole !== undefined || current === diff.newText ? {} : { after: diff.newText }),
      created,
      scope: 'turn',
    });
  }

  private async openSessionDiff(path: string): Promise<void> {
    const change = (this.activeId ? this.projections.get(this.activeId) : undefined)
      ?.fileChanges()
      .find((f) => this.absolute(f.path) === path);
    if (!change || change.diffs.length === 0) return this.workbench.openFile(path);
    const current = await this.workbench.readFile(path);
    const before = current === undefined ? undefined : reverseToolDiffs(current, change.diffs);
    if (before !== undefined) {
      await this.workbench.openDiff({
        kind: 'contents',
        path,
        before: change.created ? '' : before,
        created: change.created,
        scope: 'session',
      });
      return;
    }
    const last = change.calls.at(-1);
    if (last) return this.openDiff({ kind: 'tool', callId: last });
    return this.workbench.openFile(path);
  }

  private sessionChanges(projection: PiSessionProjection | undefined): SessionChangesView | undefined {
    const files = projection?.fileChanges() ?? [];
    if (files.length === 0) return undefined;
    const views: ChangedFileView[] = files.map((f) => {
      const path = this.absolute(f.path);
      return {
        path: displayPath(path, this.workspacePath),
        ref: { kind: 'session', path },
        additions: f.additions,
        deletions: f.deletions,
        ...(f.created ? { created: true } : {}),
      };
    });
    return {
      files: views,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }

  private tabsState(current: SessionHeader): TabsState {
    const waiting = this.interactions.sessionsWaiting();
    const flag = (sid: string | undefined) => (sid && waiting.has(sid) ? { needsAttention: true } : {});
    const items = this.tabs.view(
      { title: current.title, running: current.running, ...flag(this.tabs.current?.sessionId) },
      (sid) => ({ title: this.titleOf(sid), running: this.projections.get(sid)?.running ?? false, ...flag(sid) }),
      t('session.new'),
    );
    return { items, active: this.tabs.activeTabKey };
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, renderDelay(this.options));
  }

  render(): void {
    const view = this.compute();
    this.publisher.publish(view);
    const lastItem = view.items.at(-1);
    const turnAborted =
      (lastItem?.kind === 'turnDone' && !lastItem.completed) ||
      (lastItem?.kind === 'notice' && lastItem.level === 'error');
    const hasTurnOutput = view.items.some((item) => item.kind === 'assistant' || item.kind === 'turnDone');
    this.options.onSessionObserve?.({
      ...(view.session.id ? { sessionId: view.session.id } : {}),
      title: view.session.title,
      running: view.session.running,
      sync: view.session.sync,
      interactionIds: view.interactions.map((i) => i.id),
      ...(turnAborted ? { turnAborted: true } : {}),
      ...(hasTurnOutput ? { hasTurnOutput: true } : {}),
      ...(view.session.goal ? { goalPhase: view.session.goal.phase, goalObjective: view.session.goal.objective } : {}),
    });
  }

  private compute(): ControllerView {
    const sessionId = this.activeId;
    const projection = sessionId ? this.projections.get(sessionId) : undefined;
    const running = projection?.running ?? false;
    const queue = sessionId ? (this.queues.get(sessionId) ?? []) : [];
    const items: Item[] = [
      ...(projection?.snapshotItems() ?? []),
      ...queue.map((q): Item => {
        const parsed = splitContext(q.text);
        return {
          kind: 'user',
          id: `q:${q.id}`,
          text: parsed.text,
          ...(parsed.attachments.length ? { attachments: parsed.attachments } : {}),
          ...(q.images.length
            ? {
                images: q.images.map((img): ImageView => ({
                  localId: img.localId,
                  mediaType: img.mediaType,
                  ...(img.name ? { name: img.name } : {}),
                })),
              }
            : {}),
          pending: 'queued',
          queue: { itemId: q.id, target: 'next-turn' },
        };
      }),
    ];

    const usage = projection?.usage;
    const contextDetail = projection?.usageTracker.detail();
    const changes = this.sessionChanges(projection);
    const session: SessionHeader = {
      ...(sessionId ? { id: sessionId } : {}),
      title: this.titleOf(sessionId),
      running,
      hasOlder: false,
      loadingOlder: false,
      sync: !sessionId ? 'idle' : this.loading.has(sessionId) || !this.link ? 'opening' : 'live',
      ...(usage
        ? {
            contextUsage: Math.min(1, usage.used / usage.size),
            contextTokens: { used: usage.used, window: usage.size },
          }
        : {}),
      ...(contextDetail ? { contextDetail } : {}),
      ...(this.draftMode === 'plan' ? { planMode: true } : {}),
      ...(projection?.todos?.length ? { todos: projection.todos } : {}),
      ...(projection?.goal ? { goal: projection.goal } : {}),
      ...(running && projection?.runningSince !== undefined ? { runningSince: projection.runningSince } : {}),
      ...(this.options.folderLabel?.() ? { folder: this.options.folderLabel() } : {}),
      ...(changes ? { changes } : {}),
    };

    const waiting = this.interactions.sessionsWaiting();
    const state = (id: string) => ({
      running: this.projections.get(id)?.running ?? false,
      ...(waiting.has(id) ? { needsAttention: true } : {}),
    });
    const known = new Map<string, SessionListItem>();
    const otherWorkspaceIds = new Set<string>();
    for (const s of this.diskSessions) {
      if (isPathInsideProject(this.workspacePath, s.cwd)) {
        known.set(s.id, { id: s.id, title: this.titleOf(s.id), updatedAt: s.updatedAt, ...state(s.id) });
      } else {
        otherWorkspaceIds.add(s.id);
      }
    }
    for (const s of this.stored) {
      if (!known.has(s.id) && !otherWorkspaceIds.has(s.id)) {
        known.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt, ...state(s.id) });
      }
    }
    const isHidden = this.options.isHiddenSession;
    const sessions = [...known.values()]
      .filter((s) => !isHidden?.(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const locale = getLocale();
    const permissions: PermissionState = {
      options: PI_MODES.map((m) => m.id),
      current: this.draftMode,
      labels: Object.fromEntries(PI_MODES.map((m) => [m.id, { name: locale === 'zh' ? m.zh : m.en }])),
    };

    const baseCommands: CommandView[] = [
      ...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })),
      ...this.agentCommands,
    ];
    const takenNames = new Set(baseCommands.map((c) => c.name));
    const extraSkills: CommandView[] = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'pi')
      .filter((s) => !takenNames.has(s.name))
      .map((s) => ({ name: s.name, description: s.description, source: 'skill' as const }));
    const commands: CommandView[] = [...baseCommands, ...extraSkills];

    return {
      sessionKey: sessionId ?? '',
      sessions,
      tabs: this.tabsState(session),
      session,
      items,
      models: this.buildModelState(),
      interactions: this.interactions.viewsFor(sessionId),
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
      context: this.editorContext.state(),
      commands,
    };
  }

  private enrichPromptWithSkills(sessionId: string, text: string): string {
    const activeSkills = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'pi');
    if (activeSkills.length === 0) return text;
    // 若 get_commands 已原生发现该技能，Pi 已通过 `--skill` 挂载，无需注入 XML 目录
    const nativeSkillNames = new Set(this.agentCommands.filter((c) => c.source === 'skill').map((c) => c.name));
    const missing = activeSkills.filter((s) => !nativeSkillNames.has(s.name) && !nativeSkillNames.has(`skill:${s.name}`));
    if (missing.length === 0) return text;
    if (!this.skillCatalogInjected.has(sessionId)) {
      this.skillCatalogInjected.add(sessionId);
      const catalog = formatSkillsPromptCatalog(missing);
      if (catalog) return `${catalog}\n\n${text}`;
    }
    return text;
  }

  private projectionFor(sessionId: string): PiSessionProjection {
    let p = this.projections.get(sessionId);
    if (!p) {
      p = new PiSessionProjection(this.workspacePath);
      this.projections.set(sessionId, p);
    }
    return p;
  }

  private remember(sessionId: string, title: string, force = false): void {
    const existing = this.stored.find((s) => s.id === sessionId);
    if (existing && !force && existing.title) {
      this.stored = this.stored.map((s) => (s.id === sessionId ? { ...s, updatedAt: Date.now() } : s));
    } else {
      const clean = title.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE);
      this.stored = [{ id: sessionId, title: clean, updatedAt: Date.now() }, ...this.stored.filter((s) => s.id !== sessionId)];
    }
    this.options.saveSessions(this.stored.slice(0, 200));
  }

  private titleOf(sessionId: string | undefined): string {
    if (!sessionId) return t('session.new');
    return (
      this.stored.find((s) => s.id === sessionId)?.title ||
      this.projections.get(sessionId)?.title ||
      this.diskSessions.find((s) => s.id === sessionId)?.title ||
      t('acp.untitled')
    );
  }

  private describeAuthOrError(error: unknown): string {
    const msg = describe(error);
    if (/auth|credential|api[-_ ]?key|unauthoriz|not logged|login|no model/iu.test(msg)) {
      return this.options.signInHint ? `${msg}（${this.options.signInHint}）` : msg;
    }
    return msg;
  }

  private async waitForLink(timeoutMs: number): Promise<PiLink | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.link) return this.link;
      await new Promise((r) => setTimeout(r, 60));
    }
    return this.link;
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workspacePath, path);
  }

  private backends(): BackendsState {
    return this.options.backends?.() ?? { items: [], active: '' };
  }

  private toast(level: 'info' | 'error', text: string): void {
    this.options.post({ type: 'toast', payload: { level, text } });
  }
}

function parsePiModels(raw: unknown): ModelOption[] {
  const list =
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { models?: unknown }).models)
        ? (raw as { models: unknown[] }).models
        : [];
  const out: ModelOption[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const provider = typeof m.provider === 'string' ? m.provider.trim() : '';
    const model = typeof m.id === 'string' ? m.id.trim() : '';
    if (!provider || !model) continue;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : model;
    const reasoning = m.reasoning === true;
    out.push({
      provider,
      model,
      name,
      group: provider,
      efforts: reasoning ? PI_THINKING_EFFORTS : [],
      ...(reasoning ? { defaultEffort: 'medium' } : {}),
    });
  }
  return out;
}

function parsePiCommands(raw: unknown): CommandView[] {
  const list =
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { commands?: unknown }).commands)
        ? (raw as { commands: unknown[] }).commands
        : [];
  const out: CommandView[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const rawName = typeof c.name === 'string' ? c.name.trim().replace(/^\/+/u, '') : '';
    if (!rawName || rawName === 'new' || rawName === 'plan' || seen.has(rawName)) continue;
    seen.add(rawName);
    const description = typeof c.description === 'string' ? c.description.trim() : '';
    const source: CommandView['source'] = c.source === 'skill' || rawName.startsWith('skill:') ? 'skill' : 'agent';
    out.push({
      name: rawName.replace(/^skill:/u, ''),
      description,
      source,
    });
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

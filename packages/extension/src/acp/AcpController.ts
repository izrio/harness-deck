/**
 * ACP 底层的控制器：和 dsh 的 ChatController 实现同一个接口、产出同样的视图模型，界面不区分底层。
 *
 * - 会话：`session/list` 列出（代理支持时），`session/load` 打开并回放历史，第一条消息前先 `session/new` 建好草稿会话
 *   （这样模型、模式和斜杠命令在发消息前就能用）；
 * - 发送：`session/prompt`（附带编辑器上下文和图片），一轮进行中时新消息在本地排队，结束后依次发送；停止用 `session/cancel`；
 * - 审批：代理的 `session/request_permission` 显示成审批卡片；
 * - 模型、模式：代理的 config option（category 为 model / mode / thought_level）对应模型选择和权限选择。
 *
 * 没有对应能力的功能（每轮改动汇总、子代理、dsh 的队列和插队）在界面上自然不出现。
 */
import type {
  BackendsState,
  CommandView,
  ConnectionState,
  DiffRef,
  HostSnapshot,
  ImageView,
  InstalledSkillView,
  Item,
  McpServerConfig,
  ModelOption,
  ModelState,
  PendingInteraction,
  PermissionState,
  PromptImage,
  ProviderConfig,
  RuntimeStatus,
  SessionHeader,
  SessionListItem,
  SessionChangesView,
  ChangedFileView,
  TabsState,
  WebviewToHost,
} from '@harness-deck/shared';
import { isAbsolute, resolve } from 'node:path';
import {
  renderDelay,
  type ChatBackendController,
  type ControllerHostOptions,
  type CrossProjectSession,
  type ProgrammaticSessionRequest,
} from '../backend/types.ts';
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
import { displayPath } from '../vm/paths.ts';
import { EditorContext, type GatherOptions } from '../vm/EditorContext.ts';
import { attachPickedPaths } from '../vm/pickedFiles.ts';
import { TabsModel } from '../vm/TabsModel.ts';
import { ViewPublisher, type ControllerView } from '../vm/ViewPublisher.ts';
import { noWorkbench, type Workbench } from '../vm/workbench.ts';
import { AcpError } from './connection.ts';
import { toAcpMcpServers, type AcpSkillInjectionMode } from '../extensions/mcpService.ts';
import { formatSkillsPromptCatalog } from '../extensions/skillService.ts';
import {
  AcpSessionProjection,
  inputFilePath,
  type AcpCommand,
  type AcpConfigOption,
  type AcpDiff,
  type AcpSessionMeta,
  type AcpToolCall,
} from './projection.ts';

/** 和代理通话的接口（测试里用假的）。 */
export interface AcpLink {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
}

/** `initialize` 的结果里用到的部分。 */
export interface AcpInitialize {
  readonly protocolVersion?: number;
  readonly agentInfo?: { readonly name?: string; readonly title?: string; readonly version?: string };
  readonly authMethods?: readonly AuthMethod[];
  readonly agentCapabilities?: {
    readonly loadSession?: boolean;
    readonly promptCapabilities?: { readonly image?: boolean; readonly embeddedContext?: boolean };
    readonly mcpCapabilities?: { readonly http?: boolean; readonly sse?: boolean };
    readonly sessionCapabilities?: { readonly list?: unknown; readonly additionalDirectories?: unknown };
  };
}

/** 本地记住的会话（代理不支持列表时用；标题也存在这里）。 */
export interface StoredSession {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

export interface AcpControllerOptions extends ControllerHostOptions {
  readonly workspacePath: string;
  readonly restartRuntime: () => void;
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly loadSessions: () => readonly StoredSession[] | undefined;
  readonly saveSessions: (sessions: readonly StoredSession[]) => void;
  /**
   * 上次选的模型和思考等级。ACP 的模型是会话级的（Claude 新会话总是 Default），
   * 新对话套用上次的选择，和看到的保持一致；已有的会话保持自己的模型。
   */
  readonly loadPreferredModel?: () => PreferredModel | undefined;
  readonly savePreferredModel?: (preferred: PreferredModel) => void;
  /** 打开的标签（会话 id，按顺序）；新对话的标签不保存。 */
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  /**
   * 代理要求登录时由宿主完成：有多种方式时让用户选，登录期间显示进度。
   * 返回 false 表示用户取消。没有提供时直接用第一种方式。
   */
  readonly authenticate?: (methods: readonly AuthMethod[], run: (methodId: string) => Promise<unknown>) => Promise<boolean>;
  /**
   * 代理一个进程只给一个会话推送实时更新（见 BackendProfile.singleSession）：
   * 在别的会话里发消息前用 restartRuntime 重启代理并加载那个会话；绑定的会话正在回复时不新建会话。
   */
  readonly singleSession?: boolean;
  /** 代理要求登录、又没有提供登录方式时显示的说明（例如 Claude：在终端登录 Claude Code）。 */
  readonly signInHint?: string;
  /** 当前智能体启动会话时应注入的 MCP 服务器列表。 */
  readonly mcpServers?: () => readonly McpServerConfig[];
  /** 当前智能体启动时携带的已安装 Agent Skills 上下文。 */
  readonly skillsContext?: () => {
    readonly skills: readonly InstalledSkillView[];
    readonly bundleDir?: string;
    readonly mode: AcpSkillInjectionMode;
  };
  /** 当前绑定到该 ACP 智能体的第三方服务商配置（若有）。 */
  readonly boundProvider?: () => ProviderConfig | undefined;
  /** 用户在模型选择器中切换绑定服务商的模型时通知本机代理同步映射。 */
  readonly onProviderModelSelected?: (providerId: string, model: string) => void;
}

export interface PreferredModel {
  readonly model: string;
  readonly effort?: string;
}

export interface AuthMethod {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
}

interface PendingPermission {
  readonly id: string;
  readonly sessionId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly { readonly optionId: string; readonly name?: string; readonly kind?: string }[];
  readonly resolve: (result: unknown) => void;
}

interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
  readonly images: readonly PromptImage[];
}

const MAX_TITLE = 60;

export class AcpController implements ChatBackendController {
  private link: AcpLink | undefined;
  private init: AcpInitialize | undefined;
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private activeId: string | undefined;
  /** 新对话：已经建好但还没发过消息的会话。 */
  private draftId: string | undefined;
  private creatingDraft: Promise<string | undefined> | undefined;
  private readonly projections = new Map<string, AcpSessionProjection>();
  private readonly loading = new Set<string>();
  private listed: { id: string; updatedAt: number; title?: string }[] = [];
  private stored: StoredSession[];
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly permissions = new Map<string, PendingPermission>();
  private permissionCounter = 0;
  private queueCounter = 0;
  /** 当前编辑器和用「添加到对话」固定的上下文。 */
  private readonly editorContext: EditorContext;
  /** 单会话代理：当前进程推送实时更新的会话。 */
  private bound: string | undefined;
  /** 单会话代理：正在重启代理、等待绑定到这个会话。 */
  private rebinding: { readonly sessionId: string; readonly done: (ok: boolean) => void } | undefined;
  /** 对话面板里打开的标签；当前标签的会话就是 activeId，新对话的标签（没有 sessionId）用草稿会话。 */
  private readonly tabs: TabsModel;
  /** 同一进程里最近收到的选项和命令：切换/新建标签等待 session/new 或 session/load 返回期间沿用，避免反复显示「正在读取模型…」。 */
  private cachedConfigOptions: readonly AcpConfigOption[] = [];
  private cachedCommands: readonly AcpCommand[] = [];
  /** 通用 ACP 代理下已注入过 `<available_skills>` 目录索引的会话 id。 */
  private readonly skillCatalogInjected = new Set<string>();
  private workspacePath: string;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly publisher: ViewPublisher;

  constructor(private readonly options: AcpControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.stored = [...(options.loadSessions() ?? [])];
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
    this.editorContext = new EditorContext(
      () => this.workbench,
      () => this.options.includeActiveEditor?.() ?? true,
      () => this.workspacePath,
    );
    // ACP 的每个会话都有自己的投影，后台标签的会话继续收更新，切回时内容立即可见
    this.tabs = new TabsModel({
      keyPrefix: 'acp-tab',
      load: () => this.options.loadOpenTabs?.(),
      save: (ids) => this.options.saveOpenTabs?.(ids),
      onActivate: (sessionId) => this.setActive(sessionId),
      // 关掉的标签还在等的审批取消掉（没有地方再显示）
      onClose: (tab) => tab.sessionId && this.cancelPermissions(tab.sessionId),
      onChange: () => this.scheduleRender(),
    });
    this.tabs.restore(this.activeId);
  }

  private get workbench(): Workbench {
    return this.options.workbench ?? noWorkbench;
  }

  // ---------------------------------------------------------------- 连接

  /** 代理进程初始化完成（或断开，传 undefined）。 */
  setLink(link: AcpLink | undefined, init?: AcpInitialize): void {
    this.link = link;
    this.init = init;
    this.connection = link ? 'connected' : 'idle';
    this.options.post({ type: 'connection', payload: this.connection });
    // 新进程里会话要重新加载；草稿会话和选项缓存作废
    this.projections.clear();
    this.loading.clear();
    this.draftId = undefined;
    this.creatingDraft = undefined;
    this.bound = undefined;
    this.cachedConfigOptions = [];
    this.cachedCommands = [];
    this.skillCatalogInjected.clear();
    this.cancelPermissions();
    if (link) {
      void this.refreshList();
      if (this.activeId) void this.load(this.activeId);
      else void this.ensureDraft();
    }
    this.scheduleRender();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    if (status.kind === 'failed' || status.kind === 'notInstalled') this.finishRebind(false);
    this.options.post({ type: 'runtimeStatus', payload: status });
    this.scheduleRender();
  }

  /** 代理推送的 `session/update`。 */
  onSessionUpdate(params: unknown): void {
    const { sessionId, update } = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
    if (!sessionId || !update) return;
    const projection = this.projectionFor(sessionId);
    projection.apply(update);
    this.cacheProjectionDefaults(projection);
    if (update.sessionUpdate === 'session_info_update' && projection.title) this.remember(sessionId, projection.title);
    this.scheduleRender();
  }

  /** 代理发来的请求。 */
  async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') return this.askPermission(params);
    throw new AcpError(method, -32601, `${method} is not supported by this client`);
  }

  // ---------------------------------------------------------------- 接口

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.cancelPermissions();
  }

  /** 取消等待中的审批（代理收到 cancelled）；给了会话 id 时只取消这个会话的。 */
  private cancelPermissions(sessionId?: string): void {
    for (const [id, pending] of this.permissions) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.permissions.delete(id);
    }
  }

  private buildSnapshot(view: ControllerView, includeWorkbench: boolean): HostSnapshot {
    return {
      runtime: this.runtime,
      connection: this.connection,
      sessions: view.sessions,
      tabs: view.tabs,
      session: view.session,
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
    return this.modelsOf(this.currentProjection());
  }

  allWorkspaceSessions(): readonly CrossProjectSession[] {
    const waiting = new Set([...this.permissions.values()].map((p) => p.sessionId));
    return this.compute().sessions.map((s) => ({
      id: s.id,
      title: s.title,
      cwd: this.workspacePath,
      updatedAt: s.updatedAt,
      running: s.running,
      ...(waiting.has(s.id) ? { needsAttention: true } : {}),
    }));
  }

  async startProgrammaticSession(req: ProgrammaticSessionRequest): Promise<string | undefined> {
    const link = await this.waitForLink(20_000);
    if (!link) {
      this.toast('error', t('notConnected'));
      return undefined;
    }
    this.tabs.openNew();
    const sessionId = await this.ensureDraft();
    if (!sessionId) return undefined;

    this.activeId = sessionId;
    this.draftId = undefined;
    this.options.saveActiveSessionId(sessionId);
    this.tabs.setCurrentSession(sessionId);
    if (req.title?.trim()) {
      this.remember(sessionId, req.title.trim(), true);
    }
    if (req.model?.model) {
      await this.selectModel(req.model.model, req.model.reasoningEffort);
    }
    if (req.permissionPreset) {
      const modeOpt = this.modeOption(this.projectionFor(sessionId));
      if (modeOpt?.options?.length) {
        const candidate =
          req.permissionPreset === 'danger-full-access'
            ? modeOpt.options.find((o) => isUnrestrictedMode(o.value, o.name))?.value
            : req.permissionPreset === 'read-only'
              ? modeOpt.options.find((o) => /plan|read[-_]?only/iu.test(o.value))?.value
              : undefined;
        if (candidate && candidate !== modeOpt.currentValue) {
          await this.setOption(sessionId, modeOpt.id, candidate).catch(() => undefined);
        }
      }
    }
    if (req.prompt?.trim()) {
      if (!req.title?.trim()) this.remember(sessionId, req.prompt.trim());
      void this.prompt(this.link ?? link, sessionId, req.prompt.trim(), []);
    }
    this.scheduleRender();
    return sessionId;
  }

  latestAssistantText(sessionId: string): string | undefined {
    const items = this.projections.get(sessionId)?.snapshotItems() ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === 'assistant' && item.markdown.trim()) {
        return item.markdown.trim();
      }
    }
    return undefined;
  }

  private async waitForLink(timeoutMs: number): Promise<AcpLink | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.link) return this.link;
      await new Promise((r) => setTimeout(r, 80));
    }
    return this.link;
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
    this.cancelPermissions();
    this.stored = [...(this.options.loadSessions() ?? [])];
    this.listed = [];
    this.loading.clear();
    this.creatingDraft = undefined;
    this.bound = undefined;
    this.activeId = this.options.loadActiveSessionId();
    this.draftId = undefined;
    this.projections.clear();
    this.tabs.restore(this.activeId);
    if (this.link) {
      void this.refreshList();
      if (this.activeId) void this.load(this.activeId);
      else void this.ensureDraft();
    }
    this.scheduleRender();
  }

  async askAboutSelection(template: TemplateName): Promise<void> {
    const attachment = this.editorContext.active();
    if (!attachment) {
      this.toast('info', t('context.none'));
      return;
    }
    await this.send(templatePrompt(template, ''), { includeActive: false, extra: [attachment], diagnostics: template === 'fix' });
  }

  pinActiveEditor(): void {
    if (!this.editorContext.pinActive()) {
      this.toast('info', t('context.none'));
      return;
    }
    this.scheduleRender();
    this.options.post({ type: 'focusComposer', payload: {} });
  }

  async renameSession(): Promise<void> {
    const sessionId = this.activeId;
    if (!sessionId) return;
    const title = await this.workbench.input({ title: t('rename.title'), value: this.titleOf(sessionId) });
    if (!title?.trim()) return;
    this.remember(sessionId, title.trim(), true);
    this.scheduleRender();
  }

  async configureApiKey(): Promise<void> {
    this.toast('info', t('acp.apiKey', this.agentName()));
  }

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.options.post({ type: 'snapshot', payload: this.snapshot() });
        return;
      case 'sendMessage': {
        const accepted = await this.send(message.payload.text, { includeActive: message.payload.includeActive ?? true, images: message.payload.images ?? [] });
        // 没发出去（没连上、代理正忙、建不了会话…）：输入框已经清空了，把文字放回去
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
        this.options.post({ type: 'fileCandidates', payload: { requestId: message.payload.requestId, items: items.slice(0, 50) } });
        return;
      }
      case 'removeAttachment':
        this.editorContext.unpin(message.payload.id);
        this.scheduleRender();
        return;
      case 'queueAction':
        return this.queueAction(message.payload);
      case 'renameSession':
        return this.renameSession();
      case 'configureApiKey':
        return this.configureApiKey();
      case 'selectFolder':
        this.options.selectFolder?.();
        return;
      case 'interrupt':
        return this.interrupt();
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
      case 'loadOlder':
      case 'retryPending':
      case 'discardPending':
      case 'previewApproval':
        return;
      case 'selectModel':
        return this.selectModel(message.payload.model, message.payload.reasoningEffort);
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
        this.toast('info', t('acp.noWebUI', this.agentName()));
        return;
      case 'respondApproval':
        this.respondApproval(message.payload.id, message.payload.decision);
        return;
      case 'answerQuestion':
        this.toast('info', t('question.ended'));
        return;
      case 'openDiff':
        try {
          await this.openDiff(message.payload.ref);
        } finally {
          if (message.payload.token !== undefined) this.options.post({ type: 'diffOpened', payload: { token: message.payload.token } });
        }
        return;
      case 'openFile': {
        const { path, startLine, endLine } = message.payload;
        return this.workbench.openFile(this.absolute(path), startLine ? { startLine, ...(endLine ? { endLine } : {}) } : undefined);
      }
      case 'selectPermission':
        return this.setMode(message.payload.preset);
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
        // 历史消息里的图片：ACP 没有读取附件的方法
        this.options.post({ type: 'imageData', payload: { attachmentId: message.payload.attachmentId } });
        return;
      case 'selectBackend':
      case 'checkBackendEnv':
      case 'fetchBackendVersions':
      case 'installBackend':
      case 'uninstallBackend':
      case 'upsertBackendProfile':
      case 'deleteBackendProfile':
      case 'testNotification':
      case 'setProjectWorktreeConfig':
      case 'addRecentProject':
      case 'removeRecentProject':
      case 'openProject':
      case 'createWorktree':
      case 'runProjectVerify':
      case 'previewMarkdown':
      case 'openWorkbenchPanel':
      case 'markUnreadRead':
      case 'upsertSchedule':
      case 'toggleSchedule':
      case 'deleteSchedule':
      case 'runScheduleNow':
      case 'markScheduleRunRead':
      case 'upsertAgent':
      case 'deleteAgent':
      case 'startAgentSession':
      case 'delegateToAgent':
      case 'createTask':
      case 'updateTaskStatus':
      case 'reorderTask':
      case 'deleteTask':
      case 'clearDoneTasks':
      case 'setTaskQueueAutoRun':
      case 'runTaskNow':
      case 'startProjectSession':
      case 'openProjectSession':
      case 'scanGitSkills':
      case 'installGitSkills':
      case 'updateSkill':
      case 'syncSkill':
      case 'deleteSkill':
      case 'upsertMcpServer':
      case 'toggleMcpServer':
      case 'deleteMcpServer':
      case 'scanAgentMcpConfigs':
      case 'pickMcpConfigFile':
      case 'importMcpServers':
      case 'upsertProvider':
      case 'deleteProvider':
      case 'bindProviderAgents':
      case 'fetchProviderModels':
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
    }
  }

  // ---------------------------------------------------------------- 标签

  private tabsState(current: SessionHeader): TabsState {
    const waiting = new Set([...this.permissions.values()].map((p) => p.sessionId));
    const flag = (sessionId: string | undefined) => (sessionId && waiting.has(sessionId) ? { needsAttention: true } : {});
    const items = this.tabs.view(
      { title: current.title, running: current.running, ...flag(this.tabs.current?.sessionId) },
      (sessionId) => ({ title: this.titleOf(sessionId), running: this.projections.get(sessionId)?.running ?? false, ...flag(sessionId) }),
      t('session.new'),
    );
    return { items, active: this.tabs.activeTabKey };
  }

  // ---------------------------------------------------------------- 会话

  private setActive(sessionId: string | undefined): void {
    this.tabs.setCurrentSession(sessionId);
    if (sessionId === this.activeId && (sessionId !== undefined || this.draftId !== undefined)) return;
    this.activeId = sessionId;
    this.options.saveActiveSessionId(sessionId);
    if (sessionId) void this.load(sessionId);
    else void this.ensureDraft();
    this.scheduleRender();
  }

  /** 构造传给 ACP `session/new` 与 `session/load` 的公共参数（包含 MCP 服务器与技能挂载目录）。 */
  private sessionLaunchParams(stdioOnly = false): { readonly params: Record<string, unknown>; readonly hasRemoteMcp: boolean } {
    const rawServers = this.options.mcpServers?.() ?? [];
    const hasRemoteMcp = rawServers.some((s) => s.enabled && s.transport !== 'stdio');
    const mcpServers = toAcpMcpServers(
      stdioOnly ? rawServers.filter((s) => s.transport === 'stdio') : rawServers,
      this.init?.agentCapabilities?.mcpCapabilities,
    );
    const skillCtx = this.options.skillsContext?.();
    const bundleDir = skillCtx?.bundleDir;
    const extra: Record<string, unknown> = {};
    if (bundleDir) {
      if (this.init?.agentCapabilities?.sessionCapabilities?.additionalDirectories) {
        extra.additionalDirectories = [bundleDir];
      }
      if (skillCtx?.mode === 'claude-meta') {
        extra._meta = { claudeCode: { options: { additionalDirectories: [bundleDir] } } };
      }
    }
    return {
      params: { cwd: this.workspacePath, mcpServers, ...extra },
      hasRemoteMcp,
    };
  }

  /** 打开会话：同一个进程里已经加载过的直接显示，否则用 session/load 回放历史。 */
  private async load(sessionId: string): Promise<void> {
    const link = this.link;
    if (!link || this.projections.has(sessionId) || this.loading.has(sessionId)) return;
    if (!this.init?.agentCapabilities?.loadSession) {
      this.toast('info', t('acp.noLoad', this.agentName()));
      return;
    }
    this.loading.add(sessionId);
    const projection = this.projectionFor(sessionId);
    projection.reset();
    this.scheduleRender();
    try {
      const { params, hasRemoteMcp } = this.sessionLaunchParams();
      let result: AcpSessionMeta | null;
      try {
        result = await link.request<AcpSessionMeta | null>('session/load', { sessionId, ...params });
      } catch (err) {
        if (hasRemoteMcp && err instanceof AcpError && err.code === -32602) {
          this.options.log(`${this.agentName()} 拒绝了远程 MCP 参数，回退为仅挂载 stdio MCP 服务器`);
          result = await link.request<AcpSessionMeta | null>('session/load', {
            sessionId,
            ...this.sessionLaunchParams(true).params,
          });
        } else {
          throw err;
        }
      }
      projection.setSessionMeta(result);
      this.cacheProjectionDefaults(projection);
      // 新进程里第一个加载的会话收到实时更新
      if (this.options.singleSession && this.link === link && this.bound === undefined) this.bound = sessionId;
      if (this.rebinding?.sessionId === sessionId) this.finishRebind(this.bound === sessionId);
    } catch (error) {
      if (this.rebinding?.sessionId === sessionId) this.finishRebind(false);
      this.options.log(`打开会话 ${sessionId} 失败：${describe(error)}`);
      this.toast('error', t('acp.loadFailed', describe(error)));
      this.projections.delete(sessionId);
      if (this.activeId === sessionId) this.setActive(undefined);
    } finally {
      this.loading.delete(sessionId);
      this.scheduleRender();
    }
  }

  /** 新对话的草稿会话：建好后模型、模式和斜杠命令就能用了。 */
  private ensureDraft(): Promise<string | undefined> {
    // 单会话代理：新建会话会把实时更新从正在回复的会话抢走，等这一轮结束再建（prompt 结束时补上）
    if (this.boundBusy()) return Promise.resolve(undefined);
    if (this.draftId) return Promise.resolve(this.draftId);
    if (this.creatingDraft) return this.creatingDraft;
    const link = this.link;
    if (!link) return Promise.resolve(undefined);
    this.creatingDraft = this.newSession(link)
      .then(
        async (id) => {
          if (this.link !== link) return id;
          await this.applyPreferredModel(id);
          if (this.link === link) this.draftId = id;
          return id;
        },
        (error: unknown) => {
          this.options.log(`新建会话失败：${describe(error)}`);
          this.toast('error', t('acp.newFailed', describe(error)));
          return undefined;
        },
      )
      .finally(() => {
        this.creatingDraft = undefined;
        this.scheduleRender();
      });
    return this.creatingDraft;
  }

  /**
   * `session/new`；代理要求认证（-32000）时登录后再试一次。
   * 只有一种方式时直接用（omp：用已有的本地凭据）；有多种时由宿主让用户选（CodeBuddy：浏览器登录，可能要几分钟）。
   */
  private async newSession(link: AcpLink): Promise<string> {
    const { params, hasRemoteMcp } = this.sessionLaunchParams();
    const requestNew = async (): Promise<{ sessionId: string } & AcpSessionMeta> => {
      try {
        return await link.request('session/new', params);
      } catch (err) {
        if (hasRemoteMcp && err instanceof AcpError && err.code === -32602) {
          this.options.log(`${this.agentName()} 拒绝了远程 MCP 参数，回退为仅挂载 stdio MCP 服务器`);
          return await link.request('session/new', this.sessionLaunchParams(true).params);
        }
        throw err;
      }
    };
    let result: ({ sessionId: string } & AcpSessionMeta);
    try {
      result = await requestNew();
    } catch (error) {
      if (!isAuthRequired(error)) throw error;
      if (!(await this.signIn(link))) throw new Error(this.authRequiredText(error));
      result = await requestNew();
    }
    const projection = this.projectionFor(result.sessionId);
    projection.setSessionMeta(result);
    this.cacheProjectionDefaults(projection);
    if (this.options.singleSession && this.link === link) this.bound = result.sessionId;
    return result.sessionId;
  }

  /**
   * 代理要求登录（-32000）：有登录方式时登录（多种时由宿主让用户选）。
   * @returns 登录完成；代理没有登录方式或用户取消时为 false。
   */
  private async signIn(link: AcpLink): Promise<boolean> {
    const methods = this.init?.authMethods ?? [];
    if (methods.length === 0) return false;
    const run = (methodId: string) => link.request('authenticate', { methodId });
    if (this.options.authenticate) {
      if (!(await this.options.authenticate(methods, run))) throw new Error(t('acp.signInCancelled'));
    } else {
      await run(methods[0]!.id);
    }
    return true;
  }

  /** 需要登录时给用户看的说明：底层配置里的提示（Claude），没有时用代理返回的原话。 */
  private authRequiredText(error?: unknown): string {
    return t('acp.authRequired', this.agentName(), this.options.signInHint ?? (error ? describe(error) : ''));
  }

  private async refreshList(): Promise<void> {
    const link = this.link;
    if (!link || this.init?.agentCapabilities?.sessionCapabilities?.list === undefined) return;
    try {
      const result = await link.request<{ sessions?: { sessionId: string; cwd?: string; updatedAt?: string; title?: string | null }[] }>('session/list', { cwd: this.workspacePath });
      this.listed = (result?.sessions ?? [])
        .filter((s) => !s.cwd || s.cwd === this.workspacePath)
        .map((s) => ({ id: s.sessionId, updatedAt: s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0, ...(s.title ? { title: s.title } : {}) }));
      this.scheduleRender();
    } catch (error) {
      this.options.log(`读取会话列表失败：${describe(error)}`);
    }
  }

  private projectionFor(sessionId: string): AcpSessionProjection {
    let projection = this.projections.get(sessionId);
    if (!projection) {
      projection = new AcpSessionProjection(this.workspacePath);
      this.projections.set(sessionId, projection);
    }
    return projection;
  }

  /** 当前显示的会话 id（新对话时是草稿会话）。 */
  private currentId(): string | undefined {
    return this.activeId ?? this.draftId;
  }

  private currentProjection(): AcpSessionProjection | undefined {
    const id = this.currentId();
    return id ? this.projections.get(id) : undefined;
  }

  /** 记住会话标题（第一条消息或代理给的标题）；`force` 用于手动重命名。 */
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
    return this.stored.find((s) => s.id === sessionId)?.title || this.projections.get(sessionId)?.title || this.listed.find((s) => s.id === sessionId)?.title || t('acp.untitled');
  }

  // ---------------------------------------------------------------- 发送

  /**
   * 发送一条消息（一轮进行中时在本地排队）。
   * @returns 消息是否已经交出去（发给代理或进了队列）；false 时调用方把文字还给输入框。
   */
  async send(text: string, options: GatherOptions & { images?: readonly PromptImage[] } = {}): Promise<boolean> {
    const slash = parseSlash(text);
    if (slash?.name === 'new') {
      this.tabs.openNew();
      return slash.args.trim() ? this.send(slash.args, options) : true;
    }
    // 计划模式的标记点击后发 /plan off；代理有 plan 模式时切换模式
    if (slash?.name === 'plan' && this.modeOption()?.options?.some((o) => o.value === 'plan')) {
      await this.setMode(slash.args.trim() === 'off' ? (this.modeOption()?.options?.find((o) => o.value !== 'plan')?.value ?? 'default') : 'plan');
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
      // 代理自己的斜杠命令照原样发送（ACP 里命令就是以 / 开头的消息）
      attachments = slash ? [] : this.editorContext.gather(options);
    }
    const full = withContext(prompt, attachments, this.workspacePath);
    const link = this.link;
    if (!link) {
      this.toast('error', t('notConnected'));
      return false;
    }
    if (this.options.singleSession && this.boundBusy() && this.activeId !== this.bound) {
      // 另一个会话正在回复：这个代理同一时间只能进行一个会话
      this.toast('info', t('acp.singleSessionBusy', this.agentName()));
      return false;
    }
    if (this.activeId && !(await this.bindTo(this.activeId))) return false;
    const sessionId = this.activeId ?? (await this.ensureDraft());
    if (!sessionId) {
      // 新建会话失败时 ensureDraft 已经提示过原因；这里是连接刚断开等没有提示的情况
      if (!this.link) this.toast('error', t('notConnected'));
      return false;
    }
    // 到这里消息一定会交出去：固定的上下文用完了
    this.editorContext.clearPinned();
    if (!this.activeId) {
      // 草稿会话收到第一条消息：成为正式会话，标签记住它
      this.activeId = sessionId;
      this.draftId = undefined;
      this.options.saveActiveSessionId(sessionId);
      this.tabs.setCurrentSession(sessionId);
      this.remember(sessionId, prompt || t('acp.image'));
    }
    const projection = this.projectionFor(sessionId);
    const images = options.images ?? [];
    if (projection.running) {
      const queue = this.queues.get(sessionId) ?? [];
      queue.push({ id: `q${++this.queueCounter}`, text: full, images });
      this.queues.set(sessionId, queue);
      this.scheduleRender();
      return true;
    }
    await this.prompt(this.link ?? link, sessionId, full, images);
    return true;
  }

  // ---------------------------------------------------------------- 单会话代理

  /** 绑定的会话正在回复。 */
  private boundBusy(): boolean {
    return this.options.singleSession === true && this.bound !== undefined && (this.projections.get(this.bound)?.running ?? false);
  }

  /**
   * 单会话代理：要在没有绑定的会话里发消息时，重启代理，新进程第一个加载这个会话，于是收得到实时更新。
   * 其他代理直接返回 true。
   */
  private async bindTo(sessionId: string): Promise<boolean> {
    if (!this.options.singleSession || this.bound === sessionId || this.bound === undefined) return true;
    this.options.log(`${this.agentName()} 只给一个会话推送更新：重启后加载会话 ${sessionId}`);
    this.finishRebind(false);
    const bound = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.finishRebind(false), 60_000);
      this.rebinding = {
        sessionId,
        done: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
    this.options.restartRuntime();
    const ok = await bound;
    if (!ok) this.toast('error', t('acp.rebindFailed', this.agentName()));
    return ok;
  }

  private finishRebind(ok: boolean): void {
    const pending = this.rebinding;
    this.rebinding = undefined;
    pending?.done(ok);
  }

  private async prompt(link: AcpLink, sessionId: string, text: string, images: readonly PromptImage[]): Promise<void> {
    const projection = this.projectionFor(sessionId);
    const allowImages = this.init?.agentCapabilities?.promptCapabilities?.image === true;
    if (images.length && !allowImages) this.toast('info', t('acp.noImages', this.agentName()));
    const sent = allowImages ? images : [];
    projection.addUserMessage(
      text,
      sent.map((image): ImageView => ({ localId: image.localId, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })),
    );
    projection.startTurn(Date.now());
    this.scheduleRender();
    const wireText = this.enrichPromptWithSkills(sessionId, text);
    const content = [
      ...(wireText.trim() ? [{ type: 'text', text: wireText }] : []),
      ...sent.map((image) => ({ type: 'image', mimeType: image.mediaType, data: image.data })),
    ];
    const send = () => link.request<{ stopReason?: string } | null>('session/prompt', { sessionId, prompt: content });
    let endedNormally = false;
    try {
      let result: { stopReason?: string } | null;
      try {
        result = await send();
      } catch (error) {
        // 登录过期或还没登录（Claude 在发消息时才发现）：能登录就登录后重发这一轮
        if (!isAuthRequired(error) || !(await this.signIn(link).catch(() => false))) throw error;
        result = await send();
      }
      const stopReason = result?.stopReason ?? 'end_turn';
      projection.endTurn(Date.now(), stopReason);
      endedNormally = stopReason !== 'cancelled';
    } catch (error) {
      projection.endTurn(Date.now(), undefined, isAuthRequired(error) ? this.authRequiredText(error) : describe(error));
    }
    this.remember(sessionId, this.titleOf(sessionId));
    void this.refreshList();
    this.scheduleRender();
    // 本地排队的消息：仅在上一轮正常结束（未被停止或报错）时自动发送；停止后保留在队列里等用户点击「现在发送」
    const next = endedNormally && this.link ? this.queues.get(sessionId)?.shift() : undefined;
    if (next && this.link) await this.prompt(this.link, sessionId, next.text, next.images);
    // 单会话代理：回复期间点了新对话，草稿会话这时才建
    else if (this.options.singleSession && this.link && this.activeId === undefined && this.draftId === undefined) void this.ensureDraft();
  }

  private async interrupt(): Promise<void> {
    const sessionId = this.currentId();
    if (!sessionId || !this.link) return;
    this.cancelPermissions(sessionId);
    this.link.notify('session/cancel', { sessionId });
    this.scheduleRender();
  }

  private queueAction(payload: Extract<WebviewToHost, { type: 'queueAction' }>['payload']): void {
    const sessionId = this.currentId();
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
      const running = this.currentProjection()?.running ?? false;
      if (!running && this.link) {
        this.scheduleRender();
        void this.prompt(this.link, sessionId, item.text, item.images);
        return;
      }
      queue.unshift(item);
    } else if (payload.action === 'steer') {
      // 没有插队：移到队首，当前回复结束后最先发送
      const [item] = queue.splice(index, 1);
      queue.unshift(item!);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模型、模式

  private cacheProjectionDefaults(projection: AcpSessionProjection): void {
    if (projection.configOptions.length > 0) this.cachedConfigOptions = projection.configOptions;
    if (projection.commands.length > 0) this.cachedCommands = projection.commands;
  }

  private effectiveOptions(projection = this.currentProjection()): readonly AcpConfigOption[] {
    return projection?.configOptions.length ? projection.configOptions : this.cachedConfigOptions;
  }

  private modelOption(projection = this.currentProjection()): AcpConfigOption | undefined {
    return this.effectiveOptions(projection).find((o) => o.category === 'model' || o.id === 'model');
  }

  private effortOption(projection = this.currentProjection()): AcpConfigOption | undefined {
    return this.effectiveOptions(projection).find((o) => o.category === 'thought_level' || o.id === 'thought_level' || o.id === 'reasoning_effort');
  }

  private modeOption(projection = this.currentProjection()): AcpConfigOption | undefined {
    return this.effectiveOptions(projection).find((o) => o.category === 'mode' || o.id === 'mode');
  }

  private modelsOf(projection: AcpSessionProjection | undefined): ModelState {
    const bound = this.options.boundProvider?.();
    const model = this.modelOption(projection);
    const effort = this.effortOption(projection);
    const acpEfforts = (effort?.options ?? []).map((o) => ({ id: o.value, name: o.name ?? o.value }));

    if (bound && bound.models.length > 0) {
      const saved = this.options.loadPreferredModel?.();
      const boundOptions: ModelOption[] = bound.models.map((m) => {
        const itemEfforts =
          m.efforts && m.efforts.length > 0 ? m.efforts.map((e) => ({ id: e, name: e })) : acpEfforts;
        return {
          provider: bound.id,
          model: m.id,
          name: m.name || m.id,
          group: bound.name,
          efforts: itemEfforts,
          ...(itemEfforts[0] ? { defaultEffort: itemEfforts[0].id } : {}),
        };
      });
      const chosenModel =
        (saved?.model && bound.models.some((m) => m.id === saved.model) ? saved.model : undefined) ??
        (bound.defaultModel && bound.models.some((m) => m.id === bound.defaultModel) ? bound.defaultModel : undefined) ??
        bound.models[0]!.id;
      const chosenOption = boundOptions.find((o) => o.model === chosenModel) ?? boundOptions[0]!;
      const chosenEffort =
        (saved?.effort && chosenOption.efforts.some((e) => e.id === saved.effort) ? saved.effort : undefined) ??
        effort?.currentValue ??
        chosenOption.defaultEffort;
      return {
        options: boundOptions,
        current: {
          provider: bound.id,
          model: chosenModel,
          ...(chosenEffort ? { reasoningEffort: chosenEffort } : {}),
        },
      };
    }

    if (!model?.options?.length) return { options: [] };
    const efforts = acpEfforts;
    const usingFallback = !projection?.configOptions.length;
    const preferred = usingFallback && !this.activeId ? this.options.loadPreferredModel?.() : undefined;
    const activeModel =
      preferred && model.options.some((o) => o.value === preferred.model) ? preferred.model : model.currentValue;
    const activeEffort =
      preferred && activeModel === preferred.model && preferred.effort && efforts.some((e) => e.id === preferred.effort)
        ? preferred.effort
        : effort?.currentValue;
    // 当前模型不在代理给的选项里（CodeBuddy 接第三方模型、命令行 --model 指定）：补在最前面，选择器才显示得出来
    const options = activeModel && !model.options.some((o) => o.value === activeModel) ? [{ value: activeModel, name: activeModel }, ...model.options] : model.options;
    return {
      options: options.map((o: { value: string; name?: string; description?: string }) => ({
        provider: 'acp',
        model: o.value,
        name: o.name ?? o.value,
        group: o.value.includes('/') ? o.value.slice(0, o.value.indexOf('/')) : this.agentName(),
        ...(o.description && o.description !== o.value ? { description: o.description } : {}),
        // 思考等级是会话级的设置：挂在每个模型选项上，便于上方选模型、下方直接调思考等级
        efforts,
        ...(activeEffort ? { defaultEffort: activeEffort } : {}),
      })),
      ...(activeModel ? { current: { provider: 'acp', model: activeModel, ...(activeEffort ? { reasoningEffort: activeEffort } : {}) } } : {}),
    };
  }

  private async selectModel(model: string, effort?: string): Promise<void> {
    const bound = this.options.boundProvider?.();
    if (bound) {
      this.options.onProviderModelSelected?.(bound.id, model);
    }
    this.options.savePreferredModel?.({ model, ...(effort ? { effort } : {}) });
    this.scheduleRender();
    const sessionId = this.currentId() ?? (await this.ensureDraft());
    const option = this.modelOption(this.currentProjection());
    if (!sessionId || !option) return;
    try {
      const prefixed = bound ? `${bound.id}/${model}` : undefined;
      const acpModelValue =
        option.options?.some((o) => o.value === model)
          ? model
          : prefixed && option.options?.some((o) => o.value === prefixed)
            ? prefixed
            : bound
              ? undefined
              : model;
      if (acpModelValue && acpModelValue !== option.currentValue) {
        await this.setOption(sessionId, option.id, acpModelValue);
      }
      const effortOption = this.effortOption(this.currentProjection());
      if (effort && effortOption && effort !== effortOption.currentValue && (!bound || effortOption.options?.some((o) => o.value === effort))) {
        await this.setOption(sessionId, effortOption.id, effort);
      }
      // 已经建好、还没用过的草稿会话也换过来
      if (this.draftId && this.draftId !== sessionId) await this.applyPreferredModel(this.draftId);
    } catch (error) {
      if (!bound) this.toast('error', t('model.failed', describe(error)));
    }
  }

  /** 新对话（草稿会话）套用上次选的模型和思考等级；代理没有这个选项时不动。 */
  private async applyPreferredModel(sessionId: string): Promise<void> {
    const preferred = this.options.loadPreferredModel?.();
    const projection = this.projections.get(sessionId);
    if (!preferred || !projection || projection.snapshotItems().length > 0) return;
    try {
      const model = this.modelOption(projection);
      if (model && model.currentValue !== preferred.model && model.options?.some((o) => o.value === preferred.model)) {
        await this.setOption(sessionId, model.id, preferred.model);
      }
      // 思考等级的选项随模型变化：换完模型再看
      const effort = this.effortOption(this.projections.get(sessionId));
      if (preferred.effort && effort && effort.currentValue !== preferred.effort && effort.options?.some((o) => o.value === preferred.effort)) {
        await this.setOption(sessionId, effort.id, preferred.effort);
      }
    } catch (error) {
      this.options.log(`新对话套用上次的模型失败：${describe(error)}`);
    }
  }

  private async setMode(mode: string): Promise<void> {
    const sessionId = this.currentId() ?? (await this.ensureDraft());
    const option = this.modeOption();
    if (!sessionId || !option || option.currentValue === mode) return;
    // 不再逐项询问的模式（Claude 的 bypassPermissions、各家的 yolo / full access）：和 dsh 的完全访问一样先确认
    const target = option.options?.find((o) => o.value === mode);
    if (isUnrestrictedMode(mode, target?.name)) {
      const name = target?.name ?? mode;
      if (!(await this.workbench.confirm(t('acp.dangerTitle', name), t('acp.dangerDetail', this.agentName(), name), t('acp.dangerAllow', name)))) return;
    }
    try {
      await this.setOption(sessionId, option.id, mode);
    } catch (error) {
      this.toast('error', t('permission.failed', describe(error)));
    }
  }

  private async setOption(sessionId: string, configId: string, value: string): Promise<void> {
    const projection = this.projectionFor(sessionId);
    const currentOpt = this.effectiveOptions(projection).find((o) => o.id === configId || o.category === configId);
    if (currentOpt?.legacyMethod === 'session/set_model') {
      const result = await this.link?.request<AcpSessionMeta | null>('session/set_model', { sessionId, modelId: value });
      projection.updateOptionValue('model', value);
      projection.setSessionMeta(result);
    } else if (currentOpt?.legacyMethod === 'session/set_mode') {
      const result = await this.link?.request<AcpSessionMeta | null>('session/set_mode', { sessionId, modeId: value });
      projection.updateOptionValue('mode', value);
      projection.setSessionMeta(result);
    } else {
      const result = await this.link?.request<AcpSessionMeta | null>('session/set_config_option', { sessionId, configId, value });
      projection.updateOptionValue(configId, value);
      projection.setSessionMeta(result);
    }
    this.cacheProjectionDefaults(projection);
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 审批

  private askPermission(params: unknown): Promise<unknown> {
    const { sessionId, toolCall, options } = (params ?? {}) as { sessionId?: string; toolCall?: AcpToolCall; options?: PendingPermission['options'] };
    if (!sessionId || !toolCall || !options?.length) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    // 请求里可能只有 toolCallId 和参数（CodeBuddy）：用已经收到的工具调用补上标题、类型和位置
    const known = this.projections.get(sessionId)?.toolCall(toolCall.toolCallId);
    const call: AcpToolCall = known ? { ...known, ...Object.fromEntries(Object.entries(toolCall).filter(([, v]) => v !== undefined && v !== null)) } : toolCall;
    return new Promise((resolvePermission) => {
      const id = `perm-${++this.permissionCounter}`;
      this.permissions.set(id, { id, sessionId, toolCall: call, options, resolve: resolvePermission });
      this.scheduleRender();
    });
  }

  private respondApproval(id: string, decision: 'allow' | 'allowAlways' | 'reject'): void {
    const pending = this.permissions.get(id);
    if (!pending) {
      this.toast('info', t('request.ended'));
      return;
    }
    if (decision !== 'reject' && this.dirtyTargets(pending).length > 0) {
      // 编辑器里还有未保存的内容，代理直接写磁盘后会和编辑器冲突
      this.toast('error', t('approval.dirty'));
      return;
    }
    const pick = (prefix: string) => pending.options.find((o) => o.kind === `${prefix}_once`) ?? pending.options.find((o) => o.kind?.startsWith(prefix));
    const option = decision === 'allowAlways' ? (pending.options.find((o) => o.kind === 'allow_always') ?? pick('allow')) : decision === 'allow' ? pick('allow') : pick('reject');
    this.permissions.delete(id);
    pending.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
    this.scheduleRender();
  }

  /** 审批要改的文件（绝对路径）；不是修改文件的工具时为 undefined。 */
  private editTarget(pending: PendingPermission): string | undefined {
    const call = pending.toolCall;
    if (call.kind !== 'edit' && call.kind !== 'delete' && call.kind !== 'move' && !(call.content ?? []).some((c) => c.type === 'diff')) return undefined;
    const path = call.locations?.[0]?.path ?? inputFilePath(call.rawInput);
    return path ? this.absolute(path) : undefined;
  }

  /** 要改的文件里在编辑器中有未保存内容的（显示用的路径）。 */
  private dirtyTargets(pending: PendingPermission): string[] {
    const target = this.editTarget(pending);
    return target && this.workbench.dirtyFiles().includes(target) ? [displayPath(target, this.workspacePath)] : [];
  }

  private interactionOf(pending: PendingPermission): PendingInteraction {
    const call = pending.toolCall;
    const args = (call.rawInput ?? {}) as { command?: unknown };
    const path = call.locations?.[0]?.path ?? inputFilePath(call.rawInput);
    const subject =
      typeof args.command === 'string' && args.command.trim()
        ? { subject: args.command.trim(), subjectKind: 'command' as const }
        : path
          ? { subject: displayPath(path, this.workspacePath), subjectKind: 'file' as const }
          : undefined;
    const always = pending.options.find((o) => o.kind === 'allow_always');
    return {
      kind: 'approval',
      id: pending.id,
      toolName: call.name ?? call.kind ?? 'tool',
      reason: call.title ?? '',
      ...(subject ?? {}),
      previewable: false,
      dirtyFiles: this.dirtyTargets(pending),
      ...(always ? { allowAlways: always.name?.trim() || t('acp.allowAlways') } : {}),
    };
  }

  // ---------------------------------------------------------------- Diff

  private async openDiff(ref: DiffRef): Promise<void> {
    if (ref.kind === 'session') return this.openSessionDiff(ref.path);
    if (ref.kind !== 'tool') return;
    const diffs = this.currentProjection()?.diffsOf(ref.callId) ?? [];
    const diff = diffs[0];
    if (!diff) {
      this.toast('info', t('diff.noRecord'));
      return;
    }
    const path = this.absolute(diff.path);
    // 磁盘上的文件就是修改后的内容时右侧用真实文件（可以继续编辑）
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

  /**
   * 本会话对一个文件的累计改动：从磁盘上的当前内容倒着撤回这个会话的每次修改，还原出会话开始前的内容。
   * 中途被别的方式改过、撤不回去时，改为显示最后一次修改。
   */
  private async openSessionDiff(path: string): Promise<void> {
    const change = this.currentProjection()
      ?.fileChanges()
      .find((f) => this.absolute(f.path) === path);
    if (!change || change.diffs.length === 0) return this.workbench.openFile(path);
    const current = await this.workbench.readFile(path);
    const before = current === undefined ? undefined : reverseToolDiffs(current, change.diffs);
    if (before !== undefined) {
      await this.workbench.openDiff({ kind: 'contents', path, before: change.created ? '' : before, created: change.created, scope: 'session' });
      return;
    }
    this.options.log(`无法还原 ${path} 在本会话修改前的内容，改为显示最后一次修改`);
    const last = change.calls.at(-1);
    if (last) return this.openDiff({ kind: 'tool', callId: last });
    return this.workbench.openFile(path);
  }

  /** 输入框上方的改动栏：本会话改过的文件和增删行数。 */
  private sessionChanges(projection: AcpSessionProjection | undefined): SessionChangesView | undefined {
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
    return { files: views, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) };
  }

  // ---------------------------------------------------------------- 视图

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
    const sessionId = this.currentId();
    const projection = this.currentProjection();
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
    const mode = this.modeOption(projection);
    const session: SessionHeader = {
      ...(this.activeId ? { id: this.activeId } : {}),
      title: this.titleOf(this.activeId),
      running,
      hasOlder: false,
      loadingOlder: false,
      sync: !this.activeId ? 'idle' : this.loading.has(this.activeId) || !this.link ? 'opening' : 'live',
      ...(usage ? { contextUsage: Math.min(1, usage.used / usage.size), contextTokens: { used: usage.used, window: usage.size } } : {}),
      ...(mode?.currentValue === 'plan' ? { planMode: true } : {}),
      ...(projection?.todos?.length ? { todos: projection.todos } : {}),
      ...(running && projection?.runningSince !== undefined ? { runningSince: projection.runningSince } : {}),
      ...(this.options.folderLabel?.() ? { folder: this.options.folderLabel() } : {}),
      ...(() => {
        const changes = this.sessionChanges(projection);
        return changes ? { changes } : {};
      })(),
    };
    // 等着审批的会话在列表里标出来：它的标签可能已经关了，不标就没有任何地方看得到
    const waiting = new Set([...this.permissions.values()].map((p) => p.sessionId));
    const state = (id: string) => ({ running: this.projections.get(id)?.running ?? false, ...(waiting.has(id) ? { needsAttention: true } : {}) });
    const known = new Map<string, SessionListItem>();
    for (const s of this.listed) known.set(s.id, { id: s.id, title: this.titleOf(s.id), updatedAt: s.updatedAt, ...state(s.id) });
    for (const s of this.stored) {
      if (!known.has(s.id) && (this.init?.agentCapabilities?.sessionCapabilities?.list === undefined || this.projections.has(s.id))) {
        known.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt, ...state(s.id) });
      }
    }
    const isHidden = this.options.isHiddenSession;
    const sessions = [...known.values()]
      .filter((s) => s.id !== this.draftId && !isHidden?.(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const interactions = [...this.permissions.values()].filter((p) => p.sessionId === sessionId).map((p) => this.interactionOf(p));
    const permissions: PermissionState = {
      options: (mode?.options ?? []).map((o) => o.value),
      ...(mode?.currentValue ? { current: mode.currentValue } : {}),
      labels: Object.fromEntries((mode?.options ?? []).map((o) => [o.value, { name: o.name ?? o.value, ...(o.description ? { description: o.description } : {}) }])),
    };
    const agentCommands = projection?.commands.length ? projection.commands : this.cachedCommands;
    const baseCommands: CommandView[] = [
      ...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })),
      ...agentCommands.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        ...(c.input?.hint ? { hint: c.input.hint } : {}),
        source: c._meta?.type === 'skill' ? ('skill' as const) : ('agent' as const),
      })),
    ];
    const takenNames = new Set(baseCommands.map((c) => c.name));
    const extraSkills: CommandView[] = (this.options.skillsContext?.().skills ?? [])
      .filter((s) => !takenNames.has(s.name))
      .map((s) => ({ name: s.name, description: s.description, source: 'skill' as const }));
    const commands: CommandView[] = [...baseCommands, ...extraSkills];
    return {
      sessionKey: this.activeId ?? '',
      sessions,
      tabs: this.tabsState(session),
      session,
      items,
      models: this.modelsOf(projection),
      interactions,
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
      context: this.editorContext.state(),
      commands,
    };
  }

  private enrichPromptWithSkills(sessionId: string, text: string): string {
    const skillCtx = this.options.skillsContext?.();
    if (!skillCtx || skillCtx.skills.length === 0 || skillCtx.mode !== 'prompt') return text;

    const projection = this.projections.get(sessionId);
    const agentCommandNames = new Set(
      (projection?.commands.length ? projection.commands : this.cachedCommands).map((c) => c.name),
    );
    const slash = parseSlash(text);
    let body = text;
    if (slash && !agentCommandNames.has(slash.name)) {
      const matched = skillCtx.skills.find((s) => s.name === slash.name || s.id === slash.name);
      if (matched) {
        const taskPart = slash.args.trim() ? `\n\nTask: ${slash.args.trim()}` : '';
        body = `Use the Agent Skill "${matched.name}" by reading its instructions at "${matched.skillMdPath}".${taskPart}`;
      }
    }

    if (!this.skillCatalogInjected.has(sessionId)) {
      this.skillCatalogInjected.add(sessionId);
      const catalog = formatSkillsPromptCatalog(skillCtx.skills);
      if (catalog) return `${catalog}\n\n${body}`;
    }
    return body;
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workspacePath, path);
  }

  private backends(): BackendsState {
    return this.options.backends?.() ?? { items: [], active: '' };
  }

  private agentName(): string {
    const state = this.backends();
    return state.items.find((b) => b.id === state.active)?.name ?? this.init?.agentInfo?.title ?? this.init?.agentInfo?.name ?? 'ACP';
  }

  private toast(level: 'info' | 'error', text: string): void {
    this.options.post({ type: 'toast', payload: { level, text } });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 代理只给了替换的片段（CodeBuddy 的 Edit：old_string → new_string）时，用磁盘上的文件还原整个文件的修改前内容，
 * 这样 Diff 显示整个文件、右侧是真实文件。片段在文件里不是正好出现一次（之后又改过）时返回 undefined，只显示片段。
 */
export function wholeFile(diff: AcpDiff, current: string | undefined): string | undefined {
  if (current === undefined || diff.oldText === null || current === diff.newText || !diff.newText) return undefined;
  const at = current.indexOf(diff.newText);
  if (at < 0 || current.indexOf(diff.newText, at + 1) >= 0) return undefined;
  return current.slice(0, at) + diff.oldText + current.slice(at + diff.newText.length);
}

/** 模式的 id 或名称表明它不再逐项询问（bypassPermissions、yolo、full access、dontAsk…）。 */
export function isUnrestrictedMode(id: string, name?: string): boolean {
  return /bypass|yolo|danger|full[\s_-]?(access|auto)|dont[\s_-]?ask|skip[\s_-]?permission|unrestricted|auto[\s_-]?approve/iu.test(`${id} ${name ?? ''}`);
}

/** ACP 的「需要认证」错误（RequestError.authRequired，-32000）。 */
function isAuthRequired(error: unknown): boolean {
  return error instanceof AcpError && error.code === -32000;
}

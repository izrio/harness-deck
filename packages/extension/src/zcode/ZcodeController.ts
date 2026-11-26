/**
 * ZCode 原生控制器（`zcode app-server --stdio`）：
 * 实现与 dsh `ChatController`、ACP `AcpController` 完全一致的 `ChatBackendController` 接口，
 * 支持逐字流式回复与推理、工具行归并与 Diff、审批与提问卡片、排队与运行中插队（`session/steer`）、
 * 多标签、跨项目会话汇总以及工作台无人值守/编程式会话启动。
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
import { isUnrestrictedMode, wholeFile, type StoredSession } from '../acp/AcpController.ts';
import { isPathInsideProject } from '../projects/ProjectService.ts';
import {
  renderDelay,
  type ChatBackendController,
  type ControllerHostOptions,
  type CrossProjectSession,
  type ProgrammaticSessionRequest,
} from '../backend/types.ts';
import { getLocale, t } from '../i18n.ts';
import { mcpServersForBackend, toAcpMcpServers } from '../extensions/mcpService.ts';
import { formatSkillsPromptCatalog, skillsForBackend } from '../extensions/skillService.ts';
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
import { ZcodeError, type ZcodeLink } from './connection.ts';
import { defaultRuntimePreferences, extractZcodeSessionId, ZCODE_DELIVERY_KIND, ZcodeInteractionManager } from './interactions.ts';
import { ZcodeSessionProjection } from './projection.ts';

export interface ZcodePreferredModel {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface ZcodeControllerOptions extends ControllerHostOptions {
  readonly workspacePath: string;
  readonly restartRuntime: () => void;
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly loadSessions: () => readonly StoredSession[] | undefined;
  readonly saveSessions: (sessions: readonly StoredSession[]) => void;
  readonly loadPreferredModel?: () => ZcodePreferredModel | undefined;
  readonly savePreferredModel?: (preferred: ZcodePreferredModel) => void;
  readonly loadSessionModels?: () => Readonly<Record<string, ZcodePreferredModel>> | undefined;
  readonly saveSessionModels?: (models: Readonly<Record<string, ZcodePreferredModel>>) => void;
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  readonly signInHint?: string;
  readonly boundProvider?: () => ProviderConfig | undefined;
  readonly onProviderModelSelected?: (providerId: string, model: string, sessionId?: string) => void;
}

interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
  readonly images: readonly PromptImage[];
}

interface ListedSession {
  readonly id: string;
  readonly cwd?: string;
  readonly updatedAt: number;
  readonly title?: string;
}

const MAX_TITLE = 60;

const DEFAULT_MODES: readonly { readonly id: string; readonly zh: string; readonly en: string }[] = [
  { id: 'auto', zh: '自动审批（Auto）', en: 'Auto' },
  { id: 'plan', zh: '计划模式（Plan）', en: 'Plan' },
  { id: 'build', zh: '开发模式（Build）', en: 'Build' },
  { id: 'yolo', zh: '完全放行（YOLO）', en: 'Full Access (YOLO)' },
];

export class ZcodeController implements ChatBackendController {
  private link: ZcodeLink | undefined;
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private activeId: string | undefined;
  private workspacePath: string;
  private readonly projections = new Map<string, ZcodeSessionProjection>();
  private readonly subscribed = new Set<string>();
  private readonly loading = new Set<string>();
  private listed: ListedSession[] = [];
  private stored: StoredSession[];
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private queueCounter = 0;
  private modelOptions: ModelOption[] = [];
  private hasRuntimeModelCatalog = false;
  private selectedModel: ZcodePreferredModel | undefined;
  private readonly sessionModels = new Map<string, ZcodePreferredModel>();
  private draftMode = 'auto';
  /** 回复进行中用户切换的权限模式，延后到下一轮发送前生效。 */
  private readonly pendingModes = new Map<string, string>();
  private agentCommands: CommandView[] = [];
  private readonly skillCatalogInjected = new Set<string>();
  private readonly editorContext: EditorContext;
  private readonly tabs: TabsModel;
  private readonly interactions: ZcodeInteractionManager;
  private readonly publisher: ViewPublisher;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ZcodeControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.stored = [...(options.loadSessions() ?? [])];
    this.selectedModel = options.loadPreferredModel?.();
    const restoredSessionModels = options.loadSessionModels?.();
    if (restoredSessionModels) {
      for (const [sid, model] of Object.entries(restoredSessionModels)) {
        if (sid && model?.provider && model?.model) {
          this.sessionModels.set(sid, model);
        }
      }
    }
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
    this.editorContext = new EditorContext(
      () => this.workbench,
      () => this.options.includeActiveEditor?.() ?? true,
      () => this.workspacePath,
    );
    this.interactions = new ZcodeInteractionManager(
      () => this.workspacePath,
      () => this.workbench.dirtyFiles(),
      (sid, callId) => this.projections.get(sid)?.toolCall(callId),
      () => this.scheduleRender(),
    );
    this.tabs = new TabsModel({
      keyPrefix: 'zcode-tab',
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

  setLink(link: ZcodeLink | undefined): void {
    this.link = link;
    this.connection = link ? 'connected' : 'idle';
    this.options.post({ type: 'connection', payload: this.connection });
    this.projections.clear();
    this.subscribed.clear();
    this.loading.clear();
    this.interactions.clear();
    if (link) {
      void this.refreshCatalogs();
      void this.refreshList();
      if (this.activeId) void this.openExisting(this.activeId);
    }
    this.scheduleRender();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    this.options.post({ type: 'runtimeStatus', payload: status });
    this.scheduleRender();
  }

  onNotification(method: string, params: unknown): void {
    if (method !== 'session/event' && !method.startsWith('turn.') && !method.startsWith('model.') && !method.startsWith('tool.') && !method.startsWith('session.')) {
      return;
    }
    const obj = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const inner = obj.event && typeof obj.event === 'object' ? (obj.event as Record<string, unknown>) : undefined;
    const sessionId =
      typeof obj.sessionId === 'string' && obj.sessionId
        ? obj.sessionId
        : typeof inner?.sessionId === 'string' && inner.sessionId
          ? inner.sessionId
          : this.activeId;
    if (!sessionId) return;

    const projection = this.projectionFor(sessionId);
    const wasRunning = projection.running;
    const eventPayload = method === 'session/event' ? obj : { type: method, payload: obj };
    projection.applyEvent(eventPayload);
    if (projection.title) this.remember(sessionId, projection.title);

    const eventType = typeof inner?.type === 'string' ? inner.type : typeof obj.type === 'string' ? obj.type : method;
    if (wasRunning && !projection.running && (eventType === 'turn.completed' || eventType === 'turn/end')) {
      void this.drainQueue(sessionId);
    }
    this.scheduleRender();
  }

  async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/requestRuntimePreferences') {
      return defaultRuntimePreferences(false);
    }
    if (method === 'interaction/requestPermission' || method === 'session/requestPermission' || method === 'permission/request') {
      return this.interactions.requestPermission(params, this.activeId);
    }
    if (method === 'interaction/requestUserInput' || method === 'session/requestUserInput' || method === 'askUserQuestion') {
      return this.interactions.requestUserInput(params, this.activeId);
    }
    if (method === 'provider/updateAccountConfig') {
      return { ok: true };
    }
    throw new ZcodeError(method, -32601, `${method} is not supported by this host`);
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
    for (const s of this.listed) {
      byId.set(s.id, {
        id: s.id,
        title: this.titleOf(s.id),
        cwd: s.cwd ?? '',
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
    if (req.title?.trim()) this.remember(sessionId, req.title.trim(), true);
    if (req.model?.model) {
      await this.selectModel(req.model.provider ?? 'zai', req.model.model, req.model.reasoningEffort);
    }
    if (req.permissionPreset) {
      const targetMode =
        req.permissionPreset === 'danger-full-access'
          ? 'yolo'
          : req.permissionPreset === 'read-only'
            ? 'plan'
            : 'auto';
      await this.applyMode(sessionId, targetMode, true);
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
    this.listed = [];
    this.loading.clear();
    this.subscribed.clear();
    this.activeId = this.options.loadActiveSessionId();
    this.projections.clear();
    this.tabs.restore(this.activeId);
    if (this.link) {
      void this.refreshList();
      if (this.activeId) void this.openExisting(this.activeId);
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
    await this.link?.request('session/rename', { sessionId, title: trimmed }).catch(() => undefined);
    this.scheduleRender();
  }

  async configureApiKey(): Promise<void> {
    this.toast('info', t('zcode.apiKey'));
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
        this.options.post({ type: 'fileCandidates', payload: { requestId: message.payload.requestId, items: items.slice(0, 50) } });
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
        this.toast('info', t('acp.noWebUI', 'ZCode'));
        return;
      case 'respondApproval': {
        const outcome = this.interactions.respondApproval(message.payload.id, message.payload.decision);
        if (!outcome.ok && outcome.error) {
          this.toast(outcome.error === t('approval.dirty') ? 'error' : 'info', outcome.error);
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
          if (message.payload.token !== undefined) this.options.post({ type: 'diffOpened', payload: { token: message.payload.token } });
        }
        return;
      case 'openFile': {
        const { path, startLine, endLine } = message.payload;
        return this.workbench.openFile(this.absolute(path), startLine ? { startLine, ...(endLine ? { endLine } : {}) } : undefined);
      }
      case 'selectPermission':
        await this.setMode(message.payload.preset, message.payload.confirmed);
        return;
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
    const link = this.link;
    if (!link || this.subscribed.has(sessionId) || this.loading.has(sessionId)) return;
    this.loading.add(sessionId);
    const projection = this.projectionFor(sessionId);
    this.scheduleRender();
    try {
      const resumed = await link.request<Record<string, unknown> | null>('session/resume', { sessionId }).catch(() => null);
      this.applySessionModelCatalog(resumed);
      await link.request('session/subscribe', { sessionId, deliveryKind: ZCODE_DELIVERY_KIND });
      this.subscribed.add(sessionId);
      const [readState, messagesRes] = await Promise.all([
        link.request<Record<string, unknown> | null>('session/read', { sessionId }).catch(() => null),
        link.request<unknown>('session/messages', { sessionId }).catch(() => undefined),
      ]);
      this.applySessionModelCatalog(readState);
      projection.applySnapshot(readState, messagesRes);
      if (projection.title) this.remember(sessionId, projection.title);
    } catch (error) {
      this.options.log(`打开 ZCode 会话 ${sessionId} 失败：${describe(error)}`);
      this.toast('error', t('acp.loadFailed', describe(error)));
      if (this.activeId === sessionId) this.setActive(undefined);
    } finally {
      this.loading.delete(sessionId);
      this.scheduleRender();
    }
  }

  private async createBackendSession(link: ZcodeLink): Promise<string | undefined> {
    try {
      const mcpServers = toAcpMcpServers(
        mcpServersForBackend(this.options.runtimeMcpServers?.() ?? this.options.extensions?.().mcp.servers ?? [], 'zcode'),
      );
      const created = await link.request<Record<string, unknown> | null>('session/create', {
        workspace: { workspacePath: this.workspacePath, workspaceKey: this.workspacePath },
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
      });
      const sessionId = extractZcodeSessionId(created);
      if (!sessionId) throw new Error('missing sessionId in session/create');
      await link.request('session/subscribe', { sessionId, deliveryKind: ZCODE_DELIVERY_KIND });
      this.subscribed.add(sessionId);
      const projection = this.projectionFor(sessionId);
      if (created && typeof created === 'object') {
        projection.applyMetadata(created);
        this.applySessionModelCatalog(created);
      }
      if (this.draftMode && projection.mode !== this.draftMode) {
        projection.mode = this.draftMode;
        await this.applyMode(sessionId, this.draftMode, true);
      }
      const initial = this.buildModelState(undefined).current;
      if (initial) {
        this.sessionModels.set(sessionId, {
          provider: initial.provider,
          model: initial.model,
          ...(initial.reasoningEffort ? { effort: initial.reasoningEffort } : {}),
        });
        this.persistSessionModels();
        await link
          .request('session/setModel', {
            sessionId,
            model: {
              providerId: initial.provider,
              modelId: initial.model,
              ...(initial.reasoningEffort ? { options: { reasoningLevel: initial.reasoningEffort } } : {}),
            },
          })
          .catch(() => undefined);
      }
      return sessionId;
    } catch (error) {
      this.options.log(`新建 ZCode 会话失败：${describe(error)}`);
      this.toast('error', t('acp.newFailed', this.describeAuthOrError(error)));
      return undefined;
    }
  }

  private async ensureSessionActive(link: ZcodeLink, sessionId: string): Promise<void> {
    if (this.subscribed.has(sessionId)) return;
    const resumed = await link.request<Record<string, unknown> | null>('session/resume', { sessionId }).catch(() => null);
    this.applySessionModelCatalog(resumed);
    await link.request('session/subscribe', { sessionId, deliveryKind: ZCODE_DELIVERY_KIND });
    this.subscribed.add(sessionId);
  }

  private async refreshList(): Promise<void> {
    const link = this.link;
    if (!link) return;
    try {
      const res = await link.request<{ sessions?: Record<string, unknown>[]; items?: Record<string, unknown>[] }>('session/list', { limit: 100 });
      const raw = res?.sessions ?? res?.items ?? [];
      this.listed = raw.flatMap((s): ListedSession[] => {
        const id = typeof s?.sessionId === 'string' ? s.sessionId : typeof s?.id === 'string' ? s.id : '';
        if (!id || s?.archived === true) return [];
        const ws = s?.workspace;
        const wsObj = ws && typeof ws === 'object' ? (ws as { workspacePath?: unknown; path?: unknown }) : undefined;
        const cwd =
          typeof ws === 'string'
            ? ws
            : typeof wsObj?.workspacePath === 'string'
              ? wsObj.workspacePath
              : typeof wsObj?.path === 'string'
                ? wsObj.path
                : typeof s?.cwd === 'string'
                  ? s.cwd
                  : undefined;
        const updatedRaw = s?.updatedAt;
        const updatedAt =
          typeof updatedRaw === 'number'
            ? updatedRaw
            : typeof updatedRaw === 'string'
              ? Date.parse(updatedRaw) || 0
              : 0;
        const title = typeof s?.title === 'string' && s.title.trim() ? s.title.trim() : undefined;
        return [{ id, ...(cwd ? { cwd } : {}), updatedAt, ...(title ? { title } : {}) }];
      });
      this.scheduleRender();
    } catch (error) {
      this.options.log(`读取 ZCode 会话列表跳过：${describe(error)}`);
    }
  }

  private async refreshCatalogs(): Promise<void> {
    const link = this.link;
    if (!link) return;
    const [modelsRes, commandsRes, skillsRes] = await Promise.all([
      link.request<unknown>('model/list', {}).catch(() => undefined),
      link.request<unknown>('commands/list', {}).catch(() => undefined),
      link.request<unknown>('skills/list', {}).catch(() => undefined),
    ]);
    const parsedModels = parseZcodeModels(modelsRes);
    if (parsedModels.length > 0) {
      this.modelOptions = parsedModels;
      this.hasRuntimeModelCatalog = true;
    } else if (!this.hasRuntimeModelCatalog && this.modelOptions.length === 0) {
      this.modelOptions = fallbackGlmModels();
    }
    if (!this.selectedModel && this.modelOptions[0]) {
      const first = this.modelOptions[0];
      this.selectedModel = {
        provider: first.provider,
        model: first.model,
        ...(first.defaultEffort ? { effort: first.defaultEffort } : {}),
      };
    }
    this.agentCommands = [
      ...parseZcodeCommands(commandsRes, 'agent'),
      ...parseZcodeCommands(skillsRes, 'skill'),
    ];
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 消息发送、插队与停止

  async send(text: string, options: GatherOptions & { images?: readonly PromptImage[] } = {}): Promise<boolean> {
    const slash = parseSlash(text);
    if (slash?.name === 'new') {
      this.tabs.openNew();
      return slash.args.trim() ? this.send(slash.args, options) : true;
    }
    if (slash?.name === 'plan') {
      const currentMode = this.currentMode();
      const nextMode = slash.args.trim() === 'off' ? 'auto' : currentMode === 'plan' && !slash.args.trim() ? 'auto' : 'plan';
      await this.setMode(nextMode);
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
    if (projection.running) {
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
    link: ZcodeLink,
    sessionId: string,
    text: string,
    images: readonly PromptImage[],
  ): Promise<void> {
    const projection = this.projectionFor(sessionId);
    projection.addUserMessage(
      text,
      images.map((img): ImageView => ({ localId: img.localId, mediaType: img.mediaType, ...(img.name ? { name: img.name } : {}) })),
    );
    projection.startTurn(Date.now());
    this.scheduleRender();

    const wireText = this.enrichPromptWithSkills(sessionId, text);
    const attachments =
      images.length > 0
        ? images.map((img) => ({
            type: 'image',
            mediaType: img.mediaType,
            mimeType: img.mediaType,
            data: img.data,
            ...(img.name ? { name: img.name } : {}),
          }))
        : undefined;

    const chosenModel = this.resolveModelEntry(sessionId);
    if (chosenModel && !this.sessionModels.has(sessionId)) {
      this.sessionModels.set(sessionId, chosenModel);
      this.persistSessionModels();
    }
    const resolvedEffort = chosenModel
      ? this.resolveReasoningLevel(chosenModel.provider, chosenModel.model, chosenModel.effort)
      : undefined;
    const sendParams: Record<string, unknown> = {
      sessionId,
      content: wireText,
      ...(attachments ? { attachments } : {}),
      ...(chosenModel
        ? {
            modelSelection: {
              providerId: chosenModel.provider,
              modelId: chosenModel.model,
              ...(resolvedEffort ? { options: { reasoningLevel: resolvedEffort } } : {}),
            },
          }
        : {}),
    };

    try {
      await this.ensureSessionActive(link, sessionId);
      const pendingMode = this.pendingModes.get(sessionId);
      if (pendingMode !== undefined) {
        this.pendingModes.delete(sessionId);
        await this.applyMode(sessionId, pendingMode, false);
      }
      // ensureSessionActive 可能刚刚从 session/resume 拿到完整的模型与默认思考档位目录，发消息前补全一次 reasoningLevel
      if (this.selectedModel && !resolvedEffort) {
        const refreshedEffort = this.resolveReasoningLevel(
          this.selectedModel.provider,
          this.selectedModel.model,
          this.selectedModel.effort,
        );
        if (refreshedEffort && sendParams.modelSelection && typeof sendParams.modelSelection === 'object') {
          (sendParams.modelSelection as Record<string, unknown>).options = { reasoningLevel: refreshedEffort };
        }
      }
      try {
        await link.request('session/send', sendParams);
      } catch (error) {
        if (!isSessionEvictedError(error)) throw error;
        // 空闲逐出自动恢复：重新 resume + subscribe 后重发一次
        this.subscribed.delete(sessionId);
        await this.ensureSessionActive(link, sessionId);
        await link.request('session/send', sendParams);
      }
      this.remember(sessionId, this.titleOf(sessionId));
      void this.refreshList();
    } catch (error) {
      projection.endTurn(Date.now(), 'failed', this.describeAuthOrError(error));
      this.scheduleRender();
    }
  }

  private async drainQueue(sessionId: string): Promise<void> {
    const link = this.link;
    if (!link) return;
    const next = this.queues.get(sessionId)?.shift();
    if (!next) return;
    await this.dispatchSend(link, sessionId, next.text, next.images);
  }

  private async interrupt(): Promise<void> {
    const sessionId = this.activeId;
    if (!sessionId || !this.link) return;
    this.interactions.clear(sessionId);
    await this.link.request('session/stop', { sessionId }).catch(() => undefined);
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
      if (this.link && (this.projections.get(sessionId)?.running ?? false)) {
        try {
          await this.link.request('session/steer', { sessionId, content: item.text });
          this.projectionFor(sessionId).addUserMessage(item.text);
          this.scheduleRender();
          return;
        } catch {
          // 当前版本不支持 session/steer 时退回到排在队首
        }
      }
      queue.unshift(item);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模型与模式

  private applySessionModelCatalog(raw: unknown): void {
    const parsed = parseZcodeSessionModels(raw);
    if (parsed.length === 0) return;
    this.modelOptions = parsed;
    this.hasRuntimeModelCatalog = true;
    if (!this.selectedModel) {
      const bound = this.options.boundProvider?.();
      const preferred =
        (bound
          ? parsed.find((o) => o.provider === bound.id && (!bound.defaultModel || o.model === bound.defaultModel)) ??
            parsed.find((o) => o.provider === bound.id)
          : undefined) ?? parsed[0];
      if (preferred) {
        this.selectedModel = {
          provider: preferred.provider,
          model: preferred.model,
          ...(preferred.defaultEffort ? { effort: preferred.defaultEffort } : {}),
        };
      }
    } else if (!this.selectedModel.effort) {
      const matched = parsed.find((o) => o.provider === this.selectedModel?.provider && o.model === this.selectedModel?.model);
      if (matched?.defaultEffort) {
        this.selectedModel = { ...this.selectedModel, effort: matched.defaultEffort };
      }
    }
    this.scheduleRender();
  }

  private resolveReasoningLevel(provider: string, model: string, explicitEffort?: string): string | undefined {
    const matched = this.modelOptions.find((o) => o.provider === provider && o.model === model);
    if (explicitEffort) {
      if (!matched || matched.efforts.length === 0 || matched.efforts.some((e) => e.id === explicitEffort)) {
        return explicitEffort;
      }
    }
    return matched?.defaultEffort ?? matched?.efforts[0]?.id ?? explicitEffort;
  }

  private persistSessionModels(): void {
    if (!this.options.saveSessionModels) return;
    this.options.saveSessionModels(Object.fromEntries(this.sessionModels.entries()));
  }

  private resolveModelEntry(sessionId: string | undefined = this.activeId): ZcodePreferredModel | undefined {
    return (sessionId ? this.sessionModels.get(sessionId) : undefined) ?? this.selectedModel;
  }

  private buildModelState(sessionId: string | undefined = this.activeId): ModelState {
    const bound = this.options.boundProvider?.();
    const runtimeByKey = new Map(this.modelOptions.map((o) => [`${o.provider}/${o.model}`, o] as const));
    const boundOpts: ModelOption[] =
      bound && bound.models.length > 0
        ? bound.models.map((m) => {
            const runtimeMatch = runtimeByKey.get(`${bound.id}/${m.id}`);
            const configuredEfforts = (m.efforts ?? []).map((e) => ({ id: e, name: e }));
            const efforts = configuredEfforts.length > 0 ? configuredEfforts : (runtimeMatch?.efforts ?? []);
            const defaultEffort =
              configuredEfforts.length > 0
                ? configuredEfforts[0]?.id
                : (runtimeMatch?.defaultEffort ?? efforts[0]?.id);
            return {
              provider: bound.id,
              model: m.id,
              name: m.name || m.id,
              group: bound.name,
              efforts,
              ...(defaultEffort ? { defaultEffort } : {}),
            };
          })
        : [];
    const boundKeys = new Set(boundOpts.map((o) => `${o.provider}/${o.model}`));
    const extraRuntimeOpts = this.hasRuntimeModelCatalog
      ? this.modelOptions.filter((o) => !boundKeys.has(`${o.provider}/${o.model}`))
      : [];
    const options = boundOpts.length > 0 ? [...boundOpts, ...extraRuntimeOpts] : this.modelOptions;
    if (options.length === 0) return { options: [] };
    const defaultFromBound: ZcodePreferredModel | undefined =
      bound && (bound.defaultModel || bound.models[0]?.id)
        ? { provider: bound.id, model: bound.defaultModel ?? bound.models[0]!.id }
        : undefined;
    const fallbackFirst: ZcodePreferredModel = { provider: options[0]!.provider, model: options[0]!.model };
    const picked = this.resolveModelEntry(sessionId);
    const current: ZcodePreferredModel = picked ?? defaultFromBound ?? fallbackFirst;
    if (bound && current.provider === bound.id) {
      this.options.onProviderModelSelected?.(bound.id, current.model, sessionId);
    }
    const resolvedEffort = this.resolveReasoningLevel(current.provider, current.model, current.effort);
    const exists = options.some((o) => o.provider === current.provider && o.model === current.model);
    const mergedOptions = exists
      ? options
      : [{ provider: current.provider, model: current.model, name: current.model, group: 'ZCode', efforts: [] }, ...options];
    return {
      options: mergedOptions,
      current: {
        provider: current.provider,
        model: current.model,
        ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}),
      },
    };
  }

  private async selectModel(provider: string, model: string, effort?: string): Promise<void> {
    const sessionId = this.activeId;
    const bound = this.options.boundProvider?.();
    if (bound && provider === bound.id) {
      this.options.onProviderModelSelected?.(bound.id, model, sessionId);
    }
    const resolvedEffort = this.resolveReasoningLevel(provider, model, effort);
    const nextModel: ZcodePreferredModel = { provider, model, ...(resolvedEffort ? { effort: resolvedEffort } : {}) };
    if (sessionId) {
      this.sessionModels.set(sessionId, nextModel);
      this.persistSessionModels();
    } else {
      this.selectedModel = nextModel;
      this.options.savePreferredModel?.(nextModel);
    }
    if (sessionId && this.link) {
      await this.link
        .request('session/setModel', {
          sessionId,
          model: {
            providerId: provider,
            modelId: model,
            ...(resolvedEffort ? { options: { reasoningLevel: resolvedEffort } } : {}),
          },
        })
        .catch(() => undefined);
    }
    this.scheduleRender();
  }

  private currentMode(): string {
    return (
      (this.activeId ? (this.pendingModes.get(this.activeId) ?? this.projections.get(this.activeId)?.mode) : undefined) ??
      this.draftMode
    );
  }

  private async setMode(mode: string, preConfirmed?: boolean): Promise<void> {
    if (mode === this.currentMode()) return;
    const labelInfo = DEFAULT_MODES.find((m) => m.id === mode);
    const displayName = labelInfo ? (getLocale() === 'zh' ? labelInfo.zh : labelInfo.en) : mode;
    if (preConfirmed !== true && isUnrestrictedMode(mode, displayName)) {
      if (!(await this.workbench.confirm(t('acp.dangerTitle', displayName), t('acp.dangerDetail', 'ZCode', displayName), t('acp.dangerAllow', displayName)))) {
        return;
      }
    }
    this.draftMode = mode;
    if (this.activeId) {
      const projection = this.projectionFor(this.activeId);
      if (projection.running) {
        // 正在回复中：延后到下一轮发送前再应用权限，不影响当前回合
        this.pendingModes.set(this.activeId, mode);
        this.toast('info', t('permission.nextTurn', displayName));
        this.scheduleRender();
        return;
      }
      this.pendingModes.delete(this.activeId);
      await this.applyMode(this.activeId, mode, false);
    }
    this.scheduleRender();
  }

  private async applyMode(sessionId: string, mode: string, silent: boolean): Promise<void> {
    const projection = this.projectionFor(sessionId);
    projection.mode = mode;
    if (!this.link) return;
    try {
      await this.link.request('session/setMode', { sessionId, mode });
    } catch {
      try {
        await this.link.request('session/updateSettings', { sessionId, settings: { mode } });
      } catch (error) {
        if (!silent) this.options.log(`切换 ZCode 模式提示：${describe(error)}`);
      }
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
        await this.workbench.openDiff({ kind: 'contents', path, before: created ? '' : reversed, created, scope: 'turn' });
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
      await this.workbench.openDiff({ kind: 'contents', path, before: change.created ? '' : before, created: change.created, scope: 'session' });
      return;
    }
    const last = change.calls.at(-1);
    if (last) return this.openDiff({ kind: 'tool', callId: last });
    return this.workbench.openFile(path);
  }

  private sessionChanges(projection: ZcodeSessionProjection | undefined): SessionChangesView | undefined {
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
    const mode = this.currentMode();
    const changes = this.sessionChanges(projection);
    const session: SessionHeader = {
      ...(sessionId ? { id: sessionId } : {}),
      title: this.titleOf(sessionId),
      running,
      hasOlder: false,
      loadingOlder: false,
      sync: !sessionId ? 'idle' : this.loading.has(sessionId) || !this.link ? 'opening' : 'live',
      ...(usage ? { contextUsage: Math.min(1, usage.used / usage.size), contextTokens: { used: usage.used, window: usage.size } } : {}),
      ...(contextDetail ? { contextDetail } : {}),
      ...(mode === 'plan' ? { planMode: true } : {}),
      ...(projection?.todos?.length ? { todos: projection.todos } : {}),
      ...(projection?.goal ? { goal: projection.goal } : {}),
      ...(running && projection?.runningSince !== undefined ? { runningSince: projection.runningSince } : {}),
      ...(this.options.folderLabel?.() ? { folder: this.options.folderLabel() } : {}),
      ...(changes ? { changes } : {}),
    };

    const waiting = this.interactions.sessionsWaiting();
    const state = (id: string) => ({ running: this.projections.get(id)?.running ?? false, ...(waiting.has(id) ? { needsAttention: true } : {}) });
    const known = new Map<string, SessionListItem>();
    const otherWorkspaceIds = new Set<string>();
    for (const s of this.listed) {
      if (!s.cwd || isPathInsideProject(this.workspacePath, s.cwd)) {
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
      options: DEFAULT_MODES.map((m) => m.id),
      current: mode,
      labels: Object.fromEntries(DEFAULT_MODES.map((m) => [m.id, { name: locale === 'zh' ? m.zh : m.en }])),
    };

    const baseCommands: CommandView[] = [
      ...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })),
      ...this.agentCommands,
    ];
    const takenNames = new Set(baseCommands.map((c) => c.name));
    const extraSkills: CommandView[] = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'zcode')
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
    const activeSkills = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'zcode');
    if (activeSkills.length === 0) return text;
    const knownNames = new Set(this.agentCommands.map((c) => c.name));
    const slash = parseSlash(text);
    let body = text;
    if (slash && !knownNames.has(slash.name)) {
      const matched = activeSkills.find((s) => s.name === slash.name || s.id === slash.name);
      if (matched) {
        const taskPart = slash.args.trim() ? `\n\nTask: ${slash.args.trim()}` : '';
        body = `Use the Agent Skill "${matched.name}" by reading its instructions at "${matched.skillMdPath}".${taskPart}`;
      }
    }
    if (!this.skillCatalogInjected.has(sessionId)) {
      this.skillCatalogInjected.add(sessionId);
      const catalog = formatSkillsPromptCatalog(activeSkills);
      if (catalog) return `${catalog}\n\n${body}`;
    }
    return body;
  }

  private projectionFor(sessionId: string): ZcodeSessionProjection {
    let p = this.projections.get(sessionId);
    if (!p) {
      p = new ZcodeSessionProjection(this.workspacePath);
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
      this.listed.find((s) => s.id === sessionId)?.title ||
      t('acp.untitled')
    );
  }

  private describeAuthOrError(error: unknown): string {
    const msg = describe(error);
    if (/auth|credential|api[-_ ]?key|unauthoriz|not logged|login|-32000/iu.test(msg)) {
      return this.options.signInHint ? `${msg}（${this.options.signInHint}）` : msg;
    }
    return msg;
  }

  private async waitForLink(timeoutMs: number): Promise<ZcodeLink | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.link) return this.link;
      await new Promise((r) => setTimeout(r, 80));
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

function isSessionEvictedError(error: unknown): boolean {
  if (error instanceof ZcodeError && error.code === -32004) return true;
  const msg = describe(error);
  return /session is not active|session not active|not found in active/iu.test(msg);
}

function parseZcodeModelEntry(m: Record<string, unknown> | undefined): ModelOption | undefined {
  if (!m) return undefined;
  const ref = m.ref && typeof m.ref === 'object' ? (m.ref as Record<string, unknown>) : undefined;
  const model =
    typeof ref?.modelId === 'string'
      ? ref.modelId
      : typeof m.id === 'string'
        ? m.id
        : typeof m.modelId === 'string'
          ? m.modelId
          : typeof m.model === 'string'
            ? m.model
            : '';
  if (!model) return undefined;
  const provider =
    typeof ref?.providerId === 'string'
      ? ref.providerId
      : typeof m.providerId === 'string'
        ? m.providerId
        : typeof m.provider === 'string'
          ? m.provider
          : 'zai';
  const name =
    typeof m.label === 'string' && m.label
      ? m.label
      : typeof m.name === 'string' && m.name
        ? m.name
        : model;
  const group =
    typeof m.providerLabel === 'string' && m.providerLabel
      ? m.providerLabel
      : typeof m.providerName === 'string' && m.providerName
        ? m.providerName
        : provider;
  const desc = typeof m.description === 'string' && m.description ? m.description : undefined;
  const reasoning = m.reasoning && typeof m.reasoning === 'object' ? (m.reasoning as Record<string, unknown>) : undefined;
  const rawLevels = Array.isArray(reasoning?.levels) ? (reasoning.levels as Record<string, unknown>[]) : [];
  const efforts = rawLevels.flatMap((lvl) => {
    const id = typeof lvl?.value === 'string' ? lvl.value.trim() : typeof lvl?.id === 'string' ? lvl.id.trim() : '';
    if (!id) return [];
    const label = typeof lvl?.label === 'string' && lvl.label.trim() ? lvl.label.trim() : id;
    return [{ id, name: label }];
  });
  const defaultEffort =
    typeof reasoning?.defaultLevel === 'string' && reasoning.defaultLevel.trim()
      ? reasoning.defaultLevel.trim()
      : efforts[0]?.id;
  return {
    provider,
    model,
    name,
    group,
    ...(desc ? { description: desc } : {}),
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}

function parseZcodeModels(raw: unknown): ModelOption[] {
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : raw && typeof raw === 'object'
      ? ((raw as { models?: unknown; items?: unknown; available?: unknown }).models ??
        (raw as { items?: unknown }).items ??
        (raw as { available?: unknown }).available)
      : undefined;
  if (!Array.isArray(list)) return [];
  return (list as Record<string, unknown>[]).flatMap((m): ModelOption[] => {
    const parsed = parseZcodeModelEntry(m);
    return parsed ? [parsed] : [];
  });
}

function parseZcodeSessionModels(raw: unknown): ModelOption[] {
  if (!raw || typeof raw !== 'object') return [];
  const settings = (raw as { settings?: unknown }).settings;
  if (!settings || typeof settings !== 'object') return [];
  const modelSection = (settings as { model?: unknown }).model;
  if (!modelSection || typeof modelSection !== 'object') return [];
  return parseZcodeModels(modelSection);
}

function fallbackGlmModels(): ModelOption[] {
  return [
    { provider: 'zai', model: 'glm-5.3', name: 'GLM-5.3', group: 'Z.ai', efforts: [] },
    { provider: 'zai', model: 'glm-5.3-flash', name: 'GLM-5.3-Flash', group: 'Z.ai', efforts: [] },
  ];
}

function parseZcodeCommands(raw: unknown, source: 'agent' | 'skill'): CommandView[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as { commands?: unknown; skills?: unknown; items?: unknown }).commands ??
        (raw as { skills?: unknown }).skills ??
        (raw as { items?: unknown }).items)
      : undefined;
  if (!Array.isArray(list)) return [];
  return (list as Record<string, unknown>[]).flatMap((c): CommandView[] => {
    const name = typeof c?.name === 'string' ? c.name.replace(/^\/+/u, '').trim() : '';
    if (!name) return [];
    return [
      {
        name,
        description: typeof c?.description === 'string' ? c.description : '',
        source,
      },
    ];
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

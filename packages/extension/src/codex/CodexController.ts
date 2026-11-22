/**
 * OpenAI Codex 原生控制器（`codex app-server --listen stdio://`）：
 * 实现与 dsh `ChatController`、ZCode `ZcodeController`、Pi `PiController` 一致的 `ChatBackendController` 接口，
 * 支持逐字流式回复与推理、命令与文件改动 Diff、审批与提问卡片、排队与运行中插队（`turn/steer`）、
 * 多标签、跨项目会话汇总、模型与思考等级切换，以及工作台无人值守/编程式会话启动。
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
import {
  renderDelay,
  type ChatBackendController,
  type ControllerHostOptions,
  type CrossProjectSession,
  type ProgrammaticSessionRequest,
} from '../backend/types.ts';
import { formatSkillsPromptCatalog, skillsForBackend } from '../extensions/skillService.ts';
import { getLocale, t } from '../i18n.ts';
import { isPathInsideProject } from '../projects/ProjectService.ts';
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
import { CodexError, type CodexLink, type CodexRequestId } from './connection.ts';
import { CodexInteractionManager } from './interactions.ts';
import { CodexSessionProjection } from './projection.ts';

export interface CodexPreferredModel {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface CodexControllerOptions extends ControllerHostOptions {
  readonly workspacePath: string;
  readonly restartRuntime: () => void;
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly loadSessions: () => readonly StoredSession[] | undefined;
  readonly saveSessions: (sessions: readonly StoredSession[]) => void;
  readonly loadPreferredModel?: () => CodexPreferredModel | undefined;
  readonly savePreferredModel?: (preferred: CodexPreferredModel) => void;
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  readonly signInHint?: string;
  readonly boundProvider?: () => ProviderConfig | undefined;
  readonly onProviderModelSelected?: (providerId: string, model: string) => void;
}

interface QueuedPrompt {
  readonly id: string;
  readonly text: string;
  readonly images: readonly PromptImage[];
}

interface ListedThread {
  readonly id: string;
  readonly cwd?: string;
  readonly updatedAt: number;
  readonly title?: string;
}

export type CodexPermissionMode = 'read-only' | 'workspace-write' | 'full-auto' | 'danger-full-access';

interface CodexPermissionConfig {
  readonly id: CodexPermissionMode;
  readonly zh: string;
  readonly en: string;
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approvalPolicy: 'on-request' | 'never';
  readonly sandboxPolicy: Record<string, unknown>;
}

const MAX_TITLE = 60;

export const CODEX_PERMISSION_MODES: readonly CodexPermissionConfig[] = [
  {
    id: 'read-only',
    zh: '只读（Read-only）',
    en: 'Read-only',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
  },
  {
    id: 'workspace-write',
    zh: '工作区可写（审批）',
    en: 'Workspace Write',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  },
  {
    id: 'full-auto',
    zh: '工作区自动（Full Auto）',
    en: 'Full Auto',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  },
  {
    id: 'danger-full-access',
    zh: '完全访问（无沙箱）',
    en: 'Full Access',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
];

export function codexPermissionConfig(mode: string): CodexPermissionConfig {
  return CODEX_PERMISSION_MODES.find((m) => m.id === mode) ?? CODEX_PERMISSION_MODES[1]!;
}

export class CodexController implements ChatBackendController {
  private link: CodexLink | undefined;
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private activeId: string | undefined;
  private workspacePath: string;
  private readonly projections = new Map<string, CodexSessionProjection>();
  private readonly resumed = new Set<string>();
  private readonly loading = new Set<string>();
  private readonly threadModes = new Map<string, CodexPermissionMode>();
  private listed: ListedThread[] = [];
  private stored: StoredSession[];
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private queueCounter = 0;
  private modelOptions: ModelOption[] = [];
  private selectedModel: CodexPreferredModel | undefined;
  private draftMode: CodexPermissionMode = 'workspace-write';
  private agentCommands: CommandView[] = [];
  private readonly skillCatalogInjected = new Set<string>();
  private readonly editorContext: EditorContext;
  private readonly tabs: TabsModel;
  private readonly interactions: CodexInteractionManager;
  private readonly publisher: ViewPublisher;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: CodexControllerOptions) {
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
    this.interactions = new CodexInteractionManager(
      () => this.workspacePath,
      () => this.workbench.dirtyFiles(),
      (tid, itemId) => this.projections.get(tid)?.toolCall(itemId),
      () => this.scheduleRender(),
    );
    this.tabs = new TabsModel({
      keyPrefix: 'codex-tab',
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

  setLink(link: CodexLink | undefined): void {
    this.link = link;
    this.connection = link ? 'connected' : 'idle';
    this.options.post({ type: 'connection', payload: this.connection });
    this.projections.clear();
    this.resumed.clear();
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
    const obj = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};

    if (method === 'serverRequest/resolved') {
      const reqId = obj.requestId;
      if (typeof reqId === 'string' || typeof reqId === 'number') {
        this.interactions.resolveFromServer(reqId);
      }
      return;
    }

    if (method === 'thread/started') {
      const thread = obj.thread as Record<string, unknown> | undefined;
      if (typeof thread?.id === 'string') {
        void this.refreshList();
      }
      return;
    }

    const threadId = typeof obj.threadId === 'string' && obj.threadId ? obj.threadId : this.activeId;
    if (!threadId) return;

    const projection = this.projectionFor(threadId);
    const wasRunning = projection.running;
    const outcome = projection.applyNotification(method, obj);
    if (projection.title) this.remember(threadId, projection.title);

    if (wasRunning && outcome.turnEnded && !projection.running) {
      void this.drainQueue(threadId);
    }
    this.scheduleRender();
  }

  async onAgentRequest(method: string, params: unknown, requestId: CodexRequestId): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval') {
      return this.interactions.requestCommandApproval(params, requestId, this.activeId);
    }
    if (method === 'item/fileChange/requestApproval') {
      return this.interactions.requestFileChangeApproval(params, requestId, this.activeId);
    }
    if (method === 'item/permissions/requestApproval') {
      return this.interactions.requestPermissionsApproval(params, requestId, this.activeId);
    }
    if (method === 'item/tool/requestUserInput') {
      return this.interactions.requestUserInput(params, requestId, this.activeId);
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return this.interactions.requestLegacyApproval(method, params, requestId, this.activeId);
    }
    if (method === 'mcpServer/elicitation/request') {
      return { action: 'cancel' };
    }
    throw new CodexError(method, -32601, `${method} is not supported by this host`);
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
    const targetMode: CodexPermissionMode =
      req.permissionPreset === 'danger-full-access'
        ? 'danger-full-access'
        : req.permissionPreset === 'read-only'
          ? 'read-only'
          : req.permissionPreset === 'workspace-write'
            ? 'full-auto'
            : this.draftMode;

    if (req.model?.model) {
      await this.selectModel(req.model.provider ?? 'openai', req.model.model, req.model.reasoningEffort);
    }

    const threadId = await this.createBackendThread(link, targetMode);
    if (!threadId) return undefined;

    this.activeId = threadId;
    this.options.saveActiveSessionId(threadId);
    this.tabs.setCurrentSession(threadId);
    this.threadModes.set(threadId, targetMode);
    if (req.title?.trim()) this.remember(threadId, req.title.trim(), true);
    if (req.prompt?.trim()) {
      if (!req.title?.trim()) this.remember(threadId, req.prompt.trim());
      void this.dispatchSend(link, threadId, req.prompt.trim(), []);
    }
    this.scheduleRender();
    return threadId;
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
    this.resumed.clear();
    this.activeId = this.options.loadActiveSessionId();
    this.projections.clear();
    this.tabs.restore(this.activeId);
    if (this.link) {
      void this.refreshCatalogs();
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
    const threadId = this.activeId;
    if (!threadId) {
      this.toast('info', t('rename.needsSession'));
      return;
    }
    const title =
      explicitTitle !== undefined
        ? explicitTitle
        : await this.workbench.input({ title: t('rename.title'), value: this.titleOf(threadId) });
    if (!title?.trim()) return;
    const trimmed = title.trim();
    this.remember(threadId, trimmed, true);
    await this.link?.request('thread/name/set', { threadId, name: trimmed }).catch(() => undefined);
    this.scheduleRender();
  }

  async configureApiKey(): Promise<void> {
    this.toast('info', t('codex.apiKey'));
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
        this.toast('info', t('acp.noWebUI', 'Codex'));
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

  private async openExisting(threadId: string): Promise<void> {
    const link = this.link;
    if (!link || this.resumed.has(threadId) || this.loading.has(threadId)) return;
    this.loading.add(threadId);
    const projection = this.projectionFor(threadId);
    this.scheduleRender();
    try {
      const res = await link.request<{ thread?: Record<string, unknown> }>('thread/resume', {
        threadId,
        persistExtendedHistory: true,
      });
      this.resumed.add(threadId);
      let thread = res?.thread;
      if (!thread || !Array.isArray(thread.turns)) {
        const readRes = await link
          .request<{ thread?: Record<string, unknown> }>('thread/read', { threadId, includeTurns: true })
          .catch(() => undefined);
        if (readRes?.thread) thread = readRes.thread;
      }
      projection.applyThreadSnapshot(thread);
      if (projection.title) this.remember(threadId, projection.title);
    } catch (error) {
      this.options.log(`打开 Codex 会话 ${threadId} 失败：${describe(error)}`);
      this.toast('error', t('acp.loadFailed', describe(error)));
      if (this.activeId === threadId) this.setActive(undefined);
    } finally {
      this.loading.delete(threadId);
      this.scheduleRender();
    }
  }

  private async createBackendThread(link: CodexLink, mode: CodexPermissionMode): Promise<string | undefined> {
    try {
      const cfg = codexPermissionConfig(mode);
      const selected = this.resolveCurrentModel();
      const res = await link.request<{ thread?: { id?: string } }>('thread/start', {
        cwd: this.workspacePath,
        approvalPolicy: cfg.approvalPolicy,
        sandbox: cfg.sandbox,
        ...(selected?.model ? { model: selected.model } : {}),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      const threadId = res?.thread?.id;
      if (!threadId) throw new Error('missing thread.id in thread/start');
      this.resumed.add(threadId);
      this.threadModes.set(threadId, mode);
      return threadId;
    } catch (error) {
      this.options.log(`新建 Codex 会话失败：${describe(error)}`);
      this.toast('error', t('acp.newFailed', this.describeAuthOrError(error)));
      return undefined;
    }
  }

  private async ensureThreadResumed(link: CodexLink, threadId: string): Promise<void> {
    if (this.resumed.has(threadId)) return;
    await link.request('thread/resume', { threadId, persistExtendedHistory: true });
    this.resumed.add(threadId);
  }

  private async refreshList(): Promise<void> {
    const link = this.link;
    if (!link) return;
    try {
      const res = await link.request<{ data?: Record<string, unknown>[] }>('thread/list', {
        limit: 100,
        sortKey: 'updated_at',
        archived: false,
      });
      const raw = Array.isArray(res?.data) ? res.data : [];
      this.listed = raw.flatMap((entry): ListedThread[] => {
        const id = typeof entry?.id === 'string' ? entry.id : '';
        if (!id || entry.ephemeral === true) return [];
        const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : undefined;
        const updatedSec = typeof entry.updatedAt === 'number' ? entry.updatedAt : typeof entry.createdAt === 'number' ? entry.createdAt : 0;
        const updatedAt = updatedSec > 1e12 ? updatedSec : updatedSec * 1000;
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
        const preview = typeof entry.preview === 'string' && entry.preview.trim() ? entry.preview.trim().slice(0, MAX_TITLE) : undefined;
        const title = name ?? preview;
        return [{ id, ...(cwd ? { cwd } : {}), updatedAt, ...(title ? { title } : {}) }];
      });
      this.scheduleRender();
    } catch (error) {
      this.options.log(`读取 Codex 会话列表跳过：${describe(error)}`);
    }
  }

  private async refreshCatalogs(): Promise<void> {
    const link = this.link;
    if (!link) return;
    const [modelsRes, skillsRes] = await Promise.all([
      link.request<unknown>('model/list', {}).catch(() => undefined),
      link.request<unknown>('skills/list', { cwds: [this.workspacePath] }).catch(() => undefined),
    ]);
    const parsedModels = parseCodexModels(modelsRes);
    this.modelOptions = parsedModels;
    if (!this.selectedModel && this.modelOptions.length > 0) {
      const preferred = this.modelOptions.find((m) => m.model === (modelsRes as { data?: { isDefault?: boolean; model?: string }[] })?.data?.find((d) => d.isDefault)?.model) ?? this.modelOptions[0]!;
      this.selectedModel = {
        provider: preferred.provider,
        model: preferred.model,
        ...(preferred.defaultEffort ? { effort: preferred.defaultEffort } : {}),
      };
    }
    this.agentCommands = parseCodexSkills(skillsRes);
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
      const current = this.currentMode();
      const next: CodexPermissionMode =
        slash.args.trim() === 'off' ? 'workspace-write' : current === 'read-only' && !slash.args.trim() ? 'workspace-write' : 'read-only';
      await this.setMode(next);
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

    let threadId = this.activeId;
    if (!threadId) {
      threadId = await this.createBackendThread(link, this.draftMode);
      if (!threadId) return false;
      this.activeId = threadId;
      this.options.saveActiveSessionId(threadId);
      this.tabs.setCurrentSession(threadId);
      this.remember(threadId, prompt || t('acp.image'));
    }

    this.editorContext.clearPinned();
    const projection = this.projectionFor(threadId);
    const images = options.images ?? [];
    if (projection.running) {
      const queue = this.queues.get(threadId) ?? [];
      queue.push({ id: `q${++this.queueCounter}`, text: full, images });
      this.queues.set(threadId, queue);
      this.scheduleRender();
      return true;
    }

    await this.dispatchSend(link, threadId, full, images);
    return true;
  }

  private async dispatchSend(
    link: CodexLink,
    threadId: string,
    text: string,
    images: readonly PromptImage[],
  ): Promise<void> {
    const projection = this.projectionFor(threadId);
    projection.addUserMessage(
      text,
      images.map((img): ImageView => ({ localId: img.localId, mediaType: img.mediaType, ...(img.name ? { name: img.name } : {}) })),
    );
    projection.startTurn(Date.now());
    this.scheduleRender();

    const wireText = this.enrichPromptWithSkills(threadId, text);
    const input = buildCodexUserInput(wireText, images);
    const modeCfg = codexPermissionConfig(this.modeFor(threadId));
    const selected = this.resolveCurrentModel();

    const params: Record<string, unknown> = {
      threadId,
      input,
      cwd: this.workspacePath,
      approvalPolicy: modeCfg.approvalPolicy,
      sandboxPolicy: modeCfg.sandboxPolicy,
      ...(selected?.model ? { model: selected.model } : {}),
      ...(selected?.effort ? { effort: selected.effort } : {}),
    };

    try {
      await this.ensureThreadResumed(link, threadId);
      const res = await link.request<{ turn?: { id?: string } }>('turn/start', params);
      if (typeof res?.turn?.id === 'string') {
        projection.activeTurnId = res.turn.id;
      }
      this.remember(threadId, this.titleOf(threadId));
      void this.refreshList();
    } catch (error) {
      projection.endTurn(Date.now(), 'failed', this.describeAuthOrError(error));
      this.scheduleRender();
    }
  }

  private async drainQueue(threadId: string): Promise<void> {
    const link = this.link;
    if (!link) return;
    const next = this.queues.get(threadId)?.shift();
    if (!next) return;
    await this.dispatchSend(link, threadId, next.text, next.images);
  }

  private async interrupt(): Promise<void> {
    const threadId = this.activeId;
    if (!threadId || !this.link) return;
    this.interactions.clear(threadId);
    const projection = this.projections.get(threadId);
    const turnId = projection?.activeTurnId;
    if (turnId) {
      await this.link.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    }
    if (projection?.running) {
      projection.endTurn(Date.now(), 'cancelled');
    }
    this.scheduleRender();
  }

  private async queueAction(payload: Extract<WebviewToHost, { type: 'queueAction' }>['payload']): Promise<void> {
    const threadId = this.activeId;
    const queue = threadId ? this.queues.get(threadId) : undefined;
    if (!threadId || !queue) return;
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
      const running = this.projections.get(threadId)?.running ?? false;
      if (!running && this.link) {
        this.scheduleRender();
        await this.dispatchSend(this.link, threadId, item.text, item.images);
        return;
      }
      queue.unshift(item);
    } else if (payload.action === 'steer') {
      const [item] = queue.splice(index, 1);
      if (!item) return;
      const projection = this.projections.get(threadId);
      const turnId = projection?.activeTurnId;
      if (this.link && projection?.running && turnId) {
        try {
          await this.link.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: buildCodexUserInput(item.text, item.images),
          });
          projection.addUserMessage(
            item.text,
            item.images.map((img): ImageView => ({ localId: img.localId, mediaType: img.mediaType, ...(img.name ? { name: img.name } : {}) })),
          );
          this.scheduleRender();
          return;
        } catch {
          // 当前轮次已切换或不支持 steer 时退回到队首
        }
      }
      queue.unshift(item);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模型与权限模式

  private resolveCurrentModel(): CodexPreferredModel | undefined {
    const bound = this.options.boundProvider?.();
    const defaultFromBound: CodexPreferredModel | undefined =
      bound && (bound.defaultModel || bound.models[0]?.id)
        ? { provider: bound.id, model: bound.defaultModel ?? bound.models[0]!.id }
        : undefined;
    const first = this.modelOptions[0];
    const fallback: CodexPreferredModel | undefined = first
      ? { provider: first.provider, model: first.model, ...(first.defaultEffort ? { effort: first.defaultEffort } : {}) }
      : undefined;
    if (bound) {
      if (
        this.selectedModel &&
        this.selectedModel.provider === bound.id &&
        (bound.models.length === 0 || bound.models.some((m) => m.id === this.selectedModel!.model))
      ) {
        return this.selectedModel;
      }
      return defaultFromBound ?? fallback;
    }
    if (this.selectedModel && this.selectedModel.provider === 'openai') {
      return this.selectedModel;
    }
    return fallback;
  }

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
    const options = boundOpts.length > 0 ? boundOpts : this.modelOptions;
    if (options.length === 0) return { options: [] };
    const current = this.resolveCurrentModel() ?? { provider: options[0]!.provider, model: options[0]!.model };
    if (bound && current.provider === bound.id) {
      this.options.onProviderModelSelected?.(bound.id, current.model);
    }
    const exists = options.some((o) => o.provider === current.provider && o.model === current.model);
    const mergedOptions = exists
      ? options
      : [{ provider: current.provider, model: current.model, name: current.model, group: bound ? bound.name : 'Codex', efforts: [] }, ...options];
    return {
      options: mergedOptions,
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
    this.scheduleRender();
  }

  private modeFor(threadId: string | undefined): CodexPermissionMode {
    return (threadId ? this.threadModes.get(threadId) : undefined) ?? this.draftMode;
  }

  private currentMode(): CodexPermissionMode {
    return this.modeFor(this.activeId);
  }

  private async setMode(rawMode: string, preConfirmed?: boolean): Promise<void> {
    const cfg = codexPermissionConfig(rawMode);
    if (cfg.id === this.currentMode()) return;
    const displayName = getLocale() === 'zh' ? cfg.zh : cfg.en;
    if (preConfirmed !== true && (cfg.id === 'danger-full-access' || isUnrestrictedMode(cfg.id, displayName))) {
      if (
        !(await this.workbench.confirm(
          t('acp.dangerTitle', displayName),
          t('acp.dangerDetail', 'Codex', displayName),
          t('acp.dangerAllow', displayName),
        ))
      ) {
        return;
      }
    }
    this.draftMode = cfg.id;
    if (this.activeId) {
      this.threadModes.set(this.activeId, cfg.id);
    }
    this.scheduleRender();
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

  private sessionChanges(projection: CodexSessionProjection | undefined): SessionChangesView | undefined {
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
    });
  }

  private compute(): ControllerView {
    const threadId = this.activeId;
    const projection = threadId ? this.projections.get(threadId) : undefined;
    const running = projection?.running ?? false;
    const queue = threadId ? (this.queues.get(threadId) ?? []) : [];
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
    const contextDetail = projection?.contextDetail();
    const mode = this.currentMode();
    const changes = this.sessionChanges(projection);
    const session: SessionHeader = {
      ...(threadId ? { id: threadId } : {}),
      title: this.titleOf(threadId),
      running,
      hasOlder: false,
      loadingOlder: false,
      sync: !threadId ? 'idle' : this.loading.has(threadId) || !this.link ? 'opening' : 'live',
      ...(usage ? { contextUsage: Math.min(1, usage.used / usage.size), contextTokens: { used: usage.used, window: usage.size } } : {}),
      ...(contextDetail ? { contextDetail } : {}),
      ...(mode === 'read-only' ? { planMode: true } : {}),
      ...(projection?.todos?.length ? { todos: projection.todos } : {}),
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
      options: CODEX_PERMISSION_MODES.map((m) => m.id),
      current: mode,
      labels: Object.fromEntries(CODEX_PERMISSION_MODES.map((m) => [m.id, { name: locale === 'zh' ? m.zh : m.en }])),
    };

    const baseCommands: CommandView[] = [
      ...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })),
      ...this.agentCommands,
    ];
    const takenNames = new Set(baseCommands.map((c) => c.name));
    const extraSkills: CommandView[] = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'codex')
      .filter((s) => !takenNames.has(s.name))
      .map((s) => ({ name: s.name, description: s.description, source: 'skill' as const }));
    const commands: CommandView[] = [...baseCommands, ...extraSkills];

    return {
      sessionKey: threadId ?? '',
      sessions,
      tabs: this.tabsState(session),
      session,
      items,
      models: this.buildModelState(),
      interactions: this.interactions.viewsFor(threadId),
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
      context: this.editorContext.state(),
      commands,
    };
  }

  private enrichPromptWithSkills(threadId: string, text: string): string {
    const activeSkills = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'codex');
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
    if (!this.skillCatalogInjected.has(threadId)) {
      this.skillCatalogInjected.add(threadId);
      const catalog = formatSkillsPromptCatalog(activeSkills);
      if (catalog) return `${catalog}\n\n${body}`;
    }
    return body;
  }

  private projectionFor(threadId: string): CodexSessionProjection {
    let p = this.projections.get(threadId);
    if (!p) {
      p = new CodexSessionProjection(this.workspacePath);
      this.projections.set(threadId, p);
    }
    return p;
  }

  private remember(threadId: string, title: string, force = false): void {
    const existing = this.stored.find((s) => s.id === threadId);
    if (existing && !force && existing.title) {
      this.stored = this.stored.map((s) => (s.id === threadId ? { ...s, updatedAt: Date.now() } : s));
    } else {
      const clean = title.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE);
      this.stored = [{ id: threadId, title: clean, updatedAt: Date.now() }, ...this.stored.filter((s) => s.id !== threadId)];
    }
    this.options.saveSessions(this.stored.slice(0, 200));
  }

  private titleOf(threadId: string | undefined): string {
    if (!threadId) return t('session.new');
    return (
      this.stored.find((s) => s.id === threadId)?.title ||
      this.projections.get(threadId)?.title ||
      this.listed.find((s) => s.id === threadId)?.title ||
      t('acp.untitled')
    );
  }

  private describeAuthOrError(error: unknown): string {
    const msg = describe(error);
    if (/auth|credential|api[-_ ]?key|unauthoriz|not logged|login|401|openai/iu.test(msg)) {
      return this.options.signInHint ? `${msg}（${this.options.signInHint}）` : msg;
    }
    return msg;
  }

  private async waitForLink(timeoutMs: number): Promise<CodexLink | undefined> {
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

export function buildCodexUserInput(text: string, images: readonly PromptImage[] = []): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  if (text.trim() || images.length === 0) {
    input.push({ type: 'text', text, text_elements: [] });
  }
  for (const img of images) {
    input.push({ type: 'image', url: `data:${img.mediaType};base64,${img.data}` });
  }
  return input;
}

export function parseCodexModels(raw: unknown): ModelOption[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).flatMap((m): ModelOption[] => {
    if (m?.hidden === true) return [];
    const model = typeof m?.model === 'string' && m.model ? m.model : typeof m?.id === 'string' ? m.id : '';
    if (!model) return [];
    const name = typeof m.displayName === 'string' && m.displayName ? m.displayName : model;
    const desc = typeof m.description === 'string' && m.description ? m.description : undefined;
    const rawEfforts = Array.isArray(m.supportedReasoningEfforts)
      ? (m.supportedReasoningEfforts as Record<string, unknown>[])
      : [];
    const efforts = rawEfforts.flatMap((e) => {
      const id = typeof e?.reasoningEffort === 'string' ? e.reasoningEffort : '';
      if (!id) return [];
      const eDesc = typeof e?.description === 'string' && e.description ? e.description : undefined;
      return [{ id, name: id, ...(eDesc ? { description: eDesc } : {}) }];
    });
    const defaultEffort =
      typeof m.defaultReasoningEffort === 'string' && m.defaultReasoningEffort ? m.defaultReasoningEffort : undefined;
    return [
      {
        provider: 'openai',
        model,
        name,
        group: 'OpenAI',
        ...(desc ? { description: desc } : {}),
        efforts,
        ...(defaultEffort ? { defaultEffort } : {}),
      },
    ];
  });
}

export function parseCodexSkills(raw: unknown): CommandView[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const result: CommandView[] = [];
  for (const entry of data as Record<string, unknown>[]) {
    const skills = Array.isArray(entry?.skills) ? (entry.skills as Record<string, unknown>[]) : [];
    for (const skill of skills) {
      if (skill?.enabled === false) continue;
      const name = typeof skill?.name === 'string' ? skill.name.replace(/^\/+/u, '').trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const iface = skill?.interface && typeof skill.interface === 'object' ? (skill.interface as { shortDescription?: unknown }) : undefined;
      const desc =
        typeof iface?.shortDescription === 'string' && iface.shortDescription
          ? iface.shortDescription
          : typeof skill?.shortDescription === 'string' && skill.shortDescription
            ? skill.shortDescription
            : typeof skill?.description === 'string'
              ? skill.description
              : '';
      result.push({ name, description: desc, source: 'skill' });
    }
  }
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

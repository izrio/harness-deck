/**
 * Claude Code 原生控制器（`claude -p`）：
 * 基于 `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`
 * 实现完整的 `ChatBackendController` 接口：
 * - 多标签与多会话隔离并发运行（每个活跃会话按需启动独立流式进程，空闲历史会话直接从 `~/.claude/projects` 秒开回放）；
 * - 实时流式正文与思考链（`stream_event`）、工具合并（`explore` / `edit` / `command` / `subagent`）、待办列表（`TodoWrite`）与文件 Diff；
 * - 权限审批卡片（`can_use_tool`）、提问卡片（`AskUserQuestion`）与计划审阅卡片（`ExitPlanMode`）；
 * - 在线模型切换（`set_model`）、权限模式切换（`set_permission_mode`）与生成中断（`interrupt`）。
 */
import { appendFile } from 'node:fs/promises';
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
import { skillsForBackend } from '../extensions/skillService.ts';
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
import type { ClaudeLink } from './connection.ts';
import { ClaudeInteractionManager } from './interactions.ts';
import { ClaudeSessionProjection } from './projection.ts';
import {
  findClaudeSessionFile,
  readClaudeSessionEvents,
  scanClaudeSessions,
  type ClaudeDiskSession,
} from './sessions.ts';

export interface ClaudePreferredModel {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface ClaudeSpawnSessionParams {
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly cwd: string;
  readonly onEvent: (event: Record<string, unknown>) => void;
  readonly onControlRequest: (requestId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
}

export type ClaudeSessionSpawner = (params: ClaudeSpawnSessionParams) => Promise<ClaudeLink>;

export interface ClaudeControllerOptions extends ControllerHostOptions {
  readonly workspacePath: string;
  readonly restartRuntime: () => void;
  readonly loadActiveSessionId: () => string | undefined;
  readonly saveActiveSessionId: (sessionId: string | undefined) => void;
  readonly loadSessions: () => readonly StoredSession[] | undefined;
  readonly saveSessions: (sessions: readonly StoredSession[]) => void;
  readonly loadPreferredModel?: () => ClaudePreferredModel | undefined;
  readonly savePreferredModel?: (preferred: ClaudePreferredModel) => void;
  readonly loadOpenTabs?: () => readonly string[] | undefined;
  readonly saveOpenTabs?: (sessionIds: readonly string[]) => void;
  readonly claudeConfigDir?: () => string | undefined;
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

const CLAUDE_EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
] as const;

const BUILTIN_CLAUDE_MODELS: readonly ModelOption[] = [
  {
    provider: 'anthropic',
    model: 'sonnet',
    name: 'Claude Sonnet (Default)',
    group: 'Anthropic',
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    provider: 'anthropic',
    model: 'opus',
    name: 'Claude Opus',
    group: 'Anthropic',
    efforts: CLAUDE_EFFORTS,
    defaultEffort: 'high',
  },
  {
    provider: 'anthropic',
    model: 'haiku',
    name: 'Claude Haiku',
    group: 'Anthropic',
    efforts: [],
  },
];

const CLAUDE_MODES: readonly { readonly id: string; readonly zh: string; readonly en: string }[] = [
  { id: 'default', zh: '默认（需要时询问）', en: 'Default (Ask when needed)' },
  { id: 'acceptEdits', zh: '自动接受文件修改', en: 'Accept Edits' },
  { id: 'plan', zh: '计划模式（Plan）', en: 'Plan Mode' },
  { id: 'bypassPermissions', zh: '跳过所有确认（全放行）', en: 'Bypass Permissions' },
];

export class ClaudeController implements ChatBackendController {
  private spawner: ClaudeSessionSpawner | undefined;
  private runtime: RuntimeStatus = { kind: 'idle' };
  private connection: ConnectionState = 'idle';
  private activeId: string | undefined;
  private workspacePath: string;
  private readonly projections = new Map<string, ClaudeSessionProjection>();
  private readonly links = new Map<string, ClaudeLink>();
  private readonly historyLoaded = new Set<string>();
  private readonly loading = new Set<string>();
  private diskSessions: ClaudeDiskSession[] = [];
  private stored: StoredSession[];
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private queueCounter = 0;
  private draftCounter = 0;
  private selectedModel: ClaudePreferredModel | undefined;
  private draftMode = 'default';
  /** 回复进行中用户切换的权限模式，延后到下一轮发送前生效。 */
  private readonly pendingModes = new Map<string, string>();
  private discoveredSlashCommands: string[] = [];
  private readonly editorContext: EditorContext;
  private readonly tabs: TabsModel;
  private readonly interactions: ClaudeInteractionManager;
  private readonly publisher: ViewPublisher;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastBoundProviderSig: string;

  constructor(private readonly options: ClaudeControllerOptions) {
    this.workspacePath = options.workspacePath;
    this.activeId = options.loadActiveSessionId();
    this.stored = [...(options.loadSessions() ?? [])].filter((s) => !s.id.startsWith('pending:'));
    this.selectedModel = options.loadPreferredModel?.();
    this.lastBoundProviderSig = this.boundProviderSig();
    this.publisher = new ViewPublisher(options.post, options.onModelChange);
    this.editorContext = new EditorContext(
      () => this.workbench,
      () => this.options.includeActiveEditor?.() ?? true,
      () => this.workspacePath,
    );
    this.interactions = new ClaudeInteractionManager(
      () => this.workspacePath,
      () => this.workbench.dirtyFiles(),
      () => this.scheduleRender(),
    );
    this.tabs = new TabsModel({
      keyPrefix: 'claude-tab',
      load: () => this.options.loadOpenTabs?.()?.filter((id) => !id.startsWith('pending:')),
      save: (ids) => this.options.saveOpenTabs?.(ids.filter((id) => !id.startsWith('pending:'))),
      onActivate: (sessionId) => this.setActive(sessionId),
      onClose: (tab) => {
        if (tab.sessionId) {
          this.interactions.clear(tab.sessionId);
          void this.closeSessionLink(tab.sessionId);
        }
      },
      onChange: () => this.scheduleRender(),
    });
    this.tabs.restore(this.activeId);
  }

  private get workbench(): Workbench {
    return this.options.workbench ?? noWorkbench;
  }

  setSpawner(spawner: ClaudeSessionSpawner | undefined): void {
    if (!spawner) {
      for (const link of this.links.values()) {
        void link.dispose();
      }
      this.links.clear();
      this.interactions.clear();
    }
    this.spawner = spawner;
    this.connection = spawner ? 'connected' : 'idle';
    this.options.post({ type: 'connection', payload: this.connection });
    if (spawner) {
      void this.refreshDiskSessions();
      if (this.activeId) void this.openExisting(this.activeId);
    }
    this.scheduleRender();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    this.options.post({ type: 'runtimeStatus', payload: status });
    this.scheduleRender();
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.interactions.clear();
    for (const link of this.links.values()) {
      void link.dispose();
    }
    this.links.clear();
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
      if (!byId.has(s.id) && !s.id.startsWith('pending:')) {
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
    const spawner = await this.waitForSpawner(15_000);
    if (!spawner) {
      this.toast('error', t('notConnected'));
      return undefined;
    }
    this.tabs.openNew();
    const pendingKey = `pending:${++this.draftCounter}`;
    this.activeId = pendingKey;
    this.tabs.setCurrentSession(pendingKey);
    const projection = this.projectionFor(pendingKey);

    if (req.title?.trim()) projection.title = req.title.trim();
    if (req.model?.model) {
      await this.selectModel(req.model.provider ?? 'anthropic', req.model.model, req.model.reasoningEffort);
    }
    if (req.permissionPreset) {
      projection.mode =
        req.permissionPreset === 'danger-full-access'
          ? 'bypassPermissions'
          : req.permissionPreset === 'read-only'
            ? 'plan'
            : 'acceptEdits';
    }
    if (req.prompt?.trim()) {
      void this.dispatchSend(pendingKey, req.prompt.trim(), [], false);
    }
    this.scheduleRender();
    return this.activeId;
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

  private boundProviderSig(): string {
    return JSON.stringify(this.options.boundProvider?.() ?? null);
  }

  providersChanged(): void {
    if (this.options.providers) {
      this.options.post({ type: 'providers', payload: this.options.providers() });
    }
    const nextSig = this.boundProviderSig();
    if (nextSig !== this.lastBoundProviderSig) {
      this.lastBoundProviderSig = nextSig;
      for (const [sessionKey] of this.links) {
        if (!(this.projections.get(sessionKey)?.running ?? false)) {
          void this.closeSessionLink(sessionKey);
        }
      }
    }
    this.scheduleRender();
  }

  accountsChanged(): void {
    if (this.options.accounts) {
      this.options.post({ type: 'accounts', payload: this.options.accounts() });
    }
    this.providersChanged();
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
    for (const link of this.links.values()) void link.dispose();
    this.links.clear();
    this.workspacePath = path;
    this.editorContext.clearPinned();
    this.interactions.clear();
    this.stored = [...(this.options.loadSessions() ?? [])].filter((s) => !s.id.startsWith('pending:'));
    this.diskSessions = [];
    this.historyLoaded.clear();
    this.loading.clear();
    this.activeId = this.options.loadActiveSessionId();
    this.projections.clear();
    this.tabs.restore(this.activeId);
    if (this.spawner) {
      void this.refreshDiskSessions();
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
    const sessionId = this.activeId;
    if (!sessionId || sessionId.startsWith('pending:')) {
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
    const filePath = await findClaudeSessionFile(sessionId, this.workspacePath, this.options.claudeConfigDir?.());
    if (filePath) {
      const record = JSON.stringify({ type: 'custom-title', sessionId, customTitle: trimmed });
      await appendFile(filePath, `${record}\n`, 'utf8').catch(() => undefined);
    }
    this.scheduleRender();
  }

  async configureApiKey(): Promise<void> {
    this.toast('info', this.options.signInHint ?? t('acp.claudeSignIn'));
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
        this.toast('info', t('acp.noWebUI', 'Claude Code'));
        return;
      case 'respondApproval': {
        const outcome = this.interactions.respondApproval(message.payload.id, message.payload.decision);
        if (!outcome.ok && outcome.error) {
          this.toast(outcome.error === t('approval.dirty') ? 'error' : 'info', outcome.error);
        }
        return;
      }
      case 'previewApproval': {
        const diffs = this.interactions.approvalDiffs(message.payload.id);
        const diff = diffs[0];
        if (!diff) return;
        const path = this.absolute(diff.path);
        const current = await this.workbench.readFile(path);
        const whole = wholeFile(diff, current);
        await this.workbench.openDiff({
          kind: 'contents',
          path,
          before: whole ?? diff.oldText ?? '',
          after: whole !== undefined && current !== undefined ? current.replace(diff.oldText ?? '', diff.newText) : diff.newText,
          created: diff.oldText === null,
          scope: 'turn',
        });
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
    if (!sessionId || !sessionId.startsWith('pending:')) {
      this.options.saveActiveSessionId(sessionId);
    }
    if (sessionId && !sessionId.startsWith('pending:')) {
      void this.openExisting(sessionId);
    }
    this.scheduleRender();
  }

  private async openExisting(sessionId: string): Promise<void> {
    if (this.historyLoaded.has(sessionId) || this.loading.has(sessionId) || this.links.has(sessionId)) return;
    this.loading.add(sessionId);
    this.scheduleRender();
    try {
      const knownDisk = this.diskSessions.find((s) => s.id === sessionId);
      const filePath =
        knownDisk?.filePath ??
        (await findClaudeSessionFile(sessionId, this.workspacePath, this.options.claudeConfigDir?.()));
      if (filePath) {
        const records = await readClaudeSessionEvents(filePath);
        const projection = this.projectionFor(sessionId);
        projection.applyHistoryRecords(records);
        if (projection.title) this.remember(sessionId, projection.title);
      }
      this.historyLoaded.add(sessionId);
    } catch (error) {
      this.options.log(`读取 Claude Code 会话历史 ${sessionId} 失败：${describe(error)}`);
    } finally {
      this.loading.delete(sessionId);
      this.scheduleRender();
    }
  }

  private async refreshDiskSessions(): Promise<void> {
    try {
      const extraProjects = this.options.projects?.().recent.map((p) => p.path) ?? [];
      this.diskSessions = await scanClaudeSessions(this.workspacePath, this.options.claudeConfigDir?.(), extraProjects);
      this.scheduleRender();
    } catch (error) {
      this.options.log(`扫描 Claude Code 历史会话跳过：${describe(error)}`);
    }
  }

  private async closeSessionLink(sessionKey: string): Promise<void> {
    const link = this.links.get(sessionKey);
    if (!link) return;
    this.links.delete(sessionKey);
    await link.dispose();
  }

  private rekeyPendingSession(oldKey: string, realSessionId: string, initialTitle?: string): void {
    if (oldKey === realSessionId || !oldKey.startsWith('pending:')) return;
    const projection = this.projections.get(oldKey);
    if (projection) {
      this.projections.delete(oldKey);
      this.projections.set(realSessionId, projection);
    }
    const link = this.links.get(oldKey);
    if (link) {
      this.links.delete(oldKey);
      this.links.set(realSessionId, link);
    }
    const queue = this.queues.get(oldKey);
    if (queue) {
      this.queues.delete(oldKey);
      this.queues.set(realSessionId, queue);
    }
    const pendingMode = this.pendingModes.get(oldKey);
    if (pendingMode !== undefined) {
      this.pendingModes.delete(oldKey);
      this.pendingModes.set(realSessionId, pendingMode);
    }
    this.interactions.rekeySession(oldKey, realSessionId);
    this.historyLoaded.add(realSessionId);

    for (const tab of this.tabs.items) {
      if (tab.sessionId === oldKey) {
        tab.sessionId = realSessionId;
      }
    }
    if (this.activeId === oldKey) {
      this.activeId = realSessionId;
      this.options.saveActiveSessionId(realSessionId);
      this.tabs.setCurrentSession(realSessionId);
    }
    const title = initialTitle || projection?.title || t('acp.untitled');
    this.remember(realSessionId, title);
    this.options.onSessionRekey?.(oldKey, realSessionId);
  }

  private async ensureSessionLink(
    sessionKey: string,
    isResume: boolean,
    initialPromptTitle?: string,
  ): Promise<{ readonly key: string; readonly link: ClaudeLink }> {
    let currentKey = sessionKey;
    const existing = this.links.get(currentKey);
    if (existing?.running) return { key: currentKey, link: existing };
    if (!this.spawner) throw new Error(t('notConnected'));

    const modelState = this.buildModelState();
    const chosenModel = modelState.current?.model;
    const chosenEffort = modelState.current?.reasoningEffort;
    const projection = this.projectionFor(currentKey);
    const mode = projection.mode ?? this.draftMode;
    // bypassPermissions 通过客户端拦截器立即放行所有 can_use_tool 请求，避免 root 环境下 CLI 拒绝 --permission-mode bypassPermissions
    const cliMode = mode === 'bypassPermissions' ? 'default' : mode;

    const link = await this.spawner({
      ...(isResume && !currentKey.startsWith('pending:') ? { resumeSessionId: currentKey } : {}),
      ...(chosenModel ? { model: chosenModel } : {}),
      ...(chosenEffort ? { effort: chosenEffort } : {}),
      ...(cliMode ? { permissionMode: cliMode } : {}),
      cwd: this.workspacePath,
      onEvent: (event) => {
        const emittedId =
          typeof event.session_id === 'string' && event.session_id
            ? event.session_id
            : typeof event.sessionId === 'string' && event.sessionId
              ? event.sessionId
              : undefined;
        if (emittedId && currentKey.startsWith('pending:')) {
          const prevKey = currentKey;
          currentKey = emittedId;
          this.rekeyPendingSession(prevKey, emittedId, initialPromptTitle);
        }

        const proj = this.projectionFor(currentKey);
        const wasRunning = proj.running;
        const desiredModeBeforeInit = proj.mode;
        proj.applyEvent(event);
        if (
          event.type === 'system' &&
          event.subtype === 'init' &&
          desiredModeBeforeInit &&
          desiredModeBeforeInit !== 'bypassPermissions' &&
          typeof event.permissionMode === 'string' &&
          event.permissionMode &&
          event.permissionMode !== desiredModeBeforeInit
        ) {
          const activeLink = this.links.get(currentKey);
          if (activeLink?.running) {
            void activeLink
              .sendControlRequest({ subtype: 'set_permission_mode', mode: desiredModeBeforeInit }, 8_000)
              .catch(() => undefined);
          }
        }
        if (proj.slashCommands.length > 0) {
          this.discoveredSlashCommands = [...new Set([...this.discoveredSlashCommands, ...proj.slashCommands])];
        }
        if (proj.title) this.remember(currentKey, proj.title);

        if (wasRunning && !proj.running && event.type === 'result') {
          void this.refreshDiskSessions();
          void this.drainQueue(currentKey);
        }
        this.scheduleRender();
      },
      onControlRequest: async (_reqId, request) => {
        const proj = this.projectionFor(currentKey);
        const effectiveMode = proj.mode ?? this.draftMode;
        if (
          effectiveMode === 'bypassPermissions' &&
          request.subtype === 'can_use_tool' &&
          request.tool_name !== 'AskUserQuestion' &&
          request.tool_name !== 'ExitPlanMode'
        ) {
          const input =
            request.input && typeof request.input === 'object' && !Array.isArray(request.input)
              ? (request.input as Record<string, unknown>)
              : {};
          return { behavior: 'allow', updatedInput: input };
        }
        return this.interactions.handleControlRequest(currentKey, request);
      },
      onExit: (code, signal, stderr) => {
        this.links.delete(currentKey);
        this.interactions.clear(currentKey);
        const proj = this.projections.get(currentKey);
        if (proj?.running) {
          const errDetail = stderr.split('\n').slice(-5).join('\n').trim() || `Exited (${signal ?? code})`;
          proj.endTurn(Date.now(), 'failed', this.describeAuthOrError(errDetail));
        }
        this.scheduleRender();
      },
    });

    this.links.set(currentKey, link);
    return { key: currentKey, link };
  }

  // ---------------------------------------------------------------- 消息发送、队列与中断

  async send(text: string, options: GatherOptions & { images?: readonly PromptImage[] } = {}): Promise<boolean> {
    const slash = parseSlash(text);
    if (slash?.name === 'new') {
      this.tabs.openNew();
      return slash.args.trim() ? this.send(slash.args, options) : true;
    }
    if (slash?.name === 'plan') {
      const currentMode = this.currentMode();
      const nextMode =
        slash.args.trim() === 'off' ? 'default' : currentMode === 'plan' && !slash.args.trim() ? 'default' : 'plan';
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
    if (!this.spawner) {
      this.toast('error', t('notConnected'));
      return false;
    }

    let sessionKey = this.activeId;
    let isResume = Boolean(sessionKey && !sessionKey.startsWith('pending:'));
    if (!sessionKey) {
      sessionKey = `pending:${++this.draftCounter}`;
      isResume = false;
      this.activeId = sessionKey;
      this.tabs.setCurrentSession(sessionKey);
      const proj = this.projectionFor(sessionKey);
      proj.title = (prompt || t('acp.image')).replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE);
      proj.mode = this.draftMode;
    }

    this.editorContext.clearPinned();
    const projection = this.projectionFor(sessionKey);
    const images = options.images ?? [];
    if (projection.running) {
      const queue = this.queues.get(sessionKey) ?? [];
      queue.push({ id: `q${++this.queueCounter}`, text: full, images });
      this.queues.set(sessionKey, queue);
      this.scheduleRender();
      return true;
    }

    await this.dispatchSend(sessionKey, full, images, isResume, prompt || t('acp.image'));
    return true;
  }

  private async dispatchSend(
    sessionKey: string,
    text: string,
    images: readonly PromptImage[],
    isResume: boolean,
    titleHint?: string,
  ): Promise<void> {
    const projection = this.projectionFor(sessionKey);
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

    const content: string | readonly Record<string, unknown>[] =
      images.length > 0
        ? [
            ...(text.trim() ? [{ type: 'text', text }] : []),
            ...images.map((img) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.data,
              },
            })),
          ]
        : text;

    try {
      const pendingMode = this.pendingModes.get(sessionKey);
      if (pendingMode !== undefined) {
        this.pendingModes.delete(sessionKey);
        projection.mode = pendingMode;
      }
      const { key, link } = await this.ensureSessionLink(sessionKey, isResume, titleHint);
      if (pendingMode !== undefined && link.running) {
        const cliMode = pendingMode === 'bypassPermissions' ? 'default' : pendingMode;
        await link.sendControlRequest({ subtype: 'set_permission_mode', mode: cliMode }, 8_000).catch(() => undefined);
      }
      const sid = key.startsWith('pending:') ? '' : key;
      link.sendUserMessage(content, sid);
      if (!key.startsWith('pending:')) {
        this.remember(key, this.titleOf(key));
      }
    } catch (error) {
      projection.endTurn(Date.now(), 'failed', this.describeAuthOrError(error));
      this.scheduleRender();
    }
  }

  private async drainQueue(sessionKey: string): Promise<void> {
    const next = this.queues.get(sessionKey)?.shift();
    if (!next) return;
    await this.dispatchSend(sessionKey, next.text, next.images, !sessionKey.startsWith('pending:'));
  }

  private async interrupt(): Promise<void> {
    const sessionKey = this.activeId;
    if (!sessionKey) return;
    this.interactions.clear(sessionKey);
    const link = this.links.get(sessionKey);
    if (link?.running) {
      await link.sendControlRequest({ subtype: 'interrupt' }, 5_000).catch(() => undefined);
    }
    const projection = this.projections.get(sessionKey);
    if (projection?.running) {
      projection.endTurn(Date.now(), 'cancelled');
    }
    this.scheduleRender();
  }

  private async queueAction(payload: Extract<WebviewToHost, { type: 'queueAction' }>['payload']): Promise<void> {
    const sessionKey = this.activeId;
    const queue = sessionKey ? this.queues.get(sessionKey) : undefined;
    if (!sessionKey || !queue) return;
    const index = queue.findIndex((q) => q.id === payload.itemId);
    if (index < 0) return;

    if (payload.action === 'remove') {
      queue.splice(index, 1);
    } else if (payload.action === 'edit') {
      const original = queue[index]!;
      const at = original.text.lastIndexOf(`\n\n${CONTEXT_OPEN}\n`);
      const text = at >= 0 ? `${payload.text}${original.text.slice(at)}` : payload.text;
      queue[index] = { ...original, text };
    } else if (payload.action === 'send' || payload.action === 'steer') {
      const [item] = queue.splice(index, 1);
      if (!item) return;
      const running = this.projections.get(sessionKey)?.running ?? false;
      if (!running) {
        this.scheduleRender();
        await this.dispatchSend(sessionKey, item.text, item.images, !sessionKey.startsWith('pending:'));
        return;
      }
      // steer 时排在队首，当前轮结束后第一时间发送
      queue.unshift(item);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模型与权限模式

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
    const options = boundOpts.length > 0 ? boundOpts : [...BUILTIN_CLAUDE_MODELS];
    if (options.length === 0) return { options: [] };

    const defaultFromBound: ClaudePreferredModel | undefined =
      bound && (bound.defaultModel || bound.models[0]?.id)
        ? { provider: bound.id, model: bound.defaultModel ?? bound.models[0]!.id }
        : undefined;
    const fallbackFirst: ClaudePreferredModel = {
      provider: options[0]!.provider,
      model: options[0]!.model,
      ...(options[0]!.defaultEffort ? { effort: options[0]!.defaultEffort } : {}),
    };
    const current: ClaudePreferredModel =
      this.selectedModel &&
      (bound
        ? this.selectedModel.provider === bound.id &&
          (bound.models.length === 0 || bound.models.some((m) => m.id === this.selectedModel!.model))
        : true)
        ? this.selectedModel
        : (defaultFromBound ?? fallbackFirst);
    if (bound && current.provider === bound.id) {
      this.options.onProviderModelSelected?.(bound.id, current.model);
    }

    const exists = options.some((o) => o.provider === current.provider && o.model === current.model);
    const mergedOptions = exists
      ? options
      : [
          {
            provider: current.provider,
            model: current.model,
            name: current.model,
            group: bound ? bound.name : 'Anthropic',
            efforts: CLAUDE_EFFORTS,
          },
          ...options,
        ];
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
    const prevModel = this.selectedModel?.model;
    const prevProvider = this.selectedModel?.provider;
    const prevEffort = this.selectedModel?.effort;
    this.selectedModel = { provider, model, ...(effort ? { effort } : {}) };
    this.options.savePreferredModel?.(this.selectedModel);

    if (this.activeId) {
      const link = this.links.get(this.activeId);
      if (link?.running) {
        const modelChanged = model !== prevModel || provider !== prevProvider;
        const effortChanged = effort !== prevEffort;
        if ((modelChanged || effortChanged) && !(this.projections.get(this.activeId)?.running ?? false)) {
          // 思考档位与绑定的环境变量在启动时注入：会话空闲时关闭旧进程，下一条消息以新模型与配置重启（--resume）
          await this.closeSessionLink(this.activeId);
        } else {
          await link.sendControlRequest({ subtype: 'set_model', model }, 8_000).catch(() => undefined);
        }
      }
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
    const labelInfo = CLAUDE_MODES.find((m) => m.id === mode);
    const displayName = labelInfo ? (getLocale() === 'zh' ? labelInfo.zh : labelInfo.en) : mode;
    if (preConfirmed !== true && isUnrestrictedMode(mode, displayName)) {
      if (
        !(await this.workbench.confirm(
          t('acp.dangerTitle', displayName),
          t('acp.dangerDetail', 'Claude Code', displayName),
          t('acp.dangerAllow', displayName),
        ))
      ) {
        return;
      }
    }
    this.draftMode = mode;
    if (this.activeId) {
      const projection = this.projectionFor(this.activeId);
      if (projection.running) {
        // 正在回复中：记录待应用权限，延后到下一轮发送前再通知底层，不打断当前回合
        this.pendingModes.set(this.activeId, mode);
        this.toast('info', t('permission.nextTurn', displayName));
        this.scheduleRender();
        return;
      }
      this.pendingModes.delete(this.activeId);
      projection.mode = mode;
      const link = this.links.get(this.activeId);
      if (link?.running) {
        const cliMode = mode === 'bypassPermissions' ? 'default' : mode;
        await link.sendControlRequest({ subtype: 'set_permission_mode', mode: cliMode }, 8_000).catch(() => undefined);
      }
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- Diff 与视图渲染

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

  private sessionChanges(projection: ClaudeSessionProjection | undefined): SessionChangesView | undefined {
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
      ...(view.session.id && !view.session.id.startsWith('pending:') ? { sessionId: view.session.id } : {}),
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
    const sessionKey = this.activeId;
    const projection = sessionKey ? this.projections.get(sessionKey) : undefined;
    const running = projection?.running ?? false;
    const queue = sessionKey ? (this.queues.get(sessionKey) ?? []) : [];
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
      ...(sessionKey ? { id: sessionKey } : {}),
      title: this.titleOf(sessionKey),
      running,
      hasOlder: false,
      loadingOlder: false,
      sync: !sessionKey ? 'idle' : this.loading.has(sessionKey) || !this.spawner ? 'opening' : 'live',
      ...(usage
        ? {
            contextUsage: Math.min(1, usage.used / usage.size),
            contextTokens: { used: usage.used, window: usage.size },
          }
        : {}),
      ...(contextDetail ? { contextDetail } : {}),
      ...(mode === 'plan' ? { planMode: true } : {}),
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
      if (!known.has(s.id) && !otherWorkspaceIds.has(s.id) && !s.id.startsWith('pending:')) {
        known.set(s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt, ...state(s.id) });
      }
    }
    const isHidden = this.options.isHiddenSession;
    const sessions = [...known.values()]
      .filter((s) => !isHidden?.(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const locale = getLocale();
    const permissions: PermissionState = {
      options: CLAUDE_MODES.map((m) => m.id),
      current: mode,
      labels: Object.fromEntries(CLAUDE_MODES.map((m) => [m.id, { name: locale === 'zh' ? m.zh : m.en }])),
    };

    const baseCommands: CommandView[] = [
      ...pluginCommands().map((c) => ({ ...c, source: 'plugin' as const })),
      ...this.discoveredSlashCommands
        .map((c) => c.replace(/^\/+/u, '').trim())
        .filter((c) => c.length > 0 && c !== 'new' && c !== 'plan')
        .map((name) => ({ name, description: 'Claude Code command', source: 'agent' as const })),
    ];
    const takenNames = new Set(baseCommands.map((c) => c.name));
    const extraSkills: CommandView[] = skillsForBackend(this.options.extensions?.().skills.items ?? [], 'claude')
      .filter((s) => !takenNames.has(s.name))
      .map((s) => ({ name: s.name, description: s.description, source: 'skill' as const }));
    const commands: CommandView[] = [...baseCommands, ...extraSkills];

    return {
      sessionKey: sessionKey ?? '',
      sessions,
      tabs: this.tabsState(session),
      session,
      items,
      models: this.buildModelState(),
      interactions: this.interactions.viewsFor(sessionKey),
      permissions,
      workspace: { dirtyFiles: this.workbench.dirtyFiles().length },
      context: this.editorContext.state(),
      commands,
    };
  }

  private projectionFor(sessionKey: string): ClaudeSessionProjection {
    let p = this.projections.get(sessionKey);
    if (!p) {
      p = new ClaudeSessionProjection(this.workspacePath);
      this.projections.set(sessionKey, p);
    }
    return p;
  }

  private remember(sessionId: string, title: string, force = false): void {
    if (sessionId.startsWith('pending:')) return;
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
    if (/auth|credential|api[-_ ]?key|unauthoriz|not logged|login|invalid x-api-key/iu.test(msg)) {
      return this.options.signInHint ? `${msg}（${this.options.signInHint}）` : msg;
    }
    return msg;
  }

  private async waitForSpawner(timeoutMs: number): Promise<ClaudeSessionSpawner | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spawner) return this.spawner;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.spawner;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 工作台核心协调器（WorkbenchHub）：统一编排五大模块的状态与动作。
 *
 * 1. 总览（overview）：聚合「等我、待办、在跑、接下来、未读」五块实时状态
 * 2. 定时（schedules）：15 秒轮询触发 + 手动立即执行，调用 UnattendedRunner 隔离运行，结果只进规则历史、不进左侧会话列表
 * 3. 智能体（agents）：管理智能体专长/指令/模型/工具配置，支持直接开始会话或委派任务
 * 4. 任务（tasks）：四列看板（待执行/执行中/待验收/已完成）及按顺序连续执行调度器
 * 5. 会话（sessions）：跨项目会话注册表与按项目分组会话管理
 */
import { basename } from 'node:path';
import type {
  AgentProfile,
  GroupedSessionItem,
  HostSnapshot,
  HostToWebview,
  OverviewRunningItem,
  OverviewTodoItem,
  OverviewUnreadItem,
  OverviewUpcomingItem,
  OverviewWaitingItem,
  ProjectsState,
  ProjectSessionGroup,
  TaskBoardState,
  WebviewToHost,
  WorkbenchModule,
  WorkbenchOverview,
  WorkbenchState,
} from '@harness-deck/shared';
import type { BackendProfile, CrossProjectSession, ProgrammaticSessionRequest, SessionObservation } from '../backend/types.ts';
import {
  composeAgentPrompt,
  deleteStoredAgent,
  parseStoredAgentData,
  resolveAgentProfiles,
  upsertStoredAgent,
  type StoredAgentData,
} from './AgentStore.ts';
import {
  appendHiddenSessionId,
  attachRunSessionId,
  beginScheduleRun,
  deleteScheduleRule,
  findDueRules,
  finishScheduleRun,
  markScheduleRunAsRead,
  parseStoredScheduleData,
  toggleScheduleRule,
  upsertScheduleRule,
  type StoredScheduleData,
} from './ScheduleEngine.ts';
import {
  activeRunningTask,
  clearDoneKanbanTasks,
  createKanbanTask,
  deleteKanbanTask,
  markKanbanTaskRead,
  nextQueuedTask,
  parseTaskBoardState,
  reorderKanbanTask,
  setKanbanAutoRun,
  updateKanbanTaskStatus,
} from './TaskBoardStore.ts';
import type { SchedulePermissionPreset, UnattendedRunner } from './UnattendedRunner.ts';

const SCHEDULES_STORAGE_KEY = 'harnessDeck.hub.schedules';
const AGENTS_STORAGE_KEY = 'harnessDeck.hub.agents';
const TASKS_STORAGE_KEY = 'harnessDeck.hub.tasks';
const SESSION_REGISTRY_KEY = 'harnessDeck.hub.sessionRegistry';
const MAX_REGISTRY_SESSIONS = 400;
const TICK_INTERVAL_MS = 15_000;

export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

interface StoredRegistrySession {
  readonly id: string;
  readonly title: string;
  readonly projectPath: string;
  readonly backendId: string;
  readonly updatedAt: number;
  readonly unread?: boolean;
  readonly unreadSummary?: string;
  readonly agentName?: string;
}

export interface ActiveControllerContext {
  readonly backendId: string;
  readonly backendName: string;
  readonly workspacePath: string;
  readonly snapshot: HostSnapshot;
  readonly crossProjectSessions: readonly CrossProjectSession[];
  readonly latestAssistantText: (sessionId: string) => string | undefined;
}

export interface WorkbenchHubHost {
  readonly globalState: StateStore;
  readonly runner: UnattendedRunner;
  readonly locale: () => 'zh' | 'en';
  readonly isWorkspaceTrusted: () => boolean;
  readonly isWebviewVisible: () => boolean;
  readonly workspacePath: () => string;
  readonly projects: () => ProjectsState;
  readonly profiles: () => readonly BackendProfile[];
  readonly schedulePermission: () => SchedulePermissionPreset;
  readonly activeContext: () => ActiveControllerContext | undefined;
  readonly switchProjectAndBackend: (projectPath: string, backendId?: string) => Promise<void>;
  readonly startProgrammaticSession: (req: ProgrammaticSessionRequest) => Promise<string | undefined>;
  readonly switchSessionInActive: (sessionId: string) => Promise<void>;
  readonly openNewSessionInActive: () => Promise<void>;
  readonly post: (message: HostToWebview) => void;
  readonly focusView: () => Thenable<unknown>;
  readonly openPanel: () => void;
  readonly notifyScheduledComplete?: (ruleName: string, status: 'succeeded' | 'failed') => void;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly enableTimer?: boolean;
}

interface ActiveTaskTracker {
  readonly taskId: string;
  readonly sessionId: string;
  sawRunning: boolean;
}

export class WorkbenchHub {
  private scheduleData: StoredScheduleData;
  private hiddenSet: Set<string>;
  private agentData: StoredAgentData;
  private taskBoard: TaskBoardState;
  private registry = new Map<string, StoredRegistrySession>();
  private readonly runningRuleIds = new Set<string>();
  private readonly sessionPrevRunning = new Map<string, boolean>();
  private activeTaskTracker: ActiveTaskTracker | undefined;
  private taskDispatching = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();

  constructor(private readonly host: WorkbenchHubHost) {
    const now = this.now();
    const interruptedNote =
      this.host.locale() === 'zh' ? 'VS Code 重启或扩展重载导致执行中断' : 'Interrupted by extension reload';
    this.scheduleData = parseStoredScheduleData(host.globalState.get(SCHEDULES_STORAGE_KEY), now, interruptedNote);
    this.hiddenSet = new Set(this.scheduleData.hiddenSessionIds);
    this.agentData = parseStoredAgentData(host.globalState.get(AGENTS_STORAGE_KEY));
    this.taskBoard = parseTaskBoardState(host.globalState.get(TASKS_STORAGE_KEY));
    this.loadRegistry(host.globalState.get(SESSION_REGISTRY_KEY));

    if (host.enableTimer !== false) {
      this.tickTimer = setInterval(() => {
        void this.tickSchedules();
      }, TICK_INTERVAL_MS);
      this.tickTimer.unref?.();
      // 启动后延迟 3 秒检查一次到期定时任务
      const bootTimer = setTimeout(() => {
        if (!this.abort.signal.aborted) void this.tickSchedules();
      }, 3_000);
      bootTimer.unref?.();
    }
  }

  dispose(): void {
    this.abort.abort(new Error('Extension deactivated'));
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }

  /** 判断某个会话 id 是否属于定时任务的隐藏会话（不出现在左侧会话列表中）。 */
  isHiddenSession = (sessionId: string): boolean => {
    return this.hiddenSet.has(sessionId);
  };

  /** 当前完整工作台视图状态。 */
  state(): WorkbenchState {
    const ctx = this.host.activeContext();
    if (ctx) {
      this.syncRegistryFromContext(ctx);
    }
    const agents = resolveAgentProfiles(this.agentData, this.host.locale());
    const sessionGroups = this.buildSessionGroups(ctx);
    const overview = this.buildOverview(ctx, sessionGroups);
    return {
      overview,
      schedules: this.scheduleData.rules,
      agents,
      tasks: this.taskBoard,
      sessionGroups,
    };
  }

  /** 主动合并推送最新 WorkbenchState 给 Webview。 */
  schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (this.abort.signal.aborted) return;
      this.host.post({ type: 'workbench', payload: this.state() });
    }, 30);
  }

  pushNow(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    if (this.abort.signal.aborted) return;
    this.host.post({ type: 'workbench', payload: this.state() });
  }

  /** 监听前台控制器的会话状态变化：驱动顺序任务流转与未读会话标记。 */
  observeSession(obs: SessionObservation): void {
    const ctx = this.host.activeContext();
    if (obs.sessionId && !this.isHiddenSession(obs.sessionId)) {
      const regKey = `${ctx?.backendId ?? 'dsh'}:${obs.sessionId}`;
      const prevRunning = this.sessionPrevRunning.get(regKey) ?? false;
      this.sessionPrevRunning.set(regKey, obs.running);

      const existing = this.registry.get(regKey);
      const isActivelyViewed = this.host.isWebviewVisible() && ctx?.snapshot.session.id === obs.sessionId;

      if (prevRunning && !obs.running && !obs.turnAborted && !isActivelyViewed) {
        const summary = ctx?.latestAssistantText(obs.sessionId) ?? '';
        if (existing) {
          this.registry.set(regKey, {
            ...existing,
            title: obs.title || existing.title,
            updatedAt: this.now(),
            unread: true,
            ...(summary ? { unreadSummary: summary.slice(0, 240) } : {}),
          });
          this.persistRegistry();
        }
      } else if (isActivelyViewed && existing?.unread) {
        const { unread: _u, unreadSummary: _s, ...rest } = existing;
        this.registry.set(regKey, rest);
        this.persistRegistry();
      }

      // 检查是否关联了正在执行的看板任务
      const tracker = this.activeTaskTracker;
      if (tracker && tracker.sessionId === obs.sessionId) {
        if (obs.running) {
          tracker.sawRunning = true;
        } else if (tracker.sawRunning || obs.hasTurnOutput || obs.turnAborted) {
          this.activeTaskTracker = undefined;
          void this.settleRunningTask(tracker.taskId, obs.sessionId, Boolean(obs.turnAborted));
        }
      }
    }
    this.schedulePush();
  }

  /** 处理来自 Webview 的工作台专属消息；返回 true 表示已由 Hub 消费。 */
  async handleMessage(message: WebviewToHost): Promise<boolean> {
    switch (message.type) {
      case 'openWorkbenchPanel':
        this.host.openPanel();
        return true;

      case 'markUnreadRead':
        await this.markUnreadRead(message.payload);
        return true;

      case 'upsertSchedule': {
        const projectPath = message.payload.projectPath || this.host.workspacePath();
        const { rules } = upsertScheduleRule(
          this.scheduleData.rules,
          {
            ...(message.payload.id ? { id: message.payload.id } : {}),
            name: message.payload.name,
            prompt: message.payload.prompt,
            frequency: message.payload.frequency,
            backendId: message.payload.backendId,
            projectPath,
            ...(message.payload.enabled !== undefined ? { enabled: message.payload.enabled } : {}),
          },
          this.now(),
        );
        await this.saveScheduleData({ ...this.scheduleData, rules });
        this.pushNow();
        return true;
      }

      case 'toggleSchedule': {
        const rules = toggleScheduleRule(this.scheduleData.rules, message.payload.id, message.payload.enabled, this.now());
        await this.saveScheduleData({ ...this.scheduleData, rules });
        this.pushNow();
        return true;
      }

      case 'deleteSchedule': {
        const rules = deleteScheduleRule(this.scheduleData.rules, message.payload.id);
        await this.saveScheduleData({ ...this.scheduleData, rules });
        this.pushNow();
        return true;
      }

      case 'runScheduleNow':
        void this.executeScheduleRule(message.payload.id);
        return true;

      case 'markScheduleRunRead': {
        const rules = markScheduleRunAsRead(this.scheduleData.rules, message.payload.ruleId, message.payload.runId);
        await this.saveScheduleData({ ...this.scheduleData, rules });
        this.pushNow();
        return true;
      }

      case 'upsertAgent': {
        const { stored } = upsertStoredAgent(this.agentData, message.payload, this.now(), this.host.locale());
        this.agentData = stored;
        await this.host.globalState.update(AGENTS_STORAGE_KEY, stored);
        this.pushNow();
        return true;
      }

      case 'deleteAgent': {
        const stored = deleteStoredAgent(this.agentData, message.payload.id, this.host.locale());
        this.agentData = stored;
        await this.host.globalState.update(AGENTS_STORAGE_KEY, stored);
        this.pushNow();
        return true;
      }

      case 'startAgentSession':
        await this.startAgentSession(message.payload);
        return true;

      case 'delegateToAgent':
        await this.delegateToAgent(message.payload);
        return true;

      case 'createTask': {
        const { board, task } = createKanbanTask(this.taskBoard, message.payload, this.now());
        this.taskBoard = board;
        await this.saveTaskBoard();
        this.pushNow();
        if (message.payload.autoStart || this.taskBoard.autoRun) {
          void this.pumpTaskQueue(message.payload.autoStart ? task.id : undefined);
        }
        return true;
      }

      case 'updateTaskStatus': {
        if (this.activeTaskTracker?.taskId === message.payload.id && message.payload.status !== 'in_progress') {
          this.activeTaskTracker = undefined;
        }
        this.taskBoard = updateKanbanTaskStatus(this.taskBoard, message.payload.id, message.payload.status, this.now());
        await this.saveTaskBoard();
        this.pushNow();
        if (this.taskBoard.autoRun) {
          void this.pumpTaskQueue();
        }
        return true;
      }

      case 'reorderTask': {
        this.taskBoard = reorderKanbanTask(this.taskBoard, message.payload.id, message.payload.direction);
        await this.saveTaskBoard();
        this.pushNow();
        return true;
      }

      case 'deleteTask': {
        if (this.activeTaskTracker?.taskId === message.payload.id) {
          this.activeTaskTracker = undefined;
        }
        this.taskBoard = deleteKanbanTask(this.taskBoard, message.payload.id);
        await this.saveTaskBoard();
        this.pushNow();
        return true;
      }

      case 'clearDoneTasks': {
        this.taskBoard = clearDoneKanbanTasks(this.taskBoard);
        await this.saveTaskBoard();
        this.pushNow();
        return true;
      }

      case 'setTaskQueueAutoRun': {
        this.taskBoard = setKanbanAutoRun(this.taskBoard, message.payload.autoRun);
        await this.saveTaskBoard();
        this.pushNow();
        if (message.payload.autoRun) {
          void this.pumpTaskQueue();
        }
        return true;
      }

      case 'runTaskNow':
        void this.pumpTaskQueue(message.payload.id);
        return true;

      case 'startProjectSession': {
        await this.host.switchProjectAndBackend(message.payload.projectPath, message.payload.backendId);
        await this.host.openNewSessionInActive();
        this.host.post({ type: 'switchWorkbenchModule', payload: { module: 'sessions' } });
        this.host.post({ type: 'focusComposer', payload: {} });
        this.pushNow();
        return true;
      }

      case 'openProjectSession': {
        await this.host.switchProjectAndBackend(message.payload.projectPath, message.payload.backendId);
        await this.host.switchSessionInActive(message.payload.sessionId);
        await this.clearSessionUnread(message.payload.sessionId, message.payload.backendId);
        this.host.post({ type: 'switchWorkbenchModule', payload: { module: 'sessions' } });
        this.pushNow();
        return true;
      }

      default:
        return false;
    }
  }

  /** 定时轮询入口（测试也可直接调用）。 */
  async tickSchedules(): Promise<void> {
    if (this.abort.signal.aborted || !this.host.isWorkspaceTrusted()) return;
    const due = findDueRules(this.scheduleData.rules, this.now(), this.runningRuleIds);
    for (const rule of due) {
      void this.executeScheduleRule(rule.id);
    }
  }

  /** 立即在隔离后台会话里执行一条定时规则。 */
  async executeScheduleRule(ruleId: string): Promise<void> {
    if (this.runningRuleIds.has(ruleId)) return;
    const rule = this.scheduleData.rules.find((r) => r.id === ruleId);
    if (!rule) return;
    if (!this.host.isWorkspaceTrusted()) {
      this.host.post({
        type: 'toast',
        payload: {
          level: 'error',
          text: this.host.locale() === 'zh' ? '当前工作区未受信任，无法运行定时任务' : 'Workspace is untrusted; cannot run scheduled task',
        },
      });
      return;
    }

    const profile = this.host.profiles().find((p) => p.id === rule.backendId) ?? this.host.profiles()[0];
    if (!profile) return;

    this.runningRuleIds.add(ruleId);
    const { rules: startedRules, run } = beginScheduleRun(this.scheduleData.rules, ruleId, this.now());
    if (!run) {
      this.runningRuleIds.delete(ruleId);
      return;
    }
    await this.saveScheduleData({ ...this.scheduleData, rules: startedRules });
    this.pushNow();

    try {
      const outcome = await this.host.runner.run({
        profile,
        projectPath: rule.projectPath,
        prompt: rule.prompt,
        permission: this.host.schedulePermission(),
        signal: this.abort.signal,
        onSessionCreated: (sessionId) => {
          this.registerHiddenSession(sessionId, ruleId, run.id);
        },
      });

      const finishedRules = finishScheduleRun(this.scheduleData.rules, ruleId, run.id, {
        status: outcome.status,
        endedAt: this.now(),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.output ? { output: outcome.output } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      await this.saveScheduleData({ ...this.scheduleData, rules: finishedRules });
      this.host.notifyScheduledComplete?.(rule.name, outcome.status);
    } catch (error) {
      const finishedRules = finishScheduleRun(this.scheduleData.rules, ruleId, run.id, {
        status: 'failed',
        endedAt: this.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.saveScheduleData({ ...this.scheduleData, rules: finishedRules });
    } finally {
      this.runningRuleIds.delete(ruleId);
      this.pushNow();
    }
  }

  private registerHiddenSession(sessionId: string, ruleId: string, runId: string): void {
    this.hiddenSet.add(sessionId);
    const hiddenSessionIds = appendHiddenSessionId(this.scheduleData.hiddenSessionIds, sessionId);
    const rules = attachRunSessionId(this.scheduleData.rules, ruleId, runId, sessionId);
    this.scheduleData = { rules, hiddenSessionIds };
    void this.host.globalState.update(SCHEDULES_STORAGE_KEY, this.scheduleData);
  }

  private async startAgentSession(payload: Extract<WebviewToHost, { type: 'startAgentSession' }>['payload']): Promise<void> {
    const agents = resolveAgentProfiles(this.agentData, this.host.locale());
    const agent = agents.find((a) => a.id === payload.agentId);
    if (!agent) return;
    const projectPath = payload.projectPath || this.host.workspacePath();
    await this.host.switchProjectAndBackend(projectPath, agent.backendId);

    const initialText = payload.initialPrompt?.trim()
      ? composeAgentPrompt(agent, payload.initialPrompt)
      : composeAgentPrompt(
          agent,
          this.host.locale() === 'zh'
            ? `请以「${agent.name}」的身份就绪，简要确认你的专长与当前可用边界，等待我的下一步指令。`
            : `Stand by as "${agent.name}", briefly confirm your specialty and active tool boundaries, and await my instructions.`,
        );

    const sessionId = await this.host.startProgrammaticSession({
      prompt: initialText,
      title: `${agent.name}`,
      ...(agent.model
        ? {
            model: {
              ...(agent.provider ? { provider: agent.provider } : {}),
              model: agent.model,
              ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
            },
          }
        : {}),
      permissionPreset: agent.tools.permissionPreset,
    });

    if (sessionId) {
      this.recordAgentOnSession(agent.backendId, sessionId, projectPath, agent.name, agent.name);
    }
    this.host.post({ type: 'switchWorkbenchModule', payload: { module: 'sessions' } });
    this.host.post({ type: 'focusComposer', payload: {} });
    this.pushNow();
  }

  private async delegateToAgent(payload: Extract<WebviewToHost, { type: 'delegateToAgent' }>['payload']): Promise<void> {
    const agents = resolveAgentProfiles(this.agentData, this.host.locale());
    const agent = agents.find((a) => a.id === payload.agentId);
    if (!agent) return;
    const projectPath = payload.projectPath || this.host.workspacePath();

    const { board, task } = createKanbanTask(
      this.taskBoard,
      {
        prompt: payload.prompt,
        projectPath,
        backendId: agent.backendId,
        ...(agent.provider ? { provider: agent.provider } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
        agentId: agent.id,
      },
      this.now(),
    );
    this.taskBoard = board;
    await this.saveTaskBoard();
    const shouldRun = payload.runImmediately !== false || this.taskBoard.autoRun;
    this.host.post({ type: 'switchWorkbenchModule', payload: { module: 'tasks' as WorkbenchModule } });
    this.pushNow();
    if (shouldRun) {
      void this.pumpTaskQueue(payload.runImmediately !== false ? task.id : undefined);
    }
  }

  /** 按顺序调度下一个待执行看板任务（同一时刻最多运行 1 条任务）。 */
  private async pumpTaskQueue(explicitTaskId?: string): Promise<void> {
    if (this.taskDispatching || this.abort.signal.aborted) return;
    if (activeRunningTask(this.taskBoard)) return;
    if (!this.host.isWorkspaceTrusted()) return;

    // 若前台当前会话正忙于回复用户的手动提问，等空闲再调度，避免打断当前轮次
    const ctx = this.host.activeContext();
    if (ctx?.snapshot.session.running && !explicitTaskId) return;

    const target = explicitTaskId
      ? this.taskBoard.items.find((t) => t.id === explicitTaskId && t.status === 'todo')
      : nextQueuedTask(this.taskBoard);
    if (!target) return;

    this.taskDispatching = true;
    try {
      const agents = resolveAgentProfiles(this.agentData, this.host.locale());
      const agent: AgentProfile | undefined = target.agentId ? agents.find((a) => a.id === target.agentId) : undefined;
      const fullPrompt = agent ? composeAgentPrompt(agent, target.prompt) : target.prompt;

      this.taskBoard = updateKanbanTaskStatus(this.taskBoard, target.id, 'in_progress', this.now());
      await this.saveTaskBoard();
      this.pushNow();

      await this.host.switchProjectAndBackend(target.projectPath, target.backendId);
      const sessionId = await this.host.startProgrammaticSession({
        prompt: fullPrompt,
        title: target.title,
        ...(target.model
          ? {
              model: {
                ...(target.provider ? { provider: target.provider } : {}),
                model: target.model,
                ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
              },
            }
          : {}),
        ...(agent ? { permissionPreset: agent.tools.permissionPreset } : {}),
        skipPermissionConfirm: true,
      });

      if (!sessionId) {
        const errText =
          this.host.locale() === 'zh'
            ? '无法创建任务会话，请检查底层代理是否已安装并就绪'
            : 'Failed to start task session; check if the harness backend is installed and ready';
        this.taskBoard = updateKanbanTaskStatus(this.taskBoard, target.id, 'todo', this.now(), { error: errText });
        this.taskBoard = setKanbanAutoRun(this.taskBoard, false);
        await this.saveTaskBoard();
        this.host.post({ type: 'toast', payload: { level: 'error', text: errText } });
        this.pushNow();
        return;
      }

      if (agent) {
        this.recordAgentOnSession(target.backendId, sessionId, target.projectPath, target.title, agent.name);
      }
      this.taskBoard = updateKanbanTaskStatus(this.taskBoard, target.id, 'in_progress', this.now(), { sessionId });
      this.activeTaskTracker = { taskId: target.id, sessionId, sawRunning: false };
      await this.saveTaskBoard();
      this.pushNow();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.taskBoard = updateKanbanTaskStatus(this.taskBoard, target.id, 'todo', this.now(), { error: msg });
      this.taskBoard = setKanbanAutoRun(this.taskBoard, false);
      await this.saveTaskBoard();
      this.pushNow();
    } finally {
      this.taskDispatching = false;
    }
  }

  private async settleRunningTask(taskId: string, sessionId: string, aborted: boolean): Promise<void> {
    const ctx = this.host.activeContext();
    const summary = ctx?.latestAssistantText(sessionId)?.slice(0, 500);
    if (aborted) {
      const abortedNote = this.host.locale() === 'zh' ? '执行已中止，顺序队列已暂停' : 'Execution stopped; sequential queue paused';
      this.taskBoard = updateKanbanTaskStatus(this.taskBoard, taskId, 'todo', this.now(), {
        sessionId,
        error: abortedNote,
      });
      this.taskBoard = setKanbanAutoRun(this.taskBoard, false);
      await this.saveTaskBoard();
      this.pushNow();
      return;
    }

    this.taskBoard = updateKanbanTaskStatus(this.taskBoard, taskId, 'review', this.now(), {
      sessionId,
      ...(summary ? { summary } : {}),
      unread: true,
    });
    await this.saveTaskBoard();
    this.pushNow();

    if (this.taskBoard.autoRun) {
      await this.pumpTaskQueue();
    }
  }

  private async markUnreadRead(payload: { readonly id?: string; readonly all?: boolean }): Promise<void> {
    if (payload.all || !payload.id) {
      const rules = markScheduleRunAsRead(this.scheduleData.rules);
      await this.saveScheduleData({ ...this.scheduleData, rules });
      this.taskBoard = markKanbanTaskRead(this.taskBoard);
      await this.saveTaskBoard();
      for (const [k, v] of this.registry) {
        if (v.unread) {
          const { unread: _u, unreadSummary: _s, ...rest } = v;
          this.registry.set(k, rest);
        }
      }
      this.persistRegistry();
      this.pushNow();
      return;
    }

    const id = payload.id;
    if (id.startsWith('sched-run:')) {
      const [, ruleId, runId] = id.split(':');
      const rules = markScheduleRunAsRead(this.scheduleData.rules, ruleId, runId);
      await this.saveScheduleData({ ...this.scheduleData, rules });
    } else if (id.startsWith('task:')) {
      const taskId = id.slice('task:'.length);
      this.taskBoard = markKanbanTaskRead(this.taskBoard, taskId);
      await this.saveTaskBoard();
    } else if (id.startsWith('session:')) {
      const restKey = id.slice('session:'.length);
      const entry = this.registry.get(restKey);
      if (entry?.unread) {
        const { unread: _u, unreadSummary: _s, ...rest } = entry;
        this.registry.set(restKey, rest);
        this.persistRegistry();
      }
    }
    this.pushNow();
  }

  private async clearSessionUnread(sessionId: string, backendId?: string): Promise<void> {
    let changed = false;
    for (const [key, entry] of this.registry) {
      if (entry.id === sessionId && (!backendId || entry.backendId === backendId) && entry.unread) {
        const { unread: _u, unreadSummary: _s, ...rest } = entry;
        this.registry.set(key, rest);
        changed = true;
      }
    }
    if (changed) this.persistRegistry();
  }

  private recordAgentOnSession(backendId: string, sessionId: string, projectPath: string, title: string, agentName: string): void {
    const key = `${backendId}:${sessionId}`;
    const existing = this.registry.get(key);
    this.registry.set(key, {
      id: sessionId,
      title: existing?.title || title,
      projectPath,
      backendId,
      updatedAt: this.now(),
      ...(existing?.unread ? { unread: true } : {}),
      ...(existing?.unreadSummary ? { unreadSummary: existing.unreadSummary } : {}),
      agentName,
    });
    this.persistRegistry();
  }

  private syncRegistryFromContext(ctx: ActiveControllerContext): void {
    let dirty = false;
    const upsert = (id: string, title: string, projectPath: string, backendId: string, updatedAt: number) => {
      if (this.isHiddenSession(id)) return;
      const key = `${backendId}:${id}`;
      const prev = this.registry.get(key);
      if (!prev || prev.title !== title || prev.projectPath !== projectPath || Math.abs(prev.updatedAt - updatedAt) > 1_000) {
        this.registry.set(key, {
          id,
          title,
          projectPath,
          backendId,
          updatedAt,
          ...(prev?.unread ? { unread: true } : {}),
          ...(prev?.unreadSummary ? { unreadSummary: prev.unreadSummary } : {}),
          ...(prev?.agentName ? { agentName: prev.agentName } : {}),
        });
        dirty = true;
      }
    };

    for (const s of ctx.snapshot.sessions) {
      upsert(s.id, s.title, ctx.workspacePath, ctx.backendId, s.updatedAt);
    }
    for (const s of ctx.crossProjectSessions) {
      upsert(s.id, s.title, s.cwd || ctx.workspacePath, ctx.backendId, s.updatedAt);
    }

    if (this.registry.size > MAX_REGISTRY_SESSIONS) {
      const sorted = [...this.registry.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_REGISTRY_SESSIONS);
      this.registry = new Map(sorted);
      dirty = true;
    }
    if (dirty) this.persistRegistry();
  }

  private buildSessionGroups(ctx: ActiveControllerContext | undefined): ProjectSessionGroup[] {
    const currentPath = this.host.workspacePath();
    const projects = this.host.projects();
    const profiles = this.host.profiles();
    const backendNameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

    const liveMap = new Map<string, { running: boolean; needsAttention?: boolean; title?: string; updatedAt?: number }>();
    if (ctx) {
      for (const s of ctx.snapshot.sessions) {
        liveMap.set(`${ctx.backendId}:${s.id}`, {
          running: s.running,
          ...(s.needsAttention ? { needsAttention: true } : {}),
          title: s.title,
          updatedAt: s.updatedAt,
        });
      }
      for (const s of ctx.crossProjectSessions) {
        const key = `${ctx.backendId}:${s.id}`;
        if (!liveMap.has(key)) {
          liveMap.set(key, {
            running: s.running,
            ...(s.needsAttention ? { needsAttention: true } : {}),
            title: s.title,
            updatedAt: s.updatedAt,
          });
        }
      }
    }

    const grouped = new Map<string, GroupedSessionItem[]>();
    const ensureGroup = (path: string) => {
      if (!path) return;
      if (!grouped.has(path)) grouped.set(path, []);
    };

    ensureGroup(currentPath);
    for (const p of projects.recent) ensureGroup(p.path);
    for (const cfgPath of Object.keys(projects.configs)) ensureGroup(cfgPath);
    for (const t of this.taskBoard.items) ensureGroup(t.projectPath);

    for (const [key, rec] of this.registry) {
      if (this.isHiddenSession(rec.id)) continue;
      ensureGroup(rec.projectPath);
      const live = liveMap.get(key);
      grouped.get(rec.projectPath)!.push({
        id: rec.id,
        title: live?.title || rec.title,
        projectPath: rec.projectPath,
        backendId: rec.backendId,
        backendName: backendNameOf(rec.backendId),
        updatedAt: live?.updatedAt ?? rec.updatedAt,
        running: live?.running ?? false,
        ...(live?.needsAttention ? { needsAttention: true } : {}),
        ...(rec.unread ? { unread: true } : {}),
        ...(rec.agentName ? { agentName: rec.agentName } : {}),
      });
    }

    const result: ProjectSessionGroup[] = [];
    for (const [projectPath, sessions] of grouped) {
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      const knownProject = projects.recent.find((p) => p.path === projectPath);
      result.push({
        projectPath,
        projectName: knownProject?.name ?? (basename(projectPath) || projectPath),
        isCurrent: projectPath === currentPath,
        sessions,
      });
    }

    result.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      const aLatest = a.sessions[0]?.updatedAt ?? 0;
      const bLatest = b.sessions[0]?.updatedAt ?? 0;
      return bLatest - aLatest;
    });
    return result;
  }

  private buildOverview(
    ctx: ActiveControllerContext | undefined,
    sessionGroups: readonly ProjectSessionGroup[],
  ): WorkbenchOverview {
    const zh = this.host.locale() === 'zh';
    const profiles = this.host.profiles();
    const backendNameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

    // 1. 等我（waiting）：当前审批/提问/计划确认 + 其他会话里的待处理请求 + 看板「待验收」任务
    const waiting: OverviewWaitingItem[] = [];
    const seenAttentionSessions = new Set<string>();
    if (ctx) {
      const currentSessionId = ctx.snapshot.session.id;
      const projectName = basename(ctx.workspacePath) || ctx.workspacePath;
      for (const inter of ctx.snapshot.interactions) {
        if (currentSessionId) seenAttentionSessions.add(`${ctx.backendId}:${currentSessionId}`);
        if (inter.kind === 'approval') {
          waiting.push({
            id: `inter:${inter.id}`,
            kind: 'interaction',
            title: `${inter.toolName}${inter.subject ? ` · ${inter.subject}` : ''}`,
            subtitle: inter.reason,
            projectName,
            backendName: ctx.backendName,
            ...(currentSessionId ? { sessionId: currentSessionId } : {}),
            projectPath: ctx.workspacePath,
            backendId: ctx.backendId,
          });
        } else {
          const firstQ = inter.questions[0];
          const isPlan = firstQ?.intent?.kind === 'plan-review';
          waiting.push({
            id: `inter:${inter.id}`,
            kind: 'interaction',
            title: isPlan ? (zh ? '计划待审阅确认' : 'Plan ready for review') : (firstQ?.header || (zh ? '智能体提问' : 'Agent question')),
            subtitle: firstQ?.question ?? '',
            projectName,
            backendName: ctx.backendName,
            ...(currentSessionId ? { sessionId: currentSessionId } : {}),
            projectPath: ctx.workspacePath,
            backendId: ctx.backendId,
          });
        }
      }
    }

    for (const group of sessionGroups) {
      for (const s of group.sessions) {
        if (s.needsAttention && !seenAttentionSessions.has(`${s.backendId}:${s.id}`)) {
          waiting.push({
            id: `attn:${s.backendId}:${s.id}`,
            kind: 'interaction',
            title: s.title,
            subtitle: zh ? '有等待处理的审批或提问' : 'Pending approval or question',
            projectName: group.projectName,
            backendName: s.backendName,
            sessionId: s.id,
            projectPath: s.projectPath,
            backendId: s.backendId,
          });
        }
      }
    }

    for (const task of this.taskBoard.items) {
      if (task.status === 'review') {
        waiting.push({
          id: `review:${task.id}`,
          kind: 'task-review',
          title: task.title,
          subtitle: task.summary ? firstLineText(task.summary) : zh ? '任务执行完成，等待验收' : 'Task completed, awaiting review',
          projectName: task.projectName,
          backendName: backendNameOf(task.backendId),
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          projectPath: task.projectPath,
          backendId: task.backendId,
          taskId: task.id,
        });
      }
    }

    // 2. 待办（todos）：当前会话 todo_write 未完成项 + 看板「待执行」任务
    const todos: OverviewTodoItem[] = [];
    if (ctx?.snapshot.session.todos) {
      ctx.snapshot.session.todos.forEach((todo, idx) => {
        if (todo.status === 'pending' || todo.status === 'in_progress') {
          todos.push({
            id: `agent-todo:${idx}`,
            kind: 'agent-todo',
            content: todo.content,
            status: todo.status,
            contextLabel: ctx.snapshot.session.title,
            ...(ctx.snapshot.session.id ? { sessionId: ctx.snapshot.session.id } : {}),
            projectPath: ctx.workspacePath,
            backendId: ctx.backendId,
          });
        }
      });
    }
    for (const task of this.taskBoard.items) {
      if (task.status === 'todo') {
        todos.push({
          id: `kanban-todo:${task.id}`,
          kind: 'kanban-todo',
          content: task.title,
          status: 'pending',
          contextLabel: `${task.projectName} · ${backendNameOf(task.backendId)}`,
          projectPath: task.projectPath,
          backendId: task.backendId,
          taskId: task.id,
        });
      }
    }

    // 3. 在跑（running）：执行中的看板任务 + 执行中的定时规则 + 其他运行中会话
    const running: OverviewRunningItem[] = [];
    const runningTaskSessionIds = new Set<string>();
    for (const task of this.taskBoard.items) {
      if (task.status === 'in_progress') {
        if (task.sessionId) runningTaskSessionIds.add(`${task.backendId}:${task.sessionId}`);
        running.push({
          id: `run-task:${task.id}`,
          kind: 'task',
          title: task.title,
          backendName: backendNameOf(task.backendId),
          projectName: task.projectName,
          ...(task.startedAt ? { startedAt: task.startedAt } : {}),
          ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          projectPath: task.projectPath,
          backendId: task.backendId,
          taskId: task.id,
        });
      }
    }

    for (const rule of this.scheduleData.rules) {
      if (rule.lastStatus === 'running' || this.runningRuleIds.has(rule.id)) {
        const activeRun = rule.runs.find((r) => r.status === 'running');
        running.push({
          id: `run-sched:${rule.id}`,
          kind: 'schedule',
          title: rule.name,
          backendName: backendNameOf(rule.backendId),
          projectName: basename(rule.projectPath) || rule.projectPath,
          ...(activeRun?.startedAt ? { startedAt: activeRun.startedAt } : {}),
          projectPath: rule.projectPath,
          backendId: rule.backendId,
          ruleId: rule.id,
        });
      }
    }

    for (const group of sessionGroups) {
      for (const s of group.sessions) {
        if (s.running && !runningTaskSessionIds.has(`${s.backendId}:${s.id}`)) {
          running.push({
            id: `run-sess:${s.backendId}:${s.id}`,
            kind: 'session',
            title: s.title,
            backendName: s.backendName,
            projectName: group.projectName,
            ...(ctx && ctx.snapshot.session.id === s.id && ctx.snapshot.session.runningSince
              ? { startedAt: ctx.snapshot.session.runningSince }
              : {}),
            sessionId: s.id,
            projectPath: s.projectPath,
            backendId: s.backendId,
          });
        }
      }
    }

    // 4. 接下来（upcoming）：已启用的定时规则（按 nextRunAt 升序）+ 排队中的顺序看板任务
    const upcoming: OverviewUpcomingItem[] = [];
    const queuedTasks = this.taskBoard.items.filter((t) => t.status === 'todo');
    queuedTasks.forEach((task, index) => {
      upcoming.push({
        id: `up-task:${task.id}`,
        kind: 'queued-task',
        title: task.title,
        backendName: backendNameOf(task.backendId),
        projectName: task.projectName,
        queuePosition: index + 1,
        taskId: task.id,
      });
    });

    const upcomingRules = this.scheduleData.rules
      .filter((r) => r.enabled && r.nextRunAt !== undefined && !this.runningRuleIds.has(r.id))
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
    for (const rule of upcomingRules) {
      upcoming.push({
        id: `up-sched:${rule.id}`,
        kind: 'schedule',
        title: rule.name,
        backendName: backendNameOf(rule.backendId),
        projectName: basename(rule.projectPath) || rule.projectPath,
        ...(rule.nextRunAt !== undefined ? { nextRunAt: rule.nextRunAt } : {}),
        ruleId: rule.id,
      });
    }

    // 5. 未读（unread）：未读定时运行结果 + 未读待验收任务 + 未读后台完成会话（按时间倒序）
    const unread: OverviewUnreadItem[] = [];
    for (const rule of this.scheduleData.rules) {
      for (const run of rule.runs) {
        if (!run.unread) continue;
        const summaryText =
          run.status === 'failed'
            ? run.error || (zh ? '定时任务执行失败' : 'Scheduled run failed')
            : firstLineText(run.output || (zh ? '已完成执行' : 'Run completed'));
        unread.push({
          id: `sched-run:${rule.id}:${run.id}`,
          kind: 'schedule-run',
          title: rule.name,
          summary: summaryText,
          timestamp: run.endedAt ?? run.startedAt,
          projectPath: rule.projectPath,
          backendId: rule.backendId,
          ruleId: rule.id,
          runId: run.id,
        });
      }
    }

    for (const task of this.taskBoard.items) {
      if (!task.unread) continue;
      unread.push({
        id: `task:${task.id}`,
        kind: 'task-review',
        title: task.title,
        summary: firstLineText(task.summary || (zh ? '任务已完成，可前往验收' : 'Task finished and ready for review')),
        timestamp: task.completedAt ?? task.createdAt,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
        projectPath: task.projectPath,
        backendId: task.backendId,
        taskId: task.id,
      });
    }

    for (const [key, rec] of this.registry) {
      if (!rec.unread || this.isHiddenSession(rec.id)) continue;
      unread.push({
        id: `session:${key}`,
        kind: 'session',
        title: rec.title,
        summary: firstLineText(rec.unreadSummary || (zh ? '会话回复已完成' : 'Session reply finished')),
        timestamp: rec.updatedAt,
        sessionId: rec.id,
        projectPath: rec.projectPath,
        backendId: rec.backendId,
      });
    }
    unread.sort((a, b) => b.timestamp - a.timestamp);

    return { waiting, todos, running, upcoming, unread };
  }

  private loadRegistry(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Partial<StoredRegistrySession>;
      if (typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.projectPath !== 'string' || typeof r.backendId !== 'string') {
        continue;
      }
      if (this.hiddenSet.has(r.id)) continue;
      this.registry.set(`${r.backendId}:${r.id}`, {
        id: r.id,
        title: r.title,
        projectPath: r.projectPath,
        backendId: r.backendId,
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
        ...(r.unread ? { unread: true } : {}),
        ...(typeof r.unreadSummary === 'string' && r.unreadSummary ? { unreadSummary: r.unreadSummary } : {}),
        ...(typeof r.agentName === 'string' && r.agentName ? { agentName: r.agentName } : {}),
      });
    }
  }

  private persistRegistry(): void {
    void this.host.globalState.update(SESSION_REGISTRY_KEY, [...this.registry.values()]);
  }

  private async saveScheduleData(next: StoredScheduleData): Promise<void> {
    this.scheduleData = next;
    this.hiddenSet = new Set(next.hiddenSessionIds);
    await this.host.globalState.update(SCHEDULES_STORAGE_KEY, next);
  }

  private async saveTaskBoard(): Promise<void> {
    await this.host.globalState.update(TASKS_STORAGE_KEY, this.taskBoard);
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }
}

function firstLineText(markdown: string): string {
  const clean = markdown
    .split(/\r?\n/u)
    .map((l) => l.replace(/^[#*>\-\s`]+/u, '').trim())
    .find((l) => l.length > 0);
  const text = clean ?? markdown.replace(/\s+/gu, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

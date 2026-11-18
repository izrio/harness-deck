/**
 * 系统通知调度：当窗口不在前台时，在 Agent 等待确认、完成一轮、异常退出或定时/目标任务完成时发送通知，
 * 用户点击通知按钮后聚焦对话面板并跳回对应会话。
 */
import type { NotificationPreferences } from '@harness-deck/shared';

export type NotificationKind = 'attention' | 'turnComplete' | 'unexpectedExit' | 'scheduledComplete';

export interface NotificationEvent {
  readonly kind: NotificationKind;
  readonly message: string;
  readonly sessionId?: string;
  /** 去重键：同一个事件在状态刷新时不重复弹窗。 */
  readonly dedupeKey?: string;
}

export interface NotificationHost {
  readonly isWindowFocused: () => boolean;
  readonly getPreferences: () => NotificationPreferences;
  readonly showNotification: (level: 'info' | 'warning', message: string, actionLabel: string) => Promise<boolean>;
  readonly openSession: (sessionId?: string) => void | Promise<void>;
  readonly actionLabel: () => string;
}

export class NotificationDispatcher {
  private readonly seenKeys = new Set<string>();
  private readonly lastTurnState = new Map<string, boolean>();
  private readonly lastGoalPhase = new Map<string, string>();
  private lastRuntimeKey = '';

  constructor(private readonly host: NotificationHost) {}

  /** 重置状态跟踪（例如切换底层后）。 */
  reset(): void {
    this.seenKeys.clear();
    this.lastTurnState.clear();
    this.lastGoalPhase.clear();
    this.lastRuntimeKey = '';
  }

  /**
   * 观测会话状态快照变化：自动检测等待确认、一轮完成与目标任务完成。
   */
  observeSession(params: {
    readonly sessionId?: string;
    readonly title: string;
    readonly agentName: string;
    readonly running: boolean;
    readonly sync: string;
    readonly interactionIds: readonly string[];
    readonly turnAborted?: boolean;
    readonly goalPhase?: 'active' | 'paused' | 'blocked' | 'complete';
    readonly goalObjective?: string;
    readonly format: {
      readonly attention: (agent: string, title: string) => string;
      readonly turnComplete: (agent: string, title: string) => string;
      readonly scheduledComplete: (title: string) => string;
    };
  }): void {
    const key = params.sessionId ?? '__draft__';
    const wasRunning = this.lastTurnState.get(key);
    if (params.sync === 'live' || !params.running) {
      this.lastTurnState.set(key, params.running);
    }

    if (params.interactionIds.length > 0) {
      const dedupeKey = `attention:${key}:${params.interactionIds.join(',')}`;
      void this.notify({
        kind: 'attention',
        message: params.format.attention(params.agentName, params.title),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        dedupeKey,
      });
    }

    if (
      wasRunning === true &&
      params.running === false &&
      !params.turnAborted &&
      params.sync !== 'disconnected' &&
      params.sync !== 'failed'
    ) {
      void this.notify({
        kind: 'turnComplete',
        message: params.format.turnComplete(params.agentName, params.title),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    }

    if (params.goalPhase) {
      const prevPhase = this.lastGoalPhase.get(key);
      this.lastGoalPhase.set(key, params.goalPhase);
      if (prevPhase !== undefined && prevPhase !== 'complete' && params.goalPhase === 'complete') {
        void this.notify({
          kind: 'scheduledComplete',
          message: params.format.scheduledComplete(params.goalObjective || params.title),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          dedupeKey: `goal:${key}:${params.goalObjective ?? ''}`,
        });
      }
    }
  }

  /**
   * 观测运行环境状态变化：检测异常退出。
   */
  observeRuntimeExit(params: {
    readonly kind: string;
    readonly message?: string;
    readonly sessionId?: string;
    readonly text: string;
  }): void {
    if (params.kind !== 'failed' && params.kind !== 'reconnecting') {
      this.lastRuntimeKey = '';
      return;
    }
    const runtimeKey = `${params.kind}:${params.message ?? ''}`;
    if (runtimeKey === this.lastRuntimeKey) return;
    this.lastRuntimeKey = runtimeKey;
    void this.notify({
      kind: 'unexpectedExit',
      message: params.text,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      dedupeKey: `exit:${runtimeKey}`,
    });
  }

  /** 根据偏好与窗口焦点判断是否触发系统通知。 */
  async notify(event: NotificationEvent, options: { readonly ignoreFocusCheck?: boolean } = {}): Promise<boolean> {
    const prefs = this.host.getPreferences();
    if (!options.ignoreFocusCheck) {
      if (!prefs.enabled) return false;
      if (prefs.onlyWhenUnfocused && this.host.isWindowFocused()) return false;
      if (!isKindEnabled(prefs, event.kind)) return false;
    }
    if (event.dedupeKey) {
      if (this.seenKeys.has(event.dedupeKey)) return false;
      this.seenKeys.add(event.dedupeKey);
      if (this.seenKeys.size > 200) {
        const first = this.seenKeys.values().next().value;
        if (first !== undefined) this.seenKeys.delete(first);
      }
    }
    const level = event.kind === 'unexpectedExit' ? 'warning' : 'info';
    const clicked = await this.host.showNotification(level, event.message, this.host.actionLabel());
    if (clicked) {
      await this.host.openSession(event.sessionId);
    }
    return true;
  }

  /** 发送测试通知（跳过前台焦点限制，便于用户在设置页验证跳转）。 */
  async sendTest(message: string, sessionId?: string): Promise<void> {
    await this.notify(
      {
        kind: 'turnComplete',
        message,
        ...(sessionId ? { sessionId } : {}),
      },
      { ignoreFocusCheck: true },
    );
  }
}

function isKindEnabled(prefs: NotificationPreferences, kind: NotificationKind): boolean {
  switch (kind) {
    case 'attention':
      return prefs.onAttention;
    case 'turnComplete':
      return prefs.onTurnComplete;
    case 'unexpectedExit':
      return prefs.onUnexpectedExit;
    case 'scheduledComplete':
      return prefs.onScheduledComplete;
  }
}

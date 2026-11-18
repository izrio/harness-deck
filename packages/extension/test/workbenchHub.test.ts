import { describe, expect, it } from 'vitest';
import type { HostSnapshot, HostToWebview, ProjectsState } from '@harness-deck/shared';
import type { BackendProfile, ProgrammaticSessionRequest } from '../src/backend/types.ts';
import { composeAgentPrompt, deleteStoredAgent, parseStoredAgentData, resolveAgentProfiles, upsertStoredAgent } from '../src/hub/AgentStore.ts';
import { computeNextRunAt, parseStoredScheduleData, upsertScheduleRule } from '../src/hub/ScheduleEngine.ts';
import { createKanbanTask, parseTaskBoardState, reorderKanbanTask } from '../src/hub/TaskBoardStore.ts';
import type { UnattendedRunner, UnattendedRunRequest } from '../src/hub/UnattendedRunner.ts';
import { WorkbenchHub, type StateStore } from '../src/hub/WorkbenchHub.ts';

class MemoryStore implements StateStore {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

function makeBaseSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '0.2.2', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: '新对话', running: false }], active: 't1' },
    session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: { items: [{ id: 'dsh', name: 'DeepSeek', kind: 'dsh' }], active: 'dsh' },
    ...overrides,
  };
}

describe('ScheduleEngine / AgentStore / TaskBoardStore 纯函数逻辑', () => {
  it('准确计算 daily / weekly / interval / once 下一次触发时间并清理重启遗留 running 状态', () => {
    const baseNow = new Date('2026-05-04T08:30:00').getTime(); // 周一 08:30
    const dailySameDay = computeNextRunAt({ kind: 'daily', time: '09:00' }, baseNow);
    expect(dailySameDay).toBe(new Date('2026-05-04T09:00:00').getTime());

    const dailyTomorrow = computeNextRunAt({ kind: 'daily', time: '08:00' }, baseNow);
    expect(dailyTomorrow).toBe(new Date('2026-05-05T08:00:00').getTime());

    // 周三 = 3
    const weeklyWed = computeNextRunAt({ kind: 'weekly', days: [3], time: '10:00' }, baseNow);
    expect(weeklyWed).toBe(new Date('2026-05-06T10:00:00').getTime());

    const intervalNext = computeNextRunAt({ kind: 'interval', minutes: 45 }, baseNow);
    expect(intervalNext).toBe(baseNow + 45 * 60_000);

    expect(computeNextRunAt({ kind: 'once', runAt: baseNow - 1000 }, baseNow)).toBeUndefined();
    expect(computeNextRunAt({ kind: 'once', runAt: baseNow + 5000 }, baseNow)).toBe(baseNow + 5000);

    const { rules } = upsertScheduleRule(
      [],
      {
        id: 'r1',
        name: '晨报',
        prompt: '检查状态',
        frequency: { kind: 'daily', time: '09:00' },
        backendId: 'dsh',
        projectPath: '/repo/a',
      },
      baseNow,
    );
    const recovered = parseStoredScheduleData(
      {
        rules: [
          {
            ...rules[0]!,
            lastStatus: 'running',
            runs: [{ id: 'run-1', ruleId: 'r1', startedAt: baseNow - 1000, status: 'running', backendId: 'dsh', projectPath: '/repo/a' }],
          },
        ],
        hiddenSessionIds: ['hidden-s1'],
      },
      baseNow,
      '扩展重载中断',
    );
    expect(recovered.rules[0]?.lastStatus).toBe('failed');
    expect(recovered.rules[0]?.runs[0]?.status).toBe('failed');
    expect(recovered.rules[0]?.runs[0]?.error).toBe('扩展重载中断');
    expect(recovered.hiddenSessionIds).toEqual(['hidden-s1']);
  });

  it('智能体预设支持内置合并、覆盖、删除及带工具边界的提示词组装', () => {
    let stored = parseStoredAgentData(undefined);
    const initial = resolveAgentProfiles(stored, 'zh');
    expect(initial.length).toBeGreaterThanOrEqual(4);

    const added = upsertStoredAgent(
      stored,
      {
        name: '性能专家',
        specialty: 'Node 与前端渲染性能剖析',
        instructions: '先给基准数据再优化',
        backendId: 'claude',
        model: 'claude-sonnet-4-5',
        tools: {
          permissionPreset: 'read-only',
          readSearch: true,
          editWrite: false,
          bashCommand: true,
          webFetch: false,
          mcpTools: false,
        },
      },
      1000,
      'zh',
    );
    stored = added.stored;
    const prompt = composeAgentPrompt(added.agent, '分析首屏耗时');
    expect(prompt).toContain('性能专家');
    expect(prompt).toContain('Node 与前端渲染性能剖析');
    expect(prompt).toContain('Restricted capabilities');
    expect(prompt).toContain('edit/write files');
    expect(prompt).toContain('分析首屏耗时');

    stored = deleteStoredAgent(stored, 'builtin-architect', 'zh');
    const afterDelete = resolveAgentProfiles(stored, 'zh');
    expect(afterDelete.some((a) => a.id === 'builtin-architect')).toBe(false);
  });

  it('看板支持待执行队列重排与重启后 in_progress 回退 todo', () => {
    let board = parseTaskBoardState(undefined);
    board = createKanbanTask(board, { prompt: '任务一', projectPath: '/repo/a', backendId: 'dsh' }, 100).board;
    board = createKanbanTask(board, { prompt: '任务二', projectPath: '/repo/a', backendId: 'dsh' }, 200).board;
    const secondId = board.items[1]!.id;

    board = reorderKanbanTask(board, secondId, 'up');
    expect(board.items.map((i) => i.title)).toEqual(['任务二', '任务一']);

    const recovered = parseTaskBoardState({
      autoRun: true,
      items: [{ ...board.items[0]!, status: 'in_progress' }],
    });
    expect(recovered.items[0]?.status).toBe('todo');
  });
});

describe('WorkbenchHub 五大模块协同与顺序调度', () => {
  it('定时任务无人值守运行：结果写入规则历史且生成的会话绝不进入会话列表；总览五块准确聚合', async () => {
    const store = new MemoryStore();
    const posted: HostToWebview[] = [];
    const unattendedRequests: UnattendedRunRequest[] = [];
    let currentTime = 1_700_000_000_000;
    let workspacePath = '/repo/alpha';
    let activeBackend = 'dsh';
    let sessionCounter = 0;
    const assistantReplies = new Map<string, string>();
    const startedSessions: { projectPath: string; backendId: string; req: ProgrammaticSessionRequest; sessionId: string }[] = [];

    const profiles: BackendProfile[] = [
      { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
      { id: 'claude', kind: 'acp', name: 'Claude Code', command: 'claude-agent-acp', args: [], env: {} },
    ];
    const projects: ProjectsState = {
      currentPath: '/repo/alpha',
      recent: [
        { path: '/repo/alpha', name: 'alpha', lastOpenedAt: 200, isCurrent: true },
        { path: '/repo/beta', name: 'beta', lastOpenedAt: 100 },
      ],
      configs: {},
    };

    const fakeRunner = {
      run: async (req: UnattendedRunRequest) => {
        unattendedRequests.push(req);
        req.onSessionCreated('sched-hidden-session-1');
        return {
          status: 'succeeded' as const,
          sessionId: 'sched-hidden-session-1',
          output: '### 巡检结论\n一切正常，0 个警告。',
        };
      },
    } as unknown as UnattendedRunner;

    let snapshot = makeBaseSnapshot({
      sessions: [
        { id: 'visible-sess-1', title: '重构登录页', updatedAt: currentTime - 5000, running: true },
      ],
      session: {
        id: 'visible-sess-1',
        title: '重构登录页',
        running: true,
        hasOlder: false,
        loadingOlder: false,
        sync: 'live',
        todos: [
          { content: '补充单元测试', status: 'in_progress' },
          { content: '已完成设计', status: 'completed' },
        ],
      },
      interactions: [
        {
          kind: 'approval',
          id: 'app-1',
          toolName: 'bash',
          reason: '需要执行测试脚本',
          subject: 'pnpm test',
          subjectKind: 'command',
          previewable: false,
          dirtyFiles: [],
        },
      ],
    });

    const hub = new WorkbenchHub({
      globalState: store,
      runner: fakeRunner,
      locale: () => 'zh',
      isWorkspaceTrusted: () => true,
      isWebviewVisible: () => true,
      workspacePath: () => workspacePath,
      projects: () => projects,
      profiles: () => profiles,
      schedulePermission: () => 'danger-full-access',
      activeContext: () => ({
        backendId: activeBackend,
        backendName: profiles.find((p) => p.id === activeBackend)?.name ?? activeBackend,
        workspacePath,
        snapshot,
        crossProjectSessions: [
          // 即使底层返回了定时任务的隐藏会话，Hub 也必须过滤掉
          { id: 'sched-hidden-session-1', title: '后台定时会话', cwd: '/repo/alpha', updatedAt: currentTime, running: false },
          { id: 'beta-sess-1', title: 'Beta API 联调', cwd: '/repo/beta', updatedAt: currentTime - 1000, running: false },
        ],
        latestAssistantText: (sid) => assistantReplies.get(sid),
      }),
      switchProjectAndBackend: async (nextPath, nextBackend) => {
        workspacePath = nextPath;
        if (nextBackend) activeBackend = nextBackend;
      },
      startProgrammaticSession: async (req) => {
        const sessionId = `task-sess-${++sessionCounter}`;
        startedSessions.push({ projectPath: workspacePath, backendId: activeBackend, req, sessionId });
        return sessionId;
      },
      switchSessionInActive: async () => undefined,
      openNewSessionInActive: async () => undefined,
      post: (msg) => posted.push(msg),
      focusView: async () => undefined,
      openPanel: () => undefined,
      log: () => undefined,
      now: () => currentTime,
      enableTimer: false,
    });

    // 1. 新建并立即运行一条定时规则
    await hub.handleMessage({
      type: 'upsertSchedule',
      payload: {
        id: 'rule-daily',
        name: '每日代码体检',
        prompt: '检查仓库健康度',
        frequency: { kind: 'daily', time: '09:00' },
        backendId: 'dsh',
        projectPath: '/repo/alpha',
      },
    });
    await hub.executeScheduleRule('rule-daily');

    expect(unattendedRequests).toHaveLength(1);
    expect(unattendedRequests[0]?.permission).toBe('danger-full-access');
    expect(hub.isHiddenSession('sched-hidden-session-1')).toBe(true);

    const st1 = hub.state();
    // 结果保存在规则自身历史里
    expect(st1.schedules[0]?.runs).toHaveLength(1);
    expect(st1.schedules[0]?.runs[0]?.output).toContain('巡检结论');
    expect(st1.schedules[0]?.runs[0]?.unread).toBe(true);

    // 隐藏的定时会话绝不进入任何项目的会话分组列表，而跨项目的正常会话按项目归组
    const allGroupedIds = st1.sessionGroups.flatMap((g) => g.sessions.map((s) => s.id));
    expect(allGroupedIds).not.toContain('sched-hidden-session-1');
    expect(st1.sessionGroups.find((g) => g.projectName === 'alpha')?.sessions.map((s) => s.id)).toContain('visible-sess-1');
    expect(st1.sessionGroups.find((g) => g.projectName === 'beta')?.sessions.map((s) => s.id)).toContain('beta-sess-1');

    // 验证总览五大区块：等我 / 待办 / 在跑 / 接下来 / 未读
    expect(st1.overview.waiting.some((w) => w.title.includes('bash'))).toBe(true);
    expect(st1.overview.todos.some((t) => t.content === '补充单元测试')).toBe(true);
    expect(st1.overview.running.some((r) => r.sessionId === 'visible-sess-1')).toBe(true);
    expect(st1.overview.upcoming.some((u) => u.ruleId === 'rule-daily')).toBe(true);
    expect(st1.overview.unread.some((u) => u.kind === 'schedule-run')).toBe(true);

    // 2. 验证任务看板按顺序连续执行（todo -> in_progress -> review，自动拉起下一条）
    snapshot = makeBaseSnapshot({
      session: { title: '空闲', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    });

    await hub.handleMessage({
      type: 'createTask',
      payload: {
        title: '第一步：实现接口',
        prompt: '编写 REST 接口',
        projectPath: '/repo/alpha',
        backendId: 'dsh',
        model: 'deepseek-chat',
      },
    });
    await hub.handleMessage({
      type: 'createTask',
      payload: {
        title: '第二步：补齐文档',
        prompt: '更新 API 文档',
        projectPath: '/repo/beta',
        backendId: 'claude',
      },
    });

    // 等异步微任务完成第一次任务派发
    await new Promise((r) => setTimeout(r, 20));
    expect(startedSessions).toHaveLength(1);
    expect(startedSessions[0]?.projectPath).toBe('/repo/alpha');
    expect(startedSessions[0]?.backendId).toBe('dsh');
    expect(hub.state().tasks.items.map((t) => t.status)).toEqual(['in_progress', 'todo']);

    // 模拟第一个任务会话完成一轮输出
    currentTime += 5_000;
    assistantReplies.set('task-sess-1', 'REST 接口已实现并通过自测。');
    hub.observeSession({
      sessionId: 'task-sess-1',
      title: '第一步：实现接口',
      running: false,
      sync: 'live',
      interactionIds: [],
      hasTurnOutput: true,
    });

    await new Promise((r) => setTimeout(r, 30));
    // 第一个任务进入待验收（review），第二个任务自动切换到 /repo/beta + claude 开始执行！
    const tasksAfterFirst = hub.state().tasks.items;
    expect(tasksAfterFirst[0]?.status).toBe('review');
    expect(tasksAfterFirst[0]?.summary).toContain('REST 接口已实现');
    expect(tasksAfterFirst[1]?.status).toBe('in_progress');
    expect(startedSessions).toHaveLength(2);
    expect(startedSessions[1]?.projectPath).toBe('/repo/beta');
    expect(startedSessions[1]?.backendId).toBe('claude');

    hub.dispose();
  });
});

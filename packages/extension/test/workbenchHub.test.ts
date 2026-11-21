import { describe, expect, it } from 'vitest';
import type { HostSnapshot, HostToWebview, ProjectsState } from '@harness-deck/shared';
import type { BackendProfile, ProgrammaticSessionRequest } from '../src/backend/types.ts';
import { composeAgentPrompt, deleteStoredAgent, parseStoredAgentData, resolveAgentProfiles, upsertStoredAgent } from '../src/hub/AgentStore.ts';
import { computeNextRunAt, parseStoredScheduleData, upsertScheduleRule } from '../src/hub/ScheduleEngine.ts';
import { createKanbanTask, parseTaskBoardState, reorderKanbanTask } from '../src/hub/TaskBoardStore.ts';
import type { UnattendedRunner, UnattendedRunRequest } from '../src/hub/UnattendedRunner.ts';
import { WorkbenchHub, type ActiveControllerContext, type StateStore } from '../src/hub/WorkbenchHub.ts';

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

  it('多智能体并发保活时通过 liveContexts 与 backendContext 正确聚合与结算后台任务', async () => {
    const store = new MemoryStore();
    const posted: HostToWebview[] = [];
    let currentTime = 1_700_000_000_000;
    let activeBackend = 'dsh';
    let sessionSeq = 0;

    const profiles: BackendProfile[] = [
      { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
      { id: 'claude', kind: 'acp', name: 'Claude Code', command: 'claude-agent-acp', args: [], env: {} },
    ];
    const projects: ProjectsState = {
      currentPath: '/repo/alpha',
      recent: [{ path: '/repo/alpha', name: 'alpha', lastOpenedAt: 200, isCurrent: true }],
      configs: {},
    };

    let dshSnapshot = makeBaseSnapshot({
      session: { id: 'dsh-live', title: 'DSH 执行中', running: true, hasOlder: false, loadingOlder: false, sync: 'live' },
      sessions: [{ id: 'dsh-live', title: 'DSH 执行中', updatedAt: currentTime, running: true }],
    });
    let claudeSnapshot = makeBaseSnapshot({
      backends: { items: profiles.map((p) => ({ id: p.id, name: p.name, kind: p.kind })), active: 'claude' },
      session: { id: 'claude-bg', title: 'Claude 后台待审批', running: true, hasOlder: false, loadingOlder: false, sync: 'live' },
      sessions: [{ id: 'claude-bg', title: 'Claude 后台待审批', updatedAt: currentTime, running: true }],
      interactions: [
        {
          kind: 'approval',
          id: 'claude-app-1',
          toolName: 'bash',
          reason: '需要执行构建',
          subject: 'pnpm build',
          subjectKind: 'command',
          previewable: false,
          dirtyFiles: [],
        },
      ],
    });

    const contexts = (): readonly ActiveControllerContext[] => [
      {
        backendId: 'dsh',
        backendName: 'DeepSeek',
        workspacePath: '/repo/alpha',
        snapshot: dshSnapshot,
        crossProjectSessions: [],
        latestAssistantText: () => 'DSH 完成结果',
      },
      {
        backendId: 'claude',
        backendName: 'Claude Code',
        workspacePath: '/repo/alpha',
        snapshot: claudeSnapshot,
        crossProjectSessions: [],
        latestAssistantText: (id) => (id === 'task-sess-1' ? 'Claude 后台任务已交付' : undefined),
      },
    ];

    const hub = new WorkbenchHub({
      globalState: store,
      runner: {
        run: async () => ({ status: 'succeeded', sessionId: 'unused', output: '' }),
      } as unknown as UnattendedRunner,
      locale: () => 'zh',
      isWorkspaceTrusted: () => true,
      isWebviewVisible: () => true,
      workspacePath: () => '/repo/alpha',
      projects: () => projects,
      profiles: () => profiles,
      schedulePermission: () => 'workspace-write',
      activeContext: () => contexts().find((c) => c.backendId === activeBackend),
      liveContexts: contexts,
      backendContext: (id) => contexts().find((c) => c.backendId === id),
      switchProjectAndBackend: async (_path, backendId) => {
        if (backendId) activeBackend = backendId;
      },
      startProgrammaticSession: async () => `task-sess-${++sessionSeq}`,
      switchSessionInActive: async () => undefined,
      openNewSessionInActive: async () => undefined,
      post: (msg) => {
        posted.push(msg);
      },
      focusView: async () => undefined,
      openPanel: () => undefined,
      log: () => undefined,
      now: () => currentTime,
      enableTimer: false,
    });

    // 当前聚焦在 dsh，但后台 claude 也在运行且有待审批请求：总览同时聚合两个保活后端的 waiting / running
    const st0 = hub.state();
    expect(st0.overview.waiting.some((w) => w.backendId === 'claude' && w.id === 'inter:claude:claude-app-1')).toBe(true);
    expect(st0.overview.running.some((r) => r.backendId === 'dsh' && r.id === 'run-sess:dsh:dsh-live')).toBe(true);
    expect(st0.overview.running.some((r) => r.backendId === 'claude' && r.id === 'run-sess:claude:claude-bg')).toBe(true);

    // 看板派发一个使用 claude 的任务，随后切回前台聚焦 dsh
    await hub.handleMessage({
      type: 'createTask',
      payload: {
        title: '后台 Claude 任务',
        prompt: '生成测试报告',
        projectPath: '/repo/alpha',
        backendId: 'claude',
        autoStart: true,
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    activeBackend = 'dsh';
    dshSnapshot = makeBaseSnapshot({
      session: { id: 'dsh-live', title: 'DSH 闲置', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    });

    // 后台 claude 会话结束并携带 backendId='claude' 上报，即使此时 activeContext 是 dsh 也能准确结算该任务
    currentTime += 3_000;
    claudeSnapshot = makeBaseSnapshot({
      session: { id: 'task-sess-1', title: '后台 Claude 任务', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
    });
    hub.observeSession(
      {
        sessionId: 'task-sess-1',
        title: '后台 Claude 任务',
        running: false,
        sync: 'live',
        interactionIds: [],
        hasTurnOutput: true,
      },
      'claude',
    );
    await new Promise((r) => setTimeout(r, 20));

    const settledTask = hub.state().tasks.items[0];
    expect(settledTask?.status).toBe('review');
    expect(settledTask?.summary).toContain('Claude 后台任务已交付');

    hub.dispose();
  });

  it('收敛已知项目分组：过滤未知目录、归并子目录会话、防止无 cwd 会话串组、按活跃度排序并支持移除清理与同名消歧', () => {
    const store = new MemoryStore();
    const now = 1_700_000_000_000;
    let currentWorkspace = '/work/team-a/app';

    const profiles: BackendProfile[] = [
      { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
      { id: 'claude', kind: 'claude', name: 'Claude Code' },
    ];

    let projects: ProjectsState = {
      currentPath: '/work/team-a/app',
      recent: [
        { path: '/work/team-a/app/', name: 'app', lastOpenedAt: now - 10_000, isCurrent: true },
        { path: '/work/team-b/app', name: 'app', lastOpenedAt: now - 20_000 },
        { path: '/repo/beta', name: 'beta', lastOpenedAt: now - 30_000 },
        // 新添加但尚无任何会话的空项目（最近打开时间最新）
        { path: '/repo/fresh-empty', name: 'fresh-empty', lastOpenedAt: now },
      ],
      configs: {},
    };

    let snapshot = makeBaseSnapshot({
      sessions: [
        { id: 'alpha-1', title: '主仓库会话', updatedAt: now - 5_000, running: false },
        { id: 'alpha-no-cwd', title: '无 cwd 历史会话', updatedAt: now - 8_000, running: false },
      ],
    });
    let crossProjectSessions = [
      // 子目录会话应自动归并到父项目 /work/team-a/app
      { id: 'alpha-sub', title: '子目录构建', cwd: '/work/team-a/app/packages/ext', updatedAt: now - 4_000, running: false },
      // 不属于任何已知项目的野生临时目录必须被忽略
      { id: 'wild-tmp', title: '临时测试目录会话', cwd: '/tmp/random-dir', updatedAt: now, running: false },
      { id: 'beta-1', title: 'Beta 会话', cwd: '/repo/beta', updatedAt: now - 6_000, running: false },
    ];

    const hub = new WorkbenchHub({
      globalState: store,
      runner: {
        run: async () => ({ status: 'succeeded', sessionId: 'unused', output: '' }),
      } as unknown as UnattendedRunner,
      locale: () => 'zh',
      isWorkspaceTrusted: () => true,
      isWebviewVisible: () => true,
      workspacePath: () => currentWorkspace,
      projects: () => projects,
      profiles: () => profiles,
      schedulePermission: () => 'workspace-write',
      activeContext: () => ({
        backendId: 'dsh',
        backendName: 'DeepSeek',
        workspacePath: currentWorkspace,
        snapshot,
        crossProjectSessions,
        latestAssistantText: () => undefined,
      }),
      switchProjectAndBackend: async () => undefined,
      startProgrammaticSession: async () => undefined,
      switchSessionInActive: async () => undefined,
      openNewSessionInActive: async () => undefined,
      post: () => undefined,
      focusView: async () => undefined,
      openPanel: () => undefined,
      log: () => undefined,
      now: () => now,
      enableTimer: false,
    });

    const st1 = hub.state();
    // 1. 野生临时目录不建组、不入表
    expect(st1.sessionGroups.some((g) => g.projectPath === '/tmp/random-dir')).toBe(false);
    expect(st1.sessionGroups.flatMap((g) => g.sessions.map((s) => s.id))).not.toContain('wild-tmp');

    // 2. 重名项目自动附加父目录消歧，且子目录会话已归并到父项目
    const teamAGroup = st1.sessionGroups.find((g) => g.projectPath === '/work/team-a/app');
    const teamBGroup = st1.sessionGroups.find((g) => g.projectPath === '/work/team-b/app');
    expect(teamAGroup?.projectName).toBe('team-a/app');
    expect(teamBGroup?.projectName).toBe('team-b/app');
    expect(teamAGroup?.isCurrent).toBe(true);
    expect(teamAGroup?.sessions.map((s) => s.id)).toEqual(['alpha-sub', 'alpha-1', 'alpha-no-cwd']);

    // 3. 新添加的空项目按 lastOpenedAt 排在当前项目之后、旧项目之前，不会沉底
    expect(st1.sessionGroups.map((g) => g.projectPath)).toEqual([
      '/work/team-a/app',
      '/repo/fresh-empty',
      '/repo/beta',
      '/work/team-b/app',
    ]);

    // 4. 切换到 /repo/beta 后，无明确 cwd（cwd: ''）的历史会话保留在 /work/team-a/app 下，不串组到 /repo/beta
    currentWorkspace = '/repo/beta';
    snapshot = makeBaseSnapshot({
      sessions: [{ id: 'beta-1', title: 'Beta 会话', updatedAt: now - 6_000, running: false }],
    });
    crossProjectSessions = [
      { id: 'alpha-no-cwd', title: '无 cwd 历史会话', cwd: '', updatedAt: now - 8_000, running: false },
      { id: 'beta-1', title: 'Beta 会话', cwd: '/repo/beta', updatedAt: now - 6_000, running: false },
    ];
    const st2 = hub.state();
    expect(st2.sessionGroups.find((g) => g.projectPath === '/work/team-a/app')?.sessions.map((s) => s.id)).toContain('alpha-no-cwd');
    expect(st2.sessionGroups.find((g) => g.projectPath === '/repo/beta')?.sessions.map((s) => s.id)).not.toContain('alpha-no-cwd');

    // 5. 移除最近项目 /work/team-b/app 后同步清理注册表残留会话并消失分组
    projects = {
      ...projects,
      recent: projects.recent.filter((p) => p.path !== '/repo/beta' && p.path !== '/work/team-b/app'),
    };
    currentWorkspace = '/work/team-a/app';
    snapshot = makeBaseSnapshot({ sessions: [] });
    crossProjectSessions = [];
    hub.removeProjectSessions('/repo/beta');
    const st3 = hub.state();
    expect(st3.sessionGroups.some((g) => g.projectPath === '/repo/beta')).toBe(false);
    expect(st3.sessionGroups.some((g) => g.projectPath === '/work/team-b/app')).toBe(false);

    hub.dispose();
  });

  it('逐条会话记录最近使用的模型：切换会话后各自保留，并随注册表持久化', () => {
    const store = new MemoryStore();
    const now = 1_700_000_000_000;
    const workspacePath = '/repo/alpha';
    const projects: ProjectsState = {
      currentPath: workspacePath,
      recent: [{ path: workspacePath, name: 'alpha', lastOpenedAt: now, isCurrent: true }],
      configs: {},
    };
    const claudeModel = {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      group: 'Anthropic',
      efforts: [],
    };
    const deepseekModel = {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      name: 'DeepSeek R1',
      group: 'DeepSeek',
      efforts: [],
    };
    let snapshot = makeBaseSnapshot({
      sessions: [
        { id: 's1', title: '会话一', updatedAt: now - 2_000, running: false },
        { id: 's2', title: '会话二', updatedAt: now - 1_000, running: false },
      ],
      session: { id: 's1', title: '会话一', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
      models: { options: [claudeModel, deepseekModel], current: { provider: 'anthropic', model: 'claude-sonnet-4' } },
    });

    const createHub = () =>
      new WorkbenchHub({
        globalState: store,
        runner: { run: async () => ({ status: 'succeeded', sessionId: 'unused', output: '' }) } as unknown as UnattendedRunner,
        locale: () => 'zh',
        isWorkspaceTrusted: () => true,
        isWebviewVisible: () => true,
        workspacePath: () => workspacePath,
        projects: () => projects,
        profiles: () => [
          { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
          { id: 'claude', kind: 'claude', name: 'Claude Code' },
        ],
        schedulePermission: () => 'workspace-write',
        activeContext: () => ({
          backendId: 'dsh',
          backendName: 'DeepSeek',
          workspacePath,
          snapshot,
          crossProjectSessions: [],
          latestAssistantText: () => undefined,
        }),
        switchProjectAndBackend: async () => undefined,
        startProgrammaticSession: async () => undefined,
        switchSessionInActive: async () => undefined,
        openNewSessionInActive: async () => undefined,
        post: () => undefined,
        focusView: async () => undefined,
        openPanel: () => undefined,
        log: () => undefined,
        now: () => now,
        enableTimer: false,
      });

    const hub = createHub();
    const modelsOf = (state: ReturnType<WorkbenchHub['state']>) =>
      Object.fromEntries(
        state.sessionGroups.flatMap((g) => g.sessions.map((s) => [s.id, s.model])),
      );

    // 当前打开的会话记录正在使用的模型，未打开过的会话还没有模型
    const st1 = hub.state();
    expect(modelsOf(st1)).toEqual({ s1: 'Claude Sonnet 4', s2: undefined });

    // 切到会话二并改用 DeepSeek：两条会话各自保留自己的模型
    snapshot = {
      ...snapshot,
      session: { id: 's2', title: '会话二', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
      models: { ...snapshot.models, current: { provider: 'deepseek', model: 'deepseek-reasoner' } },
    };
    expect(modelsOf(hub.state())).toEqual({ s1: 'Claude Sonnet 4', s2: 'DeepSeek R1' });

    // 重启后从注册表恢复，模型不丢
    hub.dispose();
    const revived = createHub();
    expect(modelsOf(revived.state())).toEqual({ s1: 'Claude Sonnet 4', s2: 'DeepSeek R1' });
    revived.dispose();
  });
});

describe('会话删除', () => {
  it('删除后关闭其标签、从分组移除并按 backend 持久化，重启后底层扫描结果不会把它带回', async () => {
    const store = new MemoryStore();
    const now = 5_000_000;
    const profiles: BackendProfile[] = [
      { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
      { id: 'claude', kind: 'claude', name: 'Claude Code' },
    ];
    const projects: ProjectsState = {
      currentPath: '/repo/alpha',
      recent: [{ path: '/repo/alpha', name: 'alpha', lastOpenedAt: 100, isCurrent: true }],
      configs: {},
    };
    const dshSnapshot = makeBaseSnapshot({
      sessions: [{ id: 'shared-s1', title: 'DeepSeek 会话', updatedAt: now - 1000, running: false }],
      session: { id: 'shared-s1', title: 'DeepSeek 会话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    });
    const dshCtx: ActiveControllerContext = {
      backendId: 'dsh',
      backendName: 'DeepSeek',
      workspacePath: '/repo/alpha',
      snapshot: dshSnapshot,
      crossProjectSessions: [],
      latestAssistantText: () => undefined,
    };
    const claudeCtx: ActiveControllerContext = {
      backendId: 'claude',
      backendName: 'Claude Code',
      workspacePath: '/repo/alpha',
      snapshot: makeBaseSnapshot(),
      crossProjectSessions: [{ id: 'shared-s1', title: 'Claude 会话', cwd: '/repo/alpha', updatedAt: now - 2000, running: false }],
      latestAssistantText: () => undefined,
    };
    const closedTabs: string[] = [];

    const createHub = (): WorkbenchHub =>
      new WorkbenchHub({
        globalState: store,
        runner: { run: async () => ({ status: 'failed', output: '' }) } as unknown as UnattendedRunner,
        locale: () => 'zh',
        isWorkspaceTrusted: () => true,
        isWebviewVisible: () => true,
        closeSessionTabs: async (backendId, sessionId) => {
          closedTabs.push(`${backendId}:${sessionId}`);
        },
        workspacePath: () => '/repo/alpha',
        projects: () => projects,
        profiles: () => profiles,
        schedulePermission: () => 'workspace-write',
        activeContext: () => dshCtx,
        liveContexts: () => [dshCtx, claudeCtx],
        backendContext: (backendId) => (backendId === 'dsh' ? dshCtx : backendId === 'claude' ? claudeCtx : undefined),
        switchProjectAndBackend: async () => undefined,
        startProgrammaticSession: async () => undefined,
        switchSessionInActive: async () => undefined,
        openNewSessionInActive: async () => undefined,
        post: () => undefined,
        focusView: async () => undefined,
        openPanel: () => undefined,
        log: () => undefined,
        now: () => now,
        enableTimer: false,
      });

    const hub = createHub();
    const groupsOf = (state: ReturnType<WorkbenchHub['state']>) =>
      state.sessionGroups.flatMap((g) => g.sessions.map((s) => `${s.backendId}:${s.id}`));
    expect(groupsOf(hub.state())).toEqual(expect.arrayContaining(['dsh:shared-s1', 'claude:shared-s1']));

    await hub.handleMessage({ type: 'deleteProjectSession', payload: { sessionId: 'shared-s1', backendId: 'dsh' } });

    expect(closedTabs).toEqual(['dsh:shared-s1']);
    const afterDelete = groupsOf(hub.state());
    expect(afterDelete).not.toContain('dsh:shared-s1');
    // 只删除指定底层；另一个底层即便有同 id 会话也保留
    expect(afterDelete).toContain('claude:shared-s1');
    expect(store.get('harnessDeck.hub.deletedSessions')).toEqual(['dsh:shared-s1']);

    // 重启后底层仍会扫描到该会话，但删除标记让它不再出现在列表里
    hub.dispose();
    const revived = createHub();
    expect(groupsOf(revived.state())).not.toContain('dsh:shared-s1');
    expect(groupsOf(revived.state())).toContain('claude:shared-s1');
    revived.dispose();
  });
});

describe('会话列表排序', () => {
  it('按首次创建时间排序，后续活动更新不会改变会话位置', () => {
    const store = new MemoryStore();
    let snapshot = makeBaseSnapshot({
      sessions: [
        { id: 's-old', title: '旧会话', updatedAt: 1_000, running: false },
        { id: 's-new', title: '新会话', updatedAt: 2_000, running: false },
      ],
      session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    });
    const projects: ProjectsState = {
      currentPath: '/repo/alpha',
      recent: [{ path: '/repo/alpha', name: 'alpha', lastOpenedAt: 100, isCurrent: true }],
      configs: {},
    };
    const createHub = (): WorkbenchHub =>
      new WorkbenchHub({
        globalState: store,
        runner: { run: async () => ({ status: 'failed', output: '' }) } as unknown as UnattendedRunner,
        locale: () => 'zh',
        isWorkspaceTrusted: () => true,
        isWebviewVisible: () => true,
        workspacePath: () => '/repo/alpha',
        projects: () => projects,
        profiles: () => [{ id: 'dsh', kind: 'dsh', name: 'DeepSeek' }],
        schedulePermission: () => 'workspace-write',
        activeContext: () => ({
          backendId: 'dsh',
          backendName: 'DeepSeek',
          workspacePath: '/repo/alpha',
          snapshot,
          crossProjectSessions: [],
          latestAssistantText: () => undefined,
        }),
        switchProjectAndBackend: async () => undefined,
        startProgrammaticSession: async () => undefined,
        switchSessionInActive: async () => undefined,
        openNewSessionInActive: async () => undefined,
        post: () => undefined,
        focusView: async () => undefined,
        openPanel: () => undefined,
        log: () => undefined,
        now: () => 10_000,
        enableTimer: false,
      });

    const ids = (hub: WorkbenchHub) =>
      hub.state().sessionGroups.flatMap((g) => g.sessions.map((s) => s.id));

    const hub = createHub();
    // 首次登记时旧会话创建更早：新会话在上
    expect(ids(hub)).toEqual(['s-new', 's-old']);

    // 旧会话重新活动后 updatedAt 变成最新，但列表位置不变
    snapshot = {
      ...snapshot,
      sessions: [
        { id: 's-old', title: '旧会话', updatedAt: 9_000, running: true },
        { id: 's-new', title: '新会话', updatedAt: 2_000, running: false },
      ],
    };
    expect(ids(hub)).toEqual(['s-new', 's-old']);

    // 新建的会话按创建时间排到最前
    snapshot = {
      ...snapshot,
      sessions: [...(snapshot.sessions ?? []), { id: 's-newest', title: '刚创建', updatedAt: 10_000, running: false }],
    };
    expect(ids(hub)).toEqual(['s-newest', 's-new', 's-old']);

    // 重启后仍按首次创建时间排序，不因最近活动回退
    hub.dispose();
    const revived = createHub();
    expect(ids(revived)).toEqual(['s-newest', 's-new', 's-old']);
    revived.dispose();
  });
});

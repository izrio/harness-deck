// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, HostToWebview, WorkbenchState } from '@harness-deck/shared';
import { backendCapabilities } from '@harness-deck/shared';
import { App } from '../src/App.tsx';
import * as store from '../src/store.ts';

const posted: unknown[] = [];

function sampleWorkbench(): WorkbenchState {
  return {
    overview: {
      waiting: [
        {
          id: 'review:task-r1',
          kind: 'task-review',
          title: '重构支付网关模块',
          subtitle: '已完成全部测试等待验收',
          projectName: 'alpha',
          backendName: 'DeepSeek',
          projectPath: '/repo/alpha',
          backendId: 'dsh',
          taskId: 'task-r1',
        },
      ],
      todos: [
        {
          id: 'kanban-todo:task-t1',
          kind: 'kanban-todo',
          content: '补充 E2E 用例',
          status: 'pending',
          contextLabel: 'alpha · DeepSeek',
          projectPath: '/repo/alpha',
          backendId: 'dsh',
          taskId: 'task-t1',
        },
      ],
      running: [
        {
          id: 'run-sess:dsh:s1',
          kind: 'session',
          title: '性能优化分析',
          backendName: 'DeepSeek',
          projectName: 'alpha',
          sessionId: 's1',
          projectPath: '/repo/alpha',
          backendId: 'dsh',
        },
      ],
      upcoming: [
        {
          id: 'up-sched:rule-1',
          kind: 'schedule',
          title: '每日晨间代码体检',
          backendName: 'DeepSeek',
          projectName: 'alpha',
          nextRunAt: Date.now() + 3600_000,
          ruleId: 'rule-1',
        },
      ],
      unread: [
        {
          id: 'sched-run:rule-1:run-1',
          kind: 'schedule-run',
          title: '每日晨间代码体检',
          summary: '类型检查与 42 个测试全部通过',
          timestamp: Date.now() - 60_000,
          projectPath: '/repo/alpha',
          backendId: 'dsh',
          ruleId: 'rule-1',
          runId: 'run-1',
        },
      ],
    },
    schedules: [
      {
        id: 'rule-1',
        name: '每日晨间代码体检',
        prompt: '检查最近提交与测试状态',
        frequency: { kind: 'daily', time: '09:00' },
        backendId: 'dsh',
        projectPath: '/repo/alpha',
        enabled: true,
        createdAt: 1000,
        nextRunAt: Date.now() + 3600_000,
        lastStatus: 'succeeded',
        runs: [
          {
            id: 'run-1',
            ruleId: 'rule-1',
            startedAt: Date.now() - 120_000,
            endedAt: Date.now() - 60_000,
            status: 'succeeded',
            backendId: 'dsh',
            projectPath: '/repo/alpha',
            output: '### 体检报告\n\n类型检查与 **42** 个测试全部通过。',
            unread: true,
          },
        ],
      },
    ],
    agents: [
      {
        id: 'builtin-architect',
        name: '架构规划师',
        specialty: '架构设计、模块边界梳理与分步实施计划',
        instructions: '先阅读相关模块再给出方案',
        backendId: 'dsh',
        tools: {
          permissionPreset: 'read-only',
          readSearch: true,
          editWrite: false,
          bashCommand: false,
          webFetch: true,
          mcpTools: true,
        },
        builtin: true,
        updatedAt: 0,
      },
    ],
    tasks: {
      autoRun: true,
      items: [
        {
          id: 'task-t1',
          title: '补充 E2E 用例',
          prompt: '覆盖核心下单流程的端到端测试',
          status: 'todo',
          projectPath: '/repo/alpha',
          projectName: 'alpha',
          backendId: 'dsh',
          createdAt: 1000,
        },
        {
          id: 'task-r1',
          title: '重构支付网关模块',
          prompt: '抽离统一支付渠道接口',
          status: 'review',
          projectPath: '/repo/alpha',
          projectName: 'alpha',
          backendId: 'dsh',
          sessionId: 's-pay',
          summary: '已抽离 PaymentAdapter 并通过单测',
          createdAt: 900,
          completedAt: 950,
          unread: true,
        },
      ],
    },
    sessionGroups: [
      {
        projectPath: '/repo/alpha',
        projectName: 'alpha',
        isCurrent: true,
        sessions: [
          {
            id: 's1',
            title: '性能优化分析',
            projectPath: '/repo/alpha',
            backendId: 'dsh',
            backendName: 'DeepSeek',
            updatedAt: Date.now() - 10_000,
            running: true,
            model: 'DeepSeek R1',
          },
        ],
      },
      {
        projectPath: '/repo/beta',
        projectName: 'beta',
        isCurrent: false,
        sessions: [
          {
            id: 's2',
            title: 'Beta 接口设计',
            projectPath: '/repo/beta',
            backendId: 'claude',
            backendName: 'Claude Code',
            updatedAt: Date.now() - 50_000,
            running: false,
            unread: true,
            model: 'Claude Sonnet 4.5',
          },
        ],
      },
    ],
  };
}

function workbenchSnapshot(): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '0.2.2', newerThanTested: false },
    connection: 'connected',
    sessions: [{ id: 's1', title: '性能优化分析', updatedAt: Date.now(), running: true }],
    tabs: { items: [{ key: 't1', sessionId: 's1', title: '性能优化分析', running: true }], active: 't1' },
    session: { id: 's1', title: '性能优化分析', running: true, hasOlder: false, loadingOlder: false, sync: 'live' },
    items: [],
    models: {
      options: [
        {
          provider: 'deepseek',
          model: 'deepseek-reasoner',
          name: 'DeepSeek R1',
          group: 'DeepSeek',
          efforts: [],
        },
      ],
      current: { provider: 'deepseek', model: 'deepseek-reasoner' },
    },
    interactions: [],
    permissions: { options: ['read-only', 'workspace-write', 'danger-full-access'] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    preferences: {
      language: 'auto',
      includeActiveEditor: true,
      showTurnChanges: false,
      schedulePermission: 'danger-full-access',
    },
    projects: {
      currentPath: '/repo/alpha',
      recent: [
        { path: '/repo/alpha', name: 'alpha', lastOpenedAt: 200, isCurrent: true },
        { path: '/repo/beta', name: 'beta', lastOpenedAt: 100 },
      ],
      configs: {
        '/repo/alpha': { copyFiles: [], setupCommands: [], verifyCommands: ['pnpm test'] },
      },
    },
    backends: {
      active: 'dsh',
      workspace: 'alpha',
      items: [
        { id: 'dsh', name: 'DeepSeek', kind: 'dsh', builtin: true, available: true },
        { id: 'claude', name: 'Claude Code', kind: 'acp', builtin: true, available: true },
      ],
    },
    workbench: sampleWorkbench(),
  };
}

const host = (message: HostToWebview) => act(() => store.applyHostMessage(message));

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (callback(0), 0)) as typeof requestAnimationFrame;
});

afterEach(() => {
  cleanup();
  store.resetStoreForTests();
  posted.length = 0;
});

describe('工作台六大模块（总览 / 改动 / 定时 / 智能体 / 任务 / 会话）', () => {
  it('改动模块：展示分支与文件，点击打开 Diff，推送二次确认，PR 失败保留草稿并解除忙碌', () => {
    const snapshot = workbenchSnapshot();
    const workbench = snapshot.workbench!;
    const sc = {
      available: true,
      root: '/repo/alpha',
      branch: 'feature/changes',
      remote: 'git@github.com:acme/alpha.git',
      files: [
        { path: 'src/a.ts', status: 'modified' as const, staged: false, additions: 3, deletions: 1 },
        { path: 'src/b.ts', status: 'added' as const, staged: true, additions: 10, deletions: 0 },
      ],
      additions: 13,
      deletions: 1,
      gh: { installed: true, authenticated: true },
      updatedAt: 1_000,
    };
    host({
      type: 'snapshot',
      payload: {
        ...snapshot,
        session: {
          ...snapshot.session,
          turns: [{ id: 'u1', seq: 1, status: 'completed', authoredPaths: ['src/a.ts'] }],
        },
        workbench: {
          ...workbench,
          sourceControl: sc,
        },
      },
    });
    render(createElement(App));

    fireEvent.click(screen.getByTestId('workbench-tab-changes'));
    const view = screen.getByTestId('workbench-changes');
    expect(view.textContent).toContain('feature/changes');
    expect(view.textContent).toContain('src/a.ts');
    expect(view.textContent).toContain('+3');
    expect(posted).toContainEqual({ type: 'refreshSourceControl', payload: {} });

    // 宿主返回刷新结果后解除初始 busy
    host({ type: 'workbench', payload: { ...workbench, sourceControl: { ...sc, updatedAt: 1_100 } } });

    // 点击文件发送 openSourceControlDiff（而非 openFile）
    fireEvent.click(screen.getByText('src/a.ts'));
    expect(posted).toContainEqual({ type: 'openSourceControlDiff', payload: { path: 'src/a.ts', staged: false } });

    // 勾选「仅看本会话改过的文件」过滤掉 src/b.ts
    fireEvent.click(screen.getByTestId('changes-session-filter'));
    expect(view.textContent).toContain('src/a.ts');
    expect(view.textContent).not.toContain('src/b.ts');

    // 点击推送弹出二次确认，确认后才发送 sourceControlPush
    fireEvent.click(screen.getByTestId('changes-push-btn'));
    expect(screen.getByTestId('changes-push-dialog')).toBeTruthy();
    expect(posted.some((m) => (m as { type?: string }).type === 'sourceControlPush')).toBe(false);
    fireEvent.click(screen.getByTestId('changes-push-confirm'));
    expect(posted).toContainEqual({ type: 'sourceControlPush', payload: {} });
    host({ type: 'workbench', payload: { ...workbench, sourceControl: { ...sc, updatedAt: 1_200, lastAction: { kind: 'push', ok: true, at: 1_200 } } } });

    // 创建 PR 失败时保留草稿、弹窗不关闭，且 updatedAt 更新后解除 busy
    fireEvent.click(screen.getByTestId('changes-pr-btn'));
    const titleInput = screen.getByLabelText('标题') as HTMLInputElement;
    const bodyInput = screen.getByLabelText('说明（可选）') as HTMLTextAreaElement;
    fireEvent.change(titleInput, { target: { value: 'Fix PR' } });
    fireEvent.change(bodyInput, { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByTestId('changes-pr-confirm'));
    expect(posted).toContainEqual({ type: 'sourceControlCreatePr', payload: { title: 'Fix PR', body: 'Keep my draft' } });
    host({
      type: 'workbench',
      payload: {
        ...workbench,
        sourceControl: { ...sc, updatedAt: 1_300, lastAction: { kind: 'pr', ok: false, at: 1_300, message: 'gh not logged in' } },
      },
    });
    expect(screen.getByTestId('changes-pr-dialog')).toBeTruthy();
    expect((screen.getByLabelText('说明（可选）') as HTMLTextAreaElement).value).toBe('Keep my draft');
    expect((screen.getByTestId('changes-pr-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('会话模块：最后一轮结束时提供文件恢复入口', () => {
    const base = workbenchSnapshot();
    const snapshot: HostSnapshot = {
      ...base,
      items: [
        { kind: 'user', id: 'u1', text: '改一下' },
        { kind: 'assistant', id: 'a1', markdown: '改好了', streaming: false },
        { kind: 'turnDone', id: 't1', durationMs: 100, completed: true },
      ],
      session: {
        ...base.session,
        running: false,
        turns: [{ id: 'u1', seq: 1, status: 'completed', durationMs: 100, authoredPaths: ['src/a.ts'] }],
      },
      backends: {
        ...base.backends,
        items: base.backends.items.map((item) =>
          item.id === 'dsh' ? { ...item, capabilities: backendCapabilities({ id: 'dsh', kind: 'dsh' }) } : item,
        ),
      },
    };
    render(createElement(App));
    host({ type: 'snapshot', payload: snapshot });

    fireEvent.click(screen.getByText('恢复本轮文件'));
    expect(posted).toContainEqual({ type: 'rollbackLastTurn', payload: {} });
  });

  it('会话模块：worktree 按钮请求串行化的 worktree 会话', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });

    fireEvent.click(screen.getByTestId('new-worktree-session'));
    expect(posted).toContainEqual({ type: 'newWorktreeSession', payload: {} });
  });

  it('总览模块：默认展示等我、待办、在跑、接下来、未读五大区块，支持标为已读并保留会话草稿', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });

    expect(screen.getByTestId('workbench-overview')).toBeTruthy();
    expect(screen.getByTestId('overview-block-waiting').textContent).toContain('重构支付网关模块');
    expect(screen.getByTestId('overview-block-todos').textContent).toContain('补充 E2E 用例');
    expect(screen.getByTestId('overview-block-running').textContent).toContain('性能优化分析');
    expect(screen.getByTestId('overview-block-upcoming').textContent).toContain('每日晨间代码体检');
    expect(screen.getByTestId('overview-block-unread').textContent).toContain('类型检查与 42 个测试全部通过');

    fireEvent.click(screen.getByTestId('overview-mark-all-read'));
    expect(posted).toContainEqual({ type: 'markUnreadRead', payload: { all: true } });

    // 切到会话模块写草稿，再切回总览，再回会话，草稿始终保留
    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));
    const textarea = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '跨模块保留的草稿', selectionStart: 8 } });

    fireEvent.click(screen.getByTestId('workbench-tab-overview'));
    expect(screen.getByTestId('workbench-overview')).toBeTruthy();

    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('跨模块保留的草稿');
  });

  it('定时模块：包含「我的」和「模板」两大块，查看规则内嵌历史结果，支持新建规则与跳设置修改默认放行权限', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-schedules'));

    expect(screen.getByTestId('workbench-schedules')).toBeTruthy();
    // 展开历史查看结果
    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-1'));
    expect(screen.getByTestId('schedule-history-rule-1').textContent).toContain('体检报告');

    // 切换到「模板」并选用模板填充表单创建
    fireEvent.click(screen.getByTestId('schedules-subtab-templates'));
    expect(screen.getByTestId('schedules-list-templates')).toBeTruthy();
    fireEvent.click(screen.getByTestId('use-template-weekly-deps'));

    expect(screen.getByTestId('schedule-form')).toBeTruthy();
    fireEvent.change(screen.getByTestId('schedule-select-harness'), { target: { value: 'claude' } });
    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'upsertSchedule',
        payload: expect.objectContaining({
          name: '每周依赖与安全审计',
          backendId: 'claude',
          projectPath: '/repo/alpha',
        }),
      }),
    );

    // 点击「在设置中修改」跳转到设置页 Agent 分页修改定时任务默认权限
    fireEvent.click(screen.getByTestId('schedule-open-settings'));
    expect(screen.getByTestId('pref-schedule-permission')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pref-schedule-permission'), { target: { value: 'workspace-write' } });
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { schedulePermission: 'workspace-write' } });
  });

  it('智能体模块：保存专长、指令、模型与工具配置，支持直接开始会话或接受委派', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-agents'));

    expect(screen.getByTestId('workbench-agents')).toBeTruthy();
    fireEvent.click(screen.getByTestId('agent-start-builtin-architect'));
    expect(posted).toContainEqual({
      type: 'startAgentSession',
      payload: { agentId: 'builtin-architect', projectPath: '/repo/alpha' },
    });

    // 委派任务
    fireEvent.click(screen.getByTestId('agent-delegate-toggle-builtin-architect'));
    fireEvent.change(screen.getByTestId('agent-delegate-input-builtin-architect'), {
      target: { value: '梳理工作台模块依赖图' },
    });
    fireEvent.click(screen.getByTestId('agent-delegate-submit-builtin-architect'));
    expect(posted).toContainEqual({
      type: 'delegateToAgent',
      payload: {
        agentId: 'builtin-architect',
        prompt: '梳理工作台模块依赖图',
        projectPath: '/repo/alpha',
        runImmediately: true,
      },
    });

    // 新建与编辑智能体使用 Modal 弹窗（支持 Escape / 遮罩关闭）
    fireEvent.click(screen.getByTestId('agent-new-btn'));
    const newAgentModal = screen.getByTestId('agent-form');
    expect(newAgentModal.getAttribute('role')).toBe('dialog');
    expect(newAgentModal.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-form')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-new-btn'));
    fireEvent.change(screen.getByTestId('agent-input-name'), { target: { value: '安全审计员' } });
    fireEvent.change(screen.getByTestId('agent-input-specialty'), { target: { value: 'CSP 与依赖安全审计' } });
    fireEvent.change(screen.getByTestId('agent-input-instructions'), { target: { value: '逐项核查权限边界' } });
    fireEvent.change(screen.getByTestId('agent-select-backend'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByTestId('agent-select-model'), { target: { value: 'deepseek::deepseek-reasoner' } });
    fireEvent.click(screen.getByTestId('agent-submit-btn'));
    expect(screen.queryByTestId('agent-form')).toBeNull();

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'upsertAgent',
        payload: expect.objectContaining({
          name: '安全审计员',
          specialty: 'CSP 与依赖安全审计',
          instructions: '逐项核查权限边界',
          backendId: 'claude',
          provider: 'deepseek',
          model: 'deepseek-reasoner',
        }),
      }),
    );

    fireEvent.click(screen.getByTestId('agent-edit-builtin-architect'));
    const editAgentModal = screen.getByTestId('agent-form');
    expect(editAgentModal.getAttribute('aria-modal')).toBe('true');
    expect((screen.getByTestId('agent-input-name') as HTMLInputElement).value).toBe('架构规划师');
    fireEvent.click(editAgentModal.querySelector('[data-slot="dialog-close"]') as HTMLElement);
    expect(screen.queryByTestId('agent-form')).toBeNull();
  });

  it('任务模块：四列看板（待执行/执行中/待验收/已完成），支持弹窗新增任务（标题在第一项）、按顺序执行与验收通过', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-tasks'));

    expect(screen.getByTestId('kanban-col-todo')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-in_progress')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-review')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-done')).toBeTruthy();

    // 默认不内联渲染创建表单，点击「新增任务」打开 Modal 弹窗（支持 Escape 关闭）
    expect(screen.queryByTestId('kanban-task-creator')).toBeNull();
    fireEvent.click(screen.getByTestId('task-new-btn'));
    const taskModal = screen.getByTestId('kanban-task-creator');
    expect(taskModal.getAttribute('role')).toBe('dialog');
    expect(taskModal.getAttribute('aria-modal')).toBe('true');

    // 验证标题输入框位于任务内容输入之前（表单第一个）
    const titleInput = screen.getByTestId('task-input-title');
    const promptTextarea = screen.getByTestId('task-input-prompt');
    expect(titleInput.compareDocumentPosition(promptTextarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('kanban-task-creator')).toBeNull();

    // 点击「待执行」列头 + 按钮也可打开新增任务弹窗，填写标题、内容、项目、Harness 与模型后创建并关闭弹窗
    fireEvent.click(screen.getByTestId('kanban-todo-add-btn'));
    fireEvent.change(screen.getByTestId('task-input-title'), { target: { value: '搜索优化' } });
    fireEvent.change(screen.getByTestId('task-input-prompt'), { target: { value: '实现跨项目会话搜索优化' } });
    fireEvent.change(screen.getByTestId('task-select-project'), { target: { value: '/repo/beta' } });
    fireEvent.change(screen.getByTestId('task-select-harness'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByTestId('task-select-model'), { target: { value: 'deepseek::deepseek-reasoner' } });
    fireEvent.click(screen.getByTestId('task-create-btn'));
    expect(screen.queryByTestId('kanban-task-creator')).toBeNull();

    expect(posted).toContainEqual({
      type: 'createTask',
      payload: {
        title: '搜索优化',
        prompt: '实现跨项目会话搜索优化',
        projectPath: '/repo/beta',
        backendId: 'claude',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
      },
    });

    // 切换按顺序执行开关
    fireEvent.click(screen.getByTestId('tasks-auto-run-switch'));
    expect(posted).toContainEqual({ type: 'setTaskQueueAutoRun', payload: { autoRun: false } });

    // 待验收任务点击「验收通过」
    fireEvent.click(screen.getByTestId('task-approve-task-r1'));
    expect(posted).toContainEqual({ type: 'updateTaskStatus', payload: { id: 'task-r1', status: 'done' } });
  });

  it('会话模块：按项目分组展示会话列表，支持按项目新建分组会话与切换跨项目会话', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));

    expect(screen.getByTestId('project-sessions-sidebar')).toBeTruthy();
    expect(screen.getByTestId('project-group-alpha')).toBeTruthy();
    expect(screen.getByTestId('project-group-beta')).toBeTruthy();

    // 在 beta 项目分组下直接新建分组会话
    fireEvent.click(screen.getByTestId('project-new-session-beta'));
    expect(posted).toContainEqual({
      type: 'startProjectSession',
      payload: { projectPath: '/repo/beta', backendId: 'dsh' },
    });

    // 点击打开 beta 分组里的会话
    fireEvent.click(screen.getByTestId('grouped-session-s2'));
    expect(posted).toContainEqual({
      type: 'openProjectSession',
      payload: { projectPath: '/repo/beta', sessionId: 's2', backendId: 'claude' },
    });

    // 双行条目展示底层标识与相对时间
    const s2Button = screen.getByTestId('grouped-session-s2');
    expect(s2Button.textContent).toContain('Beta 接口设计');
    expect(s2Button.textContent).toContain('Claude Code');

    // 每条会话在底层图标后展示各自使用的模型
    const s1Button = screen.getByTestId('grouped-session-s1');
    expect(s1Button.textContent).toContain('DeepSeek R1');
    expect(s2Button.textContent).toContain('Claude Sonnet 4.5');

    // 搜索框过滤并支持一键清除
    const sidebar = screen.getByTestId('project-sessions-sidebar');
    const searchInput = sidebar.querySelector('input[aria-label="搜索会话"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    fireEvent.change(searchInput, { target: { value: 'Claude' } });
    expect(screen.queryByTestId('grouped-session-s1')).toBeNull();
    expect(screen.getByTestId('grouped-session-s2')).toBeTruthy();
    fireEvent.click(sidebar.querySelector('button[aria-label="关闭"]') as HTMLElement);
    expect(screen.getByTestId('grouped-session-s1')).toBeTruthy();

    // 删除会话：先弹出确认，确认后通知宿主移除（不立即删除）
    fireEvent.click(screen.getByTestId('delete-session-s2'));
    expect(screen.getByTestId('delete-session-dialog')).toBeTruthy();
    expect(posted.some((m) => (m as { type?: string }).type === 'deleteProjectSession')).toBe(false);
    fireEvent.click(screen.getByTestId('delete-session-confirm'));
    expect(posted).toContainEqual({
      type: 'deleteProjectSession',
      payload: { sessionId: 's2', backendId: 'claude' },
    });
    expect(screen.queryByTestId('delete-session-dialog')).toBeNull();

    // 折叠与展开项目分组
    const alphaToggle = screen.getByTestId('project-group-alpha').querySelector('button') as HTMLElement;
    fireEvent.click(alphaToggle);
    expect(screen.queryByTestId('grouped-session-s1')).toBeNull();
    fireEvent.click(alphaToggle);
    expect(screen.getByTestId('grouped-session-s1')).toBeTruthy();

    // 收起与重新展开侧边栏
    fireEvent.click(screen.getByTestId('toggle-project-groups'));
    expect(screen.queryByTestId('project-sessions-sidebar')).toBeNull();
    fireEvent.click(screen.getByTestId('toggle-project-groups'));
    expect(screen.getByTestId('project-sessions-sidebar')).toBeTruthy();
  });

  it('顶栏移除左侧会话下拉选择，在设置按钮左侧展示历史按钮并跳转独立会话列表页', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));

    // 1. 顶部左侧不再出现会话选择下拉按钮
    expect(document.querySelector('.header__title')).toBeNull();
    expect(document.querySelector('.sessions-menu')).toBeNull();

    // 2. 历史按钮位于设置按钮紧邻左侧
    const actions = screen.getByTestId('header-actions');
    const buttons: HTMLElement[] = [...actions.querySelectorAll('button')];
    const historyBtn = screen.getByTestId('history-button');
    const settingsBtn = screen.getByTestId('settings-button');
    expect(buttons.indexOf(historyBtn)).toBe(buttons.indexOf(settingsBtn) - 1);

    // 3. 在会话输入草稿后点击历史按钮，跳转独立会话列表页，且保留输入框草稿
    const textarea = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '历史页返回后仍在的草稿', selectionStart: 11 } });

    fireEvent.click(historyBtn);
    expect(screen.getByTestId('session-history-page')).toBeTruthy();
    expect(historyBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('history-grouped-list')).toBeTruthy();
    expect(screen.getByTestId('history-session-s1')).toBeTruthy();
    expect(screen.getByTestId('history-session-s2')).toBeTruthy();

    // 4. 搜索过滤会话
    const search = screen.getByTestId('history-search') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Beta' } });
    expect(screen.queryByTestId('history-session-s1')).toBeNull();
    expect(screen.getByTestId('history-session-s2')).toBeTruthy();

    // 5. 返回按钮关闭会话列表页并保留草稿
    fireEvent.click(screen.getByTestId('history-back'));
    expect(screen.queryByTestId('session-history-page')).toBeNull();
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('历史页返回后仍在的草稿');

    // 6. 再次进入历史页并点击会话，打开会话并自动切回对话界面
    fireEvent.click(historyBtn);
    fireEvent.click(screen.getByTestId('history-session-s2'));
    expect(screen.queryByTestId('session-history-page')).toBeNull();
    expect(posted).toContainEqual({
      type: 'openProjectSession',
      payload: { projectPath: '/repo/beta', sessionId: 's2', backendId: 'claude' },
    });

    // 7. 与设置页互斥，且支持 Escape 关闭
    fireEvent.click(historyBtn);
    expect(screen.getByTestId('session-history-page')).toBeTruthy();
    fireEvent.click(settingsBtn);
    expect(screen.queryByTestId('session-history-page')).toBeNull();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    fireEvent.click(historyBtn);
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(screen.getByTestId('session-history-page')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('session-history-page')).toBeNull();
  });

  it('无工作台分组（纯会话模式）时历史页展示扁平会话列表并发送 switchSession', () => {
    const snap = workbenchSnapshot();
    const { workbench: _w, ...standalone } = snap;
    render(createElement(App));
    host({
      type: 'snapshot',
      payload: {
        ...standalone,
        sessions: [
          { id: 's1', title: '性能优化分析', updatedAt: Date.now() - 5_000, running: false },
          { id: 's2', title: '修复测试断言', updatedAt: Date.now() - 20_000, running: false },
        ],
      },
    });

    fireEvent.click(screen.getByTestId('history-button'));
    expect(screen.getByTestId('history-flat-list')).toBeTruthy();
    fireEvent.click(screen.getByTestId('history-session-s2'));
    expect(screen.queryByTestId('session-history-page')).toBeNull();
    expect(posted).toContainEqual({ type: 'switchSession', payload: { sessionId: 's2' } });
  });
});

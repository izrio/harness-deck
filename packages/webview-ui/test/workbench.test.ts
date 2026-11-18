// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, HostToWebview, WorkbenchState } from '@harness-deck/shared';
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

describe('工作台五大模块（总览 / 定时 / 智能体 / 任务 / 会话）', () => {
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

    // 新建智能体
    fireEvent.click(screen.getByTestId('agent-new-btn'));
    fireEvent.change(screen.getByTestId('agent-input-name'), { target: { value: '安全审计员' } });
    fireEvent.change(screen.getByTestId('agent-input-specialty'), { target: { value: 'CSP 与依赖安全审计' } });
    fireEvent.change(screen.getByTestId('agent-input-instructions'), { target: { value: '逐项核查权限边界' } });
    fireEvent.change(screen.getByTestId('agent-select-backend'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByTestId('agent-select-model'), { target: { value: 'deepseek::deepseek-reasoner' } });
    fireEvent.click(screen.getByTestId('agent-submit-btn'));

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
  });

  it('任务模块：四列看板（待执行/执行中/待验收/已完成），支持选项目/Harness/模型创建任务、按顺序执行与验收通过', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-tasks'));

    expect(screen.getByTestId('kanban-col-todo')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-in_progress')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-review')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-done')).toBeTruthy();

    // 在待执行列写下一个任务，选项目、选 harness、选模型创建
    fireEvent.change(screen.getByTestId('task-input-prompt'), { target: { value: '实现跨项目会话搜索优化' } });
    fireEvent.change(screen.getByTestId('task-select-project'), { target: { value: '/repo/beta' } });
    fireEvent.change(screen.getByTestId('task-select-harness'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByTestId('task-select-model'), { target: { value: 'deepseek::deepseek-reasoner' } });
    fireEvent.click(screen.getByTestId('task-create-btn'));

    expect(posted).toContainEqual({
      type: 'createTask',
      payload: {
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
  });
});

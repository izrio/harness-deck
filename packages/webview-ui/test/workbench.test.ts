// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  Element.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  store.resetStoreForTests();
  posted.length = 0;
});

describe('工作台五大模块（总览 / 定时 / 智能体 / 任务 / 项目）与右侧文件/Git 面板', () => {
  it('右侧面板：点击展开后支持「文件」树浏览与「Git」改动提交、推送确认与 PR 保留草稿', async () => {
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

    // 左侧不再显示「改动」菜单
    expect(screen.queryByTestId('workbench-tab-changes')).toBeNull();
    // 默认收起右侧面板，点击顶栏按钮展开
    expect(screen.queryByTestId('workbench-right-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('toggle-right-panel'));
    expect(screen.getByTestId('workbench-right-panel')).toBeTruthy();

    // 默认进入「文件」标签页并请求工作区文件列表
    expect(screen.getByTestId('right-panel-files')).toBeTruthy();
    const searchMsg = posted.find((m) => (m as { type?: string }).type === 'searchFiles') as
      | { type: 'searchFiles'; payload: { requestId: number; query: string } }
      | undefined;
    expect(searchMsg).toBeTruthy();
    host({
      type: 'fileCandidates',
      payload: {
        requestId: searchMsg!.payload.requestId,
        items: [
          { path: 'src/a.ts', kind: 'file' },
          { path: 'README.md', kind: 'file' },
          { path: 'package.json', kind: 'file' },
        ],
      },
    });

    // 目录默认全部收起：顶层目录存在，但子文件尚未展开
    const srcDir = screen.getByTestId('right-panel-dir-src');
    expect(srcDir.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('right-panel-file-src/a.ts')).toBeNull();

    // 根目录文件按后缀/文件名展示对应的 VS Code 图标
    expect(screen.getByTestId('right-panel-file-README.md').querySelector('[data-file-icon-kind="markdown"]')).toBeTruthy();
    expect(screen.getByTestId('right-panel-file-package.json').querySelector('[data-file-icon-kind="npm"]')).toBeTruthy();

    // 手动展开目录后点击文件：发送内置 previewFile（不联动 VS Code openFile）
    fireEvent.click(srcDir);
    expect(srcDir.getAttribute('aria-expanded')).toBe('true');
    const tsFileBtn = screen.getByTestId('right-panel-file-src/a.ts');
    expect(tsFileBtn.querySelector('[data-file-icon-kind="typescript"]')).toBeTruthy();
    fireEvent.click(tsFileBtn);
    expect(posted).toContainEqual({ type: 'previewFile', payload: { path: 'src/a.ts' } });
    expect(posted.some((m) => (m as { type?: string }).type === 'openFile')).toBe(false);

    // 宿主返回 diffContent 后在插件内置查看器中展示，且桌面右侧面板保持可见便于连续切换文件
    host({
      type: 'diffContent',
      payload: {
        path: 'src/a.ts',
        title: 'a.ts',
        language: 'typescript',
        kind: 'file',
        after: 'export const ok = 1;\n',
        readonly: true,
      },
    });
    expect(screen.getByTestId('diff-viewer-modal')).toBeTruthy();
    expect(screen.getByTestId('workbench-right-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('diff-viewer-close'));
    expect(screen.queryByTestId('diff-viewer-modal')).toBeNull();

    // 切换到「Git」标签页展示 IDEA 风格分支、工具栏与变更列表
    fireEvent.click(screen.getByTestId('right-panel-tab-git'));
    const view = screen.getByTestId('workbench-changes');
    expect(view.textContent).toContain('feature/changes');
    expect(screen.getByTestId('changes-file-src/a.ts')).toBeTruthy();
    expect(view.textContent).toContain('a.ts');
    expect(view.textContent).toContain('+3');
    expect(posted).toContainEqual({ type: 'refreshSourceControl', payload: {} });

    // 宿主返回刷新结果后解除初始 busy
    host({ type: 'workbench', payload: { ...workbench, sourceControl: { ...sc, updatedAt: 1_100 } } });

    // 支持切换按目录分组视图
    fireEvent.click(screen.getByTestId('changes-group-toggle'));
    expect(screen.getByTestId('changes-dir-tree-changes')).toBeTruthy();
    fireEvent.click(screen.getByTestId('changes-group-toggle'));

    // 点击文件发送 openSourceControlDiff（内置查看，不联动 VS Code openFile）
    fireEvent.click(screen.getByTestId('changes-file-src/a.ts'));
    expect(posted).toContainEqual({ type: 'openSourceControlDiff', payload: { path: 'src/a.ts', staged: false } });

    // 点击图标过滤「仅看本会话改过的文件」过滤掉 src/b.ts
    fireEvent.click(screen.getByTestId('changes-session-filter'));
    expect(screen.getByTestId('changes-file-src/a.ts')).toBeTruthy();
    expect(screen.queryByTestId('changes-file-src/b.ts')).toBeNull();

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

    // 关闭弹窗并收起右侧面板
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('right-panel-close'));
    await waitFor(() => expect(screen.queryByTestId('workbench-right-panel')).toBeNull());
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

  it('已移除独立定时菜单和模块，总览点击定时或排队条目统一跳转任务模块', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });

    expect(screen.queryByTestId('workbench-tab-schedules')).toBeNull();
    expect(screen.queryByTestId('workbench-schedules')).toBeNull();

    // 总览「接下来」区块点击后进入任务模块
    const upcomingBtn = screen.getByTestId('overview-block-upcoming').querySelector('button') as HTMLElement;
    expect(upcomingBtn).toBeTruthy();
    fireEvent.click(upcomingBtn);
    expect(screen.getByTestId('workbench-tasks')).toBeTruthy();
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

  it('任务模块：扁平四列看板（待执行无+按钮、运行时仅图标），弹窗复用会话输入框并支持文件/模型/Auto与定时设置', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-tasks'));

    expect(screen.getByTestId('kanban-col-todo')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-in_progress')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-review')).toBeTruthy();
    expect(screen.getByTestId('kanban-col-done')).toBeTruthy();

    // 「待执行」列头右侧已去掉新增图标按钮
    expect(screen.queryByTestId('kanban-todo-add-btn')).toBeNull();

    // 任务卡片运行时仅用图标展示，不展示文字
    const reviewCard = screen.getByTestId('task-card-task-r1');
    const backendIcon = screen.getByTestId('task-backend-icon-task-r1');
    expect(backendIcon.getAttribute('title')).toBe('DeepSeek');
    expect(reviewCard.textContent).not.toContain('DeepSeek');

    // 默认不内联渲染创建表单，点击「新增任务」打开 Modal 弹窗（支持 Escape 关闭）
    expect(screen.queryByTestId('kanban-task-creator')).toBeNull();
    fireEvent.click(screen.getByTestId('task-new-btn'));
    const taskModal = screen.getByTestId('kanban-task-creator');
    expect(taskModal.getAttribute('role')).toBe('dialog');
    expect(taskModal.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('task-dialog-icon')).toBeTruthy();

    // 任务内容复用会话输入框（支持文件、运行时、模型、Auto，不展示用量与上下文）
    const taskComposer = screen.getByTestId('task-composer');
    expect(taskComposer.querySelector('[data-testid="usage-badge"]')).toBeNull();
    expect(taskComposer.querySelector('[data-testid="context-ring"]')).toBeNull();
    expect(screen.getByTestId('task-attach-btn')).toBeTruthy();
    const runtimePicker = screen.getByTestId('task-runtime-picker');
    const modelPicker = screen.getByTestId('task-model-picker');
    expect(runtimePicker.querySelector('[data-logo="dsh"]')).toBeTruthy();
    expect(runtimePicker.compareDocumentPosition(modelPicker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('task-permission-picker')).toBeTruthy();

    // 验证标题输入框位于任务内容输入之前（表单第一个）
    const titleInput = screen.getByTestId('task-input-title');
    const promptTextarea = screen.getByTestId('task-input-prompt');
    expect(titleInput.compareDocumentPosition(promptTextarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('kanban-task-creator')).toBeNull();

    // 重新打开弹窗：附件选文件、切换运行时并刷新模型列表、选模型与权限、开启定时时间并提交
    fireEvent.click(screen.getByTestId('task-new-btn'));
    fireEvent.change(screen.getByTestId('task-input-title'), { target: { value: '搜索优化' } });
    fireEvent.change(screen.getByTestId('task-input-prompt'), { target: { value: '实现跨项目会话搜索优化' } });
    fireEvent.change(screen.getByTestId('task-select-project'), { target: { value: '/repo/beta' } });

    // 在模型选择器前面切换运行时到 Claude Code，向宿主拉取该运行时的模型列表
    fireEvent.click(screen.getByTestId('task-runtime-picker'));
    fireEvent.click(screen.getByTestId('task-runtime-option-claude'));
    const fetchReq = posted.find((m) => (m as { type?: string }).type === 'fetchBackendModels') as
      | { type: 'fetchBackendModels'; payload: { requestId: number; backendId: string } }
      | undefined;
    expect(fetchReq?.payload.backendId).toBe('claude');
    host({
      type: 'backendModelsFetched',
      payload: {
        requestId: fetchReq!.payload.requestId,
        backendId: 'claude',
        models: {
          current: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          options: [
            {
              provider: 'anthropic',
              model: 'claude-sonnet-4-5',
              name: 'Claude Sonnet 4.5',
              group: 'Anthropic',
              efforts: [],
            },
            {
              provider: 'anthropic',
              model: 'claude-opus-4-6',
              name: 'Claude Opus 4.6',
              group: 'Anthropic',
              efforts: [],
            },
          ],
        },
      },
    });

    // 点击附件按钮请求宿主选文件，并插入返回的 @文件 引用
    fireEvent.click(screen.getByTestId('task-attach-btn'));
    expect(posted).toContainEqual({ type: 'pickTaskFiles', payload: { projectPath: '/repo/beta' } });
    host({ type: 'taskFilesPicked', payload: { paths: ['src/search.ts'] } });
    expect((screen.getByTestId('task-input-prompt') as HTMLTextAreaElement).value).toContain('@src/search.ts');

    // 在刷新后的模型列表中选择 Claude Opus 4.6，并在权限选择器中切换权限
    fireEvent.click(screen.getByTestId('task-model-picker'));
    expect(screen.queryByRole('menuitemradio', { name: 'DeepSeek R1' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude Opus 4.6' }));
    fireEvent.click(screen.getByTestId('task-permission-picker'));
    fireEvent.click(screen.getByRole('menuitem', { name: /完全访问/ }));

    // 开启定时执行并设置为每天 09:30
    fireEvent.click(screen.getByTestId('task-schedule-toggle'));
    fireEvent.change(screen.getByTestId('task-schedule-freq'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByTestId('task-schedule-time'), { target: { value: '09:30' } });

    fireEvent.click(screen.getByTestId('task-create-btn'));
    expect(screen.queryByTestId('kanban-task-creator')).toBeNull();

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'createTask',
        payload: expect.objectContaining({
          title: '搜索优化',
          prompt: expect.stringContaining('@src/search.ts'),
          projectPath: '/repo/beta',
          backendId: 'claude',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          permissionPreset: 'danger-full-access',
          schedule: { kind: 'daily', time: '09:30' },
        }),
      }),
    );

    // 切换按顺序执行开关
    fireEvent.click(screen.getByTestId('tasks-auto-run-switch'));
    expect(posted).toContainEqual({ type: 'setTaskQueueAutoRun', payload: { autoRun: false } });

    // 待验收任务点击「验收通过」
    fireEvent.click(screen.getByTestId('task-approve-task-r1'));
    expect(posted).toContainEqual({ type: 'updateTaskStatus', payload: { id: 'task-r1', status: 'done' } });
  });

  it('会话模块：项目大菜单带展开收起图标且默认首次全部收起，支持展开后按项目新建与切换跨项目会话', async () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });
    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));

    expect(screen.getByTestId('project-sessions-sidebar')).toBeTruthy();

    // 默认首次「项目」大菜单处于收起态，项目列表不展示
    const projectsToggle = screen.getByTestId('sidebar-projects-toggle');
    expect(projectsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('sidebar-projects-chevron').getAttribute('class') ?? '').not.toContain('rotate-90');
    expect(screen.queryByTestId('project-group-alpha')).toBeNull();
    expect(screen.queryByTestId('project-group-beta')).toBeNull();

    // 搜索时自动展开命中项；清除搜索后恢复原收起态
    const sidebar = screen.getByTestId('project-sessions-sidebar');
    fireEvent.click(screen.getByTestId('sidebar-search-toggle'));
    const searchInput = sidebar.querySelector('input[aria-label="搜索会话"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    fireEvent.change(searchInput, { target: { value: 'Claude' } });
    expect(screen.queryByTestId('grouped-session-s1')).toBeNull();
    expect(screen.getByTestId('grouped-session-s2')).toBeTruthy();
    fireEvent.click(sidebar.querySelector('button[aria-label="关闭"]') as HTMLElement);
    expect(screen.queryByTestId('project-group-alpha')).toBeNull();
    expect(screen.queryByTestId('grouped-session-s2')).toBeNull();

    // 点击「项目」大菜单的展开图标，展开项目文件夹列表（各项目文件夹首次默认收起，且文件夹上不再放额外箭头图标）
    fireEvent.click(projectsToggle);
    expect(projectsToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('sidebar-projects-chevron').getAttribute('class') ?? '').toContain('rotate-90');
    expect(screen.getByTestId('project-group-alpha')).toBeTruthy();
    expect(screen.getByTestId('project-group-beta')).toBeTruthy();
    expect(screen.queryByTestId('project-chevron-alpha')).toBeNull();

    const projectToggle = (name: string) =>
      screen.getByTestId(`project-group-${name}`).querySelector('button') as HTMLElement;
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(projectToggle('beta').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('grouped-session-s1')).toBeNull();
    expect(screen.queryByTestId('grouped-session-s2')).toBeNull();

    // 在 beta 项目分组下直接新建分组会话（即使收起状态也可新建）
    fireEvent.click(screen.getByTestId('project-new-session-beta'));
    expect(posted).toContainEqual({
      type: 'startProjectSession',
      payload: { projectPath: '/repo/beta', backendId: 'dsh' },
    });

    // 点击项目文件夹展开 alpha 与 beta 会话列表
    fireEvent.click(projectToggle('alpha'));
    fireEvent.click(projectToggle('beta'));
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(projectToggle('beta').getAttribute('aria-expanded')).toBe('true');

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

    // 左侧工作台导航与会话树在切换模块时持久保留，点击任务右侧 + 直接跳转任务并打开新增弹窗
    fireEvent.click(screen.getByTestId('workbench-tab-overview'));
    expect(screen.getByTestId('workbench-overview')).toBeTruthy();
    expect(screen.getByTestId('project-sessions-sidebar')).toBeTruthy();
    expect(screen.getByTestId('grouped-session-s1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('sidebar-new-task-btn'));
    expect(screen.getByTestId('workbench-tasks')).toBeTruthy();
    expect(screen.getByTestId('kanban-task-creator')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));

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

    // 再次点击收起与重新展开项目分组
    fireEvent.click(projectToggle('alpha'));
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('grouped-session-s1')).toBeNull();
    fireEvent.click(projectToggle('alpha'));
    expect(projectToggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('grouped-session-s1')).toBeTruthy();

    // 收起与重新展开侧边栏
    fireEvent.click(screen.getByTestId('toggle-project-groups'));
    await waitFor(() => expect(screen.queryByTestId('project-sessions-sidebar')).toBeNull());
    fireEvent.click(screen.getByTestId('toggle-project-groups'));
    expect(screen.getByTestId('project-sessions-sidebar')).toBeTruthy();
  });

  it('左侧栏「项目」菜单、左下角设置按钮，移除历史记录按钮/面板与会话状态点标识', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: workbenchSnapshot() });

    // 1. 左侧会话菜单已更名为「项目」，且不再包含「改动」菜单
    expect(screen.getByTestId('workbench-tab-sessions').textContent).toContain('项目');
    expect(screen.queryByTestId('workbench-tab-changes')).toBeNull();

    // 2. 移除历史记录按钮与面板，且顶部右侧不再有设置按钮
    expect(screen.queryByTestId('history-button')).toBeNull();
    expect(screen.queryByTestId('session-history-page')).toBeNull();
    const actions = screen.getByTestId('header-actions');
    expect(actions.querySelector('[data-testid="settings-button"]')).toBeNull();

    // 3. 设置按钮固定在左侧菜单面板左下角且为 ghost 按钮，点击进入设置页并保留对话草稿
    const sidebar = screen.getByTestId('project-sessions-sidebar');
    const slideWrapper = sidebar.firstElementChild as HTMLElement;
    expect(slideWrapper.className).toContain('flex');
    expect(slideWrapper.className).toContain('flex-col');
    expect(slideWrapper.className).toContain('h-full');
    const settingsBtn = sidebar.querySelector('[data-testid="settings-button"]') as HTMLElement;
    expect(settingsBtn).toBeTruthy();
    expect(settingsBtn.getAttribute('data-variant')).toBe('ghost');

    // 4. 项目会话条目不再展示右侧状态圆点（先展开「项目」大菜单再展开 beta 分组）
    fireEvent.click(screen.getByTestId('sidebar-projects-toggle'));
    fireEvent.click(screen.getByTestId('project-group-beta').querySelector('button') as HTMLElement);
    const s2Button = screen.getByTestId('grouped-session-s2');
    expect(s2Button.querySelector('.bg-orange')).toBeNull();
    expect(s2Button.querySelector('.bg-brand')).toBeNull();

    fireEvent.click(screen.getByTestId('workbench-tab-sessions'));
    const textarea = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '设置页返回后仍在的草稿', selectionStart: 11 } });

    fireEvent.click(settingsBtn);
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('设置页返回后仍在的草稿');
  });

  it('任务模块：新增任务支持配置独立 Worktree 与分支名，且卡片展示分支与清理入口', () => {
    const base = workbenchSnapshot();
    const withWorktreeTask: HostSnapshot = {
      ...base,
      workbench: {
        ...base.workbench!,
        tasks: {
          autoRun: false,
          items: [
            {
              id: 'task-wt-1',
              title: '隔离重构',
              prompt: '在 worktree 里重构认证层',
              status: 'review',
              projectPath: '/repo/alpha',
              projectName: 'alpha',
              backendId: 'dsh',
              useWorktree: true,
              worktreeBranch: 'feat/auth-refactor',
              worktreePath: '/repo/alpha-feat-auth-refactor',
              sessionId: 's-wt-1',
              createdAt: 1000,
            },
          ],
        },
      },
    };
    render(createElement(App));
    host({ type: 'snapshot', payload: withWorktreeTask });
    fireEvent.click(screen.getByTestId('workbench-tab-tasks'));

    // 已有 worktree 任务展示分支标识，并支持一键清理 worktree
    expect(screen.getByTestId('task-worktree-badge-task-wt-1').textContent).toContain('feat/auth-refactor');
    fireEvent.click(screen.getByTestId('task-worktree-cleanup-task-wt-1'));
    expect(posted).toContainEqual({
      type: 'removeWorktree',
      payload: { path: '/repo/alpha-feat-auth-refactor' },
    });

    // 新增任务弹窗支持开启 Worktree 并输入分支名
    fireEvent.click(screen.getByTestId('task-new-btn'));
    expect(screen.queryByTestId('task-worktree-branch')).toBeNull();
    fireEvent.click(screen.getByTestId('task-worktree-toggle'));
    const branchInput = screen.getByTestId('task-worktree-branch') as HTMLInputElement;
    fireEvent.change(branchInput, { target: { value: 'feat/task-wt' } });
    fireEvent.change(screen.getByTestId('task-input-prompt'), { target: { value: '在独立 worktree 中补全单测' } });
    fireEvent.click(screen.getByTestId('task-create-btn'));

    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'createTask',
        payload: expect.objectContaining({
          prompt: '在独立 worktree 中补全单测',
          useWorktree: true,
          worktreeBranch: 'feat/task-wt',
        }),
      }),
    );
  });
});

// @vitest-environment jsdom
/**
 * 输入框：发送失败时还原文字、运行中的停止和发送、Esc 停止；以及输入框上方合并后的状态栏。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, HostToWebview } from '@harness-deck/shared';

const posted: { type: string; payload: unknown }[] = [];
/** Webview 保存的状态（草稿等）；每个用例之后清掉。 */
let state: unknown;
let Composer: typeof import('../src/components/Composer.tsx').Composer;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: { type: string; payload: unknown }) => posted.push(message),
    getState: () => state,
    setState: (next: unknown) => void (state = next),
  });
  // jsdom 没有 requestAnimationFrame 的布局语义，同步执行即可
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (callback(0), 0)) as typeof requestAnimationFrame;
  store = await import('../src/store.ts');
  ({ Composer } = await import('../src/components/Composer.tsx'));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
  state = undefined;
  store.resetStoreForTests();
});

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1', newerThanTested: false },
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
    backends: { items: [], active: 'dsh' },
    ...overrides,
  };
}

const host = (message: HostToWebview) => act(() => store.applyHostMessage(message));
const input = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const running = { title: '任务', id: 's1', running: true, hasOlder: false, loadingOlder: false, sync: 'live' as const };

describe('输入框', () => {
  it('消息没发出去时把文字放回来；这期间新写的内容接在后面', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });
    fireEvent.change(input(), { target: { value: '帮我修一下这个 bug' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(posted.at(-1)).toMatchObject({ type: 'sendMessage', payload: { text: '帮我修一下这个 bug' } });
    expect(input().value).toBe('');

    host({ type: 'restoreDraft', payload: { text: '帮我修一下这个 bug' } });
    expect(input().value).toBe('帮我修一下这个 bug');

    // 还原之前用户已经开始写下一条：两段都保留
    fireEvent.change(input(), { target: { value: '另外' } });
    host({ type: 'restoreDraft', payload: { text: '第一条' } });
    expect(input().value).toBe('第一条\n另外');
  });

  it('运行中：没写内容时只有停止；写了内容时发送和停止都在', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot({ session: running }) });
    expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull();

    fireEvent.change(input(), { target: { value: '顺便把测试也补上' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    expect(posted.at(-1)).toMatchObject({ type: 'interrupt' });
    // 停止不清掉已经写的内容
    expect(input().value).toBe('顺便把测试也补上');
  });

  it('Esc 停止生成；空闲时、输入法组合输入时不发', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(posted.some((m) => m.type === 'interrupt')).toBe(false);

    host({ type: 'session', payload: running });
    fireEvent.keyDown(input(), { key: 'Escape', isComposing: true });
    expect(posted.some((m) => m.type === 'interrupt')).toBe(false);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(posted.at(-1)).toMatchObject({ type: 'interrupt' });
  });

  it('点击附件按钮直接发送 pickFiles，支持通过 Host 回传或隐藏 input 添加图片', async () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });

    fireEvent.click(screen.getByTestId('composer-attach-btn'));
    expect(screen.queryByTestId('composer-attach-menu')).toBeNull();
    expect(posted.at(-1)).toEqual({ type: 'pickFiles', payload: {} });

    // Host 通过 attachImages 传入选中的图片 -> 展示缩略图并随消息发出
    host({
      type: 'attachImages',
      payload: {
        images: [{ localId: 'picked-1', mediaType: 'image/png', data: 'aGVsbG8=', name: 'demo.png' }],
      },
    });
    expect(screen.getByTestId('composer-images')).toBeTruthy();

    // 直接通过隐藏 file input 也能添加图片
    const file = new File(['png-bytes'], 'extra.png', { type: 'image/png' });
    const fileInput = screen.getByTestId('composer-image-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('composer-images').querySelectorAll('img').length).toBeGreaterThanOrEqual(1);
  });

  it('斜杠命令补全不额外添加 / 图标，且剥除命令自带的前导 /', () => {
    render(createElement(Composer));
    host({
      type: 'snapshot',
      payload: snapshot({
        commands: [
          { name: 'explain', description: '解释代码', source: 'plugin' },
          { name: '/custom', description: '自定义命令', source: 'agent' },
        ],
      }),
    });

    const box = input();
    fireEvent.change(box, { target: { value: '/', selectionStart: 1 } });
    fireEvent.click(box);

    const completion = screen.getByTestId('completion');
    const labels = [...completion.querySelectorAll('.completion__label')].map((el) => el.textContent);
    expect(labels).toEqual(['/explain', '/custom']);
    expect(completion.querySelectorAll('.completion__icon')).toHaveLength(0);
  });

  it('权限选择器位于发送按钮左侧，下拉项以两行完整展示说明并区分图标', () => {
    render(createElement(Composer));
    host({
      type: 'snapshot',
      payload: snapshot({
        permissions: {
          options: ['default', 'acceptEdits', 'auto', 'plan'],
          current: 'default',
          labels: {
            default: { name: 'Default', description: 'Ask before edits and commands, per your permission rules.' },
            acceptEdits: { name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
            auto: { name: 'Auto', description: 'Approve edits and safe commands; ask before irreversible actions.' },
            plan: { name: 'Plan', description: 'Plan carefully before executing a task.' },
          },
        },
      }),
    });

    const toolbar = document.querySelector('.composer__toolbar') as HTMLElement;
    const spacer = toolbar.querySelector('.composer__spacer') as HTMLElement;
    const permissionBtn = screen.getByTestId('permission-picker');
    const sendBtn = screen.getByRole('button', { name: '发送' });
    expect(spacer.compareDocumentPosition(permissionBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(permissionBtn.compareDocumentPosition(sendBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(permissionBtn);
    const menu = document.querySelector('.permission-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(items).toHaveLength(4);

    const iconKinds = items.map((item) => item.querySelector('[data-permission-icon]')?.getAttribute('data-permission-icon'));
    expect(iconKinds).toEqual(['default', 'edit', 'auto', 'plan']);

    for (const item of items) {
      const hint = item.querySelector('.menu-item__hint');
      expect(hint?.className).toContain('whitespace-normal');
      expect(hint?.className).not.toContain('truncate');
    }
    expect(items[0]?.textContent).toContain('Ask before edits and commands, per your permission rules.');
  });

  it('输入文字重新测量高度期间锁定输入卡片最小高度，避免临时收缩挤压上方对话流滚动条', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });

    const box = input();
    const card = document.querySelector('.composer') as HTMLDivElement;
    expect(card).toBeTruthy();

    Object.defineProperty(card, 'offsetHeight', { configurable: true, get: () => 168 });
    const observedMinHeightsDuringAuto: string[] = [];
    Object.defineProperty(box, 'scrollHeight', {
      configurable: true,
      get: () => {
        if (box.style.height === 'auto') {
          observedMinHeightsDuringAuto.push(card.style.minHeight);
        }
        return 44;
      },
    });

    fireEvent.change(box, { target: { value: '全项目里的' } });

    expect(observedMinHeightsDuringAuto).toEqual(['168px']);
    expect(card.style.minHeight).toBe('');
    expect(box.style.height).toBe('44px');
  });
});

describe('输入框上方的状态栏', () => {
  const todos = [
    { content: '读代码', status: 'completed' as const },
    { content: '改实现', status: 'in_progress' as const },
    { content: '补测试', status: 'pending' as const },
  ];
  const changes = {
    additions: 4,
    deletions: 1,
    files: [{ path: 'src/a.ts', ref: { kind: 'session' as const, path: '/w/src/a.ts' }, additions: 4, deletions: 1 }],
  };

  it('没有内容时不出现', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot() });
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('待办、改动、未保存合在一栏；同时只展开一个列表', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot({ session: { ...running, todos, changes }, workspace: { dirtyFiles: 2 } }) });
    const dock = screen.getByTestId('dock');
    expect(dock.className).toContain('w-full');
    expect(screen.getByTestId('status-strip').textContent).toContain('改实现');
    expect(screen.getByTestId('status-strip').textContent).toContain('1/3');
    expect(screen.getByTestId('session-changes').textContent).toContain('1 个文件');
    expect(screen.getByTestId('dirty-strip').textContent).toContain('2 个未保存');
    expect(dock.querySelectorAll('.todo')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('status-strip'));
    expect(dock.querySelectorAll('.todo')).toHaveLength(3);
    const todoPanel = dock.querySelector('#dock-panel');
    expect(todoPanel?.className).toContain('absolute');
    expect(dock.querySelector('.dock__card')?.contains(todoPanel!)).toBe(false);

    fireEvent.click(dock.querySelector('.session-changes__toggle')!);
    expect(dock.querySelectorAll('.todo')).toHaveLength(0);
    expect(dock.querySelectorAll('.session-changes__file')).toHaveLength(1);
    const changesPanel = dock.querySelector('#dock-panel');
    expect(changesPanel?.className).toContain('absolute');
    expect(dock.querySelector('.dock__card')?.contains(changesPanel!)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '全部保存' }));
    expect(posted.at(-1)).toMatchObject({ type: 'saveAll' });
    expect(dock.querySelector('#dock-panel')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dock.querySelector('#dock-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('status-strip'));
    expect(dock.querySelectorAll('.todo')).toHaveLength(3);
    fireEvent.pointerDown(document.body);
    expect(dock.querySelector('#dock-panel')).toBeNull();
  });

  it('隐藏改动后不再显示，有新的改动时重新出现', () => {
    render(createElement(Composer));
    host({ type: 'snapshot', payload: snapshot({ session: { ...running, changes } }) });
    fireEvent.click(screen.getByRole('button', { name: /隐藏/u }));
    expect(screen.queryByTestId('dock')).toBeNull();
    host({ type: 'session', payload: { ...running, changes: { ...changes, additions: 9 } } });
    expect(screen.getByTestId('session-changes')).toBeTruthy();
  });

  it('输入框下方左侧提供项目与分支切换，右侧展示双圆环用量标识', () => {
    render(createElement(Composer));
    host({
      type: 'snapshot',
      payload: snapshot({
        backends: { items: [{ id: 'antigravity', name: 'Antigravity', kind: 'acp' }], active: 'antigravity' },
        projects: {
          currentPath: '/repo/harness-deck',
          recent: [
            { path: '/repo/harness-deck', name: 'harness-deck', lastOpenedAt: 2 },
            { path: '/repo/other-app', name: 'other-app', lastOpenedAt: 1 },
          ],
          configs: {},
        },
        workbench: {
          overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
          schedules: [],
          agents: [],
          tasks: { items: [], autoRun: false },
          sessionGroups: [],
          sourceControl: {
            available: true,
            root: '/repo/harness-deck',
            branch: 'main',
            branches: ['main', 'feat/composer-footer'],
            remote: 'origin',
            files: [],
            additions: 0,
            deletions: 0,
            updatedAt: Date.now(),
          },
        },
      }),
    });

    const footer = screen.getByTestId('composer-footer');
    expect(footer).toBeTruthy();

    // 1. 切换项目（就地切换 inPlace: true）
    const projectBtn = screen.getByTestId('composer-project-trigger');
    expect(projectBtn.textContent).toContain('harness-deck');
    fireEvent.click(projectBtn);
    fireEvent.click(screen.getByTestId('composer-project-item-other-app'));
    expect(posted.at(-1)).toEqual({
      type: 'openProject',
      payload: { path: '/repo/other-app', inPlace: true },
    });

    // 2. 切换分支与新建分支
    const branchBtn = screen.getByTestId('composer-branch-trigger');
    expect(branchBtn.textContent).toContain('main');
    fireEvent.click(branchBtn);
    fireEvent.click(screen.getByTestId('composer-branch-item-feat/composer-footer'));
    expect(posted.at(-1)).toEqual({
      type: 'sourceControlCheckoutBranch',
      payload: { branch: 'feat/composer-footer' },
    });

    // 模拟 checkout 完成后再新建分支
    host({
      type: 'workbench',
      payload: {
        overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
        schedules: [],
        agents: [],
        tasks: { items: [], autoRun: false },
        sessionGroups: [],
        sourceControl: {
          available: true,
          root: '/repo/harness-deck',
          branch: 'feat/composer-footer',
          branches: ['main', 'feat/composer-footer'],
          remote: 'origin',
          files: [],
          additions: 0,
          deletions: 0,
          lastAction: { kind: 'checkout', ok: true, at: Date.now() },
          updatedAt: Date.now(),
        },
      },
    });
    fireEvent.click(screen.getByTestId('composer-branch-trigger'));
    fireEvent.change(screen.getByTestId('composer-new-branch-input'), { target: { value: 'feat/new-ui' } });
    fireEvent.click(screen.getByTestId('composer-create-branch-btn'));
    expect(posted.at(-1)).toEqual({
      type: 'sourceControlCreateBranch',
      payload: { branch: 'feat/new-ui' },
    });

    // 3. 右侧双圆环用量标识位于 composer-footer 内，不在 .composer__toolbar 内
    const fetchReq = [...posted].reverse().find((m) => m.type === 'fetchQuota');
    const requestId = (fetchReq?.payload as { requestId: number } | undefined)?.requestId ?? -1;
    host({
      type: 'quotaFetched',
      payload: {
        requestId,
        quota: {
          windows: [
            { kind: 'weekly', label: 'gemini', usedPercent: 20, remainingPercent: 80 },
            { kind: 'session', label: 'gemini', usedPercent: 35, remainingPercent: 65 },
          ],
          queriedAt: Date.now(),
        },
      },
    });
    const badge = screen.getByTestId('usage-badge');
    expect(footer.contains(badge)).toBe(true);
    expect(document.querySelector('.composer__toolbar')?.contains(badge)).toBe(false);
    expect(screen.getByTestId('usage-ring-outer').getAttribute('data-percent')).toBe('80');
    expect(screen.getByTestId('usage-ring-inner').getAttribute('data-percent')).toBe('65');
  });
});

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, QuotaView } from '@harness-deck/shared';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();
let UsageBadge: typeof import('../src/components/UsageBadge.tsx').UsageBadge;
let store: typeof import('../src/store.ts');

const quota: QuotaView = {
  windows: [
    { kind: 'session', label: '', usedPercent: 42, remainingPercent: 58 },
    { kind: 'weekly', label: '', usedPercent: 76, remainingPercent: 24, resetsAt: Date.now() + 3 * 86_400_000 },
    { kind: 'weeklyModel', label: 'Fable', usedPercent: 91, remainingPercent: 9 },
  ],
  extraUsage: { usedPercent: 18, remainingPercent: 82 },
  queriedAt: Date.now(),
};

const poolQuota: QuotaView = {
  windows: [
    { kind: 'cycle', label: '', usedPercent: 63, remainingPercent: 37 },
    { kind: 'cycle', label: 'Pro', usedPercent: 20, remainingPercent: 80 },
    {
      kind: 'weekly',
      label: 'gemini',
      models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'],
      usedPercent: 4,
      remainingPercent: 96,
    },
    {
      kind: 'session',
      label: 'gemini',
      models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'],
      usedPercent: 12,
      remainingPercent: 88,
    },
    {
      kind: 'weekly',
      label: '3p',
      models: ['Claude Opus 5.5', 'GPT-OSS 120B'],
      usedPercent: 92,
      remainingPercent: 8,
    },
    { kind: 'weekly', label: 'Gemini 4 Argon', usedPercent: 0, remainingPercent: 100 },
    { kind: 'weeklyModel', label: 'Fable', usedPercent: 91, remainingPercent: 9 },
  ],
  queriedAt: Date.now(),
};

const claudeSnapshot = (): HostSnapshot =>
  makeSnapshot({ backends: { items: [{ id: 'claude', name: 'Claude Code', kind: 'claude' }], active: 'claude' } });

beforeAll(async () => {
  store = await import('../src/store.ts');
  ({ UsageBadge } = await import('../src/components/UsageBadge.tsx'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vscode.reset();
  store.resetStoreForTests();
});

function mount() {
  act(() => store.applyHostMessage({ type: 'snapshot', payload: claudeSnapshot() }));
  render(createElement(UsageBadge));
  const probe = vscode.posted.find((m) => m.type === 'fetchQuota');
  expect(probe).toBeTruthy();
  const requestId = probe && probe.type === 'fetchQuota' ? probe.payload.requestId : -1;
  return requestId;
}

describe('订阅用量标识', () => {
  it('挂载时探测一次，查不到额度时完全不渲染标识', () => {
    const requestId = mount();
    expect(vscode.posted.filter((m) => m.type === 'fetchQuota')).toHaveLength(1);
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId, error: 'unavailable' } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();
  });

  it('过期请求的结果被忽略', () => {
    const requestId = mount();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: requestId - 1, quota } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();
  });

  it('拿到额度后徽标优先展示 5 小时窗口剩余百分比，悬浮展开展示全部窗口且不展示已用', async () => {
    vi.useFakeTimers();
    const requestId = mount();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId, quota } }));

    const badge = screen.getByTestId('usage-badge');
    expect(badge.textContent).toContain('58%'); // 只取 5 小时窗口，不被每周/单模型窗口拉低
    // 双圆环：外环周用量（24%），内环 5 小时用量（58%）
    expect(screen.getByTestId('usage-dual-ring')).toBeTruthy();
    expect(screen.getByTestId('usage-ring-outer').getAttribute('data-percent')).toBe('24');
    expect(screen.getByTestId('usage-ring-inner').getAttribute('data-percent')).toBe('58');
    expect(screen.queryByTestId('usage-popover')).toBeNull();

    fireEvent.pointerEnter(badge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const body = screen.getByTestId('usage-popover');
    expect(screen.getByTestId('usage-ring-legend').textContent).toContain('外环：每周');
    expect(screen.getByTestId('usage-ring-legend').textContent).toContain('内环：5 小时');
    expect(body.textContent).toContain('5 小时');
    expect(body.textContent).toContain('每周');
    expect(body.textContent).toContain('Fable');
    expect(body.textContent).not.toContain('已用');
    expect(body.textContent).toContain('剩余 58%');
    expect(body.textContent).toContain('剩余 24%');
    expect(body.textContent).toContain('剩余 9%');
    expect(body.textContent).toContain('额外用量');
    expect(body.textContent).toContain('剩余 82%');

    const fills = screen.getAllByTestId('usage-bar-fill').map((el) => (el as HTMLElement).style.width);
    expect(fills).toEqual(['58%', '24%', '9%']);

    fireEvent.pointerLeave(badge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByTestId('usage-popover')).toBeNull();
  });

  it('计费周期与多模型额度池按分组和语言包展示', async () => {
    vi.useFakeTimers();
    const requestId = mount();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId, quota: poolQuota } }));

    // 徽标只展示 5 小时（gemini）剩余 88%，外环周用量取非 3p 池最低值 96%，内环 5 小时 88%
    expect(screen.getByTestId('usage-badge').textContent).toContain('88%');
    expect(screen.getByTestId('usage-ring-outer').getAttribute('data-percent')).toBe('96');
    expect(screen.getByTestId('usage-ring-inner').getAttribute('data-percent')).toBe('88');

    fireEvent.pointerEnter(screen.getByTestId('usage-badge'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const body = screen.getByTestId('usage-popover').textContent ?? '';
    expect(body).toContain('本计费周期');
    expect(body).toContain('本计费周期 · Pro');
    expect(body).toContain('Gemini 模型');
    expect(body).not.toContain('Gemini 4 Neon · Gemini 3.8 Flash');
    expect(body).toContain('剩余 96%');
    expect(body).toContain('剩余 88%');
    expect(body).toContain('Claude 与 GPT 模型');
    expect(body).not.toContain('Claude Opus 5.5 · GPT-OSS 120B');
    expect(body).toContain('剩余 8%');
    expect(body).toContain('Gemini 4 Argon');
    expect(body).toContain('剩余 100%');
    expect(body).toContain('每周 · Fable');
    expect(body).not.toContain('已用');
  });

  it('切换到底层后隐藏标识', () => {
    const requestId = mount();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId, quota } }));
    expect(screen.getByTestId('usage-badge')).toBeTruthy();

    act(() =>
      store.applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({ backends: { items: [{ id: 'dsh', name: 'DeepSeek', kind: 'dsh' }], active: 'dsh' } }),
      }),
    );
    expect(screen.queryByTestId('usage-badge')).toBeNull();
  });

  it('同一底层切换官方账号后立即清空旧额度并重新请求新账号额度', () => {
    act(() =>
      store.applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          backends: { items: [{ id: 'antigravity', name: 'Antigravity', kind: 'acp' }], active: 'antigravity' },
          accounts: {
            items: [
              { id: 'system:antigravity', backendId: 'antigravity', label: '本机默认账号', isSystemDefault: true, status: 'authenticated' },
              { id: 'agy-2', backendId: 'antigravity', label: 'second@gmail.com', isSystemDefault: false, status: 'authenticated' },
            ],
            channels: { antigravity: { mode: 'official', accountId: 'system:antigravity' } },
          },
        }),
      }),
    );
    render(createElement(UsageBadge));
    const firstReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const firstId = firstReq && firstReq.type === 'fetchQuota' ? firstReq.payload.requestId : -1;
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId: firstId,
          quota: { windows: [{ kind: 'session', label: 'gemini', usedPercent: 100, remainingPercent: 0 }], queriedAt: Date.now() },
        },
      }),
    );
    expect(screen.getByTestId('usage-badge').textContent).toContain('0%');

    // 切换到第二个账号
    vscode.reset();
    act(() =>
      store.applyHostMessage({
        type: 'accounts',
        payload: {
          items: [
            { id: 'system:antigravity', backendId: 'antigravity', label: '本机默认账号', isSystemDefault: true, status: 'authenticated' },
            { id: 'agy-2', backendId: 'antigravity', label: 'second@gmail.com', isSystemDefault: false, status: 'authenticated' },
          ],
          channels: { antigravity: { mode: 'official', accountId: 'agy-2' } },
        },
      }),
    );

    // 切换瞬间隐藏旧 0% 额度并发起新的 force fetchQuota
    expect(screen.queryByTestId('usage-badge')).toBeNull();
    const secondReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    expect(secondReq).toBeTruthy();
    expect(secondReq && secondReq.type === 'fetchQuota' ? secondReq.payload.force : undefined).toBe(true);
    const secondId = secondReq && secondReq.type === 'fetchQuota' ? secondReq.payload.requestId : -1;
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId: secondId,
          quota: { windows: [{ kind: 'session', label: 'gemini', usedPercent: 12, remainingPercent: 88 }], queriedAt: Date.now() },
        },
      }),
    );
    expect(screen.getByTestId('usage-badge').textContent).toContain('88%');
  });

  it('切换账号时首次探测因旧 token 过期返回 unavailable，底层重连与模型加载后自动补查并恢复展示', () => {
    act(() =>
      store.applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          connection: 'connected',
          models: { options: [{ provider: 'antigravity', model: 'gemini-4-neon', name: 'Gemini 4 Neon', group: 'Gemini', efforts: [] }] },
          backends: { items: [{ id: 'antigravity', name: 'Antigravity', kind: 'acp' }], active: 'antigravity' },
          accounts: {
            items: [
              { id: 'system:antigravity', backendId: 'antigravity', label: '本机默认账号', isSystemDefault: true, status: 'authenticated' },
              { id: 'agy-2', backendId: 'antigravity', label: 'second@gmail.com', isSystemDefault: false, status: 'authenticated' },
            ],
            channels: { antigravity: { mode: 'official', accountId: 'agy-2' } },
          },
        }),
      }),
    );
    render(createElement(UsageBadge));
    const initReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const initId = initReq && initReq.type === 'fetchQuota' ? initReq.payload.requestId : -1;
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId: initId,
          quota: { windows: [{ kind: 'session', label: 'gemini', usedPercent: 10, remainingPercent: 90 }], queriedAt: Date.now() },
        },
      }),
    );
    expect(screen.getByTestId('usage-badge').textContent).toContain('90%');

    // 切回本机默认账号，首次探测时该账号存储的 access_token 已过期，宿主返回 unavailable
    vscode.reset();
    act(() =>
      store.applyHostMessage({
        type: 'accounts',
        payload: {
          items: [
            { id: 'system:antigravity', backendId: 'antigravity', label: '本机默认账号', isSystemDefault: true, status: 'authenticated' },
            { id: 'agy-2', backendId: 'antigravity', label: 'second@gmail.com', isSystemDefault: false, status: 'authenticated' },
          ],
          channels: { antigravity: { mode: 'official', accountId: 'system:antigravity' } },
        },
      }),
    );
    const switchReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const switchId = switchReq && switchReq.type === 'fetchQuota' ? switchReq.payload.requestId : -1;
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: switchId, error: 'unavailable' } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();

    // 底层重启：先断开、清空模型列表
    vscode.reset();
    act(() => {
      store.applyHostMessage({ type: 'connection', payload: 'idle' });
      store.applyHostMessage({ type: 'models', payload: { options: [] } });
    });
    expect(vscode.posted.filter((m) => m.type === 'fetchQuota')).toHaveLength(0);

    // 底层重新连接后自动补查；若此时 CLI 还未刷新完 token（仍 unavailable），拉回模型列表后再补查一次并成功展示
    act(() => store.applyHostMessage({ type: 'connection', payload: 'connected' }));
    const reconnectReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    expect(reconnectReq).toBeTruthy();
    const reconnectId = reconnectReq && reconnectReq.type === 'fetchQuota' ? reconnectReq.payload.requestId : -1;
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: reconnectId, error: 'unavailable' } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();

    vscode.reset();
    act(() =>
      store.applyHostMessage({
        type: 'models',
        payload: {
          options: [{ provider: 'antigravity', model: 'gemini-4-neon', name: 'Gemini 4 Neon', group: 'Gemini', efforts: [] }],
        },
      }),
    );
    const modelsReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    expect(modelsReq).toBeTruthy();
    const modelsId = modelsReq && modelsReq.type === 'fetchQuota' ? modelsReq.payload.requestId : -1;
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId: modelsId,
          quota: { windows: [{ kind: 'session', label: 'gemini', usedPercent: 25, remainingPercent: 75 }], queriedAt: Date.now() },
        },
      }),
    );
    expect(screen.getByTestId('usage-badge').textContent).toContain('75%');
  });

  it('组件卸载重挂（如从设置页切完账号返回对话）时请求号持续递增，不会被 store 中的旧结果撞车吞掉', () => {
    act(() => store.applyHostMessage({ type: 'snapshot', payload: claudeSnapshot() }));
    const firstRender = render(createElement(UsageBadge));
    const firstReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const firstId = firstReq && firstReq.type === 'fetchQuota' ? firstReq.payload.requestId : -1;
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: firstId, error: 'unavailable' } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();

    // 模拟切换到设置页卸载 UsageBadge，再返回对话重新挂载
    firstRender.unmount();
    vscode.reset();
    render(createElement(UsageBadge));
    const secondReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const secondId = secondReq && secondReq.type === 'fetchQuota' ? secondReq.payload.requestId : -1;
    expect(secondId).toBeGreaterThan(firstId);

    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: secondId, quota } }));
    expect(screen.getByTestId('usage-badge').textContent).toContain('58%');
  });

  it('同批次乱序到达的旧 requestId 回包不会覆盖新请求的额度结果', () => {
    const firstId = mount();
    vscode.reset();
    // 切换账号触发 secondId
    act(() =>
      store.applyHostMessage({
        type: 'accounts',
        payload: {
          items: [
            { id: 'system:claude', backendId: 'claude', label: '本机默认账号', isSystemDefault: true, status: 'authenticated' },
            { id: 'claude-2', backendId: 'claude', label: 'b@example.com', isSystemDefault: false, status: 'authenticated' },
          ],
          channels: { claude: { mode: 'official', accountId: 'claude-2' } },
        },
      }),
    );
    const secondReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const secondId = secondReq && secondReq.type === 'fetchQuota' ? secondReq.payload.requestId : -1;
    expect(secondId).toBeGreaterThan(firstId);

    // 模拟 secondId 先返回成功，紧接着旧的 firstId 乱序返回 unavailable（同一 React 批次内）
    act(() => {
      store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: secondId, quota } });
      store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: firstId, error: 'unavailable' } });
    });
    expect(screen.getByTestId('usage-badge').textContent).toContain('58%');
  });

  it('账号列表同步到当前激活账号的新额度时自动展示，且连接态遇临时 unavailable 会在 3 秒后补查一次', async () => {
    vi.useFakeTimers();
    act(() =>
      store.applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          connection: 'connected',
          backends: { items: [{ id: 'antigravity', name: 'Antigravity', kind: 'acp' }], active: 'antigravity' },
          accounts: {
            items: [
              { id: 'agy-1', backendId: 'antigravity', label: 'user@gmail.com', isSystemDefault: false, status: 'authenticated' },
            ],
            channels: { antigravity: { mode: 'official', accountId: 'agy-1' } },
          },
        }),
      }),
    );
    render(createElement(UsageBadge));
    const req1 = vscode.posted.find((m) => m.type === 'fetchQuota');
    const id1 = req1 && req1.type === 'fetchQuota' ? req1.payload.requestId : -1;

    // 首次探测返回 unavailable 后，3 秒自动补查一次
    vscode.reset();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: id1, error: 'unavailable' } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    const retryReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    expect(retryReq).toBeTruthy();
    const retryId = retryReq && retryReq.type === 'fetchQuota' ? retryReq.payload.requestId : -1;
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId: retryId, error: 'unavailable' } }));
    expect(screen.queryByTestId('usage-badge')).toBeNull();

    // 之后宿主通过 accounts 广播当前账号的新额度，徽标立即可见
    const freshQuota: QuotaView = {
      windows: [
        { kind: 'weekly', label: 'gemini', usedPercent: 27, remainingPercent: 73 },
        { kind: 'session', label: 'gemini', usedPercent: 4, remainingPercent: 96 },
      ],
      queriedAt: Date.now() + 10_000,
    };
    act(() =>
      store.applyHostMessage({
        type: 'accounts',
        payload: {
          items: [
            {
              id: 'agy-1',
              backendId: 'antigravity',
              label: 'user@gmail.com',
              isSystemDefault: false,
              status: 'authenticated',
              quota: freshQuota,
            },
          ],
          channels: { antigravity: { mode: 'official', accountId: 'agy-1' } },
        },
      }),
    );
    expect(screen.getByTestId('usage-badge').textContent).toContain('96%');
    expect(screen.getByTestId('usage-ring-outer').getAttribute('data-percent')).toBe('73');
    expect(screen.getByTestId('usage-ring-inner').getAttribute('data-percent')).toBe('96');
  });

  it('每轮对话结束后强制刷新额度，并平滑过渡进度条与数字变化', async () => {
    vi.useFakeTimers();
    const requestId = mount();
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId,
          quota: {
            windows: [
              { kind: 'weekly', label: 'gemini', usedPercent: 50, remainingPercent: 50 },
              { kind: 'session', label: 'gemini', usedPercent: 20, remainingPercent: 80 },
            ],
            queriedAt: Date.now(),
          },
        },
      }),
    );

    const badge = screen.getByTestId('usage-badge');
    expect(badge.textContent).toContain('80%');

    // 打开浮层以便观察进度条与数字动画
    fireEvent.pointerEnter(badge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const fillsBefore = screen.getAllByTestId('usage-bar-fill');
    expect(fillsBefore[0]!.className).toContain('transition-[width]');
    expect((fillsBefore[0] as HTMLElement).style.width).toBe('50%');
    expect((fillsBefore[1] as HTMLElement).style.width).toBe('80%');

    // 开始一轮对话（running: false -> true），不触发额度刷新
    vscode.reset();
    act(() =>
      store.applyHostMessage({
        type: 'session',
        payload: { ...claudeSnapshot().session, running: true },
      }),
    );
    expect(vscode.posted.filter((m) => m.type === 'fetchQuota')).toHaveLength(0);

    // 对话回合结束（running: true -> false）：立即带 force: true 刷新额度
    act(() =>
      store.applyHostMessage({
        type: 'session',
        payload: { ...claudeSnapshot().session, running: false },
      }),
    );
    const refreshReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    expect(refreshReq).toBeTruthy();
    expect(refreshReq && refreshReq.type === 'fetchQuota' ? refreshReq.payload.force : undefined).toBe(true);

    // 宿主返回更新后的额度：进度条目标宽度立即更新，数字经动画过渡到目标值
    const refreshId = refreshReq && refreshReq.type === 'fetchQuota' ? refreshReq.payload.requestId : -1;
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId: refreshId,
          quota: {
            windows: [
              { kind: 'weekly', label: 'gemini', usedPercent: 53, remainingPercent: 47 },
              { kind: 'session', label: 'gemini', usedPercent: 29, remainingPercent: 71 },
            ],
            queriedAt: Date.now() + 1_000,
          },
        },
      }),
    );

    const fillsAfter = screen.getAllByTestId('usage-bar-fill').map((el) => (el as HTMLElement).style.width);
    expect(fillsAfter).toEqual(['47%', '71%']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByTestId('usage-badge').textContent).toContain('71%');
    expect(screen.getByTestId('usage-popover').textContent).toContain('剩余 47%');
    expect(screen.getByTestId('usage-popover').textContent).toContain('剩余 71%');
  });

  it('积分模式（如 CodeBuddy）展示积分胶囊与 5 格能量条，悬浮展示主积分卡与资源包明细并支持数值动画', async () => {
    vi.useFakeTimers();
    act(() =>
      store.applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          backends: { items: [{ id: 'codebuddy', name: 'CodeBuddy', kind: 'codebuddy' }], active: 'codebuddy' },
        }),
      }),
    );
    render(createElement(UsageBadge));
    const probe = vscode.posted.find((m) => m.type === 'fetchQuota');
    const requestId = probe && probe.type === 'fetchQuota' ? probe.payload.requestId : -1;

    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId,
          quota: {
            mode: 'credits',
            windows: [
              {
                kind: 'cycle',
                label: '',
                usedPercent: 63,
                remainingPercent: 37,
                remainingAmount: 1850,
                totalAmount: 5000,
                usedAmount: 3150,
                resetsAt: Date.now() + 5 * 86_400_000,
              },
              {
                kind: 'cycle',
                label: 'Pro',
                usedPercent: 20,
                remainingPercent: 80,
                remainingAmount: 800,
                totalAmount: 1000,
                usedAmount: 200,
              },
            ],
            queriedAt: Date.now(),
          },
        },
      }),
    );

    const badge = screen.getByTestId('usage-badge');
    expect(badge.getAttribute('data-quota-mode')).toBe('credits');
    expect(badge.textContent).toContain('1,850 积分');
    expect(screen.queryByTestId('usage-dual-ring')).toBeNull();
    expect(screen.getByTestId('usage-credit-gauge').getAttribute('data-percent')).toBe('37');

    // 悬浮展开积分余额浮层
    fireEvent.pointerEnter(badge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const popover = screen.getByTestId('usage-popover');
    expect(popover.getAttribute('data-quota-mode')).toBe('credits');
    expect(screen.getByTestId('usage-credits-hero').textContent).toContain('1,850');
    expect(screen.getByTestId('usage-credits-hero').textContent).toContain('/ 5,000 积分');
    expect(screen.getByTestId('usage-credits-hero').textContent).toContain('已用 3,150');
    expect(screen.getByTestId('usage-credit-pack-Pro').textContent).toContain('800');
    expect(screen.getByTestId('usage-credit-pack-Pro').textContent).toContain('/ 1,000 积分');

    const fills = screen.getAllByTestId('usage-bar-fill').map((el) => (el as HTMLElement).style.width);
    expect(fills).toEqual(['37%', '80%']);

    // 回合结束后余额减少，触发积分数字与进度条平滑动画
    vscode.reset();
    act(() =>
      store.applyHostMessage({
        type: 'session',
        payload: { ...claudeSnapshot().session, running: true },
      }),
    );
    act(() =>
      store.applyHostMessage({
        type: 'session',
        payload: { ...claudeSnapshot().session, running: false },
      }),
    );
    const refreshReq = vscode.posted.find((m) => m.type === 'fetchQuota');
    const refreshId = refreshReq && refreshReq.type === 'fetchQuota' ? refreshReq.payload.requestId : -1;
    act(() =>
      store.applyHostMessage({
        type: 'quotaFetched',
        payload: {
          requestId: refreshId,
          quota: {
            mode: 'credits',
            windows: [
              {
                kind: 'cycle',
                label: '',
                usedPercent: 65,
                remainingPercent: 35,
                remainingAmount: 1750,
                totalAmount: 5000,
                usedAmount: 3250,
              },
            ],
            queriedAt: Date.now() + 1_000,
          },
        },
      }),
    );

    expect(screen.getByTestId('usage-credit-gauge').getAttribute('data-percent')).toBe('35');
    expect((screen.getAllByTestId('usage-bar-fill')[0] as HTMLElement).style.width).toBe('35%');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByTestId('usage-badge').textContent).toContain('1,750 积分');
    expect(screen.getByTestId('usage-credits-hero').textContent).toContain('1,750');
  });
});

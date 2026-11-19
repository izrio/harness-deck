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
    { kind: 'session', label: 'gemini', usedPercent: 12, remainingPercent: 88 },
    { kind: 'weekly', label: '3p', usedPercent: 92, remainingPercent: 8 },
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

  it('拿到额度后显示标识，悬浮展开用量与剩余明细', async () => {
    vi.useFakeTimers();
    const requestId = mount();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId, quota } }));

    const badge = screen.getByTestId('usage-badge');
    expect(badge.textContent).toContain('91%'); // 取最紧的窗口
    expect(screen.queryByTestId('usage-popover')).toBeNull();

    fireEvent.pointerEnter(badge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const body = screen.getByTestId('usage-popover');
    expect(body.textContent).toContain('5 小时');
    expect(body.textContent).toContain('每周');
    expect(body.textContent).toContain('Fable');
    expect(body.textContent).toContain('已用 91%');
    expect(body.textContent).toContain('剩余 9%');
    expect(body.textContent).toContain('额外用量');

    fireEvent.pointerLeave(badge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByTestId('usage-popover')).toBeNull();
  });

  it('计费周期与额度池标题按语言包展示', async () => {
    vi.useFakeTimers();
    const requestId = mount();
    act(() => store.applyHostMessage({ type: 'quotaFetched', payload: { requestId, quota: poolQuota } }));

    fireEvent.pointerEnter(screen.getByTestId('usage-badge'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const body = screen.getByTestId('usage-popover').textContent ?? '';
    expect(body).toContain('本计费周期');
    expect(body).toContain('本计费周期 · Pro');
    expect(body).toContain('5 小时 · Gemini 模型');
    expect(body).toContain('每周 · Claude 与 GPT 模型');
    expect(body).toContain('每周 · Fable');
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
});

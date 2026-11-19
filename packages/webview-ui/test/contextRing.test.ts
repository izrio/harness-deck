// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { ContextDetail } from '@harness-deck/shared';

let ContextRing: typeof import('../src/components/ContextRing.tsx').ContextRing;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  });
  store = await import('../src/store.ts');
  ({ ContextRing } = await import('../src/components/ContextRing.tsx'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  store.resetStoreForTests();
});

const detail: ContextDetail = {
  lastRequest: { input: 1_840, output: 6_200, cacheRead: 24_800, cacheWrite: 3_560, reasoning: 2_400 },
  session: { input: 9_620, output: 21_400, cacheRead: 118_000, cacheWrite: 12_900 },
  requests: 14,
  cost: { amount: 1.284, currency: 'USD' },
};

describe('上下文圆环用量明细', () => {
  it('无明细时保持纯展示圆环：title 提示、不弹浮层', () => {
    render(createElement(ContextRing, { usage: 0.28, tokens: { used: 36_400, window: 128_000 } }));
    const ring = screen.getByTestId('context-ring');
    expect(ring.getAttribute('role')).toBe('img');
    expect(ring.getAttribute('title')).toContain('28%');
    expect(screen.queryByTestId('context-detail')).toBeNull();
  });

  it('点击圆环弹出明细：输入 / 缓存读写 / 输出、请求数与费用', () => {
    render(createElement(ContextRing, { usage: 0.28, tokens: { used: 36_400, window: 128_000 }, detail }));
    fireEvent.click(screen.getByTestId('context-ring'));

    const body = screen.getByTestId('context-detail');
    expect(body.textContent).toContain('最近一次请求');
    expect(body.textContent).toContain('本会话累计');
    expect(body.textContent).toContain('14 次请求');
    expect(body.textContent).toContain('输入');
    expect(body.textContent).toContain('缓存读取');
    expect(body.textContent).toContain('缓存写入');
    expect(body.textContent).toContain('输出');
    expect(body.textContent).toContain('36.4k / 128.0k tokens');
    expect(screen.getByTestId('context-detail-cost').textContent).toBe('$1.28');
  });

  it('悬停 250ms 后自动弹出明细浮层', async () => {
    vi.useFakeTimers();
    render(createElement(ContextRing, { usage: 0.28, detail }));
    fireEvent.pointerEnter(screen.getByTestId('context-ring'));
    expect(screen.queryByTestId('context-detail')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByTestId('context-detail')).toBeTruthy();
  });
});

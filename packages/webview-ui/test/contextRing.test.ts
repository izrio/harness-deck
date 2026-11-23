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
  performance: { ttftMs: 1_240, tokensPerSec: 68.4, durationMs: 4_820 },
};

describe('上下文圆环用量明细', () => {
  it('仅有占比且无 tokens 与明细时保持纯展示标识：显示百分比、title 提示、不弹浮层', () => {
    render(createElement(ContextRing, { usage: 0.28 }));
    const ring = screen.getByTestId('context-ring');
    expect(ring.getAttribute('role')).toBe('img');
    expect(ring.textContent).toContain('28%');
    expect(ring.getAttribute('title')).toContain('28%');
    expect(screen.queryByTestId('context-detail')).toBeNull();
  });

  it('仅有 tokens 无四段明细时仍可点击弹出上下文进度与 token 数浮窗', () => {
    render(createElement(ContextRing, { usage: 0.28, tokens: { used: 36_400, window: 128_000 } }));
    fireEvent.click(screen.getByTestId('context-ring'));
    const body = screen.getByTestId('context-detail');
    expect(body.textContent).toContain('28%');
    expect(body.textContent).toContain('36.4k / 128.0k tokens');
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
    expect(screen.getByTestId('context-detail-cache-rate').textContent).toBe('(82.1%)');
    expect(screen.getByTestId('context-detail-session-cache-rate').textContent).toBe('84.0%');
    expect(screen.getByTestId('context-detail-ttft').textContent).toBe('1.2s');
    expect(screen.getByTestId('context-detail-speed').textContent).toBe('68.4 tok/s');
    expect(screen.getByTestId('context-detail-cost').textContent).toBe('$1.28');
  });

  it('首字耗时小于 1 秒显示毫秒，仅上报单指标时正常渲染', () => {
    const fastDetail: ContextDetail = {
      lastRequest: { input: 100, output: 200, cacheRead: 9_900, cacheWrite: 0 },
      session: { input: 100, output: 200, cacheRead: 9_900, cacheWrite: 0 },
      requests: 1,
      performance: { ttftMs: 480 },
    };
    render(createElement(ContextRing, { usage: 0.1, detail: fastDetail }));
    fireEvent.click(screen.getByTestId('context-ring'));

    expect(screen.getByTestId('context-detail-cache-rate').textContent).toBe('(99.0%)');
    expect(screen.getByTestId('context-detail-ttft').textContent).toBe('480ms');
    expect(screen.queryByTestId('context-detail-speed')).toBeNull();
  });

  it('首轮请求与会话累计一致时自动去重，只展示一节明细', () => {
    const single: ContextDetail = {
      lastRequest: { input: 142_000, output: 2_500, cacheRead: 405_300, cacheWrite: 0, reasoning: 672 },
      session: { input: 142_000, output: 2_500, cacheRead: 405_300, cacheWrite: 0, reasoning: 672 },
      requests: 1,
    };
    render(createElement(ContextRing, { usage: 0.15, tokens: { used: 156_900, window: 1_000_000 }, detail: single }));
    fireEvent.click(screen.getByTestId('context-ring'));

    const body = screen.getByTestId('context-detail');
    expect(body.textContent).not.toContain('最近一次请求');
    expect(body.textContent).toContain('本会话累计');
    expect(body.textContent).toContain('1 次请求');
    expect(body.textContent).toContain('其中推理 672');
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

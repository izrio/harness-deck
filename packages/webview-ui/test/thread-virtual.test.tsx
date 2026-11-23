// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '@harness-deck/shared';
import { Thread } from '../src/components/Thread.tsx';
import {
  LOAD_OLDER_THRESHOLD,
  THREAD_GAP,
  computeVirtualLayout,
  computeVisibleRange,
  detectPrependAnchor,
} from '../src/hooks/virtualThreadMath.ts';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { buildThreadRows } from '../src/threadRows.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

function makeItems(count: number, prefix = 'msg', startIndex = 0): Item[] {
  const list: Item[] = [];
  for (let i = 0; i < count; i++) {
    const n = startIndex + i;
    if (n % 2 === 0) {
      list.push({ kind: 'user', id: `${prefix}-${n}`, text: `用户消息 #${n}` });
    } else {
      list.push({ kind: 'assistant', id: `${prefix}-${n}`, markdown: `助手回复 #${n}`, streaming: false });
    }
  }
  return list;
}

function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; clientWidth?: number; scrollTop?: number },
) {
  let currentScrollTop = metrics.scrollTop ?? 0;
  let currentScrollHeight = metrics.scrollHeight;
  let currentClientHeight = metrics.clientHeight;
  const currentClientWidth = metrics.clientWidth ?? 600;

  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => currentScrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => currentClientHeight,
  });
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    get: () => currentClientWidth,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = Math.max(0, Math.min(value, Math.max(0, currentScrollHeight - currentClientHeight)));
    },
  });

  return {
    setScrollHeight(next: number) {
      currentScrollHeight = next;
    },
    setClientHeight(next: number) {
      currentClientHeight = next;
    },
    getScrollTop() {
      return currentScrollTop;
    },
    setScrollTopRaw(next: number) {
      currentScrollTop = next;
    },
  };
}

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('virtualThreadMath 纯计算', () => {
  it('computeVirtualLayout 正确累加已测高度、估算高度与间距', () => {
    const items = makeItems(4);
    const measured = new Map<string, number>([
      ['msg-0', 60],
      ['msg-2', 120],
    ]);
    const layout = computeVirtualLayout(buildThreadRows(items), measured, THREAD_GAP);

    expect(layout.sizes[0]).toBe(60);
    expect(layout.sizes[2]).toBe(120);
    expect(layout.offsets[0]).toBe(0);
    expect(layout.offsets[1]).toBe(60 + THREAD_GAP);
    expect(layout.offsets[2]).toBe(60 + THREAD_GAP + layout.sizes[1]! + THREAD_GAP);
    expect(layout.totalHeight).toBe(layout.offsets[3]! + layout.sizes[3]!);
  });

  it('computeVisibleRange 在大规模列表中通过二分查找返回紧凑可视区间', () => {
    const items = makeItems(2000);
    const measured = new Map(items.map((item) => [item.id, 80]));
    const layout = computeVirtualLayout(buildThreadRows(items), measured, THREAD_GAP);

    const topRange = computeVisibleRange(layout, 0, 600, 300, 2);
    expect(topRange.startIndex).toBe(0);
    expect(topRange.endIndex).toBeLessThan(25);

    const midOffset = layout.offsets[1000]!;
    const midRange = computeVisibleRange(layout, midOffset, 600, 300, 2);
    expect(midRange.startIndex).toBeLessThanOrEqual(1000);
    expect(midRange.endIndex).toBeGreaterThanOrEqual(1000);
    expect(midRange.endIndex - midRange.startIndex + 1).toBeLessThan(30);

    const bottomRange = computeVisibleRange(layout, layout.totalHeight - 600, 600, 300, 2);
    expect(bottomRange.endIndex).toBe(1999);
    expect(bottomRange.startIndex).toBeGreaterThan(1970);
  });

  it('detectPrependAnchor 准确识别前插消息并兼容边界合并，不在尾部追加时误报', () => {
    const base = makeItems(5, 'm', 10);
    const prepended = [...makeItems(3, 'm', 7), ...base];
    const anchor = detectPrependAnchor(buildThreadRows(base), buildThreadRows(prepended));
    expect(anchor).toEqual({ anchorId: 'm-10', prevIndex: 0, nextIndex: 3 });

    // 首条在边界合并，次条 m-11 仍能作为锚点
    const boundaryMerged = [...makeItems(3, 'm', 7), { kind: 'user' as const, id: 'm-merged', text: 'merged' }, ...base.slice(1)];
    const mergedAnchor = detectPrependAnchor(buildThreadRows(base), buildThreadRows(boundaryMerged));
    expect(mergedAnchor).toEqual({ anchorId: 'm-11', prevIndex: 1, nextIndex: 4 });

    // 尾部追加不触发前插锚点
    const appended = [...base, ...makeItems(3, 'm', 15)];
    expect(detectPrependAnchor(buildThreadRows(base), buildThreadRows(appended))).toBeUndefined();
  });
});

describe('Thread 虚拟滚动与顶部自动无限加载', () => {
  it('长会话只挂载可视窗口内的少量节点，上下滚动时动态切换渲染切片', () => {
    const items = makeItems(200);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-long', title: '长会话', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    expect(scroller).toBeTruthy();

    const rowsInitial = container.querySelectorAll('[data-virtual-index]');
    // 200 条消息只渲染底部窗口一小部分（远少于 200）
    expect(rowsInitial.length).toBeGreaterThan(0);
    expect(rowsInitial.length).toBeLessThan(60);
    // 默认贴底，包含最后一条消息
    expect(container.querySelector('[data-virtual-id="msg-199"]')).not.toBeNull();
    expect(container.querySelector('[data-virtual-id="msg-0"]')).toBeNull();

    // 模拟滚回顶部
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);
    mockScrollMetrics(scroller, {
      scrollHeight: layout.totalHeight + 40,
      clientHeight: 600,
      scrollTop: 0,
    });
    act(() => {
      fireEvent.scroll(scroller);
    });

    // 滚到顶部后渲染顶部切片并卸载底部切片，且出现回底按钮
    expect(container.querySelector('[data-virtual-id="msg-0"]')).not.toBeNull();
    expect(container.querySelector('[data-virtual-id="msg-199"]')).toBeNull();
    expect(screen.getByTestId('to-bottom')).toBeTruthy();

    // 再滚到底部，恢复渲染尾部切片且隐藏回底按钮
    act(() => {
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      fireEvent.scroll(scroller);
    });
    expect(container.querySelector('[data-virtual-id="msg-199"]')).not.toBeNull();
    expect(screen.queryByTestId('to-bottom')).toBeNull();
  });

  it('存在更早历史时不渲染点击按钮，向上滚动接近顶部时自动触发 loadOlder 并去重，支持连续无限加载且保持阅读锚点', () => {
    const page3 = makeItems(40, 'm', 80); // m-80 .. m-119
    const page2 = makeItems(40, 'm', 40); // m-40 .. m-79
    const page1 = makeItems(40, 'm', 0); // m-0 .. m-39

    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-inf', title: '无限历史', running: false, hasOlder: true, loadingOlder: false, sync: 'live' },
          items: page3,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;

    // 确认不存在需要点击的「加载更早的消息」按钮
    expect(screen.queryByRole('button', { name: /加载更早的消息|Load earlier/i })).toBeNull();

    const layout3 = computeVirtualLayout(buildThreadRows(page3), new Map(), THREAD_GAP);
    const metrics = mockScrollMetrics(scroller, {
      scrollHeight: layout3.totalHeight + 40,
      clientHeight: 600,
      scrollTop: layout3.totalHeight - 600,
    });

    // 在底部不触发 loadOlder
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(0);

    // 向上滚入顶部阈值内：自动触发第一次 loadOlder
    act(() => {
      scroller.scrollTop = LOAD_OLDER_THRESHOLD - 100;
      fireEvent.scroll(scroller);
    });
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(1);
    expect(screen.getByTestId('thread-loading-older')).toBeTruthy();

    // 仍在请求中继续滚动：严格去重，不重复发送 loadOlder
    act(() => {
      scroller.scrollTop = 20;
      fireEvent.scroll(scroller);
    });
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(1);

    // Host 推送 loadingOlder: true -> 然后返回 page2（仍有更早历史 hasOlder: true）
    const combined23 = [...page2, ...page3];
    const layout23 = computeVirtualLayout(buildThreadRows(combined23), new Map(), THREAD_GAP);
    const scrollBeforePrepend = metrics.getScrollTop();
    const expectedDelta2 = layout23.offsets[page2.length]!;

    act(() => {
      applyHostMessage({
        type: 'session',
        payload: { id: 'sess-inf', title: '无限历史', running: false, hasOlder: true, loadingOlder: true, sync: 'live' },
      });
    });

    act(() => {
      metrics.setScrollHeight(layout23.totalHeight + 40);
      applyHostMessage({
        type: 'session',
        payload: { id: 'sess-inf', title: '无限历史', running: false, hasOlder: true, loadingOlder: false, sync: 'live' },
      });
      applyHostMessage({
        type: 'items',
        payload: {
          sessionKey: 'sess-inf',
          reset: false,
          order: combined23.map((i) => i.id),
          upsert: page2,
        },
      });
    });

    // 滚动位置应按新增高度向下补偿，锚定在原先阅读的 m-80 附近，且不误亮未读红点
    expect(metrics.getScrollTop()).toBeCloseTo(scrollBeforePrepend + expectedDelta2, 0);
    expect(container.querySelector('.to-bottom__dot')).toBeNull();
    // 锚定补偿后远离顶部，不会自动连环触发下一次加载
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(1);

    // 用户继续向上滚到顶部附近：无缝自动触发第二次 loadOlder（无限滚动）
    act(() => {
      scroller.scrollTop = 60;
      fireEvent.scroll(scroller);
    });
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(2);

    // Host 返回最后一页 page1，hasOlder 变为 false
    const combined123 = [...page1, ...combined23];
    const layout123 = computeVirtualLayout(buildThreadRows(combined123), new Map(), THREAD_GAP);
    act(() => {
      metrics.setScrollHeight(layout123.totalHeight + 40);
      applyHostMessage({
        type: 'session',
        payload: { id: 'sess-inf', title: '无限历史', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
      });
      applyHostMessage({
        type: 'items',
        payload: {
          sessionKey: 'sess-inf',
          reset: false,
          order: combined123.map((i) => i.id),
          upsert: page1,
        },
      });
    });

    // 已到历史起点，不再渲染加载指示器，再次滚到顶部也不会再发 loadOlder
    expect(screen.queryByTestId('thread-loading-older')).toBeNull();
    expect(screen.queryByTestId('thread-older-sentinel')).toBeNull();
    act(() => {
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
    });
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(2);
  });

  it('首屏消息高度不足一屏且仍有更早历史时自动补齐加载，无需滚动或点击', () => {
    const shortItems = makeItems(2, 'short', 10);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-short', title: '短首屏', running: false, hasOlder: true, loadingOlder: false, sync: 'live' },
          items: shortItems,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;

    mockScrollMetrics(scroller, {
      scrollHeight: 180,
      clientHeight: 700,
      scrollTop: 0,
    });

    // 触发一次会话/尺寸更新（模拟真实浏览器 ResizeObserver 报告视口高度）
    act(() => {
      fireEvent.scroll(scroller);
    });

    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(1);
  });

  it('上翻阅读时尾部追加新消息点亮未读红点，点击回底按钮清除未读并平滑滚到底部', () => {
    const items = makeItems(80, 'chat', 0);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-unread', title: '未读测试', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);
    mockScrollMetrics(scroller, {
      scrollHeight: layout.totalHeight + 40,
      clientHeight: 600,
      scrollTop: 0,
    });

    const scrollToSpy = vi.fn();
    scroller.scrollTo = scrollToSpy;

    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(screen.getByTestId('to-bottom')).toBeTruthy();
    expect(container.querySelector('.to-bottom__dot')).toBeNull();

    // 尾部追加新消息
    const nextItem: Item = { kind: 'assistant', id: 'chat-80', markdown: '最新回复', streaming: false };
    const nextItems = [...items, nextItem];
    act(() => {
      applyHostMessage({
        type: 'items',
        payload: {
          sessionKey: 'sess-unread',
          reset: false,
          order: nextItems.map((i) => i.id),
          upsert: [nextItem],
        },
      });
    });
    expect(container.querySelector('.to-bottom__dot')).not.toBeNull();

    // 点击回底按钮
    fireEvent.click(screen.getByTestId('to-bottom'));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: scroller.scrollHeight, behavior: 'smooth' });
    expect(container.querySelector('.to-bottom__dot')).toBeNull();
  });

  it('视口上方条目实际测量高度变大时自动补偿 scrollTop，防止上翻阅读时画面跳动', () => {
    const items = makeItems(60, 'dyn', 0);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-dyn', title: '动态高度', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);

    // 滚动到第 25 条附近（上方 overscan 里包含更早的条目）
    const targetScrollTop = layout.offsets[25]!;
    const metrics = mockScrollMetrics(scroller, {
      scrollHeight: layout.totalHeight + 40,
      clientHeight: 600,
      scrollTop: targetScrollTop,
    });

    act(() => {
      fireEvent.scroll(scroller);
    });

    // 找一个完全位于视口上方（overscan 内）的已挂载条目，模拟其真实高度比估算值高出 120px
    const aboveIndex = 20;
    const aboveRow = container.querySelector(`[data-virtual-id="dyn-${aboveIndex}"]`) as HTMLDivElement | null;
    expect(aboveRow).not.toBeNull();
    const estimated = layout.sizes[aboveIndex]!;
    const actualHeight = estimated + 120;
    aboveRow!.getBoundingClientRect = () =>
      ({
        height: actualHeight,
        width: 560,
        top: 0,
        bottom: actualHeight,
        left: 0,
        right: 560,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    // 触发一次新的渲染/layout 测量（例如一条无关状态更新）
    act(() => {
      applyHostMessage({
        type: 'session',
        payload: { id: 'sess-dyn', title: '动态高度（已更新）', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
      });
    });

    // scrollTop 应补偿 +120px，保持当前阅读的第 25 条留在原视口位置
    expect(metrics.getScrollTop()).toBeCloseTo(targetScrollTop + 120, 0);
  });

  it('切换会话时重置贴底与无限加载状态，直接渲染新会话尾部条目', () => {
    const sessA = makeItems(120, 'a', 0);
    const sessB = makeItems(120, 'b', 0);

    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-a', title: 'A', running: false, hasOlder: true, loadingOlder: false, sync: 'live' },
          items: sessA,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layoutA = computeVirtualLayout(buildThreadRows(sessA), new Map(), THREAD_GAP);
    mockScrollMetrics(scroller, {
      scrollHeight: layoutA.totalHeight + 40,
      clientHeight: 600,
      scrollTop: 50,
    });

    // 在会话 A 上翻到顶部，触发一次 loadOlder
    act(() => {
      fireEvent.scroll(scroller);
    });
    expect(vscode.posted.filter((m) => m.type === 'loadOlder')).toHaveLength(1);
    expect(container.querySelector('[data-virtual-id="a-0"]')).not.toBeNull();

    // 切换到会话 B
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-b', title: 'B', running: false, hasOlder: true, loadingOlder: false, sync: 'live' },
          items: sessB,
        }),
      });
    });

    // 会话 B 应立刻贴底渲染尾部，隐藏回底按钮，不保留旧会话的加载中状态
    expect(container.querySelector('[data-virtual-id="b-119"]')).not.toBeNull();
    expect(container.querySelector('[data-virtual-id="b-0"]')).toBeNull();
    expect(screen.queryByTestId('to-bottom')).toBeNull();
    expect(screen.queryByTestId('thread-loading-older')).toBeNull();
  });

  it('滚到接近底部时上方条目实际高度小于估算且被浏览器钳位，不再二次扣减把滚动条弹回中部', () => {
    const items: Item[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'assistant' as const,
      id: `shrink-${i}`,
      markdown: Array.from({ length: 18 }, (__, line) => `第 ${i}-${line} 行内容`).join('\n'),
      streaming: false,
    }));
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-shrink', title: '收缩防回弹', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);
    const oldScrollHeight = layout.totalHeight + 40;
    const clientHeight = 600;
    const nearBottomScrollTop = oldScrollHeight - clientHeight - 60;

    const metrics = mockScrollMetrics(scroller, {
      scrollHeight: oldScrollHeight,
      clientHeight,
      scrollTop: nearBottomScrollTop,
    });

    // 先滚到距底 60px（仍未贴底，stickRef=false）
    act(() => {
      fireEvent.scroll(scroller);
    });

    // 模拟上方已挂载条目比估算值矮 400px，同时浏览器因 scrollHeight 缩小把 scrollTop 自动钳位到新底部
    const aboveIndex = 36;
    const aboveRow = container.querySelector(`[data-virtual-id="shrink-${aboveIndex}"]`) as HTMLDivElement | null;
    expect(aboveRow).not.toBeNull();
    const estimated = layout.sizes[aboveIndex]!;
    const actualHeight = Math.max(40, estimated - 400);
    const shrinkDelta = estimated - actualHeight;
    aboveRow!.getBoundingClientRect = () =>
      ({
        height: actualHeight,
        width: 560,
        top: 0,
        bottom: actualHeight,
        left: 0,
        right: 560,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const nextScrollHeight = oldScrollHeight - shrinkDelta;
    metrics.setScrollHeight(nextScrollHeight);
    const clampedBottom = nextScrollHeight - clientHeight;
    metrics.setScrollTopRaw(clampedBottom);

    // 触发一次布局测量
    act(() => {
      applyHostMessage({
        type: 'session',
        payload: { id: 'sess-shrink', title: '收缩防回弹（刷新）', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
      });
    });

    // 应停留在新底部上方 60px（保留原距底偏移），而不是从 clampedBottom 再减去 shrinkDelta 弹回中部
    expect(metrics.getScrollTop()).toBeCloseTo(clampedBottom - 60, 0);
  });

  it('贴底状态下内容异步变高触发 scroll 事件（scrollTop 未减小）时保持贴底，不回弹到中部', () => {
    const items = makeItems(40, 'grow', 0);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-grow', title: '底部变高', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);
    const initialHeight = layout.totalHeight + 40;
    const clientHeight = 600;

    const metrics = mockScrollMetrics(scroller, {
      scrollHeight: initialHeight,
      clientHeight,
      scrollTop: initialHeight - clientHeight,
    });

    // 先在底部触发一次 scroll，建立基线（stickRef=true）
    act(() => {
      fireEvent.scroll(scroller);
    });

    // 模拟长回复/代码高亮导致 scrollHeight 突增 +1600px，同时在 ResizeObserver 前触发一次 scroll（用户并未上滚）
    const expandedHeight = initialHeight + 1600;
    metrics.setScrollHeight(expandedHeight);
    act(() => {
      fireEvent.scroll(scroller);
    });

    // 仍应自动贴到新底部，且不显示回底按钮
    expect(metrics.getScrollTop()).toBe(expandedHeight - clientHeight);
    expect(screen.queryByTestId('to-bottom')).toBeNull();

    // 用户真正向上滚（scrollTop 减小）时立刻解除贴底
    act(() => {
      scroller.scrollTop = 400;
      fireEvent.scroll(scroller);
    });
    expect(metrics.getScrollTop()).toBe(400);
    expect(screen.getByTestId('to-bottom')).toBeTruthy();
  });

  it('跨过视口顶线的当前阅读条目首次测量高度变化时，不把 scrollTop 弹离当前位置', () => {
    const items: Item[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'assistant' as const,
      id: `straddle-${i}`,
      markdown: Array.from({ length: 14 }, (__, line) => `段落 ${i}-${line}`).join('\n'),
      streaming: false,
    }));
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-straddle', title: '跨顶线条目', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);
    const straddleIndex = 15;
    // scrollTop 落在该条目的正中间（itemTop < scrollOffset < itemTop + oldHeight）
    const targetScrollTop = layout.offsets[straddleIndex]! + Math.floor(layout.sizes[straddleIndex]! / 2);

    const metrics = mockScrollMetrics(scroller, {
      scrollHeight: layout.totalHeight + 40,
      clientHeight: 600,
      scrollTop: targetScrollTop,
    });

    act(() => {
      fireEvent.scroll(scroller);
    });

    const rowEl = container.querySelector(`[data-virtual-id="straddle-${straddleIndex}"]`) as HTMLDivElement | null;
    expect(rowEl).not.toBeNull();
    const actualHeight = layout.sizes[straddleIndex]! + 600;
    rowEl!.getBoundingClientRect = () =>
      ({
        height: actualHeight,
        width: 560,
        top: 0,
        bottom: actualHeight,
        left: 0,
        right: 560,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      applyHostMessage({
        type: 'session',
        payload: { id: 'sess-straddle', title: '跨顶线条目（刷新）', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
      });
    });

    expect(metrics.getScrollTop()).toBeCloseTo(targetScrollTop, 0);
  });

  it('贴底状态下因输入框增高导致视口 clientHeight 缩小并触发 scroll 事件时，保持贴底不向上偏移', () => {
    const items = makeItems(40, 'shrink-vp', 0);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { id: 'sess-shrink-vp', title: '视口缩小', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
          items,
        }),
      });
    });

    const { container } = render(<Thread />);
    const scroller = container.querySelector('.thread') as HTMLDivElement;
    const layout = computeVirtualLayout(buildThreadRows(items), new Map(), THREAD_GAP);
    const totalHeight = layout.totalHeight + 40;
    const initialClientHeight = 600;

    const metrics = mockScrollMetrics(scroller, {
      scrollHeight: totalHeight,
      clientHeight: initialClientHeight,
      scrollTop: totalHeight - initialClientHeight,
    });

    // 在底部建立基线（stickRef=true）
    act(() => {
      fireEvent.scroll(scroller);
    });

    // 模拟下方输入框增高 120px，导致视口 clientHeight 缩小且 scroll 事件早于 ResizeObserver 到达
    const shrunkClientHeight = initialClientHeight - 120;
    metrics.setClientHeight(shrunkClientHeight);
    act(() => {
      fireEvent.scroll(scroller);
    });

    expect(metrics.getScrollTop()).toBe(totalHeight - shrunkClientHeight);
    expect(screen.queryByTestId('to-bottom')).toBeNull();
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TabBar } from '../src/components/TabBar.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('TabBar 跨智能体标签与图标渲染', () => {
  it('单个标签时也展示顶部标签栏', () => {
    render(<TabBar />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          tabs: {
            items: [{ key: 'utab-1', backendId: 'dsh', backendName: 'DeepSeek', sessionId: 's1', title: 'DSH 任务', running: false }],
            active: 'utab-1',
          },
        }),
      });
    });
    const tabBar = screen.getByTestId('tabs');
    expect(tabBar).not.toBeNull();
    expect(tabBar.querySelectorAll('[role="tab"]')).toHaveLength(1);

    // 新增会话图标按钮位于会话标签栏最右侧，点击发送 newSession
    const newSessionBtn = screen.getByTestId('tabbar-new-session-btn');
    expect(tabBar.compareDocumentPosition(newSessionBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(newSessionBtn);
    expect(vscode.posted).toContainEqual({ type: 'newSession', payload: {} });
  });

  it('同时展示 DeepSeek 与 Claude 标签，并在每个标题前显示对应智能体图标', () => {
    render(<TabBar />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          backends: {
            items: [
              { id: 'dsh', name: 'DeepSeek', kind: 'dsh', available: true },
              { id: 'claude', name: 'Claude Code', kind: 'claude', available: true },
            ],
            active: 'claude',
          },
          tabs: {
            items: [
              { key: 'utab-1', backendId: 'dsh', backendName: 'DeepSeek', sessionId: 's1', title: 'DeepSeek 架构讨论', running: false },
              { key: 'utab-2', backendId: 'claude', backendName: 'Claude Code', sessionId: 'c1', title: 'Claude 编写测试', running: true },
            ],
            active: 'utab-2',
          },
        }),
      });
    });

    const tabBar = screen.getByTestId('tabs');
    const tabElements = tabBar.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabElements).toHaveLength(2);

    const first = tabElements[0]!;
    const second = tabElements[1]!;

    // 第一个标签：DeepSeek 标志位于标题前面
    expect(first.getAttribute('data-backend-id')).toBe('dsh');
    const firstLogo = first.querySelector('[data-logo="dsh"]');
    const firstTitle = first.querySelector('.tab__title');
    expect(firstLogo).not.toBeNull();
    expect(firstTitle?.textContent).toBe('DeepSeek 架构讨论');
    expect(firstLogo!.compareDocumentPosition(firstTitle!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 第二个标签：Claude 标志位于标题前面且处于激活状态
    expect(second.getAttribute('data-backend-id')).toBe('claude');
    expect(second.getAttribute('aria-selected')).toBe('true');
    const secondLogo = second.querySelector('[data-logo="claude"]');
    const secondTitle = second.querySelector('.tab__title');
    expect(secondLogo).not.toBeNull();
    expect(secondTitle?.textContent).toBe('Claude 编写测试');
    expect(secondLogo!.compareDocumentPosition(secondTitle!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 点击第一个标签发送 activateTab，点击关闭按钮发送 closeTab
    fireEvent.click(first);
    expect(vscode.posted).toContainEqual({ type: 'activateTab', payload: { key: 'utab-1' } });

    const closeBtn = first.querySelector('.tab__close') as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(vscode.posted).toContainEqual({ type: 'closeTab', payload: { key: 'utab-1' } });
  });

  it('拖动标签发送 moveTab，右键菜单批量关闭发送 closeTabs', async () => {
    render(<TabBar />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          tabs: {
            items: [
              { key: 'utab-1', backendId: 'dsh', sessionId: 's1', title: '标签一', running: false },
              { key: 'utab-2', backendId: 'dsh', sessionId: 's2', title: '标签二', running: false },
              { key: 'utab-3', backendId: 'dsh', sessionId: 's3', title: '标签三', running: false },
            ],
            active: 'utab-2',
          },
        }),
      });
    });

    const tabBar = screen.getByTestId('tabs');
    const tabElements = tabBar.querySelectorAll<HTMLElement>('[role="tab"]');
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => undefined, getData: () => '' };

    // jsdom 里标签宽度为 0，clientX > 0 时落点视为列表末尾，toIndex 需要减去自身占位
    fireEvent.dragStart(tabElements[0]!, { dataTransfer });
    fireEvent.dragOver(tabBar, { clientX: 300, dataTransfer });
    fireEvent.drop(tabBar, { clientX: 300, dataTransfer });
    expect(vscode.posted).toContainEqual({ type: 'moveTab', payload: { key: 'utab-1', toIndex: 2 } });

    // 右键第二个标签：菜单里关闭其他标签
    fireEvent.contextMenu(tabElements[1]!);
    const closeOthers = await screen.findByText('关闭其他标签');
    fireEvent.click(closeOthers);
    expect(vscode.posted).toContainEqual({ type: 'closeTabs', payload: { key: 'utab-2', scope: 'others' } });
  });

  it('标签溢出时支持鼠标垂直滚轮横向滑动并显示左右滚动按钮，未溢出时隐藏滚动按钮', () => {
    render(<TabBar />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          tabs: {
            items: Array.from({ length: 8 }, (_, idx) => ({
              key: `utab-${idx + 1}`,
              backendId: 'dsh',
              sessionId: `s${idx + 1}`,
              title: `会话标签 ${idx + 1}`,
              running: false,
            })),
            active: 'utab-1',
          },
        }),
      });
    });

    const tabBar = screen.getByTestId('tabs');
    // 未溢出时不显示左右滚动按钮
    expect(screen.queryByTestId('tabbar-scroll-left-btn')).toBeNull();
    expect(screen.queryByTestId('tabbar-scroll-right-btn')).toBeNull();

    // 模拟标签栏发生横向溢出（clientWidth=240, scrollWidth=800）
    let scrollLeft = 0;
    Object.defineProperty(tabBar, 'clientWidth', { configurable: true, value: 240 });
    Object.defineProperty(tabBar, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(tabBar, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.max(0, Math.min(560, value));
      },
    });
    tabBar.scrollBy = ((options?: ScrollToOptions | number) => {
      const delta = typeof options === 'number' ? options : (options?.left ?? 0);
      tabBar.scrollLeft += delta;
    }) as typeof tabBar.scrollBy;

    fireEvent.scroll(tabBar);
    const leftBtn = screen.getByTestId('tabbar-scroll-left-btn') as HTMLButtonElement;
    const rightBtn = screen.getByTestId('tabbar-scroll-right-btn') as HTMLButtonElement;
    expect(leftBtn.disabled).toBe(true);
    expect(rightBtn.disabled).toBe(false);

    // 桌面鼠标垂直滚轮（deltaY > 0）自动转为横向滚动
    const wheelEvent = new WheelEvent('wheel', { deltaY: 120, deltaX: 0, cancelable: true });
    act(() => {
      tabBar.dispatchEvent(wheelEvent);
    });
    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(scrollLeft).toBe(120);
    expect(leftBtn.disabled).toBe(false);
    expect(rightBtn.disabled).toBe(false);

    // 点击向右 / 向左滚动按钮按可见区域步进滑动
    fireEvent.click(rightBtn);
    expect(scrollLeft).toBeGreaterThan(120);
    const afterRight = scrollLeft;
    fireEvent.click(leftBtn);
    expect(scrollLeft).toBeLessThan(afterRight);
  });
});

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
  it('单个标签时隐藏顶部标签栏', () => {
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
    expect(screen.queryByTestId('tabs')).toBeNull();
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
});

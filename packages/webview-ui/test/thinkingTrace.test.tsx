// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '@harness-deck/shared';
import { Thread } from '../src/components/Thread.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

mockVsCodeApi();

const session = { id: 'sess-trace', title: '轨迹', running: false, hasOlder: false, loadingOlder: false, sync: 'live' as const };

const reasoning: Item = { kind: 'assistant', id: 'r1', markdown: '', reasoning: '先看文件', streaming: false };
const edit: Item = { kind: 'activity', id: 'a1', tool: 'edit', variant: 'edit', label: 'src/a.ts', status: 'ok' };
const run: Item = { kind: 'activity', id: 'a2', tool: 'bash', variant: 'command', label: 'bash pnpm test', status: 'ok', output: '3 passed' };
const answer: Item = { kind: 'assistant', id: 'm1', markdown: '改好了', streaming: false };

function pushItems(items: Item[], running = false) {
  act(() => {
    applyHostMessage({
      type: 'snapshot',
      payload: makeSnapshot({ session: { ...session, running }, items }),
    });
  });
}

describe('思考轨迹卡片', () => {
  beforeEach(() => {
    resetStoreForTests();
  });

  it('连续的工具操作收进一张折叠卡片，展开后显示原有活动行', () => {
    pushItems([reasoning, edit, run, answer]);
    const { container } = render(<Thread />);

    const card = screen.getByTestId('thinking-trace');
    expect(card.textContent).toContain('已执行 2 项操作');
    // 默认折叠：卡片内条目未渲染
    expect(container.querySelectorAll('.activity')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('thinking-toggle'));
    expect(container.querySelectorAll('.activity')).toHaveLength(2);
    expect(container.querySelector('.thinking__body')?.textContent).toContain('思考过程');
  });

  it('运行中自动展开，结束后自动收起', () => {
    pushItems([edit, { ...run, status: 'running' }], true);
    const { container } = render(<Thread />);

    expect(container.querySelectorAll('.activity')).toHaveLength(2);
    expect(screen.getByTestId('thinking-trace').textContent).toContain('思考中');
    expect(screen.getByTestId('thinking-trace').querySelector('.thinking__loader')).not.toBeNull();

    pushItems([edit, run], false);
    expect(container.querySelectorAll('.activity')).toHaveLength(0);
    expect(screen.getByTestId('thinking-trace').textContent).toContain('已执行 2 项操作');
  });

  it('手动折叠优先于运行中的自动展开', () => {
    pushItems([edit, { ...run, status: 'running' }], true);
    const { container } = render(<Thread />);

    fireEvent.click(screen.getByTestId('thinking-toggle'));
    expect(container.querySelectorAll('.activity')).toHaveLength(0);

    // 流式更新重渲染后仍保持折叠
    pushItems([edit, { ...run, status: 'running' }, { ...reasoning, id: 'r2' }], true);
    expect(container.querySelectorAll('.activity')).toHaveLength(0);
  });

  it('单条工具操作与有正文的回复不套卡片', () => {
    pushItems([edit, answer]);
    const { container } = render(<Thread />);

    expect(screen.queryByTestId('thinking-trace')).toBeNull();
    expect(container.querySelectorAll('.activity')).toHaveLength(1);
    expect(container.textContent).toContain('改好了');
  });

  it('折叠态不暴露悬空的 aria-controls，切换会话时同步重置手动展开状态', () => {
    pushItems([reasoning, edit, run, answer]);
    const { container } = render(<Thread />);

    const toggle = screen.getByTestId('thinking-toggle');
    expect(toggle.getAttribute('aria-controls')).toBeNull();

    fireEvent.click(toggle);
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).not.toBeNull();
    expect(container.querySelectorAll('.activity')).toHaveLength(2);

    // 切换到拥有相同轨迹行 id 的另一会话：首帧即回到默认折叠态
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          session: { ...session, id: 'sess-trace-2' },
          items: [reasoning, edit, run, answer],
        }),
      });
    });
    expect(screen.getByTestId('thinking-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.activity')).toHaveLength(0);
  });

  it('英文环境下单数与复数工具计数文案正确区分', () => {
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          locale: 'en',
          session,
          items: [reasoning, edit],
        }),
      });
    });
    const { unmount } = render(<Thread />);
    expect(screen.getByTestId('thinking-trace').textContent).toContain('Ran 1 tool');
    expect(screen.getByTestId('thinking-trace').textContent).not.toContain('Ran 1 tools');
    unmount();

    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          locale: 'en',
          session,
          items: [reasoning, edit, run],
        }),
      });
    });
    render(<Thread />);
    expect(screen.getByTestId('thinking-trace').textContent).toContain('Ran 2 tools');
  });
});

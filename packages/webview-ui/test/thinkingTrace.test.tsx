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
const prompt: Item = { kind: 'user', id: 'u1', text: '继续处理' };

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

  it('运行中自动展开且不重复渲染 loading 动效，结束后自动收起', () => {
    pushItems([edit, { ...run, status: 'running' }], true);
    const { container } = render(<Thread />);

    const trace = screen.getByTestId('thinking-trace');
    expect(container.querySelectorAll('.activity')).toHaveLength(2);
    expect(trace.getAttribute('data-active')).toBe('true');
    expect(trace.textContent).toContain('执行中 · 2 项操作');
    // 轨迹头和运行中的活动行都不再叠加额外 spinner / loader，由底部 RunStatus 统一承载唯一 loading
    expect(trace.querySelector('.thinking__loader')).toBeNull();
    expect(trace.querySelector('.spin')).toBeNull();

    const runStatus = screen.getByTestId('run-status');
    expect(runStatus.textContent).toContain('正在运行命令');
    expect(runStatus.getAttribute('data-loading-state')).toBe('Orbit');
    const grid = runStatus.querySelector('[data-variant="Orbit"]');
    expect(grid).not.toBeNull();
    const cells = grid?.querySelectorAll('span') ?? [];
    expect(cells).toHaveLength(9);
    // Orbit 模式：中心格（索引 4）静态微亮，外圈 8 格按 950ms 顺时针公转
    expect((cells[4] as HTMLElement).style.animation).toBe('none');
    expect((cells[4] as HTMLElement).style.opacity).toBe('0.07');
    expect((cells[0] as HTMLElement).style.animation).toContain('pixel-on 950ms');
    expect(runStatus.className).not.toMatch(/rounded-full|bg-surface|shadow-card|bg-orange-tint/u);

    pushItems([edit, run], false);
    expect(container.querySelectorAll('.activity')).toHaveLength(0);
    expect(screen.getByTestId('thinking-trace').getAttribute('data-active')).toBeNull();
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

  it('运行期间轨迹行保持展开，整轮操作结束后才收起', () => {
    const midAnswer: Item = { kind: 'assistant', id: 'm0', markdown: '先处理第一个文件', streaming: false };
    const nextReasoning: Item = { kind: 'assistant', id: 'r2', markdown: '', reasoning: '继续处理', streaming: false };
    const nextEdit: Item = { kind: 'activity', id: 'a3', tool: 'edit', variant: 'edit', label: 'src/b.ts', status: 'running' };

    // 本轮两组轨迹：中间夹着一段有正文的回复，第一组操作已全部完成但整轮还在跑
    pushItems([prompt, reasoning, edit, run, midAnswer, nextReasoning, nextEdit], true);
    const { container } = render(<Thread />);

    const traces = screen.getAllByTestId('thinking-trace');
    expect(traces).toHaveLength(2);
    expect(traces[0]!.getAttribute('data-active')).toBe('true');
    expect(traces[0]!.textContent).toContain('执行中 · 2 项操作');
    expect(screen.getAllByTestId('thinking-toggle')[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.activity')).toHaveLength(3);

    // 整轮结束：两组轨迹统一收起
    pushItems([prompt, reasoning, edit, run, midAnswer, nextReasoning, { ...nextEdit, status: 'ok' }], false);
    expect(screen.getAllByTestId('thinking-toggle').every((toggle) => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.querySelectorAll('.activity')).toHaveLength(0);
    expect(screen.getAllByTestId('thinking-trace')[0]!.textContent).toContain('已执行 2 项操作');
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
          session: { ...session, running: true },
          items: [reasoning, { ...edit, status: 'running' }],
        }),
      });
    });
    const { unmount: unmountActive } = render(<Thread />);
    expect(screen.getByTestId('thinking-trace').textContent).toContain('Running · 1 tool');
    expect(screen.getByTestId('thinking-trace').textContent).not.toContain('Running · 1 tools');
    unmountActive();

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

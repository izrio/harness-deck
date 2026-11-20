import { describe, expect, it } from 'vitest';
import { deriveTurns } from '../src/turns.ts';
import type { Item } from '../src/viewModel.ts';

describe('deriveTurns', () => {
  it('按用户消息切分回合，汇总编辑文件与改动表', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: '第一个任务' },
      { kind: 'activity', id: 'a1', tool: 'edit', variant: 'edit', label: 'src/a.ts', status: 'ok' },
      { kind: 'changes', id: 'c1', turn: 1, source: 'turn', total: 2, files: [
        { path: 'src/a.ts', ref: { kind: 'session', path: 'src/a.ts' } },
        { path: 'src/b.ts', ref: { kind: 'session', path: 'src/b.ts' } },
      ] },
      { kind: 'turnDone', id: 't1', durationMs: 1_200, completed: true },
      { kind: 'user', id: 'u2', text: '第二个任务' },
    ];

    expect(deriveTurns(items, true)).toEqual([
      { id: 'u1', seq: 1, status: 'completed', durationMs: 1_200, authoredPaths: ['src/a.ts', 'src/b.ts'] },
      { id: 'u2', seq: 2, status: 'running', authoredPaths: [] },
    ]);
  });

  it('被停止的一轮标记为 interrupted', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: '任务' },
      { kind: 'assistant', id: 'a1', markdown: '部分回复', streaming: false, interrupted: true },
      { kind: 'turnDone', id: 't1', durationMs: 800, completed: false },
    ];

    expect(deriveTurns(items, false)).toEqual([
      { id: 'u1', seq: 1, status: 'interrupted', durationMs: 800, authoredPaths: [] },
    ]);
  });

  it('还在队列里的消息不单独开一轮', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: '任务' },
      { kind: 'turnDone', id: 't1', durationMs: 100, completed: true },
      { kind: 'user', id: 'u2', text: '排队消息', pending: 'queued' },
    ];

    expect(deriveTurns(items, false).map((turn) => turn.id)).toEqual(['u1']);
  });

  it('历史会话没有 turnDone 时按已完成处理', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: '任务' },
      { kind: 'assistant', id: 'a1', markdown: '回复', streaming: false },
    ];

    expect(deriveTurns(items, false)).toEqual([{ id: 'u1', seq: 1, status: 'completed', authoredPaths: [] }]);
  });

  it('没有用户消息时没有回合', () => {
    expect(deriveTurns([{ kind: 'notice', id: 'n1', level: 'info', text: '提示' }], true)).toEqual([]);
  });
});

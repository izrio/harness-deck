import { describe, expect, it } from 'vitest';
import type { Item } from '@harness-deck/shared';
import { buildThreadRows, rowIsRunning, rowToolCount } from '../src/threadRows.ts';

const edit: Item = { kind: 'activity', id: 'a1', tool: 'edit', variant: 'edit', label: 'src/a.ts', status: 'ok' };
const run: Item = { kind: 'activity', id: 'a2', tool: 'bash', variant: 'command', label: 'bash pnpm test', status: 'ok' };
const explore: Item = { kind: 'explore', id: 'e1', summary: '读取 1 个文件', status: 'ok', entries: [] };
const reasoning: Item = { kind: 'assistant', id: 'r1', markdown: '', reasoning: '先看文件', streaming: false };
const answer: Item = { kind: 'assistant', id: 'm1', markdown: '改好了', streaming: false };

describe('buildThreadRows', () => {
  it('连续的工具操作与仅推理消息合并成一条轨迹行', () => {
    const rows = buildThreadRows([edit, run, explore, reasoning, answer]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a1', grouped: true });
    expect(rows[0]!.items.map((item) => item.id)).toEqual(['a1', 'a2', 'e1', 'r1']);
    expect(rowToolCount(rows[0]!)).toBe(3);
    expect(rows[1]).toMatchObject({ id: 'm1', grouped: false });
  });

  it('单条工具操作与无推理内容的空占位回复不套卡片', () => {
    const emptyAssistant: Item = { kind: 'assistant', id: 'empty-1', markdown: '', streaming: true };
    const rows = buildThreadRows([explore, emptyAssistant, answer]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 'e1', grouped: false });
    expect(rows[1]).toMatchObject({ id: 'empty-1', grouped: false });
    expect(rows[2]).toMatchObject({ id: 'm1', grouped: false });
  });

  it('用户消息、改动卡片、结束行与子代理会断开轨迹', () => {
    const rows = buildThreadRows([
      edit,
      { kind: 'user', id: 'u1', text: '继续' },
      run,
      { kind: 'changes', id: 'c1', turn: 1, source: 'turn', files: [], total: 0 },
      { kind: 'turnDone', id: 't1', durationMs: 1200, completed: true },
      { kind: 'activity', id: 's1', tool: 'subagent', variant: 'subagent', label: '子代理', status: 'ok' },
      { ...run, id: 'a3' },
    ]);
    expect(rows.map((row) => [row.id, row.grouped])).toEqual([
      ['a1', false],
      ['u1', false],
      ['a2', false],
      ['c1', false],
      ['t1', false],
      ['s1', false],
      ['a3', false],
    ]);
  });

  it('运行状态由轨迹内的活动行与流式推理决定', () => {
    const running = buildThreadRows([
      { ...edit, status: 'running' },
      { ...run, status: 'running' },
    ]);
    const done = buildThreadRows([edit, run]);
    const streaming = buildThreadRows([edit, { ...reasoning, streaming: true }]);
    expect(rowIsRunning(running[0]!)).toBe(true);
    expect(rowIsRunning(done[0]!)).toBe(false);
    expect(rowIsRunning(streaming[0]!)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { parseAcpRegistry } from '../src/backend/acpRegistry.ts';

describe('parseAcpRegistry', () => {
  it('接受数组和 { entries } 两种形状', () => {
    expect(parseAcpRegistry([{ id: 'a', name: 'A', command: 'a', args: ['--acp'] }])).toEqual([
      { id: 'a', name: 'A', command: 'a', args: ['--acp'] },
    ]);
    expect(parseAcpRegistry({ entries: [{ id: 'b', name: 'B', command: 'b' }] })).toEqual([
      { id: 'b', name: 'B', command: 'b' },
    ]);
  });

  it('跳过缺字段、重复 id 和非对象条目', () => {
    expect(
      parseAcpRegistry([
        null,
        { id: 'a', name: 'A', command: 'a' },
        { id: 'a', name: 'A2', command: 'a2' },
        { id: 'b', name: 'B' },
        { name: 'C', command: 'c' },
      ]),
    ).toEqual([{ id: 'a', name: 'A', command: 'a' }]);
  });

  it('格式不对或没有有效条目时给出可读错误', () => {
    expect(() => parseAcpRegistry({ nope: [] })).toThrow(/array or \{ entries/u);
    expect(() => parseAcpRegistry([{ id: 'a' }])).toThrow(/no valid entries/u);
  });
});

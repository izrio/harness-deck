import { describe, expect, it } from 'vitest';
import { setLocale } from '../src/i18n.ts';
import { resolveDiffSpec } from '../src/vm/diffSpec.ts';

describe('resolveDiffSpec（跨 IDE 共用的 Diff 解析）', () => {
  it('tool 新建文件时左侧为空虚拟内容，右侧为真实磁盘文件', async () => {
    setLocale('zh');
    const spec = await resolveDiffSpec(
      { kind: 'tool', path: '/repo/src/new.ts', diffs: [], created: true },
      async () => 'export const x = 1;\n',
    );
    expect(spec).toEqual({
      kind: 'pair',
      path: '/repo/src/new.ts',
      title: 'new.ts（新建）',
      left: { kind: 'virtual', path: '/repo/src/new.ts', label: 'empty', content: '' },
      right: { kind: 'disk', path: '/repo/src/new.ts' },
    });
  });

  it('tool 修改文件且当前内容可反向还原时，左侧为还原的修改前内容、右侧为可编辑磁盘文件', async () => {
    setLocale('zh');
    const spec = await resolveDiffSpec(
      {
        kind: 'tool',
        path: '/repo/src/app.ts',
        created: false,
        diffs: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
      },
      async () => 'const a = 2;\n',
    );
    expect(spec).toEqual({
      kind: 'pair',
      path: '/repo/src/app.ts',
      title: 'app.ts（修改前 ↔ 当前）',
      left: { kind: 'virtual', path: '/repo/src/app.ts', label: 'before', content: 'const a = 1;\n' },
      right: { kind: 'disk', path: '/repo/src/app.ts' },
    });
  });

  it('tool 修改后文件又被外部改过导致无法反向还原时，退回 unified patch', async () => {
    const spec = await resolveDiffSpec(
      {
        kind: 'tool',
        path: '/repo/src/app.ts',
        created: false,
        diffs: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
      },
      async () => 'completely different file\n',
    );
    expect(spec.kind).toBe('unified');
    if (spec.kind === 'unified') {
      expect(spec.patchText).toContain('-const a = 1;');
      expect(spec.patchText).toContain('+const a = 2;');
    }
  });

  it('turn 删除文件时两侧均为虚拟只读内容', async () => {
    setLocale('en');
    const spec = await resolveDiffSpec(
      {
        kind: 'turn',
        path: '/repo/old.txt',
        before: true,
        after: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-hello'] }],
      },
      async () => undefined,
    );
    expect(spec).toEqual({
      kind: 'pair',
      path: '/repo/old.txt',
      title: 'old.txt (deleted)',
      left: { kind: 'virtual', path: '/repo/old.txt', label: 'before', content: 'hello' },
      right: { kind: 'virtual', path: '/repo/old.txt', label: 'deleted', content: '' },
    });
  });

  it('proposed 审批前预览能计算出写入后的虚拟右侧，无法预览的工具返回 cannotPreview', async () => {
    setLocale('zh');
    const preview = await resolveDiffSpec(
      {
        kind: 'proposed',
        path: '/repo/readme.md',
        tool: 'write',
        args: { content: '# New Title\n' },
      },
      async () => '# Old Title\n',
    );
    expect(preview).toEqual({
      kind: 'pair',
      path: '/repo/readme.md',
      title: 'readme.md（当前 ↔ 将要写入）',
      left: { kind: 'disk', path: '/repo/readme.md' },
      right: { kind: 'virtual', path: '/repo/readme.md', label: 'proposed', content: '# New Title\n' },
    });

    const invalid = await resolveDiffSpec(
      {
        kind: 'proposed',
        path: '/repo/readme.md',
        tool: 'bash',
        args: { command: 'rm -rf' },
      },
      async () => '# Old Title\n',
    );
    expect(invalid.kind).toBe('cannotPreview');
  });
});

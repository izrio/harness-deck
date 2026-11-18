import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '@harness-deck/shared';
import { EditorContext } from '../src/vm/EditorContext.ts';
import { attachPickedPaths } from '../src/vm/pickedFiles.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hd-picked-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('attachPickedPaths', () => {
  it('把图片文件走 attachImages 发到输入框，把普通文件和文件夹固定到上下文', () => {
    const root = makeTempDir();
    const imgPath = join(root, 'shot.png');
    const docPath = join(root, 'notes.md');
    const folderPath = join(root, 'src');
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(docPath, '# hello');
    mkdirSync(folderPath);

    const editorContext = new EditorContext(
      () => noWorkbench,
      () => true,
      () => root,
    );
    const posted: HostToWebview[] = [];
    const toasts: string[] = [];
    let renders = 0;

    attachPickedPaths([imgPath, docPath, folderPath], editorContext, {
      post: (msg) => posted.push(msg),
      toast: (_level, text) => toasts.push(text),
      scheduleRender: () => {
        renders += 1;
      },
    });

    expect(toasts).toEqual([]);
    expect(renders).toBe(1);
    expect(editorContext.state().pinned.map((p) => p.path)).toEqual(['notes.md', 'src']);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      type: 'attachImages',
      payload: {
        images: [
          {
            mediaType: 'image/png',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            name: 'shot.png',
          },
        ],
      },
    });
    expect(posted[1]).toEqual({ type: 'focusComposer', payload: {} });
  });

  it('扩展名像图片但实际是目录时，当作文件夹固定到上下文', () => {
    const root = makeTempDir();
    const fakeImgDir = join(root, 'assets.png');
    mkdirSync(fakeImgDir);

    const editorContext = new EditorContext(
      () => noWorkbench,
      () => true,
      () => root,
    );
    const posted: HostToWebview[] = [];
    let renders = 0;

    attachPickedPaths([fakeImgDir], editorContext, {
      post: (msg) => posted.push(msg),
      toast: () => undefined,
      scheduleRender: () => {
        renders += 1;
      },
    });

    expect(renders).toBe(1);
    expect(editorContext.state().pinned.map((p) => p.path)).toEqual(['assets.png']);
    expect(posted).toEqual([{ type: 'focusComposer', payload: {} }]);
  });
});

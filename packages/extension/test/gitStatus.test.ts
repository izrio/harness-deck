import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNumstat, parseNumstatZ, parsePorcelainZ, readGitFileAtRef, readGitStatus } from '../src/sourceControl/gitStatus.ts';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-git-'));
  tempDirs.push(dir);
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'a.txt'), 'one\n', 'utf8');
  await git(dir, ['add', 'a.txt']);
  await git(dir, ['commit', '-qm', 'init']);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Git 状态解析', () => {
  it('解析 porcelain -z 的修改、新增、未跟踪与重命名', () => {
    expect(parsePorcelainZ('R  new.txt\0old.txt\0 M a.txt\0?? c.txt\0')).toEqual([
      { path: 'new.txt', status: 'renamed', staged: true },
      { path: 'a.txt', status: 'modified', staged: false },
      { path: 'c.txt', status: 'untracked', staged: false },
    ]);
  });

  it('解析 numstat 并跳过二进制文件', () => {
    expect([...parseNumstat('1\t0\ta.txt\n2\t3\tb.txt\n-\t-\tbin.png\n')]).toEqual([
      ['a.txt', { additions: 1, deletions: 0 }],
      ['b.txt', { additions: 2, deletions: 3 }],
    ]);
  });

  it('解析 numstat -z 的重命名与中文路径', () => {
    expect([...parseNumstatZ('3\t1\t中文 文件.txt\x002\t0\t\x00old.txt\x00new.txt\x00-\t-\timg.png\x00')]).toEqual([
      ['中文 文件.txt', { additions: 3, deletions: 1 }],
      ['new.txt', { additions: 2, deletions: 0 }],
    ]);
  });
});

describe('readGitStatus', () => {
  it('读取分支、暂存与未暂存改动（含中文文件名与 HEAD 内容）', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n', 'utf8');
    await writeFile(join(dir, '说明.txt'), '第一行\n', 'utf8');
    await git(dir, ['add', '说明.txt']);

    const state = await readGitStatus(dir, { checkGh: false });
    expect(state.available).toBe(true);
    expect(state.branch).toBeTruthy();
    expect(state.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '说明.txt', status: 'added', staged: true, additions: 1, deletions: 0 }),
        expect.objectContaining({ path: 'a.txt', status: 'modified', staged: false, additions: 1, deletions: 0 }),
      ]),
    );
    expect(state.additions).toBe(2);
    expect(state.deletions).toBe(0);
    expect(await readGitFileAtRef(dir, 'a.txt', 'HEAD')).toBe('one\n');
    expect(await readGitFileAtRef(dir, '说明.txt', 'HEAD')).toBeUndefined();
  });

  it('非 Git 目录返回 available: false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-no-git-'));
    tempDirs.push(dir);
    const state = await readGitStatus(dir);
    expect(state.available).toBe(false);
    expect(state.files).toEqual([]);
  });
});

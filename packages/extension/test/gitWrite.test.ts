import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAll, createPullRequest, pushCurrentBranch } from '../src/sourceControl/gitWrite.ts';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
  return stdout;
}

async function makeRepoWithRemote(): Promise<{ repo: string; remote: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-git-write-'));
  tempDirs.push(dir);
  const remote = join(dir, 'remote.git');
  await execFileAsync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'a.txt'), 'one\n', 'utf8');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-qm', 'init']);
  await git(repo, ['remote', 'add', 'origin', remote]);
  return { repo, remote };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Git 写操作', () => {
  it('提交全部改动并推送到远程', async () => {
    const { repo, remote } = await makeRepoWithRemote();

    expect(await pushCurrentBranch(repo)).toEqual({ ok: true });
    expect((await git(remote, ['log', '--oneline'])).trim()).toContain('init');

    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
    await writeFile(join(repo, 'b.txt'), 'new\n', 'utf8');
    expect(await commitAll(repo, 'add b and update a')).toEqual({ ok: true });
    expect((await git(repo, ['log', '-1', '--pretty=%s'])).trim()).toBe('add b and update a');
    expect(await pushCurrentBranch(repo)).toEqual({ ok: true });

    const files = (await git(repo, ['ls-tree', '--name-only', 'HEAD'])).trim().split('\n');
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
  });

  it('拒绝空提交信息与空 PR 标题', async () => {
    const { repo } = await makeRepoWithRemote();
    expect(await commitAll(repo, '   ')).toEqual({ ok: false, message: 'commit message is empty' });
    expect(await createPullRequest(repo, '', '')).toEqual({ ok: false, message: 'PR title is empty' });
  });

  it('stageAll 为 false 时仅提交已暂存文件，保留未暂存与未跟踪文件', async () => {
    const { repo } = await makeRepoWithRemote();
    await writeFile(join(repo, 'staged.txt'), 'staged\n', 'utf8');
    await writeFile(join(repo, 'untracked.txt'), 'stay\n', 'utf8');
    await git(repo, ['add', 'staged.txt']);

    expect(await commitAll(repo, 'only staged', { stageAll: false })).toEqual({ ok: true });
    const committed = (await git(repo, ['ls-tree', '--name-only', 'HEAD'])).trim().split('\n');
    expect(committed).toContain('staged.txt');
    expect(committed).not.toContain('untracked.txt');
  });
});

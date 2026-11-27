import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGitLogOutput, parseRefDecorations, readGitCommitDetail, readGitLog } from '../src/sourceControl/gitLog.ts';
import {
  applyStash,
  dropStash,
  listStashes,
  popStash,
  readStashFileDiffContents,
  readStashFiles,
  saveStash,
} from '../src/sourceControl/gitStash.ts';
import { readGitStatus } from '../src/sourceControl/gitStatus.ts';
import {
  abortGitOperation,
  cherryPickCommit,
  commitAll,
  continueGitOperation,
  createBranch,
  mergeBranch,
  renameBranch,
  resetToCommit,
  resolveConflictFile,
  revertCommit,
} from '../src/sourceControl/gitWrite.ts';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
  return stdout;
}

async function makeRepo(): Promise<{ repo: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hd-git-idea-'));
  tempDirs.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  await execFileAsync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
  await mkdir(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'dev@example.com']);
  await git(repo, ['config', 'user.name', 'Halo Dev']);
  await writeFile(join(repo, 'base.txt'), 'line1\n', 'utf8');
  await git(repo, ['add', 'base.txt']);
  await git(repo, ['commit', '-qm', 'initial commit']);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['push', '-qu', 'origin', 'main']);
  return { repo, remote };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Git 重构后端能力：日志图谱、分支/标签元数据、贮藏、勾选提交与冲突处理', () => {
  it('parseRefDecorations 正确识别 HEAD、本地分支、远程分支与标签', () => {
    expect(parseRefDecorations('HEAD -> main, tag: v1.0.0, origin/main, origin/HEAD, feat/ui')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'local' },
      { name: 'v1.0.0', kind: 'tag' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'feat/ui', kind: 'local' },
    ]);
    expect(
      parseRefDecorations(
        'HEAD -> refs/heads/feat/ui, tag: refs/tags/v2.0.0, refs/remotes/fork/main, refs/remotes/fork/HEAD, refs/stash',
      ),
    ).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'feat/ui', kind: 'local' },
      { name: 'v2.0.0', kind: 'tag' },
      { name: 'fork/main', kind: 'remote' },
    ]);
  });

  it('IDEA 风格按勾选文件提交（含未跟踪文件）与 Amend 修改上次提交，且不影响未勾选文件', async () => {
    const { repo } = await makeRepo();
    await writeFile(join(repo, 'base.txt'), 'line1\nline2\n', 'utf8');
    await writeFile(join(repo, 'keep-dirty.txt'), 'do not commit yet\n', 'utf8');
    await writeFile(join(repo, 'selected-new.txt'), 'commit me\n', 'utf8');

    const res = await commitAll(repo, 'partial IDEA commit', {
      files: ['base.txt', 'selected-new.txt'],
    });
    expect(res).toEqual({ ok: true });

    // 验证只有勾选的两个文件被提交，未勾选文件仍保留在工作区
    const status = await readGitStatus(repo, { checkGh: false });
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.lastCommitMessage).toBe('partial IDEA commit');
    expect(status.files.map((f) => f.path)).toEqual(['keep-dirty.txt']);

    // Amend 修改最近一次提交信息
    const amendRes = await commitAll(repo, 'amended commit message', { amend: true, stageAll: false });
    expect(amendRes).toEqual({ ok: true });
    expect((await git(repo, ['log', '-1', '--pretty=%s'])).trim()).toBe('amended commit message');
  });

  it('readGitLog 与 readGitCommitDetail 支持多分支图谱、搜索筛选、分页及单提交文件详情', async () => {
    const { repo } = await makeRepo();
    await git(repo, ['tag', 'v0.1.0']);
    expect(await createBranch(repo, 'feat/graph')).toEqual({ ok: true });
    await writeFile(join(repo, 'feature.ts'), 'export const x = 1;\n', 'utf8');
    expect(await commitAll(repo, 'feat: add DAG graph')).toEqual({ ok: true });
    const featHash = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    await git(repo, ['checkout', 'main']);
    await writeFile(join(repo, 'main.txt'), 'main work\n', 'utf8');
    expect(await commitAll(repo, 'chore: main update')).toEqual({ ok: true });

    // 合并 feat/graph 到 main 形成双父节点提交
    expect(await mergeBranch(repo, 'feat/graph')).toEqual({ ok: true });

    const { commits, hasMore } = await readGitLog(repo, { limit: 2, skip: 0 });
    expect(commits).toHaveLength(2);
    expect(hasMore).toBe(true);
    // 顶部合并提交有两个父提交
    expect(commits[0]!.parents).toHaveLength(2);

    // 关键字搜索命中 feat 提交
    const searched = await readGitLog(repo, { query: 'DAG graph' });
    expect(searched.commits).toHaveLength(1);
    expect(searched.commits[0]!.hash).toBe(featHash);

    // 提交详情包含新增文件与统计
    const detail = await readGitCommitDetail(repo, featHash);
    expect(detail?.subject).toBe('feat: add DAG graph');
    expect(detail?.files).toEqual([
      expect.objectContaining({ path: 'feature.ts', status: 'added', additions: 1, deletions: 0 }),
    ]);

    // readGitStatus 返回本地/远程分支与标签元数据
    const status = await readGitStatus(repo, { checkGh: false });
    expect(status.branches).toEqual(expect.arrayContaining(['main', 'feat/graph']));
    expect(status.remoteBranches).toContain('origin/main');
    expect(status.tags).toContain('v0.1.0');
    expect(status.branchDetails?.some((b) => b.kind === 'tag' && b.name === 'v0.1.0')).toBe(true);
  });

  it('Stash 完整生命周期：保存（含未跟踪文件）、查看文件与 Diff 内容、Apply / Pop / Drop', async () => {
    const { repo } = await makeRepo();
    await writeFile(join(repo, 'base.txt'), 'line1\nstashed edit\n', 'utf8');
    await writeFile(join(repo, 'draft.txt'), 'brand new draft\n', 'utf8');

    expect(await saveStash(repo, { message: 'wip ui refactor', includeUntracked: true })).toEqual({ ok: true });
    const stashes = await listStashes(repo);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toMatchObject({ index: 0, ref: 'stash@{0}', branch: 'main', message: 'wip ui refactor' });

    const files = await readStashFiles(repo, 0);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['base.txt', 'draft.txt']));

    const trackedDiff = await readStashFileDiffContents(repo, 0, 'base.txt');
    expect(trackedDiff.before).toBe('line1\n');
    expect(trackedDiff.after).toContain('stashed edit');

    const untrackedDiff = await readStashFileDiffContents(repo, 0, 'draft.txt');
    expect(untrackedDiff.before).toBeUndefined();
    expect(untrackedDiff.after).toBe('brand new draft\n');

    expect(await applyStash(repo, 0)).toEqual({ ok: true });
    expect(await readFile(join(repo, 'draft.txt'), 'utf8')).toBe('brand new draft\n');
    expect(await dropStash(repo, 0)).toEqual({ ok: true });
    expect(await listStashes(repo)).toHaveLength(0);

    // 再次保存后测试 pop
    expect(await saveStash(repo, { message: 'for pop', includeUntracked: true })).toEqual({ ok: true });
    expect(await popStash(repo, 0)).toEqual({ ok: true });
    expect(await listStashes(repo)).toHaveLength(0);
    expect(await readFile(join(repo, 'base.txt'), 'utf8')).toContain('stashed edit');
  });

  it('支持分支重命名、基于提交新建分支、Cherry-pick、Revert、Reset 与合并冲突解决', async () => {
    const { repo } = await makeRepo();
    const initHash = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    expect(await createBranch(repo, 'side', initHash)).toEqual({ ok: true });
    await writeFile(join(repo, 'base.txt'), 'side change\n', 'utf8');
    expect(await commitAll(repo, 'side commit')).toEqual({ ok: true });
    const sideHash = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    // 重命名分支
    expect(await renameBranch(repo, 'side', 'side-renamed')).toEqual({ ok: true });
    expect((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('side-renamed');

    // 切回 main 制造冲突
    await git(repo, ['checkout', 'main']);
    await writeFile(join(repo, 'base.txt'), 'main change\n', 'utf8');
    expect(await commitAll(repo, 'main conflicting commit')).toEqual({ ok: true });

    const mergeRes = await mergeBranch(repo, 'side-renamed');
    expect(mergeRes.ok).toBe(false);

    // 检测进行中 merge 与冲突文件
    const conflictState = await readGitStatus(repo, { checkGh: false });
    expect(conflictState.inProgressOp).toBe('merge');
    expect(conflictState.files).toContainEqual(expect.objectContaining({ path: 'base.txt', status: 'conflicted' }));

    // 采用对方版本并继续完成合并
    expect(await resolveConflictFile(repo, 'base.txt', 'theirs')).toEqual({ ok: true });
    expect(await continueGitOperation(repo, 'merge')).toEqual({ ok: true });
    expect(await readFile(join(repo, 'base.txt'), 'utf8')).toBe('side change\n');

    // Revert 与 Reset（soft）
    const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(repo, 'extra.txt'), 'extra\n', 'utf8');
    expect(await commitAll(repo, 'extra commit')).toEqual({ ok: true });
    const extraHash = (await git(repo, ['rev-parse', 'HEAD'])).trim();

    expect(await revertCommit(repo, extraHash)).toEqual({ ok: true });
    expect(await resetToCommit(repo, headBefore, 'soft')).toEqual({ ok: true });
    expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore);

    // 新建分支并 cherry-pick
    expect(await createBranch(repo, 'pick-target', initHash)).toEqual({ ok: true });
    expect(await cherryPickCommit(repo, sideHash)).toEqual({ ok: true });
    expect(await readFile(join(repo, 'base.txt'), 'utf8')).toBe('side change\n');

    // 验证 abortGitOperation 在无进行中操作时返回清晰错误
    expect(await abortGitOperation(repo)).toEqual({ ok: false, message: 'no operation in progress' });
    expect(parseGitLogOutput('')).toEqual([]);
  });
});

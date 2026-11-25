import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listLocalBranches, parseGhPrViewJson } from '../src/sourceControl/gitStatus.ts';
import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  discardFile,
  stageFile,
  unstageFile,
} from '../src/sourceControl/gitWrite.ts';
import {
  buildHeuristicCommitMessage,
  buildHeuristicPrDraft,
  generateCommitMessage,
} from '../src/sourceControl/gitDraftGenerator.ts';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-git-write-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await writeFile(join(dir, 'index.ts'), 'export const a = 1;\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Granular Git actions, PR parsing, and AI/heuristic draft generation (P0-2 / P1-7)', () => {
  it('stages, unstages, discards files and switches/creates branches', async () => {
    const repo = await initRepo();
    await writeFile(join(repo, 'index.ts'), 'export const a = 2;\n', 'utf8');

    expect((await stageFile(repo, 'index.ts')).ok).toBe(true);
    expect((await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout.trim()).toBe('index.ts');

    expect((await unstageFile(repo, 'index.ts')).ok).toBe(true);
    expect((await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout.trim()).toBe('');

    expect((await discardFile(repo, 'index.ts', false)).ok).toBe(true);
    expect(await readFile(join(repo, 'index.ts'), 'utf8')).toBe('export const a = 1;\n');

    const initialBranches = await listLocalBranches(repo);
    expect(initialBranches.length).toBeGreaterThanOrEqual(1);
    const mainBranch = initialBranches[0]!;

    expect((await createBranch(repo, 'feat/demo')).ok).toBe(true);
    expect(await listLocalBranches(repo)).toContain('feat/demo');
    expect((await checkoutBranch(repo, mainBranch)).ok).toBe(true);
  });

  it('deletes merged branches with -d, guards current branch, and supports force -D for unmerged branches', async () => {
    const repo = await initRepo();
    const mainBranch = (await listLocalBranches(repo))[0]!;

    // 禁止删除当前检出的分支与非法分支名
    expect(await deleteBranch(repo, mainBranch)).toEqual({ ok: false, message: 'cannot delete current branch' });
    expect(await deleteBranch(repo, '-D')).toEqual({ ok: false, message: 'invalid branch name' });

    // 已合并分支可通过默认 -d 删除
    expect((await createBranch(repo, 'feat/merged')).ok).toBe(true);
    expect((await checkoutBranch(repo, mainBranch)).ok).toBe(true);
    expect((await deleteBranch(repo, 'feat/merged')).ok).toBe(true);
    expect(await listLocalBranches(repo)).not.toContain('feat/merged');

    // 未合并分支默认 -d 失败，显式 force: true 时通过 -D 删除
    expect((await createBranch(repo, 'feat/unmerged')).ok).toBe(true);
    await writeFile(join(repo, 'feature.ts'), 'export const f = 1;\n', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'feat commit'], { cwd: repo });
    expect((await checkoutBranch(repo, mainBranch)).ok).toBe(true);

    const safeResult = await deleteBranch(repo, 'feat/unmerged');
    expect(safeResult.ok).toBe(false);
    expect(await listLocalBranches(repo)).toContain('feat/unmerged');

    const forceResult = await deleteBranch(repo, 'feat/unmerged', { force: true });
    expect(forceResult.ok).toBe(true);
    expect(await listLocalBranches(repo)).not.toContain('feat/unmerged');
  });

  it('parses gh pr view JSON with statusCheckRollup accurately', () => {
    const parsed = parseGhPrViewJson(
      JSON.stringify({
        number: 42,
        title: 'Add terminal tab',
        url: 'https://github.com/org/repo/pull/42',
        state: 'MERGED',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [
          { conclusion: 'SUCCESS', status: 'COMPLETED' },
          { conclusion: 'FAILURE', status: 'COMPLETED' },
          { conclusion: '', status: 'IN_PROGRESS' },
        ],
      }),
    );
    expect(parsed).toEqual({
      number: 42,
      title: 'Add terminal tab',
      url: 'https://github.com/org/repo/pull/42',
      state: 'MERGED',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      checks: { total: 3, passed: 1, failed: 1, pending: 1 },
    });
  });

  it('generates heuristic and direct-provider AI commit messages & PR drafts', async () => {
    const repo = await initRepo();
    await writeFile(join(repo, 'index.ts'), 'export const a = 99;\n', 'utf8');

    const heuristic = buildHeuristicCommitMessage([{ path: 'packages/webview-ui/src/App.tsx', status: 'modified', staged: false }], 'zh');
    expect(heuristic).toContain('feat(webview-ui):');

    const prDraft = buildHeuristicPrDraft(
      [{ path: 'index.ts', status: 'modified', staged: false }],
      'feat/my-pr',
      ['feat: update index'],
      'en',
    );
    expect(prDraft.title).toBe('feat: update index');
    expect(prDraft.body).toContain('index.ts');

    const aiResult = await generateCommitMessage(repo, {
      locale: 'en',
      provider: {
        apiKey: 'sk-test',
        provider: {
          id: 'p1',
          name: 'Test',
          openaiChatUrl: 'https://api.example.com/v1',
          models: [{ id: 'gpt-4o-mini' }],
          defaultModel: 'gpt-4o-mini',
          boundBackendIds: [],
        },
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'feat: update constant a to 99' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(aiResult).toEqual({ message: 'feat: update constant a to 99', source: 'ai' });
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectsState,
  createProjectWorktree,
  parseProjectConfigs,
  parseRecentProjects,
  recordRecentProject,
  removeRecentProjectFromList,
  updateProjectConfigsMap,
} from '../src/projects/ProjectService.ts';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('ProjectService', () => {
  it('管理最近使用项目列表并保留顺序和上限', () => {
    let list = recordRecentProject([], '/repo/a', 100);
    list = recordRecentProject(list, '/repo/b', 200);
    list = recordRecentProject(list, '/repo/a', 300);
    expect(list.map((p) => p.path)).toEqual(['/repo/a', '/repo/b']);

    const parsed = parseRecentProjects(list);
    expect(parsed[0]?.name).toBe('a');

    const state = buildProjectsState({ currentPath: '/repo/a', recent: parsed, configs: {} });
    expect(state.recent[0]?.isCurrent).toBe(true);
    expect(state.recent[1]?.isCurrent).toBeUndefined();

    expect(removeRecentProjectFromList(list, '/repo/a').map((p) => p.path)).toEqual(['/repo/b']);
  });

  it('解析并更新项目的 Worktree 复制文件、准备和验收命令配置', () => {
    const configs = parseProjectConfigs({
      '/repo/a': {
        copyFiles: [' .env ', '.env', ''],
        setupCommands: ['pnpm install'],
        verifyCommands: ['pnpm test', 'pnpm typecheck'],
      },
    });
    expect(configs['/repo/a']).toEqual({
      copyFiles: ['.env'],
      setupCommands: ['pnpm install'],
      verifyCommands: ['pnpm test', 'pnpm typecheck'],
    });

    const cleared = updateProjectConfigsMap(configs, '/repo/a', {
      copyFiles: [],
      setupCommands: [],
      verifyCommands: [],
    });
    expect(cleared['/repo/a']).toBeUndefined();
  });

  it('创建 git worktree 时复制指定文件并执行准备命令', async () => {
    const base = await mkdtemp(join(tmpdir(), 'hd-wt-'));
    tempDirs.push(base);
    const repo = join(base, 'demo-repo');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# Demo\n');
    await writeFile(join(repo, '.env.local'), 'SECRET=42\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

    const res = await createProjectWorktree({
      repoPath: repo,
      branch: 'feat/test-wt',
      config: {
        copyFiles: ['.env.local', 'missing.txt'],
        setupCommands: ['node -e "require(\'fs\').writeFileSync(\'.setup-ok\', \'yes\')"'],
        verifyCommands: ['pnpm test'],
      },
    });

    expect(res.copiedFiles).toEqual(['.env.local']);
    expect(res.skippedFiles).toEqual(['missing.txt']);
    expect(await readFile(join(res.worktreePath, '.env.local'), 'utf8')).toBe('SECRET=42\n');
    expect(await readFile(join(res.worktreePath, '.setup-ok'), 'utf8')).toBe('yes');

    // 拒绝以 - 开头的非法分支名（防止 git 参数注入）
    await expect(
      createProjectWorktree({
        repoPath: repo,
        branch: '--detach',
        config: { copyFiles: [], setupCommands: [], verifyCommands: [] },
      }),
    ).rejects.toThrow(/Invalid branch name/u);
  });
});

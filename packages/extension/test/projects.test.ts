import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectsState,
  createProjectWorktree,
  disambiguateProjectNames,
  isPathInsideProject,
  normalizeProjectPath,
  parseProjectConfigs,
  parseRecentProjects,
  recordRecentProject,
  removeRecentProjectFromList,
  resolveEnclosingProjectPath,
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

  it('归一化路径、判断子目录归属并按最长前缀归并到已知父项目', () => {
    expect(normalizeProjectPath('  /repo/alpha/  ')).toBe('/repo/alpha');
    expect(normalizeProjectPath('/repo/alpha/./sub/../')).toBe('/repo/alpha');
    expect(normalizeProjectPath('///')).toBe('/');
    expect(normalizeProjectPath('c:/work/demo/')).toBe('C:\\work\\demo');
    expect(normalizeProjectPath('c:\\')).toBe('C:\\');

    expect(isPathInsideProject('/repo/alpha/', '/repo/alpha')).toBe(true);
    expect(isPathInsideProject('/repo/alpha', '/repo/alpha/packages/ext')).toBe(true);
    // 兄弟目录 / worktree 不能被误判为子目录
    expect(isPathInsideProject('/repo/alpha', '/repo/alpha-wt')).toBe(false);
    expect(isPathInsideProject('C:\\Work\\App', 'c:/work/app/src')).toBe(true);

    const known = ['/repo/alpha', '/repo/alpha/packages/ui', '/repo/beta'];
    expect(resolveEnclosingProjectPath('/repo/alpha/packages/ui/src', known)).toBe('/repo/alpha/packages/ui');
    expect(resolveEnclosingProjectPath('/repo/alpha/packages/core', known)).toBe('/repo/alpha');
    expect(resolveEnclosingProjectPath('/tmp/random-dir', known)).toBeUndefined();
  });

  it('对重名项目自动补充父级目录消歧，非重名项目保持原名', () => {
    const names = disambiguateProjectNames([
      { projectPath: '/work/client-a/app', baseName: 'app' },
      { projectPath: '/work/client-b/app', baseName: 'app' },
      { projectPath: '/work/solo', baseName: 'solo' },
    ]);
    expect(names.get('/work/client-a/app')).toBe('client-a/app');
    expect(names.get('/work/client-b/app')).toBe('client-b/app');
    expect(names.get('/work/solo')).toBe('solo');
  });
});

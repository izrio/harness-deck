/**
 * 项目与 Worktree 配置管理：
 * - 维护最近使用的项目列表（保存在 globalState）
 * - 读写每个项目新建 Worktree 时复制的文件、准备命令与验收命令（保存在 harnessDeck.projects）
 * - 创建 git worktree、复制文件并执行准备命令
 */
import { execFile, spawn } from 'node:child_process';
import { cp, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectsState, RecentProject, WorktreeProjectConfig } from '@harness-deck/shared';
import { LineSplitter, stopRuntime, trackChild } from '../runtime/launch.ts';

const execFileAsync = promisify(execFile);

const MAX_RECENT_PROJECTS = 20;

export const EMPTY_WORKTREE_CONFIG: WorktreeProjectConfig = {
  copyFiles: [],
  setupCommands: [],
  verifyCommands: [],
};

/** 归一化字符串列表：去空白、去重、保序。 */
export function cleanStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** 从配置中解析所有项目的 Worktree 设置。 */
export function parseProjectConfigs(raw: unknown): Record<string, WorktreeProjectConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, WorktreeProjectConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const projectPath = key.trim();
    if (!projectPath || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    result[projectPath] = {
      copyFiles: cleanStringList(obj.copyFiles),
      setupCommands: cleanStringList(obj.setupCommands),
      verifyCommands: cleanStringList(obj.verifyCommands),
    };
  }
  return result;
}

/** 解析 globalState 里的最近项目列表。 */
export function parseRecentProjects(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<RecentProject>;
    if (typeof rec.path !== 'string' || !rec.path.trim()) continue;
    const projectPath = rec.path.trim();
    if (seen.has(projectPath)) continue;
    seen.add(projectPath);
    out.push({
      path: projectPath,
      name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : basename(projectPath),
      lastOpenedAt: typeof rec.lastOpenedAt === 'number' && Number.isFinite(rec.lastOpenedAt) ? rec.lastOpenedAt : 0,
    });
  }
  return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, MAX_RECENT_PROJECTS);
}

/** 记录或置顶一个最近使用的项目。 */
export function recordRecentProject(existing: readonly RecentProject[], projectPath: string, now = Date.now()): RecentProject[] {
  const normalized = projectPath.trim();
  if (!normalized) return [...existing];
  const filtered = existing.filter((p) => p.path !== normalized);
  const next: RecentProject = {
    path: normalized,
    name: basename(normalized) || normalized,
    lastOpenedAt: now,
  };
  return [next, ...filtered].slice(0, MAX_RECENT_PROJECTS);
}

/** 从最近项目中移除指定路径。 */
export function removeRecentProjectFromList(existing: readonly RecentProject[], projectPath: string): RecentProject[] {
  return existing.filter((p) => p.path !== projectPath);
}

/** 构建推送给 Webview 的项目视图状态。 */
export function buildProjectsState(params: {
  readonly currentPath?: string;
  readonly recent: readonly RecentProject[];
  readonly configs: Readonly<Record<string, WorktreeProjectConfig>>;
}): ProjectsState {
  const recent = params.recent.map((item) => ({
    ...item,
    ...(params.currentPath && item.path === params.currentPath ? { isCurrent: true } : {}),
  }));
  return {
    ...(params.currentPath ? { currentPath: params.currentPath } : {}),
    recent,
    configs: params.configs,
  };
}

/** 更新单个项目的 Worktree 配置（三项全空时删除该条目以保持配置整洁）。 */
export function updateProjectConfigsMap(
  current: Readonly<Record<string, WorktreeProjectConfig>>,
  projectPath: string,
  config: WorktreeProjectConfig,
): Record<string, WorktreeProjectConfig> {
  const next: Record<string, WorktreeProjectConfig> = { ...current };
  const cleaned: WorktreeProjectConfig = {
    copyFiles: cleanStringList(config.copyFiles),
    setupCommands: cleanStringList(config.setupCommands),
    verifyCommands: cleanStringList(config.verifyCommands),
  };
  if (cleaned.copyFiles.length === 0 && cleaned.setupCommands.length === 0 && cleaned.verifyCommands.length === 0) {
    delete next[projectPath];
  } else {
    next[projectPath] = cleaned;
  }
  return next;
}

export interface CreateWorktreeResult {
  readonly worktreePath: string;
  readonly branch: string;
  readonly copiedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
}

const SETUP_COMMAND_TIMEOUT_MS = 300_000;

/**
 * 在主仓库旁创建 git worktree，复制配置的文件并执行准备命令。
 */
export async function createProjectWorktree(params: {
  readonly repoPath: string;
  readonly branch?: string;
  readonly config: WorktreeProjectConfig;
  readonly log?: (line: string) => void;
}): Promise<CreateWorktreeResult> {
  const repoPath = resolve(params.repoPath);
  const realRepo = await realpath(repoPath).catch(() => repoPath);
  const branch = params.branch?.trim() || `wt-${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}`;
  if (branch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  await execFileAsync('git', ['check-ref-format', '--branch', branch], { cwd: repoPath });

  const safeSuffix = branch.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'worktree';
  const worktreePath = join(dirname(repoPath), `${basename(repoPath)}-${safeSuffix}`);

  const branchExists = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })
    .then(() => true)
    .catch(() => false);
  const wtArgs = branchExists
    ? ['worktree', 'add', '--', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, '--', worktreePath];
  await execFileAsync('git', wtArgs, { cwd: repoPath });
  params.log?.(`已创建 git worktree：${worktreePath} (${branch})`);

  const realWorktree = await realpath(worktreePath).catch(() => worktreePath);
  const copiedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const rel of params.config.copyFiles) {
    const src = resolve(repoPath, rel);
    const dst = resolve(worktreePath, rel);
    if (!isInsideDir(repoPath, src) || !isInsideDir(worktreePath, dst)) {
      skippedFiles.push(rel);
      continue;
    }
    try {
      const linkInfo = await lstat(src);
      const realSrc = await realpath(src);
      if (linkInfo.isSymbolicLink() && !isInsideDir(realRepo, realSrc)) {
        skippedFiles.push(rel);
        continue;
      }
      await stat(src);
      await mkdir(dirname(dst), { recursive: true });
      const realDstParent = await realpath(dirname(dst));
      if (realDstParent !== realWorktree && !isInsideDir(realWorktree, realDstParent)) {
        skippedFiles.push(rel);
        continue;
      }
      await cp(src, dst, { recursive: true, dereference: false });
      copiedFiles.push(rel);
    } catch {
      skippedFiles.push(rel);
    }
  }

  for (const cmd of params.config.setupCommands) {
    params.log?.(`执行准备命令 (${worktreePath})：${cmd}`);
    await runShellCommand(cmd, worktreePath, params.log);
  }

  return { worktreePath, branch, copiedFiles, skippedFiles };
}

function isInsideDir(root: string, target: string): boolean {
  const normRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const rel = relative(normRoot, normTarget);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function runShellCommand(command: string, cwd: string, log?: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    trackChild(child);

    const errTail: string[] = [];
    const stdout = new LineSplitter((line) => {
      if (line.trim()) log?.(`[setup] ${line}`);
    });
    const stderr = new LineSplitter((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      errTail.push(trimmed);
      if (errTail.length > 25) errTail.shift();
      log?.(`[setup:err] ${trimmed}`);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopRuntime(child, 2_000);
      rejectPromise(new Error(`Setup command timed out: ${command}`));
    }, SETUP_COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.once('exit', (code) => {
      stdout.flush();
      stderr.flush();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Command failed (${code}): ${command}${errTail.length ? `\n${errTail.join('\n')}` : ''}`));
    });
  });
}

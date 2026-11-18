/**
 * 项目与 Worktree 配置管理：
 * - 维护最近使用的项目列表（保存在 globalState）
 * - 读写每个项目新建 Worktree 时复制的文件、准备命令与验收命令（保存在 harnessDeck.projects）
 * - 创建 git worktree、复制文件并执行准备命令
 */
import { execFile, spawn } from 'node:child_process';
import { cp, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectsState, RecentProject, WorktreeProjectConfig } from '@harness-deck/shared';
import { LineSplitter, stopRuntime, trackChild } from '../runtime/launch.ts';

const execFileAsync = promisify(execFile);

const MAX_RECENT_PROJECTS = 20;
const WINDOWS_DRIVE_RE = /^([a-zA-Z]):(?:([\\/])(.*))?$/u;
const UNC_PATH_RE = /^\\\\([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/u;

function normalizeSegments(rest: string): string[] {
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

function isWindowsStylePath(pathValue: string): boolean {
  return WINDOWS_DRIVE_RE.test(pathValue) || pathValue.startsWith('\\\\');
}

function splitPathParts(pathValue: string): string[] {
  return pathValue.split(/[\\/]+/u).filter(Boolean);
}

/** 跨平台提取路径最后一段目录名（兼容 `/` 与 `\`）。 */
export function projectBaseName(pathValue: string): string {
  const parts = splitPathParts(pathValue);
  return parts[parts.length - 1] ?? pathValue;
}

/** 跨平台安全地归一化项目路径：去除尾部多余斜杠与 `.` / `..`，统一 Windows 盘符大小写与分隔符。 */
export function normalizeProjectPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const unc = UNC_PATH_RE.exec(trimmed);
  if (unc) {
    const server = unc[1]!;
    const share = unc[2]!;
    const normRest = normalizeSegments((unc[3] ?? '').replace(/\\/gu, '/'));
    return normRest.length > 0 ? `\\\\${server}\\${share}\\${normRest.join('\\')}` : `\\\\${server}\\${share}`;
  }

  const drive = WINDOWS_DRIVE_RE.exec(trimmed);
  if (drive) {
    const letter = drive[1]!.toUpperCase();
    const normRest = normalizeSegments((drive[3] ?? '').replace(/\\/gu, '/'));
    return normRest.length > 0 ? `${letter}:\\${normRest.join('\\')}` : `${letter}:\\`;
  }

  if (trimmed.startsWith('/')) {
    const normalized = posix.normalize(trimmed.replace(/\\/gu, '/'));
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  }

  const normalized = posix.normalize(trimmed.replace(/\\/gu, '/'));
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** 判断 candidatePath 是否等于 projectRoot 或位于其子目录下（不误匹配 worktree 兄弟目录）。 */
export function isPathInsideProject(projectRoot: string, candidatePath: string): boolean {
  const root = normalizeProjectPath(projectRoot);
  const candidate = normalizeProjectPath(candidatePath);
  if (!root || !candidate) return false;

  const caseInsensitive = process.platform === 'win32' || isWindowsStylePath(root) || isWindowsStylePath(candidate);
  const normRoot = caseInsensitive ? root.toLowerCase() : root;
  const normCand = caseInsensitive ? candidate.toLowerCase() : candidate;

  if (normRoot === normCand) return true;
  if (normRoot === '/') return normCand.startsWith('/');
  if (normRoot.endsWith('\\') || normRoot.endsWith('/')) {
    return normCand.startsWith(normRoot);
  }
  return normCand.startsWith(`${normRoot}/`) || normCand.startsWith(`${normRoot}\\`);
}

/** 从已知项目集合中找出包含 candidatePath 的最具体（最长前缀）父项目路径。 */
export function resolveEnclosingProjectPath(
  candidatePath: string,
  knownProjectPaths: Iterable<string>,
): string | undefined {
  const candidate = normalizeProjectPath(candidatePath);
  if (!candidate) return undefined;

  let best: string | undefined;
  for (const rawKnown of knownProjectPaths) {
    const known = normalizeProjectPath(rawKnown);
    if (!known) continue;
    if (!isPathInsideProject(known, candidate)) continue;
    if (!best || known.length > best.length) {
      best = known;
    }
  }
  return best;
}

/** 对重名项目自动补充父级目录名进行消歧，无重名时保持原名不变。 */
export function disambiguateProjectNames(
  entries: readonly { readonly projectPath: string; readonly baseName: string }[],
): Map<string, string> {
  const countByName = new Map<string, number>();
  for (const entry of entries) {
    countByName.set(entry.baseName, (countByName.get(entry.baseName) ?? 0) + 1);
  }

  const preliminary = new Map<string, string>();
  const candidateCount = new Map<string, number>();

  for (const entry of entries) {
    const isDuplicate = (countByName.get(entry.baseName) ?? 0) > 1;
    if (!isDuplicate) {
      preliminary.set(entry.projectPath, entry.baseName);
      continue;
    }
    const parts = splitPathParts(normalizeProjectPath(entry.projectPath));
    const parent = parts.length >= 2 ? parts[parts.length - 2] : undefined;
    const candidate = parent ? `${parent}/${entry.baseName}` : entry.projectPath;
    preliminary.set(entry.projectPath, candidate);
    candidateCount.set(candidate, (candidateCount.get(candidate) ?? 0) + 1);
  }

  const result = new Map<string, string>();
  for (const entry of entries) {
    const candidate = preliminary.get(entry.projectPath) ?? entry.baseName;
    if ((countByName.get(entry.baseName) ?? 0) > 1 && (candidateCount.get(candidate) ?? 0) > 1) {
      result.set(entry.projectPath, entry.projectPath);
    } else {
      result.set(entry.projectPath, candidate);
    }
  }
  return result;
}

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
    const projectPath = normalizeProjectPath(key);
    if (!projectPath || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const existing = result[projectPath];
    result[projectPath] = {
      copyFiles: cleanStringList([...(existing?.copyFiles ?? []), ...(Array.isArray(obj.copyFiles) ? obj.copyFiles : [])]),
      setupCommands: cleanStringList([...(existing?.setupCommands ?? []), ...(Array.isArray(obj.setupCommands) ? obj.setupCommands : [])]),
      verifyCommands: cleanStringList([...(existing?.verifyCommands ?? []), ...(Array.isArray(obj.verifyCommands) ? obj.verifyCommands : [])]),
    };
  }
  return result;
}

/** 解析 globalState 里的最近项目列表。 */
export function parseRecentProjects(raw: unknown): RecentProject[] {
  if (!Array.isArray(raw)) return [];
  const byPath = new Map<string, RecentProject>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<RecentProject>;
    if (typeof rec.path !== 'string' || !rec.path.trim()) continue;
    const projectPath = normalizeProjectPath(rec.path);
    if (!projectPath) continue;
    const lastOpenedAt = typeof rec.lastOpenedAt === 'number' && Number.isFinite(rec.lastOpenedAt) ? rec.lastOpenedAt : 0;
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : projectBaseName(projectPath);
    const prev = byPath.get(projectPath);
    if (!prev || lastOpenedAt > prev.lastOpenedAt) {
      byPath.set(projectPath, { path: projectPath, name, lastOpenedAt });
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, MAX_RECENT_PROJECTS);
}

/** 记录或置顶一个最近使用的项目。 */
export function recordRecentProject(existing: readonly RecentProject[], projectPath: string, now = Date.now()): RecentProject[] {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return [...existing];
  const filtered = existing
    .map((p) => ({ ...p, path: normalizeProjectPath(p.path) }))
    .filter((p) => p.path && p.path !== normalized);
  const next: RecentProject = {
    path: normalized,
    name: projectBaseName(normalized) || normalized,
    lastOpenedAt: now,
  };
  return [next, ...filtered].slice(0, MAX_RECENT_PROJECTS);
}

/** 从最近项目中移除指定路径。 */
export function removeRecentProjectFromList(existing: readonly RecentProject[], projectPath: string): RecentProject[] {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return [...existing];
  return existing.filter((p) => normalizeProjectPath(p.path) !== normalized);
}

/** 构建推送给 Webview 的项目视图状态。 */
export function buildProjectsState(params: {
  readonly currentPath?: string;
  readonly recent: readonly RecentProject[];
  readonly configs: Readonly<Record<string, WorktreeProjectConfig>>;
}): ProjectsState {
  const currentPath = params.currentPath ? normalizeProjectPath(params.currentPath) : undefined;
  const recent = params.recent.map((item) => {
    const itemPath = normalizeProjectPath(item.path) || item.path;
    return {
      ...item,
      path: itemPath,
      ...(currentPath && itemPath === currentPath ? { isCurrent: true } : {}),
    };
  });
  return {
    ...(currentPath ? { currentPath } : {}),
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
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) return { ...current };
  const next: Record<string, WorktreeProjectConfig> = {};
  for (const [k, v] of Object.entries(current)) {
    const normKey = normalizeProjectPath(k);
    if (normKey && normKey !== normalizedPath) {
      next[normKey] = v;
    }
  }
  const cleaned: WorktreeProjectConfig = {
    copyFiles: cleanStringList(config.copyFiles),
    setupCommands: cleanStringList(config.setupCommands),
    verifyCommands: cleanStringList(config.verifyCommands),
  };
  if (cleaned.copyFiles.length === 0 && cleaned.setupCommands.length === 0 && cleaned.verifyCommands.length === 0) {
    delete next[normalizedPath];
  } else {
    next[normalizedPath] = cleaned;
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

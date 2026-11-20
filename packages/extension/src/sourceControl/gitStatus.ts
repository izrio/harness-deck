/**
 * 源码控制只读状态（HD-09）：读取工作区的 Git 分支、远程与未提交改动。
 *
 * 只执行只读命令（rev-parse / status / diff --numstat），不 commit、不 checkout、不 stash。
 * 不依赖 vscode API，便于单元测试。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  SourceControlActionResult,
  SourceControlFileStatus,
  SourceControlFileView,
  SourceControlGhStatus,
  SourceControlState,
} from '@harness-deck/shared';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 3_000;
const MAX_FILES = 500;

async function git(args: readonly string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** 供 `gitWrite.ts` 复用的只读/写入命令执行器。 */
export const runGit = git;

function statusOf(x: string, y: string): SourceControlFileStatus | undefined {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted';
  const code = y !== ' ' ? y : x;
  switch (code) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'M':
    case 'T':
      return 'modified';
    default:
      return code === ' ' ? undefined : 'modified';
  }
}

/** 解析 `git status --porcelain=v1 -z`。重命名/复制会多出一个旧路径 token。 */
export function parsePorcelainZ(stdout: string): SourceControlFileView[] {
  const tokens = stdout.split('\0');
  const files: SourceControlFileView[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record || record.length < 4) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const path = record.slice(3);
    if (!path) continue;
    const status = statusOf(x, y);
    if (!status) continue;
    if (x === 'R' || x === 'C') i += 1; // 跳过旧路径
    files.push({
      path,
      status,
      staged: x !== ' ' && x !== '?' && x !== '!',
    });
  }
  return files;
}

/** 解析 `git diff --numstat`：`新增\t删除\t路径`；二进制文件是 `-\t-\t路径`。 */
export function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of stdout.split('\n')) {
    const [added, deleted, ...rest] = line.split('\t');
    const path = rest.join('\t').trim();
    if (!path || added === undefined || deleted === undefined) continue;
    const additions = Number.parseInt(added, 10);
    const deletions = Number.parseInt(deleted, 10);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue;
    const current = result.get(path) ?? { additions: 0, deletions: 0 };
    current.additions += additions;
    current.deletions += deletions;
    result.set(path, current);
  }
  return result;
}

/** 解析 `git diff --numstat -z`：重命名/复制时记录格式为 `新增\t删除\t\0旧路径\0新路径\0`，含中文/空格不转义。 */
export function parseNumstatZ(stdout: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = firstTab >= 0 ? token.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    if (!path) {
      // 重命名/复制：下一个 token 是旧路径，再下一个是新路径
      path = tokens[i + 2] ?? '';
      i += 2;
    }
    if (!path) continue;
    const additions = Number.parseInt(added, 10);
    const deletions = Number.parseInt(deleted, 10);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue;
    const current = result.get(path) ?? { additions: 0, deletions: 0 };
    current.additions += additions;
    current.deletions += deletions;
    result.set(path, current);
  }
  return result;
}

/** 只读探测 GitHub CLI（gh）是否已安装并登录；不弹浏览器、不保存 token。 */
export async function detectGhStatus(cwd: string): Promise<SourceControlGhStatus> {
  try {
    await execFileAsync('gh', ['auth', 'status'], {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    return { installed: true, authenticated: true };
  } catch (error) {
    const missing = Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
    if (missing) return { installed: false, authenticated: false };
    return { installed: true, authenticated: false, detail: messageOf(error) };
  }
}

/** 读取某个文件在 HEAD（或 index）中的文本内容，用于工作台点击改动行时打开 Diff；不存在时返回 undefined。 */
export async function readGitFileAtRef(root: string, relPath: string, ref: 'HEAD' | '' = 'HEAD'): Promise<string | undefined> {
  const normalized = relPath.replace(/\\/gu, '/');
  try {
    return await git(['show', `${ref}:${normalized}`], root);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim().split('\n')[0] ?? 'git failed';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读取一个目录的 Git 状态。非 Git 仓库返回 `available: false`，不当作错误。
 */
export async function readGitStatus(
  cwd: string,
  options?: { readonly lastAction?: SourceControlActionResult; readonly checkGh?: boolean },
): Promise<SourceControlState> {
  const updatedAt = Date.now();
  let root: string;
  try {
    root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    return {
      available: false,
      files: [],
      additions: 0,
      deletions: 0,
      ...(options?.lastAction ? { lastAction: options.lastAction } : {}),
      updatedAt,
      ...(missing ? { error: 'git not found' } : {}),
    };
  }

  try {
    const [statusOut, stagedStats, unstagedStats, branchOut, remoteOut, gh] = await Promise.all([
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
      git(['diff', '--cached', '--numstat', '-z'], root).catch(() => ''),
      git(['diff', '--numstat', '-z'], root).catch(() => ''),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], root).catch(() => ''),
      git(['remote', 'get-url', 'origin'], root).catch(() => ''),
      options?.checkGh === false ? Promise.resolve(undefined) : detectGhStatus(root),
    ]);

    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const source of [stagedStats, unstagedStats]) {
      for (const [path, value] of parseNumstatZ(source)) {
        const current = stats.get(path) ?? { additions: 0, deletions: 0 };
        current.additions += value.additions;
        current.deletions += value.deletions;
        stats.set(path, current);
      }
    }

    const allFiles = parsePorcelainZ(statusOut).map((file) => {
      const stat = stats.get(file.path);
      return {
        ...file,
        ...(stat ? { additions: stat.additions, deletions: stat.deletions } : {}),
      };
    });
    allFiles.sort((a, b) => {
      if (a.staged !== b.staged) return a.staged ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    const files = allFiles.slice(0, MAX_FILES);
    const additions = allFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
    const deletions = allFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
    const branch = branchOut.trim();
    const remote = remoteOut.trim();

    return {
      available: true,
      root,
      ...(branch ? { branch } : {}),
      ...(remote ? { remote } : {}),
      files,
      additions,
      deletions,
      ...(allFiles.length > MAX_FILES ? { truncated: true } : {}),
      ...(gh ? { gh } : {}),
      ...(options?.lastAction ? { lastAction: options.lastAction } : {}),
      updatedAt,
    };
  } catch (error) {
    return {
      available: true,
      root,
      files: [],
      additions: 0,
      deletions: 0,
      ...(options?.lastAction ? { lastAction: options.lastAction } : {}),
      updatedAt,
      error: messageOf(error),
    };
  }
}

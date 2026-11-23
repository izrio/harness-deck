/**
 * 源码控制的写操作（HD-10 / P0-2）：
 * 提交改动、单文件/按 Hunk 暂存与撤销、分支切换/新建、Pull/Fetch、推送当前分支、用 GitHub CLI 创建 PR。
 *
 * 只在用户从工作台显式触发时执行；不做 force push，不保存 token。
 * `gh` 使用自己的登录凭据；未安装或未登录时把 stderr 返回给界面。
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { runGit } from './gitStatus.ts';

const execFileAsync = promisify(execFile);

export interface GitActionResult {
  readonly ok: boolean;
  readonly message?: string;
}

function firstLine(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim().split('\n')[0] ?? 'git failed';
  }
  return error instanceof Error ? error.message : String(error);
}

/** 将补丁通过 stdin 喂给 `git apply`，支持按 Hunk 暂存或撤销改动。 */
async function runGitWithStdin(cwd: string, args: readonly string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n')[0] || `git ${args[0] ?? ''} exited ${String(code)}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

/** 提交改动。`stageAll` 为 false 时仅提交已暂存文件；默认 true（提交全部未提交改动）。提交信息不能为空。 */
export async function commitAll(
  cwd: string,
  message: string,
  options?: { readonly stageAll?: boolean },
): Promise<GitActionResult> {
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, message: 'commit message is empty' };
  if (trimmed.length > 5_000) return { ok: false, message: 'commit message is too long' };
  try {
    if (options?.stageAll !== false) {
      await runGit(['add', '-A'], cwd);
    }
    await runGit(['commit', '-m', trimmed], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 推送当前分支；没有 upstream 时设置 origin。绝不 force push。 */
export async function pushCurrentBranch(cwd: string): Promise<GitActionResult> {
  try {
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    if (!branch || branch === 'HEAD') return { ok: false, message: 'detached HEAD' };
    const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).catch(() => '');
    const args = upstream.trim() ? ['push'] : ['push', '-u', 'origin', branch];
    await runGit(args, cwd, 120_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 用 GitHub CLI 创建 PR。标题必填，正文可为空。 */
export async function createPullRequest(cwd: string, title: string, body: string): Promise<GitActionResult> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return { ok: false, message: 'PR title is empty' };
  try {
    await execFileAsync('gh', ['pr', 'create', '--title', trimmedTitle, '--body', body.trim()], {
      cwd,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 暂存单个文件（P0-2）。 */
export async function stageFile(cwd: string, filePath: string): Promise<GitActionResult> {
  try {
    await runGit(['add', '--', filePath], cwd);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 取消暂存单个文件；兼容尚未有 HEAD 的全新仓库（P0-2）。 */
export async function unstageFile(cwd: string, filePath: string): Promise<GitActionResult> {
  try {
    await runGit(['reset', 'HEAD', '--', filePath], cwd);
    return { ok: true };
  } catch {
    try {
      await runGit(['rm', '--cached', '--', filePath], cwd);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: firstLine(error) };
    }
  }
}

/** 撤销单个文件的未提交改动（未跟踪文件使用 `git clean -fd --`，已跟踪文件使用 `git checkout --`）。 */
export async function discardFile(cwd: string, filePath: string, untracked = false): Promise<GitActionResult> {
  try {
    if (untracked) {
      await runGit(['clean', '-fd', '--', filePath], cwd);
    } else {
      await runGit(['checkout', '--', filePath], cwd);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 按单个 Hunk 补丁暂存到 index（P0-1 / P0-2）。 */
export async function stageHunk(cwd: string, patch: string): Promise<GitActionResult> {
  try {
    await runGitWithStdin(cwd, ['apply', '--cached', '--unidiff-zero', '-'], patch);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 按单个 Hunk 补丁从工作区撤销（P0-1 / P0-2）。 */
export async function discardHunk(cwd: string, patch: string): Promise<GitActionResult> {
  try {
    await runGitWithStdin(cwd, ['apply', '-R', '--unidiff-zero', '-'], patch);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 切换本地分支（P0-2）。 */
export async function checkoutBranch(cwd: string, branch: string): Promise<GitActionResult> {
  const name = branch.trim();
  if (!name || name.startsWith('-')) return { ok: false, message: 'invalid branch name' };
  try {
    await runGit(['checkout', name], cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 基于当前 HEAD 新建并切换分支（P0-2）。 */
export async function createBranch(cwd: string, branch: string): Promise<GitActionResult> {
  const name = branch.trim();
  if (!name || name.startsWith('-')) return { ok: false, message: 'invalid branch name' };
  try {
    await runGit(['checkout', '-b', name], cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 拉取远程更新（使用 `--ff-only`，不自动产生意外合并提交）。 */
export async function pullCurrentBranch(cwd: string): Promise<GitActionResult> {
  try {
    await runGit(['pull', '--ff-only'], cwd, 120_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 从远程抓取最新引用并清理失效分支引用。 */
export async function fetchRemote(cwd: string): Promise<GitActionResult> {
  try {
    await runGit(['fetch', '--prune'], cwd, 120_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

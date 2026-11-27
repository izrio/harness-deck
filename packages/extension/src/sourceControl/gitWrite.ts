/**
 * 源码控制的写操作（HD-10 / P0-2 / Git 模块重构）：
 * - IDEA 风格按勾选文件提交、Amend 修改上次提交、提交并推送
 * - 单文件/批量/按 Hunk 暂存、取消暂存与撤销
 * - 分支切换（支持远程跟踪检出）、基于指定起点新建、重命名、删除、合并、变基
 * - 提交图谱操作：Cherry-pick、Revert、Reset (soft/mixed/hard)
 * - 进行中操作控制（Continue / Abort）与单文件冲突解决（ours / theirs / mark）
 * - Pull / Fetch / Push / GitHub CLI 创建 PR
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceControlInProgressOp } from '@harness-deck/shared';
import { detectInProgressOp, parsePorcelainZ, runGit } from './gitStatus.ts';

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

function isValidRefName(name: string): boolean {
  const trimmed = name.trim();
  return Boolean(trimmed) && !trimmed.startsWith('-') && !/\s|\.\.|~|\^|:|\?|\*|\[|\\/u.test(trimmed);
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

async function hasHeadCommit(cwd: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * 提交改动：
 * - 传入非空 `files` 时：采用 IDEA 风格仅提交勾选的文件（未跟踪文件自动 intent-to-add，不影响未勾选文件）
 * - 传入 `amend: true` 时：修改最近一次提交（无文件改动时也可仅修改提交信息）
 * - 否则保持原逻辑：`stageAll` 为 false 时仅提交已暂存文件，默认 true 提交全部改动
 */
export async function commitAll(
  cwd: string,
  message: string,
  options?: {
    readonly stageAll?: boolean;
    readonly files?: readonly string[];
    readonly amend?: boolean;
  },
): Promise<GitActionResult> {
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, message: 'commit message is empty' };
  if (trimmed.length > 5_000) return { ok: false, message: 'commit message is too long' };
  const amend = Boolean(options?.amend);
  const selectedFiles = options?.files?.map((f) => f.trim()).filter(Boolean);

  try {
    if (selectedFiles && selectedFiles.length > 0) {
      const hasHead = await hasHeadCommit(cwd);
      if (hasHead) {
        // 对未跟踪文件先 intent-to-add，使 `git commit --only -- <files>` 可精准只提交所选文件
        const statusOut = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd).catch(() => '');
        const untrackedSet = new Set(
          parsePorcelainZ(statusOut)
            .filter((f) => f.status === 'untracked')
            .map((f) => f.path),
        );
        const untrackedSelected = selectedFiles.filter((p) => untrackedSet.has(p));
        if (untrackedSelected.length > 0) {
          await runGit(['add', '--intent-to-add', '--', ...untrackedSelected], cwd);
        }
        const commitArgs = ['commit', '--only', ...(amend ? ['--amend'] : []), '-m', trimmed, '--', ...selectedFiles];
        await runGit(commitArgs, cwd, 60_000);
      } else {
        await runGit(['add', '--', ...selectedFiles], cwd);
        await runGit(['commit', '-m', trimmed], cwd, 60_000);
      }
      return { ok: true };
    }

    if (amend) {
      if (options?.stageAll === true) {
        await runGit(['add', '-A'], cwd);
      }
      await runGit(['commit', '--amend', '-m', trimmed], cwd, 60_000);
      return { ok: true };
    }

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

/** 暂存工作区全部改动。 */
export async function stageAllFiles(cwd: string): Promise<GitActionResult> {
  try {
    await runGit(['add', '-A'], cwd);
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

/** 取消暂存全部文件；兼容尚未有 HEAD 的全新仓库。 */
export async function unstageAllFiles(cwd: string): Promise<GitActionResult> {
  try {
    await runGit(['reset', 'HEAD'], cwd);
    return { ok: true };
  } catch {
    try {
      await runGit(['rm', '-r', '--cached', '.'], cwd);
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

/** 撤销全部未暂存更改并清理未跟踪文件（危险操作，需二次确认）。 */
export async function discardAllFiles(cwd: string): Promise<GitActionResult> {
  try {
    await runGit(['checkout', '--', '.'], cwd).catch(() => '');
    await runGit(['clean', '-fd'], cwd);
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

/** 切换分支；若传入的是远程分支引用（如 `origin/feat`），自动检出为本地跟踪分支。 */
export async function checkoutBranch(cwd: string, branch: string): Promise<GitActionResult> {
  const name = branch.trim();
  if (!name || name.startsWith('-')) return { ok: false, message: 'invalid branch name' };
  try {
    // 检测是否为远程分支（refs/remotes/<name> 存在且本地 refs/heads/<name> 不存在）
    const isRemoteRef = await runGit(['show-ref', '--verify', '--quiet', `refs/remotes/${name}`], cwd)
      .then(() => true)
      .catch(() => false);
    if (isRemoteRef) {
      const slash = name.indexOf('/');
      const localName = slash >= 0 ? name.slice(slash + 1) : name;
      const localExists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], cwd)
        .then(() => true)
        .catch(() => false);
      if (localExists) {
        await runGit(['checkout', localName], cwd, 30_000);
      } else {
        await runGit(['checkout', '--track', name], cwd, 30_000);
      }
      return { ok: true };
    }
    await runGit(['checkout', name], cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 基于当前 HEAD 或指定起点（分支 / 标签 / 提交哈希）新建并切换分支。 */
export async function createBranch(cwd: string, branch: string, startPoint?: string): Promise<GitActionResult> {
  const name = branch.trim();
  if (!isValidRefName(name)) return { ok: false, message: 'invalid branch name' };
  const start = startPoint?.trim();
  if (start && start.startsWith('-')) return { ok: false, message: 'invalid start point' };
  try {
    const args = start ? ['checkout', '-b', name, start] : ['checkout', '-b', name];
    await runGit(args, cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 重命名本地分支。 */
export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<GitActionResult> {
  const from = oldName.trim();
  const to = newName.trim();
  if (!isValidRefName(from) || !isValidRefName(to)) return { ok: false, message: 'invalid branch name' };
  try {
    await runGit(['branch', '-m', '--', from, to], cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 删除本地分支；禁止删除当前检出的分支。默认 `-d` 安全删除，显式传 `force: true` 时使用 `-D`。 */
export async function deleteBranch(
  cwd: string,
  branch: string,
  options?: { readonly force?: boolean },
): Promise<GitActionResult> {
  const name = branch.trim();
  if (!name || name.startsWith('-')) return { ok: false, message: 'invalid branch name' };
  try {
    const current = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '')).trim();
    if (current && current === name) {
      return { ok: false, message: 'cannot delete current branch' };
    }
    await runGit(['branch', options?.force ? '-D' : '-d', '--', name], cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 将指定分支合并到当前分支。 */
export async function mergeBranch(cwd: string, branch: string): Promise<GitActionResult> {
  const name = branch.trim();
  if (!name || name.startsWith('-')) return { ok: false, message: 'invalid branch name' };
  try {
    await runGit(['merge', '--no-edit', name], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 将当前分支变基到指定目标分支之上。 */
export async function rebaseBranch(cwd: string, branch: string): Promise<GitActionResult> {
  const name = branch.trim();
  if (!name || name.startsWith('-')) return { ok: false, message: 'invalid branch name' };
  try {
    await runGit(['rebase', name], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 拣选（Cherry-pick）指定提交到当前分支。 */
export async function cherryPickCommit(cwd: string, hash: string): Promise<GitActionResult> {
  const clean = hash.trim();
  if (!/^[0-9a-fA-F]{4,64}$/u.test(clean)) return { ok: false, message: 'invalid commit hash' };
  try {
    await runGit(['cherry-pick', clean], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 反向提交（Revert）指定提交。 */
export async function revertCommit(cwd: string, hash: string): Promise<GitActionResult> {
  const clean = hash.trim();
  if (!/^[0-9a-fA-F]{4,64}$/u.test(clean)) return { ok: false, message: 'invalid commit hash' };
  try {
    await runGit(['revert', '--no-edit', clean], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 将当前分支重置到指定提交（soft / mixed / hard）。 */
export async function resetToCommit(
  cwd: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
): Promise<GitActionResult> {
  const clean = hash.trim();
  if (!/^[0-9a-fA-F]{4,64}$/u.test(clean)) return { ok: false, message: 'invalid commit hash' };
  try {
    await runGit(['reset', `--${mode}`, clean], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 继续正在进行的 merge / rebase / cherry-pick / revert 操作。 */
export async function continueGitOperation(
  cwd: string,
  op?: SourceControlInProgressOp,
): Promise<GitActionResult> {
  const activeOp = op ?? (await detectInProgressOp(cwd));
  if (!activeOp) return { ok: false, message: 'no operation in progress' };
  try {
    if (activeOp === 'merge') {
      await runGit(['commit', '--no-edit'], cwd, 60_000);
    } else {
      await runGit([activeOp, '--continue'], cwd, 60_000);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 中止正在进行的 merge / rebase / cherry-pick / revert 操作。 */
export async function abortGitOperation(
  cwd: string,
  op?: SourceControlInProgressOp,
): Promise<GitActionResult> {
  const activeOp = op ?? (await detectInProgressOp(cwd));
  if (!activeOp) return { ok: false, message: 'no operation in progress' };
  try {
    await runGit([activeOp, '--abort'], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

/** 解决单个冲突文件：采用己方（ours）、采用对方（theirs）或直接标记已解决（mark）。 */
export async function resolveConflictFile(
  cwd: string,
  filePath: string,
  strategy: 'ours' | 'theirs' | 'mark',
): Promise<GitActionResult> {
  try {
    if (strategy === 'ours') {
      await runGit(['checkout', '--ours', '--', filePath], cwd);
    } else if (strategy === 'theirs') {
      await runGit(['checkout', '--theirs', '--', filePath], cwd);
    }
    await runGit(['add', '--', filePath], cwd);
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

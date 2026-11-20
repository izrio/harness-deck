/**
 * 源码控制的写操作（HD-10）：提交全部改动、推送当前分支、用 GitHub CLI 创建 PR。
 *
 * 只在用户从工作台显式触发时执行；不做 force push，不切换分支，不保存 token。
 * `gh` 使用自己的登录凭据；未安装或未登录时把 stderr 返回给界面。
 */
import { execFile } from 'node:child_process';
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

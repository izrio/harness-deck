/**
 * Git 贮藏（Stash）读写操作：
 * - 列表读取、单个 Stash 文件变更查看（含 `-u` 未跟踪文件）
 * - 新建贮藏（支持自定义备注、包含未跟踪文件、按选中文件路径局部贮藏）
 * - Apply / Pop / Drop
 */
import type { SourceControlCommitFileView, SourceControlStashView } from '@harness-deck/shared';
import { parseNameStatusZ } from './gitLog.ts';
import { parseNumstatZ, readGitFileAtRef, runGit } from './gitStatus.ts';
import type { GitActionResult } from './gitWrite.ts';

const FIELD_SEP = '\x1f';

function firstLine(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim().split('\n')[0] ?? 'git stash failed';
  }
  return error instanceof Error ? error.message : String(error);
}

/** 解析 `git stash list --format=%gd%x1f%ct%x1f%gs`。 */
export function parseStashList(stdout: string): SourceControlStashView[] {
  const result: SourceControlStashView[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [refRaw, tsRaw, ...msgParts] = line.split(FIELD_SEP);
    const ref = refRaw?.trim() ?? '';
    const idxMatch = /^stash@\{(\d+)\}$/u.exec(ref);
    if (!idxMatch) continue;
    const index = Number.parseInt(idxMatch[1]!, 10);
    const tsSec = Number.parseInt(tsRaw?.trim() ?? '', 10);
    const date = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : undefined;
    const rawMsg = msgParts.join(FIELD_SEP).trim();
    const branchMatch = /^(?:WIP on|On)\s+([^:]+):\s*(.*)$/u.exec(rawMsg);
    const branch = branchMatch?.[1]?.trim() || undefined;
    const message = (branchMatch ? branchMatch[2]?.trim() : rawMsg) || ref;
    result.push({
      index,
      ref,
      ...(branch ? { branch } : {}),
      message,
      ...(date !== undefined ? { date } : {}),
    });
  }
  return result;
}

export async function listStashes(cwd: string): Promise<SourceControlStashView[]> {
  try {
    const out = await runGit(['stash', 'list', `--format=%gd${FIELD_SEP}%ct${FIELD_SEP}%gs`], cwd);
    return parseStashList(out);
  } catch {
    return [];
  }
}

export async function readStashFiles(cwd: string, index: number): Promise<SourceControlCommitFileView[]> {
  const ref = `stash@{${String(index)}}`;
  const [nameStatusRaw, numstatRaw] = await Promise.all([
    runGit(['stash', 'show', '--include-untracked', '--name-status', '-z', ref], cwd).catch(() => ''),
    runGit(['stash', 'show', '--include-untracked', '--numstat', '-z', ref], cwd).catch(() => ''),
  ]);
  const stats = parseNumstatZ(numstatRaw);
  return parseNameStatusZ(nameStatusRaw).map((entry) => {
    const stat = stats.get(entry.path);
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      ...(stat ? { additions: stat.additions, deletions: stat.deletions } : {}),
    };
  });
}

/** 读取某个 Stash 文件变更前后内容（兼容 `-u` 存入 `stash@{n}^3` 的未跟踪文件）。 */
export async function readStashFileDiffContents(
  cwd: string,
  index: number,
  relPath: string,
): Promise<{ readonly before?: string; readonly after?: string }> {
  const ref = `stash@{${String(index)}}`;
  const [before, trackedAfter] = await Promise.all([
    readGitFileAtRef(cwd, relPath, `${ref}^1`),
    readGitFileAtRef(cwd, relPath, ref),
  ]);
  if (trackedAfter !== undefined) {
    return { ...(before !== undefined ? { before } : {}), after: trackedAfter };
  }
  const untrackedAfter = await readGitFileAtRef(cwd, relPath, `${ref}^3`);
  return {
    ...(before !== undefined ? { before } : {}),
    ...(untrackedAfter !== undefined ? { after: untrackedAfter } : {}),
  };
}

export async function saveStash(
  cwd: string,
  options?: {
    readonly message?: string;
    readonly includeUntracked?: boolean;
    readonly paths?: readonly string[];
  },
): Promise<GitActionResult> {
  const args: string[] = ['stash', 'push'];
  if (options?.includeUntracked !== false) {
    args.push('--include-untracked');
  }
  const msg = options?.message?.trim();
  if (msg) {
    args.push('-m', msg);
  }
  if (options?.paths && options.paths.length > 0) {
    args.push('--', ...options.paths);
  }
  try {
    const out = await runGit(args, cwd, 60_000);
    if (/No local changes to save/iu.test(out)) {
      return { ok: false, message: 'No local changes to save' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

export async function applyStash(cwd: string, index: number): Promise<GitActionResult> {
  try {
    await runGit(['stash', 'apply', `stash@{${String(index)}}`], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

export async function popStash(cwd: string, index: number): Promise<GitActionResult> {
  try {
    await runGit(['stash', 'pop', `stash@{${String(index)}}`], cwd, 60_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

export async function dropStash(cwd: string, index: number): Promise<GitActionResult> {
  try {
    await runGit(['stash', 'drop', `stash@{${String(index)}}`], cwd, 30_000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: firstLine(error) };
  }
}

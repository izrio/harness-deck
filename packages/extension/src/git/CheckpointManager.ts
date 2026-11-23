/**
 * 跨底层多回合 Git 检查点管理器（P0-3）：
 * - 通过临时 `GIT_INDEX_FILE` + `git write-tree` + `git commit-tree` 把每回合工作区快照写入隐藏引用
 *   `refs/harness-deck/checkpoints/<sessionKey>/turn-<seq>`，绝不触碰用户真实的暂存区（`.git/index`）与提交历史。
 * - 支持任意底层（dsh / Claude / Codex / Pi / ZCode / CodeBuddy / ACP）在 Git 仓库里多回合回滚；
 * - 回滚前自动写入安全备份 `refs/harness-deck/backups/<sessionKey>/<ts>`，避免误操作丢代码。
 */
import { execFile } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 15_000;
const REF_PREFIX = 'refs/harness-deck/checkpoints';
const BACKUP_PREFIX = 'refs/harness-deck/backups';

export function sanitizeCheckpointSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 80);
  return safe || 'session';
}

function checkpointRef(sessionId: string, turnSeq: number): string {
  return `${REF_PREFIX}/${sanitizeCheckpointSessionId(sessionId)}/turn-${turnSeq}`;
}

async function git(
  cwd: string,
  args: readonly string[],
  envExtra?: Readonly<Record<string, string>>,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
    timeout: TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: envExtra ? { ...process.env, ...envExtra } : process.env,
  });
  return stdout;
}

async function resolveGitRoot(cwd: string): Promise<{ readonly root: string; readonly gitDir: string } | undefined> {
  try {
    const [rootOut, gitDirOut] = await Promise.all([
      git(cwd, ['rev-parse', '--show-toplevel']),
      git(cwd, ['rev-parse', '--absolute-git-dir']),
    ]);
    const root = rootOut.trim();
    const gitDir = gitDirOut.trim();
    if (!root || !gitDir) return undefined;
    return { root, gitDir };
  } catch {
    return undefined;
  }
}

/** 使用隔离的临时索引将当前工作区（含未跟踪文件，遵循 .gitignore）打包为 commit 对象。 */
async function snapshotWorkingTreeToRef(
  root: string,
  gitDir: string,
  ref: string,
  message: string,
): Promise<string> {
  const tempIndex = join(tmpdir(), `hd-ckpt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.idx`);
  try {
    await copyFile(join(gitDir, 'index'), tempIndex).catch(() => undefined);
    const env = { GIT_INDEX_FILE: tempIndex };
    await git(root, ['add', '-A'], env);
    const tree = (await git(root, ['write-tree'], env)).trim();
    const head = await git(root, ['rev-parse', '--verify', 'HEAD']).then((s) => s.trim()).catch(() => '');
    const commitArgs = head ? ['commit-tree', tree, '-p', head, '-m', message] : ['commit-tree', tree, '-m', message];
    const commit = (await git(root, commitArgs, env)).trim();
    await git(root, ['update-ref', ref, commit]);
    return commit;
  } finally {
    await rm(tempIndex, { force: true }).catch(() => undefined);
  }
}

/** 记录某个会话在 `turnSeq` 时刻的工作区检查点；非 Git 仓库时静默返回 false。 */
export async function captureTurnCheckpoint(cwd: string, sessionId: string, turnSeq: number): Promise<boolean> {
  if (!sessionId || turnSeq < 1) return false;
  const repo = await resolveGitRoot(cwd);
  if (!repo) return false;
  try {
    await snapshotWorkingTreeToRef(
      repo.root,
      repo.gitDir,
      checkpointRef(sessionId, turnSeq),
      `harness-deck checkpoint ${sessionId} turn ${turnSeq}`,
    );
    return true;
  } catch {
    return false;
  }
}

/** 查询某个会话已记录的所有检查点回合序号（升序）。 */
export async function listTurnCheckpoints(cwd: string, sessionId: string): Promise<number[]> {
  if (!sessionId) return [];
  const repo = await resolveGitRoot(cwd);
  if (!repo) return [];
  const prefix = `${REF_PREFIX}/${sanitizeCheckpointSessionId(sessionId)}/`;
  try {
    const out = await git(repo.root, ['for-each-ref', '--format=%(refname)', prefix]);
    const turns: number[] = [];
    for (const line of out.split(/\r?\n/u)) {
      const m = /\/turn-(\d+)$/u.exec(line.trim());
      if (m?.[1]) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= 1) turns.push(n);
      }
    }
    turns.sort((a, b) => a - b);
    return turns;
  } catch {
    return [];
  }
}

export interface RestoreCheckpointResult {
  readonly ok: boolean;
  readonly restoredFiles?: number;
  readonly removedFiles?: number;
  readonly backupRef?: string;
  readonly error?: string;
}

/** 将工作区精确回滚到指定回合的检查点（先留备份 ref，再还原目标树并清理该回合之后新增的文件）。 */
export async function restoreTurnCheckpoint(
  cwd: string,
  sessionId: string,
  turnSeq: number,
): Promise<RestoreCheckpointResult> {
  const repo = await resolveGitRoot(cwd);
  if (!repo) return { ok: false, error: 'not a git repository' };
  const targetRef = checkpointRef(sessionId, turnSeq);
  try {
    await git(repo.root, ['rev-parse', '--verify', targetRef]);
  } catch {
    return { ok: false, error: `checkpoint for turn ${turnSeq} not found` };
  }

  const backupRef = `${BACKUP_PREFIX}/${sanitizeCheckpointSessionId(sessionId)}/${Date.now()}`;
  const tempIndex = join(tmpdir(), `hd-restore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.idx`);
  try {
    // 1. 先保存当前工作区为安全备份，避免误回滚丢改动
    await snapshotWorkingTreeToRef(repo.root, repo.gitDir, backupRef, `backup before rollback to turn ${turnSeq}`);

    // 2. 对比当前备份树与目标检查点树，找出需要删除的新增文件与需要恢复的文件
    const [targetListRaw, currentListRaw] = await Promise.all([
      git(repo.root, ['ls-tree', '-r', '-z', '--name-only', targetRef]),
      git(repo.root, ['ls-tree', '-r', '-z', '--name-only', backupRef]),
    ]);
    const targetFiles = new Set(targetListRaw.split('\0').filter(Boolean));
    const currentFiles = currentListRaw.split('\0').filter(Boolean);

    const toRemove = currentFiles.filter((file) => !targetFiles.has(file));
    for (const rel of toRemove) {
      await rm(join(repo.root, rel), { force: true }).catch(() => undefined);
    }

    // 3. 用临时索引把目标树检出到工作区（不破坏用户的 .git/index）
    const env = { GIT_INDEX_FILE: tempIndex };
    await git(repo.root, ['read-tree', targetRef], env);
    await git(repo.root, ['checkout-index', '-a', '-f'], env);

    return {
      ok: true,
      restoredFiles: targetFiles.size,
      removedFiles: toRemove.length,
      backupRef,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(tempIndex, { force: true }).catch(() => undefined);
  }
}

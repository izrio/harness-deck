/**
 * 单实例调度锁（HD-18）：同一 configRoot 只允许一个后台调度进程。
 * 通过「写临时文件 → 原子 hard link」创建锁文件，避免先建空文件再写 pid 时的竞态窗口；
 * pid 已退出时视为陈旧锁，可以清理后重新获取。
 */
import { randomBytes } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function schedulerLockPath(configRoot: string): string {
  return join(configRoot, 'scheduler.lock');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但无权发送信号，仍视为存活。
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM');
  }
}

/** 锁是否被另一个仍然存活的进程持有；`ignorePid` 用于让锁的持有者忽略自己。 */
export function isSchedulerLockHeld(lockPath: string, ignorePid?: number): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0 || pid === ignorePid) return false;
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

export interface SchedulerLock {
  readonly release: () => Promise<void>;
}

/** 获取锁；另一个进程持有时返回 undefined。陈旧锁会被清理后重试一次。 */
export async function acquireSchedulerLock(configRoot: string): Promise<SchedulerLock | undefined> {
  const lockPath = schedulerLockPath(configRoot);
  const tmpPath = join(configRoot, `.scheduler.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmpPath, String(process.pid), 'utf8');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(tmpPath, lockPath);
        return {
          release: async () => {
            // 仅当锁文件仍记录当前进程 pid 时才清理，避免误删新持有者的锁。
            try {
              const raw = readFileSync(lockPath, 'utf8').trim();
              if (Number(raw) !== process.pid) return;
            } catch {
              return;
            }
            await unlink(lockPath).catch(() => undefined);
          },
        };
      } catch {
        if (isSchedulerLockHeld(lockPath)) return undefined;
        await unlink(lockPath).catch(() => undefined);
      }
    }
    return undefined;
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

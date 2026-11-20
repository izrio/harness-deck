import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSchedulerLock, isSchedulerLockHeld, schedulerLockPath } from '../src/sidecar/schedulerLock.ts';

const dirs: string[] = [];

async function configRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('schedulerLock', () => {
  it('进程写下的锁视为已持有', async () => {
    const root = await configRoot();
    const path = schedulerLockPath(root);
    await writeFile(path, String(process.pid), 'utf8');
    expect(isSchedulerLockHeld(path)).toBe(true);
    expect(isSchedulerLockHeld(path, process.pid)).toBe(false);
  });

  it('获取后第二个进程拿不到，释放后可以再获取', async () => {
    const root = await configRoot();
    const first = await acquireSchedulerLock(root);
    expect(first).toBeDefined();
    expect(await acquireSchedulerLock(root)).toBeUndefined();
    await first!.release();
    const again = await acquireSchedulerLock(root);
    expect(again).toBeDefined();
    await again!.release();
  });

  it('陈旧 pid 的锁会被清理后重新获取', async () => {
    const root = await configRoot();
    const path = schedulerLockPath(root);
    await writeFile(path, '999999', 'utf8');
    expect(isSchedulerLockHeld(path)).toBe(false);
    const lock = await acquireSchedulerLock(root);
    expect(lock).toBeDefined();
    await lock!.release();
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureTurnCheckpoint,
  listTurnCheckpoints,
  restoreTurnCheckpoint,
} from '../src/git/CheckpointManager.ts';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-ckpt-test-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'v1\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('CheckpointManager (P0-3)', () => {
  it('captures multi-turn checkpoints without touching user git index and restores accurately', async () => {
    const repo = await initRepo();
    // Turn 1: modify a.txt
    await writeFile(join(repo, 'a.txt'), 'turn1\n', 'utf8');
    expect(await captureTurnCheckpoint(repo, 'sess-1', 1)).toBe(true);

    // User stages nothing — real index must remain clean relative to HEAD
    const cachedDiff = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout.trim();
    expect(cachedDiff).toBe('');

    // Turn 2: modify a.txt and add new untracked file b.txt
    await writeFile(join(repo, 'a.txt'), 'turn2\n', 'utf8');
    await writeFile(join(repo, 'b.txt'), 'extra\n', 'utf8');
    expect(await captureTurnCheckpoint(repo, 'sess-1', 2)).toBe(true);

    expect(await listTurnCheckpoints(repo, 'sess-1')).toEqual([1, 2]);

    // Roll back to turn 1: a.txt reverts to turn1 and b.txt is removed, backup ref created
    const res = await restoreTurnCheckpoint(repo, 'sess-1', 1);
    expect(res.ok).toBe(true);
    expect(res.backupRef).toContain('refs/harness-deck/backups/sess-1/');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('turn1\n');
    await expect(readFile(join(repo, 'b.txt'), 'utf8')).rejects.toThrow();
  });

  it('returns false gracefully outside a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-non-git-'));
    tempDirs.push(dir);
    expect(await captureTurnCheckpoint(dir, 'sess-1', 1)).toBe(false);
    expect(await listTurnCheckpoints(dir, 'sess-1')).toEqual([]);
  });
});

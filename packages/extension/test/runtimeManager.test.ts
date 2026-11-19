/**
 * RuntimeManager 测试：用一个假的 dsh 可执行文件（Node 脚本）模拟版本输出、就绪 URL 和崩溃。
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeStatus } from '@harness-deck/shared';
import { RuntimeManager } from '../src/runtime/RuntimeManager.ts';

const FAKE_DSH = `#!/usr/bin/env node
const mode = process.env.FAKE_DSH_MODE ?? 'ok';
if (process.argv.includes('--version')) {
  console.log(process.env.FAKE_DSH_VERSION ?? '0.2.1-rc.5');
  process.exit(0);
}
if (mode === 'exit-early') {
  console.error('boom: missing provider');
  process.exit(3);
}
console.log('loading plugins…');
if (mode === 'never-ready') { setInterval(() => {}, 1000); return; }
setTimeout(() => console.log('dsh web: http://127.0.0.1:45678/?token=fake-token-1'), 50);
if (mode === 'crash-after-ready') setTimeout(() => process.exit(9), 300);
setInterval(() => {}, 1000);
`;

const managers: RuntimeManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-dsh-'));
  dirs.push(dir);
  const command = join(dir, 'dsh');
  await writeFile(command, FAKE_DSH);
  await chmod(command, 0o755);
  const statuses: RuntimeStatus[] = [];
  const manager = new RuntimeManager({
    getConfig: () => ({ configuredPath: command, profile: 'web', cwd: dir, env: { ...process.env, ...env }, readyTimeoutMs: 5_000 }),
    log: () => undefined,
    maxRestarts: 2,
    backoffMs: () => 50,
  });
  manager.onStatus((status) => statuses.push(status));
  managers.push(manager);
  return { manager, statuses };
}

describe.skipIf(process.platform === 'win32')('RuntimeManager', () => {
  it('启动后解析出 origin 和令牌，状态变为 connected', async () => {
    const { manager, statuses } = await setup({ FAKE_DSH_MODE: 'ok' });
    const endpoint = await manager.start();
    expect(endpoint).toEqual({ origin: 'http://127.0.0.1:45678', token: 'fake-token-1', version: '0.2.1-rc.5' });
    expect(statuses.map((s) => s.kind)).toEqual(['locating', 'starting', 'connected']);
  });

  it('并发调用 start 只启动一次', async () => {
    const { manager } = await setup({ FAKE_DSH_MODE: 'ok' });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    expect(a).toBe(b);
  });

  it('版本过低时不启动', async () => {
    const { manager } = await setup({ FAKE_DSH_VERSION: '0.1.5-rc.1' });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.currentStatus).toEqual({ kind: 'unsupportedVersion', version: '0.1.5-rc.1', minimum: '0.2.1-rc.5' });
  });

  it('就绪前退出时状态为 failed', async () => {
    const { manager } = await setup({ FAKE_DSH_MODE: 'exit-early' });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(manager.currentStatus.kind).toBe('failed');
  });

  it('就绪后意外退出会自动重启，超过上限后停止', async () => {
    const { manager, statuses } = await setup({ FAKE_DSH_MODE: 'crash-after-ready' });
    await manager.start();
    // 每次崩溃间隔约 300ms + 退避 50ms；上限 2 次重启
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const kinds = statuses.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'reconnecting')).toHaveLength(2);
    expect(manager.currentStatus.kind).toBe('failed');
  });

  it('找不到 dsh 时状态为 notInstalled', async () => {
    const manager = new RuntimeManager({
      getConfig: () => ({ profile: 'web', cwd: tmpdir(), env: { PATH: '/nonexistent' } }),
      log: () => undefined,
    });
    managers.push(manager);
    await manager.start();
    expect(manager.currentStatus.kind).toBe('notInstalled');
  });

  it('启动途中停止：立即结束还没就绪的进程，不等启动超时', async () => {
    const { manager, statuses } = await setup({ FAKE_DSH_MODE: 'never-ready' });
    const starting = manager.start();
    // 等到进程已经起来、正在等就绪 URL
    await expect.poll(() => statuses.at(-1)?.kind, { timeout: 3_000 }).toBe('starting');
    const began = Date.now();
    await manager.stop();
    // 就绪超时是 5 秒：远早于它返回，说明没有等启动跑完
    expect(Date.now() - began).toBeLessThan(2_000);
    await expect(starting).resolves.toBeUndefined();
    expect(statuses.at(-1)).toEqual({ kind: 'idle' });
    // 中止不算失败：不显示「启动失败」
    expect(statuses.some((s) => s.kind === 'failed')).toBe(false);
  });

  it('命中缓存的可执行文件与版本元数据时直接跳过 locating，缓存失效时自动回退查找', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fake-dsh-cached-'));
    dirs.push(dir);
    const command = join(dir, 'dsh');
    await writeFile(command, FAKE_DSH);
    await chmod(command, 0o755);

    const { verifyExecutableFile } = await import('../src/runtime/locate.ts');
    const statMeta = await verifyExecutableFile(command, process.platform);
    const statuses: RuntimeStatus[] = [];
    let resolvedCache: unknown;

    const manager = new RuntimeManager({
      getConfig: () => ({
        configuredPath: command,
        profile: 'web',
        cwd: dir,
        env: { ...process.env, FAKE_DSH_MODE: 'ok' },
        readyTimeoutMs: 5_000,
        cachedExecutable: {
          command,
          version: '0.2.1-rc.5',
          mtimeMs: statMeta?.mtimeMs,
          size: statMeta?.size,
        },
        onResolvedExecutable: (info) => {
          resolvedCache = info;
        },
      }),
      log: () => undefined,
    });
    manager.onStatus((s) => statuses.push(s));
    managers.push(manager);

    const endpoint = await manager.start();
    expect(endpoint?.version).toBe('0.2.1-rc.5');
    // 命中缓存时不经过 locating
    expect(statuses.map((s) => s.kind)).toEqual(['starting', 'connected']);
    expect(resolvedCache).toMatchObject({ command, version: '0.2.1-rc.5' });
  });

  it('WSL 环境下自动忽略并清除指向 Windows 宿主机挂载目录的缓存 dsh，回退到 WSL 中的 dsh', async () => {
    const winDir = await mkdtemp(join(tmpdir(), 'fake-win-dsh-'));
    const wslDir = await mkdtemp(join(tmpdir(), 'fake-wsl-dsh-'));
    dirs.push(winDir, wslDir);

    const winDsh = join(winDir, 'dsh');
    await writeFile(winDsh, '#!/bin/sh\necho "win addon missing" >&2\nexit 1\n');
    await chmod(winDsh, 0o755);

    const wslDsh = join(wslDir, 'dsh');
    await writeFile(wslDsh, FAKE_DSH);
    await chmod(wslDsh, 0o755);

    const { verifyExecutableFile } = await import('../src/runtime/locate.ts');
    const winStat = await verifyExecutableFile(winDsh, process.platform);
    const cacheUpdates: unknown[] = [];

    const manager = new RuntimeManager({
      getConfig: () => ({
        profile: 'web',
        cwd: wslDir,
        env: { ...process.env, PATH: `${winDir}:${wslDir}:${process.env.PATH ?? ''}`, FAKE_DSH_MODE: 'ok' },
        readyTimeoutMs: 5_000,
        isWsl: true,
        wslMountRoots: [winDir],
        cachedExecutable: {
          command: winDsh,
          version: '0.2.1-rc.5',
          mtimeMs: winStat?.mtimeMs,
          size: winStat?.size,
        },
        onResolvedExecutable: (info) => {
          cacheUpdates.push(info);
        },
      }),
      log: () => undefined,
    });
    managers.push(manager);

    const endpoint = await manager.start();
    expect(endpoint?.version).toBe('0.2.1-rc.5');
    expect(cacheUpdates[0]).toBeUndefined();
    expect(cacheUpdates.at(-1)).toMatchObject({ command: wslDsh, version: '0.2.1-rc.5' });
  });
});

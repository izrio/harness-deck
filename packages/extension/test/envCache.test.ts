import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandSpecForProfile,
  isAutoDetectedCommandSpec,
  isBackendEnvCacheComplete,
  parseBackendEnvCache,
  type CachedExecutableRecord,
  type PersistedBackendEnvCache,
} from '../src/backend/envCache.ts';
import { builtinProfiles, DSH_PROFILE } from '../src/backend/profiles.ts';
import { verifyExecutableFile } from '../src/runtime/locate.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('BackendEnvCache 与可执行文件缓存校验', () => {
  const sampleProfiles = [DSH_PROFILE, ...builtinProfiles(() => 'hint')];

  it('序列化与解析缓存快照，跨平台不一致或格式非法时自动丢弃', () => {
    const valid: PersistedBackendEnvCache = {
      schemaVersion: 1,
      platform: 'linux',
      updatedAt: 123456,
      nodeEnv: { checked: true, hasNode: true, hasNpm: true, nodeVersion: 'v22.22.2', npmVersion: '10.9.2' },
      npmCommand: '/usr/bin/npm',
      npmGlobalBin: '/opt/npm/bin',
      availability: { dsh: false, codebuddy: true },
      installedVersions: { codebuddy: '2.1.0' },
      availableVersions: { codebuddy: ['2.1.0', '2.0.0'] },
      executables: {
        codebuddy: {
          commandSpec: 'acp::codebuddy',
          command: '/opt/npm/bin/codebuddy',
          version: '2.1.0',
          mtimeMs: 1000,
          size: 512,
        },
      },
    };

    expect(parseBackendEnvCache(valid, 'linux')).toEqual(valid);
    expect(parseBackendEnvCache(valid, 'win32')).toBeUndefined();
    expect(parseBackendEnvCache({ schemaVersion: 2, platform: 'linux' }, 'linux')).toBeUndefined();
    expect(parseBackendEnvCache(null, 'linux')).toBeUndefined();
  });

  it('isBackendEnvCacheComplete 校验所有底层是否已探测且命令签名未变', () => {
    const availability = new Map<string, boolean>(sampleProfiles.map((p) => [p.id, p.id === 'codebuddy']));
    const executables = new Map<string, CachedExecutableRecord>([
      [
        'codebuddy',
        {
          commandSpec: commandSpecForProfile(sampleProfiles.find((p) => p.id === 'codebuddy')!),
          command: '/usr/local/bin/codebuddy',
        },
      ],
    ]);

    expect(
      isBackendEnvCacheComplete(
        {
          nodeEnv: { checked: true, hasNode: true, hasNpm: true },
          availability,
          executables,
        },
        sampleProfiles,
        '',
      ),
    ).toBe(true);

    // 未完成首次检测时返回 false
    expect(
      isBackendEnvCacheComplete(
        {
          nodeEnv: { checked: false, hasNode: false, hasNpm: false },
          availability,
          executables,
        },
        sampleProfiles,
        '',
      ),
    ).toBe(false);

    // 新增自定义智能体尚未探测时返回 false
    expect(
      isBackendEnvCacheComplete(
        {
          nodeEnv: { checked: true, hasNode: true, hasNpm: true },
          availability,
          executables,
        },
        [...sampleProfiles, { id: 'gemini', kind: 'acp', name: 'Gemini', command: 'gemini', args: [], env: {} }],
        '',
      ),
    ).toBe(false);

    // 修改了缓存项对应的命令签名时返回 false
    executables.set('dsh', { commandSpec: 'dsh::/old/dsh', command: '/old/dsh' });
    expect(
      isBackendEnvCacheComplete(
        {
          nodeEnv: { checked: true, hasNode: true, hasNpm: true },
          availability,
          executables,
        },
        sampleProfiles,
        '/new/dsh',
      ),
    ).toBe(false);
  });

  it('verifyExecutableFile 快速校验缓存路径并返回文件元数据，删除后自动失效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-exec-cache-'));
    dirs.push(dir);
    const bin = join(dir, process.platform === 'win32' ? 'codebuddy.cmd' : 'codebuddy');
    await writeFile(bin, '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') await chmod(bin, 0o755);

    const verified = await verifyExecutableFile(bin, process.platform);
    expect(verified?.command).toBe(bin);
    expect(typeof verified?.mtimeMs).toBe('number');
    expect((verified?.size ?? 0) > 0).toBe(true);

    await rm(bin);
    expect(await verifyExecutableFile(bin, process.platform)).toBeUndefined();
  });

  it('WSL 环境下自动丢弃旧版未隔离缓存及指向 Windows 挂载路径的缓存项', () => {
    expect(isAutoDetectedCommandSpec('dsh::')).toBe(true);
    expect(isAutoDetectedCommandSpec('dsh::/mnt/c/custom/dsh')).toBe(false);
    expect(isAutoDetectedCommandSpec('acp::codebuddy')).toBe(true);
    expect(isAutoDetectedCommandSpec('acp::/usr/local/bin/codebuddy')).toBe(false);
    expect(isAutoDetectedCommandSpec('claude::')).toBe(true);

    const legacyWsl: PersistedBackendEnvCache = {
      schemaVersion: 1,
      platform: 'linux',
      updatedAt: 123456,
      nodeEnv: { checked: true, hasNode: true, hasNpm: true },
      npmCommand: '/usr/bin/npm',
      npmGlobalBin: '/usr/local/bin',
      availability: { dsh: true },
      installedVersions: {},
      availableVersions: {},
      executables: {
        dsh: { commandSpec: 'dsh::', command: '/usr/local/bin/dsh' },
      },
    };
    // 缺少 wslIsolated 标记的旧缓存在 WSL 中失效，触发重新检测
    expect(parseBackendEnvCache(legacyWsl, 'linux', { isWsl: true })).toBeUndefined();

    // 带 wslIsolated 且全部为 WSL 路径时保留
    const cleanWsl: PersistedBackendEnvCache = { ...legacyWsl, wslIsolated: true };
    expect(parseBackendEnvCache(cleanWsl, 'linux', { isWsl: true })).toEqual(cleanWsl);

    // 即使带 wslIsolated，只要包含自动探测到的 /mnt/c/... 可执行文件或 Windows npm 路径即失效
    const pollutedDsh: PersistedBackendEnvCache = {
      ...cleanWsl,
      executables: {
        dsh: { commandSpec: 'dsh::', command: '/mnt/c/Users/longc/nvm/nodejs/dsh' },
      },
    };
    expect(parseBackendEnvCache(pollutedDsh, 'linux', { isWsl: true })).toBeUndefined();

    const pollutedNpm: PersistedBackendEnvCache = {
      ...cleanWsl,
      npmCommand: '/mnt/c/Users/longc/nvm/nodejs/npm',
    };
    expect(parseBackendEnvCache(pollutedNpm, 'linux', { isWsl: true })).toBeUndefined();

    // 用户显式配置的绝对路径不受自动探测路径过滤影响
    const explicitPath: PersistedBackendEnvCache = {
      ...cleanWsl,
      executables: {
        dsh: { commandSpec: 'dsh::/mnt/c/custom/dsh', command: '/mnt/c/custom/dsh' },
      },
    };
    expect(parseBackendEnvCache(explicitPath, 'linux', { isWsl: true })).toEqual(explicitPath);
  });
});

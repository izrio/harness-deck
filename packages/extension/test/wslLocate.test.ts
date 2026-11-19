import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectNodeEnv } from '../src/backend/npmManager.ts';
import { locateClaude } from '../src/claude/locate.ts';
import { locatePi } from '../src/pi/locate.ts';
import { locateDsh, locateExecutable } from '../src/runtime/locate.ts';
import { isWslWindowsPath, parseWslDrvFsMountRoots } from '../src/runtime/wsl.ts';
import { locateZcode } from '../src/zcode/locate.ts';

const dirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function createExec(dir: string, name: string, content = '#!/bin/sh\necho ok\n'): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, content, 'utf8');
  await chmod(file, 0o755);
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('WSL Windows 宿主机挂载路径识别', () => {
  it('从 /proc/mounts 解析 WSL1/WSL2 drvfs 挂载点，排除 /mnt/wsl 与 Linux 分区', () => {
    const sample = [
      '/dev/sdd / ext4 rw,relatime,discard 0 0',
      'tmpfs /mnt/wsl tmpfs rw,relatime 0 0',
      'none /mnt/wslg tmpfs rw,relatime 0 0',
      'drvfs /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000 0 0',
      'C:\\ /drives/c drvfs rw,noatime,uid=1000,gid=1000,case=off 0 0',
      'D:\\ /mnt/my\\040drive 9p rw,aname=drvfs;path=D:\\ 0 0',
    ].join('\n');

    expect(parseWslDrvFsMountRoots(sample)).toEqual(['/mnt/c', '/drives/c', '/mnt/my drive']);
  });

  it('准确区分 Windows 盘符挂载路径与 WSL 内部路径', () => {
    expect(isWslWindowsPath('/mnt/c/Users/longc/nvm/nodejs/dsh', [])).toBe(true);
    expect(isWslWindowsPath('/mnt/D/tools/claude', [])).toBe(true);
    expect(isWslWindowsPath('/mnt/c', [])).toBe(true);

    expect(isWslWindowsPath('/mnt/wsl/docker-desktop', [])).toBe(false);
    expect(isWslWindowsPath('/mnt/wslg/runtime-dir', [])).toBe(false);
    expect(isWslWindowsPath('/mnt/data/bin/dsh', [])).toBe(false);
    expect(isWslWindowsPath('/usr/local/bin/dsh', [])).toBe(false);
    expect(isWslWindowsPath('/home/izrio/.local/bin/claude', [])).toBe(false);

    // 支持自定义 automount.root
    expect(isWslWindowsPath('/drives/c/Users/foo/dsh', ['/drives/c'])).toBe(true);
    expect(isWslWindowsPath('/drives/cache/dsh', ['/drives/c'])).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('WSL 环境下仅检测 WSL 内部的外部智能体与 Node/npm', () => {
  it('只有 Windows 挂载目录存在命令时，WSL 自动探测全部返回未安装', async () => {
    const winDir = await makeTempDir('hd-win-mount-');
    const emptyHome = await makeTempDir('hd-wsl-home-');
    for (const cmd of ['dsh', 'claude', 'pi', 'zcode', 'codebuddy', 'opencode', 'node', 'npm']) {
      await createExec(winDir, cmd);
    }

    const env = { PATH: winDir, HOME: emptyHome, WSL_DISTRO_NAME: 'Ubuntu' };
    const wslOpts = { env, platform: 'linux' as const, isWsl: true, wslMountRoots: [winDir] };

    expect(await locateDsh(wslOpts)).toEqual({ kind: 'notFound', configuredPathInvalid: false });
    expect(await locateClaude(wslOpts)).toEqual({ kind: 'notFound', configuredPathInvalid: false });
    expect(await locatePi(wslOpts)).toEqual({ kind: 'notFound', configuredPathInvalid: false });
    expect(await locateZcode(wslOpts)).toEqual({ kind: 'notFound', configuredPathInvalid: false });
    expect(await locateExecutable('codebuddy', wslOpts)).toEqual({ kind: 'notFound', configuredPathInvalid: false });
    expect(await locateExecutable('opencode', wslOpts)).toEqual({ kind: 'notFound', configuredPathInvalid: false });

    const nodeEnv = await detectNodeEnv(wslOpts);
    expect(nodeEnv.state).toEqual({ checked: true, hasNode: false, hasNpm: false });
    expect(nodeEnv.nodeCommand).toBeUndefined();
    expect(nodeEnv.npmCommand).toBeUndefined();

    // 非 WSL 普通 Linux 不跳过该目录
    const nonWsl = await locateDsh({ env, platform: 'linux', isWsl: false, wslMountRoots: [winDir] });
    expect(nonWsl).toEqual({ kind: 'found', command: join(winDir, 'dsh'), source: 'path' });
  });

  it('PATH 中 Windows 目录排在前面时，WSL 自动跳过并命中后面的 WSL 原生智能体', async () => {
    const winDir = await makeTempDir('hd-win-mount-');
    const wslDir = await makeTempDir('hd-wsl-bin-');
    const emptyHome = await makeTempDir('hd-wsl-home-');

    for (const cmd of ['dsh', 'claude', 'pi', 'zcode', 'codebuddy']) {
      await createExec(winDir, cmd);
      await createExec(wslDir, cmd);
    }
    await createExec(winDir, 'node', '#!/bin/sh\necho v20.19.5\n');
    await createExec(wslDir, 'node', '#!/bin/sh\necho v24.9.0\n');
    await createExec(winDir, 'npm', '#!/bin/sh\necho 10.0.0\n');
    await createExec(
      wslDir,
      'npm',
      `#!/bin/sh
case "$1" in
  --version) echo "11.0.0" ;;
  prefix) echo "${wslDir}" ;;
esac
`,
    );

    const env = { PATH: `${winDir}:${wslDir}`, HOME: emptyHome, WSL_DISTRO_NAME: 'Ubuntu' };
    const wslOpts = { env, platform: 'linux' as const, isWsl: true, wslMountRoots: [winDir] };

    expect(await locateDsh(wslOpts)).toEqual({ kind: 'found', command: join(wslDir, 'dsh'), source: 'path' });
    expect(await locateClaude(wslOpts)).toEqual({ kind: 'found', command: join(wslDir, 'claude'), source: 'path' });
    expect(await locatePi(wslOpts)).toEqual({ kind: 'found', command: join(wslDir, 'pi'), source: 'path' });
    expect(await locateZcode(wslOpts)).toMatchObject({ kind: 'found', command: join(wslDir, 'zcode'), source: 'path' });
    expect(await locateExecutable('codebuddy', wslOpts)).toEqual({
      kind: 'found',
      command: join(wslDir, 'codebuddy'),
      source: 'path',
    });

    const nodeEnv = await detectNodeEnv(wslOpts);
    expect(nodeEnv.state).toEqual({
      checked: true,
      hasNode: true,
      hasNpm: true,
      nodeVersion: 'v24.9.0',
      npmVersion: '11.0.0',
    });
    expect(nodeEnv.nodeCommand).toBe(join(wslDir, 'node'));
    expect(nodeEnv.npmCommand).toBe(join(wslDir, 'npm'));
    expect(nodeEnv.npmGlobalBin).toBe(join(wslDir, 'bin'));
  });

  it('WSL 中位于 Linux 目录但软链接指向 Windows 挂载路径的可执行文件也会被跳过', async () => {
    const winDir = await makeTempDir('hd-win-mount-');
    const linkDir = await makeTempDir('hd-wsl-link-');
    const winBin = await createExec(winDir, 'dsh');
    await symlink(winBin, join(linkDir, 'dsh'));

    const res = await locateDsh({
      env: { PATH: linkDir, WSL_DISTRO_NAME: 'Ubuntu' },
      platform: 'linux',
      isWsl: true,
      wslMountRoots: [winDir],
    });
    expect(res).toEqual({ kind: 'notFound', configuredPathInvalid: false });
  });

  it('WSL 中若 npm prefix -g 指向 Windows 挂载目录，不会污染 npmGlobalBin', async () => {
    const winDir = await makeTempDir('hd-win-mount-');
    const wslDir = await makeTempDir('hd-wsl-bin-');
    await createExec(wslDir, 'node', '#!/bin/sh\necho v24.9.0\n');
    await createExec(
      wslDir,
      'npm',
      `#!/bin/sh
case "$1" in
  --version) echo "11.0.0" ;;
  prefix) echo "${winDir}" ;;
esac
`,
    );

    const nodeEnv = await detectNodeEnv({
      env: { PATH: wslDir, WSL_DISTRO_NAME: 'Ubuntu' },
      platform: 'linux',
      isWsl: true,
      wslMountRoots: [winDir],
    });
    expect(nodeEnv.state.hasNpm).toBe(true);
    expect(nodeEnv.npmGlobalBin).toBeUndefined();
  });
});

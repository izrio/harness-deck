import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectNodeEnv,
  envWithExtraPath,
  fetchNpmVersions,
  installNpmPackage,
  isValidNpmVersion,
  listNpmGlobalPackages,
  parseNpmGlobalList,
  parseNpmVersionsOutput,
  uninstallNpmPackage,
} from '../src/backend/npmManager.ts';
import { DSH_PROFILE, npmPackageFor, profileView } from '../src/backend/profiles.ts';

const tempDirs: string[] = [];

async function makeTempBinDir(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-npm-test-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(scripts)) {
    const file = join(dir, name);
    await writeFile(file, content, 'utf8');
    await chmod(file, 0o755);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('npmManager 纯函数', () => {
  it('校验 npm 版本号格式并拒绝非法参数', () => {
    expect(isValidNpmVersion('0.2.2-alpha.3')).toBe(true);
    expect(isValidNpmVersion('1.0.0')).toBe(true);
    expect(isValidNpmVersion('latest')).toBe(true);
    expect(isValidNpmVersion('--registry=http://evil')).toBe(false);
    expect(isValidNpmVersion('1.0.0 && rm -rf /')).toBe(false);
    expect(isValidNpmVersion('')).toBe(false);
    expect(isValidNpmVersion('../x')).toBe(false);
  });

  it('解析 npm list -g --depth=0 --json 输出', () => {
    expect(
      parseNpmGlobalList(
        JSON.stringify({
          dependencies: {
            '@deepseek-ai/dsh': { version: '0.2.2-alpha.3' },
            '@tencent-ai/codebuddy-code': { version: '2.181.0' },
            broken: {},
          },
        }),
      ),
    ).toEqual({
      '@deepseek-ai/dsh': '0.2.2-alpha.3',
      '@tencent-ai/codebuddy-code': '2.181.0',
    });
    expect(parseNpmGlobalList('not-json')).toEqual({});
  });

  it('解析 npm view versions 输出并倒序去重', () => {
    expect(parseNpmVersionsOutput('["0.1.0","0.2.0","0.2.0","0.3.0-rc.1"]')).toEqual(['0.3.0-rc.1', '0.2.0', '0.1.0']);
    expect(parseNpmVersionsOutput('"1.0.0"')).toEqual(['1.0.0']);
    expect(parseNpmVersionsOutput('')).toEqual([]);
  });

  it('补充 PATH 目录时不重复添加', () => {
    const updated = envWithExtraPath({ PATH: '/usr/bin:/bin' }, '/opt/npm/bin', 'linux');
    expect(updated.PATH).toBe('/opt/npm/bin:/usr/bin:/bin');
    expect(envWithExtraPath(updated, '/opt/npm/bin', 'linux').PATH).toBe('/opt/npm/bin:/usr/bin:/bin');

    const win = envWithExtraPath({ Path: 'C:\\Windows\\System32;C:\\npm' }, 'c:\\npm', 'win32');
    expect(win.Path).toBe('C:\\Windows\\System32;C:\\npm');
  });

  it('profileView 附带 npmPackage 和版本、繁忙状态', () => {
    expect(npmPackageFor('dsh')).toBe('@deepseek-ai/dsh');
    expect(npmPackageFor('custom')).toBeUndefined();
    expect(
      profileView(DSH_PROFILE, {
        available: true,
        version: '0.2.2-alpha.3',
        versions: ['0.2.2-alpha.3', '0.2.1'],
        busy: 'switching',
      }),
    ).toMatchObject({
      id: 'dsh',
      available: true,
      version: '0.2.2-alpha.3',
      npmPackage: '@deepseek-ai/dsh',
      versions: ['0.2.2-alpha.3', '0.2.1'],
      busy: 'switching',
    });
  });
});

describe('Node / npm 探测与包管理执行', () => {
  it('PATH 中没有 node 和 npm 时返回未安装状态', async () => {
    const emptyDir = await makeTempBinDir({});
    const res = await detectNodeEnv({ env: { PATH: emptyDir }, platform: 'linux' });
    expect(res.state).toEqual({ checked: true, hasNode: false, hasNpm: false });
    expect(res.npmCommand).toBeUndefined();
  });

  it('PATH 中只有 node 没有 npm 时准确区分', async () => {
    const dir = await makeTempBinDir({
      node: '#!/bin/sh\necho v22.22.2\n',
    });
    const res = await detectNodeEnv({ env: { PATH: dir }, platform: 'linux' });
    expect(res.state).toEqual({
      checked: true,
      hasNode: true,
      hasNpm: false,
      nodeVersion: 'v22.22.2',
    });
  });

  it('存在 node 和 npm 时读出版本号、全局包和可用版本，并执行安装/卸载', async () => {
    const logFile = join(await makeTempBinDir({}), 'npm-calls.log');
    const dir = await makeTempBinDir({
      node: '#!/bin/sh\necho v22.22.2\n',
      npm: `#!/bin/sh
echo "$@" >> "${logFile}"
case "$1" in
  --version) echo "10.9.2" ;;
  prefix) echo "/opt/npm-global" ;;
  list) echo '{"dependencies":{"@deepseek-ai/dsh":{"version":"0.2.1"}}}' ;;
  view) echo '["0.2.0","0.2.1","0.2.2"]' ;;
  install) echo "added 1 package" ;;
  uninstall) echo "removed 1 package" ;;
esac
`,
    });

    const detected = await detectNodeEnv({ env: { PATH: dir }, platform: 'linux' });
    expect(detected.state).toEqual({
      checked: true,
      hasNode: true,
      hasNpm: true,
      nodeVersion: 'v22.22.2',
      npmVersion: '10.9.2',
    });
    expect(detected.npmGlobalBin).toBe('/opt/npm-global/bin');

    const npmCmd = detected.npmCommand!;
    expect(await listNpmGlobalPackages(npmCmd, { PATH: dir }, 'linux')).toEqual({
      '@deepseek-ai/dsh': '0.2.1',
    });
    expect(await fetchNpmVersions(npmCmd, '@deepseek-ai/dsh', { PATH: dir }, 'linux')).toEqual(['0.2.2', '0.2.1', '0.2.0']);

    const logs: string[] = [];
    const installRes = await installNpmPackage(npmCmd, '@deepseek-ai/dsh', '0.2.2', { PATH: dir }, 'linux', (l) => logs.push(l));
    expect(installRes).toEqual({ ok: true });
    expect(logs.some((l) => l.includes('npm install -g @deepseek-ai/dsh@0.2.2'))).toBe(true);

    const badRes = await installNpmPackage(npmCmd, '@deepseek-ai/dsh', '--evil', { PATH: dir }, 'linux');
    expect(badRes.ok).toBe(false);

    const uninstallRes = await uninstallNpmPackage(npmCmd, '@deepseek-ai/dsh', { PATH: dir }, 'linux', (l) => logs.push(l));
    expect(uninstallRes).toEqual({ ok: true });
  });
});

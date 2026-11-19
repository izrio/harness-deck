/**
 * 查找本机的 ZCode 运行时（CLI 可执行文件或 ZCode 桌面端内置的 `zcode.cjs`）：
 * 1. 设置项 `harnessDeck.zcode.path` 或环境变量 `ZCODE_BIN`
 * 2. PATH（以及 `~/.zcode/bin`、`~/.local/bin`）中的 `zcode` 命令
 * 3. ZCode 官方桌面客户端默认安装目录里的 `resources/glm/zcode.cjs`
 */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { locateExecutable, verifyExecutableFile } from '../runtime/locate.ts';

export interface LocateZcodeOptions {
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** 当目标为 `.cjs`/`.js` 脚本且 PATH 中未安装独立 `node` 时，退回使用的宿主 Node（如 VS Code 的 `process.execPath`）。 */
  readonly fallbackNodePath?: string;
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}

export type LocateZcodeResult =
  | {
      readonly kind: 'found';
      /** 实际传给 spawn 的可执行文件（直接是 `zcode`，或 `node`）。 */
      readonly command: string;
      /** 放在 `app-server --stdio` 前面的前缀参数（若是脚本则为 `[scriptPath]`，否则为空）。 */
      readonly scriptArgs: readonly string[];
      /** 启动时需附加的环境变量（例如用 Electron 宿主充当 Node 时设 `ELECTRON_RUN_AS_NODE=1`）。 */
      readonly extraEnv: Readonly<Record<string, string>>;
      /** 用于缓存校验与状态展示的目标文件路径（脚本路径或可执行文件路径）。 */
      readonly targetPath: string;
      readonly source: 'setting' | 'path' | 'desktop';
    }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

function isNodeScript(filePath: string): boolean {
  return /\.(cjs|mjs|js)$/iu.test(filePath.trim());
}

async function isReadableFile(filePath: string): Promise<boolean> {
  const trimmed = filePath.trim();
  if (!trimmed) return false;
  try {
    const info = await stat(trimmed);
    if (!info.isFile()) return false;
    await access(trimmed, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function verifyZcodeTarget(
  targetPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<{ readonly mtimeMs: number; readonly size: number } | undefined> {
  const trimmed = targetPath?.trim();
  if (!trimmed) return undefined;
  if (isNodeScript(trimmed)) {
    try {
      const info = await stat(trimmed);
      if (!info.isFile()) return undefined;
      await access(trimmed, constants.R_OK);
      return { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return undefined;
    }
  }
  const verified = await verifyExecutableFile(trimmed, platform);
  return verified ? { mtimeMs: verified.mtimeMs, size: verified.size } : undefined;
}

function desktopScriptCandidates(platform: NodeJS.Platform, env: LocateZcodeOptions['env']): string[] {
  const home = platform === 'win32' ? (env.HOME ?? env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  if (platform === 'darwin') {
    return [
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      join(home, 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
      '/Applications/ZCode.app/Contents/Resources/app/zcode.cjs',
    ];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      join(programFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ];
  }
  return [
    '/opt/ZCode/resources/glm/zcode.cjs',
    '/opt/zcode/resources/glm/zcode.cjs',
    '/usr/lib/zcode/resources/glm/zcode.cjs',
    join(home, '.local', 'share', 'zcode', 'resources', 'glm', 'zcode.cjs'),
  ];
}

function augmentedEnvWithCommonDirs(env: LocateZcodeOptions['env'], platform: NodeJS.Platform): Record<string, string | undefined> {
  const home = platform === 'win32' ? (env.HOME ?? env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  const extraDirs =
    platform === 'win32'
      ? [join(home, '.zcode', 'bin')]
      : [join(home, '.zcode', 'bin'), join(home, '.local', 'bin')];
  const key = platform === 'win32' && env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH';
  const current = env.PATH ?? env.Path ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  for (const dir of extraDirs.reverse()) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return { ...env, [key]: parts.join(delimiter) };
}

async function resolveScriptRunner(
  scriptPath: string,
  source: 'setting' | 'desktop',
  options: LocateZcodeOptions,
): Promise<LocateZcodeResult> {
  const nodeLoc = await locateExecutable('node', {
    env: options.env,
    platform: options.platform,
    ...(options.isWsl !== undefined ? { isWsl: options.isWsl } : {}),
    ...(options.wslMountRoots !== undefined ? { wslMountRoots: options.wslMountRoots } : {}),
  });
  if (nodeLoc.kind === 'found') {
    return {
      kind: 'found',
      command: nodeLoc.command,
      scriptArgs: [scriptPath],
      extraEnv: {},
      targetPath: scriptPath,
      source,
    };
  }
  const fallback = options.fallbackNodePath ?? process.execPath;
  if (fallback && (await verifyExecutableFile(fallback, options.platform))) {
    return {
      kind: 'found',
      command: fallback,
      scriptArgs: [scriptPath],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      targetPath: scriptPath,
      source,
    };
  }
  return { kind: 'notFound', configuredPathInvalid: source === 'setting' };
}

export async function locateZcode(options: LocateZcodeOptions): Promise<LocateZcodeResult> {
  const explicit = options.configuredPath?.trim() || options.env.ZCODE_BIN?.trim() || '';
  if (explicit) {
    if (isNodeScript(explicit)) {
      if (await isReadableFile(explicit)) {
        return resolveScriptRunner(explicit, 'setting', options);
      }
      return { kind: 'notFound', configuredPathInvalid: true };
    }
    const located = await locateExecutable('zcode', {
      configuredPath: explicit,
      env: options.env,
      platform: options.platform,
    });
    if (located.kind === 'found') {
      return {
        kind: 'found',
        command: located.command,
        scriptArgs: [],
        extraEnv: {},
        targetPath: located.command,
        source: 'setting',
      };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }

  const searchEnv = augmentedEnvWithCommonDirs(options.env, options.platform);
  const onPath = await locateExecutable('zcode', {
    env: searchEnv,
    platform: options.platform,
    ...(options.isWsl !== undefined ? { isWsl: options.isWsl } : {}),
    ...(options.wslMountRoots !== undefined ? { wslMountRoots: options.wslMountRoots } : {}),
  });
  if (onPath.kind === 'found') {
    return {
      kind: 'found',
      command: onPath.command,
      scriptArgs: [],
      extraEnv: {},
      targetPath: onPath.command,
      source: 'path',
    };
  }

  for (const candidate of desktopScriptCandidates(options.platform, options.env)) {
    if (await isReadableFile(candidate)) {
      return resolveScriptRunner(candidate, 'desktop', options);
    }
  }

  return { kind: 'notFound', configuredPathInvalid: false };
}

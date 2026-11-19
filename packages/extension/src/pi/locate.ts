/**
 * 查找本机的 Pi Coding Agent CLI（`pi`）：
 * 1. 设置项 `harnessDeck.pi.path` 或环境变量 `PI_BIN` / `PI_PATH`
 * 2. PATH 以及常见安装目录（`~/.pi/bin`、`~/.local/bin`、`~/.bun/bin`）中的 `pi` 命令
 */
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { locateExecutable } from '../runtime/locate.ts';

export interface LocatePiOptions {
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}

export type LocatePiResult =
  | {
      readonly kind: 'found';
      readonly command: string;
      readonly source: 'setting' | 'path';
    }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

function augmentedEnvWithPiDirs(
  env: LocatePiOptions['env'],
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const home = platform === 'win32' ? (env.HOME ?? env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  const extraDirs = [
    join(home, '.pi', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
  ];
  const key = platform === 'win32' && env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH';
  const current = env.PATH ?? env.Path ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  for (const dir of [...extraDirs].reverse()) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return { ...env, [key]: parts.join(delimiter) };
}

export async function locatePi(options: LocatePiOptions): Promise<LocatePiResult> {
  const explicit = options.configuredPath?.trim() || options.env.PI_BIN?.trim() || options.env.PI_PATH?.trim() || '';
  if (explicit) {
    const located = await locateExecutable('pi', {
      configuredPath: explicit,
      env: options.env,
      platform: options.platform,
    });
    if (located.kind === 'found') {
      return { kind: 'found', command: located.command, source: 'setting' };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }

  const searchEnv = augmentedEnvWithPiDirs(options.env, options.platform);
  const onPath = await locateExecutable('pi', {
    env: searchEnv,
    platform: options.platform,
    ...(options.isWsl !== undefined ? { isWsl: options.isWsl } : {}),
    ...(options.wslMountRoots !== undefined ? { wslMountRoots: options.wslMountRoots } : {}),
  });
  if (onPath.kind === 'found') {
    return { kind: 'found', command: onPath.command, source: 'path' };
  }
  return { kind: 'notFound', configuredPathInvalid: false };
}

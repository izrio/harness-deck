/**
 * 查找本机的 OpenAI Codex CLI（`codex`）：
 * 1. 设置项 `harnessDeck.codex.path` 或环境变量 `CODEX_BIN` / `CODEX_PATH`
 * 2. PATH 以及常见安装目录（`~/.codex/bin`、`~/.local/bin`、`~/.bun/bin`）中的 `codex` 命令
 */
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { locateExecutable } from '../runtime/locate.ts';

export interface LocateCodexOptions {
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}

export type LocateCodexResult =
  | {
      readonly kind: 'found';
      readonly command: string;
      readonly source: 'setting' | 'path';
    }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

function augmentedEnvWithCodexDirs(
  env: LocateCodexOptions['env'],
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const home = platform === 'win32' ? (env.HOME ?? env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  const extraDirs = [
    join(home, '.codex', 'bin'),
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

export async function locateCodex(options: LocateCodexOptions): Promise<LocateCodexResult> {
  const explicit =
    options.configuredPath?.trim() || options.env.CODEX_BIN?.trim() || options.env.CODEX_PATH?.trim() || '';
  if (explicit) {
    const located = await locateExecutable('codex', {
      configuredPath: explicit,
      env: options.env,
      platform: options.platform,
    });
    if (located.kind === 'found') {
      return { kind: 'found', command: located.command, source: 'setting' };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }

  const searchEnv = augmentedEnvWithCodexDirs(options.env, options.platform);
  const onPath = await locateExecutable('codex', {
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

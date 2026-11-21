/**
 * 查找本机的 CodeBuddy CLI（`codebuddy` / `cbc`）：
 * 1. 设置项 `harnessDeck.codebuddy.path` 或环境变量 `CODEBUDDY_BIN` / `CODEBUDDY_CODE_PATH`
 * 2. PATH 以及常见安装位置（`~/.local/bin`、`~/.codebuddy/bin`、`~/.codebuddy/local`）中的 `codebuddy` / `cbc` 命令
 */
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { locateExecutable } from '../runtime/locate.ts';

export interface LocateCodebuddyOptions {
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}

export type LocateCodebuddyResult =
  | {
      readonly kind: 'found';
      readonly command: string;
      readonly source: 'setting' | 'path';
    }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

function augmentedEnvWithCodebuddyDirs(
  env: LocateCodebuddyOptions['env'],
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const home = platform === 'win32' ? (env.HOME ?? env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  const extraDirs =
    platform === 'win32'
      ? [
          join(home, '.local', 'bin'),
          join(home, '.codebuddy', 'bin'),
          join(home, '.codebuddy', 'local'),
          ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'codebuddy'), join(env.LOCALAPPDATA, 'codebuddy')] : []),
        ]
      : [
          join(home, '.local', 'bin'),
          join(home, '.codebuddy', 'bin'),
          join(home, '.codebuddy', 'local'),
        ];
  const key = platform === 'win32' && env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH';
  const current = env.PATH ?? env.Path ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  for (const dir of [...extraDirs].reverse()) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return { ...env, [key]: parts.join(delimiter) };
}

export async function locateCodebuddy(options: LocateCodebuddyOptions): Promise<LocateCodebuddyResult> {
  const explicit =
    options.configuredPath?.trim() ||
    options.env.CODEBUDDY_BIN?.trim() ||
    options.env.CODEBUDDY_CODE_PATH?.trim() ||
    '';
  if (explicit) {
    const located = await locateExecutable('codebuddy', {
      configuredPath: explicit,
      env: options.env,
      platform: options.platform,
    });
    if (located.kind === 'found') {
      return { kind: 'found', command: located.command, source: 'setting' };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }

  const searchEnv = augmentedEnvWithCodebuddyDirs(options.env, options.platform);
  for (const binName of ['codebuddy', 'cbc'] as const) {
    const onPath = await locateExecutable(binName, {
      env: searchEnv,
      platform: options.platform,
      ...(options.isWsl !== undefined ? { isWsl: options.isWsl } : {}),
      ...(options.wslMountRoots !== undefined ? { wslMountRoots: options.wslMountRoots } : {}),
    });
    if (onPath.kind === 'found') {
      return { kind: 'found', command: onPath.command, source: 'path' };
    }
  }
  return { kind: 'notFound', configuredPathInvalid: false };
}

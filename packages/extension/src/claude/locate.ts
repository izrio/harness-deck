/**
 * 查找本机的 Claude Code CLI（`claude`）：
 * 1. 设置项 `harnessDeck.claude.path` 或环境变量 `CLAUDE_BIN` / `CLAUDE_CODE_PATH`
 * 2. PATH 以及常见安装位置（`~/.local/bin`、`~/.claude/local`、`~/.claude/bin`）中的 `claude` 命令
 */
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { locateExecutable } from '../runtime/locate.ts';

export interface LocateClaudeOptions {
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}

export type LocateClaudeResult =
  | {
      readonly kind: 'found';
      readonly command: string;
      readonly source: 'setting' | 'path';
    }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

function augmentedEnvWithClaudeDirs(
  env: LocateClaudeOptions['env'],
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const home = platform === 'win32' ? (env.HOME ?? env.USERPROFILE ?? homedir()) : (env.HOME ?? homedir());
  const extraDirs =
    platform === 'win32'
      ? [
          join(home, '.local', 'bin'),
          join(home, '.claude', 'local'),
          join(home, '.claude', 'bin'),
          ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'claude'), join(env.LOCALAPPDATA, 'claude')] : []),
        ]
      : [
          join(home, '.local', 'bin'),
          join(home, '.claude', 'local'),
          join(home, '.claude', 'bin'),
        ];
  const key = platform === 'win32' && env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH';
  const current = env.PATH ?? env.Path ?? '';
  const parts = current.split(delimiter).filter(Boolean);
  for (const dir of [...extraDirs].reverse()) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return { ...env, [key]: parts.join(delimiter) };
}

export async function locateClaude(options: LocateClaudeOptions): Promise<LocateClaudeResult> {
  const explicit =
    options.configuredPath?.trim() ||
    options.env.CLAUDE_BIN?.trim() ||
    options.env.CLAUDE_CODE_PATH?.trim() ||
    '';
  if (explicit) {
    const located = await locateExecutable('claude', {
      configuredPath: explicit,
      env: options.env,
      platform: options.platform,
    });
    if (located.kind === 'found') {
      return { kind: 'found', command: located.command, source: 'setting' };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }

  const searchEnv = augmentedEnvWithClaudeDirs(options.env, options.platform);
  const onPath = await locateExecutable('claude', {
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

/**
 * 查找 dsh 可执行文件。顺序见 docs/DESIGN.md 6.1：
 * 1. 设置项 `harnessDeck.dsh.path`
 * 2. PATH 中的 `dsh`（DeepSeek Desktop 安装的命令，或 npm 全局安装）
 */
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { isWslEnvironment, isWslWindowsPath } from './wsl.ts';

export interface LocateOptions {
  /** 用户在设置里指定的路径；空字符串视为未设置。 */
  readonly configuredPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** 可选覆盖 WSL 判定（主要用于测试）；未传时在 Linux 平台自动判定。 */
  readonly isWsl?: boolean;
  /** 可选覆盖 WSL 下的 Windows 宿主机挂载根列表（主要用于测试）。 */
  readonly wslMountRoots?: readonly string[];
}

export type LocateResult =
  | { readonly kind: 'found'; readonly command: string; readonly source: 'setting' | 'path' }
  | { readonly kind: 'notFound'; readonly configuredPathInvalid: boolean };

export interface ExecutableStat {
  readonly command: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * 校验可执行文件路径是否仍然存在且可执行，成功时返回文件元数据（用于快速命中缓存并检测文件是否更新）。
 */
export async function verifyExecutableFile(
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecutableStat | undefined> {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  try {
    const info = await stat(trimmed);
    if (!info.isFile()) return undefined;
    // Windows 没有可执行位，存在即可
    if (platform !== 'win32') await access(trimmed, constants.X_OK);
    return { command: trimmed, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  return (await verifyExecutableFile(path, platform)) !== undefined;
}

/**
 * 判断候选可执行文件（含软链接目标）是否位于 WSL 挂载的 Windows 宿主机目录下。
 */
export async function isWslWindowsExecutable(
  filePath: string,
  mountRoots?: readonly string[],
): Promise<boolean> {
  if (isWslWindowsPath(filePath, mountRoots)) return true;
  try {
    const resolved = await realpath(filePath);
    return isWslWindowsPath(resolved, mountRoots);
  } catch {
    return false;
  }
}

function candidateNames(name: string, platform: NodeJS.Platform, env: LocateOptions['env']): string[] {
  if (platform !== 'win32') return [name];
  // 已经带扩展名（omp.cmd）时只找这个名字
  if (/\.[a-z0-9]+$/iu.test(name)) return [name];
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return extensions.map((ext) => `${name}${ext}`);
}

/**
 * 查找 dsh。
 * @returns 找到时给出命令路径和来源；设置项指定了但无效时 `configuredPathInvalid` 为 true。
 */
export async function locateDsh(options: LocateOptions): Promise<LocateResult> {
  return locateExecutable('dsh', options);
}

/**
 * 在 PATH（Windows 上加 PATHEXT）里查找可执行文件；`name` 是绝对路径或带目录时直接检查它。
 * 设置项 `configuredPath` 优先；在 WSL 环境中自动扫描 PATH 时跳过 Windows 宿主机挂载路径。
 */
export async function locateExecutable(name: string, options: LocateOptions): Promise<LocateResult> {
  if (isAbsolute(name) || /[\\/]/u.test(name)) {
    return (await isExecutableFile(name, options.platform)) ? { kind: 'found', command: name, source: 'setting' } : { kind: 'notFound', configuredPathInvalid: true };
  }
  const configured = options.configuredPath?.trim();
  if (configured) {
    if (await isExecutableFile(configured, options.platform)) {
      return { kind: 'found', command: configured, source: 'setting' };
    }
    return { kind: 'notFound', configuredPathInvalid: true };
  }
  const inWsl = options.platform === 'linux' && (options.isWsl ?? isWslEnvironment(options.env));
  const pathValue = options.env.PATH ?? options.env.Path ?? '';
  const names = candidateNames(name, options.platform, options.env);
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    if (inWsl && isWslWindowsPath(directory, options.wslMountRoots)) continue;
    for (const candidateName of names) {
      const candidate = join(directory, candidateName);
      if (!(await isExecutableFile(candidate, options.platform))) continue;
      if (inWsl && (await isWslWindowsExecutable(candidate, options.wslMountRoots))) continue;
      return { kind: 'found', command: candidate, source: 'path' };
    }
  }
  return { kind: 'notFound', configuredPathInvalid: false };
}

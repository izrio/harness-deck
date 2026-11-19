/**
 * WSL 环境识别与 Windows 宿主机挂载路径判定。
 *
 * 在 WSL（Linux）中，默认会将 Windows 的 PATH（如 `/mnt/c/Users/.../nvm/nodejs`）追加到 Linux PATH：
 * Windows 侧通过 npm 安装的全局命令通常带有无后缀 POSIX shim，在 WSL 中具备执行权限，
 * 但其原生扩展（`.node`）或二进制属于 Windows 平台，在 WSL 的 Linux Node 下启动会直接崩溃。
 * 因此在 WSL 中自动探测 Node/npm 与各类智能体（dsh、Claude、Pi、ZCode、ACP 等）时，
 * 必须排除挂载自 Windows 宿主机的路径，仅检测 WSL 自身环境内的工具。
 */
import { readFileSync } from 'node:fs';

const DEFAULT_WSL_DRIVE_RE = /^\/mnt\/[a-zA-Z](?:\/|$)/u;
const WINDOWS_DRIVE_DEVICE_RE = /^[A-Za-z]:\\/u;

let cachedProcVersion: string | undefined;
let cachedDrvFsMountRoots: readonly string[] | undefined;

function readProcVersion(): string {
  if (cachedProcVersion !== undefined) return cachedProcVersion;
  try {
    cachedProcVersion = readFileSync('/proc/version', 'utf8');
  } catch {
    cachedProcVersion = '';
  }
  return cachedProcVersion;
}

/** 判断当前是否运行在 WSL 环境中（兼容 WSL1 / WSL2 及启用 WSLg 的情况）。 */
export function isWslEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  procVersion?: string,
): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV) return true;
  const version = procVersion ?? readProcVersion();
  return /microsoft|wsl/iu.test(version);
}

/** 解码 Linux `/proc/mounts` 中的八进制转义（例如空格 `\040`）。 */
function decodeProcMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/gu, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function normalizeMountRoot(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/u, '');
  return trimmed;
}

/** 从 `/proc/mounts` 文本中提取所有 Windows 宿主机驱动器（`drvfs`）的挂载根目录。 */
export function parseWslDrvFsMountRoots(procMounts: string): string[] {
  const roots = new Set<string>();
  for (const line of procMounts.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/u);
    if (parts.length < 4) continue;
    const [device, rawMountPoint, fsType, rawOptions] = parts;
    if (!device || !rawMountPoint || !fsType || !rawOptions) continue;
    const options = rawOptions.split(',');
    const isDrvFs =
      fsType === 'drvfs' ||
      device === 'drvfs' ||
      WINDOWS_DRIVE_DEVICE_RE.test(device) ||
      options.some((opt) => opt === 'aname=drvfs' || opt.startsWith('aname=drvfs;'));
    if (!isDrvFs) continue;
    const mountPoint = normalizeMountRoot(decodeProcMountPath(rawMountPoint));
    if (mountPoint && mountPoint !== '/') {
      roots.add(mountPoint);
    }
  }
  return [...roots];
}

function readWslDrvFsMountRoots(): readonly string[] {
  if (cachedDrvFsMountRoots !== undefined) return cachedDrvFsMountRoots;
  if (process.platform !== 'linux') {
    cachedDrvFsMountRoots = [];
    return cachedDrvFsMountRoots;
  }
  try {
    cachedDrvFsMountRoots = parseWslDrvFsMountRoots(readFileSync('/proc/mounts', 'utf8'));
  } catch {
    cachedDrvFsMountRoots = [];
  }
  return cachedDrvFsMountRoots;
}

/**
 * 判断给定 Linux 路径是否位于 WSL 挂载的 Windows 宿主机文件系统下。
 * 默认识别 `/mnt/<盘符>/...`（不误伤 `/mnt/wsl`、`/mnt/wslg` 等 Linux 内部挂载），
 * 同时兼容通过 `/etc/wsl.conf` 自定义 `automount.root` 产生的 `drvfs` 挂载点。
 */
export function isWslWindowsPath(filePath: string, mountRoots?: readonly string[]): boolean {
  const trimmed = filePath.trim();
  if (!trimmed) return false;
  if (DEFAULT_WSL_DRIVE_RE.test(trimmed)) return true;
  const roots = mountRoots ?? readWslDrvFsMountRoots();
  for (const rawRoot of roots) {
    const root = normalizeMountRoot(rawRoot);
    if (!root || root === '/') continue;
    if (trimmed === root || trimmed.startsWith(`${root}/`)) return true;
  }
  return false;
}

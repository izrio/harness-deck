/**
 * Electron 独立桌面外壳配置与路径解析（P3-11）：
 * 统一解析配置目录、默认打开的项目目录、headless-server 入口路径与窗口持久化几何尺寸。
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DesktopLaunchConfig {
  readonly configRoot: string;
  readonly projectPath: string;
  readonly sidecarEntry: string;
  readonly webviewDistRoot: string;
  readonly globalShortcut: string;
  readonly port: number;
}

export interface WindowBounds {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
}

export const DEFAULT_WINDOW_BOUNDS: WindowBounds = {
  width: 1280,
  height: 820,
};

export const DEFAULT_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+H';

/** 解析桌面端启动参数（支持 CLI 与环境变量覆盖）。 */
export function resolveDesktopConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  baseDir?: string,
): DesktopLaunchConfig {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..');
  const configRoot = env.HARNESS_DECK_CONFIG_ROOT?.trim() || join(homedir(), '.harness-deck-desktop');
  const projectArg = argv.find((a) => !a.startsWith('-'));
  const projectPath = resolve(projectArg || env.HARNESS_DECK_PROJECT?.trim() || process.cwd());
  const sidecarEntry =
    env.HARNESS_DECK_SIDECAR?.trim() || join(repoRoot, 'packages', 'extension', 'dist', 'sidecar.cjs');
  const webviewDistRoot =
    env.HARNESS_DECK_WEBVIEW_DIST?.trim() || join(repoRoot, 'packages', 'extension', 'dist', 'webview');
  const rawPort = Number.parseInt(env.HARNESS_DECK_DESKTOP_PORT ?? '0', 10);
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 0;
  const globalShortcut = env.HARNESS_DECK_SHORTCUT?.trim() || DEFAULT_GLOBAL_SHORTCUT;

  return {
    configRoot,
    projectPath,
    sidecarEntry,
    webviewDistRoot,
    globalShortcut,
    port,
  };
}

/** 校验并钳制持久化的窗口几何尺寸，防止异常 JSON 导致窗口不可见。 */
export function sanitizeWindowBounds(raw: unknown): WindowBounds {
  if (!raw || typeof raw !== 'object') return DEFAULT_WINDOW_BOUNDS;
  const obj = raw as Record<string, unknown>;
  const width =
    typeof obj.width === 'number' && Number.isFinite(obj.width)
      ? Math.max(720, Math.min(3840, Math.round(obj.width)))
      : DEFAULT_WINDOW_BOUNDS.width;
  const height =
    typeof obj.height === 'number' && Number.isFinite(obj.height)
      ? Math.max(520, Math.min(2160, Math.round(obj.height)))
      : DEFAULT_WINDOW_BOUNDS.height;
  const x = typeof obj.x === 'number' && Number.isFinite(obj.x) ? Math.round(obj.x) : undefined;
  const y = typeof obj.y === 'number' && Number.isFinite(obj.y) ? Math.round(obj.y) : undefined;
  return {
    width,
    height,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
  };
}

/** 从 headless-server 输出中提取可访问的本机配对/入口 URL。 */
export function parsePairingUrlFromLog(line: string): string | undefined {
  const match = /pairing URL:\s*(https?:\/\/\S+)/iu.exec(line);
  return match?.[1]?.trim();
}

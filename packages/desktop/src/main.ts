/**
 * Halo 独立桌面客户端主进程（P3-11，Electron 壳）：
 * - 拉起内置 `sidecar.cjs --headless-server` 守护进程，复用全部多底层/多账号/工作台/终端能力；
 * - 提供系统托盘常驻、全局快捷键（默认 Cmd/Ctrl+Shift+H）唤出/隐藏窗口、原生系统通知与窗口尺寸记忆；
 * - 单实例锁保证同一时间只有一个桌面主进程在运行。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from 'electron';
import {
  DEFAULT_WINDOW_BOUNDS,
  parsePairingUrlFromLog,
  resolveDesktopConfig,
  sanitizeWindowBounds,
  type WindowBounds,
} from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

// 打包后 sidecar 与 Webview 静态资源随安装包放在 resources 目录，需显式指向它们；
// 开发态仍按仓库相对路径解析（packages/extension/dist/...）。
if (app.isPackaged) {
  process.env.HARNESS_DECK_SIDECAR ??= join(process.resourcesPath, 'sidecar.cjs');
  process.env.HARNESS_DECK_WEBVIEW_DIST ??= join(process.resourcesPath, 'webview');
}

const config = resolveDesktopConfig();
const windowStatePath = join(config.configRoot, 'desktop-window.json');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverProc: ChildProcess | null = null;
let quitting = false;

async function loadWindowBounds(): Promise<WindowBounds> {
  try {
    const raw = await readFile(windowStatePath, 'utf8');
    return sanitizeWindowBounds(JSON.parse(raw));
  } catch {
    return DEFAULT_WINDOW_BOUNDS;
  }
}

async function saveWindowBounds(win: BrowserWindow): Promise<void> {
  try {
    await mkdir(config.configRoot, { recursive: true });
    await writeFile(windowStatePath, JSON.stringify(win.getBounds(), null, 2), 'utf8');
  } catch {
    // 忽略窗口尺寸持久化失败
  }
}

function startEmbeddedHeadlessServer(): Promise<string> {
  return new Promise((resolveUrl, rejectUrl) => {
    const args = [config.sidecarEntry, '--headless-server', config.configRoot, config.projectPath];
    if (config.port > 0) args.push('--port', String(config.port));
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HARNESS_DECK_WEBVIEW_DIST: config.webviewDistRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    serverProc = child;

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectUrl(new Error('Timed out waiting for Halo headless server to start'));
      }
    }, 20_000);

    const handleChunk = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
        const url = parsePairingUrlFromLog(line);
        if (url && !settled) {
          settled = true;
          clearTimeout(timer);
          resolveUrl(url);
        }
      }
    };

    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectUrl(error);
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectUrl(new Error(`Headless server exited early with code ${String(code ?? 1)}`));
      }
    });
  });
}

function toggleMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function resolveAppIcon(): unknown {
  try {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'media', 'icon.png')
      : join(dirname(config.sidecarEntry), '..', 'media', 'icon.png');
    return nativeImage.createFromPath(iconPath);
  } catch {
    return nativeImage.createEmpty();
  }
}

async function createMainWindow(url: string): Promise<void> {
  const bounds = await loadWindowBounds();
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x } : {}),
    ...(bounds.y !== undefined ? { y: bounds.y } : {}),
    minWidth: 720,
    minHeight: 520,
    title: 'Halo',
    icon: resolveAppIcon(),
    backgroundColor: '#1b1d24',
    webPreferences: {
      // 沙箱化 preload 必须是 CommonJS，由 src/preload.cts 编译为 dist/preload.cjs。
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://') || target.startsWith('http://')) {
      void shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    void saveWindowBounds(win);
    if (!quitting && tray) {
      (event as { preventDefault?: () => void }).preventDefault?.();
      win.hide();
    }
  });

  mainWindow = win;
  await win.loadURL(url);
}

function setupTray(): void {
  try {
    tray = new Tray(resolveAppIcon());
    tray.setToolTip('Halo');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show / Hide Halo', click: () => toggleMainWindow() },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => toggleMainWindow());
  } catch {
    tray = null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.on('hd:notify', (_event, payload: unknown) => {
    if (!Notification.isSupported() || !payload || typeof payload !== 'object') return;
    const { title, body } = payload as { title?: string; body?: string };
    new Notification({ title: title || 'Halo', body: body || '' }).show();
  });

  ipcMain.handle('hd:open-external', (_event, url: unknown) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      return shell.openExternal(url);
    }
    return undefined;
  });

  void app.whenReady().then(async () => {
    setupTray();
    globalShortcut.register(config.globalShortcut, () => toggleMainWindow());
    const entryUrl = await startEmbeddedHeadlessServer();
    await createMainWindow(entryUrl);
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    tray?.destroy();
    if (serverProc && !serverProc.killed) {
      try {
        serverProc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  });
}

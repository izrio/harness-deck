/**
 * 无头调度宿主（HD-18）：没有 IDE、没有 Webview 的常驻进程。
 *
 * 复用 `HarnessHostRuntime` 与 `WorkbenchHub` 的 15 秒定时器；调度规则从 sidecar 的
 * 文件存储读取，执行走 `UnattendedRunner`。进程由 sidecar 以 detached 方式拉起，
 * 因此 IDE 关闭后仍会继续运行；单实例锁避免和 IDE 内的调度重复触发。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostPlatform } from '../host/HostPlatform.ts';
import { createHarnessHostRuntime } from '../host/HarnessHostRuntime.ts';
import { noWorkbench } from '../vm/workbench.ts';
import { FileKeyValueStore, FileSettingsStore, workspaceStateFilePath } from './fileStores.ts';
import { acquireSchedulerLock } from './schedulerLock.ts';

export interface HeadlessSchedulerOptions {
  readonly configRoot: string;
  readonly projectPath: string;
  readonly log?: (line: string) => void;
}

export interface HeadlessSchedulerHandle {
  readonly stop: () => Promise<void>;
}

/**
 * 启动常驻调度。另一个进程已持有锁时返回 undefined（调用方应直接退出）。
 */
export async function runHeadlessScheduler(options: HeadlessSchedulerOptions): Promise<HeadlessSchedulerHandle | undefined> {
  const { configRoot, projectPath } = options;
  const log = options.log ?? (() => undefined);
  await mkdir(join(configRoot, 'storage'), { recursive: true });

  const lock = await acquireSchedulerLock(configRoot);
  if (!lock) {
    log('another headless scheduler is already running');
    return undefined;
  }

  const globalState = await FileKeyValueStore.open(join(configRoot, 'global-state.json'), { watchExternal: true });
  const workspaceState = await FileKeyValueStore.open(workspaceStateFilePath(configRoot, projectPath));
  const settings = await FileSettingsStore.open(join(configRoot, 'settings.json'));
  const secrets = new Map<string, string>();

  const platform: HostPlatform = {
    hostKind: 'jetbrains',
    extensionVersion: 'headless-scheduler',
    storageRoot: join(configRoot, 'storage'),
    schedulerLockDir: configRoot,
    globalState,
    workspaceState,
    settings,
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => void secrets.set(key, value),
      delete: async (key) => void secrets.delete(key),
      onDidChange: () => () => undefined,
    },
    workbench: noWorkbench,
    envLanguage: () => 'en',
    isWorkspaceTrusted: () => true,
    onDidGrantWorkspaceTrust: () => () => undefined,
    isWindowFocused: () => false,
    workspaceFolders: () => [{ name: projectPath.split(/[\\/]/u).pop() ?? projectPath, path: projectPath }],
    postToWebview: () => undefined,
    isWebviewVisible: () => false,
    focusChatView: async () => undefined,
    openWorkbenchPanel: () => undefined,
    log,
    runtimeLog: (line, stream) => log(`[${stream}] ${line}`),
    showLogs: () => undefined,
    openHostSettings: () => undefined,
    onStatusUpdate: () => undefined,
    openExternal: async () => false,
    resolveExternalOrigin: async (origin) => origin,
    writeClipboard: async () => undefined,
    showMessage: async () => undefined,
    pickQuickItem: async () => undefined,
    withCancellableProgress: async (_title, task) => task(() => undefined),
    pickOpenDialog: async () => [],
    openProjectWindow: async () => undefined,
    runInTerminal: async () => undefined,
  };

  const runtime = createHarnessHostRuntime(platform);
  runtime.onViewVisible();
  log(`headless scheduler started for ${projectPath}`);

  let stopped = false;
  const tick = setInterval(() => undefined, 60_000);
  tick.unref?.();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      await runtime.dispose();
      settings.dispose();
      globalState.dispose();
      workspaceState.dispose();
      await lock.release();
      log('headless scheduler stopped');
    },
  };
}

/**
 * Node.js Sidecar 会话服务：把 stdio NDJSON JSON-RPC 通道、`~/.harness-deck` 文件存储与 `HarnessHostRuntime` 连接起来。
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseWebviewMessage } from '@harness-deck/shared';
import { createHarnessHostRuntime, type HarnessHostRuntime } from '../host/HarnessHostRuntime.ts';
import type { HostPlatform, QuickPickOption, WorkspaceFolderItem } from '../host/HostPlatform.ts';
import { FileKeyValueStore, FileSettingsStore, workspaceStateFilePath } from './fileStores.ts';
import {
  createIdeRpcClient,
  editorStateChangedParamsSchema,
  executeCommandParamsSchema,
  JsonRpcPeer,
  sidecarInitParamsSchema,
} from './protocol.ts';
import { RemoteWorkbench } from './RemoteWorkbench.ts';

export interface SidecarSessionHandle {
  readonly dispose: () => Promise<void>;
}

const SCHEDULES_STORAGE_KEY = 'harnessDeck.hub.schedules';

/** 以 detached 进程拉起无头调度；IDE 关闭后它继续运行，单实例锁避免重复。 */
function spawnHeadlessScheduler(configRoot: string, projectPath: string): void {
  const script = process.argv[1];
  if (!script) return;
  try {
    const child = spawn(process.execPath, [script, '--headless-scheduler', configRoot, projectPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    // 后台调度起不来时不影响正常 sidecar；IDE 内的定时器仍会工作。
  }
}

export function startSidecarSession(
  input: Readable,
  output: Writable,
  options: { readonly onShutdown?: () => void } = {},
): SidecarSessionHandle {
  let runtime: HarnessHostRuntime | undefined;
  let globalStateStore: FileKeyValueStore | undefined;
  let workspaceStateStore: FileKeyValueStore | undefined;
  let settingsStore: FileSettingsStore | undefined;
  let workbench: RemoteWorkbench | undefined;
  let webviewVisible = false;
  let windowFocused = true;
  let workspaceTrusted = true;
  let workspaceFolders: WorkspaceFolderItem[] = [];
  let ideLanguage = 'en';
  const trustListeners = new Set<() => void>();
  const secretListeners = new Set<(key: string) => void>();
  const cancelHandlers = new Map<string, () => void>();
  let progressSeq = 0;
  let shuttingDown: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      const rt = runtime;
      runtime = undefined;
      await rt?.dispose().catch(() => undefined);
      settingsStore?.dispose();
      globalStateStore?.dispose();
      workspaceStateStore?.dispose();
      trustListeners.clear();
      secretListeners.clear();
      cancelHandlers.clear();
      options.onShutdown?.();
    })();
    return shuttingDown;
  };

  const peer = new JsonRpcPeer(input, output, {
    onRequest: async (method, params) => {
      if (method === 'sidecar/init') {
        if (runtime) return { ok: true };
        const init = sidecarInitParamsSchema.parse(params ?? {});
        const configRoot = init.configRoot ?? join(homedir(), '.harness-deck');
        const storageRoot = join(configRoot, 'storage');
        await mkdir(storageRoot, { recursive: true });

        ideLanguage = init.ideLanguage;
        workspaceTrusted = init.workspaceTrusted;
        windowFocused = init.windowFocused;
        workspaceFolders =
          init.workspaceFolders.length > 0
            ? init.workspaceFolders
            : [{ name: basename(init.projectPath) || init.projectPath, path: init.projectPath }];

        const [openedGlobal, openedWorkspace, openedSettings] = await Promise.all([
          FileKeyValueStore.open(join(configRoot, 'global-state.json'), { watchExternal: true }),
          FileKeyValueStore.open(workspaceStateFilePath(configRoot, init.projectPath)),
          FileSettingsStore.open(join(configRoot, 'settings.json'), init.httpProxy ?? undefined),
        ]);
        globalStateStore = openedGlobal;
        workspaceStateStore = openedWorkspace;
        settingsStore = openedSettings;

        const ide = createIdeRpcClient(peer);
        workbench = new RemoteWorkbench(ide, init.activeEditor, init.dirtyFiles);

        const platform: HostPlatform = {
          hostKind: 'jetbrains',
          extensionVersion: init.extensionVersion,
          storageRoot,
          schedulerLockDir: configRoot,
          onSchedulesChanged: (hasEnabled) => {
            if (hasEnabled) spawnHeadlessScheduler(configRoot, init.projectPath);
          },
          globalState: openedGlobal,
          workspaceState: openedWorkspace,
          settings: openedSettings,
          secrets: {
            get: (key) => ide.secretGet(key),
            store: async (key, value) => {
              await ide.secretStore(key, value);
              for (const fn of secretListeners) fn(key);
            },
            delete: async (key) => {
              await ide.secretDelete(key);
              for (const fn of secretListeners) fn(key);
            },
            onDidChange: (listener) => {
              secretListeners.add(listener);
              return () => secretListeners.delete(listener);
            },
          },
          workbench,
          envLanguage: () => ideLanguage,
          isWorkspaceTrusted: () => workspaceTrusted,
          onDidGrantWorkspaceTrust: (listener) => {
            trustListeners.add(listener);
            return () => trustListeners.delete(listener);
          },
          isWindowFocused: () => windowFocused,
          workspaceFolders: () => workspaceFolders,
          postToWebview: (message) => ide.postToWebview(message),
          isWebviewVisible: () => webviewVisible,
          focusChatView: () => ide.focusChatView(),
          openWorkbenchPanel: (title) => ide.openWorkbenchPanel(title),
          log: (line) => ide.log('host', line),
          runtimeLog: (line, stream) => ide.log('runtime', line, stream),
          showLogs: () => ide.showLogs(),
          openHostSettings: () => ide.openHostSettings(),
          onStatusUpdate: (snap) => ide.statusUpdate(snap),
          openExternal: (url) => ide.openExternal(url),
          resolveExternalOrigin: (origin) => Promise.resolve(origin),
          writeClipboard: (text) => ide.writeClipboard(text),
          showMessage: (level, message, actions) => ide.showMessage(level, message, actions),
          pickQuickItem: async <T extends QuickPickOption>(
            items: readonly T[],
            pickOpts: { readonly placeHolder: string; readonly ignoreFocusOut?: boolean },
          ): Promise<T | undefined> => {
            const chosenId = await ide.pickQuickItem(
              items.map((item) => ({
                id: item.id,
                label: item.label,
                ...(item.description !== undefined ? { description: item.description } : {}),
                ...(item.detail !== undefined ? { detail: item.detail } : {}),
                ...(item.picked !== undefined ? { picked: item.picked } : {}),
              })),
              pickOpts,
            );
            return chosenId !== undefined ? items.find((item) => item.id === chosenId) : undefined;
          },
          withCancellableProgress: async <T>(
            title: string,
            task: (onCancel: (cb: () => void) => void) => Promise<T>,
          ): Promise<T> => {
            const progressId = `prog-${++progressSeq}`;
            ide.progressStart(progressId, title);
            try {
              return await task((cb) => {
                cancelHandlers.set(progressId, cb);
              });
            } finally {
              cancelHandlers.delete(progressId);
              ide.progressEnd(progressId);
            }
          },
          pickOpenDialog: (dialogOpts) => ide.pickOpenDialog(dialogOpts),
          openProjectWindow: (path) => ide.openProjectWindow(path),
          runInTerminal: (termOpts) => ide.runInTerminal(termOpts),
        };

        runtime = createHarnessHostRuntime(platform);
        const schedules = openedGlobal.get<{ rules?: { enabled?: boolean }[] }>(SCHEDULES_STORAGE_KEY);
        if (schedules?.rules?.some((rule) => rule.enabled !== false)) {
          spawnHeadlessScheduler(configRoot, init.projectPath);
        }
        return { ok: true };
      }

      if (method === 'sidecar/executeCommand') {
        const parsed = executeCommandParamsSchema.parse(params ?? {});
        if (workbench && (parsed.activeEditor !== undefined || parsed.dirtyFiles !== undefined)) {
          const changed = workbench.updateState({
            ...(parsed.activeEditor !== undefined ? { activeEditor: parsed.activeEditor } : {}),
            ...(parsed.dirtyFiles !== undefined ? { dirtyFiles: parsed.dirtyFiles } : {}),
          });
          if (changed) runtime?.onWorkspaceChanged();
        }
        await runtime?.executeCommand(parsed.command);
        return { ok: true };
      }

      if (method === 'sidecar/shutdown') {
        await cleanup();
        return { ok: true };
      }

      throw new Error(`Unknown sidecar request method: ${method}`);
    },

    onNotification: (method, params) => {
      if (method === 'sidecar/webviewMessage') {
        const raw =
          params && typeof params === 'object' && 'message' in (params as Record<string, unknown>)
            ? (params as { message: unknown }).message
            : params;
        const parsed = parseWebviewMessage(raw);
        if (parsed) {
          if (parsed.type === 'ready') {
            webviewVisible = true;
          }
          runtime?.handleWebviewMessage(parsed);
        }
        return;
      }

      if (method === 'sidecar/webviewVisibility') {
        const visible = Boolean((params as { visible?: unknown } | undefined)?.visible);
        const becameVisible = !webviewVisible && visible;
        webviewVisible = visible;
        if (becameVisible) {
          runtime?.onViewVisible();
        }
        return;
      }

      if (method === 'sidecar/editorStateChanged') {
        const parsed = editorStateChangedParamsSchema.safeParse(params ?? {});
        if (!parsed.success) return;
        const p = parsed.data;
        if (p.windowFocused !== undefined) windowFocused = p.windowFocused;
        if (p.workspaceFolders !== undefined) workspaceFolders = p.workspaceFolders;
        if (p.httpProxy !== undefined) settingsStore?.setIdeHttpProxy(p.httpProxy);
        if (p.workspaceTrusted !== undefined) {
          const wasTrusted = workspaceTrusted;
          workspaceTrusted = p.workspaceTrusted;
          if (!wasTrusted && workspaceTrusted) {
            for (const fn of trustListeners) fn();
          }
        }
        if (workbench && (p.activeEditor !== undefined || p.dirtyFiles !== undefined)) {
          const changed = workbench.updateState({
            ...(p.activeEditor !== undefined ? { activeEditor: p.activeEditor } : {}),
            ...(p.dirtyFiles !== undefined ? { dirtyFiles: p.dirtyFiles } : {}),
          });
          if (changed) runtime?.onWorkspaceChanged();
        }
        return;
      }

      if (method === 'sidecar/secretChanged') {
        const key = (params as { key?: unknown } | undefined)?.key;
        if (typeof key === 'string' && key) {
          for (const fn of secretListeners) fn(key);
        }
        return;
      }

      if (method === 'sidecar/cancelProgress') {
        const progressId = (params as { progressId?: unknown } | undefined)?.progressId;
        if (typeof progressId === 'string') {
          cancelHandlers.get(progressId)?.();
        }
      }
    },

    onClose: () => {
      void cleanup();
    },
  });

  return {
    dispose: async () => {
      peer.close();
      await cleanup();
    },
  };
}

/**
 * HD-18 无头宿主 spike：证明 `HarnessHostRuntime` 能在没有 IDE、没有 Webview 的 Node 进程里启动与销毁。
 *
 * 这是最小可运行路径，不执行真实定时任务：调度执行、共享存储与凭据仲裁仍需后续实现。
 * 使用临时 config 目录，并把 PATH 清空，避免探测/启动本机已安装的底层。
 */
import { mkdir, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostPlatform } from '../packages/extension/src/host/HostPlatform.ts';
import { createHarnessHostRuntime } from '../packages/extension/src/host/HarnessHostRuntime.ts';
import { FileKeyValueStore, FileSettingsStore, workspaceStateFilePath } from '../packages/extension/src/sidecar/fileStores.ts';
import { noWorkbench } from '../packages/extension/src/vm/workbench.ts';

const MOCK_ACP = join(import.meta.dirname, 'mock-acp-agent.mjs');
const SCHEDULE_KEY = 'harnessDeck.hub.schedules';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hd-headless-'));
  const configRoot = join(root, 'config');
  const projectPath = join(root, 'project');
  await mkdir(configRoot, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  // 单实例锁：同一个 configRoot 只允许一个调度进程，避免和 IDE 或另一个 daemon 重复触发。
  const lockPath = join(configRoot, 'scheduler.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, 'wx');
    await lock.writeFile(String(process.pid), 'utf8');
  } catch {
    console.log('headless scheduler: another instance holds the lock; exit');
    return;
  }

  const globalState = await FileKeyValueStore.open(join(configRoot, 'global-state.json'));
  const workspaceState = await FileKeyValueStore.open(workspaceStateFilePath(configRoot, projectPath));
  const settings = await FileSettingsStore.open(join(configRoot, 'settings.json'));
  const secrets = new Map<string, string>();

  const now = Date.now();
  await settings.update('backends', [
    { id: 'mock', name: 'Mock ACP', command: process.execPath, args: [MOCK_ACP], env: {} },
  ]);
  await globalState.update(SCHEDULE_KEY, {
    rules: [
      {
        id: 'mock-rule',
        name: 'Mock schedule',
        prompt: 'say hello',
        frequency: { kind: 'interval', minutes: 5 },
        backendId: 'mock',
        projectPath,
        enabled: true,
        createdAt: now,
        runs: [],
      },
    ],
    hiddenSessionIds: [],
  });

  const platform: HostPlatform = {
    hostKind: 'jetbrains',
    extensionVersion: 'headless-spike',
    storageRoot: join(configRoot, 'storage'),
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
    isWindowFocused: () => true,
    workspaceFolders: () => [{ name: 'spike', path: projectPath }],
    postToWebview: () => undefined,
    isWebviewVisible: () => false,
    focusChatView: async () => undefined,
    openWorkbenchPanel: () => undefined,
    log: (line) => console.log(`[host] ${line}`),
    runtimeLog: (line, stream) => console.log(`[${stream}] ${line}`),
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
  try {
    console.log('headless runtime: starting');
    runtime.onViewVisible();
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log('headless runtime: triggering scheduled task');
    runtime.handleWebviewMessage({ type: 'runScheduleNow', payload: { id: 'mock-rule' } });

    const deadline = Date.now() + 20_000;
    let status: string | undefined;
    let output: string | undefined;
    while (Date.now() < deadline) {
      const data = globalState.get<{ rules?: { id: string; lastStatus?: string; runs?: { output?: string }[] }[] }>(
        SCHEDULE_KEY,
      );
      const rule = data?.rules?.find((item) => item.id === 'mock-rule');
      status = rule?.lastStatus;
      output = rule?.runs?.[0]?.output;
      if (status && status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (status !== 'succeeded') throw new Error(`scheduled task did not succeed (status=${String(status)}, output=${String(output)})`);
    if (!output?.includes('mock scheduled reply')) throw new Error(`unexpected output: ${String(output)}`);
    console.log(`headless runtime: scheduled task ${status}: ${output.trim()}`);
  } finally {
    await runtime.dispose();
    settings.dispose();
    globalState.dispose();
    workspaceState.dispose();
    await lock?.close();
    await unlink(lockPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    console.log('headless runtime: disposed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * VS Code 插件入口：将 VS Code Extension API 适配为 HostPlatform，委托给核心宿主运行时 HarnessHostRuntime。
 */
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { RuntimeStatus } from '@harness-deck/shared';
import { createHarnessHostRuntime, type HarnessHostRuntime } from './host/HarnessHostRuntime.ts';
import type { HostCommandId, HostPlatform, QuickPickOption, SettingsStore, StatusBarSnapshot } from './host/HostPlatform.ts';
import { getLocale, t } from './i18n.ts';
import { command, migrateSettings, SECTION, settings } from './settings.ts';
import { redactSecrets } from './util/redact.ts';
import { ChatViewProvider } from './webview/ChatViewProvider.ts';
import { VscodeWorkbench } from './workbench/VscodeWorkbench.ts';

const GLOBAL_ONLY_SETTINGS = new Set([
  'defaultBackend',
  'backends',
  'acpRegistryUrl',
  'providers',
  'protocolGateway',
  'projects',
  'mcpServers',
  'dsh.path',
  'zcode.path',
  'claude.path',
  'pi.path',
  'codex.path',
  'codebuddy.path',
  'chatCommands',
]);

const WATCHED_SETTING_KEYS = [
  'defaultBackend',
  'dsh',
  'dsh.path',
  'dsh.profile',
  'zcode',
  'zcode.path',
  'claude',
  'claude.path',
  'pi',
  'pi.path',
  'codex',
  'codex.path',
  'codebuddy',
  'codebuddy.path',
  'backends',
  'acpRegistryUrl',
  'context',
  'context.includeActiveEditor',
  'ui.theme',
  'ui.fontSize',
  'ui.fontFamily',
  'ui.lineHeight',
  'ui.paragraphSpacing',
  'ui.contentWidth',
  'ui.codeFontFamily',
  'ui.terminalFontSize',
  'ui.terminalLineHeight',
  'ui.showTurnChanges',
  'ui.language',
  'notifications',
  'backendTrace',
  'schedules',
  'chatCommands',
  'projects',
  'mcpServers',
  'providers',
  'protocolGateway',
] as const;

const ALL_COMMANDS: readonly HostCommandId[] = [
  'openWorkbench',
  'openChat',
  'newSession',
  'interrupt',
  'selectBackend',
  'selectModel',
  'explainSelection',
  'fixSelection',
  'testSelection',
  'addToChat',
  'configureApiKey',
  'renameSession',
  'selectFolder',
  'restartRuntime',
  'openWebUI',
  'showLogs',
  'toggleRemoteBridge',
  'generateRemotePairing',
  'showRemoteDevices',
];

let runtimeInstance: HarnessHostRuntime | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Harness Deck', { log: true });
  const runtimeOutput = vscode.window.createOutputChannel('Harness Deck: Backend', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = command('openChat');
  context.subscriptions.push(output, runtimeOutput, status);

  const safeLog = (line: string): void => output.info(redactSecrets(line));
  void migrateSettings().then((moved) => moved.length && safeLog(`已迁移旧设置：${moved.join(', ')}`));
  void offerUninstallOldExtension(safeLog);

  const workbench = new VscodeWorkbench(safeLog);
  const viewHolder: { provider?: ChatViewProvider } = {};

  const settingsStore: SettingsStore = {
    get: <T>(key: string, defaultValue: T): T => settings().get<T>(key, defaultValue),
    update: async (key: string, value: unknown): Promise<void> => {
      const config = settings();
      if (GLOBAL_ONLY_SETTINGS.has(key)) {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
        return;
      }
      const inspected = config.inspect(key);
      const target =
        inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await config.update(key, value, target);
    },
    getHttpProxy: (): string | undefined => vscode.workspace.getConfiguration('http').get<string>('proxy'),
    onDidChange: (listener) => {
      const sub = vscode.workspace.onDidChangeConfiguration((event) => {
        const changed = new Set<string>();
        for (const key of WATCHED_SETTING_KEYS) {
          if (event.affectsConfiguration(`${SECTION}.${key}`)) {
            changed.add(key);
          }
        }
        if (changed.size > 0) listener(changed);
      });
      return () => sub.dispose();
    },
  };

  const platform: HostPlatform = {
    hostKind: 'vscode',
    extensionVersion: String(context.extension.packageJSON.version ?? '0.4.0'),
    storageRoot: context.globalStorageUri.fsPath,
    webviewDistRoot: join(context.extensionPath, 'dist', 'webview'),
    globalState: {
      get: <T>(key: string) => context.globalState.get<T>(key),
      update: async (key: string, value: unknown) => {
        await context.globalState.update(key, value);
      },
    },
    workspaceState: {
      get: <T>(key: string) => context.workspaceState.get<T>(key),
      update: async (key: string, value: unknown) => {
        await context.workspaceState.update(key, value);
      },
    },
    settings: settingsStore,
    secrets: {
      get: async (key: string) => await context.secrets.get(key),
      store: async (key: string, value: string) => {
        await context.secrets.store(key, value);
      },
      delete: async (key: string) => {
        await context.secrets.delete(key);
      },
      onDidChange: (listener) => {
        const sub = context.secrets.onDidChange((ev) => listener(ev.key));
        return () => sub.dispose();
      },
    },
    workbench,
    envLanguage: () => vscode.env.language,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    onDidGrantWorkspaceTrust: (listener) => {
      const sub = vscode.workspace.onDidGrantWorkspaceTrust(listener);
      return () => sub.dispose();
    },
    isWindowFocused: () => vscode.window.state.focused,
    workspaceFolders: () =>
      (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === 'file')
        .map((f) => ({ name: f.name, path: f.uri.fsPath })),
    postToWebview: (message) => viewHolder.provider?.post(message),
    isWebviewVisible: () => viewHolder.provider?.visible ?? false,
    focusChatView: async () => {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    },
    openWorkbenchPanel: (title) => viewHolder.provider?.openPanel(title),
    log: (line) => output.info(line),
    runtimeLog: (line, stream) => (stream === 'stderr' ? runtimeOutput.warn(line) : runtimeOutput.info(line)),
    showLogs: () => output.show(),
    openHostSettings: () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    },
    onStatusUpdate: (snap) => renderStatusBar(status, snap),
    openExternal: async (url: string) => {
      const uri = vscode.Uri.parse(url);
      if (uri.scheme !== 'http' && uri.scheme !== 'https') return false;
      // 传原字符串：Uri.toString() 会把查询里的 = 等字符编码掉，链接带参数时打开的地址就不对了
      return await vscode.env.openExternal(url as unknown as vscode.Uri);
    },
    resolveExternalOrigin: async (base: string) => {
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(base));
      return external.with({ path: '', query: '', fragment: '' }).toString(true);
    },
    writeClipboard: async (text: string) => {
      await vscode.env.clipboard.writeText(text);
    },
    showMessage: async (level, message, actions = []) => {
      if (level === 'error') return await vscode.window.showErrorMessage(message, ...actions);
      if (level === 'warning') return await vscode.window.showWarningMessage(message, ...actions);
      return await vscode.window.showInformationMessage(message, ...actions);
    },
    pickQuickItem: async <T extends QuickPickOption>(
      items: readonly T[],
      options: { readonly placeHolder: string; readonly ignoreFocusOut?: boolean },
    ): Promise<T | undefined> => {
      const wrapped = items.map((item) => ({
        label: item.label,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.picked !== undefined ? { picked: item.picked } : {}),
        raw: item,
      }));
      const picked = await vscode.window.showQuickPick(wrapped, {
        placeHolder: options.placeHolder,
        ...(options.ignoreFocusOut !== undefined ? { ignoreFocusOut: options.ignoreFocusOut } : {}),
      });
      return picked?.raw;
    },
    withCancellableProgress: <T>(
      title: string,
      task: (onCancel: (cb: () => void) => void) => Promise<T>,
    ): Promise<T> =>
      Promise.resolve(
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: true },
          (_progress, token) => {
            const subs: vscode.Disposable[] = [];
            return task((cb) => {
              subs.push(token.onCancellationRequested(cb));
            }).finally(() => subs.forEach((s) => s.dispose()));
          },
        ),
      ),
    pickOpenDialog: async (options) => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: options.canSelectMany,
        canSelectFiles: options.canSelectFiles,
        canSelectFolders: options.canSelectFolders,
        ...(options.defaultPath ? { defaultUri: vscode.Uri.file(options.defaultPath) } : {}),
        title: options.title,
        ...(options.filters
          ? {
              filters: Object.fromEntries(
                Object.entries(options.filters).map(([k, v]) => [k, [...v]]),
              ),
            }
          : {}),
      });
      return picked?.map((uri) => uri.fsPath) ?? [];
    },
    openProjectWindow: async (path: string) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), false);
    },
    runInTerminal: async ({ name, cwd, commands }) => {
      const terminal =
        vscode.window.terminals.find((term) => term.name === name && term.exitStatus === undefined) ??
        vscode.window.createTerminal({ name, cwd });
      terminal.show();
      const isWinPowerShell = process.platform === 'win32' && /powershell(?:\.exe)?$/iu.test(vscode.env.shell);
      if (isWinPowerShell && commands.length > 1) {
        const chained = commands.reduce((acc, cmd) => `${acc}; if ($?) { ${cmd} }`);
        terminal.sendText(chained, true);
      } else {
        terminal.sendText(commands.join(' && '), true);
      }
    },
  };

  const runtime = createHarnessHostRuntime(platform);
  runtimeInstance = runtime;

  context.subscriptions.push(workbench.register(() => runtime.onWorkspaceChanged()));

  const provider = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => runtime.handleWebviewMessage(message),
    onViewVisible: () => runtime.onViewVisible(),
    locale: getLocale,
    log: safeLog,
  });
  viewHolder.provider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  for (const cmd of ALL_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command(cmd), () => runtime.executeCommand(cmd)),
    );
  }
}

export async function deactivate(): Promise<void> {
  const rt = runtimeInstance;
  runtimeInstance = undefined;
  await rt?.dispose();
}

function renderStatusBar(item: vscode.StatusBarItem, snap: StatusBarSnapshot): void {
  const { backendName: name, status, modelLabel, remote } = snap;
  const remotePart =
    remote?.enabled && remote.running ? ` · $(broadcast) ${remote.connectedClients}` : '';
  const text: Record<RuntimeStatus['kind'], string> = {
    idle: `$(circle-outline) ${name}`,
    locating: `$(loading~spin) ${name}`,
    starting: `$(loading~spin) ${t('status.starting', name)}`,
    connected: `$(check) ${name}${modelLabel ? ` · ${modelLabel}` : ''}`,
    reconnecting: `$(loading~spin) ${t('status.reconnecting', name)}`,
    notInstalled: `$(warning) ${t('status.notInstalled', name)}`,
    unsupportedVersion: `$(warning) ${t('status.unsupported', name)}`,
    failed: `$(error) ${name}`,
    untrusted: `$(shield) ${name}`,
  };
  item.text = `${text[status.kind]}${remotePart}`;
  item.tooltip =
    status.kind === 'connected'
      ? `${name} ${status.version}${remotePart ? ` · Remote: ${remote?.connectedClients ?? 0}` : ''}`
      : status.kind === 'failed'
        ? status.message
        : undefined;
  item.show();
}

/** 改名前的扩展。它和 Harness Deck 是两个扩展 id，没卸载时编辑器右键菜单里还有「DSH」，侧边栏里也多一个面板。 */
const OLD_EXTENSION_ID = 'izrio.dsh-copilot';

async function offerUninstallOldExtension(log: (line: string) => void): Promise<void> {
  if (!vscode.extensions.getExtension(OLD_EXTENSION_ID)) return;
  log(`旧版扩展 ${OLD_EXTENSION_ID} 还装着`);
  const uninstall = t('ext.oldUninstall');
  const choice = await vscode.window.showWarningMessage(t('ext.oldInstalled'), uninstall);
  if (choice !== uninstall) return;
  try {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
  } catch (error) {
    log(`卸载旧版扩展失败：${error instanceof Error ? error.message : String(error)}`);
    void vscode.commands.executeCommand('workbench.extensions.search', OLD_EXTENSION_ID);
  }
}

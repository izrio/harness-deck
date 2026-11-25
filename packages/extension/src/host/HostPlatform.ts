/**
 * 宿主平台抽象（HostPlatform）：把 VS Code Extension API 与 JetBrains IDE（Sidecar RPC）的宿主能力统一为纯 TypeScript 接口。
 * 核心运行时（HarnessHostRuntime）及全部底层适配器（dsh / acp / claude / pi / zcode）仅依赖此接口，零 `vscode` 耦合。
 */
import type { HostIdeKind, HostToWebview, RuntimeStatus } from '@harness-deck/shared';
import type { Workbench } from '../vm/workbench.ts';

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  /** 磁盘状态被外部进程更新后触发（如无头后台调度写回结果）。 */
  onDidExternalChange?(listener: () => void): () => void;
}

export interface SettingsStore {
  /** 读取 `harnessDeck.<key>` 的配置值（例如 `ui.language`、`dsh.path`、`backends`）。 */
  get<T>(key: string, defaultValue: T): T;
  /** 更新 `harnessDeck.<key>` 的配置值；`value === undefined` 表示恢复默认。 */
  update(key: string, value: unknown): Promise<void>;
  /** 读取宿主编辑器的 HTTP 代理配置（如 VS Code `http.proxy` 或 IDEA `HttpConfigurable`）。 */
  getHttpProxy(): string | undefined;
  /** 监听配置变化；传入发生变更的键集合（相对 `harnessDeck.`，如 `ui.theme`、`backends`）。 */
  onDidChange(listener: (changedKeys: ReadonlySet<string>) => void): () => void;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onDidChange(listener: (key: string) => void): () => void;
}

export interface WorkspaceFolderItem {
  readonly name: string;
  readonly path: string;
}

export interface QuickPickOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly picked?: boolean;
}

export interface OpenDialogOptions {
  readonly canSelectFiles: boolean;
  readonly canSelectFolders: boolean;
  readonly canSelectMany: boolean;
  readonly defaultPath?: string;
  readonly title: string;
  readonly filters?: Readonly<Record<string, readonly string[]>>;
}

export interface StatusBarSnapshot {
  readonly backendName: string;
  readonly status: RuntimeStatus;
  readonly modelLabel?: string;
  readonly remote?: {
    readonly enabled: boolean;
    readonly running: boolean;
    readonly connectedClients: number;
  };
}

export type HostCommandId =
  | 'openWorkbench'
  | 'openChat'
  | 'newSession'
  | 'interrupt'
  | 'selectBackend'
  | 'selectChannel'
  | 'loginAccount'
  | 'selectModel'
  | 'explainSelection'
  | 'fixSelection'
  | 'testSelection'
  | 'addToChat'
  | 'configureApiKey'
  | 'renameSession'
  | 'selectFolder'
  | 'restartRuntime'
  | 'openWebUI'
  | 'showLogs'
  | 'toggleRemoteBridge'
  | 'generateRemotePairing'
  | 'showRemoteDevices';

export interface HostPlatform {
  readonly hostKind: HostIdeKind;
  readonly extensionVersion: string;
  readonly storageRoot: string;
  /** Webview 构建产物目录（dist/webview），供 RemoteBridgeServer 托管静态壳与 PWA 资源。 */
  readonly webviewDistRoot?: string;
  /** 后台无头调度单实例锁目录（仅 Sidecar / 无头宿主提供；VS Code 宿主不启用后台进程）。 */
  readonly schedulerLockDir?: string;
  /** 定时规则变更后通知宿主（用于 Sidecar 在启用首条规则时动态拉起后台无头调度）。 */
  readonly onSchedulesChanged?: (hasEnabled: boolean) => void;
  readonly globalState: KeyValueStore;
  readonly workspaceState: KeyValueStore;
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly workbench: Workbench;

  envLanguage(): string;
  isWorkspaceTrusted(): boolean;
  onDidGrantWorkspaceTrust(listener: () => void): () => void;
  isWindowFocused(): boolean;
  workspaceFolders(): readonly WorkspaceFolderItem[];

  postToWebview(message: HostToWebview): void;
  isWebviewVisible(): boolean;
  focusChatView(): Promise<void>;
  openWorkbenchPanel(title: string): void;

  log(line: string): void;
  runtimeLog(line: string, stream: 'stdout' | 'stderr'): void;
  showLogs(): void;
  openHostSettings(): void;
  onStatusUpdate(state: StatusBarSnapshot): void;

  openExternal(url: string): Promise<boolean>;
  resolveExternalOrigin(origin: string): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  readClipboard?(): Promise<string>;

  showMessage(
    level: 'info' | 'warning' | 'error',
    message: string,
    actions?: readonly string[],
  ): Promise<string | undefined>;

  pickQuickItem<T extends QuickPickOption>(
    items: readonly T[],
    options: { readonly placeHolder: string; readonly ignoreFocusOut?: boolean },
  ): Promise<T | undefined>;

  withCancellableProgress<T>(
    title: string,
    task: (onCancel: (cb: () => void) => void) => Promise<T>,
  ): Promise<T>;

  pickOpenDialog(options: OpenDialogOptions): Promise<readonly string[]>;
  openProjectWindow(path: string): Promise<void>;
  runInTerminal(options: {
    readonly name: string;
    readonly cwd: string;
    readonly commands: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<void>;
}

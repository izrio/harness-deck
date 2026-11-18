/**
 * 宿主平台抽象（HostPlatform）：把 VS Code Extension API 与 JetBrains IDE（Sidecar RPC）的宿主能力统一为纯 TypeScript 接口。
 * 核心运行时（HarnessHostRuntime）及全部底层适配器（dsh / acp / claude / pi / zcode）仅依赖此接口，零 `vscode` 耦合。
 */
import type { HostIdeKind, HostToWebview, RuntimeStatus } from '@harness-deck/shared';
import type { Workbench } from '../vm/workbench.ts';

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
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
}

export type HostCommandId =
  | 'openWorkbench'
  | 'openChat'
  | 'newSession'
  | 'interrupt'
  | 'selectBackend'
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
  | 'showLogs';

export interface HostPlatform {
  readonly hostKind: HostIdeKind;
  readonly extensionVersion: string;
  readonly storageRoot: string;
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
  }): Promise<void>;
}

/**
 * 各种底层共用的、由宿主运行时（HarnessHostRuntime）提供的能力。
 * 不依赖 `vscode` 模块，供 VS Code Extension Host 与 JetBrains Node Sidecar 共同复用。
 */
import type { ProviderConfig, RuntimeStatus } from '@harness-deck/shared';
import type { PreparedBackendLaunch } from '../extensions/mcpService.ts';
import type { KeyValueStore, QuickPickOption, SettingsStore } from '../host/HostPlatform.ts';
import { envWithExtraPath } from './npmManager.ts';
import type { BackendProfile, ControllerHostOptions } from './types.ts';

let extraBinDir: string | undefined;

/** 补充 npm 全局可执行目录，确保通过设置页安装的命令在 PATH 未包含时也能找到。 */
export function setNpmGlobalBin(dir: string | undefined): void {
  extraBinDir = dir?.trim() || undefined;
}

export interface CachedExecutableInfo {
  readonly command: string;
  readonly version?: string;
  readonly mtimeMs?: number;
  readonly size?: number;
}

export interface BackendHost {
  readonly globalState: KeyValueStore;
  readonly workspaceState: KeyValueStore;
  readonly storageRoot: string;
  readonly extensionVersion: string;
  readonly settings: SettingsStore;
  readonly isWorkspaceTrusted: () => boolean;
  readonly processEnv: (extra?: Readonly<Record<string, string | undefined>>) => Record<string, string | undefined>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly resolveExternalOrigin: (origin: string) => Promise<string>;
  readonly writeClipboard: (text: string) => Promise<void>;
  readonly showMessage: (
    level: 'info' | 'warning' | 'error',
    message: string,
    actions?: readonly string[],
  ) => Promise<string | undefined>;
  readonly pickQuickItem: <T extends QuickPickOption>(
    items: readonly T[],
    options: { readonly placeHolder: string; readonly ignoreFocusOut?: boolean },
  ) => Promise<T | undefined>;
  readonly withCancellableProgress: <T>(
    title: string,
    task: (onCancel: (cb: () => void) => void) => Promise<T>,
  ) => Promise<T>;
  readonly log: (line: string) => void;
  /** 底层进程的输出（已脱敏），写到日志面板。 */
  readonly runtimeLog: (line: string, stream: 'stdout' | 'stderr') => void;
  readonly workspacePath: () => string;
  /** 每种底层各自的 workspaceState 键（会话、标签不在底层之间混用）。 */
  readonly stateKey: (name: string) => string;
  /** 控制器的公共选项：Webview 推送、编辑器能力、外观、底层列表等。 */
  readonly controllerOptions: () => ControllerHostOptions & { readonly showTurnChanges?: () => boolean };
  readonly onStatus: (status: RuntimeStatus) => void;
  /** 读取已缓存的可执行文件路径（配置变更时自动失效）。 */
  readonly getCachedExecutable?: (profileId: string, commandSpec: string) => CachedExecutableInfo | undefined;
  /** 更新或清除某个底层的可执行文件路径缓存。 */
  readonly setCachedExecutable?: (
    profileId: string,
    commandSpec: string,
    resolved: CachedExecutableInfo | undefined,
  ) => void;
  /** 在底层进程启动前准备该 Agent 需要携带的 Skills 挂载目录、dsh patch 与 MCP 服务器列表。 */
  readonly prepareBackendLaunch?: (profile: BackendProfile) => Promise<PreparedBackendLaunch>;
  /** 读取某个底层智能体当前绑定的第三方服务商配置。 */
  readonly boundProvider?: (backendId: string) => ProviderConfig | undefined;
  /** 启动或复用本机回环服务商代理，返回代理 origin 与一次性本地令牌。 */
  readonly ensureProviderProxy?: () => Promise<{ readonly origin: string; readonly token: string }>;
  /** 是否启用本地协议转换网关（将 OpenAI 兼容接口转换为 Claude Anthropic 协议，默认关闭）。 */
  readonly isProtocolGatewayEnabled?: () => boolean;
  /** 记录某个服务商最近被选中的模型（供代理映射默认模型）。 */
  readonly onProviderModelSelected?: (providerId: string, model: string) => void;
}

/** 进程环境变量，加上 npm 全局可执行目录及宿主 IDE 的代理设置（模型请求由底层自己发出）。 */
export function processEnvWithProxy(
  extra: Readonly<Record<string, string | undefined>> = {},
  httpProxy?: string,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of Object.entries(extra)) {
    merged[k] = v;
  }
  const env = envWithExtraPath(merged, extraBinDir, process.platform);
  const proxy = httpProxy?.trim();
  // npm 等 CLI 只认 HTTP(S) 代理；socks:// 会让请求一直挂到超时，这里直接跳过。
  if (proxy && /^https?:\/\//iu.test(proxy)) {
    env.HTTPS_PROXY ??= proxy;
    env.HTTP_PROXY ??= proxy;
  }
  return env;
}

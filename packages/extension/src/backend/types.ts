/**
 * 底层（backend）：插件对话面板背后的编程代理。dsh 是内置的一种，其他代理通过 ACP（Agent Client Protocol）接入。
 *
 * 每种底层有自己的控制器，负责把底层的会话数据投影成界面视图模型（shared/viewModel），并处理 Webview 的消息；
 * 界面本身不区分底层。extension.ts 同一时间只运行一个底层，切换时停掉旧的、启动新的，Webview 重新取快照。
 */
import type {
  AppearanceState,
  BackendsState,
  ExtensionsState,
  HostSnapshot,
  HostToWebview,
  ModelState,
  PreferencesState,
  ProjectsState,
  ProvidersState,
  RuntimeStatus,
  WebviewToHost,
  WorkbenchState,
} from '@harness-deck/shared';
import type { DshClient } from '../dsh/DshClient.ts';
import type { TemplateName } from '../vm/context.ts';
import type { Workbench } from '../vm/workbench.ts';

export interface CrossProjectSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly needsAttention?: boolean;
}

export interface ProgrammaticSessionRequest {
  readonly prompt?: string;
  readonly title?: string;
  readonly model?: { readonly provider?: string; readonly model: string; readonly reasoningEffort?: string };
  readonly permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly skipPermissionConfirm?: boolean;
}

/** 控制器对外的接口：extension.ts 和命令只通过它和当前底层打交道。 */
export interface ChatBackendController {
  handle(message: WebviewToHost): Promise<void>;
  /** Webview 加载（或切换底层）后的完整快照。 */
  snapshot(): HostSnapshot;
  /** 读取当前控制器状态快照但不重置增量发布器基线，也不递归拉取工作台状态（供 WorkbenchHub 只读聚合使用）。 */
  peekSnapshot?(): HostSnapshot;
  modelState(): ModelState;
  askAboutSelection(template: TemplateName): Promise<void>;
  pinActiveEditor(): void;
  workspaceChanged(): void;
  localeChanged(): void;
  appearanceChanged(): void;
  preferencesChanged(): void;
  /** 底层列表或当前底层变化（推送给 Webview）。 */
  backendsChanged(): void;
  /** 服务商配置变化（推送给 Webview）。 */
  providersChanged?(): void;
  /** 项目与 Worktree 配置变化（推送给 Webview）。 */
  projectsChanged(): void;
  /** 扩展（Agent Skills 与 MCP 服务器）配置变化（推送给 Webview）。 */
  extensionsChanged?(): void;
  setWorkspace(path: string): void;
  renameSession(explicitTitle?: string): Promise<void>;
  configureApiKey(): Promise<void>;
  setRuntimeStatus(status: RuntimeStatus): void;
  /** 底层已知的跨项目会话摘要（供工作台按项目分组会话展示）。 */
  allWorkspaceSessions?(): readonly CrossProjectSession[];
  /** 由智能体或顺序看板任务发起一个新会话并可选发送首条消息。 */
  startProgrammaticSession?(req: ProgrammaticSessionRequest): Promise<string | undefined>;
  /** 获取指定会话最近一轮助手输出摘要（供看板待验收卡片和未读通知展示）。 */
  latestAssistantText?(sessionId: string): string | undefined;
  dispose(): void;
}

export interface SessionObservation {
  readonly sessionId?: string;
  readonly title: string;
  readonly running: boolean;
  readonly sync: string;
  readonly interactionIds: readonly string[];
  readonly turnAborted?: boolean;
  readonly hasTurnOutput?: boolean;
  readonly goalPhase?: 'active' | 'paused' | 'blocked' | 'complete';
  readonly goalObjective?: string;
}

/** 两种底层的控制器都需要、由 extension.ts 提供的能力：Webview 推送、编辑器、外观、底层列表等。 */
export interface ControllerHostOptions {
  readonly post: (message: HostToWebview) => void;
  readonly log: (line: string) => void;
  readonly openExternal: (url: string) => void;
  readonly showLogs: () => void;
  /** 当前模型的显示名变化时调用（状态栏用）。 */
  readonly onModelChange?: (label: string | undefined) => void;
  /** 打开 Diff、未保存文件、确认框、当前编辑器。 */
  readonly workbench?: Workbench;
  /** 设置 `harnessDeck.context.includeActiveEditor`：默认附带当前编辑器。 */
  readonly includeActiveEditor?: () => boolean;
  /** 多根工作区：让用户选择文件夹（选好后调用 setWorkspace）。 */
  readonly selectFolder?: () => void;
  /** 多根工作区时当前文件夹的显示名。 */
  readonly folderLabel?: () => string | undefined;
  /** 合并推送的间隔（测试里设成 0）；不传时面板可见 30ms、隐藏 500ms。 */
  readonly renderDelayMs?: number;
  /** 面板是否可见。隐藏时 Webview 收不到消息（重新显示时取快照），不必按流式输出的节奏计算和推送。 */
  readonly isVisible?: () => boolean;
  /** 界面字号和字体（设置 `harnessDeck.ui.*`）。 */
  readonly appearance?: () => AppearanceState;
  /** 设置页通用偏好。 */
  readonly preferences?: () => PreferencesState;
  /** 打开插件的界面设置。 */
  readonly openSettings?: () => void;
  /** 可选的底层和当前底层（随快照下发，设置页里切换）。 */
  readonly backends?: () => BackendsState;
  /** 第三方服务商配置与智能体绑定状态（随快照下发）。 */
  readonly providers?: () => ProvidersState;
  /** 项目与 Worktree 配置（随快照下发，设置页里管理）。 */
  readonly projects?: () => ProjectsState;
  /** 扩展模块状态（已安装 Agent Skills 与统一 MCP 服务器配置）。 */
  readonly extensions?: () => ExtensionsState;
  /** 写入外观与排版设置（harnessDeck.ui.*）；值为 null 时恢复默认。 */
  readonly setAppearance?: (
    patch: Extract<WebviewToHost, { type: 'setAppearance' }>['payload'],
  ) => Promise<void>;
  /** 写入设置页通用偏好、定时权限、系统通知与高级设置。 */
  readonly setPreferences?: (patch: {
    readonly language?: PreferencesState['language'];
    readonly includeActiveEditor?: boolean;
    readonly showTurnChanges?: boolean;
    readonly schedulePermission?: PreferencesState['schedulePermission'];
    readonly notifications?: Partial<NonNullable<PreferencesState['notifications']>>;
    readonly advanced?: Partial<NonNullable<PreferencesState['advanced']>>;
    readonly chatCommands?: PreferencesState['chatCommands'];
  }) => Promise<void>;
  /** 输入框 `+` 菜单选择磁盘文件加入上下文。 */
  readonly pickFiles?: () => Promise<readonly string[]>;
  /** 会话视图每次刷新后通知上层（用于系统通知检测与工作台同步）。 */
  readonly onSessionObserve?: (observation: SessionObservation) => void;
  /** 会话临时 key 替换为真实会话 id 时通知上层（例如 Claude 首条消息 pending key -> session_id）。 */
  readonly onSessionRekey?: (oldSessionId: string, newSessionId: string) => void;
  /** 判断某个会话 id 是否属于后台定时任务隐藏会话（不出现在左侧会话列表）。 */
  readonly isHiddenSession?: (sessionId: string) => boolean;
  /** 当前工作台五模块状态（随快照下发）。 */
  readonly workbenchState?: () => WorkbenchState;
}

/** 合并推送的间隔：流式输出时不产生消息风暴；面板隐藏时放慢。 */
export function renderDelay(options: Pick<ControllerHostOptions, 'renderDelayMs' | 'isVisible'>): number {
  return options.renderDelayMs ?? (options.isVisible?.() === false ? 500 : 30);
}

/** 底层驱动类型：决定用哪个控制器；同一个 driver 可以有多份 instanceId（账号实例）。 */
export type BackendDriver = 'dsh' | 'claude' | 'pi' | 'zcode' | 'codex' | 'codebuddy' | 'acp';

/** 设置里配置的一个底层。`id` 仍是实例标识（历史会话按它保存），`driver` 描述接入协议。 */
export type BackendProfile =
  | { readonly id: 'dsh'; readonly kind: 'dsh'; readonly name: string; readonly driver?: BackendDriver; readonly instanceId?: string }
  | {
      readonly id: 'zcode';
      readonly kind: 'zcode';
      readonly name: string;
      readonly driver?: BackendDriver;
      readonly instanceId?: string;
      readonly installHint?: string;
      readonly signInHint?: string;
    }
  | {
      readonly id: 'claude';
      readonly kind: 'claude';
      readonly name: string;
      readonly driver?: BackendDriver;
      readonly instanceId?: string;
      readonly installHint?: string;
      readonly signInHint?: string;
    }
  | {
      readonly id: 'pi';
      readonly kind: 'pi';
      readonly name: string;
      readonly driver?: BackendDriver;
      readonly instanceId?: string;
      readonly installHint?: string;
      readonly signInHint?: string;
    }
  | {
      readonly id: 'codex';
      readonly kind: 'codex';
      readonly name: string;
      readonly driver?: BackendDriver;
      readonly instanceId?: string;
      readonly installHint?: string;
      readonly signInHint?: string;
    }
  | {
      readonly id: 'codebuddy';
      readonly kind: 'codebuddy';
      readonly name: string;
      readonly driver?: BackendDriver;
      readonly instanceId?: string;
      readonly installHint?: string;
      readonly signInHint?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'acp';
      readonly name: string;
      readonly driver?: BackendDriver;
      readonly instanceId?: string;
      /** 启动 ACP 代理的命令和参数，例如 `omp` + `["acp"]`。 */
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      /** 找不到命令时给用户的安装提示。 */
      readonly installHint?: string;
      /**
       * 一个进程只给一个会话推送实时更新（CodeBuddy：最近 session/new 的会话，或新进程里第一个 session/load 的会话）。
       * 在别的会话里发消息前要重启代理再加载那个会话。
       */
      readonly singleSession?: boolean;
      /** 代理要求登录、又没有提供登录方式时给用户的说明（Claude：在终端运行 claude 登录，或设置 ANTHROPIC_API_KEY）。 */
      readonly signInHint?: string;
    };

/** 正在运行的底层。 */
export interface RunningBackend {
  readonly profile: BackendProfile;
  readonly controller: ChatBackendController;
  /** dsh 底层当前已连接的客户端（定时任务可复用同一 Host 创建后台隔离会话）。 */
  readonly dshClient?: () => DshClient | undefined;
  /** dsh 网页地址（本机 origin，不含令牌）；底层未启动时为空。 */
  readonly webUrl?: () => string | undefined;
  /** 视图打开时启动（工作区受信任时）。 */
  start(): void;
  restart(): void;
  currentStatus(): RuntimeStatus;
  /** 停掉底层进程并释放控制器。 */
  stop(): Promise<void>;
}

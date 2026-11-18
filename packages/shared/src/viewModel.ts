/**
 * 界面视图模型。由 Extension Host 从底层（dsh 或 ACP 代理）及宿主状态投影得到，Webview 只负责渲染。
 * 这里的类型是插件自己的，不直接暴露任何底层的原始事件结构（docs/DESIGN.md D8）。
 */

import type { ColorSchemeId, TaskColumn } from './limits.ts';

export type { ColorSchemeId, ImageMediaType, TaskColumn, WorkbenchModule } from './limits.ts';

/**
 * 打开某个改动的 Diff：单次工具调用（来自会话日志，长期可用）、本轮汇总里的一个文件（Host 内存中），
 * 或整个会话对某个文件的累计改动（`path` 是 Host 给出的绝对路径）。
 */
export type DiffRef =
  | { readonly kind: 'tool'; readonly callId: string }
  | { readonly kind: 'turn'; readonly seq: number; readonly index: number }
  | { readonly kind: 'session'; readonly path: string };

export interface LineStats {
  readonly additions: number;
  readonly deletions: number;
}

export interface ChangedFileView extends Partial<LineStats> {
  /** 工作区相对路径（工作区外为绝对路径）。 */
  readonly path: string;
  readonly ref: DiffRef;
  readonly created?: boolean;
  readonly flags?: readonly ('binary' | 'oversized')[];
}

/** 当前会话累计改动的文件：显示在输入框上方的改动栏。 */
export interface SessionChangesView {
  readonly files: readonly ChangedFileView[];
  readonly additions: number;
  readonly deletions: number;
}

/**
 * 界面外观与排版（对应设置 `harnessDeck.ui.*`）。
 * - 主题与配色：`theme`（浅色/深色/跟随系统）与 `colorScheme`（5 套整套界面配色，随主题切换浅/深色）。
 * - 阅读与聊天：`fontFamily`、`fontSize`、`lineHeight`、`paragraphSpacing`、`contentWidth` 共用于聊天回复、计划和 Markdown 文件预览，切换主题或配色不会改变这些设置。
 * - 终端与代码：`codeFontFamily`、`terminalFontSize`、`terminalLineHeight`。
 */
export interface AppearanceState {
  readonly theme?: 'system' | 'light' | 'dark';
  readonly colorScheme?: ColorSchemeId;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly lineHeight?: number;
  readonly paragraphSpacing?: number;
  readonly contentWidth?: number;
  readonly codeFontFamily?: string;
  readonly terminalFontSize?: number;
  readonly terminalLineHeight?: number;
}

/** 面板内 Markdown 文件预览状态。 */
export interface MarkdownPreviewData {
  readonly path: string;
  readonly title: string;
  readonly content?: string;
  readonly error?: string;
}

/**
 * 附带给底层的编辑器上下文：当前文件（只给路径，底层需要时自己读）或选中的代码（带内容和行号）。
 * `path` 是工作区相对路径（工作区外为绝对路径）。
 */
export interface AttachmentView {
  readonly kind: 'file' | 'selection';
  readonly path: string;
  /** 选区的起止行（从 1 开始）。 */
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * 消息里的一张图片。已经存进 dsh 的用 `attachmentId` 按需读取；还在发送中的本地回显用 `localId`，
 * 图片内容留在 Webview 里，不随视图模型来回传。
 */
export interface ImageView {
  readonly attachmentId?: string;
  readonly localId?: string;
  readonly mediaType: string;
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
}

/** 输入框上方的上下文标签。 */
export interface ContextState {
  /** 当前编辑器：有选区时是选区，否则是文件。`key` 变化时 Webview 恢复默认的附带状态。 */
  readonly active?: AttachmentView & { readonly key: string };
  /** 默认是否附带当前编辑器（设置 `harnessDeck.context.includeActiveEditor`）。 */
  readonly includeActiveByDefault: boolean;
  /** 用「添加到对话」固定下来的选区，发送后清空。 */
  readonly pinned: readonly (AttachmentView & { readonly id: string })[];
}

/** 斜杠命令：插件自带的模板，或 dsh 原生命令。 */
export interface CommandView {
  readonly name: string;
  readonly description: string;
  /** 参数提示，例如 `<text>`。 */
  readonly hint?: string;
  /** plugin：插件自带的模板；agent：底层（dsh 或 ACP 代理）的斜杠命令；skill：底层的 skill（也用 `/name` 调用）。 */
  readonly source: 'plugin' | 'agent' | 'skill';
}

/** `@` 补全的候选。 */
export interface FileCandidate {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

/** 对话流中的一个条目。`id` 在同一个会话内稳定，Webview 按 id 增量更新。 */
export type Item =
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly text: string;
      /** 本地回显的状态：发送中 / 已被 dsh 接收但还在排队 / 发送失败。持久消息没有这个字段。 */
      readonly pending?: 'sending' | 'queued' | 'failed';
      readonly requestId?: string;
      readonly error?: string;
      /** 随消息附带的编辑器上下文（从消息末尾的上下文块解析出来，正文里不显示）。 */
      readonly attachments?: readonly AttachmentView[];
      /** 随消息发送的图片。 */
      readonly images?: readonly ImageView[];
      /** 在 dsh 队列里等待的消息：可以编辑、删除、插队。`next-step` 表示已插队，在当前回复的下一步送达。 */
      readonly queue?: { readonly itemId: string; readonly target: 'next-turn' | 'next-step' };
    }
  | {
      readonly kind: 'assistant';
      readonly id: string;
      readonly markdown: string;
      readonly reasoning?: string;
      /** 正在流式输出。 */
      readonly streaming: boolean;
      /** 用户停止生成后保留下来的部分回复。 */
      readonly interrupted?: boolean;
    }
  | {
      readonly kind: 'activity';
      readonly id: string;
      readonly tool: string;
      /** 渲染样式：命令、文件修改、子代理、其他。 */
      readonly variant: 'command' | 'edit' | 'subagent' | 'generic';
      /** 一行摘要：工具名和参数，用 `joinLabel` 拼、`splitLabel` 拆（见 labels.ts），例如 `bash` + `pnpm test`。文件修改时是文件路径。 */
      readonly label: string;
      readonly status: 'running' | 'ok' | 'error';
      /** 展开后显示的结果文本（已截断）。 */
      readonly output?: string;
      /** 文件修改的增删行数。 */
      readonly stats?: LineStats;
      /** 新建文件。 */
      readonly created?: boolean;
      /** 可以打开 Diff。 */
      readonly diff?: DiffRef;
      /** 子代理（variant 为 subagent）：委派的任务、状态和最终回答。 */
      readonly subagent?: SubagentView;
    }
  | {
      /** 连续的只读操作（读文件、搜索）合并成一行。 */
      readonly kind: 'explore';
      readonly id: string;
      readonly summary: string;
      readonly status: 'running' | 'ok' | 'error';
      readonly entries: readonly {
        readonly id: string;
        /** 工具名和目标，格式同活动行的 `label`。 */
        readonly label: string;
        readonly status: 'running' | 'ok' | 'error';
        /** 读取的是一个文件时它的路径（工作区相对或绝对）：点击打开。 */
        readonly path?: string;
      }[];
    }
  | {
      /** 一轮结束时的改动汇总。 */
      readonly kind: 'changes';
      readonly id: string;
      readonly turn: number;
      /** turn：dsh 记录的本轮改动（含命令造成的）；tools：Host 重启后汇总不可用，退回按文件工具汇总。 */
      readonly source: 'turn' | 'tools';
      readonly files: readonly ChangedFileView[];
      readonly total: number;
    }
  | {
      /** 一轮结束：显示这一轮用了多久（来自 dsh 的 turn/start、turn/end 时间）。 */
      readonly kind: 'turnDone';
      readonly id: string;
      readonly durationMs: number;
      /** 正常完成；被停止或出错时这一轮另有提示，这里只显示用时。 */
      readonly completed: boolean;
    }
  | {
      readonly kind: 'notice';
      readonly id: string;
      readonly level: 'info' | 'warning' | 'error';
      readonly text: string;
      /** 可选的处理入口，例如缺少 API Key 时打开 dsh 设置。 */
      readonly action?: { readonly kind: 'openWebUI' | 'configureApiKey'; readonly label: string };
    };

/**
 * 一个子代理。dsh 的 subagent 工具立即返回子会话 id，子代理在后台运行；
 * 结束时父会话收到一条 `subagent-settled` 通知，带着子代理的最终回答。
 */
export interface SubagentView {
  /** 子会话 id；工具还没返回时没有。 */
  readonly childId?: string;
  /** 交给子代理的任务。 */
  readonly prompt?: string;
  readonly state: 'running' | 'done' | 'failed';
  /** 子代理的最终回答（Markdown），或失败原因。 */
  readonly result?: string;
  /** 开始和结束的时间（毫秒时间戳，dsh 所在机器的时钟）。 */
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface QuestionView {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly detail?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
  /** 计划审阅（`exit_plan_mode`）：`detail` 是计划的 Markdown，批准选项的标签是 `approve`。 */
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string; readonly keepPlanning?: string };
}

/** 等待用户处理的请求，显示在对话流末尾。 */
export type PendingInteraction =
  | {
      readonly kind: 'approval';
      readonly id: string;
      readonly toolName: string;
      /** dsh 给出的原因（优先中文）。 */
      readonly reason: string;
      /** 要执行的命令或要修改的文件。 */
      readonly subject?: string;
      readonly subjectKind?: 'command' | 'file';
      /** 能预览将要写入的内容。 */
      readonly previewable: boolean;
      /** 要修改的文件在 VS Code 里有未保存内容：先保存或放弃，避免冲突。 */
      readonly dirtyFiles: readonly string[];
      /** 底层提供「始终允许」这一类操作时的按钮文字（ACP 代理的 allow_always 选项）；没有时只有允许本次 / 拒绝。 */
      readonly allowAlways?: string;
    }
  | {
      readonly kind: 'question';
      readonly id: string;
      readonly questions: readonly QuestionView[];
    };

export interface SessionListItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly running: boolean;
  /** 有等待处理的审批或提问。 */
  readonly needsAttention?: boolean;
}

export interface ModelOption {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly group: string;
  readonly description?: string;
  readonly efforts: readonly { readonly id: string; readonly name: string }[];
  readonly defaultEffort?: string;
}

export interface ModelState {
  /** 模型目录为空：还没有配置 API Key。 */
  readonly needsApiKey?: boolean;
  readonly options: readonly ModelOption[];
  readonly current?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string };
}

export interface PermissionState {
  /** dsh 的权限预设目录（read-only、workspace-write、danger-full-access 及用户自定义的）。 */
  readonly options: readonly string[];
  /** 当前会话的预设；不匹配任何预设时为 custom。 */
  readonly current?: string;
  /** 底层给的显示名和说明（ACP 代理的模式）；没有时用 dsh 预设的翻译名或原名。 */
  readonly labels?: Readonly<Record<string, { readonly name: string; readonly description?: string }>>;
}

/** 当前会话（或尚未创建的新对话）的元信息。 */
export interface SessionHeader {
  /** undefined 表示新对话：第一条消息发送时才在 dsh 里创建会话。 */
  readonly id?: string;
  readonly title: string;
  readonly running: boolean;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** 与 dsh 的同步状态。 */
  readonly sync: 'idle' | 'opening' | 'live' | 'disconnected' | 'failed';
  readonly failure?: string;
  /** 上下文窗口占用比例，0–1。 */
  readonly contextUsage?: number;
  /** 上下文已用和窗口大小（token），用于提示。 */
  readonly contextTokens?: { readonly used: number; readonly window: number };
  /** 会话列表还在读取。 */
  readonly listLoading?: boolean;
  /** 计划模式（`/plan`）：dsh 只做计划，不改文件。 */
  readonly planMode?: boolean;
  /** dsh 的待办列表（`todo_write`），没有时为 undefined。 */
  readonly todos?: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[];
  /** 长任务目标（`/goal`）。 */
  readonly goal?: {
    readonly objective: string;
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete';
    readonly round: number;
    readonly maxRounds: number;
    readonly blockedReason?: string;
  };
  /** 多根工作区时当前对应的文件夹名。 */
  readonly folder?: string;
  /** 当前这一轮开始的时间（毫秒时间戳，dsh 所在机器的时钟）；运行中才有。 */
  readonly runningSince?: number;
  /** 这是一个子代理的会话：只能查看，消息由父会话里的代理发送。 */
  readonly subagentOf?: { readonly parentId: string };
  /** 本会话（已加载的历史里）改过的文件；没有改动时为 undefined。 */
  readonly changes?: SessionChangesView;
}

/** 对话面板里打开的一个标签：一个会话，或还没发送第一条消息的新对话。 */
export interface TabView {
  /** 标签的标识，切换、关闭时用；新对话的标签在第一条消息发送后仍沿用同一个 key。 */
  readonly key: string;
  readonly sessionId?: string;
  readonly title: string;
  readonly running: boolean;
  /** 有等待处理的审批或提问。 */
  readonly needsAttention?: boolean;
}

export interface TabsState {
  readonly items: readonly TabView[];
  readonly active: string;
}

/**
 * 底层：dsh（插件内置）或通过 ACP（Agent Client Protocol）接入的编程代理，例如 oh-my-pi。
 * 设置里可以配多个，界面上随时切换。
 */
export interface BackendView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'dsh' | 'acp';
  /** ACP 代理的启动命令（完整命令行，用于展示）。 */
  readonly command?: string;
  /** ACP 代理的可执行文件名/路径（用于表单编辑）。 */
  readonly executable?: string;
  /** ACP 代理的启动参数列表。 */
  readonly args?: readonly string[];
  /** ACP 代理的额外环境变量。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 是否单会话进程模式。 */
  readonly singleSession?: boolean;
  /** 是否为内置智能体。 */
  readonly builtin?: boolean;
  /** 是否为用户自定义新增的外部智能体。 */
  readonly custom?: boolean;
  /** 内置 ACP 智能体是否已在 harnessDeck.backends 中被用户配置覆盖。 */
  readonly overridden?: boolean;
  /** 本机能不能找到这个底层的命令；undefined 表示还在检查。 */
  readonly available?: boolean;
  /** 当前已安装的版本（通过 npm list 或命令行探测）。 */
  readonly version?: string;
  /** 支持通过 npm 安装/卸载/切换版本的包名（内置底层）。 */
  readonly npmPackage?: string;
  /** 可用的版本列表（从新到旧）；undefined 表示尚未拉取。 */
  readonly versions?: readonly string[];
  /** 正在拉取版本列表。 */
  readonly versionsLoading?: boolean;
  /** 拉取版本列表失败时的说明。 */
  readonly versionsError?: string;
  /** 正在进行安装、卸载或切换版本。 */
  readonly busy?: 'installing' | 'uninstalling' | 'switching';
  /** 找不到时的安装命令（内置底层），可以复制。 */
  readonly installCommand?: string;
  /** 找不到时的安装提示（设置里写的 installHint）。 */
  readonly installHint?: string;
}

/** 本机 Node.js 与 npm 的探测结果（底层通过 npm 安装和管理）。 */
export interface NodeEnvState {
  readonly checked: boolean;
  readonly hasNode: boolean;
  readonly hasNpm: boolean;
  readonly nodeVersion?: string;
  readonly npmVersion?: string;
}

export interface BackendsState {
  readonly items: readonly BackendView[];
  readonly active: string;
  /** 底层工作的文件夹名（首页显示）。 */
  readonly workspace?: string;
  /** 系统 Node.js 与 npm 状态。 */
  readonly nodeEnv?: NodeEnvState;
}

/** 系统通知偏好（对应 harnessDeck.notifications.*）。 */
export interface NotificationPreferences {
  readonly enabled: boolean;
  /** 仅在窗口不在前台时通知。 */
  readonly onlyWhenUnfocused: boolean;
  /** Agent 等待确认（审批、提问、计划审阅）时通知。 */
  readonly onAttention: boolean;
  /** Agent 完成一轮回复时通知。 */
  readonly onTurnComplete: boolean;
  /** Agent 或运行环境异常退出时通知。 */
  readonly onUnexpectedExit: boolean;
  /** 定时任务 / 目标任务完成时通知。 */
  readonly onScheduledComplete: boolean;
}

/** 诊断与高级运行时偏好。 */
export interface AdvancedPreferences {
  readonly dshPath: string;
  readonly dshProfile: string;
  readonly backendTrace: boolean;
}

/** 面板设置页里的通用偏好（对应 harnessDeck.* 设置）。 */
export interface PreferencesState {
  readonly language: 'auto' | 'zh' | 'en';
  readonly includeActiveEditor: boolean;
  readonly showTurnChanges: boolean;
  /** 定时任务无人值守默认权限（默认 danger-full-access「全部放行」）。 */
  readonly schedulePermission?: 'danger-full-access' | 'workspace-write' | 'read-only';
  readonly notifications?: NotificationPreferences;
  readonly advanced?: AdvancedPreferences;
}

/** 单个项目新建 worktree 时的配置。 */
export interface WorktreeProjectConfig {
  readonly copyFiles: readonly string[];
  readonly setupCommands: readonly string[];
  readonly verifyCommands: readonly string[];
}

/** 最近使用的项目。 */
export interface RecentProject {
  readonly path: string;
  readonly name: string;
  readonly lastOpenedAt: number;
  readonly isCurrent?: boolean;
}

/** 项目与 worktree 设置状态。 */
export interface ProjectsState {
  readonly currentPath?: string;
  readonly recent: readonly RecentProject[];
  readonly configs: Readonly<Record<string, WorktreeProjectConfig>>;
}

export interface WorkspaceState {
  /** 工作区里有未保存内容的文件数。 */
  readonly dirtyFiles: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected';

/** 界面语言：跟随 VS Code 的显示语言（中文用 zh，其他用 en），可以用设置 `harnessDeck.ui.language` 指定。 */
export type Locale = 'zh' | 'en';

// ────────────────────────────────────────────────────────────
// 工作台（Workbench）五大模块视图模型：总览 / 定时 / 智能体 / 任务 / 会话
// ────────────────────────────────────────────────────────────

/** 定时触发规则：每天、每周、固定间隔（分钟）或单次定时。 */
export type ScheduleFrequency =
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekly'; readonly days: readonly number[]; readonly time: string }
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'once'; readonly runAt: number };

/** 单条定时规则的一次执行记录（保存在规则自身历史里，不进入左侧会话列表）。 */
export interface ScheduleRunRecord {
  readonly id: string;
  readonly ruleId: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly backendId: string;
  readonly projectPath: string;
  readonly sessionId?: string;
  readonly output?: string;
  readonly error?: string;
  readonly unread?: boolean;
}

/** 定时任务规则。 */
export interface ScheduleRule {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly frequency: ScheduleFrequency;
  readonly backendId: string;
  readonly projectPath: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly lastStatus?: 'running' | 'succeeded' | 'failed';
  readonly runs: readonly ScheduleRunRecord[];
}

/** 智能体工具与权限配置。 */
export interface AgentToolConfig {
  readonly permissionPreset: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly readSearch: boolean;
  readonly editWrite: boolean;
  readonly bashCommand: boolean;
  readonly webFetch: boolean;
  readonly mcpTools: boolean;
}

/** 工作台「智能体」预设：保存专长、指令、模型与工具配置，支持直接开启会话或接受任务委派。 */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly instructions: string;
  readonly backendId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly tools: AgentToolConfig;
  readonly builtin?: boolean;
  readonly updatedAt: number;
}

/** 工作台「任务」看板卡片（待执行 / 执行中 / 待验收 / 已完成）。 */
export interface KanbanTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskColumn;
  readonly projectPath: string;
  readonly projectName: string;
  readonly backendId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly unread?: boolean;
}

export interface TaskBoardState {
  readonly items: readonly KanbanTask[];
  /** 是否开启按顺序连续自动执行待执行队列。 */
  readonly autoRun: boolean;
}

/** 按项目分组展示的会话条目。 */
export interface GroupedSessionItem {
  readonly id: string;
  readonly title: string;
  readonly projectPath: string;
  readonly backendId: string;
  readonly backendName: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly needsAttention?: boolean;
  readonly unread?: boolean;
  readonly agentName?: string;
}

/** 按项目归组的会话集合。 */
export interface ProjectSessionGroup {
  readonly projectPath: string;
  readonly projectName: string;
  readonly isCurrent: boolean;
  readonly sessions: readonly GroupedSessionItem[];
}

/** 总览模块五大核心区块的数据条目。 */
export interface OverviewWaitingItem {
  readonly id: string;
  readonly kind: 'interaction' | 'task-review';
  readonly title: string;
  readonly subtitle: string;
  readonly projectName?: string;
  readonly backendName?: string;
  readonly sessionId?: string;
  readonly projectPath?: string;
  readonly backendId?: string;
  readonly taskId?: string;
}

export interface OverviewTodoItem {
  readonly id: string;
  readonly kind: 'agent-todo' | 'kanban-todo';
  readonly content: string;
  readonly status: 'pending' | 'in_progress';
  readonly contextLabel?: string;
  readonly sessionId?: string;
  readonly projectPath?: string;
  readonly backendId?: string;
  readonly taskId?: string;
}

export interface OverviewRunningItem {
  readonly id: string;
  readonly kind: 'session' | 'task' | 'schedule';
  readonly title: string;
  readonly backendName: string;
  readonly projectName?: string;
  readonly startedAt?: number;
  readonly sessionId?: string;
  readonly projectPath?: string;
  readonly backendId?: string;
  readonly taskId?: string;
  readonly ruleId?: string;
}

export interface OverviewUpcomingItem {
  readonly id: string;
  readonly kind: 'schedule' | 'queued-task';
  readonly title: string;
  readonly backendName: string;
  readonly projectName?: string;
  readonly nextRunAt?: number;
  readonly queuePosition?: number;
  readonly ruleId?: string;
  readonly taskId?: string;
}

export interface OverviewUnreadItem {
  readonly id: string;
  readonly kind: 'session' | 'schedule-run' | 'task-review';
  readonly title: string;
  readonly summary: string;
  readonly timestamp: number;
  readonly sessionId?: string;
  readonly projectPath?: string;
  readonly backendId?: string;
  readonly ruleId?: string;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface WorkbenchOverview {
  readonly waiting: readonly OverviewWaitingItem[];
  readonly todos: readonly OverviewTodoItem[];
  readonly running: readonly OverviewRunningItem[];
  readonly upcoming: readonly OverviewUpcomingItem[];
  readonly unread: readonly OverviewUnreadItem[];
}

export interface WorkbenchState {
  readonly overview: WorkbenchOverview;
  readonly schedules: readonly ScheduleRule[];
  readonly agents: readonly AgentProfile[];
  readonly tasks: TaskBoardState;
  readonly sessionGroups: readonly ProjectSessionGroup[];
}

/**
 * 界面视图模型。由 Extension Host 从底层（dsh 或 ACP 代理）及宿主状态投影得到，Webview 只负责渲染。
 * 这里的类型是插件自己的，不直接暴露任何底层的原始事件结构（docs/DESIGN.md D8）。
 */

import type { TaskColumn } from './limits.ts';

export type { ImageMediaType, TaskColumn, WorkbenchModule } from './limits.ts';

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
 * - 主题：`theme`（浅色/深色/跟随系统）。
 * - 阅读与聊天：`fontFamily`、`fontSize`、`lineHeight`、`paragraphSpacing`、`contentWidth` 共用于聊天回复、计划和 Markdown 文件预览，切换主题不会改变这些设置。
 * - 终端与代码：`codeFontFamily`、`terminalFontSize`、`terminalLineHeight`。
 */
export type ThemePreset = 'default' | 'grove' | 'ocean' | 'ember' | 'iris';

export interface AppearanceState {
  readonly theme?: 'system' | 'light' | 'dark';
  /** 精选 OKLCH 配色预设（default 为 Quiet Zinc / Cool Slate）。 */
  readonly preset?: ThemePreset;
  /** 高对比度增强模式（提升边框与文本对比度）。 */
  readonly highContrast?: boolean;
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

/** 斜杠命令：插件自带的模板、底层命令、或用户自定义的聊天命令。 */
export interface CommandView {
  readonly name: string;
  readonly description: string;
  /** 参数提示，例如 `<text>`。 */
  readonly hint?: string;
  /** plugin：插件自带的模板；agent：底层（dsh 或 ACP 代理）的斜杠命令；skill：底层的 skill（也用 `/name` 调用）；custom：用户保存的聊天命令。 */
  readonly source: 'plugin' | 'agent' | 'skill' | 'custom';
  /** 用户保存的聊天命令提示词全文；选用时填入输入框，可改再发。 */
  readonly prompt?: string;
}

/**
 * 用户在「设置 -> 会话 -> 聊天命令」中保存的常用提示词模板。
 * 在输入框输入 `/` 即可检索选用，填入输入框后可继续修改再发送；所有 Agent 通用。
 */
export interface ChatCommand {
  readonly name: string;
  readonly prompt: string;
  readonly description?: string;
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

/** 一组 token 用量。`input` 只算未命中缓存的输入；缓存读取、写入单独计数。 */
export interface TokenBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** 输出中的推理部分（已包含在 output 里），底层不提供时为 undefined。 */
  readonly reasoning?: number;
}

/** 最近一次模型请求的响应性能指标（首字耗时与生成速度）。 */
export interface RequestPerformance {
  /** 首字耗时（从发起请求到收到首个模型输出/推理字符的毫秒数）。 */
  readonly ttftMs?: number;
  /** 生成速度（输出 token / 秒）。 */
  readonly tokensPerSec?: number;
  /** 本轮请求耗时（毫秒）。 */
  readonly durationMs?: number;
}

/** 上下文用量明细。 */
export interface ContextDetail {
  /** 最近一次模型请求的用量。 */
  readonly lastRequest?: TokenBreakdown;
  /** 本会话累计用量（底层给出的或本插件观察到的部分）。 */
  readonly session?: TokenBreakdown;
  /** 累计的模型请求次数。 */
  readonly requests?: number;
  /** 累计费用。 */
  readonly cost?: { readonly amount: number; readonly currency: string };
  /** 最近一次请求的响应性能（首字耗时、输出速度）。 */
  readonly performance?: RequestPerformance;
}

/** 订阅余量的展示模式：百分比双圆环（按时间窗口）或积分余额式（如 CodeBuddy）。 */
export type QuotaDisplayMode = 'percent' | 'credits';

/** 官方订阅的一个限额窗口（5 小时 / 每周 / 按模型的每周 / 计费周期）。百分比均为 0–100。 */
export interface QuotaWindowView {
  readonly kind: 'session' | 'weekly' | 'weeklyModel' | 'cycle';
  /**
   * 窗口附加名：按模型的每周填模型名（如 `Fable`）；Antigravity 的标准额度池填保留值
   * `gemini` / `3p`（Webview 翻译成池名），独立模型池保留服务端分组名（如 `Gemini 4 Argon`）；
   * CodeBuddy 计费周期可留空或用包名。
   */
  readonly label: string;
  /** 该额度分组包含的模型名列表（例如 Antigravity 额度池下的模型清单），底层未提供时为 undefined。 */
  readonly models?: readonly string[];
  readonly usedPercent: number;
  readonly remainingPercent: number;
  /** 积分模式下该窗口的绝对余额 / 总量 / 已用量（如 CodeBuddy 积分），底层未提供时为 undefined。 */
  readonly remainingAmount?: number;
  readonly totalAmount?: number;
  readonly usedAmount?: number;
  /** 可选自定义单位（如 `credits` / `积分`）；缺省时按界面语言包展示积分单位。 */
  readonly unit?: string;
  /** 重置时间（epoch ms），底层没给或尚未消耗时为 undefined。 */
  readonly resetsAt?: number;
  readonly severity?: 'normal' | 'warning' | 'critical';
  readonly isActive?: boolean;
}

/** 官方订阅用量与限额余量。由宿主查询后下发，不含任何凭据信息。 */
export interface QuotaView {
  /** 展示模式：未指定时默认 `'percent'`（窗口包含绝对积分数时自动按 `'credits'` 展示）。 */
  readonly mode?: QuotaDisplayMode;
  readonly windows: readonly QuotaWindowView[];
  /** 额外用量（按量计费的额度池），底层没开启时为 undefined。 */
  readonly extraUsage?: { readonly usedPercent: number; readonly remainingPercent: number };
  /** 查询时间（epoch ms）。 */
  readonly queriedAt: number;
}

/** 一轮对话：从用户消息开始，到 `turnDone`（或下一条用户消息）结束。 */
export interface TurnView {
  /** 这一轮的用户消息 id。 */
  readonly id: string;
  /** 从 1 开始的轮次。 */
  readonly seq: number;
  readonly status: 'running' | 'completed' | 'interrupted' | 'failed';
  /** 本轮用时（底层提供时）。 */
  readonly durationMs?: number;
  /** 本轮 token 用量（底层提供时；目前保留字段，尚未填充）。 */
  readonly usage?: TokenBreakdown;
  /** 本轮真正改过的文件（编辑活动与每轮改动汇总，去重）。 */
  readonly authoredPaths: readonly string[];
}

/** 当前会话（或尚未创建的新对话）的元信息。 */
export interface SessionHeader {
  /** undefined 表示新对话：第一条消息发送时才在 dsh 里创建会话。 */
  readonly id?: string;
  readonly title: string;
  readonly running: boolean;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** 从条目推导出的回合：每轮的用户消息、状态、用时和改过的文件（见 `turns.ts`）。 */
  readonly turns?: readonly TurnView[];
  /** 与 dsh 的同步状态。 */
  readonly sync: 'idle' | 'opening' | 'live' | 'disconnected' | 'failed';
  readonly failure?: string;
  /** 上下文窗口占用比例，0–1。 */
  readonly contextUsage?: number;
  /** 上下文已用和窗口大小（token），用于提示。 */
  readonly contextTokens?: { readonly used: number; readonly window: number };
  /** 上下文用量明细（缓存读写、输入输出、累计与费用），悬浮在上下文圆环上时展示；底层不提供时为 undefined。 */
  readonly contextDetail?: ContextDetail;
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
  /** 已记录 Git 检查点的回合序号列表（1-based，跨底层通用）。 */
  readonly checkpoints?: readonly number[];
  /** 当前会话绑定的独立 worktree 路径（如有）。 */
  readonly worktreePath?: string;
  /** 当前会话绑定的 worktree 分支名（如有）。 */
  readonly worktreeBranch?: string;
}

/** 对话面板里打开的一个标签：一个会话，或还没发送第一条消息的新对话。 */
export interface TabView {
  /** 标签的标识，切换、关闭时用；新对话的标签在第一条消息发送后仍沿用同一个 key。 */
  readonly key: string;
  readonly sessionId?: string;
  /** 所属智能体（底层）id：用于在标签标题前展示智能体图标并支持跨智能体切换。 */
  readonly backendId?: string;
  /** 所属智能体显示名（用于图标回退与悬浮提示）。 */
  readonly backendName?: string;
  readonly title: string;
  readonly running: boolean;
  /** 有等待处理的审批或提问。 */
  readonly needsAttention?: boolean;
  /** 该标签绑定的独立 worktree 路径（支持多 worktree 并行运行）。 */
  readonly worktreePath?: string;
  /** 该标签绑定的 worktree 分支名。 */
  readonly worktreeBranch?: string;
}

export interface TabsState {
  readonly items: readonly TabView[];
  readonly active: string;
}

/** 第三方服务商协议能力：底层支持哪些协议，或只能用账号登录（无法绑定第三方服务商）。 */
export type BackendProtocolCapability =
  | { readonly kind: 'supported'; readonly protocols: readonly ProviderProtocol[] }
  | { readonly kind: 'account-only' };

/** 能查询订阅额度的服务商。 */
export type QuotaProviderId = 'claude' | 'antigravity' | 'codebuddy';

/** 官方账号的隔离策略。 */
export type AccountIsolationKind = 'config-dir' | 'credential-slot' | 'api-key' | 'single';

/** 官方渠道的登录触发方式。 */
export type AccountLoginKind = 'oauth-cli' | 'terminal' | 'acp-auth' | 'api-key';

/** 底层官方账号管理能力描述符。 */
export interface BackendAccountCapability {
  /** 是否支持官方渠道账号管理与登录。 */
  readonly supported: boolean;
  /** 是否支持添加并切换多个不同的官方账号。 */
  readonly multiAccount: boolean;
  /** 多账号隔离策略。 */
  readonly isolation: AccountIsolationKind;
  /** 触发官方登录的默认方式。 */
  readonly loginKind: AccountLoginKind;
  /** 是否支持区分区域（例如 CodeBuddy 的国内/国际/内部版）。 */
  readonly supportsRegion?: boolean;
  /** 是否支持按账号查询官方订阅额度。 */
  readonly supportsQuota?: boolean;
  /** 是否支持为该账号独立隔离会话历史（config-dir 隔离时可选）。 */
  readonly supportsSessionIsolation?: boolean;
}

/**
 * 底层能做什么：由底层的描述符声明，界面只读这里，不再按 id / kind 判断功能是否可用。
 * 权限档位不在这里：它随会话由底层下发（`PermissionState.options`），每个底层可能不同。
 */
export interface BackendCapabilities {
  /** 可绑定的第三方服务商协议。 */
  readonly protocols: BackendProtocolCapability;
  /** 可查询订阅额度时对应的服务商；不填表示不支持。 */
  readonly quota?: QuotaProviderId;
  /** 官方渠道账号管理与多账号隔离能力。 */
  readonly account?: BackendAccountCapability;
  /** 能在浏览器打开底层自带的 Web UI（dsh 网页）。 */
  readonly webUi: boolean;
  /** 支持在插件里配置 API Key（dsh）。 */
  readonly apiKeySetup: boolean;
  /** 审批卡片显示底层的审批说明。 */
  readonly approvalHint: boolean;
  /** 回复过程中发送的消息可以插队到当前轮。 */
  readonly steer: boolean;
  /** 每轮结束汇总改动，包含命令造成的改动。 */
  readonly turnChanges: boolean;
  /** 子代理卡片。 */
  readonly subagents: boolean;
  /** 提问卡片（底层向用户提问）。 */
  readonly questions: boolean;
  /** `/goal` 持续目标。 */
  readonly goal: boolean;
  /** 支持随消息发送图片。 */
  readonly images: boolean;
  /** 回合级回滚能力：native 为底层原生；files 为按记录的工具片段恢复文件（对话不回退）；none 不支持。 */
  readonly rollback: 'native' | 'files' | 'none';
  /** 可以在独立的 git worktree 里运行会话。 */
  readonly worktree: boolean;
}

/**
 * 底层：内置原生接入的 DeepSeek (dsh)、Claude Code (`claude -p`)、Codex (`codex app-server`)、CodeBuddy (`codebuddy -p`)、Pi (`pi --mode rpc`)、ZCode (`zcode app-server --stdio`)，
 * 或通过 ACP（Agent Client Protocol）接入的编程代理（如 OpenCode、Antigravity）。
 * 设置里可以配多个，界面上随时切换。
 */
export interface BackendView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'dsh' | 'zcode' | 'claude' | 'pi' | 'codex' | 'codebuddy' | 'acp';
  /** 接入协议；与 kind 相同，独出来为后续多账号实例做准备。 */
  readonly driver?: string;
  /** 账号实例标识；旧数据没有时回退到 id。 */
  readonly instanceId?: string;
  /** 这个底层支持的功能；界面只读这里判断是否显示或置灰。宿主总会下发，旧快照或测试可省略，界面用 `backendCapabilities` 兜底。 */
  readonly capabilities?: BackendCapabilities;
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
  /** 本机已找到的底层是否归当前 npm 管理；false 表示由 Homebrew/mise 等外部方式安装，界面只提供手动命令。 */
  readonly npmOwned?: boolean;
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
  /** dsh 网页的地址（本机 origin，不含启动令牌）；点击由宿主转发端口并在浏览器打开。 */
  readonly webUrl?: string;
  /** 该智能体在当前窗口进程中是否已启动保活。 */
  readonly alive?: boolean;
  /** 该智能体在当前窗口进程中是否有会话正在执行回复。 */
  readonly running?: boolean;
  /** 该智能体当前激活的模型渠道（官方账号或第三方服务商）。 */
  readonly activeChannel?: BackendChannelBinding;
}

/** 本机 Node.js 与 npm 的探测结果（底层通过 npm 安装和管理）。 */
export interface NodeEnvState {
  readonly checked: boolean;
  readonly hasNode: boolean;
  readonly hasNpm: boolean;
  readonly nodeVersion?: string;
  readonly npmVersion?: string;
}

/** 从用户配置的 ACP 注册表读取到的一条底层。 */
export interface AcpRegistryEntry {
  readonly id: string;
  readonly name: string;
  /** 可执行文件名（不含参数）。 */
  readonly command: string;
  readonly args?: readonly string[];
  readonly description?: string;
  readonly install?: string;
  readonly docs?: string;
}

export interface AcpRegistryState {
  readonly entries: readonly AcpRegistryEntry[];
  /** 注册表地址。 */
  readonly source?: string;
  readonly error?: string;
  readonly fetchedAt?: number;
}

export interface BackendsState {
  readonly items: readonly BackendView[];
  readonly active: string;
  /** 启动时默认启动的智能体 id（在设置中选中当前智能体时同步设为默认）。 */
  readonly defaultBackend?: string;
  /** 底层工作的文件夹名（首页显示）。 */
  readonly workspace?: string;
  /** 系统 Node.js 与 npm 状态。 */
  readonly nodeEnv?: NodeEnvState;
  /** 用户配置的 ACP 注册表地址（可为空）。 */
  readonly registryUrl?: string;
  /** 最近一次拉取的注册表内容。 */
  readonly registry?: AcpRegistryState;
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
  readonly zcodePath?: string;
  readonly claudePath?: string;
  readonly piPath?: string;
  readonly codexPath?: string;
  readonly codebuddyPath?: string;
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
  /** 用户保存的聊天命令（存好的提示词，所有 Agent 通用）。 */
  readonly chatCommands?: readonly ChatCommand[];
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

// ────────────────────────────────────────────────────────────
// 设置 -> 扩展（技能 Skills + MCP 服务器统一管理）
// ────────────────────────────────────────────────────────────

/** 从 Git 仓库或本地目录安装的 Agent Skill（SKILL.md）。 */
export interface InstalledSkillView {
  /** 唯一标识（规范化目录名）。 */
  readonly id: string;
  /** SKILL.md 中的名称。 */
  readonly name: string;
  /** SKILL.md 中的描述。 */
  readonly description: string;
  /** 来源 Git 仓库地址或本地目录路径。 */
  readonly repoUrl: string;
  /** 来源类型：默认 git，本地导入为 local。 */
  readonly sourceKind?: 'git' | 'local';
  /** 本地导入来源标记（如 Claude Code、Codex、本地目录等）。 */
  readonly importedFrom?: string;
  /** 分支、Tag 或 Commit 引用（可选）。 */
  readonly ref?: string;
  /** 仓库内的相对子目录路径（根目录为空或 undefined）。 */
  readonly subpath?: string;
  /** 安装或最近同步时的 Git commit 短哈希。 */
  readonly commit?: string;
  /** 本地已安装的 SKILL.md 绝对路径（支持面板内 Markdown 预览）。 */
  readonly skillMdPath: string;
  /** 是否启用（启用时在目标 Agent 启动时自动带上）。 */
  readonly enabled: boolean;
  /** 限定的目标 Agent id 列表；undefined 或空数组表示对所有 Agent 生效。 */
  readonly agents?: readonly string[];
  readonly installedAt: number;
  readonly updatedAt: number;
  /** 正在同步更新或移除。 */
  readonly busy?: 'updating' | 'removing';
}

/** 扫描 Git 仓库发现的候选 Skill。 */
export interface DiscoveredGitSkill {
  readonly name: string;
  readonly description: string;
  /** 仓库内的相对子目录路径（根目录为空字符串）。 */
  readonly subpath: string;
}

/** 从本机各 Agent 技能目录或用户选择的本地目录扫描出的可导入 SKILL.md 候选。 */
export interface SkillImportCandidate {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** 技能目录绝对路径（内含 SKILL.md）。 */
  readonly sourceDir: string;
  readonly sourceAgentId: string;
  readonly sourceAgentName: string;
  /** 当前已安装技能列表中是否已存在同 ID 技能。 */
  readonly conflict?: boolean;
}

export type SkillMarketCategory = 'dev' | 'frontend' | 'docs' | 'design';

/** 技能市场中的单个可安装技能条目（支持宿主在线实时拉取与离线精选兜底）。 */
export interface SkillMarketItem {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly ref: string;
  readonly subpath: string;
  readonly category: SkillMarketCategory;
  readonly description: string;
  readonly descZh?: string;
  readonly descEn?: string;
  /** 来自在线市场（如 skills.sh）的安装热度统计。 */
  readonly installs?: number;
}

export interface SkillMarketState {
  readonly items: readonly SkillMarketItem[];
  readonly loading?: boolean;
  readonly source: 'online' | 'fallback';
  readonly query?: string;
  readonly updatedAt?: number;
  readonly error?: string;
}

export interface SkillsState {
  readonly items: readonly InstalledSkillView[];
  readonly installing?: boolean;
  readonly scanning?: boolean;
  readonly scanned?: {
    readonly repoUrl: string;
    readonly ref?: string;
    readonly skills: readonly DiscoveredGitSkill[];
  };
  readonly scanningImport?: boolean;
  readonly importCandidates?: readonly SkillImportCandidate[];
  readonly scannedSources?: readonly string[];
  readonly market?: SkillMarketState;
  readonly error?: string;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

/** 统一管理的一台 MCP 服务器配置。 */
export interface McpServerConfig {
  /** 唯一标识。 */
  readonly id: string;
  /** 传给 Agent 的 MCP 服务器名称（如 github、context7）。 */
  readonly name: string;
  readonly transport: McpTransport;
  /** stdio 模式可执行命令。 */
  readonly command?: string;
  /** stdio 模式命令参数。 */
  readonly args?: readonly string[];
  /** stdio 模式额外环境变量。 */
  readonly env?: Readonly<Record<string, string>>;
  /** http / sse 模式端点地址。 */
  readonly url?: string;
  /** http / sse 模式请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 启动时交给哪些 Agent（Backend id 列表）。 */
  readonly agents: readonly string[];
  /** 导入来源标记（如 Claude Code、Pi、DeepSeek 等）。 */
  readonly importedFrom?: string;
}

/** 从各 Agent 配置文件扫描出的可导入 MCP 服务器候选。 */
export interface McpImportCandidate {
  readonly key: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly sourceAgentId: string;
  readonly sourceAgentName: string;
  readonly sourcePath: string;
  /** 当前统一列表中是否已存在同名服务器。 */
  readonly conflict?: boolean;
}

export type McpMarketCategory = 'dev' | 'web' | 'data' | 'collab';

/** MCP 市场中的单个服务器条目（来自官方 MCP Registry 实时拉取或离线精选兜底）。 */
export interface McpMarketItem {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly envKeys?: readonly string[];
  readonly url?: string;
  readonly needsConfig?: boolean;
  readonly category: McpMarketCategory;
  readonly description: string;
  readonly descZh?: string;
  readonly descEn?: string;
  readonly version?: string;
  readonly repositoryUrl?: string;
}

export interface McpMarketState {
  readonly items: readonly McpMarketItem[];
  readonly loading?: boolean;
  readonly source: 'online' | 'fallback';
  readonly query?: string;
  readonly updatedAt?: number;
  readonly error?: string;
}

export interface McpState {
  readonly servers: readonly McpServerConfig[];
  readonly scanningImport?: boolean;
  readonly importCandidates?: readonly McpImportCandidate[];
  readonly scannedSources?: readonly string[];
  readonly market?: McpMarketState;
}

export interface ExtensionsState {
  readonly skills: SkillsState;
  readonly mcp: McpState;
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
  readonly permissionPreset?: string;
  /** 是否在独立 git worktree 中执行该任务。 */
  readonly useWorktree?: boolean;
  /** 可选的目标分支名（留空时由宿主自动生成）。 */
  readonly worktreeBranch?: string;
  /** 实际为该任务创建并绑定的 worktree 路径（供打开会话、验收与清理复用）。 */
  readonly worktreePath?: string;
  readonly schedule?: ScheduleFrequency;
  readonly scheduledAt?: number;
  readonly lastRunAt?: number;
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
  /** 该会话最近一次使用的模型显示名；从未上报过模型的会话没有。 */
  readonly model?: string;
  /** 该会话所在仓库的 Git 分支名（若有）。 */
  readonly branch?: string;
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

export type SourceControlFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

/** 工作台「改动」里的一行：一个文件的 Git 状态与增删行数。 */
export interface SourceControlFileView {
  readonly path: string;
  readonly status: SourceControlFileStatus;
  /** 是否已暂存（index 有改动）。 */
  readonly staged: boolean;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface SourceControlGhStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly detail?: string;
}

export interface SourceControlPrChecks {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
}

export interface SourceControlPrStatus {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly mergeStateStatus?: string;
  readonly reviewDecision?: string;
  readonly checks?: SourceControlPrChecks;
}

export interface SourceControlActionResult {
  readonly kind:
    | 'commit'
    | 'push'
    | 'pr'
    | 'stage'
    | 'unstage'
    | 'discard'
    | 'checkout'
    | 'branch'
    | 'deleteBranch'
    | 'pull'
    | 'fetch'
    | 'settle';
  readonly ok: boolean;
  readonly at: number;
  readonly message?: string;
}

/** 源码控制只读状态：当前工作区的分支、远程与未提交改动。 */
export interface SourceControlState {
  /** 当前工作区是否是 Git 仓库。 */
  readonly available: boolean;
  /** 仓库根目录（绝对路径）。 */
  readonly root?: string;
  readonly branch?: string;
  /** 本地分支列表（用于分支切换）。 */
  readonly branches?: readonly string[];
  readonly remote?: string;
  readonly files: readonly SourceControlFileView[];
  readonly additions: number;
  readonly deletions: number;
  /** 文件太多时只返回前 N 个。 */
  readonly truncated?: boolean;
  /** 读取失败的原因。 */
  readonly error?: string;
  /** GitHub CLI（gh）可用性与登录状态。 */
  readonly gh?: SourceControlGhStatus;
  /** 当前分支关联的 Pull Request 状态（需 gh 已登录且分支存在 PR）。 */
  readonly pr?: SourceControlPrStatus;
  /** 最近一次显式写操作的结果，供界面清理草稿或保留失败输入。 */
  readonly lastAction?: SourceControlActionResult;
  readonly updatedAt: number;
}

/** 内置终端标签页会话状态（右侧栏「终端」标签页）。 */
export interface TerminalSessionView {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly running: boolean;
  readonly exitCode?: number;
  readonly cols: number;
  readonly rows: number;
  readonly createdAt: number;
}

export interface TerminalState {
  readonly sessions: readonly TerminalSessionView[];
  readonly activeId?: string;
}

export interface WorkbenchState {
  readonly overview: WorkbenchOverview;
  readonly schedules: readonly ScheduleRule[];
  readonly agents: readonly AgentProfile[];
  readonly tasks: TaskBoardState;
  readonly sessionGroups: readonly ProjectSessionGroup[];
  /** 源码控制只读状态（工作台「改动」模块）；读取前或非 Git 仓库时为空。 */
  readonly sourceControl?: SourceControlState;
}

// ────────────────────────────────────────────────────────────
// 设置 -> Agent -> 服务商（第三方编程套餐与自定义模型接口）
// ────────────────────────────────────────────────────────────

export type ProviderProtocol = 'anthropic' | 'openai-chat' | 'openai-responses';

export interface ProviderModelItem {
  readonly id: string;
  readonly name?: string;
  /** 上下文上限（如 "200k"、"1M" 或数字字符串）。 */
  readonly contextWindow?: string;
  /** 最大输出上限（如 "64k"、"128k" 或数字字符串）。 */
  readonly maxOutputTokens?: string;
  /** 思考档位列表（如 ["low", "medium", "high"]）。 */
  readonly efforts?: readonly string[];
  /** 是否支持图片输入。 */
  readonly vision?: boolean;
}

/** 写入设置 `harnessDeck.providers` 的服务商非敏感配置（API Key 仅保存在本机 SecretStorage）。 */
export interface ProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly presetId?: string;
  readonly anthropicUrl?: string;
  readonly openaiChatUrl?: string;
  readonly openaiResponsesUrl?: string;
  /** 是否将该服务商的 OpenAI Chat Completions 接口通过本地网关转换为 Claude (Anthropic) 协议。 */
  readonly convertOpenaiToAnthropic?: boolean;
  readonly models: readonly ProviderModelItem[];
  readonly defaultModel?: string;
  readonly smallModel?: string;
  /** 绑定的底层智能体 id 列表（如 ['dsh', 'claude', 'oh-my-pi', 'codebuddy']）。 */
  readonly boundBackendIds: readonly string[];
  /** 绑定的工作台智能体预设 id 列表（如 ['builtin-builder']）。 */
  readonly boundAgentIds?: readonly string[];
}

export interface ProviderView extends ProviderConfig {
  /** 本机安全凭据存储中是否已保存 API Key（明文绝不下发到 Webview）。 */
  readonly hasApiKey: boolean;
}

export interface ProviderGatewayLogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly providerId: string;
  readonly providerName?: string;
  readonly protocol: ProviderProtocol;
  readonly converted?: boolean;
  readonly method: string;
  readonly path: string;
  readonly targetUrl?: string;
  readonly requestModel?: string;
  readonly mappedModel?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly message: string;
  readonly detail?: string;
}

export interface ProvidersState {
  readonly items: readonly ProviderView[];
  /** 是否启用本地协议转换网关（OpenAI 兼容 -> Claude Anthropic，默认 false）。 */
  readonly protocolGatewayEnabled?: boolean;
  /** 本地网关当前监听地址（已启动时存在，如 http://127.0.0.1:xxxxx）。 */
  readonly protocolGatewayOrigin?: string;
  /** 本地网关最近的请求与协议转换日志。 */
  readonly gatewayLogs?: readonly ProviderGatewayLogEntry[];
}

// ────────────────────────────────────────────────────────────
// 设置 -> Agent -> 账号（各智能体官方渠道多账号管理与渠道路由）
// ────────────────────────────────────────────────────────────

export type AccountRegion = 'cn' | 'ai' | 'internal';

export type AccountAuthStatus = 'authenticated' | 'expired' | 'unauthenticated' | 'logging-in' | 'unknown';

/** 写入设置 `harnessDeck.accounts` 的官方账号非敏感元数据（敏感凭据与密钥绝不写入此处）。 */
export interface AccountConfig {
  readonly id: string;
  readonly backendId: string;
  readonly label: string;
  /** 默认 false（仅隔离登录凭据，软链共享项目历史会话）；true 表示完全独立会话历史。 */
  readonly isolateSessions?: boolean;
  /** CodeBuddy 等支持多区域的官方渠道环境。 */
  readonly region?: AccountRegion;
  readonly createdAt: number;
}

/** 智能体当前的模型渠道绑定：使用官方渠道（指定或默认账号）还是第三方服务商。 */
export type BackendChannelBinding =
  | { readonly mode: 'official'; readonly accountId?: string }
  | { readonly mode: 'provider'; readonly providerId: string };

/** 下发给 Webview 的脱敏官方账号视图模型（不含任何 Token、Cookie 或 API Key）。 */
export interface AccountView {
  readonly id: string;
  readonly backendId: string;
  readonly label: string;
  /** 是否为系统默认主目录中自动探测到的本机官方账号（不可删除，仅可登录/退出）。 */
  readonly isSystemDefault?: boolean;
  readonly isolateSessions?: boolean;
  readonly region?: AccountRegion;
  readonly status: AccountAuthStatus;
  /** 脱敏后的账号标识（如邮箱、用户名或掩码 Key）。 */
  readonly identity?: string;
  /** 订阅计划或认证方式（如 Max、Pro、Plus、Team、API Key）。 */
  readonly plan?: string;
  /** 凭据过期时间戳（epoch ms），未提供时为 undefined。 */
  readonly expiresAt?: number;
  /** 是否已配置额外凭据（例如 dsh 的官方 API Key 或 CodeBuddy 的 usage-cookie）。 */
  readonly hasSecret?: boolean;
  /** 是否已配置 CodeBuddy 额度查询 Cookie。 */
  readonly hasUsageCookie?: boolean;
  /** 最近一次查到的官方订阅额度。 */
  readonly quota?: QuotaView;
  readonly checkedAt?: number;
  readonly createdAt?: number;
  readonly error?: string;
}

/** 官方登录流程的实时状态，用于前端登录弹窗展示授权链接、设备码或终端引导。 */
export interface AccountLoginProgress {
  readonly accountId: string;
  readonly backendId: string;
  readonly phase: 'starting' | 'waiting-browser' | 'waiting-terminal' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  readonly authUrl?: string;
  readonly deviceCode?: string;
  readonly command?: string;
  readonly message?: string;
  /** 官方 CLI 正在等待用户粘贴浏览器授权后得到的授权码（或回调页完整网址），例如 `agy acp --login`。 */
  readonly needsAuthCode?: boolean;
}

export interface AccountsState {
  readonly items: readonly AccountView[];
  /** 每个底层智能体当前激活的渠道路由（backendId -> official/provider）。 */
  readonly channels: Readonly<Record<string, BackendChannelBinding>>;
  /** 正在进行的官方登录任务状态。 */
  readonly loginProgress?: AccountLoginProgress;
  /** 正在批量刷新账号状态与额度。 */
  readonly checking?: boolean;
}

// ────────────────────────────────────────────────────────────
// 手机端远程互通（HD-22–HD-28）
// ────────────────────────────────────────────────────────────

export type ClientSurface = 'ide' | 'mobile-web';
export type RemoteScope = 'read-only' | 'operate';
export type RemoteRouteKind = 'lan' | 'tailscale' | 'quick-tunnel' | 'tunnel';
export type RemoteWebhookPreset =
  | 'bark'
  | 'ntfy'
  | 'feishu'
  | 'wecom'
  | 'dingtalk'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'custom';

export interface RemoteQuickTunnelView {
  readonly installed: boolean;
  readonly status: 'stopped' | 'starting' | 'running' | 'error';
  readonly version?: string;
  readonly url?: string;
  readonly error?: string;
}

export interface RemoteInterfaceCandidate {
  readonly name: string;
  readonly address: string;
}

export interface RemoteDeviceView {
  readonly id: string;
  readonly name: string;
  readonly scope: RemoteScope;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly connected: boolean;
  readonly pushSubscribed?: boolean;
}

export interface RemotePairingView {
  readonly url: string;
  readonly code: string;
  readonly scope: RemoteScope;
  readonly expiresAt: number;
  readonly routeKind: RemoteRouteKind;
}

export interface RemoteTailscaleView {
  readonly installed: boolean;
  readonly loggedIn: boolean;
  readonly dnsName?: string;
  readonly serveUrl?: string;
  readonly serveEnabled?: boolean;
  readonly error?: string;
}

export interface RemoteWebhookConfig {
  readonly enabled: boolean;
  readonly preset: RemoteWebhookPreset;
  readonly url: string;
  /** 可选签名密钥（飞书/钉钉加签）或 Telegram Chat ID。 */
  readonly secret?: string;
}

export interface RemotePushConfig {
  readonly webPushEnabled: boolean;
  readonly vapidPublicKey?: string;
  readonly suppressWhenFocused: boolean;
  readonly webhook: RemoteWebhookConfig;
}

export interface RemoteWslNatInfo {
  /** 当前运行在 WSL2 NAT 模式（选中的 Windows 宿主机局域网 IP 未直接绑定在 WSL 网卡上）。 */
  readonly active: boolean;
  /** WSL 虚拟网卡 IPv4（如 172.21.154.63）。 */
  readonly wslAddress: string;
  /** Windows 宿主机局域网 IPv4（如 192.168.100.32）。 */
  readonly windowsAddress: string;
  /** 是否已在 Windows 宿主机上检测到匹配的 netsh portproxy 转发规则。 */
  readonly portProxyConfigured: boolean;
  /** 供用户在 Windows 管理员 PowerShell 中一次性配置端口转发与防火墙放行的命令。 */
  readonly setupCommand: string;
}

export interface RemoteState {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly port?: number;
  readonly bindHost: string;
  readonly interfaces: readonly RemoteInterfaceCandidate[];
  readonly selectedHost?: string;
  readonly scope: RemoteScope;
  readonly connectedClients: number;
  readonly devices: readonly RemoteDeviceView[];
  readonly pairing?: RemotePairingView;
  readonly tailscale?: RemoteTailscaleView;
  readonly quickTunnel?: RemoteQuickTunnelView;
  readonly tunnelUrl?: string;
  readonly push?: RemotePushConfig;
  readonly wslNat?: RemoteWslNatInfo;
  readonly error?: string;
}

/** 移动端与内置代码/Diff 审阅查看器数据（HD-25 / P0-1）。 */
export interface DiffContentData {
  readonly path: string;
  readonly title: string;
  readonly language?: string;
  readonly kind: 'pair' | 'unified' | 'cannotPreview' | 'file';
  readonly before?: string;
  readonly after?: string;
  readonly patchText?: string;
  readonly message?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly truncated?: boolean;
  readonly readonly?: boolean;
  /** 是否允许在内置 CodeMirror 6 编辑器中直接保存修改。 */
  readonly editable?: boolean;
  /** 若来自 Git 工作区改动，记录相对路径与暂存态以支持按 Hunk 暂存/撤销。 */
  readonly sourceControlPath?: string;
  readonly staged?: boolean;
}

/** 右侧面板内置浏览器状态与 AI MCP 连接信息。 */
export type BrowserStatus = 'stopped' | 'starting' | 'running' | 'error';

export type BrowserViewportPreset = 'responsive' | 'desktop' | 'mobile';

export interface BrowserConsoleEntry {
  readonly id: number;
  readonly level: 'log' | 'info' | 'warn' | 'error';
  readonly text: string;
  readonly timestamp: number;
}

export interface BrowserAiActionView {
  readonly tool: string;
  readonly summary: string;
  readonly at: number;
  readonly x?: number;
  readonly y?: number;
}

export interface BrowserDomBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserDomBreadcrumb {
  readonly label: string;
  readonly selector: string;
}

export interface BrowserDomChildSummary {
  readonly label: string;
  readonly selector: string;
  readonly childCount: number;
  readonly textPreview?: string;
}

export interface BrowserDomElement {
  readonly tag: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly selector: string;
  readonly label: string;
  readonly rect: BrowserDomBox;
  readonly boxModel?: {
    readonly margin: readonly [number, number, number, number];
    readonly border: readonly [number, number, number, number];
    readonly padding: readonly [number, number, number, number];
  };
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly inlineStyle: string;
  readonly computedStyles: Readonly<Record<string, string>>;
  readonly textPreview?: string;
  readonly outerHtml: string;
  readonly ancestors: readonly BrowserDomBreadcrumb[];
  readonly children: readonly BrowserDomChildSummary[];
}

export interface BrowserNetworkEntry {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly mimeType?: string;
  readonly protocol?: string;
  readonly fromCache?: boolean;
  readonly encodedDataLength?: number;
  readonly durationMs?: number;
  readonly startedAt: number;
  readonly finished: boolean;
  readonly failed?: boolean;
  readonly errorText?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly postData?: string;
}

export interface BrowserState {
  readonly status: BrowserStatus;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly viewportPreset: BrowserViewportPreset;
  /** 是否自动将内置浏览器作为 MCP 工具注入到 AI 智能体（默认 true）。 */
  readonly aiEnabled: boolean;
  /** 本地 MCP HTTP 端点（127.0.0.1），可供外部或 AI 代理连接。 */
  readonly mcpUrl?: string;
  /** 本地 CDP 调试地址（如 http://127.0.0.1:9222），支持外部工具直连。 */
  readonly cdpUrl?: string;
  /** 当前运行中的浏览器可执行路径或附着的远程地址。 */
  readonly executablePath?: string;
  /** 本机自动检测到的浏览器路径。 */
  readonly detectedExecutable?: string;
  /** 最近一次 AI 操作浏览器的摘要与坐标（用于在画面上展示操作高亮）。 */
  readonly lastAiAction?: BrowserAiActionView;
  /** 最近控制台日志与未捕获异常（环形缓冲）。 */
  readonly consoleLogs: readonly BrowserConsoleEntry[];
  /** 最近网络请求记录（环形缓冲，供 DevTools Network 面板调试）。 */
  readonly networkRequests?: readonly BrowserNetworkEntry[];
  readonly error?: string;
}

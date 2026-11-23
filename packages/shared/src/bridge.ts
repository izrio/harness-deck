import { z } from 'zod';
import type { RuntimeStatus } from './runtime.ts';
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64, MAX_IMAGES, TASK_COLUMNS } from './limits.ts';
import type {
  AccountLoginProgress,
  AccountsState,
  AppearanceState,
  ClientSurface,
  CommandView,
  DiffContentData,
  Locale,
  ConnectionState,
  ContextState,
  ExtensionsState,
  FileCandidate,
  Item,
  MarkdownPreviewData,
  ModelState,
  PendingInteraction,
  PermissionState,
  PreferencesState,
  ProjectsState,
  ProviderModelItem,
  ProvidersState,
  QuotaView,
  RemoteScope,
  RemoteState,
  SessionHeader,
  SessionListItem,
  BackendsState,
  TabsState,
  WorkbenchModule,
  WorkbenchState,
  WorkspaceState,
} from './viewModel.ts';

/**
 * Host ↔ Webview 消息。所有消息都是 `{ type, payload }`；Host 收到 Webview 消息后先用 schema 校验再处理。
 * 设计见 docs/DESIGN.md 5.6。
 */

const empty = z.object({});

/** 幂等回执：Webview 为发送/审批/回答/手动触发定时任务生成一次性 id；宿主短期内忽略重复 id。 */
const commandMeta = { commandId: z.string().min(1).max(100).optional() };

const imageSchema = z.object({
  /** Webview 生成的标识：发送中的本地回显用它找到图片。 */
  localId: z.string().min(1).max(100),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  data: z.string().min(1).max(MAX_IMAGE_BASE64),
  name: z.string().max(255).optional(),
});

export type PromptImage = z.infer<typeof imageSchema>;

const diffRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), callId: z.string().min(1) }),
  z.object({ kind: z.literal('turn'), seq: z.number().int().nonnegative(), index: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('session'), path: z.string().min(1).max(4_096) }),
]);

const scheduleFrequencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/u) }),
  z.object({
    kind: z.literal('weekly'),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    time: z.string().regex(/^\d{2}:\d{2}$/u),
  }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(10_080) }),
  z.object({ kind: z.literal('once'), runAt: z.number().int().positive() }),
]);

const agentToolsSchema = z.object({
  permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  readSearch: z.boolean(),
  editWrite: z.boolean(),
  bashCommand: z.boolean(),
  webFetch: z.boolean(),
  mcpTools: z.boolean(),
});

const chatCommandSchema = z.object({
  name: z.string().min(1).max(80),
  prompt: z.string().min(1).max(50_000),
  description: z.string().max(300).optional(),
});

const mcpTransportSchema = z.enum(['stdio', 'http', 'sse']);

const mcpServerPayloadSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120),
  transport: mcpTransportSchema,
  command: z.string().max(1_000).optional(),
  args: z.array(z.string().max(1_000)).max(100).optional(),
  env: z.record(z.string().min(1).max(200), z.string().max(8_000)).optional(),
  url: z.string().max(2_000).optional(),
  headers: z.record(z.string().min(1).max(200), z.string().max(8_000)).optional(),
  enabled: z.boolean().optional(),
  agents: z.array(z.string().min(1).max(100)).max(100),
  importedFrom: z.string().max(200).optional(),
});

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), payload: empty }),
  /** 重新读取工作区的 Git 状态（工作台「改动」模块打开时调用）。 */
  z.object({ type: z.literal('refreshSourceControl'), payload: empty }),
  /** 打开工作台「改动」里指定文件的 Diff（未跟踪文件直接打开文件）。 */
  z.object({
    type: z.literal('openSourceControlDiff'),
    payload: z.object({ path: z.string().min(1).max(4_096), staged: z.boolean().optional() }),
  }),
  /** 新建一个在独立 worktree 中运行的会话；会串行切换到该 worktree（同一时间只有一个工作区活动）。 */
  z.object({
    type: z.literal('newWorktreeSession'),
    payload: z.object({
      path: z.string().max(4_096).optional(),
      branch: z.string().max(200).optional(),
    }),
  }),
  /** 清理一个已创建的 git worktree（非 force，有未提交改动时拒绝）。 */
  z.object({
    type: z.literal('removeWorktree'),
    payload: z.object({ path: z.string().min(1).max(4_096), confirmed: z.boolean().optional() }),
  }),
  /** 提交改动（显式动作；stageAll 为 false 时仅提交已暂存文件）。 */
  z.object({
    type: z.literal('sourceControlCommit'),
    payload: z.object({ message: z.string().min(1).max(5_000), stageAll: z.boolean().optional() }),
  }),
  /** 推送当前分支（显式动作，不 force）。 */
  z.object({ type: z.literal('sourceControlPush'), payload: empty }),
  /** 用 GitHub CLI 创建 PR（显式动作）。 */
  z.object({
    type: z.literal('sourceControlCreatePr'),
    payload: z.object({ title: z.string().min(1).max(500), body: z.string().max(20_000) }),
  }),
  z.object({
    type: z.literal('sendMessage'),
    ...commandMeta,
    payload: z
      .object({
        text: z.string().max(200_000),
        /** 是否附带当前编辑器（输入框上方的标签被关掉时为 false）。 */
        includeActive: z.boolean().optional(),
        /** 粘贴或拖进来的图片（base64，不带 data: 前缀）。 */
        images: z.array(imageSchema).max(MAX_IMAGES).optional(),
      })
      .refine((payload) => payload.text.trim().length > 0 || (payload.images?.length ?? 0) > 0, { message: 'empty message' }),
  }),
  /** 读取历史消息里的图片（dsh 的 session/attachment），结果用 imageData 回传。 */
  z.object({ type: z.literal('loadImage'), payload: z.object({ attachmentId: z.string().min(1).max(512) }) }),
  z.object({ type: z.literal('searchFiles'), payload: z.object({ requestId: z.number().int(), query: z.string().max(1_000) }) }),
  z.object({ type: z.literal('removeAttachment'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({
    type: z.literal('queueAction'),
    payload: z.discriminatedUnion('action', [
      z.object({ action: z.literal('edit'), itemId: z.string().min(1), text: z.string().min(1).max(200_000) }),
      z.object({ action: z.literal('remove'), itemId: z.string().min(1) }),
      z.object({ action: z.literal('steer'), itemId: z.string().min(1) }),
      /** 停止生成后留在队列里的消息：从队列取出，作为新消息立即发送。 */
      z.object({ action: z.literal('send'), itemId: z.string().min(1) }),
    ]),
  }),
  z.object({ type: z.literal('renameSession'), payload: z.object({ title: z.string().max(200).optional() }) }),
  z.object({ type: z.literal('configureApiKey'), payload: empty }),
  z.object({ type: z.literal('selectFolder'), payload: empty }),
  z.object({ type: z.literal('interrupt'), payload: empty }),
  /** 新建对话：打开一个新标签（已有空的新对话标签时切换过去），不覆盖当前会话。 */
  z.object({ type: z.literal('newSession'), payload: empty }),
  /** 打开会话：已经在某个标签里时切换过去，否则在新标签里打开。 */
  z.object({
    type: z.literal('switchSession'),
    /** parentId / label：打开的是子代理的会话时，它的父会话（读取子代理的会话要用父会话地址）和任务描述（做标题）。 */
    payload: z.object({ sessionId: z.string().min(1), parentId: z.string().min(1).optional(), label: z.string().max(200).optional() }),
  }),
  z.object({ type: z.literal('activateTab'), payload: z.object({ key: z.string().min(1) }) }),
  /** 关闭标签只是不再显示，会话仍在 dsh 里，可以从会话列表重新打开。 */
  z.object({ type: z.literal('closeTab'), payload: z.object({ key: z.string().min(1) }) }),
  /** 拖动标签调整顺序：把 `key` 移到标签列表的 `toIndex` 位置（越界时夹到首尾）。 */
  z.object({ type: z.literal('moveTab'), payload: z.object({ key: z.string().min(1), toIndex: z.number().int().nonnegative() }) }),
  /** 右键批量关闭：`scope` 相对 `key`，others 为除它以外的标签，left/right 为左侧/右侧，all 为全部。 */
  z.object({
    type: z.literal('closeTabs'),
    payload: z.object({ key: z.string().min(1), scope: z.enum(['others', 'left', 'right', 'all']) }),
  }),
  z.object({ type: z.literal('loadOlder'), payload: empty }),
  z.object({
    type: z.literal('selectModel'),
    payload: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }),
  }),
  z.object({ type: z.literal('retryPending'), payload: z.object({ requestId: z.string().min(1) }) }),
  z.object({ type: z.literal('discardPending'), payload: z.object({ requestId: z.string().min(1) }) }),
  z.object({ type: z.literal('openExternal'), payload: z.object({ url: z.string().url() }) }),
  z.object({ type: z.literal('restartRuntime'), payload: empty }),
  z.object({ type: z.literal('showLogs'), payload: empty }),
  z.object({ type: z.literal('openWebUI'), payload: empty }),
  /** allowAlways：底层提供「始终允许」时才有（ACP 代理的 allow_always 选项）。 */
  z.object({ type: z.literal('respondApproval'), ...commandMeta, payload: z.object({ id: z.string().min(1), decision: z.enum(['allow', 'allowAlways', 'reject']) }) }),
  z.object({ type: z.literal('previewApproval'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({
    type: z.literal('answerQuestion'),
    ...commandMeta,
    payload: z.union([
      z.object({
        id: z.string().min(1),
        answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().max(20_000).optional() })),
      }),
      z.object({ id: z.string().min(1), cancelled: z.literal(true) }),
    ]),
  }),
  /** `token` 由 Webview 生成，Host 打开（或放弃）后用 `diffOpened` 回传，Webview 据此结束加载状态。 */
  z.object({ type: z.literal('openDiff'), payload: z.object({ ref: diffRefSchema, token: z.number().int().optional() }) }),
  z.object({ type: z.literal('openSettings'), payload: empty }),
  /** 切换底层（设置里配置的 dsh / ACP 代理）。 */
  z.object({ type: z.literal('selectBackend'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 重新探测系统的 Node.js / npm 以及各底层安装状态。 */
  z.object({ type: z.literal('checkBackendEnv'), payload: empty }),
  /** 获取某个底层的可用 npm 版本列表。 */
  z.object({ type: z.literal('fetchBackendVersions'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 通过 npm 安装或切换某个底层的版本。 */
  z.object({
    type: z.literal('installBackend'),
    payload: z.object({ id: z.string().min(1).max(100), version: z.string().min(1).max(100).optional() }),
  }),
  /** 通过 npm 卸载某个底层。 */
  z.object({ type: z.literal('uninstallBackend'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 新增或更新外部 ACP 智能体配置（写入 harnessDeck.backends）。 */
  z.object({
    type: z.literal('upsertBackendProfile'),
    payload: z.object({
      id: z.string().min(1).max(100),
      name: z.string().min(1).max(100),
      command: z.string().min(1).max(1_000),
      args: z.array(z.string().max(1_000)).max(100),
      env: z.record(z.string().min(1).max(200), z.string().max(4_000)),
      installHint: z.string().max(1_000).optional(),
      singleSession: z.boolean().optional(),
    }),
  }),
  /** 拉取用户配置的 ACP 注册表（只读 HTTPS URL，不会执行安装）。 */
  z.object({
    type: z.literal('fetchAcpRegistry'),
    payload: z.object({
      url: z
        .string()
        .url()
        .max(2_000)
        .refine((value) => value.startsWith('https://'), 'only https:// URLs are allowed'),
    }),
  }),
  /** 删除自定义外部智能体，或移除对内置 ACP 智能体的覆盖。 */
  z.object({ type: z.literal('deleteBackendProfile'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 面板里的外观与排版设置：写入 VS Code 设置 harnessDeck.ui.*；null 表示恢复默认。 */
  z.object({
    type: z.literal('setAppearance'),
    payload: z.object({
      theme: z.enum(['system', 'light', 'dark']).nullable().optional(),
      fontSize: z.number().int().min(8).max(32).nullable().optional(),
      fontFamily: z.string().max(500).nullable().optional(),
      lineHeight: z.number().min(1.2).max(2.4).nullable().optional(),
      paragraphSpacing: z.number().int().min(0).max(32).nullable().optional(),
      contentWidth: z.number().int().min(520).max(1600).nullable().optional(),
      codeFontFamily: z.string().max(500).nullable().optional(),
      terminalFontSize: z.number().int().min(9).max(24).nullable().optional(),
      terminalLineHeight: z.number().min(1.1).max(2.4).nullable().optional(),
    }),
  }),
  /** 在面板内读取并预览 Markdown 文件。 */
  z.object({ type: z.literal('previewMarkdown'), payload: z.object({ path: z.string().min(1).max(4_096) }) }),
  /** 在插件内置查看器中只读查看工作区文件（不联动宿主 IDE 编辑器，便于独立客户端复用）。 */
  z.object({ type: z.literal('previewFile'), payload: z.object({ path: z.string().min(1).max(4_096) }) }),
  /** 设置页里的通用偏好、定时权限、系统通知与诊断高级设置：写入 VS Code 设置。 */
  z.object({
    type: z.literal('setPreferences'),
    payload: z.object({
      language: z.enum(['auto', 'zh', 'en']).optional(),
      includeActiveEditor: z.boolean().optional(),
      showTurnChanges: z.boolean().optional(),
      schedulePermission: z.enum(['danger-full-access', 'workspace-write', 'read-only']).optional(),
      notifications: z
        .object({
          enabled: z.boolean().optional(),
          onlyWhenUnfocused: z.boolean().optional(),
          onAttention: z.boolean().optional(),
          onTurnComplete: z.boolean().optional(),
          onUnexpectedExit: z.boolean().optional(),
          onScheduledComplete: z.boolean().optional(),
        })
        .optional(),
      advanced: z
        .object({
          dshPath: z.string().max(1_000).optional(),
          dshProfile: z.string().max(200).optional(),
          zcodePath: z.string().max(1_000).optional(),
          claudePath: z.string().max(1_000).optional(),
          piPath: z.string().max(1_000).optional(),
          codexPath: z.string().max(1_000).optional(),
          codebuddyPath: z.string().max(1_000).optional(),
          backendTrace: z.boolean().optional(),
        })
        .optional(),
      chatCommands: z.array(chatCommandSchema).max(200).readonly().optional(),
    }),
  }),
  /** 发送测试系统通知。 */
  z.object({ type: z.literal('testNotification'), payload: empty }),
  /** 更新某个项目的 worktree 配置（复制文件、准备命令、验收命令）。 */
  z.object({
    type: z.literal('setProjectWorktreeConfig'),
    payload: z.object({
      path: z.string().min(1).max(4_096),
      copyFiles: z.array(z.string().max(1_000)).max(200),
      setupCommands: z.array(z.string().max(2_000)).max(50),
      verifyCommands: z.array(z.string().max(2_000)).max(50),
    }),
  }),
  /** 选择并添加一个本地项目目录到最近项目列表。 */
  z.object({ type: z.literal('addRecentProject'), payload: empty }),
  /** 从最近项目列表中移除（不删除磁盘文件）。 */
  z.object({ type: z.literal('removeRecentProject'), payload: z.object({ path: z.string().min(1).max(4_096) }) }),
  /** 在 VS Code 中打开对应项目目录。 */
  z.object({ type: z.literal('openProject'), payload: z.object({ path: z.string().min(1).max(4_096) }) }),
  /** 为项目创建 git worktree 并执行复制文件与准备命令。 */
  z.object({
    type: z.literal('createWorktree'),
    payload: z.object({ path: z.string().min(1).max(4_096), branch: z.string().max(200).optional() }),
  }),
  /** 执行项目的验收命令。 */
  z.object({ type: z.literal('runProjectVerify'), payload: z.object({ path: z.string().min(1).max(4_096) }) }),
  /** 输入框 `+` 菜单：选择文件加入上下文。 */
  z.object({ type: z.literal('pickFiles'), payload: empty }),
  z.object({
    type: z.literal('openFile'),
    payload: z.object({ path: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }),
  }),
  z.object({ type: z.literal('selectPermission'), payload: z.object({ preset: z.string().min(1), confirmed: z.boolean().optional() }) }),
  z.object({ type: z.literal('saveAll'), payload: empty }),
  /** 把最后一轮改过的文件恢复到本轮开始前（仅 dsh；对话不回退）。 */
  z.object({ type: z.literal('rollbackLastTurn'), payload: z.object({ confirmed: z.boolean().optional() }) }),
  /** 在编辑器标签页中打开全宽工作台面板。 */
  z.object({ type: z.literal('openWorkbenchPanel'), payload: empty }),
  /** 总览未读项已读标记。 */
  z.object({
    type: z.literal('markUnreadRead'),
    payload: z.object({ id: z.string().min(1).max(500).optional(), all: z.boolean().optional() }),
  }),
  /** 定时模块：新增或编辑定时任务规则。 */
  z.object({
    type: z.literal('upsertSchedule'),
    payload: z.object({
      id: z.string().min(1).max(100).optional(),
      name: z.string().min(1).max(200),
      prompt: z.string().min(1).max(50_000),
      frequency: scheduleFrequencySchema,
      backendId: z.string().min(1).max(100),
      projectPath: z.string().min(1).max(4_096).optional(),
      enabled: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal('toggleSchedule'), payload: z.object({ id: z.string().min(1).max(100), enabled: z.boolean() }) }),
  z.object({ type: z.literal('deleteSchedule'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({ type: z.literal('runScheduleNow'), ...commandMeta, payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({
    type: z.literal('markScheduleRunRead'),
    payload: z.object({ ruleId: z.string().min(1).max(100), runId: z.string().min(1).max(100) }),
  }),
  /** 智能体模块：新增或编辑智能体预设、直接开启会话或委派任务。 */
  z.object({
    type: z.literal('upsertAgent'),
    payload: z.object({
      id: z.string().min(1).max(100).optional(),
      name: z.string().min(1).max(120),
      specialty: z.string().min(1).max(400),
      instructions: z.string().max(50_000),
      backendId: z.string().min(1).max(100),
      provider: z.string().max(100).optional(),
      model: z.string().max(200).optional(),
      reasoningEffort: z.string().max(100).optional(),
      tools: agentToolsSchema,
    }),
  }),
  z.object({ type: z.literal('deleteAgent'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({
    type: z.literal('startAgentSession'),
    payload: z.object({
      agentId: z.string().min(1).max(100),
      projectPath: z.string().min(1).max(4_096).optional(),
      initialPrompt: z.string().max(50_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('delegateToAgent'),
    payload: z.object({
      agentId: z.string().min(1).max(100),
      prompt: z.string().min(1).max(50_000),
      projectPath: z.string().min(1).max(4_096).optional(),
      runImmediately: z.boolean().optional(),
    }),
  }),
  /** 任务看板模块：创建任务（支持可选定时规则与权限模式）、状态流转、顺序调整与顺序自动执行。 */
  z.object({
    type: z.literal('createTask'),
    payload: z.object({
      title: z.string().max(240).optional(),
      prompt: z.string().min(1).max(50_000),
      projectPath: z.string().min(1).max(4_096),
      backendId: z.string().min(1).max(100),
      provider: z.string().max(100).optional(),
      model: z.string().max(200).optional(),
      reasoningEffort: z.string().max(100).optional(),
      agentId: z.string().min(1).max(100).optional(),
      permissionPreset: z.string().min(1).max(100).optional(),
      useWorktree: z.boolean().optional(),
      worktreeBranch: z.string().max(200).optional(),
      schedule: scheduleFrequencySchema.optional(),
      autoStart: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('pickTaskFiles'),
    payload: z.object({ projectPath: z.string().max(4_096).optional() }),
  }),
  /** 按需拉取指定运行时的可用模型与权限列表（如新建任务切换运行时时刷新模型列表，不切换当前会话底层）。 */
  z.object({
    type: z.literal('fetchBackendModels'),
    payload: z.object({ requestId: z.number().int(), backendId: z.string().min(1).max(100) }),
  }),
  z.object({
    type: z.literal('updateTaskStatus'),
    payload: z.object({ id: z.string().min(1).max(100), status: z.enum(TASK_COLUMNS) }),
  }),
  z.object({
    type: z.literal('reorderTask'),
    payload: z.object({ id: z.string().min(1).max(100), direction: z.enum(['up', 'down']) }),
  }),
  z.object({ type: z.literal('deleteTask'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({ type: z.literal('clearDoneTasks'), payload: empty }),
  z.object({ type: z.literal('setTaskQueueAutoRun'), payload: z.object({ autoRun: z.boolean() }) }),
  z.object({ type: z.literal('runTaskNow'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 会话模块：按项目分组新建会话或打开指定项目下的会话。 */
  z.object({
    type: z.literal('startProjectSession'),
    payload: z.object({ projectPath: z.string().min(1).max(4_096), backendId: z.string().min(1).max(100).optional() }),
  }),
  z.object({
    type: z.literal('openProjectSession'),
    payload: z.object({
      projectPath: z.string().min(1).max(4_096),
      sessionId: z.string().min(1).max(500),
      backendId: z.string().min(1).max(100).optional(),
    }),
  }),
  /** 会话模块：从会话列表中删除条目（关闭其标签，不再显示；底层历史文件保留）。 */
  z.object({
    type: z.literal('deleteProjectSession'),
    payload: z.object({
      sessionId: z.string().min(1).max(500),
      backendId: z.string().min(1).max(100).optional(),
    }),
  }),
  /** 设置 -> 扩展 -> 技能（Agent Skills，SKILL.md）。 */
  z.object({
    type: z.literal('scanGitSkills'),
    payload: z.object({
      repoUrl: z.string().min(1).max(2_000),
      ref: z.string().max(200).optional(),
      subpath: z.string().max(1_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('installGitSkills'),
    payload: z.object({
      repoUrl: z.string().min(1).max(2_000),
      ref: z.string().max(200).optional(),
      subpath: z.string().max(1_000).optional(),
      selectedSubpaths: z.array(z.string().max(1_000)).max(200).optional(),
      agents: z.array(z.string().min(1).max(100)).max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal('updateSkill'),
    payload: z.object({
      id: z.string().min(1).max(120),
      enabled: z.boolean().optional(),
      agents: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
    }),
  }),
  z.object({ type: z.literal('syncSkill'), payload: z.object({ id: z.string().min(1).max(120) }) }),
  z.object({ type: z.literal('deleteSkill'), payload: z.object({ id: z.string().min(1).max(120) }) }),
  /** 设置 -> 扩展 -> MCP 服务器统一管理与导入。 */
  z.object({ type: z.literal('upsertMcpServer'), payload: mcpServerPayloadSchema }),
  z.object({
    type: z.literal('toggleMcpServer'),
    payload: z.object({
      id: z.string().min(1).max(120),
      enabled: z.boolean().optional(),
      agents: z.array(z.string().min(1).max(100)).max(100).optional(),
    }),
  }),
  z.object({ type: z.literal('deleteMcpServer'), payload: z.object({ id: z.string().min(1).max(120) }) }),
  z.object({ type: z.literal('scanAgentMcpConfigs'), payload: empty }),
  z.object({ type: z.literal('pickMcpConfigFile'), payload: empty }),
  z.object({
    type: z.literal('importMcpServers'),
    payload: z.object({
      servers: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            transport: mcpTransportSchema,
            command: z.string().max(1_000).optional(),
            args: z.array(z.string().max(1_000)).max(100).optional(),
            env: z.record(z.string().min(1).max(200), z.string().max(8_000)).optional(),
            url: z.string().max(2_000).optional(),
            headers: z.record(z.string().min(1).max(200), z.string().max(8_000)).optional(),
            importedFrom: z.string().max(200).optional(),
          }),
        )
        .min(1)
        .max(200),
      agents: z.array(z.string().min(1).max(100)).max(100),
    }),
  }),
  /** 设置 -> Agent -> 服务商：管理第三方编程套餐与自定义模型接口，并绑定到智能体。 */
  z.object({
    type: z.literal('upsertProvider'),
    payload: z.object({
      id: z.string().max(100).optional(),
      name: z.string().min(1).max(120),
      presetId: z.string().max(100).optional(),
      /** undefined 表示保留已有密钥；空字符串表示清除密钥；非空字符串写入本机 SecretStorage。 */
      apiKey: z.string().max(4_000).optional(),
      anthropicUrl: z.string().max(2_000).optional(),
      openaiChatUrl: z.string().max(2_000).optional(),
      openaiResponsesUrl: z.string().max(2_000).optional(),
      convertOpenaiToAnthropic: z.boolean().optional(),
      models: z
        .array(
          z.object({
            id: z.string().min(1).max(200),
            name: z.string().max(200).optional(),
            contextWindow: z.string().max(50).optional(),
            maxOutputTokens: z.string().max(50).optional(),
            efforts: z.array(z.string().max(60)).max(20).readonly().optional(),
            vision: z.boolean().optional(),
          }),
        )
        .max(200),
      defaultModel: z.string().max(200).optional(),
      smallModel: z.string().max(200).optional(),
      boundBackendIds: z.array(z.string().min(1).max(100)).max(100),
      boundAgentIds: z.array(z.string().min(1).max(100)).max(100).optional(),
    }),
  }),
  z.object({ type: z.literal('deleteProvider'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 设置 -> Agent -> 服务商：启停本地协议转换网关（OpenAI 兼容 -> Claude Anthropic，默认关闭）。 */
  z.object({
    type: z.literal('setProtocolGateway'),
    payload: z.object({ enabled: z.boolean() }),
  }),
  z.object({ type: z.literal('clearProtocolGatewayLogs'), payload: empty }),
  z.object({
    type: z.literal('bindProviderAgents'),
    payload: z.object({
      id: z.string().min(1).max(100),
      boundBackendIds: z.array(z.string().min(1).max(100)).max(100),
      boundAgentIds: z.array(z.string().min(1).max(100)).max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal('fetchProviderModels'),
    payload: z.object({
      requestId: z.number().int(),
      providerId: z.string().max(100).optional(),
      apiKey: z.string().max(4_000).optional(),
      anthropicUrl: z.string().max(2_000).optional(),
      openaiChatUrl: z.string().max(2_000).optional(),
      openaiResponsesUrl: z.string().max(2_000).optional(),
    }),
  }),
  /** 悬浮上下文旁的用量标识时查询官方订阅额度；宿主按激活后端判断是否有官方 OAuth 凭据。 */
  z.object({ type: z.literal('fetchQuota'), payload: z.object({ requestId: z.number().int() }) }),
  /** 设置 -> Agent -> 账号：官方渠道多账号管理与智能体渠道路由切换（官方 ↔ 服务商）。 */
  z.object({
    type: z.literal('upsertAccount'),
    payload: z.object({
      id: z.string().max(120).optional(),
      backendId: z.string().min(1).max(100),
      label: z.string().min(1).max(120),
      isolateSessions: z.boolean().optional(),
      region: z.enum(['cn', 'ai', 'internal']).optional(),
      /** 仅 dsh 官方 API Key 账号使用：undefined 保留原密钥，空串清除，非空写入 SecretStorage。 */
      apiKey: z.string().max(4_000).optional(),
      /** 仅 CodeBuddy 官方额度查询 Cookie 使用：undefined 保留，空串清除，非空写入 SecretStorage。 */
      usageCookie: z.string().max(8_000).optional(),
      /** 保存后是否立即设为该智能体的激活官方账号。 */
      setActive: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal('deleteAccount'), payload: z.object({ id: z.string().min(1).max(120) }) }),
  z.object({
    type: z.literal('loginAccount'),
    payload: z.object({
      id: z.string().min(1).max(120),
      backendId: z.string().min(1).max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal('cancelAccountLogin'),
    payload: z.object({
      id: z.string().max(120).optional(),
      /** 为 true 时同时清除登录进度（关闭弹窗），否则仅取消进行中的登录并保留「已取消」提示。 */
      dismiss: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('submitAccountLoginCode'),
    payload: z.object({
      id: z.string().max(120).optional(),
      code: z.string().trim().min(1).max(8192),
    }),
  }),
  z.object({ type: z.literal('logoutAccount'), payload: z.object({ id: z.string().min(1).max(120) }) }),
  z.object({
    type: z.literal('refreshAccounts'),
    payload: z.object({
      backendId: z.string().max(100).optional(),
      includeQuota: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('setBackendChannel'),
    payload: z.object({
      backendId: z.string().min(1).max(100),
      mode: z.enum(['official', 'provider']),
      accountId: z.string().max(120).optional(),
      providerId: z.string().max(100).optional(),
    }),
  }),
  /** 手机端远程互通（HD-23 / HD-26 / HD-27）。 */
  z.object({ type: z.literal('setRemoteEnabled'), payload: z.object({ enabled: z.boolean() }) }),
  z.object({
    type: z.literal('setRemoteConfig'),
    payload: z.object({
      selectedHost: z.string().max(255).optional(),
      scope: z.enum(['read-only', 'operate']).optional(),
      tunnelUrl: z.string().max(2_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('generateRemotePairing'),
    payload: z.object({
      scope: z.enum(['read-only', 'operate']).optional(),
      routeKind: z.enum(['lan', 'tailscale', 'tunnel']).optional(),
    }),
  }),
  z.object({ type: z.literal('clearRemotePairing'), payload: empty }),
  z.object({ type: z.literal('revokeRemoteDevice'), payload: z.object({ deviceId: z.string().min(1).max(120) }) }),
  z.object({ type: z.literal('disconnectAllRemote'), payload: empty }),
  z.object({ type: z.literal('refreshRemoteNetwork'), payload: empty }),
  z.object({ type: z.literal('probeTailscale'), payload: empty }),
  z.object({ type: z.literal('configureTailscaleServe'), payload: z.object({ enabled: z.boolean() }) }),
  z.object({
    type: z.literal('setRemotePushConfig'),
    payload: z.object({
      webPushEnabled: z.boolean().optional(),
      suppressWhenFocused: z.boolean().optional(),
      webhook: z
        .object({
          enabled: z.boolean().optional(),
          preset: z.enum(['bark', 'ntfy', 'custom']).optional(),
          url: z.string().max(2_000).optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('registerWebPushSubscription'),
    payload: z.object({
      endpoint: z.string().url().max(2_000),
      keys: z.object({
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(256),
      }),
    }),
  }),
  z.object({
    type: z.literal('unregisterWebPushSubscription'),
    payload: z.object({ endpoint: z.string().max(2_000).optional() }),
  }),
  z.object({ type: z.literal('testRemotePush'), payload: empty }),
]);

export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

export type HostIdeKind = 'vscode' | 'jetbrains';

export interface HostSnapshot {
  readonly hostKind?: HostIdeKind;
  readonly clientSurface?: ClientSurface;
  readonly clientScope?: RemoteScope;
  readonly runtime: RuntimeStatus;
  readonly connection: ConnectionState;
  readonly sessions: readonly SessionListItem[];
  readonly tabs: TabsState;
  readonly session: SessionHeader;
  readonly items: readonly Item[];
  readonly models: ModelState;
  readonly interactions: readonly PendingInteraction[];
  readonly permissions: PermissionState;
  readonly workspace: WorkspaceState;
  readonly context: ContextState;
  readonly commands: readonly CommandView[];
  readonly locale: Locale;
  readonly appearance: AppearanceState;
  readonly preferences?: PreferencesState;
  readonly backends: BackendsState;
  readonly providers?: ProvidersState;
  readonly accounts?: AccountsState;
  readonly projects?: ProjectsState;
  readonly extensions?: ExtensionsState;
  readonly workbench?: WorkbenchState;
  readonly remote?: RemoteState;
}

/**
 * 条目增量。`sessionKey` 标识当前会话（新对话为空字符串），Webview 丢弃不属于当前会话的增量。
 * `reset` 为 true 时 `upsert` 是完整列表；否则按 `order` 排列，`upsert` 中的条目替换同 id 的旧条目。
 */
export interface ItemsPatch {
  readonly sessionKey: string;
  readonly reset: boolean;
  readonly order: readonly string[];
  readonly upsert: readonly Item[];
}

export type HostToWebview =
  | { readonly type: 'snapshot'; readonly payload: HostSnapshot }
  | { readonly type: 'runtimeStatus'; readonly payload: RuntimeStatus }
  | { readonly type: 'connection'; readonly payload: ConnectionState }
  | { readonly type: 'sessions'; readonly payload: readonly SessionListItem[] }
  | { readonly type: 'tabs'; readonly payload: TabsState }
  | { readonly type: 'session'; readonly payload: SessionHeader }
  | { readonly type: 'items'; readonly payload: ItemsPatch }
  | { readonly type: 'models'; readonly payload: ModelState }
  | { readonly type: 'interactions'; readonly payload: readonly PendingInteraction[] }
  | { readonly type: 'permissions'; readonly payload: PermissionState }
  | { readonly type: 'workspace'; readonly payload: WorkspaceState }
  | { readonly type: 'context'; readonly payload: ContextState }
  | { readonly type: 'locale'; readonly payload: Locale }
  | { readonly type: 'appearance'; readonly payload: AppearanceState }
  | { readonly type: 'preferences'; readonly payload: PreferencesState }
  | { readonly type: 'backends'; readonly payload: BackendsState }
  | { readonly type: 'providers'; readonly payload: ProvidersState }
  | { readonly type: 'accounts'; readonly payload: AccountsState }
  | { readonly type: 'accountLoginProgress'; readonly payload: AccountLoginProgress | undefined }
  | {
      readonly type: 'providerModelsFetched';
      readonly payload: { readonly requestId: number; readonly models: readonly ProviderModelItem[]; readonly error?: string };
    }
  /** 官方订阅额度查询结果；`quota` 缺失表示查不到（非官方订阅、凭据失效或请求失败），前端应隐藏标识。 */
  | {
      readonly type: 'quotaFetched';
      readonly payload: { readonly requestId: number; readonly quota?: QuotaView; readonly error?: string };
    }
  | { readonly type: 'projects'; readonly payload: ProjectsState }
  | { readonly type: 'extensions'; readonly payload: ExtensionsState }
  | { readonly type: 'workbench'; readonly payload: WorkbenchState }
  | { readonly type: 'switchWorkbenchModule'; readonly payload: { readonly module: WorkbenchModule } }
  | { readonly type: 'markdownPreview'; readonly payload: MarkdownPreviewData }
  | { readonly type: 'diffContent'; readonly payload: DiffContentData }
  | { readonly type: 'remote'; readonly payload: RemoteState }
  | { readonly type: 'navigateToSession'; readonly payload: { readonly sessionId?: string } }
  | { readonly type: 'diffOpened'; readonly payload: { readonly token: number } }
  | { readonly type: 'imageData'; readonly payload: { readonly attachmentId: string; readonly dataUrl?: string } }
  | { readonly type: 'commands'; readonly payload: readonly CommandView[] }
  | { readonly type: 'fileCandidates'; readonly payload: { readonly requestId: number; readonly items: readonly FileCandidate[] } }
  | { readonly type: 'toast'; readonly payload: { readonly level: 'info' | 'error'; readonly text: string } }
  | { readonly type: 'attachImages'; readonly payload: { readonly images: readonly PromptImage[] } }
  | { readonly type: 'taskFilesPicked'; readonly payload: { readonly paths: readonly string[] } }
  | {
      readonly type: 'backendModelsFetched';
      readonly payload: {
        readonly requestId: number;
        readonly backendId: string;
        readonly models: ModelState;
        readonly permissions?: PermissionState;
      };
    }
  /** 消息没能发出去（没连上、建不了会话…）：输入框发送时已经清空，把文字放回去。 */
  | { readonly type: 'restoreDraft'; readonly payload: { readonly text: string } }
  | { readonly type: 'focusComposer'; readonly payload: Record<string, never> };

/**
 * 解析来自 Webview 的消息；格式不对时返回 undefined，由调用方记录日志并丢弃。
 * @param value - `onDidReceiveMessage` 收到的原始值。
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
  const parsed = webviewToHostSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

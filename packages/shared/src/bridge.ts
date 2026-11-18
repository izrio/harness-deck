import { z } from 'zod';
import type { RuntimeStatus } from './runtime.ts';
import { COLOR_SCHEMES, IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64, MAX_IMAGES, TASK_COLUMNS } from './limits.ts';
import type {
  AppearanceState,
  CommandView,
  Locale,
  ConnectionState,
  ContextState,
  FileCandidate,
  Item,
  MarkdownPreviewData,
  ModelState,
  PendingInteraction,
  PermissionState,
  PreferencesState,
  ProjectsState,
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

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), payload: empty }),
  z.object({
    type: z.literal('sendMessage'),
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
  z.object({ type: z.literal('renameSession'), payload: empty }),
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
  z.object({ type: z.literal('respondApproval'), payload: z.object({ id: z.string().min(1), decision: z.enum(['allow', 'allowAlways', 'reject']) }) }),
  z.object({ type: z.literal('previewApproval'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({
    type: z.literal('answerQuestion'),
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
  /** 删除自定义外部智能体，或移除对内置 ACP 智能体的覆盖。 */
  z.object({ type: z.literal('deleteBackendProfile'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 面板里的外观与排版设置：写入 VS Code 设置 harnessDeck.ui.*；null 表示恢复默认。 */
  z.object({
    type: z.literal('setAppearance'),
    payload: z.object({
      theme: z.enum(['system', 'light', 'dark']).nullable().optional(),
      colorScheme: z.enum(COLOR_SCHEMES).nullable().optional(),
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
          backendTrace: z.boolean().optional(),
        })
        .optional(),
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
    payload: z.object({ path: z.string().min(1).max(4_096), branch: z.string().min(1).max(200).optional() }),
  }),
  /** 执行项目的验收命令。 */
  z.object({ type: z.literal('runProjectVerify'), payload: z.object({ path: z.string().min(1).max(4_096) }) }),
  /** 输入框 `+` 菜单：选择文件加入上下文。 */
  z.object({ type: z.literal('pickFiles'), payload: empty }),
  z.object({
    type: z.literal('openFile'),
    payload: z.object({ path: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }),
  }),
  z.object({ type: z.literal('selectPermission'), payload: z.object({ preset: z.string().min(1) }) }),
  z.object({ type: z.literal('saveAll'), payload: empty }),
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
  z.object({ type: z.literal('runScheduleNow'), payload: z.object({ id: z.string().min(1).max(100) }) }),
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
  /** 任务看板模块：创建任务、状态流转、顺序调整与顺序自动执行。 */
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
      autoStart: z.boolean().optional(),
    }),
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
]);

export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

export interface HostSnapshot {
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
  readonly projects?: ProjectsState;
  readonly workbench?: WorkbenchState;
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
  | { readonly type: 'projects'; readonly payload: ProjectsState }
  | { readonly type: 'workbench'; readonly payload: WorkbenchState }
  | { readonly type: 'switchWorkbenchModule'; readonly payload: { readonly module: WorkbenchModule } }
  | { readonly type: 'markdownPreview'; readonly payload: MarkdownPreviewData }
  | { readonly type: 'navigateToSession'; readonly payload: { readonly sessionId?: string } }
  | { readonly type: 'diffOpened'; readonly payload: { readonly token: number } }
  | { readonly type: 'imageData'; readonly payload: { readonly attachmentId: string; readonly dataUrl?: string } }
  | { readonly type: 'commands'; readonly payload: readonly CommandView[] }
  | { readonly type: 'fileCandidates'; readonly payload: { readonly requestId: number; readonly items: readonly FileCandidate[] } }
  | { readonly type: 'toast'; readonly payload: { readonly level: 'info' | 'error'; readonly text: string } }
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

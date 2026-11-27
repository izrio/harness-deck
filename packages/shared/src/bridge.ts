import { z } from 'zod';
import type { RuntimeStatus } from './runtime.ts';
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64, MAX_IMAGES, TASK_COLUMNS } from './limits.ts';
import type {
  AccountLoginProgress,
  AccountsState,
  AppearanceState,
  BrowserConsoleProperty,
  BrowserDomElement,
  BrowserState,
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
  RemoteStorageAuthState,
  RemoteStorageListResult,
  RemoteStoragesState,
  SessionHeader,
  SessionListItem,
  SourceControlCommitDetailView,
  SourceControlCommitFileView,
  SourceControlCommitView,
  BackendsState,
  TabsState,
  TerminalState,
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
  /** 提交改动（支持 IDEA 风格按勾选文件提交、Amend 修改上次提交与提交并推送）。 */
  z.object({
    type: z.literal('sourceControlCommit'),
    payload: z.object({
      message: z.string().min(1).max(5_000),
      stageAll: z.boolean().optional(),
      files: z.array(z.string().min(1).max(4_096)).max(500).optional(),
      amend: z.boolean().optional(),
      push: z.boolean().optional(),
    }),
  }),
  /** 推送当前分支（显式动作，不 force）。 */
  z.object({ type: z.literal('sourceControlPush'), payload: empty }),
  /** 用 GitHub CLI 创建 PR（显式动作）。 */
  z.object({
    type: z.literal('sourceControlCreatePr'),
    payload: z.object({ title: z.string().min(1).max(500), body: z.string().max(20_000) }),
  }),
  /** 单文件与批量暂存 / 取消暂存 / 撤销改动（P0-2）。 */
  z.object({
    type: z.literal('sourceControlStageFile'),
    payload: z.object({ path: z.string().min(1).max(4_096) }),
  }),
  z.object({
    type: z.literal('sourceControlUnstageFile'),
    payload: z.object({ path: z.string().min(1).max(4_096) }),
  }),
  z.object({ type: z.literal('sourceControlStageAll'), payload: empty }),
  z.object({ type: z.literal('sourceControlUnstageAll'), payload: empty }),
  z.object({
    type: z.literal('sourceControlDiscardFile'),
    payload: z.object({
      path: z.string().min(1).max(4_096),
      untracked: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlDiscardAll'),
    payload: z.object({ confirmed: z.boolean().optional() }),
  }),
  /** 按 Hunk 暂存或撤销改动（P0-1 / P0-2）。 */
  z.object({
    type: z.literal('sourceControlStageHunk'),
    payload: z.object({ patch: z.string().min(1).max(500_000) }),
  }),
  z.object({
    type: z.literal('sourceControlDiscardHunk'),
    payload: z.object({ patch: z.string().min(1).max(500_000), confirmed: z.boolean().optional() }),
  }),
  /** 分支切换 / 新建（可选起点）/ 重命名 / 删除 / 合并 / 变基 / 拉取 / 抓取。 */
  z.object({
    type: z.literal('sourceControlCheckoutBranch'),
    payload: z.object({ branch: z.string().min(1).max(200) }),
  }),
  z.object({
    type: z.literal('sourceControlCreateBranch'),
    payload: z.object({
      branch: z.string().min(1).max(200),
      startPoint: z.string().min(1).max(200).optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlRenameBranch'),
    payload: z.object({
      oldName: z.string().trim().min(1).max(200),
      newName: z.string().trim().min(1).max(200),
    }),
  }),
  z.object({
    type: z.literal('sourceControlDeleteBranch'),
    payload: z.object({
      branch: z.string().trim().min(1).max(200),
      force: z.boolean().optional(),
      confirmed: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlMergeBranch'),
    payload: z.object({ branch: z.string().trim().min(1).max(200) }),
  }),
  z.object({
    type: z.literal('sourceControlRebaseBranch'),
    payload: z.object({ branch: z.string().trim().min(1).max(200) }),
  }),
  z.object({ type: z.literal('sourceControlPull'), payload: empty }),
  z.object({ type: z.literal('sourceControlFetch'), payload: empty }),
  /** 进行中合并/变基/拣选/回滚操作控制与单文件冲突解决。 */
  z.object({ type: z.literal('sourceControlContinueOp'), payload: empty }),
  z.object({ type: z.literal('sourceControlAbortOp'), payload: empty }),
  z.object({
    type: z.literal('sourceControlResolveConflict'),
    payload: z.object({
      path: z.string().min(1).max(4_096),
      strategy: z.enum(['ours', 'theirs', 'mark']),
    }),
  }),
  /** Git 提交日志（DAG 图谱）、提交详情、历史文件 Diff 与提交操作（Cherry-pick / Revert / Reset）。 */
  z.object({
    type: z.literal('sourceControlFetchLog'),
    payload: z.object({
      requestId: z.number().int(),
      query: z.string().max(200).optional(),
      branch: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      skip: z.number().int().min(0).max(10_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlFetchCommitDetail'),
    payload: z.object({
      requestId: z.number().int(),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/u),
    }),
  }),
  z.object({
    type: z.literal('sourceControlOpenCommitFileDiff'),
    payload: z.object({
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/u),
      path: z.string().min(1).max(4_096),
      oldPath: z.string().min(1).max(4_096).optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlCherryPick'),
    payload: z.object({ hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/u) }),
  }),
  z.object({
    type: z.literal('sourceControlRevertCommit'),
    payload: z.object({ hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/u) }),
  }),
  z.object({
    type: z.literal('sourceControlResetToCommit'),
    payload: z.object({
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/u),
      mode: z.enum(['soft', 'mixed', 'hard']),
      confirmed: z.boolean().optional(),
    }),
  }),
  /** Git 贮藏（Stash）：新建、查看文件与 Diff、Apply / Pop / Drop。 */
  z.object({
    type: z.literal('sourceControlStashSave'),
    payload: z.object({
      message: z.string().max(500).optional(),
      includeUntracked: z.boolean().optional(),
      paths: z.array(z.string().min(1).max(4_096)).max(500).optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlStashApply'),
    payload: z.object({ index: z.number().int().min(0).max(500) }),
  }),
  z.object({
    type: z.literal('sourceControlStashPop'),
    payload: z.object({ index: z.number().int().min(0).max(500) }),
  }),
  z.object({
    type: z.literal('sourceControlStashDrop'),
    payload: z.object({
      index: z.number().int().min(0).max(500),
      confirmed: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('sourceControlFetchStashDetail'),
    payload: z.object({
      requestId: z.number().int(),
      index: z.number().int().min(0).max(500),
    }),
  }),
  z.object({
    type: z.literal('sourceControlOpenStashFileDiff'),
    payload: z.object({
      index: z.number().int().min(0).max(500),
      path: z.string().min(1).max(4_096),
    }),
  }),
  /** AI / 规则生成提交信息与 PR 描述草稿（P0-2）。 */
  z.object({
    type: z.literal('sourceControlGenerateCommitMessage'),
    payload: z.object({ requestId: z.number().int() }),
  }),
  z.object({
    type: z.literal('sourceControlGeneratePrDraft'),
    payload: z.object({ requestId: z.number().int() }),
  }),
  /** PR 合并后一键结单（归档关联任务 / 可选清理 worktree，P1-7）。 */
  z.object({
    type: z.literal('sourceControlSettlePr'),
    payload: z.object({
      removeWorktree: z.boolean().optional(),
      completeLinkedTask: z.boolean().optional(),
    }),
  }),
  /** 保存内置 CodeMirror 6 编辑器修改的工作区文件（P0-1）。 */
  z.object({
    type: z.literal('saveWorkspaceFile'),
    payload: z.object({ path: z.string().min(1).max(4_096), content: z.string().max(2_000_000) }),
  }),
  /** 跨底层多回合 Git 检查点回滚 / 会话分叉 / 编辑历史消息重发（P0-3）。 */
  z.object({
    type: z.literal('rollbackToTurn'),
    payload: z.object({ turnSeq: z.number().int().positive(), confirmed: z.boolean().optional() }),
  }),
  z.object({
    type: z.literal('forkSessionAtTurn'),
    payload: z.object({ turnSeq: z.number().int().positive() }),
  }),
  z.object({
    type: z.literal('editAndResendTurn'),
    payload: z.object({
      turnSeq: z.number().int().positive(),
      text: z.string().min(1).max(200_000),
      rollbackFiles: z.boolean().optional(),
    }),
  }),
  /** 右侧栏内置终端会话管理（P1-4）。 */
  z.object({
    type: z.literal('terminalCreate'),
    payload: z.object({
      cwd: z.string().max(4_096).optional(),
      title: z.string().max(120).optional(),
      cols: z.number().int().min(20).max(400).optional(),
      rows: z.number().int().min(5).max(200).optional(),
    }),
  }),
  z.object({
    type: z.literal('terminalInput'),
    payload: z.object({ id: z.string().min(1).max(100), data: z.string().max(64_000) }),
  }),
  z.object({
    type: z.literal('terminalResize'),
    payload: z.object({
      id: z.string().min(1).max(100),
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(200),
    }),
  }),
  z.object({ type: z.literal('terminalClose'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({ type: z.literal('terminalRestart'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({ type: z.literal('terminalClear'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  z.object({ type: z.literal('terminalSelect'), payload: z.object({ id: z.string().min(1).max(100) }) }),
  /** 右侧栏内置浏览器控制与交互（CDP 实时画面 + AI MCP 连接）。 */
  z.object({
    type: z.literal('browserLaunch'),
    payload: z.object({
      url: z.string().max(4_096).optional(),
      cdpUrl: z.string().max(1_024).optional(),
      executablePath: z.string().max(1_024).optional(),
      width: z.number().int().min(320).max(2_560).optional(),
      height: z.number().int().min(240).max(2_000).optional(),
      deviceScaleFactor: z.number().min(1).max(3).optional(),
    }),
  }),
  z.object({ type: z.literal('browserStop'), payload: empty }),
  z.object({ type: z.literal('browserNavigate'), payload: z.object({ url: z.string().min(1).max(4_096) }) }),
  z.object({ type: z.literal('browserBack'), payload: empty }),
  z.object({ type: z.literal('browserForward'), payload: empty }),
  z.object({ type: z.literal('browserReload'), payload: empty }),
  z.object({
    type: z.literal('browserResize'),
    payload: z.object({
      width: z.number().int().min(320).max(2_560),
      height: z.number().int().min(240).max(2_000),
      preset: z.enum(['responsive', 'desktop', 'mobile']).optional(),
      deviceScaleFactor: z.number().min(1).max(3).optional(),
    }),
  }),
  z.object({
    type: z.literal('browserMouse'),
    payload: z.object({
      action: z.enum(['move', 'down', 'up', 'wheel']),
      x: z.number().min(0).max(10_000),
      y: z.number().min(0).max(10_000),
      button: z.enum(['left', 'middle', 'right', 'none']).optional(),
      buttons: z.number().int().min(0).max(63).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      deltaX: z.number().min(-5_000).max(5_000).optional(),
      deltaY: z.number().min(-5_000).max(5_000).optional(),
      modifiers: z.number().int().min(0).max(15).optional(),
    }),
  }),
  z.object({
    type: z.literal('browserKey'),
    payload: z.object({
      action: z.enum(['down', 'up', 'char']),
      key: z.string().max(64),
      code: z.string().max(64).optional(),
      text: z.string().max(256).optional(),
      modifiers: z.number().int().min(0).max(15).optional(),
    }),
  }),
  z.object({
    type: z.literal('browserSetAiEnabled'),
    payload: z.object({ enabled: z.boolean() }),
  }),
  z.object({ type: z.literal('browserClearConsole'), payload: empty }),
  z.object({ type: z.literal('browserRequestFrame'), payload: empty }),
  z.object({
    type: z.literal('browserInspectAt'),
    payload: z.object({
      x: z.number().min(0).max(10_000),
      y: z.number().min(0).max(10_000),
      select: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('browserSelectElement'),
    payload: z.object({
      selector: z.string().min(1).max(2_048),
      scrollIntoView: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('browserEditElementStyle'),
    payload: z.object({
      selector: z.string().min(1).max(2_048),
      property: z.string().min(1).max(128),
      value: z.string().max(1_024),
    }),
  }),
  z.object({
    type: z.literal('browserEvalConsole'),
    payload: z.object({
      expression: z.string().min(1).max(8_192),
      selectedSelector: z.string().min(1).max(2_048).optional(),
    }),
  }),
  z.object({
    type: z.literal('browserGetConsoleObject'),
    payload: z.object({
      requestId: z.string().min(1).max(128),
      objectId: z.string().min(1).max(512),
    }),
  }),
  z.object({
    type: z.literal('browserConsoleComplete'),
    payload: z.object({
      requestId: z.string().min(1).max(128),
      expression: z.string().max(4_096),
      selectedSelector: z.string().min(1).max(2_048).optional(),
    }),
  }),
  z.object({
    type: z.literal('browserSetConsoleOptions'),
    payload: z.object({
      preserveLog: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('browserClearNetwork'), payload: empty }),
  z.object({
    type: z.literal('browserGetNetworkBody'),
    payload: z.object({
      requestId: z.string().min(1).max(256),
    }),
  }),
  z.object({
    type: z.literal('browserClipboard'),
    payload: z.object({
      action: z.enum(['copy', 'cut', 'paste', 'selectAll']),
      text: z.string().max(500_000).optional(),
    }),
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
      preset: z.enum(['default', 'grove', 'ocean', 'ember', 'iris']).nullable().optional(),
      highContrast: z.boolean().nullable().optional(),
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
      fetchQuota: z.boolean().optional(),
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
  /** 在当前会话或新窗口中打开对应项目目录；`inPlace: true` 表示在当前面板内就地切换工作区。 */
  z.object({
    type: z.literal('openProject'),
    payload: z.object({ path: z.string().min(1).max(4_096), inPlace: z.boolean().optional() }),
  }),
  /** 添加并配对一个云端开发环境（Colab / 远端 Linux / 自定义 Halo Server）。 */
  z.object({
    type: z.literal('addCloudEnvironment'),
    payload: z.object({
      name: z.string().max(120).optional(),
      provider: z.enum(['colab', 'linux', 'custom']).optional(),
      pairingUrlOrEndpoint: z.string().min(1).max(2_048),
      pairingCode: z.string().max(256).optional(),
      connectNow: z.boolean().optional(),
    }),
  }),
  /** 更新已保存云环境的名称、类型或隧道配对链接（如 Colab 重启后刷新隧道地址）。 */
  z.object({
    type: z.literal('updateCloudEnvironment'),
    payload: z.object({
      id: z.string().min(1).max(120),
      name: z.string().max(120).optional(),
      provider: z.enum(['colab', 'linux', 'custom']).optional(),
      pairingUrlOrEndpoint: z.string().min(1).max(2_048).optional(),
      pairingCode: z.string().max(256).optional(),
      reconnect: z.boolean().optional(),
    }),
  }),
  /** 切换到并连接指定云端开发环境。 */
  z.object({
    type: z.literal('connectCloudEnvironment'),
    payload: z.object({ id: z.string().min(1).max(120) }),
  }),
  /** 断开当前云端环境并切回本地工作区。 */
  z.object({
    type: z.literal('disconnectCloudEnvironment'),
    payload: empty,
  }),
  /** 删除一个已保存的云端开发环境及其本地保存的配对凭据。 */
  z.object({
    type: z.literal('removeCloudEnvironment'),
    payload: z.object({ id: z.string().min(1).max(120) }),
  }),
  /** 在当前已连接的云端环境中切换远端工作目录。 */
  z.object({
    type: z.literal('switchCloudProject'),
    payload: z.object({ path: z.string().min(1).max(4_096) }),
  }),
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
  z.object({ type: z.literal('scanAgentSkills'), payload: empty }),
  z.object({ type: z.literal('pickLocalSkillDir'), payload: empty }),
  z.object({
    type: z.literal('fetchSkillMarket'),
    payload: z.object({
      query: z.string().max(200).optional(),
      force: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('importLocalSkills'),
    payload: z.object({
      skills: z
        .array(
          z.object({
            sourceDir: z.string().min(1).max(2_000),
            importedFrom: z.string().max(200).optional(),
          }),
        )
        .min(1)
        .max(200),
      agents: z.array(z.string().min(1).max(100)).max(100).optional(),
    }),
  }),
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
    type: z.literal('fetchMcpMarket'),
    payload: z.object({
      query: z.string().max(200).optional(),
      force: z.boolean().optional(),
    }),
  }),
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
  /** 悬浮上下文旁的用量标识或回合结束时查询官方订阅额度；force=true 时跳过宿主缓存实时刷新。 */
  z.object({
    type: z.literal('fetchQuota'),
    payload: z.object({ requestId: z.number().int(), force: z.boolean().optional() }),
  }),
  /** 设置 -> Agent -> 账号：官方渠道多账号管理与智能体渠道路由切换（官方 ↔ 服务商）。 */
  z.object({
    type: z.literal('upsertAccount'),
    payload: z.object({
      id: z.string().max(120).optional(),
      backendId: z.string().min(1).max(100),
      label: z.string().max(120),
      isolateSessions: z.boolean().optional(),
      region: z.enum(['cn', 'ai', 'internal']).optional(),
      /** 仅 dsh 官方 API Key 账号使用：undefined 保留原密钥，空串清除，非空写入 SecretStorage。 */
      apiKey: z.string().max(4_000).optional(),
      /** 仅 CodeBuddy 官方额度查询 Cookie 使用：undefined 保留，空串清除，非空写入 SecretStorage。 */
      usageCookie: z.string().max(8_000).optional(),
      /** 自定义标签（如 主力 / 备用 / 团队）。 */
      tags: z.array(z.string().max(40)).max(12).optional(),
      /** 可选账号备注。 */
      notes: z.string().max(300).optional(),
      /** 是否临时禁用（禁用后不参与低配额自动切号）。 */
      disabled: z.boolean().optional(),
      /** 保存后是否立即设为该智能体的激活官方账号。 */
      setActive: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal('deleteAccount'), payload: z.object({ id: z.string().min(1).max(120) }) }),
  z.object({
    type: z.literal('toggleAccountDisabled'),
    payload: z.object({ id: z.string().min(1).max(120), disabled: z.boolean() }),
  }),
  z.object({
    type: z.literal('refreshAccount'),
    payload: z.object({
      id: z.string().min(1).max(120),
      backendId: z.string().min(1).max(100),
      includeQuota: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('setAccountAutomation'),
    payload: z.object({
      autoSwitchEnabled: z.boolean().optional(),
      autoSwitchThresholdPercent: z.number().int().min(0).max(50).optional(),
      autoSwitchStrategy: z.enum(['highest-quota', 'round-robin']).optional(),
      autoRefreshIntervalMin: z.number().int().min(0).max(1_440).optional(),
    }),
  }),
  z.object({
    type: z.literal('importAccounts'),
    payload: z.object({
      rawJson: z.string().min(1).max(500_000),
      defaultBackendId: z.string().max(100).optional(),
    }),
  }),
  z.object({
    type: z.literal('exportAccounts'),
    payload: z.object({
      requestId: z.number().int(),
      includeSecrets: z.boolean().optional(),
      backendId: z.string().max(100).optional(),
    }),
  }),
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
      /** `'session'` 仅对当前会话/标签生效（隔离其他会话与工具默认渠道）；缺省或 `'default'` 修改该智能体的默认渠道。 */
      scope: z.enum(['session', 'default']).optional(),
      sessionId: z.string().max(200).optional(),
      tabKey: z.string().max(120).optional(),
    }),
  }),
  /** 手机端远程互通（HD-23 / HD-26 / HD-27）。 */
  z.object({ type: z.literal('setRemoteEnabled'), payload: z.object({ enabled: z.boolean() }) }),
  z.object({
    type: z.literal('setRemoteConfig'),
    payload: z.object({
      selectedHost: z.string().max(255).optional(),
      scope: z.enum(['read-only', 'operate', 'owner']).optional(),
      tunnelUrl: z.string().max(2_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('generateRemotePairing'),
    payload: z.object({
      scope: z.enum(['read-only', 'operate', 'owner']).optional(),
      routeKind: z.enum(['lan', 'tailscale', 'quick-tunnel', 'tunnel']).optional(),
    }),
  }),
  z.object({ type: z.literal('clearRemotePairing'), payload: empty }),
  z.object({
    type: z.literal('updateRemoteDevice'),
    payload: z.object({
      deviceId: z.string().min(1).max(120),
      name: z.string().min(1).max(80).optional(),
      scope: z.enum(['read-only', 'operate', 'owner']).optional(),
    }),
  }),
  z.object({ type: z.literal('revokeRemoteDevice'), payload: z.object({ deviceId: z.string().min(1).max(120) }) }),
  z.object({ type: z.literal('disconnectAllRemote'), payload: empty }),
  z.object({ type: z.literal('refreshRemoteNetwork'), payload: empty }),
  z.object({ type: z.literal('probeTailscale'), payload: empty }),
  z.object({ type: z.literal('configureTailscaleServe'), payload: z.object({ enabled: z.boolean() }) }),
  z.object({ type: z.literal('probeQuickTunnel'), payload: empty }),
  z.object({ type: z.literal('setQuickTunnelEnabled'), payload: z.object({ enabled: z.boolean() }) }),
  z.object({
    type: z.literal('setRemotePushConfig'),
    payload: z.object({
      webPushEnabled: z.boolean().optional(),
      suppressWhenFocused: z.boolean().optional(),
      webhook: z
        .object({
          enabled: z.boolean().optional(),
          preset: z
            .enum(['bark', 'ntfy', 'feishu', 'wecom', 'dingtalk', 'telegram', 'slack', 'discord', 'custom'])
            .optional(),
          url: z.string().max(2_000).optional(),
          secret: z.string().max(512).optional(),
          chatId: z.string().max(128).optional(),
          group: z.string().max(128).optional(),
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
  /** IM 机器人双向聊天（企微 / 飞书 / 钉钉 / Telegram 长连接与长轮询）。 */
  z.object({
    type: z.literal('updateImBotChannel'),
    payload: z.object({
      platform: z.enum(['wecom', 'feishu', 'dingtalk', 'telegram']),
      enabled: z.boolean().optional(),
      appId: z.string().max(256).optional(),
      /** undefined 保留原密钥；空字符串清除密钥；非空字符串写入本机 SecretStorage。 */
      secret: z.string().max(2_000).optional(),
      domain: z.enum(['feishu', 'lark']).optional(),
      apiBase: z.string().max(2_000).optional(),
      allowlist: z.array(z.string().max(256)).max(200).optional(),
      requireMentionInGroup: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('generateImBotPairing'),
    payload: z.object({
      platform: z.enum(['wecom', 'feishu', 'dingtalk', 'telegram']).optional(),
    }),
  }),
  z.object({ type: z.literal('clearImBotPairing'), payload: empty }),
  z.object({
    type: z.literal('revokeImBotUser'),
    payload: z.object({ id: z.string().min(1).max(300) }),
  }),
  z.object({
    type: z.literal('testImBotChannel'),
    payload: z.object({ platform: z.enum(['wecom', 'feishu', 'dingtalk', 'telegram']) }),
  }),
  /** 远端存储（Google Cloud Storage / Google Drive / WebDAV）与文件管理操作。 */
  z.object({
    type: z.literal('upsertRemoteStorage'),
    payload: z.object({
      id: z.string().min(1).max(120).optional(),
      name: z.string().min(1).max(120),
      kind: z.enum(['google-cloud-storage', 'google-drive', 'webdav']),
      endpoint: z.string().max(2_048).optional(),
      bucket: z.string().max(256).optional(),
      rootPath: z.string().max(1_024).optional(),
      username: z.string().max(256).optional(),
      /** undefined 保留原凭据；非空写入 SecretStorage（密码 / Access Token / Service Account JSON / Refresh Token JSON）。 */
      secret: z.string().max(64_000).optional(),
    }),
  }),
  z.object({
    type: z.literal('deleteRemoteStorage'),
    payload: z.object({ id: z.string().min(1).max(120) }),
  }),
  z.object({
    type: z.literal('testRemoteStorage'),
    payload: z.object({ id: z.string().min(1).max(120) }),
  }),
  /** 探测本机 gcloud / Google OAuth 一键授权就绪状态（只读、无副作用）。 */
  z.object({ type: z.literal('probeRemoteStorageAuth'), payload: empty }),
  /** 启动 Google 浏览器一键登录授权（本地 OAuth PKCE 回环或本机 gcloud ADC）。 */
  z.object({
    type: z.literal('startRemoteStorageOAuth'),
    payload: z.object({
      kind: z.enum(['google-drive', 'google-cloud-storage']),
      method: z.enum(['oauth', 'gcloud']),
      storageId: z.string().min(1).max(120).optional(),
      name: z.string().max(120).optional(),
      bucket: z.string().max(256).optional(),
      rootPath: z.string().max(1_024).optional(),
      clientId: z.string().max(512).optional(),
      clientSecret: z.string().max(512).optional(),
    }),
  }),
  /** 取消正在进行的浏览器授权回调等待。 */
  z.object({ type: z.literal('cancelRemoteStorageOAuth'), payload: empty }),
  z.object({
    type: z.literal('listRemoteFiles'),
    payload: z.object({
      requestId: z.number().int(),
      storageId: z.string().min(1).max(120),
      dirPath: z.string().max(4_096).optional(),
      query: z.string().max(500).optional(),
    }),
  }),
  z.object({
    type: z.literal('previewRemoteFile'),
    payload: z.object({
      storageId: z.string().min(1).max(120),
      entryId: z.string().min(1).max(4_096),
      path: z.string().min(1).max(4_096),
      name: z.string().min(1).max(512),
    }),
  }),
  z.object({
    type: z.literal('downloadRemoteFile'),
    payload: z.object({
      storageId: z.string().min(1).max(120),
      entryId: z.string().min(1).max(4_096),
      path: z.string().min(1).max(4_096),
      name: z.string().min(1).max(512),
    }),
  }),
  z.object({
    type: z.literal('uploadRemoteFiles'),
    payload: z.object({
      storageId: z.string().min(1).max(120),
      dirPath: z.string().max(4_096).optional(),
      /** 未提供时由宿主弹出系统文件选择框读取本地文件；提供时直接上传 base64 内容（支持移动端/浏览器）。 */
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(512),
            dataBase64: z.string().max(32 * 1024 * 1024),
            mimeType: z.string().max(256).optional(),
          }),
        )
        .max(20)
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('deleteRemoteFile'),
    payload: z.object({
      storageId: z.string().min(1).max(120),
      entryId: z.string().min(1).max(4_096),
      path: z.string().min(1).max(4_096),
      name: z.string().min(1).max(512),
      kind: z.enum(['file', 'directory']),
    }),
  }),
  z.object({
    type: z.literal('createRemoteFolder'),
    payload: z.object({
      storageId: z.string().min(1).max(120),
      dirPath: z.string().max(4_096).optional(),
      name: z.string().min(1).max(256),
    }),
  }),
  /** 本地工作区文件管理常用操作（严格限定在当前工作区目录内）。 */
  z.object({
    type: z.literal('deleteLocalFile'),
    payload: z.object({
      path: z.string().min(1).max(4_096),
      kind: z.enum(['file', 'directory']),
    }),
  }),
  z.object({
    type: z.literal('createLocalFolder'),
    payload: z.object({
      dirPath: z.string().max(4_096).optional(),
      name: z.string().min(1).max(256),
    }),
  }),
  z.object({
    type: z.literal('uploadLocalFiles'),
    payload: z.object({
      dirPath: z.string().max(4_096).optional(),
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(512),
            dataBase64: z.string().max(32 * 1024 * 1024),
          }),
        )
        .max(20)
        .optional(),
    }),
  }),
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
  readonly remoteStorages?: RemoteStoragesState;
  readonly terminal?: TerminalState;
  readonly browser?: BrowserState;
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
      readonly type: 'accountsExported';
      readonly payload: {
        readonly requestId: number;
        readonly json: string;
        readonly count: number;
        readonly includesSecrets: boolean;
      };
    }
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
  | { readonly type: 'remoteStorages'; readonly payload: RemoteStoragesState }
  | { readonly type: 'remoteStorageAuthProgress'; readonly payload: RemoteStorageAuthState }
  | { readonly type: 'remoteFilesListed'; readonly payload: RemoteStorageListResult }
  | {
      readonly type: 'remoteFileActionDone';
      readonly payload: {
        readonly storageId: string;
        readonly action: 'upload' | 'download' | 'delete' | 'mkdir' | 'test';
        readonly ok: boolean;
        readonly message?: string;
        readonly download?: {
          readonly name: string;
          readonly mimeType?: string;
          readonly dataBase64: string;
        };
      };
    }
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
  | { readonly type: 'focusComposer'; readonly payload: Record<string, never> }
  | { readonly type: 'fileSaved'; readonly payload: { readonly path: string; readonly ok: boolean; readonly error?: string } }
  | {
      readonly type: 'sourceControlDraftGenerated';
      readonly payload: {
        readonly requestId: number;
        readonly kind: 'commit' | 'pr';
        readonly message?: string;
        readonly title?: string;
        readonly body?: string;
        readonly error?: string;
      };
    }
  | {
      readonly type: 'sourceControlLogResult';
      readonly payload: {
        readonly requestId: number;
        readonly commits: readonly SourceControlCommitView[];
        readonly hasMore: boolean;
        readonly append?: boolean;
        readonly error?: string;
      };
    }
  | {
      readonly type: 'sourceControlCommitDetail';
      readonly payload: {
        readonly requestId: number;
        readonly detail?: SourceControlCommitDetailView;
        readonly error?: string;
      };
    }
  | {
      readonly type: 'sourceControlStashDetail';
      readonly payload: {
        readonly requestId: number;
        readonly index: number;
        readonly files: readonly SourceControlCommitFileView[];
        readonly error?: string;
      };
    }
  | { readonly type: 'terminalState'; readonly payload: TerminalState }
  | { readonly type: 'terminalOutput'; readonly payload: { readonly id: string; readonly data: string; readonly reset?: boolean } }
  | { readonly type: 'browserState'; readonly payload: BrowserState }
  | {
      readonly type: 'browserFrame';
      readonly payload: {
        readonly data: string;
        readonly format?: 'png' | 'jpeg';
        readonly width: number;
        readonly height: number;
        readonly timestamp: number;
      };
    }
  | {
      readonly type: 'browserInspectResult';
      readonly payload: {
        readonly mode: 'hover' | 'select';
        readonly element?: BrowserDomElement;
      };
    }
  | {
      readonly type: 'browserNetworkBody';
      readonly payload: {
        readonly requestId: string;
        readonly body?: string;
        readonly base64Encoded?: boolean;
        readonly error?: string;
      };
    }
  | {
      readonly type: 'browserClipboardData';
      readonly payload: {
        readonly text: string;
      };
    }
  | {
      readonly type: 'browserConsoleObject';
      readonly payload: {
        readonly requestId: string;
        readonly objectId: string;
        readonly properties?: readonly BrowserConsoleProperty[];
        readonly error?: string;
      };
    }
  | {
      readonly type: 'browserConsoleCompletions';
      readonly payload: {
        readonly requestId: string;
        readonly prefix: string;
        readonly items: readonly string[];
      };
    }
  | { readonly type: 'sessionCheckpoints'; readonly payload: { readonly sessionId: string; readonly turns: readonly number[] } };

/**
 * 解析来自 Webview 的消息；格式不对时返回 undefined，由调用方记录日志并丢弃。
 * @param value - `onDidReceiveMessage` 收到的原始值。
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
  const parsed = webviewToHostSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

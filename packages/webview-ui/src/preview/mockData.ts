import { backendCapabilities } from '@harness-deck/shared';
import type {
  AgentProfile,
  BackendsState,
  CommandView,
  ExtensionsState,
  FileCandidate,
  Item,
  KanbanTask,
  ModelState,
  PendingInteraction,
  PermissionState,
  PreferencesState,
  ProjectsState,
  ProvidersState,
  ScheduleRule,
  SessionHeader,
  SessionListItem,
  WorkbenchState,
} from '@harness-deck/shared';

export interface PreviewSessionData {
  readonly header: SessionHeader;
  readonly items: readonly Item[];
  readonly interactions: readonly PendingInteraction[];
  readonly olderPages?: readonly (readonly Item[])[];
}

const now = Date.now();
const min = 60_000;
const hour = 60 * min;

export const PREVIEW_WORKSPACE_PATH = '/workspace/harness-deck';

export const PREVIEW_FILES: readonly FileCandidate[] = [
  { path: 'packages/webview-ui/src/App.tsx', kind: 'file' },
  { path: 'packages/webview-ui/src/store.ts', kind: 'file' },
  { path: 'packages/webview-ui/src/vscode.ts', kind: 'file' },
  { path: 'packages/webview-ui/src/components/Header.tsx', kind: 'file' },
  { path: 'packages/webview-ui/src/components/Composer.tsx', kind: 'file' },
  { path: 'packages/webview-ui/src/components/Thread.tsx', kind: 'file' },
  { path: 'packages/webview-ui/src/components/SettingsPage.tsx', kind: 'file' },
  { path: 'packages/webview-ui/src/styles/beautifului-foundation.css', kind: 'file' },
  { path: 'packages/extension/src/host/HarnessHostRuntime.ts', kind: 'file' },
  { path: 'packages/shared/src/viewModel.ts', kind: 'file' },
  { path: 'packages/shared/src/bridge.ts', kind: 'file' },
  { path: 'README.md', kind: 'file' },
];

export const PREVIEW_BACKENDS: BackendsState = {
  active: 'dsh',
  workspace: 'harness-deck',
  nodeEnv: { checked: true, hasNode: true, hasNpm: true, nodeVersion: 'v22.14.0', npmVersion: '10.9.2' },
  items: [
    { id: 'dsh', name: 'DeepSeek', kind: 'dsh', capabilities: backendCapabilities({ id: 'dsh', kind: 'dsh' }), builtin: true, available: true, version: '0.9.4', npmPackage: '@deepseek-ai/dsh' },
    { id: 'claude', name: 'Claude Code', kind: 'claude', capabilities: backendCapabilities({ id: 'claude', kind: 'claude' }), builtin: true, available: true, version: '1.0.32', npmPackage: '@anthropic-ai/claude-code' },
    { id: 'pi', name: 'Pi', kind: 'pi', capabilities: backendCapabilities({ id: 'pi', kind: 'pi' }), builtin: true, available: true, version: '0.6.1', npmPackage: '@earendil-works/pi-coding-agent' },
    { id: 'zcode', name: 'ZCode', kind: 'zcode', capabilities: backendCapabilities({ id: 'zcode', kind: 'zcode' }), builtin: true, available: false, installHint: 'npm install -g zcode-app-cli' },
    { id: 'codebuddy', name: 'CodeBuddy', kind: 'acp', capabilities: backendCapabilities({ id: 'codebuddy', kind: 'acp', command: 'codebuddy --acp' }), builtin: true, available: true, version: '2.1.0', command: 'codebuddy --acp' },
    { id: 'opencode', name: 'OpenCode', kind: 'acp', capabilities: backendCapabilities({ id: 'opencode', kind: 'acp', command: 'opencode acp' }), builtin: true, available: true, version: '0.4.8', command: 'opencode acp' },
    { id: 'antigravity', name: 'Antigravity', kind: 'acp', capabilities: backendCapabilities({ id: 'antigravity', kind: 'acp', command: 'agy acp' }), builtin: true, available: true, version: '1.5.12', command: 'agy acp' },
  ],
};

export const PREVIEW_MODELS: ModelState = {
  current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
  options: [
    {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      group: 'DeepSeek',
      description: '深度推理与复杂工程重构',
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'high',
    },
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      name: 'DeepSeek Chat',
      group: 'DeepSeek',
      description: '快速日常编码与问答',
      efforts: [],
    },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      group: 'Anthropic',
      description: '均衡速度与代码质量',
      efforts: [
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'medium',
    },
  ],
};

export const PREVIEW_PERMISSIONS: PermissionState = {
  options: ['read-only', 'workspace-write', 'danger-full-access'],
  current: 'workspace-write',
};

export const PREVIEW_COMMANDS: readonly CommandView[] = [
  { name: 'plan', description: '进入只读计划模式，先梳理方案再动手', source: 'plugin' },
  { name: 'review', description: '审查当前工作区改动与潜在边界问题', source: 'agent' },
  { name: 'explain', description: '解释选中代码或当前模块的设计结构', hint: '<symbol>', source: 'skill' },
  { name: 'verify', description: '运行 typecheck、lint 与单测并汇报结果', source: 'custom', prompt: '请依次运行 pnpm typecheck、pnpm lint 和 pnpm test，并汇总结果。' },
];

export const PREVIEW_PROVIDERS: ProvidersState = {
  items: [
    {
      id: 'prov-deepseek',
      name: 'DeepSeek Official',
      presetId: 'deepseek',
      openaiChatUrl: 'https://api.deepseek.com/v1/chat/completions',
      hasApiKey: true,
      defaultModel: 'deepseek-reasoner',
      smallModel: 'deepseek-chat',
      boundBackendIds: ['dsh', 'opencode'],
      boundAgentIds: ['builtin-builder'],
      models: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: '128k', maxOutputTokens: '64k', efforts: ['low', 'medium', 'high'] },
        { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: '128k', maxOutputTokens: '8k' },
      ],
    },
  ],
};

export const PREVIEW_EXTENSIONS: ExtensionsState = {
  skills: {
    items: [
      {
        id: 'code-review-checklist',
        name: 'code-review-checklist',
        description: '按团队规范检查 TypeScript 类型、空值边界与单测覆盖率',
        repoUrl: 'https://github.com/example/agent-skills',
        ref: 'main',
        commit: 'a1b2c3d',
        skillMdPath: '/workspace/harness-deck/.dsh/skills/code-review-checklist/SKILL.md',
        enabled: true,
        installedAt: now - 3 * 24 * hour,
        updatedAt: now - 12 * hour,
      },
    ],
  },
  mcp: {
    servers: [
      {
        id: 'mcp-context7',
        name: 'context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        enabled: true,
        agents: ['dsh', 'claude'],
        importedFrom: 'Claude Code',
      },
      {
        id: 'mcp-github',
        name: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: false,
        agents: ['dsh'],
      },
    ],
  },
};

export const PREVIEW_PROJECTS: ProjectsState = {
  currentPath: PREVIEW_WORKSPACE_PATH,
  recent: [
    { path: PREVIEW_WORKSPACE_PATH, name: 'harness-deck', lastOpenedAt: now - 5 * min, isCurrent: true },
    { path: '/workspace/beautiful-ui', name: 'beautiful-ui', lastOpenedAt: now - 6 * hour },
  ],
  configs: {
    [PREVIEW_WORKSPACE_PATH]: {
      copyFiles: ['.env.local'],
      setupCommands: ['pnpm install --frozen-lockfile'],
      verifyCommands: ['pnpm typecheck', 'pnpm lint', 'pnpm test'],
    },
  },
};

export const PREVIEW_PREFERENCES: PreferencesState = {
  language: 'auto',
  includeActiveEditor: true,
  showTurnChanges: true,
  schedulePermission: 'danger-full-access',
  notifications: {
    enabled: true,
    onlyWhenUnfocused: true,
    onAttention: true,
    onTurnComplete: true,
    onUnexpectedExit: true,
    onScheduledComplete: true,
  },
  advanced: {
    dshPath: '',
    dshProfile: 'web',
    backendTrace: false,
  },
  chatCommands: [
    {
      name: 'verify',
      description: '运行 typecheck、lint 与单测并汇报结果',
      prompt: '请依次运行 pnpm typecheck、pnpm lint 和 pnpm test，并汇总结果。',
    },
  ],
};

export function createInitialSessions(): Record<string, PreviewSessionData> {
  return {
    'session-preview-main': {
      header: {
        id: 'session-preview-main',
        title: '浏览器本地预览模式调试',
        running: false,
        hasOlder: false,
        loadingOlder: false,
        sync: 'live',
        contextUsage: 0.28,
        contextTokens: { used: 36_400, window: 128_000 },
        contextDetail: {
          lastRequest: { input: 1_840, output: 6_200, cacheRead: 24_800, cacheWrite: 3_560, reasoning: 2_400 },
          session: { input: 9_620, output: 21_400, cacheRead: 118_000, cacheWrite: 12_900, reasoning: 8_300 },
          requests: 14,
          cost: { amount: 1.284, currency: 'USD' },
        },
        folder: 'harness-deck',
        todos: [
          { content: '梳理 webview-ui 通信入口与主题变量', status: 'completed' },
          { content: '实现浏览器本地预览 Mock Host', status: 'in_progress' },
          { content: '在浏览器中验证各模块交互与样式', status: 'pending' },
        ],
        changes: {
          additions: 118,
          deletions: 6,
          files: [
            { path: 'packages/webview-ui/index.html', additions: 12, deletions: 0, created: true, ref: { kind: 'session', path: 'packages/webview-ui/index.html' } },
            { path: 'packages/webview-ui/src/preview/mockHost.ts', additions: 84, deletions: 0, created: true, ref: { kind: 'session', path: 'packages/webview-ui/src/preview/mockHost.ts' } },
            { path: 'packages/webview-ui/package.json', additions: 22, deletions: 6, ref: { kind: 'session', path: 'packages/webview-ui/package.json' } },
          ],
        },
      },
      interactions: [],
      items: [
        {
          kind: 'user',
          id: 'u-1',
          text: '帮我看一下 webview-ui 能不能直接在浏览器预览，并演示一轮带工具调用和代码修改的回复效果。',
          attachments: [{ kind: 'file', path: 'packages/webview-ui/src/vscode.ts' }],
        },
        {
          kind: 'explore',
          id: 'exp-1',
          summary: '浏览了 3 个文件',
          status: 'ok',
          entries: [
            { id: 'e-1', label: 'read packages/webview-ui/vite.config.ts', status: 'ok', path: 'packages/webview-ui/vite.config.ts' },
            { id: 'e-2', label: 'read packages/webview-ui/src/vscode.ts', status: 'ok', path: 'packages/webview-ui/src/vscode.ts' },
            { id: 'e-3', label: 'grep acquireVsCodeApi packages/webview-ui', status: 'ok' },
          ],
        },
        {
          kind: 'activity',
          id: 'act-edit-1',
          tool: 'edit',
          variant: 'edit',
          label: 'packages/webview-ui/index.html',
          status: 'ok',
          created: true,
          stats: { additions: 12, deletions: 0 },
          diff: { kind: 'tool', callId: 'act-edit-1' },
        },
        {
          kind: 'activity',
          id: 'act-cmd-1',
          tool: 'bash',
          variant: 'command',
          label: 'bash pnpm --filter @harness-deck/webview-ui run typecheck',
          status: 'ok',
          output: '> @harness-deck/webview-ui@0.0.0 typecheck\n> tsc -p tsconfig.json\n\nDone in 1.4s (0 errors)',
        },
        {
          kind: 'assistant',
          id: 'a-1',
          streaming: false,
          reasoning: '已确认生产构建只以 src/main.tsx 为入口，因此可以在 packages/webview-ui 下独立提供 index.html 和 src/preview/mockHost.ts，不影响 VS Code 扩展包产物。',
          markdown: [
            '已经为 `@harness-deck/webview-ui` 接好了**浏览器本地预览模式**（带热更新与交互式 Mock Host）。\n\n',
            '### 已包含的演示能力\n\n',
            '- **实时流式对话**：在下方输入框直接发消息，会模拟推理流（Thinking）、工具执行与 Markdown 代码块流式输出。\n',
            '- **主题与配色实时切换**：点右上角设置 → 外观，可切换浅色/深色与 5 套整套配色（`slate` / `warm` / `forest` / `violet` / `rose`）。\n',
            '- **工作台五大模块**：顶部可切换 **总览 / 定时 / 智能体 / 任务 / 会话**，支持新建任务、拖拽流转状态、编辑规则。\n\n',
            '```ts\n',
            'export function installPreviewBridge(): void {\n',
            '  window.acquireVsCodeApi = () => ({ postMessage, getState, setState });\n',
            '}\n',
            '```\n\n',
            '| 模块 | 状态 | 说明 |\n| --- | --- | --- |\n| 会话流 | 就绪 | 支持 `@` 补全、`/` 命令与流式回复 |\n| 审批与提问 | 就绪 | 可切换到「待确认」会话体验交互卡片 |\n',
          ].join(''),
        },
        {
          kind: 'changes',
          id: 'chg-1',
          turn: 1,
          source: 'turn',
          total: 2,
          files: [
            { path: 'packages/webview-ui/index.html', additions: 12, deletions: 0, created: true, ref: { kind: 'turn', seq: 1, index: 0 } },
            { path: 'packages/webview-ui/src/preview/mockHost.ts', additions: 84, deletions: 0, created: true, ref: { kind: 'turn', seq: 1, index: 1 } },
          ],
        },
        {
          kind: 'turnDone',
          id: 'td-1',
          durationMs: 4280,
          completed: true,
        },
      ],
    },
    'session-preview-approval': {
      header: {
        id: 'session-preview-approval',
        title: '待确认：验证生产包构建与清理',
        running: false,
        hasOlder: false,
        loadingOlder: false,
        sync: 'live',
        contextUsage: 0.14,
        contextTokens: { used: 18_200, window: 128_000 },
        folder: 'harness-deck',
      },
      items: [
        { kind: 'user', id: 'u-app-1', text: '帮我清理旧构建产物并重新跑一次完整验证。' },
        {
          kind: 'assistant',
          id: 'a-app-1',
          streaming: false,
          markdown: '在执行清理与全量构建命令前，需要先得到你的确认：',
        },
      ],
      interactions: [
        {
          kind: 'approval',
          id: 'apr-preview-1',
          toolName: 'bash',
          reason: '命令请求在完全访问权限下清理并重建工作区产物',
          subject: 'rm -rf packages/*/dist && pnpm run build',
          subjectKind: 'command',
          previewable: false,
          dirtyFiles: [],
          allowAlways: '本会话始终允许此类命令',
        },
      ],
    },
    'session-preview-question': {
      header: {
        id: 'session-preview-question',
        title: '重构计划审阅：Mock Bridge',
        running: false,
        hasOlder: false,
        loadingOlder: false,
        sync: 'live',
        contextUsage: 0.19,
        contextTokens: { used: 24_300, window: 128_000 },
        folder: 'harness-deck',
        planMode: true,
      },
      items: [
        { kind: 'user', id: 'u-q-1', text: '/plan 为浏览器预览模式设计数据结构' },
      ],
      interactions: [
        {
          kind: 'question',
          id: 'q-preview-1',
          questions: [
            {
              id: 'preview-scope',
              header: '预览方案',
              question: '希望浏览器预览默认启动哪种数据模式？',
              detail: '### 预览启动计划\n\n1. 保留 `vite.config.ts` 原有构建入口，零侵入扩展产物。\n2. 通过 `index.html` 加载 `src/preview/main.tsx` 提供浏览器桥接。',
              multiSelect: false,
              options: [
                { label: '内置交互式 Mock（推荐）', description: '零外部依赖，立即可看全部 UI 效果与流式输出' },
                { label: '继续补充计划细节', description: '先讨论与真实后端的 WebSocket 联调方案' },
              ],
              intent: { kind: 'plan-review', approve: '内置交互式 Mock（推荐）', keepPlanning: '继续补充计划细节' },
            },
          ],
        },
      ],
    },
  };
}

export function createInitialSessionList(sessions: Readonly<Record<string, PreviewSessionData>>): SessionListItem[] {
  return Object.entries(sessions).map(([id, data], idx) => ({
    id,
    title: data.header.title,
    updatedAt: now - idx * 15 * min,
    running: data.header.running,
    needsAttention: data.interactions.length > 0,
  }));
}

export function createInitialWorkbench(): WorkbenchState {
  const agents: AgentProfile[] = [
    {
      id: 'builtin-builder',
      name: '全栈构建者',
      specialty: 'TypeScript / React UI 与 Node.js 扩展工程实现',
      instructions: '遵循项目组件库规范，优先复用 shadcn-ui 与 beautifului 原语，修改后验证 typecheck 与测试。',
      backendId: 'dsh',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      builtin: true,
      updatedAt: now - 2 * hour,
      tools: { permissionPreset: 'workspace-write', readSearch: true, editWrite: true, bashCommand: true, webFetch: false, mcpTools: true },
    },
    {
      id: 'builtin-reviewer',
      name: '代码审查员',
      specialty: '只读静态审查、边界条件与安全检查',
      instructions: '重点排查竞态、未处理异常与类型缩窄问题，输出可执行修改建议。',
      backendId: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      builtin: true,
      updatedAt: now - 5 * hour,
      tools: { permissionPreset: 'read-only', readSearch: true, editWrite: false, bashCommand: false, webFetch: false, mcpTools: false },
    },
  ];

  const schedules: ScheduleRule[] = [
    {
      id: 'sched-nightly',
      name: '每日构建与单测巡检',
      prompt: '运行 pnpm typecheck && pnpm lint && pnpm test，若有失败则总结原因。',
      frequency: { kind: 'daily', time: '09:30' },
      backendId: 'dsh',
      projectPath: PREVIEW_WORKSPACE_PATH,
      enabled: true,
      createdAt: now - 5 * 24 * hour,
      nextRunAt: now + 35 * min,
      lastRunAt: now - 18 * hour,
      lastStatus: 'succeeded',
      runs: [
        {
          id: 'run-1',
          ruleId: 'sched-nightly',
          startedAt: now - 18 * hour,
          endedAt: now - 18 * hour + 42_000,
          status: 'succeeded',
          backendId: 'dsh',
          projectPath: PREVIEW_WORKSPACE_PATH,
          output: 'typecheck、lint 与全部单元测试均已通过。',
        },
      ],
    },
  ];

  const tasks: KanbanTask[] = [
    {
      id: 'task-1',
      title: '补充浏览器预览快捷键与 Mock 演示',
      prompt: '在浏览器本地预览中支持主题切换、流式回复与审批交互演示。',
      status: 'review',
      projectPath: PREVIEW_WORKSPACE_PATH,
      projectName: 'harness-deck',
      backendId: 'dsh',
      agentId: 'builtin-builder',
      sessionId: 'session-preview-main',
      createdAt: now - 40 * min,
      startedAt: now - 25 * min,
      completedAt: now - 5 * min,
      summary: '已完成 index.html 与 mockHost.ts，可在浏览器直接交互预览。',
      unread: true,
    },
    {
      id: 'task-2',
      title: '核对 5 套配色方案在暗色模式下的对比度',
      prompt: '依次切换 slate / warm / forest / violet / rose 检查气泡和表格可读性。',
      status: 'todo',
      projectPath: PREVIEW_WORKSPACE_PATH,
      projectName: 'harness-deck',
      backendId: 'claude',
      agentId: 'builtin-reviewer',
      createdAt: now - 20 * min,
    },
    {
      id: 'task-3',
      title: '整理 v0.4.0 发布说明',
      prompt: '汇总最近提交中的功能变更与已知限制。',
      status: 'done',
      projectPath: PREVIEW_WORKSPACE_PATH,
      projectName: 'harness-deck',
      backendId: 'dsh',
      createdAt: now - 4 * hour,
      startedAt: now - 3.5 * hour,
      completedAt: now - 3 * hour,
      summary: '已更新 CHANGELOG.md 中的 v0.4.0 变更记录。',
    },
  ];

  return {
    agents,
    schedules,
    tasks: { items: tasks, autoRun: true },
    sessionGroups: [
      {
        projectPath: PREVIEW_WORKSPACE_PATH,
        projectName: 'harness-deck',
        isCurrent: true,
        sessions: [
          { id: 'session-preview-main', title: '浏览器本地预览模式调试', projectPath: PREVIEW_WORKSPACE_PATH, backendId: 'dsh', backendName: 'DeepSeek', updatedAt: now - 2 * min, running: false, model: 'DeepSeek Reasoner' },
          { id: 'session-preview-approval', title: '待确认：验证生产包构建与清理', projectPath: PREVIEW_WORKSPACE_PATH, backendId: 'dsh', backendName: 'DeepSeek', updatedAt: now - 15 * min, running: false, needsAttention: true, model: 'DeepSeek Chat' },
          { id: 'session-preview-question', title: '重构计划审阅：Mock Bridge', projectPath: PREVIEW_WORKSPACE_PATH, backendId: 'claude', backendName: 'Claude Code', updatedAt: now - 32 * min, running: false, needsAttention: true, model: 'Claude Sonnet 4' },
        ],
      },
    ],
    sourceControl: {
      available: true,
      root: PREVIEW_WORKSPACE_PATH,
      branch: 'feat/preview',
      remote: 'git@github.com:acme/harness-deck.git',
      files: [
        { path: 'packages/webview-ui/src/App.tsx', status: 'modified', staged: false, additions: 12, deletions: 3 },
        { path: 'packages/shared/src/viewModel.ts', status: 'modified', staged: true, additions: 30, deletions: 2 },
        { path: 'docs/PLAN.md', status: 'untracked', staged: false },
      ],
      additions: 42,
      deletions: 5,
      updatedAt: now,
    },
    overview: {
      waiting: [
        {
          id: 'w-1',
          kind: 'interaction',
          title: '待确认：验证生产包构建与清理',
          subtitle: 'bash: rm -rf packages/*/dist && pnpm run build',
          projectName: 'harness-deck',
          backendName: 'DeepSeek',
          sessionId: 'session-preview-approval',
          projectPath: PREVIEW_WORKSPACE_PATH,
          backendId: 'dsh',
        },
        {
          id: 'w-2',
          kind: 'task-review',
          title: '补充浏览器预览快捷键与 Mock 演示',
          subtitle: '已完成 index.html 与 mockHost.ts，等待验收',
          projectName: 'harness-deck',
          backendName: 'DeepSeek',
          taskId: 'task-1',
        },
      ],
      todos: [
        { id: 'todo-1', kind: 'agent-todo', content: '实现浏览器本地预览 Mock Host', status: 'in_progress', contextLabel: '浏览器本地预览模式调试', sessionId: 'session-preview-main', projectPath: PREVIEW_WORKSPACE_PATH, backendId: 'dsh' },
        { id: 'todo-2', kind: 'kanban-todo', content: '核对 5 套配色方案在暗色模式下的对比度', status: 'pending', contextLabel: 'harness-deck', taskId: 'task-2' },
      ],
      running: [],
      upcoming: [
        { id: 'up-1', kind: 'schedule', title: '每日构建与单测巡检', backendName: 'DeepSeek', projectName: 'harness-deck', nextRunAt: now + 35 * min, ruleId: 'sched-nightly' },
      ],
      unread: [
        { id: 'un-1', kind: 'task-review', title: '补充浏览器预览快捷键与 Mock 演示', summary: '已完成 index.html 与 mockHost.ts，可在浏览器直接交互预览。', timestamp: now - 5 * min, taskId: 'task-1' },
      ],
    },
  };
}

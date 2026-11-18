// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, HostToWebview } from '@harness-deck/shared';
import { App } from '../src/App.tsx';
import { SettingsPage } from '../src/components/SettingsPage.tsx';
import * as store from '../src/store.ts';

const posted: unknown[] = [];

function baseSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '0.2.2-alpha.3', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: '新对话', running: false }], active: 't1' },
    session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    preferences: {
      language: 'auto',
      includeActiveEditor: true,
      showTurnChanges: false,
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
      chatCommands: [],
    },
    projects: {
      currentPath: '/repo/demo',
      recent: [
        { path: '/repo/demo', name: 'demo', lastOpenedAt: 200, isCurrent: true },
        { path: '/repo/other', name: 'other', lastOpenedAt: 100 },
      ],
      configs: {
        '/repo/demo': {
          copyFiles: ['.env'],
          setupCommands: ['pnpm install'],
          verifyCommands: ['pnpm test'],
        },
      },
    },
    backends: {
      active: 'dsh',
      workspace: 'repo',
      nodeEnv: { checked: true, hasNode: true, hasNpm: true, nodeVersion: 'v22.22.2', npmVersion: '10.9.2' },
      items: [
        {
          id: 'dsh',
          name: 'DeepSeek',
          kind: 'dsh',
          builtin: true,
          available: true,
          version: '0.2.2-alpha.3',
          npmPackage: '@deepseek-ai/dsh',
          versions: ['0.2.2-alpha.3', '0.2.1-rc.5'],
        },
        {
          id: 'claude',
          name: 'Claude Code',
          kind: 'acp',
          builtin: true,
          command: 'claude-agent-acp',
          executable: 'claude-agent-acp',
          args: [],
          env: {},
          available: false,
          npmPackage: '@agentclientprotocol/claude-agent-acp',
          versions: ['0.10.0', '0.9.0'],
        },
        {
          id: 'opencode',
          name: 'OpenCode',
          kind: 'acp',
          builtin: true,
          command: 'opencode acp',
          executable: 'opencode',
          args: ['acp'],
          env: {},
          available: true,
          version: '1.2.0',
          npmPackage: 'opencode-ai',
          versions: ['1.2.0', '1.1.0'],
        },
        {
          id: 'zcode',
          name: 'ZCode',
          kind: 'zcode',
          builtin: true,
          available: true,
          version: '0.18.0',
          npmPackage: 'zcode-app-cli',
          versions: ['0.18.0', '0.17.0'],
        },
      ],
    },
    ...overrides,
  };
}

const host = (message: HostToWebview) => act(() => store.applyHostMessage(message));

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => (callback(0), 0)) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.colorScheme;
  document.documentElement.removeAttribute('style');
  store.resetStoreForTests();
  posted.length = 0;
});

describe('Sidebar Nav 设置页面与「会话 -> 聊天命令」', () => {
  it('左侧 Sidebar Nav 展示分组导航，默认打开「界面 -> 外观」并保留后台聊天输入框草稿，支持上下方向键切换页面', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: baseSnapshot() });

    // 输入草稿后打开设置再返回，草稿不丢失
    const textarea = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '未发送草稿', selectionStart: 5 } });

    fireEvent.click(screen.getByTestId('settings-button'));
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(screen.getByTestId('settings-tabs')).toBeTruthy();
    for (const groupId of ['interface', 'agent', 'extensions', 'sessionGroup', 'project', 'other']) {
      expect(screen.getByTestId(`sidebar-group-${groupId}`)).toBeTruthy();
    }
    expect(screen.getByTestId('settings-appearance')).toBeTruthy();
    expect(screen.queryByTestId('settings-notifications')).toBeNull();

    // 键盘方向键依次切换：外观 -> 通知 -> 外部智能体 -> 服务商 -> 技能 -> MCP -> 会话 -> 聊天命令 -> 项目 -> 运行时与诊断
    const tabs = screen.getByTestId('settings-tabs');
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-notifications')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-backends')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-providers')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-skills')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-mcp')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-preferences')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-chat-commands')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-projects')).toBeTruthy();
    fireEvent.keyDown(tabs, { key: 'ArrowDown' });
    expect(screen.getByTestId('settings-advanced')).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-back'));
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('未发送草稿');
  });

  it('界面 -> 外观：支持浅色/深色/跟随系统主题、5 套左浅右深整套配色，且切换主题与配色绝不改变阅读与聊天排版参数', () => {
    render(createElement(App));
    host({
      type: 'snapshot',
      payload: baseSnapshot({
        appearance: {
          fontFamily: 'Georgia, serif',
          fontSize: 17,
          lineHeight: 1.8,
          paragraphSpacing: 14,
          contentWidth: 920,
        },
      }),
    });
    fireEvent.click(screen.getByTestId('settings-button'));

    // 校验 5 套配色色卡均存在，且每张色卡包含左浅右深结构
    for (const schemeId of ['slate', 'warm', 'forest', 'violet', 'rose'] as const) {
      const card = screen.getByTestId(`palette-card-${schemeId}`);
      expect(card.querySelector('[data-half="light"]')).toBeTruthy();
      expect(card.querySelector('[data-half="dark"]')).toBeTruthy();
    }

    // 切换整套配色与主题
    fireEvent.click(screen.getByTestId('palette-card-warm'));
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { colorScheme: 'warm' } });
    expect(document.documentElement.dataset.colorScheme).toBe('warm');

    fireEvent.click(screen.getByTestId('theme-card-dark'));
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { theme: 'dark' } });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    fireEvent.click(screen.getByTestId('theme-card-light'));
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { theme: 'light' } });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    fireEvent.click(screen.getByTestId('theme-card-system'));
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { theme: 'system' } });

    // 验证阅读与聊天的字体、字号、行高、段距与内容宽度在主题/配色切换后纹丝未动
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--prose-font-family')).toBe('Georgia, serif');
    expect(style.getPropertyValue('--prose-font-size')).toBe('17px');
    expect(style.getPropertyValue('--prose-line-height')).toBe('1.8');
    expect(style.getPropertyValue('--prose-paragraph-spacing')).toBe('14px');
    expect(style.getPropertyValue('--content-width')).toBe('920px');
  });

  it('界面 -> 外观 -> 终端与语言，以及系统通知开关均可正常配置', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: baseSnapshot() });
    fireEvent.click(screen.getByTestId('settings-button'));

    // 终端配置
    const termFont = screen.getByTestId('terminal-font-family');
    fireEvent.change(termFont, { target: { value: 'JetBrains Mono' } });
    fireEvent.keyDown(termFont, { key: 'Enter' });
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { codeFontFamily: 'JetBrains Mono' } });
    expect(document.documentElement.style.getPropertyValue('--hd-code-font-family')).toBe('JetBrains Mono');

    fireEvent.click(screen.getByRole('button', { name: '增大终端字号' }));
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { terminalFontSize: 13 } });
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('13px');

    // 语言配置（位于外观 -> 语言模块）
    fireEvent.change(screen.getByTestId('pref-language'), { target: { value: 'en' } });
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { language: 'en' } });

    // 通知配置（界面 -> 通知）
    fireEvent.click(screen.getByTestId('settings-tab-notifications'));
    expect(screen.getByTestId('settings-notifications')).toBeTruthy();
    fireEvent.click(screen.getByTestId('notif-turn-complete'));
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { notifications: { onTurnComplete: false } } });
    fireEvent.click(screen.getByTestId('notif-test-btn'));
    expect(posted).toContainEqual({ type: 'testNotification', payload: {} });
  });

  it('支持面板内 Markdown 文件预览，与聊天回复及计划审阅共用排版变量', () => {
    render(createElement(App));
    host({
      type: 'snapshot',
      payload: baseSnapshot({
        appearance: { fontSize: 18, lineHeight: 1.9, contentWidth: 900 },
        items: [{ kind: 'assistant', id: 'a1', markdown: '请阅读 `docs/DESIGN.md` 了解整体架构。', streaming: false }],
      }),
    });

    fireEvent.click(screen.getByTestId('preview-md-docs/DESIGN.md'));
    expect(posted).toContainEqual({ type: 'previewMarkdown', payload: { path: 'docs/DESIGN.md' } });
    expect(screen.getByTestId('markdown-preview-modal')).toBeTruthy();

    host({
      type: 'markdownPreview',
      payload: { path: 'docs/DESIGN.md', title: 'DESIGN.md', content: '# 架构方案\n\n正文段落。' },
    });
    expect(screen.getByTestId('markdown-preview-modal').textContent).toContain('架构方案');

    fireEvent.click(screen.getByTestId('markdown-preview-open-editor'));
    expect(posted).toContainEqual({ type: 'openFile', payload: { path: 'docs/DESIGN.md' } });

    fireEvent.click(screen.getByTestId('markdown-preview-close'));
    expect(screen.queryByTestId('markdown-preview-modal')).toBeNull();
  });

  it('Agent Tab 支持 npm 环境检测、安装卸载、外部智能体增删改及高级诊断设置', () => {
    const snap = baseSnapshot();
    host({
      type: 'snapshot',
      payload: {
        ...snap,
        backends: {
          ...snap.backends,
          nodeEnv: { checked: true, hasNode: false, hasNpm: false },
        },
      },
    });
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByTestId('settings-tab-agents'));

    expect(screen.getByTestId('node-env-missing')).toBeTruthy();
    expect((screen.getByTestId('install-backend-claude') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('uninstall-backend-dsh') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('install-node-btn'));
    expect(posted).toContainEqual({ type: 'openExternal', payload: { url: 'https://nodejs.org/' } });

    // 已缓存检测结果（nodeEnv.checked = true）时进入外部智能体页不重复触发 checkBackendEnv，点击重新检测才触发
    posted.length = 0;
    host({ type: 'snapshot', payload: baseSnapshot() });
    expect(posted.some((m) => (m as { type: string }).type === 'checkBackendEnv')).toBe(false);
    fireEvent.click(screen.getByTestId('settings-refresh-env'));
    expect(posted).toContainEqual({ type: 'checkBackendEnv', payload: {} });

    fireEvent.change(screen.getByTestId('version-select-claude'), { target: { value: '0.10.0' } });
    fireEvent.click(screen.getByTestId('install-backend-claude'));
    expect(posted).toContainEqual({ type: 'installBackend', payload: { id: 'claude', version: '0.10.0' } });

    const switchBtn = screen.getByTestId('switch-version-dsh') as HTMLButtonElement;
    expect(switchBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('version-select-dsh'), { target: { value: '0.2.1-rc.5' } });
    expect(switchBtn.disabled).toBe(false);
    fireEvent.click(switchBtn);
    expect(posted).toContainEqual({ type: 'installBackend', payload: { id: 'dsh', version: '0.2.1-rc.5' } });

    // 通过 Modal 弹窗新建与编辑外部智能体（支持 Escape / 遮罩关闭）
    fireEvent.click(screen.getByTestId('agent-add-btn'));
    const addAgentDialog = screen.getByTestId('agent-form');
    expect(addAgentDialog.getAttribute('role')).toBe('dialog');
    expect(addAgentDialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-form')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-add-btn'));
    fireEvent.change(screen.getByTestId('agent-form-name'), { target: { value: 'Gemini CLI' } });
    fireEvent.change(screen.getByTestId('agent-form-command'), { target: { value: 'gemini' } });
    fireEvent.change(screen.getByTestId('agent-form-args'), { target: { value: '--acp --fast' } });
    fireEvent.change(screen.getByTestId('agent-form-env'), { target: { value: 'KEY=123' } });
    fireEvent.click(screen.getByTestId('agent-form-save'));
    expect(screen.queryByTestId('agent-form')).toBeNull();

    expect(posted).toContainEqual({
      type: 'upsertBackendProfile',
      payload: {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        command: 'gemini',
        args: ['--acp', '--fast'],
        env: { KEY: '123' },
      },
    });

    fireEvent.click(screen.getByTestId('edit-backend-claude'));
    const editAgentDialog = screen.getByTestId('agent-form');
    expect(editAgentDialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(editAgentDialog.querySelector('[data-slot="dialog-close"]') as HTMLElement);
    expect(screen.queryByTestId('agent-form')).toBeNull();

    // 运行时与诊断位于「其他」分组
    fireEvent.click(screen.getByTestId('settings-tab-other'));
    fireEvent.change(screen.getByTestId('adv-zcode-path'), { target: { value: '/opt/ZCode/resources/glm/zcode.cjs' } });
    fireEvent.blur(screen.getByTestId('adv-zcode-path'));
    expect(posted).toContainEqual({
      type: 'setPreferences',
      payload: { advanced: { zcodePath: '/opt/ZCode/resources/glm/zcode.cjs' } },
    });
    fireEvent.click(screen.getByTestId('adv-backend-trace'));
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { advanced: { backendTrace: true } } });
    fireEvent.click(screen.getByTestId('open-vscode-settings'));
    expect(posted).toContainEqual({ type: 'openSettings', payload: {} });
  });

  it('会话 -> 会话支持交互与上下文开关配置', () => {
    host({ type: 'snapshot', payload: baseSnapshot() });
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByTestId('settings-tab-session'));

    expect(screen.getByTestId('settings-preferences')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pref-include-active'));
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { includeActiveEditor: false } });
    fireEvent.click(screen.getByTestId('pref-show-turn-changes'));
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { showTurnChanges: true } });
  });

  it('会话 -> 聊天命令：存好的提示词可在输入框输入 / 选用并填入后修改再发送，且所有 Agent 通用', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: baseSnapshot() });

    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-commands'));
    expect(screen.getByTestId('chat-commands-empty')).toBeTruthy();

    // 添加聊天命令使用 Dialog 弹窗（带前导 / 时自动清理，支持关闭按钮关闭）
    fireEvent.click(screen.getByTestId('chat-command-add-btn'));
    const addCmdDialog = screen.getByTestId('chat-command-form');
    expect(addCmdDialog.getAttribute('role')).toBe('dialog');
    expect(addCmdDialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(addCmdDialog.querySelector('[data-slot="dialog-close"]') as HTMLElement);
    expect(screen.queryByTestId('chat-command-form')).toBeNull();

    fireEvent.click(screen.getByTestId('chat-command-add-btn'));
    fireEvent.change(screen.getByTestId('chat-command-form-name'), { target: { value: '/review' } });
    fireEvent.change(screen.getByTestId('chat-command-form-desc'), { target: { value: '审查当前改动' } });
    fireEvent.change(screen.getByTestId('chat-command-form-prompt'), { target: { value: '请仔细审查以下代码改动：' } });
    fireEvent.click(screen.getByTestId('chat-command-form-save'));
    expect(screen.queryByTestId('chat-command-form')).toBeNull();

    expect(posted).toContainEqual({
      type: 'setPreferences',
      payload: {
        chatCommands: [
          { name: 'review', description: '审查当前改动', prompt: '请仔细审查以下代码改动：' },
        ],
      },
    });
    expect(screen.getByTestId('chat-command-item-review')).toBeTruthy();

    // 返回对话并在输入框输入 / 选用
    fireEvent.click(screen.getByTestId('settings-back'));
    const textarea = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });
    const completion = screen.getByTestId('completion');
    expect(completion.textContent).toContain('/review');
    expect(completion.textContent).toContain('审查当前改动');
    expect(completion.textContent).toContain('提示词');

    // 输入完整命令名时补全框仍保持可选，Enter 填入提示词而非直接发送
    fireEvent.change(textarea, { target: { value: '/review', selectionStart: 7 } });
    expect(screen.getByTestId('completion').textContent).toContain('/review');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('请仔细审查以下代码改动：');
    expect(posted.some((m) => (m as { type: string }).type === 'sendMessage')).toBe(false);

    // 填入后可继续修改再发
    fireEvent.change(textarea, { target: { value: '请仔细审查以下代码改动：重点关注并发安全', selectionStart: 20 } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(posted).toContainEqual({
      type: 'sendMessage',
      payload: { text: '请仔细审查以下代码改动：重点关注并发安全', includeActive: true },
    });

    // 切换到其他 Agent（如 Claude Code）后同样通用可选
    host({
      type: 'backends',
      payload: {
        ...baseSnapshot().backends,
        active: 'claude',
      },
    });
    fireEvent.change(textarea, { target: { value: '/rev', selectionStart: 4 } });
    expect(screen.getByTestId('completion').textContent).toContain('/review');

    // 回到设置页测试「填入输入框」、编辑和删除命令
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-commands'));
    fireEvent.click(screen.getByTestId('edit-chat-command-review'));
    fireEvent.change(screen.getByTestId('chat-command-form-prompt'), { target: { value: '更新后的审查提示词：' } });
    fireEvent.click(screen.getByTestId('chat-command-form-save'));
    expect(posted).toContainEqual({
      type: 'setPreferences',
      payload: {
        chatCommands: [
          { name: 'review', description: '审查当前改动', prompt: '更新后的审查提示词：' },
        ],
      },
    });

    fireEvent.click(screen.getByTestId('use-chat-command-review'));
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('更新后的审查提示词：');

    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-commands'));
    fireEvent.click(screen.getByTestId('delete-chat-command-review'));
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { chatCommands: [] } });
    expect(screen.getByTestId('chat-commands-empty')).toBeTruthy();
  });

  it('项目 Tab 支持查看最近项目并配置 Worktree 复制文件、准备和验收命令', () => {
    host({ type: 'snapshot', payload: baseSnapshot() });
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByTestId('settings-tab-projects'));

    expect(screen.getByTestId('settings-projects')).toBeTruthy();
    expect(screen.getByTestId('recent-project-0').textContent).toContain('demo');
    expect((screen.getByTestId('project-copy-files') as HTMLTextAreaElement).value).toBe('.env');

    fireEvent.change(screen.getByTestId('project-copy-files'), { target: { value: '.env\n.env.local' } });
    fireEvent.change(screen.getByTestId('project-setup-commands'), { target: { value: 'pnpm install' } });
    fireEvent.change(screen.getByTestId('project-verify-commands'), { target: { value: 'pnpm typecheck\npnpm test' } });
    fireEvent.click(screen.getByTestId('project-save-btn'));

    expect(posted).toContainEqual({
      type: 'setProjectWorktreeConfig',
      payload: {
        path: '/repo/demo',
        copyFiles: ['.env', '.env.local'],
        setupCommands: ['pnpm install'],
        verifyCommands: ['pnpm typecheck', 'pnpm test'],
      },
    });

    fireEvent.click(screen.getByTestId('project-create-wt-btn'));
    expect(posted).toContainEqual({ type: 'createWorktree', payload: { path: '/repo/demo' } });

    fireEvent.click(screen.getByTestId('project-run-verify-btn'));
    expect(posted).toContainEqual({ type: 'runProjectVerify', payload: { path: '/repo/demo' } });
  });

  it('Agent -> 服务商：支持火山方舟、智谱 GLM 与自定义编程套餐预设、模型批量粘贴与接口拉取、以及绑定到对应智能体', () => {
    const snap = baseSnapshot({
      backends: {
        ...baseSnapshot().backends,
        items: [
          ...baseSnapshot().backends.items,
          {
            id: 'cursor-cli',
            name: 'Cursor',
            kind: 'acp',
            custom: true,
            command: 'cursor',
            executable: 'cursor',
          },
        ],
      },
      workbench: {
        overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
        schedules: [],
        agents: [
          {
            id: 'builtin-reviewer',
            name: '代码审查官',
            specialty: '严格代码审查',
            instructions: '',
            backendId: 'claude',
            builtin: true,
            updatedAt: 100,
            tools: {
              permissionPreset: 'read-only',
              readSearch: true,
              editWrite: false,
              bashCommand: false,
              webFetch: false,
              mcpTools: false,
            },
          },
        ],
        tasks: { items: [], autoRun: true },
        sessionGroups: [],
      },
    });
    host({ type: 'snapshot', payload: snap });
    render(createElement(SettingsPage));
    fireEvent.click(screen.getByTestId('settings-tab-providers'));

    // 默认状态下本地协议转换网关关闭；仅填 OpenAI Chat 地址时不可绑定 Claude Code，开启网关后方可绑定
    const gwSwitch = screen.getByTestId('provider-protocol-gateway-switch');
    expect(gwSwitch.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('provider-protocol-gateway-card').textContent).toContain('已关闭');

    fireEvent.change(screen.getByTestId('provider-url-openai-chat'), {
      target: { value: 'https://api.example.com/v1' },
    });
    expect((screen.getByTestId('provider-bind-backend-claude') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(gwSwitch);
    expect(posted).toContainEqual({ type: 'setProtocolGateway', payload: { enabled: true } });
    expect(gwSwitch.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('provider-bind-backend-claude') as HTMLButtonElement).disabled).toBe(false);

    // 清空回初始状态以便继续校验自定义预设缺地址提示
    fireEvent.click(gwSwitch);
    expect(posted).toContainEqual({ type: 'setProtocolGateway', payload: { enabled: false } });
    fireEvent.change(screen.getByTestId('provider-url-openai-chat'), { target: { value: '' } });

    // 默认「自定义」下未填地址时展示缺地址提示与自有账号智能体提示
    const hintText = screen.getByTestId('provider-compatibility-hint').textContent ?? '';
    expect(hintText).toContain('还缺地址：');
    expect(hintText).toContain('Claude Code（Anthropic 协议地址）');
    expect(hintText).toContain('Cursor 用不了这个服务商的接口，只能用自己的账号。');

    // 选择「火山方舟」预设，自动填入 Coding Plan 接口地址与模型
    fireEvent.click(screen.getByTestId('provider-preset-volcengine-coding'));
    expect((screen.getByTestId('provider-form-name') as HTMLInputElement).value).toBe('火山方舟');
    expect((screen.getByTestId('provider-url-anthropic') as HTMLInputElement).value).toBe(
      'https://ark.cn-beijing.volces.com/api/coding',
    );
    expect((screen.getByTestId('provider-model-id-0') as HTMLInputElement).value).toBe('ark-code-latest');

    // 测试批量粘贴新模型与从接口获取模型
    fireEvent.click(screen.getByTestId('provider-batch-toggle'));
    fireEvent.change(screen.getByTestId('provider-batch-input'), {
      target: { value: 'ep-custom-ark-model, deepseek-v3.2' },
    });
    fireEvent.click(screen.getByTestId('provider-batch-confirm'));
    expect((screen.getByTestId('provider-model-id-5') as HTMLInputElement).value).toBe('ep-custom-ark-model');

    fireEvent.change(screen.getByTestId('provider-form-apikey'), { target: { value: 'ark-secret-key' } });
    fireEvent.click(screen.getByTestId('provider-fetch-models'));
    const fetchMsg = posted.find((m) => (m as { type: string }).type === 'fetchProviderModels') as {
      payload: { requestId: number };
    };
    expect(fetchMsg).toBeTruthy();
    host({
      type: 'providerModelsFetched',
      payload: {
        requestId: fetchMsg.payload.requestId,
        models: [{ id: 'doubao-seed-pro-remote', name: 'Doubao Remote', contextWindow: '256k' }],
      },
    });
    expect((screen.getByTestId('provider-model-id-6') as HTMLInputElement).value).toBe('doubao-seed-pro-remote');

    // 勾选绑定到 Claude Code、DeepSeek 与工作台「代码审查官」智能体并保存
    fireEvent.click(screen.getByTestId('provider-bind-backend-claude'));
    fireEvent.click(screen.getByTestId('provider-bind-backend-dsh'));
    fireEvent.click(screen.getByTestId('provider-bind-wb-agent-builtin-reviewer'));
    fireEvent.click(screen.getByTestId('provider-save-btn'));

    const savedMsg = posted.find((m) => (m as { type: string }).type === 'upsertProvider') as {
      payload: {
        name: string;
        presetId: string;
        apiKey: string;
        boundBackendIds: string[];
        boundAgentIds: string[];
        defaultModel: string;
      };
    };
    expect(savedMsg.payload).toMatchObject({
      name: '火山方舟',
      presetId: 'volcengine-coding',
      apiKey: 'ark-secret-key',
      defaultModel: 'ark-code-latest',
      boundBackendIds: ['claude', 'dsh'],
      boundAgentIds: ['builtin-reviewer'],
    });

    // Host 推送已保存的服务商后，列表展示已存 Key 与绑定的智能体，且「外部智能体」页展示服务商徽章并可点击跳转
    host({
      type: 'providers',
      payload: {
        protocolGatewayEnabled: true,
        protocolGatewayOrigin: 'http://127.0.0.1:43123',
        items: [
          {
            id: 'volcengine',
            name: '火山方舟',
            presetId: 'volcengine-coding',
            hasApiKey: true,
            anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding',
            openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
            models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
            defaultModel: 'ark-code-latest',
            boundBackendIds: ['claude', 'dsh'],
            boundAgentIds: ['builtin-reviewer'],
          },
          {
            id: 'openai-gw',
            name: 'OpenAI Only Gateway',
            hasApiKey: true,
            openaiChatUrl: 'https://api.openai-compat.example/v1',
            models: [{ id: 'gpt-4.1' }],
            defaultModel: 'gpt-4.1',
            boundBackendIds: [],
          },
        ],
      },
    });
    expect(screen.getByTestId('provider-protocol-gateway-card').textContent).toContain('已启动 · http://127.0.0.1:43123');
    expect(screen.getByTestId('provider-card-volcengine').textContent).toContain('已存 Key');
    expect(screen.getByTestId('provider-card-volcengine').textContent).toContain('Claude Code');
    expect(screen.getByTestId('provider-card-volcengine').textContent).toContain('代码审查官');
    expect(screen.getByTestId('provider-card-openai-gw').textContent).toContain('OpenAI → Claude');

    // 点击「网关日志」入口按钮打开日志弹窗，查看空状态、日志渲染、清空日志与打开输出面板
    fireEvent.click(screen.getByTestId('provider-gateway-logs-btn'));
    expect(screen.getByTestId('provider-gateway-logs-dialog')).toBeTruthy();
    expect(screen.getByTestId('provider-gateway-logs-empty')).toBeTruthy();

    host({
      type: 'providers',
      payload: {
        ...store.getState().providers,
        gatewayLogs: [
          {
            id: 'log-1',
            timestamp: Date.now(),
            level: 'error',
            providerId: 'openai-gw',
            providerName: 'OpenAI Only Gateway',
            protocol: 'anthropic',
            converted: true,
            method: 'POST',
            path: '/v1/messages',
            targetUrl: 'https://api.openai-compat.example/v1/chat/completions',
            requestModel: 'claude-sonnet-4-5',
            mappedModel: 'gpt-4.1',
            status: 400,
            durationMs: 120,
            message: 'Model not supported',
          },
        ],
      },
    });
    const logItem = screen.getByTestId('provider-gateway-log-log-1');
    expect(logItem.textContent).toContain('HTTP 400');
    expect(logItem.textContent).toContain('claude-sonnet-4-5 → gpt-4.1');
    expect(logItem.textContent).toContain('Model not supported');

    fireEvent.click(screen.getByTestId('provider-gateway-clear-logs-btn'));
    expect(posted).toContainEqual({ type: 'clearProtocolGatewayLogs', payload: {} });

    fireEvent.click(screen.getByTestId('provider-gateway-open-output-btn'));
    expect(posted).toContainEqual({ type: 'showLogs', payload: {} });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('provider-gateway-logs-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-tab-agents'));
    const boundBadge = screen.getByTestId('backend-bound-provider-claude');
    expect(boundBadge.textContent).toContain('服务商：火山方舟');
    fireEvent.click(boundBadge);
    expect(screen.getByTestId('settings-providers')).toBeTruthy();
  });

  it('扩展 -> 技能：支持从 Git 仓库扫描与安装 SKILL.md、预览文档、同步更新、按 Agent 限定及卸载', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: baseSnapshot() });
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-skills'));

    expect(screen.getByTestId('settings-skills')).toBeTruthy();
    expect(screen.getByTestId('skills-empty')).toBeTruthy();

    // 打开从 Git 安装弹窗并扫描仓库
    fireEvent.click(screen.getByTestId('skill-install-btn'));
    expect(screen.getByTestId('skill-install-dialog')).toBeTruthy();
    fireEvent.change(screen.getByTestId('skill-repo-url'), { target: { value: 'anthropics/skills' } });
    fireEvent.change(screen.getByTestId('skill-repo-ref'), { target: { value: 'main' } });
    fireEvent.click(screen.getByTestId('skill-scan-btn'));
    expect(posted).toContainEqual({
      type: 'scanGitSkills',
      payload: { repoUrl: 'anthropics/skills', ref: 'main' },
    });

    // Host 返回扫描到的技能列表
    host({
      type: 'extensions',
      payload: {
        skills: {
          items: [],
          scanned: {
            repoUrl: 'https://github.com/anthropics/skills.git',
            ref: 'main',
            skills: [
              {
                name: 'frontend-design',
                description: 'Create distinctive frontend UIs',
                subpath: 'skills/frontend-design',
              },
              {
                name: 'mcp-builder',
                description: 'Build MCP servers cleanly',
                subpath: 'skills/mcp-builder',
              },
            ],
          },
        },
        mcp: { servers: [] },
      },
    });
    expect(screen.getByTestId('skill-discovered-list')).toBeTruthy();

    // 限定只带给 DeepSeek 并点击安装
    fireEvent.click(screen.getByTestId('skill-install-agent-dsh'));
    fireEvent.click(screen.getByTestId('skill-install-submit'));
    expect(posted).toContainEqual({
      type: 'installGitSkills',
      payload: {
        repoUrl: 'anthropics/skills',
        ref: 'main',
        selectedSubpaths: ['skills/frontend-design', 'skills/mcp-builder'],
        agents: ['dsh'],
      },
    });

    // Host 推送安装中 -> 安装完成，弹窗自动关闭并展示已安装卡片
    host({
      type: 'extensions',
      payload: {
        skills: { items: [], installing: true },
        mcp: { servers: [] },
      },
    });
    host({
      type: 'extensions',
      payload: {
        skills: {
          installing: false,
          items: [
            {
              id: 'frontend-design',
              name: 'frontend-design',
              description: 'Create distinctive frontend UIs',
              repoUrl: 'https://github.com/anthropics/skills.git',
              ref: 'main',
              subpath: 'skills/frontend-design',
              commit: 'a1b2c3d',
              skillMdPath: '/storage/skills/installed/frontend-design/SKILL.md',
              enabled: true,
              agents: ['dsh'],
              installedAt: 1000,
              updatedAt: 1000,
            },
          ],
        },
        mcp: { servers: [] },
      },
    });
    expect(screen.queryByTestId('skill-install-dialog')).toBeNull();
    expect(screen.getByTestId('skill-item-frontend-design').textContent).toContain('/frontend-design');

    // 在设置内点击「预览 SKILL.md」直接弹出 Markdown 预览，关闭后回到设置技能页
    fireEvent.click(screen.getByTestId('preview-skill-frontend-design'));
    expect(posted).toContainEqual({
      type: 'previewMarkdown',
      payload: { path: '/storage/skills/installed/frontend-design/SKILL.md' },
    });
    host({
      type: 'markdownPreview',
      payload: {
        path: '/storage/skills/installed/frontend-design/SKILL.md',
        title: 'SKILL.md',
        content: '# Frontend Design Skill',
      },
    });
    expect(screen.getByTestId('markdown-preview-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('markdown-preview-close'));
    expect(screen.getByTestId('settings-skills')).toBeTruthy();

    // 切换为全部 Agent 通用、同步更新、停用与卸载
    fireEvent.click(screen.getByTestId('skill-agent-all-frontend-design'));
    expect(posted).toContainEqual({
      type: 'updateSkill',
      payload: { id: 'frontend-design', agents: null },
    });

    fireEvent.click(screen.getByTestId('sync-skill-frontend-design'));
    expect(posted).toContainEqual({ type: 'syncSkill', payload: { id: 'frontend-design' } });

    fireEvent.click(screen.getByTestId('toggle-skill-frontend-design'));
    expect(posted).toContainEqual({
      type: 'updateSkill',
      payload: { id: 'frontend-design', enabled: false },
    });

    fireEvent.click(screen.getByTestId('delete-skill-frontend-design'));
    expect(posted).toContainEqual({ type: 'deleteSkill', payload: { id: 'frontend-design' } });
  });

  it('扩展 -> MCP：支持统一添加服务器、JSON 快捷填入、按 Agent 分配以及从各 Agent 配置导入', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: baseSnapshot() });
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByTestId('settings-tab-mcp'));

    expect(screen.getByTestId('settings-mcp')).toBeTruthy();
    expect(screen.getByTestId('mcp-empty')).toBeTruthy();

    // 1. 添加 MCP 服务器并测试 JSON 粘贴解析
    fireEvent.click(screen.getByTestId('mcp-add-btn'));
    expect(screen.getByTestId('mcp-form-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mcp-paste-json-toggle'));
    fireEvent.change(screen.getByTestId('mcp-paste-json-input'), {
      target: {
        value: JSON.stringify({
          mcpServers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'],
              env: { LOG_LEVEL: 'info' },
            },
          },
        }),
      },
    });
    fireEvent.click(screen.getByTestId('mcp-paste-json-apply'));
    expect((screen.getByTestId('mcp-form-name') as HTMLInputElement).value).toBe('filesystem');
    expect((screen.getByTestId('mcp-form-command') as HTMLInputElement).value).toBe('npx');

    // 取消勾选 zcode，保留 dsh / claude / opencode
    fireEvent.click(screen.getByTestId('mcp-form-agent-zcode'));
    fireEvent.click(screen.getByTestId('mcp-form-save'));

    expect(posted).toContainEqual({
      type: 'upsertMcpServer',
      payload: {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'],
        env: { LOG_LEVEL: 'info' },
        enabled: true,
        agents: ['dsh', 'claude', 'opencode'],
      },
    });
    expect(screen.getByTestId('mcp-server-filesystem')).toBeTruthy();

    // 2. 在卡片上直接点击 Agent 芯片切换启动时交给哪些 Agent
    fireEvent.click(screen.getByTestId('mcp-agent-filesystem-zcode'));
    expect(posted).toContainEqual({
      type: 'toggleMcpServer',
      payload: { id: 'filesystem', agents: ['dsh', 'claude', 'opencode', 'zcode'] },
    });

    // 3. 从各 Agent 配置文件扫描并导入 MCP 服务器
    fireEvent.click(screen.getByTestId('mcp-import-btn'));
    expect(screen.getByTestId('mcp-import-dialog')).toBeTruthy();
    expect(posted).toContainEqual({ type: 'scanAgentMcpConfigs', payload: {} });

    host({
      type: 'extensions',
      payload: {
        skills: { items: [] },
        mcp: {
          servers: store.getState().extensions.mcp.servers,
          scannedSources: ['/home/user/.claude.json', '/home/user/.dsh/cordis.patch.yml'],
          importCandidates: [
            {
              key: 'claude:/home/user/.claude.json:context7',
              name: 'context7',
              transport: 'http',
              url: 'https://mcp.context7.com/mcp',
              sourceAgentId: 'claude',
              sourceAgentName: 'Claude Code',
              sourcePath: '/home/user/.claude.json',
            },
            {
              key: 'dsh:/home/user/.dsh/cordis.patch.yml:filesystem',
              name: 'filesystem',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem'],
              sourceAgentId: 'dsh',
              sourceAgentName: 'DeepSeek',
              sourcePath: '/home/user/.dsh/cordis.patch.yml',
              conflict: true,
            },
          ],
        },
      },
    });

    // 无冲突的 context7 默认自动勾选，已存在的 filesystem 默认不勾选避免误覆盖
    expect(screen.getByTestId('mcp-candidate-check-context7').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('mcp-candidate-check-filesystem').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('mcp-import-submit'));
    expect(posted).toContainEqual({
      type: 'importMcpServers',
      payload: {
        servers: [
          {
            name: 'context7',
            transport: 'http',
            url: 'https://mcp.context7.com/mcp',
            importedFrom: 'Claude Code',
          },
        ],
        agents: ['dsh', 'claude', 'opencode', 'zcode'],
      },
    });

    // 删除服务器
    fireEvent.click(screen.getByTestId('delete-mcp-filesystem'));
    expect(posted).toContainEqual({ type: 'deleteMcpServer', payload: { id: 'filesystem' } });
  });
});

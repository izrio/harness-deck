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
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.colorScheme;
  document.documentElement.removeAttribute('style');
  store.resetStoreForTests();
  posted.length = 0;
});

describe('多 Tab 设置页面（界面 / Agent / 项目）', () => {
  it('默认打开「界面」Tab 并保留后台聊天输入框草稿，支持左右方向键切换多个 Tab', () => {
    render(createElement(App));
    host({ type: 'snapshot', payload: baseSnapshot() });

    // 输入草稿后打开设置再返回，草稿不丢失
    const textarea = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '未发送草稿', selectionStart: 5 } });

    fireEvent.click(screen.getByTestId('settings-button'));
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(screen.getByTestId('settings-tabs')).toBeTruthy();
    expect(screen.getByTestId('settings-appearance')).toBeTruthy();

    // 键盘方向键在 界面 -> Agent -> 项目 之间切换
    fireEvent.keyDown(screen.getByTestId('settings-tabs'), { key: 'ArrowRight' });
    expect(screen.getByTestId('settings-backends')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('settings-tabs'), { key: 'ArrowRight' });
    expect(screen.getByTestId('settings-projects')).toBeTruthy();

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

    // 通知配置
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

    host({ type: 'snapshot', payload: baseSnapshot() });

    fireEvent.change(screen.getByTestId('version-select-claude'), { target: { value: '0.10.0' } });
    fireEvent.click(screen.getByTestId('install-backend-claude'));
    expect(posted).toContainEqual({ type: 'installBackend', payload: { id: 'claude', version: '0.10.0' } });

    const switchBtn = screen.getByTestId('switch-version-dsh') as HTMLButtonElement;
    expect(switchBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('version-select-dsh'), { target: { value: '0.2.1-rc.5' } });
    expect(switchBtn.disabled).toBe(false);
    fireEvent.click(switchBtn);
    expect(posted).toContainEqual({ type: 'installBackend', payload: { id: 'dsh', version: '0.2.1-rc.5' } });

    fireEvent.click(screen.getByTestId('agent-add-btn'));
    fireEvent.change(screen.getByTestId('agent-form-name'), { target: { value: 'Gemini CLI' } });
    fireEvent.change(screen.getByTestId('agent-form-command'), { target: { value: 'gemini' } });
    fireEvent.change(screen.getByTestId('agent-form-args'), { target: { value: '--acp --fast' } });
    fireEvent.change(screen.getByTestId('agent-form-env'), { target: { value: 'KEY=123' } });
    fireEvent.click(screen.getByTestId('agent-form-save'));

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

    // 运行时与诊断同属 Agent Tab
    fireEvent.click(screen.getByTestId('adv-backend-trace'));
    expect(posted).toContainEqual({ type: 'setPreferences', payload: { advanced: { backendTrace: true } } });
    fireEvent.click(screen.getByTestId('open-vscode-settings'));
    expect(posted).toContainEqual({ type: 'openSettings', payload: {} });
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
});

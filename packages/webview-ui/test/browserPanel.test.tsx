// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { HostSnapshot, HostToWebview } from '@harness-deck/shared';
import { App } from '../src/App.tsx';
import * as store from '../src/store.ts';

const posted: unknown[] = [];

function baseSnapshot(): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '0.2.2', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [], active: '' },
    session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: ['workspace-write'] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: {
      active: 'dsh',
      workspace: 'harness-deck',
      items: [{ id: 'dsh', name: 'DeepSeek', kind: 'dsh', builtin: true, available: true }],
    },
    browser: {
      status: 'stopped',
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      viewportWidth: 1024,
      viewportHeight: 720,
      viewportPreset: 'responsive',
      aiEnabled: true,
      mcpUrl: 'http://127.0.0.1:41234/mcp',
      detectedExecutable: '/usr/bin/google-chrome',
      consoleLogs: [],
    },
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
  store.resetStoreForTests();
  posted.length = 0;
});

describe('右侧面板拖动调宽与内置浏览器标签页（AI MCP 协同）', () => {
  it('桌面端支持拖动右侧面板左边缘调整宽度，双击恢复默认宽度', () => {
    host({ type: 'snapshot', payload: baseSnapshot() });
    render(createElement(App));

    fireEvent.click(screen.getByTestId('toggle-right-panel'));
    const panel = screen.getByTestId('workbench-right-panel');
    expect(panel.style.width).toBe('360px');

    const handle = screen.getByTestId('right-panel-resize-handle');
    fireEvent.mouseDown(handle, { clientX: 800, button: 0 });
    fireEvent.mouseMove(window, { clientX: 620 });
    expect(panel.style.width).toBe('540px');

    fireEvent.mouseUp(window, { clientX: 620 });
    expect(store.getState().rightPanelWidth).toBe(540);
    expect(panel.style.width).toBe('540px');

    fireEvent.doubleClick(handle);
    expect(store.getState().rightPanelWidth).toBeUndefined();
    expect(panel.style.width).toBe('360px');
  });

  it('切换到浏览器 tab 后支持启动、导航、实时画面交互与 AI MCP 开关', async () => {
    host({ type: 'snapshot', payload: baseSnapshot() });
    render(createElement(App));

    fireEvent.click(screen.getByTestId('toggle-right-panel'));
    const tabList = screen.getByTestId('right-panel-tab-browser').closest('[data-slot="tabs-list"]') as HTMLElement;
    expect(tabList.className).toContain('overflow-y-hidden');
    expect(tabList.className).toContain('tabs');
    expect(screen.getByTestId('right-panel-tab-browser').className).toContain(
      'group-data-[orientation=horizontal]/tabs:after:bottom-0',
    );
    fireEvent.click(screen.getByTestId('right-panel-tab-browser'));

    const browserPane = await screen.findByTestId('right-panel-browser');
    expect(browserPane).toBeTruthy();

    // 切换到浏览器 tab 且未自定义宽度时默认提供更宽视口（520px）
    expect(screen.getByTestId('workbench-right-panel').style.width).toBe('520px');

    // 点击启动浏览器按钮
    fireEvent.click(screen.getByTestId('browser-launch-btn'));
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'browserLaunch',
      }),
    );

    // 宿主推送运行中状态与实时 JPEG 画面帧，以及 AI 操作记录
    host({
      type: 'browserState',
      payload: {
        status: 'running',
        url: 'http://localhost:5173',
        title: 'Demo App',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        viewportWidth: 1000,
        viewportHeight: 600,
        viewportPreset: 'responsive',
        aiEnabled: true,
        mcpUrl: 'http://127.0.0.1:41234/mcp',
        cdpUrl: 'http://127.0.0.1:49999',
        lastAiAction: { tool: 'browser_click', summary: '点击 Submit', at: Date.now(), x: 200, y: 120 },
        consoleLogs: [{ id: 1, level: 'error', text: 'Uncaught ReferenceError: foo', timestamp: Date.now() }],
      },
    });
    host({
      type: 'browserFrame',
      payload: { data: 'ZmFrZQ==', width: 1000, height: 600, timestamp: Date.now() },
    });

    await waitFor(() => {
      expect(screen.getByTestId('browser-ai-banner').textContent).toContain('点击 Submit');
    });

    const img = screen.getByAltText('Demo App') as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,ZmFrZQ==');
    img.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 300, right: 500, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    // 鼠标点击按比例映射回 1000×600 视口坐标
    fireEvent.mouseDown(img, { clientX: 100, clientY: 75, button: 0, detail: 1 });
    expect(posted).toContainEqual({
      type: 'browserMouse',
      payload: { action: 'down', x: 200, y: 150, button: 'left', clickCount: 1, modifiers: 0 },
    });

    // 地址栏提交新网址
    const urlInput = screen.getByTestId('browser-url-input');
    fireEvent.change(urlInput, { target: { value: 'https://example.com' } });
    fireEvent.submit(urlInput.closest('form')!);
    expect(posted).toContainEqual({
      type: 'browserNavigate',
      payload: { url: 'https://example.com' },
    });

    // 打开控制台抽屉可见错误日志
    fireEvent.click(screen.getByTestId('browser-console-toggle'));
    expect(screen.getByTestId('browser-console-drawer').textContent).toContain('Uncaught ReferenceError: foo');

    // 打开 AI 连接 Popover 并切换开关
    fireEvent.click(screen.getByTestId('browser-ai-popover-trigger'));
    const aiSwitch = await screen.findByTestId('browser-ai-switch');
    fireEvent.click(aiSwitch);
    expect(posted).toContainEqual({
      type: 'browserSetAiEnabled',
      payload: { enabled: false },
    });

    // 已检测到浏览器时高级连接默认折叠，点击可展开
    expect(screen.queryByTestId('browser-advanced-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('browser-advanced-toggle'));
    expect(screen.getByTestId('browser-advanced-panel')).toBeTruthy();
  });
});

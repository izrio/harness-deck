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
        networkRequests: [
          {
            requestId: 'net-1',
            url: 'http://localhost:5173/api/users',
            method: 'GET',
            resourceType: 'Fetch',
            status: 200,
            statusText: 'OK',
            mimeType: 'application/json',
            encodedDataLength: 256,
            durationMs: 42,
            startedAt: Date.now(),
            finished: true,
            responseHeaders: { 'content-type': 'application/json' },
          },
        ],
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

    // 鼠标点击按比例映射回 1000×600 视口坐标，支持 Ctrl+C/X/A 与原生粘贴事件
    fireEvent.mouseDown(img, { clientX: 100, clientY: 75, button: 0, detail: 1 });
    expect(posted).toContainEqual({
      type: 'browserMouse',
      payload: { action: 'down', x: 200, y: 150, button: 'left', clickCount: 1, modifiers: 0 },
    });

    const viewportForClipboard = screen.getByTestId('browser-viewport');
    fireEvent.keyDown(viewportForClipboard, { key: 'c', ctrlKey: true });
    expect(posted).toContainEqual({ type: 'browserClipboard', payload: { action: 'copy' } });
    fireEvent.keyDown(viewportForClipboard, { key: 'x', ctrlKey: true });
    expect(posted).toContainEqual({ type: 'browserClipboard', payload: { action: 'cut' } });
    fireEvent.keyDown(viewportForClipboard, { key: 'a', ctrlKey: true });
    expect(posted).toContainEqual({ type: 'browserClipboard', payload: { action: 'selectAll' } });
    fireEvent.paste(viewportForClipboard, {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? 'hello clipboard' : '') },
    });
    expect(posted).toContainEqual({
      type: 'browserClipboard',
      payload: { action: 'paste', text: 'hello clipboard' },
    });

    // 地址栏按 Enter 提交新网址（不依赖表单提交按钮），并自动失焦以便回显重定向后的 URL
    const urlInput = screen.getByTestId('browser-url-input') as HTMLInputElement;
    urlInput.focus();
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: 'https://example.com' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });
    expect(posted).toContainEqual({
      type: 'browserNavigate',
      payload: { url: 'https://example.com' },
    });

    // 无损 PNG 帧正确切换为 image/png 渲染以保持高分屏文字锐利度
    host({
      type: 'browserFrame',
      payload: { data: 'cG5nZGF0YQ==', format: 'png', width: 1000, height: 600, timestamp: Date.now() },
    });
    await waitFor(() => {
      expect(img.src).toBe('data:image/png;base64,cG5nZGF0YQ==');
    });

    // 打开开发者工具抽屉可见错误日志，支持控制台 REPL 求值
    fireEvent.click(screen.getByTestId('browser-console-toggle'));
    expect(screen.getByTestId('browser-console-drawer').textContent).toContain('Uncaught ReferenceError: foo');

    const consoleInput = screen.getByTestId('browser-console-input');
    fireEvent.change(consoleInput, { target: { value: '1 + 1' } });
    fireEvent.submit(consoleInput.closest('form')!);
    expect(posted).toContainEqual({
      type: 'browserEvalConsole',
      payload: { expression: '1 + 1' },
    });

    // 停靠位置支持切换为左侧 / 右侧 / 底部（不卸载视口 DOM，通过 flex 方向无闪烁切换）
    const devtoolsPanel = screen.getByTestId('browser-devtools-panel');
    const browserBody = screen.getByTestId('browser-body');
    expect(devtoolsPanel.getAttribute('data-dock')).toBe('bottom');
    expect(browserBody.className).toContain('flex-col');

    fireEvent.click(screen.getByTestId('devtools-dock-left'));
    expect(devtoolsPanel.getAttribute('data-dock')).toBe('left');
    expect(browserBody.className).toContain('flex-row-reverse');

    fireEvent.click(screen.getByTestId('devtools-dock-right'));
    expect(devtoolsPanel.getAttribute('data-dock')).toBe('right');
    expect(browserBody.className).toContain('flex-row');
    expect(browserBody.className).not.toContain('flex-row-reverse');

    // 切换到网络面板，点击请求并查看响应体
    fireEvent.mouseDown(screen.getByTestId('devtools-tab-network'));
    fireEvent.click(screen.getByTestId('devtools-tab-network'));
    const netRow = await screen.findByTestId('devtools-network-row-net-1');
    expect(netRow.textContent).toContain('users');
    fireEvent.click(netRow);
    fireEvent.click(screen.getByTestId('devtools-network-detail-response'));
    expect(posted).toContainEqual({
      type: 'browserGetNetworkBody',
      payload: { requestId: 'net-1' },
    });
    host({
      type: 'browserNetworkBody',
      payload: { requestId: 'net-1', body: '{"ok":true}', base64Encoded: false },
    });
    await waitFor(() => {
      expect(screen.getByTestId('devtools-network-response-body').textContent).toContain('"ok": true');
    });

    // 开启 DOM 拾取模式，点击页面元素后展示元素详情、高亮层并支持实时修改行内样式
    fireEvent.click(screen.getByTestId('browser-inspect-btn'));
    fireEvent.mouseDown(img, { clientX: 50, clientY: 50, button: 0, detail: 1 });
    expect(posted).toContainEqual({
      type: 'browserInspectAt',
      payload: { x: 100, y: 100, select: true },
    });
    host({
      type: 'browserInspectResult',
      payload: {
        mode: 'select',
        element: {
          tag: 'button',
          id: 'submit-btn',
          classes: ['primary'],
          selector: '#submit-btn',
          label: 'button#submit-btn.primary',
          rect: { x: 80, y: 90, width: 120, height: 36 },
          boxModel: { margin: [0, 0, 0, 0], border: [1, 1, 1, 1], padding: [6, 12, 6, 12] },
          attributes: [{ name: 'id', value: 'submit-btn' }],
          inlineStyle: '',
          computedStyles: { display: 'inline-flex', color: 'rgb(255, 255, 255)' },
          outerHtml: '<button id="submit-btn" class="primary">Submit</button>',
          ancestors: [{ label: 'body', selector: 'body' }],
          children: [],
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId('devtools-elements-pane').textContent).toContain('button#submit-btn.primary');
      expect(screen.getByTestId('browser-dom-highlight')).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId('devtools-style-prop'), { target: { value: 'color' } });
    fireEvent.change(screen.getByTestId('devtools-style-val'), { target: { value: 'red' } });
    fireEvent.submit(screen.getByTestId('devtools-style-form'));
    expect(posted).toContainEqual({
      type: 'browserEditElementStyle',
      payload: { selector: '#submit-btn', property: 'color', value: 'red' },
    });

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

  it('控制台对标 Chrome：过滤（负向与正则）、级别/计数快捷筛选、重复合并、对象懒展开、表格/堆栈/分组、设置与多行 REPL 补全', async () => {
    const now = Date.now();
    const snap = baseSnapshot();
    host({
      type: 'snapshot',
      payload: {
        ...snap,
        browser: {
          ...snap.browser!,
          status: 'running',
          url: 'http://localhost:5173',
          title: 'Console Demo',
          preserveConsoleLog: false,
          consoleLogs: [
            {
              id: 1,
              level: 'debug',
              kind: 'console',
              text: 'verbose debug noise',
              timestamp: now,
            },
            {
              id: 2,
              level: 'info',
              kind: 'console',
              text: 'booted app',
              formatted: [{ text: 'booted app', style: { color: 'rgb(14, 165, 233)', fontWeight: 'bold' } }],
              source: { functionName: 'init', url: 'http://localhost:5173/src/main.ts', lineNumber: 12, columnNumber: 3 },
              timestamp: now + 1,
            },
            {
              id: 3,
              level: 'warn',
              kind: 'console',
              text: 'repeated warning',
              timestamp: now + 2,
            },
            {
              id: 4,
              level: 'warn',
              kind: 'console',
              text: 'repeated warning',
              timestamp: now + 3,
            },
            {
              id: 5,
              level: 'error',
              kind: 'exception',
              text: 'TypeError: boom',
              source: { functionName: 'handleClick', url: 'http://localhost:5173/src/app.ts', lineNumber: 42, columnNumber: 9 },
              stackTrace: [
                { functionName: 'handleClick', url: 'http://localhost:5173/src/app.ts', lineNumber: 42, columnNumber: 9 },
                { functionName: 'dispatch', url: 'http://localhost:5173/src/router.ts', lineNumber: 8, columnNumber: 1 },
              ],
              timestamp: now + 4,
            },
            {
              id: 6,
              level: 'log',
              kind: 'result',
              text: '{ id: 7 }',
              args: [
                {
                  type: 'object',
                  className: 'Object',
                  description: 'Object',
                  objectId: 'obj-7',
                  preview: [{ name: 'id', value: { type: 'number', value: 7, description: '7' }, isOwn: true }],
                },
              ],
              timestamp: now + 5,
            },
            {
              id: 7,
              level: 'log',
              kind: 'table',
              text: 'Array(1)',
              table: {
                columns: ['(index)', 'name'],
                rows: [{ '(index)': '0', name: 'Halo' }],
              },
              timestamp: now + 6,
            },
            {
              id: 8,
              level: 'log',
              kind: 'groupCollapsed',
              groupId: 8,
              text: 'Collapsed Section',
              timestamp: now + 7,
            },
            {
              id: 9,
              level: 'log',
              kind: 'console',
              parentGroupId: 8,
              groupDepth: 1,
              text: 'Hidden inside collapsed group',
              timestamp: now + 8,
            },
          ],
        },
      },
    });

    render(createElement(App));
    fireEvent.click(screen.getByTestId('toggle-right-panel'));
    fireEvent.click(await screen.findByTestId('right-panel-tab-browser'));
    fireEvent.click(await screen.findByTestId('browser-console-toggle'));

    const drawer = await screen.findByTestId('browser-console-drawer');

    // 1. 默认级别隐藏 Verbose (debug)，合并连续重复日志显示计数徽标，collapsed group 子行默认隐藏
    expect(drawer.textContent).not.toContain('verbose debug noise');
    expect(drawer.textContent).toContain('booted app');
    expect(screen.getByTestId('console-repeat-badge').textContent).toBe('2');
    expect(drawer.textContent).not.toContain('Hidden inside collapsed group');
    expect(screen.getByTestId('console-table-7').textContent).toContain('Halo');

    // 2. 展开 collapsed group 显示子行；展开错误堆栈；点击对象树触发懒加载并展示子属性
    fireEvent.click(screen.getByTestId('console-group-toggle-8'));
    expect(drawer.textContent).toContain('Hidden inside collapsed group');

    fireEvent.click(screen.getByTestId('console-stack-toggle-5'));
    expect(screen.getByTestId('console-stack-5').textContent).toContain('dispatch');

    fireEvent.click(screen.getByTestId('console-object-toggle'));
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'browserGetConsoleObject',
        payload: expect.objectContaining({ objectId: 'obj-7' }),
      }),
    );
    host({
      type: 'browserConsoleObject',
      payload: {
        requestId: 'obj-1',
        objectId: 'obj-7',
        properties: [
          { name: 'id', value: { type: 'number', value: 7, description: '7' }, isOwn: true },
          { name: 'secret', value: { type: 'string', value: 'loaded' }, isOwn: true },
        ],
      },
    });
    await waitFor(() => {
      expect(drawer.textContent).toContain('loaded');
    });

    // 3. 文本过滤（含 -排除 与 正则）及错误/警告计数快捷过滤
    const filterInput = screen.getByTestId('console-filter-input');
    fireEvent.change(filterInput, { target: { value: 'booted -Hidden' } });
    expect(drawer.textContent).toContain('booted app');
    expect(drawer.textContent).not.toContain('TypeError: boom');

    fireEvent.change(filterInput, { target: { value: 'localhost -app.ts' } });
    expect(drawer.textContent).toContain('booted app');
    expect(drawer.textContent).not.toContain('TypeError: boom');

    fireEvent.click(screen.getByTestId('console-regex-toggle'));
    fireEvent.change(filterInput, { target: { value: '^TypeError:.*boom$' } });
    expect(drawer.textContent).toContain('TypeError: boom');
    expect(drawer.textContent).not.toContain('booted app');
    fireEvent.change(filterInput, { target: { value: '' } });

    fireEvent.click(screen.getByTestId('console-error-count'));
    expect(drawer.textContent).toContain('TypeError: boom');
    expect(drawer.textContent).not.toContain('booted app');
    fireEvent.click(screen.getByTestId('console-error-count'));
    expect(drawer.textContent).toContain('booted app');

    // 4. 设置弹窗：Preserve log 下发宿主，时间戳立即渲染，关闭合并重复拆开计数
    fireEvent.click(screen.getByTestId('console-settings-trigger'));
    fireEvent.click(await screen.findByTestId('console-setting-preserve'));
    expect(posted).toContainEqual({ type: 'browserSetConsoleOptions', payload: { preserveLog: true } });

    fireEvent.click(screen.getByTestId('console-setting-timestamps'));
    expect(screen.getAllByTestId('console-timestamp').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('console-setting-group-similar'));
    expect(screen.queryByTestId('console-repeat-badge')).toBeNull();

    // 5. 多行 REPL：Shift+Enter 不提交、Enter 提交、补全弹窗 Tab 采纳、Ctrl+L 清空
    const consoleInput = screen.getByTestId('browser-console-input') as HTMLTextAreaElement;
    fireEvent.change(consoleInput, { target: { value: 'document.qu' } });
    const completeCall = await waitFor(() => {
      const hit = posted.find(
        (m): m is { type: string; payload: { requestId: string; expression: string } } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'browserConsoleComplete',
      );
      expect(hit).toBeTruthy();
      return hit!;
    });
    host({
      type: 'browserConsoleCompletions',
      payload: {
        requestId: completeCall.payload.requestId,
        prefix: 'qu',
        items: ['querySelector', 'querySelectorAll'],
      },
    });
    expect(await screen.findByTestId('console-completions')).toBeTruthy();
    fireEvent.keyDown(consoleInput, { key: 'Tab' });
    expect(consoleInput.value).toBe('document.querySelector');

    fireEvent.keyDown(consoleInput, { key: 'Enter', shiftKey: true });
    expect(posted.some((m) => (m as { type?: string }).type === 'browserEvalConsole')).toBe(false);

    fireEvent.keyDown(consoleInput, { key: 'Enter' });
    expect(posted).toContainEqual({
      type: 'browserEvalConsole',
      payload: { expression: 'document.querySelector' },
    });

    fireEvent.keyDown(consoleInput, { key: 'l', ctrlKey: true });
    expect(posted).toContainEqual({ type: 'browserClearConsole', payload: {} });
  });
});

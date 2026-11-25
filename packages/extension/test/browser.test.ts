import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpClient, type CdpSocketLike } from '../src/browser/CdpClient.ts';
import {
  EmbeddedBrowserManager,
  type BrowserFramePayload,
  normalizeBrowserUrl,
  resolveChromiumUserDataDir,
} from '../src/browser/EmbeddedBrowserManager.ts';
import {
  cdpPropertyDescriptorsToProperties,
  cdpRemoteObjectToArg,
  extractCompletionTarget,
  extractConsoleTable,
  extractStackFrames,
  formatConsoleArgs,
  sanitizeConsoleCss,
} from '../src/browser/consoleFormat.ts';
import {
  BrowserMcpServer,
  BUILTIN_BROWSER_MCP_ID,
  BUILTIN_BROWSER_MCP_NAME,
  buildBuiltinBrowserMcpConfig,
  ensureBrowserMcpBridgeScript,
} from '../src/browser/BrowserMcpServer.ts';

class FakeSocket extends EventEmitter implements CdpSocketLike {
  readyState = 1; // OPEN
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('EmbeddedBrowser & BrowserMcpServer', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('normalizeBrowserUrl 正确补全协议并拦截危险协议', () => {
    expect(normalizeBrowserUrl('')).toBe('about:blank');
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank');
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeBrowserUrl('localhost:5173?tab=1')).toBe('http://localhost:5173?tab=1');
    expect(normalizeBrowserUrl('localhost:5173#section')).toBe('http://localhost:5173#section');
    expect(normalizeBrowserUrl('127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app');
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserUrl('https://github.com')).toBe('https://github.com');
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow(/Unsupported URL scheme/u);
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow(/Unsupported URL scheme/u);
  });

  it('resolveChromiumUserDataDir 在 WSL2 启动 Windows 浏览器时避开 \\\\wsl.localhost 9P 路径并落到 Windows NTFS 盘符', () => {
    // 1. 普通 Linux 原生浏览器直接使用 storageRoot/browser-profile
    const nativeLinux = resolveChromiumUserDataDir('/home/u/.halo', '/usr/bin/chromium', {
      platform: 'linux',
    });
    expect(nativeLinux).toEqual({
      linuxDir: '/home/u/.halo/browser-profile',
      arg: '/home/u/.halo/browser-profile',
      isWslWinExe: false,
    });

    // 2. WSL2 + Windows chrome.exe 且 storageRoot 在 Linux ext4（wslpath 返回 \\wsl.localhost\...）：必须改用 Windows NTFS 目录
    const wslExt4 = resolveChromiumUserDataDir(
      '/home/u/.vscode-server/data/User/globalStorage/izrio.harness-deck',
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      {
        platform: 'linux',
        env: {},
        toWinPath: () => '\\\\wsl.localhost\\Ubuntu\\home\\u\\.vscode-server\\browser-profile',
        probeWinEnv: (name) => (name === 'LOCALAPPDATA' ? 'C:\\Users\\alice\\AppData\\Local' : undefined),
      },
    );
    expect(wslExt4.isWslWinExe).toBe(true);
    expect(wslExt4.arg).toMatch(/^C:\\Users\\alice\\AppData\\Local\\Halo\\browser-profile-[0-9a-f]{12}$/u);
    expect(wslExt4.arg).not.toContain('wsl.localhost');
    expect(wslExt4.linuxDir).toMatch(/^\/mnt\/c\/Users\/alice\/AppData\/Local\/Halo\/browser-profile-[0-9a-f]{12}$/u);

    // 3. WSL2 + Windows chrome.exe 且 storageRoot 本身已在 /mnt/d/... 盘符：直接复用该 NTFS 路径
    const wslDrive = resolveChromiumUserDataDir(
      '/mnt/d/work/halo',
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      {
        platform: 'linux',
        toWinPath: () => 'D:\\work\\halo\\browser-profile',
      },
    );
    expect(wslDrive).toEqual({
      linuxDir: '/mnt/d/work/halo/browser-profile',
      arg: 'D:\\work\\halo\\browser-profile',
      isWslWinExe: true,
    });
  });

  it('CdpClient 支持请求响应匹配、事件订阅与断连清理', async () => {
    let fake!: FakeSocket;
    const connectPromise = CdpClient.connect('ws://127.0.0.1:9222/devtools/page/1', {
      socketFactory: () => {
        fake = new FakeSocket();
        queueMicrotask(() => fake.emit('open'));
        return fake;
      },
    });
    const client = await connectPromise;
    expect(client.connected).toBe(true);

    const events: Record<string, unknown>[] = [];
    client.on('Page.loadEventFired', (params) => events.push(params));

    const callPromise = client.send<{ frameId: string }>('Page.navigate', { url: 'http://localhost:5173' });
    const req = JSON.parse(fake.sent[0]!) as { id: number; method: string; params: { url: string } };
    expect(req.method).toBe('Page.navigate');
    expect(req.params.url).toBe('http://localhost:5173');

    fake.emit('message', JSON.stringify({ id: req.id, result: { frameId: 'f1' } }));
    await expect(callPromise).resolves.toEqual({ frameId: 'f1' });

    fake.emit('message', JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 123 } }));
    expect(events).toEqual([{ timestamp: 123 }]);

    const pendingAfterClose = client.send('Runtime.evaluate', { expression: '1+1' });
    fake.close();
    await expect(pendingAfterClose).rejects.toThrow(/CDP connection closed/u);
    expect(client.connected).toBe(false);
  });

  it('BrowserMcpServer 校验 Bearer Token、暴露完整工具目录并支持 stdio 桥接脚本端到端调用', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'hd-browser-mcp-'));
    cleanups.push(() => rm(tmpRoot, { recursive: true, force: true }));

    const manager = new EmbeddedBrowserManager({
      storageRoot: tmpRoot,
      onStateChange: () => undefined,
      onFrame: () => undefined,
    });
    const server = new BrowserMcpServer(manager, { version: '0.14.0' });
    cleanups.push(async () => {
      await server.stop();
      await manager.dispose();
    });

    const mcpUrl = await server.ensureStarted();
    expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(manager.getState().mcpUrl).toBe(mcpUrl);

    // 1. 无 Token 返回 401
    const unauth = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(unauth.status).toBe(401);

    // 2. 带正确 Token 可调用 initialize / tools/list / tools/call(browser_status)
    const rpc = async (body: Record<string, unknown>) => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(BUILTIN_BROWSER_MCP_NAME);

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        'browser_status',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_screenshot',
        'browser_evaluate',
        'browser_console',
      ]),
    );

    const statusCall = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: {} },
    });
    const statusText = (statusCall.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(statusText)).toMatchObject({ status: 'stopped', url: 'about:blank' });

    // 3. 关闭 AI 开关后工具调用返回明确 isError 提示
    manager.setAiEnabled(false);
    const disabledCall = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: {} },
    });
    expect((disabledCall.result as { isError?: boolean }).isError).toBe(true);
    manager.setAiEnabled(true);

    // 4. 验证 stdio 桥接脚本可被任意 MCP 客户端拉起并完成 JSON-RPC 往返
    const bridgePath = await ensureBrowserMcpBridgeScript(tmpRoot);
    const mcpConfig = buildBuiltinBrowserMcpConfig({
      mcpUrl,
      token: server.token,
      bridgeScriptPath: bridgePath,
      nodeCommand: process.execPath,
      agents: ['dsh', 'claude'],
    });
    expect(mcpConfig.id).toBe(BUILTIN_BROWSER_MCP_ID);
    expect(mcpConfig.transport).toBe('stdio');

    const child = spawn(mcpConfig.command!, [...(mcpConfig.args ?? [])], {
      env: { ...process.env, ...(mcpConfig.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    });

    const responseLine = await new Promise<string>((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          resolve(buf.slice(0, nl));
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!buf.includes('\n')) reject(new Error(`stdio bridge exited early (code=${String(code)})`));
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' })}\n`);
      child.stdin.end();
    });
    expect(JSON.parse(responseLine)).toEqual({ jsonrpc: '2.0', id: 99, result: {} });
  });

  it('EmbeddedBrowserManager 按真实 DPR 启动高清推流，并在切换地址与同文档哈希跳转时重启推流并推送无损 PNG 帧', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'hd-browser-nav-'));
    cleanups.push(() => rm(tmpRoot, { recursive: true, force: true }));

    let currentUrl = 'about:blank';
    let currentTitle = '';
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    let socket!: FakeSocket;

    const origConnect = CdpClient.connect.bind(CdpClient);
    const spy = vi.spyOn(CdpClient, 'connect').mockImplementation(async (wsUrl) => {
      return origConnect(wsUrl, {
        socketFactory: () => {
          socket = new FakeSocket();
          const origSend = socket.send.bind(socket);
          socket.send = (raw: string) => {
            origSend(raw);
            const msg = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
            calls.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}) });
            queueMicrotask(() => {
              if (msg.method === 'Page.navigate') {
                const targetUrl = String(msg.params?.url ?? '');
                const sameDoc = targetUrl.includes('#') && targetUrl.split('#')[0] === currentUrl.split('#')[0];
                currentUrl = targetUrl;
                currentTitle = sameDoc ? 'Hash Page' : `Title for ${targetUrl}`;
                socket.emit(
                  'message',
                  JSON.stringify({
                    id: msg.id,
                    result: sameDoc ? { frameId: 'f1' } : { frameId: 'f1', loaderId: 'l1' },
                  }),
                );
                if (!sameDoc) {
                  socket.emit('message', JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
                }
                return;
              }
              if (msg.method === 'Page.getNavigationHistory') {
                socket.emit(
                  'message',
                  JSON.stringify({
                    id: msg.id,
                    result: { currentIndex: 0, entries: [{ id: 1, url: currentUrl, title: currentTitle }] },
                  }),
                );
                return;
              }
              if (msg.method === 'Page.captureScreenshot') {
                socket.emit('message', JSON.stringify({ id: msg.id, result: { data: `frame:${currentUrl}` } }));
                return;
              }
              socket.emit('message', JSON.stringify({ id: msg.id, result: {} }));
            });
          };
          queueMicrotask(() => socket.emit('open'));
          return socket;
        },
      });
    });
    cleanups.push(() => spy.mockRestore());

    const frames: BrowserFramePayload[] = [];
    const manager = new EmbeddedBrowserManager({
      storageRoot: tmpRoot,
      onStateChange: () => undefined,
      onFrame: (f) => frames.push(f),
    });
    cleanups.push(() => manager.dispose());

    // 1. 以 DPR=2 启动并打开第一个地址
    const launched = await manager.launch({
      cdpUrl: 'ws://127.0.0.1:9222/devtools/page/1',
      url: 'http://localhost:5173',
      width: 600,
      height: 400,
      deviceScaleFactor: 2,
    });
    expect(launched.status).toBe('running');
    expect(launched.url).toBe('http://localhost:5173');

    const metricsCall = calls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(metricsCall?.params).toMatchObject({ width: 600, height: 400, deviceScaleFactor: 2 });

    const screencastCall = calls.find((c) => c.method === 'Page.startScreencast');
    expect(screencastCall?.params).toMatchObject({
      format: 'jpeg',
      quality: 92,
      maxWidth: 1200,
      maxHeight: 800,
    });

    // 2. 切换到新地址（跨域）：应重启 screencast 并抓取新页面 PNG 帧
    const screencastCountBefore = calls.filter((c) => c.method === 'Page.startScreencast').length;
    const navRes = await manager.navigate('https://example.com/next');
    expect(navRes.url).toBe('https://example.com/next');
    expect(navRes.title).toBe('Title for https://example.com/next');
    expect(calls.filter((c) => c.method === 'Page.startScreencast').length).toBeGreaterThan(screencastCountBefore);
    expect(manager.getLastFrame()).toMatchObject({
      data: 'frame:https://example.com/next',
      format: 'png',
    });

    // 3. 同文档 #hash 跳转（无 loaderId）：立即完成不卡 15 秒，并刷新画面
    const hashRes = await manager.navigate('https://example.com/next#details');
    expect(hashRes.url).toBe('https://example.com/next#details');
    expect(manager.getLastFrame()).toMatchObject({
      data: 'frame:https://example.com/next#details',
      format: 'png',
    });

    // 4. 网络事件捕获（requestWillBeSent / responseReceived / loadingFinished）与响应体读取
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Network.requestWillBeSent',
        params: {
          requestId: 'req-1',
          type: 'Fetch',
          timestamp: 10.0,
          wallTime: 1700000000,
          request: {
            url: 'https://example.com/api/items',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            postData: '{"q":"halo"}',
          },
        },
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Network.responseReceived',
        params: {
          requestId: 'req-1',
          type: 'Fetch',
          response: {
            status: 200,
            statusText: 'OK',
            mimeType: 'application/json',
            headers: { 'content-type': 'application/json' },
          },
        },
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Network.loadingFinished',
        params: { requestId: 'req-1', timestamp: 10.125, encodedDataLength: 512 },
      }),
    );

    const netState = manager.getState().networkRequests ?? [];
    expect(netState).toHaveLength(1);
    expect(netState[0]).toMatchObject({
      requestId: 'req-1',
      method: 'POST',
      url: 'https://example.com/api/items',
      resourceType: 'Fetch',
      status: 200,
      encodedDataLength: 512,
      durationMs: 125,
      finished: true,
      postData: '{"q":"halo"}',
    });

    manager.clearNetwork();
    expect(manager.getState().networkRequests).toEqual([]);

    // 5. 剪贴板粘贴与拖选鼠标 buttons 透传
    await manager.pasteText('pasted text');
    expect(calls).toContainEqual({ method: 'Input.insertText', params: { text: 'pasted text' } });

    await manager.dispatchMouse({ action: 'move', x: 120, y: 80, buttons: 1 });
    expect(calls).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 120, y: 80, button: 'left', buttons: 1, clickCount: 0, modifiers: 0 },
    });
  });

  it('consoleFormat 正确处理 %s/%d/%c 占位符、安全样式消毒、表格、堆栈与补全目标提取', () => {
    expect(
      sanitizeConsoleCss('color: red; font-weight: bold; background-image: url(https://evil.test); position: fixed; padding: 2px 6px'),
    ).toEqual({
      color: 'red',
      fontWeight: 'bold',
      padding: '2px 6px',
    });
    expect(sanitizeConsoleCss('color: expression(alert(1))')).toBeUndefined();

    const formatted = formatConsoleArgs([
      { type: 'string', value: '%cHello %s #%d' },
      { type: 'string', value: 'color: #0ea5e9; font-weight: 600' },
      { type: 'string', value: 'Halo' },
      { type: 'number', value: 42.9, description: '42.9' },
    ]);
    expect(formatted.text).toBe('Hello Halo #42');
    expect(formatted.formatted).toEqual([
      { text: 'Hello ', style: { color: '#0ea5e9', fontWeight: '600' } },
      { text: 'Halo', style: { color: '#0ea5e9', fontWeight: '600' } },
      { text: ' #', style: { color: '#0ea5e9', fontWeight: '600' } },
      { text: '42', style: { color: '#0ea5e9', fontWeight: '600' } },
    ]);

    const tableArg = cdpRemoteObjectToArg({
      type: 'object',
      subtype: 'array',
      description: 'Array(2)',
      preview: {
        type: 'object',
        subtype: 'array',
        description: 'Array(2)',
        properties: [
          {
            name: '0',
            type: 'object',
            valuePreview: {
              type: 'object',
              properties: [
                { name: 'id', type: 'number', value: '1' },
                { name: 'name', type: 'string', value: 'alpha' },
              ],
            },
          },
          {
            name: '1',
            type: 'object',
            valuePreview: {
              type: 'object',
              properties: [
                { name: 'id', type: 'number', value: '2' },
                { name: 'name', type: 'string', value: 'beta' },
              ],
            },
          },
        ],
      },
    });
    expect(extractConsoleTable(tableArg)).toEqual({
      columns: ['(index)', 'id', 'name'],
      rows: [
        { '(index)': '0', id: '1', name: 'alpha' },
        { '(index)': '1', id: '2', name: 'beta' },
      ],
    });

    expect(
      extractStackFrames({
        callFrames: [{ functionName: 'onClick', url: 'https://example.com/app.js', lineNumber: 9, columnNumber: 4 }],
      }),
    ).toEqual([{ functionName: 'onClick', url: 'https://example.com/app.js', lineNumber: 10, columnNumber: 5 }]);

    const props = cdpPropertyDescriptorsToProperties(
      [{ name: 'count', value: { type: 'number', value: 3, description: '3' }, isOwn: true }],
      [{ name: '[[Prototype]]', value: { type: 'object', className: 'Object', description: 'Object', objectId: 'proto-1' } }],
    );
    expect(props).toEqual([
      { name: 'count', value: { type: 'number', value: 3, description: '3' }, isOwn: true },
      {
        name: '[[Prototype]]',
        value: { type: 'object', className: 'Object', description: 'Object', objectId: 'proto-1' },
        internal: true,
      },
    ]);

    expect(extractCompletionTarget('document.qu')).toEqual({ receiver: 'document', prefix: 'qu' });
    expect(extractCompletionTarget('$0.sty')).toEqual({ receiver: '$0', prefix: 'sty' });
    expect(extractCompletionTarget('doc')).toEqual({ prefix: 'doc' });
    expect(extractCompletionTarget('foo().bar')).toBeUndefined();
    expect(extractCompletionTarget('1.toFixed')).toBeUndefined();
  });

  it('EmbeddedBrowserManager 支持结构化控制台日志、分组/表格/Log.entryAdded、REPL $0 与属性懒加载及 preserveLog', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'hd-browser-console-'));
    cleanups.push(() => rm(tmpRoot, { recursive: true, force: true }));

    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    let socket!: FakeSocket;

    const origConnect = CdpClient.connect.bind(CdpClient);
    const spy = vi.spyOn(CdpClient, 'connect').mockImplementation(async (wsUrl) => {
      return origConnect(wsUrl, {
        socketFactory: () => {
          socket = new FakeSocket();
          const origSend = socket.send.bind(socket);
          socket.send = (raw: string) => {
            origSend(raw);
            const msg = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
            calls.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}) });
            queueMicrotask(() => {
              if (msg.method === 'Runtime.evaluate') {
                const expr = String(msg.params?.expression ?? '');
                if (msg.params?.throwOnSideEffect === true) {
                  socket.emit('message', JSON.stringify({ id: msg.id, result: { result: { type: 'object', value: ['querySelector', 'querySelectorAll'] } } }));
                  return;
                }
                socket.emit(
                  'message',
                  JSON.stringify({
                    id: msg.id,
                    result: {
                      result: {
                        type: 'object',
                        className: 'Object',
                        description: 'Object',
                        objectId: 'eval-obj-1',
                        preview: {
                          type: 'object',
                          properties: [{ name: 'ok', type: 'boolean', value: 'true' }],
                        },
                      },
                    },
                  }),
                );
                expect(expr).toContain('document.querySelector("#hero")');
                return;
              }
              if (msg.method === 'Runtime.getProperties') {
                socket.emit(
                  'message',
                  JSON.stringify({
                    id: msg.id,
                    result: {
                      result: [{ name: 'ok', value: { type: 'boolean', value: true, description: 'true' }, isOwn: true }],
                      internalProperties: [
                        { name: '[[Prototype]]', value: { type: 'object', description: 'Object', objectId: 'proto-1' } },
                      ],
                    },
                  }),
                );
                return;
              }
              if (msg.method === 'Page.captureScreenshot') {
                socket.emit('message', JSON.stringify({ id: msg.id, result: { data: 'ok' } }));
                return;
              }
              socket.emit('message', JSON.stringify({ id: msg.id, result: {} }));
            });
          };
          queueMicrotask(() => socket.emit('open'));
          return socket;
        },
      });
    });
    cleanups.push(() => spy.mockRestore());

    const manager = new EmbeddedBrowserManager({
      storageRoot: tmpRoot,
      onStateChange: () => undefined,
      onFrame: () => undefined,
    });
    cleanups.push(() => manager.dispose());

    await manager.launch({ cdpUrl: 'ws://127.0.0.1:9222/devtools/page/1' });
    expect(calls.some((c) => c.method === 'Log.enable')).toBe(true);

    // 1. 分组日志、debug、table 与 Log.entryAdded
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Runtime.consoleAPICalled',
        params: {
          type: 'startGroupCollapsed',
          args: [{ type: 'string', value: 'Init Group' }],
          stackTrace: { callFrames: [{ functionName: 'boot', url: 'https://app.test/main.js', lineNumber: 4, columnNumber: 1 }] },
        },
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'debug', args: [{ type: 'string', value: 'trace detail' }] },
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'endGroup', args: [] },
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        method: 'Log.entryAdded',
        params: { entry: { level: 'error', text: 'Failed to load resource: 404', url: 'https://app.test/missing.png', lineNumber: 0 } },
      }),
    );

    const logs = manager.getState().consoleLogs;
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ kind: 'groupCollapsed', text: 'Init Group', source: { url: 'https://app.test/main.js', lineNumber: 5 } });
    expect(logs[1]).toMatchObject({ level: 'debug', text: 'trace detail', groupDepth: 1, parentGroupId: logs[0]!.groupId });
    expect(logs[2]).toMatchObject({ kind: 'browser', level: 'error', text: 'Failed to load resource: 404' });

    // 2. REPL 求值带 $0 与 Command Line API，并返回结构化 objectId
    await manager.evalConsole('({ ok: $0 !== null })', '#hero');
    const evalCall = calls.find((c) => c.method === 'Runtime.evaluate' && c.params?.includeCommandLineAPI === true);
    expect(evalCall?.params).toMatchObject({
      returnByValue: false,
      generatePreview: true,
      includeCommandLineAPI: true,
      replMode: true,
      objectGroup: 'halo-console',
    });
    const afterEval = manager.getState().consoleLogs;
    expect(afterEval.at(-2)).toMatchObject({ kind: 'command', text: '({ ok: $0 !== null })' });
    expect(afterEval.at(-1)).toMatchObject({
      kind: 'result',
      args: [expect.objectContaining({ objectId: 'eval-obj-1' })],
    });

    // 3. 懒加载对象属性 & 无副作用补全
    const objRes = await manager.getConsoleObject('eval-obj-1');
    expect(objRes.properties).toHaveLength(2);
    expect(objRes.properties?.[0]).toMatchObject({ name: 'ok', isOwn: true });

    const cmpRes = await manager.completeConsole('document.qu');
    expect(cmpRes).toEqual({ prefix: 'qu', items: ['querySelector', 'querySelectorAll'] });

    // 4. preserveLog = false 时导航自动清空；preserveLog = true 时保留并插入分隔消息
    socket.emit('message', JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { url: 'https://app.test/page-a' } } }));
    expect(manager.getState().consoleLogs).toEqual([]);

    manager.setConsoleOptions({ preserveLog: true });
    expect(manager.getState().preserveConsoleLog).toBe(true);
    socket.emit(
      'message',
      JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'keep me' }] } }),
    );
    socket.emit('message', JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { url: 'https://app.test/page-b' } } }));
    const preserved = manager.getState().consoleLogs;
    expect(preserved.map((l) => l.text)).toEqual(['keep me', 'Navigated to https://app.test/page-b']);
  });
});

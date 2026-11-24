import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CdpClient, type CdpSocketLike } from '../src/browser/CdpClient.ts';
import {
  EmbeddedBrowserManager,
  normalizeBrowserUrl,
  resolveChromiumUserDataDir,
} from '../src/browser/EmbeddedBrowserManager.ts';
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
});

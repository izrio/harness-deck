/**
 * 内置浏览器 MCP Server（BrowserMcpServer）与 Stdio 桥接脚本生成器：
 * - 在宿主进程内监听 `127.0.0.1:0`（随机端口 + 一次性 Bearer Token），对外提供标准 MCP JSON-RPC 2.0 Streamable HTTP 端点 `/mcp`；
 * - 同时在 `storageRoot/runtime/browser-mcp-bridge.cjs` 生成零依赖 Node stdio 桥接脚本，
 *   让所有支持 stdio MCP 的 AI 代理（DeepSeek dsh / Claude / Codex / CodeBuddy / ZCode / 全部 ACP 代理）开箱即用直连右侧内置浏览器。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { McpServerConfig } from '@harness-deck/shared';
import type { EmbeddedBrowserManager } from './EmbeddedBrowserManager.ts';

export const BUILTIN_BROWSER_MCP_ID = '__harness_browser__';
export const BUILTIN_BROWSER_MCP_NAME = 'harness-browser';

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const BROWSER_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'browser_status',
    description: 'Get the current state of the Harness Deck built-in browser (status, URL, title, viewport, console error count).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the built-in browser to a URL (automatically launches the browser if stopped).',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'URL to open (e.g. http://localhost:5173 or https://example.com).' },
      },
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Inspect the current page in the built-in browser. Returns visible text and numbered interactive elements (ref e1, e2, ...) with their coordinates for clicking/typing.',
    inputSchema: {
      type: 'object',
      properties: {
        maxElements: { type: 'number', description: 'Maximum interactive elements to return (default 60, max 150).' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element in the built-in browser by snapshot ref (e.g. "e3"), CSS selector, or viewport (x, y) coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3").' },
        selector: { type: 'string', description: 'CSS selector to click.' },
        x: { type: 'number', description: 'Viewport X coordinate in pixels.' },
        y: { type: 'number', description: 'Viewport Y coordinate in pixels.' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button (default left).' },
        doubleClick: { type: 'boolean', description: 'Double-click when true.' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input/editable element in the built-in browser (by ref or CSS selector, or currently focused element).',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e2").' },
        selector: { type: 'string', description: 'CSS selector of input element.' },
        text: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Clear existing value before typing.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key in the built-in browser (e.g. Enter, Escape, Tab, Backspace, ArrowDown).',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Key name (e.g. Enter, Escape, Tab, ArrowDown).' },
        modifiers: { type: 'number', description: 'Optional CDP modifier bitmask (1=Alt, 2=Ctrl, 4=Meta, 8=Shift).' },
      },
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page or a specific element in the built-in browser.',
    inputSchema: {
      type: 'object',
      properties: {
        deltaY: { type: 'number', description: 'Vertical scroll delta in pixels (positive scrolls down, default 480).' },
        deltaX: { type: 'number', description: 'Horizontal scroll delta in pixels (default 0).' },
        selector: { type: 'string', description: 'Optional CSS selector to scroll over.' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the built-in browser page.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture beyond viewport when true.' },
      },
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the built-in browser page context and return its JSON result.',
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
      },
    },
  },
  {
    name: 'browser_console',
    description: 'Read recent browser console logs and uncaught exceptions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum log entries (default 30).' },
        level: { type: 'string', enum: ['log', 'info', 'warn', 'error'], description: 'Filter by console level.' },
      },
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a duration in milliseconds, a CSS selector to appear, or specific text to appear on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Duration in milliseconds (when selector/text omitted).' },
        selector: { type: 'string', description: 'Wait until this CSS selector appears.' },
        text: { type: 'string', description: 'Wait until this text appears in document.body.innerText.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 8000).' },
      },
    },
  },
  {
    name: 'browser_go_back',
    description: 'Navigate back in the built-in browser history.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page in the built-in browser.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 零依赖 stdio → Streamable HTTP MCP 桥接脚本（写入 storageRoot/runtime/browser-mcp-bridge.cjs）。 */
const STDIO_MCP_BRIDGE_SCRIPT = `'use strict';
const http = require('node:http');
const readline = require('node:readline');

const targetUrl = process.env.HARNESS_BROWSER_MCP_URL;
const token = process.env.HARNESS_BROWSER_MCP_TOKEN || '';

if (!targetUrl) {
  process.stderr.write('HARNESS_BROWSER_MCP_URL is not set\\n');
  process.exit(1);
}

const parsed = new URL(targetUrl);

function forward(line) {
  return new Promise((resolve) => {
    const body = Buffer.from(line, 'utf8');
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          'Authorization': 'Bearer ' + token,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim();
          if (text) {
            process.stdout.write(text + '\\n');
          }
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      try {
        const parsedReq = JSON.parse(line);
        if (parsedReq && parsedReq.id !== undefined) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsedReq.id,
              error: { code: -32000, message: 'Harness browser MCP bridge error: ' + err.message },
            }) + '\\n',
          );
        }
      } catch {}
      resolve();
    });
    req.end(body);
  });
}

let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  queue = queue.then(() => forward(trimmed));
});
rl.on('close', () => {
  queue.finally(() => process.exit(0));
});
`;

export async function ensureBrowserMcpBridgeScript(storageRoot: string): Promise<string> {
  const scriptPath = join(storageRoot, 'runtime', 'browser-mcp-bridge.cjs');
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, STDIO_MCP_BRIDGE_SCRIPT, 'utf8');
  return scriptPath;
}

export function buildBuiltinBrowserMcpConfig(params: {
  readonly mcpUrl: string;
  readonly token: string;
  readonly bridgeScriptPath?: string;
  readonly nodeCommand?: string;
  readonly agents: readonly string[];
}): McpServerConfig {
  if (params.bridgeScriptPath) {
    const command = params.nodeCommand || process.execPath;
    const isElectronExec = command === process.execPath && Boolean(process.versions.electron);
    return {
      id: BUILTIN_BROWSER_MCP_ID,
      name: BUILTIN_BROWSER_MCP_NAME,
      transport: 'stdio',
      command,
      args: [params.bridgeScriptPath],
      env: {
        HARNESS_BROWSER_MCP_URL: params.mcpUrl,
        HARNESS_BROWSER_MCP_TOKEN: params.token,
        ...(isElectronExec ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      enabled: true,
      agents: [...params.agents],
    };
  }
  return {
    id: BUILTIN_BROWSER_MCP_ID,
    name: BUILTIN_BROWSER_MCP_NAME,
    transport: 'http',
    url: params.mcpUrl,
    headers: { Authorization: `Bearer ${params.token}` },
    enabled: true,
    agents: [...params.agents],
  };
}

function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export class BrowserMcpServer {
  readonly token: string;
  private server?: Server;
  private _url?: string;
  private starting?: Promise<string>;

  constructor(
    private readonly browser: EmbeddedBrowserManager,
    private readonly options?: {
      readonly version?: string;
      readonly log?: (line: string) => void;
    },
  ) {
    this.token = randomBytes(24).toString('hex');
  }

  get url(): string | undefined {
    return this._url;
  }

  async ensureStarted(): Promise<string> {
    if (this._url) return this._url;
    if (this.starting) return this.starting;
    this.starting = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      server.once('error', (err) => {
        this.starting = undefined;
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          this.starting = undefined;
          reject(new Error('Failed to bind BrowserMcpServer'));
          return;
        }
        this.server = server;
        this._url = `http://127.0.0.1:${addr.port}/mcp`;
        this.browser.setMcpUrl(this._url);
        this.options?.log?.(`BrowserMcpServer listening at ${this._url}`);
        resolve(this._url);
      });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this._url = undefined;
    this.starting = undefined;
    this.browser.setMcpUrl(undefined);
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && urlPath === '/health') {
      sendJson(res, 200, { ok: true, browser: this.browser.getState().status });
      return;
    }

    if (req.method !== 'POST' || urlPath !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${this.token}`) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    let body: JsonRpcRequest;
    try {
      body = (await readJsonBody(req)) as JsonRpcRequest;
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const { id, method, params } = body;
    if (!method) {
      sendJson(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }

    // 通知类消息无需响应体
    if (method === 'notifications/initialized' || id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      if (method === 'initialize') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: BUILTIN_BROWSER_MCP_NAME,
              version: this.options?.version ?? '1.0.0',
            },
          },
        });
        return;
      }

      if (method === 'ping') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { tools: BROWSER_MCP_TOOLS },
        });
        return;
      }

      if (method === 'tools/call') {
        const toolName = typeof params?.name === 'string' ? params.name : '';
        const toolArgs = (params?.arguments as Record<string, unknown> | undefined) ?? {};
        const result = await this.callTool(toolName, toolArgs);
        sendJson(res, 200, { jsonrpc: '2.0', id, result });
        return;
      }

      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: msg },
      });
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly content: readonly Record<string, unknown>[]; readonly isError?: boolean }> {
    if (!this.browser.isAiEnabled()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'AI browser control is currently disabled by the user in Harness Deck.' }],
      };
    }

    try {
      switch (name) {
        case 'browser_status': {
          const st = this.browser.getState();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: st.status,
                    url: st.url,
                    title: st.title,
                    viewport: { width: st.viewportWidth, height: st.viewportHeight, preset: st.viewportPreset },
                    consoleErrors: st.consoleLogs.filter((l) => l.level === 'error').length,
                    cdpUrl: st.cdpUrl,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case 'browser_navigate': {
          const url = typeof args.url === 'string' ? args.url : '';
          const res = await this.browser.aiNavigate(url);
          return {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          };
        }
        case 'browser_snapshot': {
          const maxElements = typeof args.maxElements === 'number' ? args.maxElements : 60;
          const snap = await this.browser.aiSnapshot(maxElements);
          return {
            content: [{ type: 'text', text: JSON.stringify(snap, null, 2) }],
          };
        }
        case 'browser_click': {
          const button =
            args.button === 'right' || args.button === 'middle' || args.button === 'left' ? args.button : undefined;
          const res = await this.browser.aiClick({
            ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
            ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
            ...(typeof args.x === 'number' ? { x: args.x } : {}),
            ...(typeof args.y === 'number' ? { y: args.y } : {}),
            ...(button ? { button } : {}),
            ...(args.doubleClick === true ? { doubleClick: true } : {}),
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(res) }],
          };
        }
        case 'browser_type': {
          const text = typeof args.text === 'string' ? args.text : '';
          const res = await this.browser.aiType({
            ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
            ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
            text,
            ...(args.clear === true ? { clear: true } : {}),
            ...(args.submit === true ? { submit: true } : {}),
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(res) }],
          };
        }
        case 'browser_press_key': {
          const key = typeof args.key === 'string' ? args.key : '';
          await this.browser.aiPressKey({
            key,
            ...(typeof args.modifiers === 'number' ? { modifiers: args.modifiers } : {}),
          });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, key }) }] };
        }
        case 'browser_scroll': {
          await this.browser.aiScroll({
            ...(typeof args.deltaY === 'number' ? { deltaY: args.deltaY } : {}),
            ...(typeof args.deltaX === 'number' ? { deltaX: args.deltaX } : {}),
            ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
          });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
        }
        case 'browser_screenshot': {
          const shot = await this.browser.aiScreenshot({
            ...(args.fullPage === true ? { fullPage: true } : {}),
          });
          return {
            content: [
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
              {
                type: 'text',
                text: JSON.stringify({ url: shot.url, title: shot.title, width: shot.width, height: shot.height }),
              },
            ],
          };
        }
        case 'browser_evaluate': {
          const expression = typeof args.expression === 'string' ? args.expression : '';
          const res = await this.browser.aiEvaluate(expression);
          if (res.error) {
            return { isError: true, content: [{ type: 'text', text: res.error }] };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(res.value ?? null, null, 2) }],
          };
        }
        case 'browser_console': {
          const logs = this.browser.aiConsole({
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(typeof args.level === 'string' ? { level: args.level } : {}),
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
          };
        }
        case 'browser_wait': {
          const res = await this.browser.aiWait({
            ...(typeof args.ms === 'number' ? { ms: args.ms } : {}),
            ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
            ...(typeof args.text === 'string' ? { text: args.text } : {}),
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(res) }],
          };
        }
        case 'browser_go_back': {
          const res = await this.browser.goBack();
          return { content: [{ type: 'text', text: JSON.stringify(res) }] };
        }
        case 'browser_reload': {
          const res = await this.browser.reload();
          return { content: [{ type: 'text', text: JSON.stringify(res) }] };
        }
        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown browser tool: ${name}` }] };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: 'text', text: msg }],
      };
    }
  }
}

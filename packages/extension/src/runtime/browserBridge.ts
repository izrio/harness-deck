/**
 * 宿主浏览器桥接（BrowserBridge）：
 *
 * 在 WSL、Remote-SSH、容器或无桌面/缺少 `xdg-open` 的 Linux 环境中，底层代理（例如 `codebuddy --acp`）
 * 在执行浏览器 OAuth 登录时，通常会通过 `$BROWSER`、`xdg-open` 或 `wslview` 尝试唤起浏览器：
 * - VS Code Remote-WSL 的集成终端会注入 `BROWSER=.../browser.sh`，但 Extension Host 进程环境里并没有设置；
 * - WSL 默认镜像通常没有安装 `xdg-open` / `wslview`，也没有 Linux 图形浏览器。
 *
 * 本模块在本机回环地址 `127.0.0.1:0` 启动一次性随机令牌保护的轻量桥接服务，
 * 并在专属目录中生成无状态可执行 shim（`browser-open`、`xdg-open`、`wslview`、`x-www-browser`、`sensible-browser`），
 * 通过环境变量注入给子进程：
 * - 子进程打开 `http://` 或 `https://` 链接时，经由本机回环桥接转交宿主 `openExternal`（VS Code Remote-WSL 会自动拉起 Windows 浏览器）；
 * - 非 HTTP(S) 参数或桥接不可用时，剥离 shim 目录后回退到系统原命令，避免递归死循环；
 * - 令牌与端口仅通过环境变量传递、不写入磁盘，多个 IDE 窗口共用同一 shim 目录也互不干扰。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { locateExecutable } from './locate.ts';
import { isWslEnvironment } from './wsl.ts';

export { isWslEnvironment };

const MAX_BODY_BYTES = 16 * 1024;
const SHIM_COMMANDS = ['browser-open', 'xdg-open', 'wslview', 'x-www-browser', 'sensible-browser'] as const;

const SHIM_WRAPPER = [
  '#!/bin/sh',
  'SCRIPT_DIR="${0%/*}"',
  'SCRIPT_NAME="${0##*/}"',
  '[ "$SCRIPT_DIR" = "$0" ] && SCRIPT_DIR="."',
  'NODE_BIN="${HARNESS_DECK_BROWSER_NODE:-node}"',
  'export ELECTRON_RUN_AS_NODE=1',
  'exec "$NODE_BIN" "$SCRIPT_DIR/browser-open.cjs" "$SCRIPT_NAME" "$@"',
  '',
].join('\n');

const SHIM_SCRIPT_CJS = `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const invokedAs = process.argv[2] || 'browser-open';
const args = process.argv.slice(3);
const bridgeUrl = process.env.HARNESS_DECK_BROWSER_BRIDGE_URL;
const bridgeToken = process.env.HARNESS_DECK_BROWSER_BRIDGE_TOKEN;
const bridgeBin = process.env.HARNESS_DECK_BROWSER_BRIDGE_BIN;
const originalBrowser = process.env.HARNESS_DECK_BROWSER_ORIGINAL;

function findHttpUrl(argv) {
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (/^https?:\\/\\/\\S+$/iu.test(trimmed)) return trimmed;
  }
  return undefined;
}

function stripBridgeBin(rawPath) {
  if (!rawPath || !bridgeBin) return rawPath || '';
  const target = path.resolve(bridgeBin);
  return rawPath
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== target)
    .join(path.delimiter);
}

function findRealBinary(name, cleanPath) {
  if (name.includes(path.sep)) {
    try {
      const stat = fs.statSync(name);
      if (stat.isFile()) {
        fs.accessSync(name, fs.constants.X_OK);
        return name;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  for (const dir of cleanPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue searching
    }
  }
  return undefined;
}

function fallbackExec() {
  const cleanPath = stripBridgeBin(process.env.PATH);
  const env = { ...process.env, PATH: cleanPath };
  if (originalBrowser) {
    env.BROWSER = originalBrowser;
  } else if (env.BROWSER && bridgeBin && path.resolve(env.BROWSER).startsWith(path.resolve(bridgeBin) + path.sep)) {
    delete env.BROWSER;
  }
  const targetName = invokedAs === 'browser-open' ? originalBrowser : invokedAs;
  if (!targetName) process.exit(1);
  const realBin = findRealBinary(targetName, cleanPath);
  if (!realBin) process.exit(127);
  const res = spawnSync(realBin, args, { stdio: 'inherit', env });
  process.exit(typeof res.status === 'number' ? res.status : 1);
}

const url = findHttpUrl(args);
if (!url || !bridgeUrl || !bridgeToken) {
  fallbackExec();
}

let target;
try {
  target = new URL(bridgeUrl);
} catch {
  fallbackExec();
}

const body = JSON.stringify({ url });
const req = http.request(
  {
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-harness-deck-token': bridgeToken,
    },
    timeout: 5000,
  },
  (res) => {
    res.resume();
    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        process.exit(0);
      } else {
        fallbackExec();
      }
    });
  },
);

req.on('timeout', () => {
  req.destroy();
  fallbackExec();
});

req.on('error', () => {
  fallbackExec();
});

req.write(body);
req.end();
`;

/** 校验并规范化 HTTP/HTTPS 链接，其他协议一律拒绝。 */
export function parseHttpUrl(raw: string): URL | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (!parsed.hostname) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 是否为本机回环主机名。 */
export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]';
}

export interface BrowserBridgeDecisionOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly procVersion?: string;
  readonly hasSystemXdgOpen?: boolean;
}

/** 判断当前环境是否需要启用浏览器桥接（WSL / Remote-SSH / 容器 / 无图形界面 / 缺少 xdg-open 的 Linux）。 */
export function shouldEnableBrowserBridge(options: BrowserBridgeDecisionOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return false;
  const env = options.env ?? process.env;
  if (isWslEnvironment(env, options.procVersion)) return true;
  if (
    env.SSH_CONNECTION ||
    env.SSH_CLIENT ||
    env.SSH_TTY ||
    env.REMOTE_CONTAINERS ||
    env.CODESPACES ||
    env.VSCODE_REMOTE_CONTAINERS_SESSION
  ) {
    return true;
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  if (options.hasSystemXdgOpen === false) return true;
  return false;
}

/** 异步检测当前 Linux 环境是否应启用浏览器桥接（在未知时自动探测系统是否存在 `xdg-open`）。 */
export async function shouldEnableBrowserBridgeAsync(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'linux') return false;
  if (shouldEnableBrowserBridge({ platform, env })) return true;
  const located = await locateExecutable('xdg-open', { env, platform });
  return located.kind !== 'found';
}

/**
 * 若链接指向本机回环地址，则交由宿主转发端口后再保留原路径与查询参数；
 * 外部 OAuth 链接原样返回，避免破坏查询参数编码。
 */
export async function resolveBrowserUrl(
  rawUrl: string,
  resolveExternalOrigin?: (origin: string) => Promise<string>,
  log?: (line: string) => void,
): Promise<string> {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed || !resolveExternalOrigin || !isLoopbackHost(parsed.hostname)) return rawUrl;
  try {
    const forwarded = (await resolveExternalOrigin(`${parsed.origin}/`)).replace(/\/+$/u, '');
    if (!forwarded) return rawUrl;
    return `${forwarded}${rawUrl.slice(parsed.origin.length)}`;
  } catch (error) {
    log?.(`转发回环地址端口失败，直接打开原地址：${error instanceof Error ? error.message : String(error)}`);
    return rawUrl;
  }
}

const OSC8_HYPERLINK = /\u001b\]8;[^;\u0007\u001b]*;(https?:\/\/[^\u0007\u001b]+)(?:\u0007|\u001b\\)/giu;
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const HTTP_URL_RE = /https?:\/\/[^\s"'<>`]+/giu;

function cleanExtractedUrl(raw: string): string | undefined {
  let candidate = raw.trim();
  // 去掉末尾常见的句末标点与不匹配的右括号/方括号
  while (candidate.length > 0) {
    const last = candidate[candidate.length - 1];
    if (last === ')' && countChar(candidate, '(') < countChar(candidate, ')')) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    if (last === ']' && countChar(candidate, '[') < countChar(candidate, ']')) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    if (/[.,;:!?'"\u3002\uff0c\uff1b\uff1a\u3001\u300b\u3011\uff09]/u.test(last ?? '')) {
      candidate = candidate.slice(0, -1);
      continue;
    }
    break;
  }
  return parseHttpUrl(candidate) ? candidate : undefined;
}

function countChar(text: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ch) count++;
  }
  return count;
}

/** 从一段终端输出文本中提取合法的 HTTP/HTTPS 链接（兼容 ANSI 颜色码与 OSC-8 超链接）。 */
export function extractHttpUrls(text: string): string[] {
  const seen = new Set<string>();
  const add = (raw: string) => {
    const cleaned = cleanExtractedUrl(raw);
    if (cleaned) seen.add(cleaned);
  };
  for (const match of text.matchAll(OSC8_HYPERLINK)) {
    if (match[1]) add(match[1]);
  }
  const plain = text.replace(ANSI_OSC, ' ').replace(ANSI_CSI, '');
  for (const match of plain.matchAll(HTTP_URL_RE)) {
    add(match[0]);
  }
  return [...seen];
}

/**
 * 从登录过程中的 stderr / 非 JSON stdout 提取可打开的登录链接。
 * 忽略本机回环地址，避免误打开 CLI 打印的 "Callback server listening on http://127.0.0.1:.../callback"。
 */
export function extractAuthUrlsFromOutput(line: string): string[] {
  return extractHttpUrls(line).filter((url) => {
    const parsed = parseHttpUrl(url);
    return parsed !== undefined && !isLoopbackHost(parsed.hostname);
  });
}

const AUTH_URL_KEY_RE =
  /^(?:url|uri|href|link|auth[_-]?url|login[_-]?url|open[_-]?url|verification[_-]?uri(?:[_-]?complete)?)$/iu;

/** 从 ACP 通知载荷中递归提取常见登录链接字段里的 HTTP/HTTPS URL。 */
export function extractUrlsFromPayload(payload: unknown, maxDepth = 4): string[] {
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > maxDepth || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string' && AUTH_URL_KEY_RE.test(key)) {
        const cleaned = cleanExtractedUrl(entry);
        if (cleaned) seen.add(cleaned);
      } else if (entry && typeof entry === 'object') {
        walk(entry, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return [...seen];
}

/** 用于日志的脱敏链接摘要：只展示 origin 与 pathname，不输出 query/hash 中的 OAuth state/code/token。 */
export function formatUrlForLog(rawUrl: string): string {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return '<invalid-url>';
  return `${parsed.origin}${parsed.pathname}`;
}

export interface BrowserBridgeOptions {
  readonly storageRoot?: string;
  readonly nodeExecPath?: string;
  readonly onOpenUrl: (url: string) => void | Promise<void>;
  readonly log?: (line: string) => void;
}

export interface PatchEnvOptions {
  /** 用户在底层配置里显式设置了 BROWSER 时保留用户值，只补充 PATH 中的 xdg-open/wslview shim。 */
  readonly preserveBrowser?: boolean;
}

const SHELL_UNSAFE_PATH_RE = /[\s"'`$\\]/u;

async function resolveShimDir(storageRoot?: string): Promise<{ readonly dir: string; readonly ownedTemp: boolean }> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const candidates: string[] = [];
  if (storageRoot && !SHELL_UNSAFE_PATH_RE.test(storageRoot)) {
    candidates.push(join(storageRoot, 'browser-bridge'));
  }
  const tmpBase = tmpdir();
  if (!SHELL_UNSAFE_PATH_RE.test(tmpBase)) {
    candidates.push(join(tmpBase, `harness-deck-browser-${uid ?? 'user'}`));
  }

  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const info = lstatSync(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (uid !== undefined && info.uid !== uid) continue;
      return { dir, ownedTemp: false };
    } catch {
      // try next candidate
    }
  }

  const created = await mkdtemp(join(tmpdir(), 'harness-deck-browser-'));
  await chmod(created, 0o700).catch(() => undefined);
  return { dir: created, ownedTemp: true };
}

async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, content, { encoding: 'utf8', mode });
  await chmod(tmpPath, mode);
  await rename(tmpPath, filePath);
}

function tokenEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 进程级浏览器桥接服务。
 * 供子进程在 WSL / Remote-SSH / 无桌面 Linux 中通过 `$BROWSER` / `xdg-open` / `wslview` 唤起宿主浏览器。
 */
export class BrowserBridge {
  private server: Server | undefined;
  private bridgeUrl: string | undefined;
  private binDir: string | undefined;
  private ownedTempDir = false;
  private readonly token = randomBytes(24).toString('hex');
  private readonly nodeExecPath: string;
  private starting: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: BrowserBridgeOptions) {
    this.nodeExecPath = options.nodeExecPath ?? process.execPath;
  }

  get running(): boolean {
    return this.server !== undefined && this.bridgeUrl !== undefined && this.binDir !== undefined && !this.disposed;
  }

  get directory(): string | undefined {
    return this.binDir;
  }

  get endpoint(): string | undefined {
    return this.bridgeUrl;
  }

  get authToken(): string {
    return this.token;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('BrowserBridge has been disposed');
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const { dir, ownedTemp } = await resolveShimDir(this.options.storageRoot);
    if (this.disposed) {
      if (ownedTemp) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    await atomicWriteFile(join(dir, 'browser-open.cjs'), SHIM_SCRIPT_CJS, 0o644);
    await Promise.all(
      SHIM_COMMANDS.map((name) => atomicWriteFile(join(dir, name), SHIM_WRAPPER, 0o755)),
    );

    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    if (this.disposed) {
      server.close();
      if (ownedTemp) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== 'number') {
      server.close();
      throw new Error('Failed to bind BrowserBridge server');
    }
    this.server = server;
    this.binDir = dir;
    this.ownedTempDir = ownedTemp;
    this.bridgeUrl = `http://127.0.0.1:${address.port}/open`;
  }

  /** 将桥接环境变量和 shim PATH 合并到子进程环境中（不修改原对象）。 */
  patchEnv(
    env: Readonly<Record<string, string | undefined>>,
    options: PatchEnvOptions = {},
  ): Record<string, string | undefined> {
    if (!this.running || !this.binDir || !this.bridgeUrl) return { ...env };
    const next: Record<string, string | undefined> = { ...env };
    const currentPath = next.PATH ?? '';
    const entries = currentPath.split(delimiter).filter((entry) => entry && entry !== this.binDir);
    next.PATH = [this.binDir, ...entries].join(delimiter);
    next.HARNESS_DECK_BROWSER_BRIDGE_URL = this.bridgeUrl;
    next.HARNESS_DECK_BROWSER_BRIDGE_TOKEN = this.token;
    next.HARNESS_DECK_BROWSER_BRIDGE_BIN = this.binDir;
    next.HARNESS_DECK_BROWSER_NODE = this.nodeExecPath;
    if (!options.preserveBrowser) {
      const existingBrowser = next.BROWSER?.trim();
      if (existingBrowser && !existingBrowser.startsWith(`${this.binDir}/`)) {
        next.HARNESS_DECK_BROWSER_ORIGINAL = existingBrowser;
      }
      next.BROWSER = join(this.binDir, 'browser-open');
    }
    return next;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const server = this.server;
    const ownedDir = this.ownedTempDir ? this.binDir : undefined;
    this.server = undefined;
    this.bridgeUrl = undefined;
    this.binDir = undefined;
    this.ownedTempDir = false;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (ownedDir) {
      await rm(ownedDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, payload: Record<string, unknown>) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== 'POST' || req.url !== '/open') {
      send(404, { ok: false, error: 'not_found' });
      return;
    }

    const rawToken = req.headers['x-harness-deck-token'];
    const headerToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (!headerToken || !tokenEquals(this.token, headerToken)) {
      send(401, { ok: false, error: 'unauthorized' });
      return;
    }

    let parsedBody: { url?: unknown };
    try {
      const raw = await readJsonBody(req);
      parsedBody = JSON.parse(raw) as { url?: unknown };
    } catch {
      send(400, { ok: false, error: 'invalid_body' });
      return;
    }

    const url = typeof parsedBody?.url === 'string' ? parsedBody.url.trim() : '';
    if (!parseHttpUrl(url)) {
      send(400, { ok: false, error: 'invalid_url' });
      return;
    }

    // 立即返回 200，避免宿主弹「是否打开外部网站」确认框时阻塞子进程或导致 shim 超时
    send(200, { ok: true });
    try {
      await this.options.onOpenUrl(url);
    } catch (error) {
      this.options.log?.(`宿主打开浏览器链接失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

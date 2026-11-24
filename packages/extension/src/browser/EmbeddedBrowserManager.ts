/**
 * 宿主内置浏览器管理器（EmbeddedBrowserManager）：
 * - 基于真实 Chromium / Chrome / Edge + Chrome DevTools Protocol (CDP)，无 X-Frame-Options / 跨域限制；
 * - 向 Webview 实时推送 `Page.startScreencast` JPEG 画面，并把用户的鼠标/滚轮/键盘事件原样透传给浏览器；
 * - 向内置 MCP Server 暴露高可靠 AI 自动化原语（navigate / snapshot / click / type / press_key / scroll / screenshot / evaluate / console / wait），
 *   让用户与 AI 共享同一个实时可见、可交互的浏览器会话。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserAiActionView,
  BrowserConsoleEntry,
  BrowserState,
  BrowserStatus,
  BrowserViewportPreset,
} from '@harness-deck/shared';
import { CdpClient } from './CdpClient.ts';

const MAX_CONSOLE_LOGS = 80;
const FRAME_MIN_INTERVAL_MS = 50;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 720;

export interface BrowserFramePayload {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly timestamp: number;
}

export interface BrowserMouseInput {
  readonly action: 'move' | 'down' | 'up' | 'wheel';
  readonly x: number;
  readonly y: number;
  readonly button?: 'left' | 'middle' | 'right' | 'none';
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers?: number;
}

export interface BrowserKeyInput {
  readonly action: 'down' | 'up' | 'char';
  readonly key: string;
  readonly code?: string;
  readonly text?: string;
  readonly modifiers?: number;
}

export interface BrowserSnapshotElement {
  readonly ref: string;
  readonly tag: string;
  readonly role?: string;
  readonly name: string;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly href?: string;
  readonly disabled?: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserPageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly text: string;
  readonly elements: readonly BrowserSnapshotElement[];
}

const KEY_CODE_MAP: Readonly<Record<string, { readonly keyCode: number; readonly code: string; readonly text?: string }>> = {
  Enter: { keyCode: 13, code: 'Enter', text: '\r' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  Tab: { keyCode: 9, code: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape' },
  Delete: { keyCode: 46, code: 'Delete' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  Home: { keyCode: 36, code: 'Home' },
  End: { keyCode: 35, code: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown' },
  ' ': { keyCode: 32, code: 'Space', text: ' ' },
};

/** 规范化用户或 AI 输入的网址；禁止危险协议（javascript:/file:/chrome: 等）。 */
export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'about:blank';
  if (/^about:blank$/iu.test(trimmed)) return 'about:blank';

  if (
    /^localhost(?::\d+)?(?:\/|$)/iu.test(trimmed) ||
    /^127\.0\.0\.1(?::\d+)?(?:\/|$)/u.test(trimmed) ||
    /^\[::1\](?::\d+)?(?:\/|$)/u.test(trimmed) ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/u.test(trimmed) ||
    /^[a-z0-9.-]+:\d+(?:\/|$)/iu.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      return trimmed;
    }
    throw new Error(`Unsupported URL scheme: ${scheme}:`);
  }

  return `https://${trimmed}`;
}

function findInPath(commands: readonly string[], platform: NodeJS.Platform): string | undefined {
  const finder = platform === 'win32' ? 'where' : 'which';
  for (const cmd of commands) {
    try {
      const res = spawnSync(finder, [cmd], { encoding: 'utf8', timeout: 1_500, windowsHide: true });
      if (res.status === 0 && res.stdout) {
        const first = res.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find(Boolean);
        if (first && existsSync(first)) return first;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function findPlaywrightOrPuppeteerBrowser(platform: NodeJS.Platform, home: string): string | undefined {
  const roots = [
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(home, 'AppData', 'Local', 'ms-playwright'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const dirs = readdirSync(root)
        .filter((name) => name.startsWith('chromium-'))
        .sort()
        .reverse();
      for (const dir of dirs) {
        const candidates =
          platform === 'darwin'
            ? [
                join(root, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                join(root, dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
              ]
            : platform === 'win32'
              ? [join(root, dir, 'chrome-win', 'chrome.exe')]
              : [join(root, dir, 'chrome-linux', 'chrome')];
        for (const candidate of candidates) {
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** 自动探测本机可用的 Chromium / Chrome / Edge 可执行文件路径（支持 Linux / macOS / Windows / WSL2 / Playwright 缓存）。 */
export function discoverBrowserExecutable(options?: {
  readonly configuredPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}): string | undefined {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? homedir();

  const explicitCandidates = [
    options?.configuredPath?.trim(),
    env.CHROME_PATH?.trim(),
    env.CHROMIUM_PATH?.trim(),
    env.PUPPETEER_EXECUTABLE_PATH?.trim(),
  ].filter((v): v is string => Boolean(v));

  for (const candidate of explicitCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const staticCandidates: string[] = [];
  if (platform === 'darwin') {
    staticCandidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localApp = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    staticCandidates.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else {
    staticCandidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium',
      // WSL2 宿主机 Windows 浏览器回退
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    );
  }

  for (const candidate of staticCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const fromPath = findInPath(
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'],
    platform,
  );
  if (fromPath) return fromPath;

  return findPlaywrightOrPuppeteerBrowser(platform, home);
}

function toWslWindowsPath(linuxPath: string): string | undefined {
  try {
    const res = spawnSync('wslpath', ['-w', linuxPath], { encoding: 'utf8', timeout: 1_500 });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  } catch {
    // ignore
  }
  return undefined;
}

const SNAPSHOT_SCRIPT = `(() => {
  const maxElements = __MAX_ELEMENTS__;
  const selectors = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="combobox"]',
    '[contenteditable="true"]',
  ].join(',');

  document.querySelectorAll('[data-hd-ref]').forEach((el) => el.removeAttribute('data-hd-ref'));

  const nodes = Array.from(document.querySelectorAll(selectors));
  const elements = [];
  let seq = 1;

  for (const el of nodes) {
    if (elements.length >= maxElements) break;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight * 2.5 || rect.left > window.innerWidth * 2) continue;

    const ref = 'e' + seq++;
    el.setAttribute('data-hd-ref', ref);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || undefined;
    const ariaLabel = el.getAttribute('aria-label') || '';
    const titleAttr = el.getAttribute('title') || '';
    const placeholder = el.getAttribute('placeholder') || undefined;
    const textContent = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const name = (ariaLabel || textContent || placeholder || titleAttr || el.getAttribute('name') || '').slice(0, 120);
    const type = el.getAttribute('type') || undefined;
    const href = tag === 'a' ? (el.getAttribute('href') || '').slice(0, 200) : undefined;
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    const rawValue = isInput ? String(el.value ?? '') : undefined;
    const value = rawValue !== undefined ? (type === 'password' ? '***' : rawValue.slice(0, 120)) : undefined;
    const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');

    elements.push({
      ref,
      tag,
      ...(role ? { role } : {}),
      name,
      ...(type ? { type } : {}),
      ...(value !== undefined && value !== '' ? { value } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(href ? { href } : {}),
      ...(disabled ? { disabled: true } : {}),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }

  const rawText = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const text = rawText.length > 4000 ? rawText.slice(0, 4000) + '…' : rawText;

  return {
    url: window.location.href,
    title: document.title || '',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    text,
    elements,
  };
})()`;

export interface EmbeddedBrowserManagerOptions {
  readonly storageRoot: string;
  readonly onStateChange: (state: BrowserState) => void;
  readonly onFrame: (frame: BrowserFramePayload) => void;
  readonly onAiActivity?: (action: BrowserAiActionView) => void;
  readonly onAiEnabledChange?: (enabled: boolean) => void;
  readonly configuredExecutablePath?: () => string | undefined;
  readonly initialAiEnabled?: boolean;
  readonly log?: (line: string) => void;
}

export class EmbeddedBrowserManager {
  private status: BrowserStatus = 'stopped';
  private url = 'about:blank';
  private title = '';
  private loading = false;
  private canGoBack = false;
  private canGoForward = false;
  private viewportWidth = DEFAULT_WIDTH;
  private viewportHeight = DEFAULT_HEIGHT;
  private viewportPreset: BrowserViewportPreset = 'responsive';
  private aiEnabled: boolean;
  private mcpUrl?: string;
  private cdpUrl?: string;
  private executablePath?: string;
  private detectedExecutable?: string;
  private lastAiAction?: BrowserAiActionView;
  private consoleLogs: BrowserConsoleEntry[] = [];
  private consoleSeq = 0;
  private error?: string;

  private child?: ChildProcess;
  private client?: CdpClient;
  private lastFrame?: BrowserFramePayload;
  private pendingFrame?: BrowserFramePayload;
  private lastFrameSentAt = 0;
  private frameFlushTimer?: ReturnType<typeof setTimeout>;
  private launching?: Promise<BrowserState>;
  private disposed = false;

  constructor(private readonly options: EmbeddedBrowserManagerOptions) {
    this.aiEnabled = options.initialAiEnabled ?? true;
    this.detectedExecutable = discoverBrowserExecutable({
      configuredPath: options.configuredExecutablePath?.(),
    });
  }

  getState(): BrowserState {
    return {
      status: this.status,
      url: this.url,
      title: this.title,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      viewportPreset: this.viewportPreset,
      aiEnabled: this.aiEnabled,
      ...(this.mcpUrl ? { mcpUrl: this.mcpUrl } : {}),
      ...(this.cdpUrl ? { cdpUrl: this.cdpUrl } : {}),
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
      ...(this.detectedExecutable ? { detectedExecutable: this.detectedExecutable } : {}),
      ...(this.lastAiAction ? { lastAiAction: this.lastAiAction } : {}),
      consoleLogs: [...this.consoleLogs],
      ...(this.error ? { error: this.error } : {}),
    };
  }

  getLastFrame(): BrowserFramePayload | undefined {
    return this.lastFrame;
  }

  isAiEnabled(): boolean {
    return this.aiEnabled;
  }

  setAiEnabled(enabled: boolean): void {
    if (this.aiEnabled === enabled) return;
    this.aiEnabled = enabled;
    this.emitState();
    this.options.onAiEnabledChange?.(enabled);
  }

  setMcpUrl(url: string | undefined): void {
    if (this.mcpUrl === url) return;
    this.mcpUrl = url;
    this.emitState();
  }

  clearConsole(): void {
    this.consoleLogs = [];
    this.emitState();
  }

  async ensureRunning(url?: string): Promise<void> {
    if (this.status === 'running' && this.client?.connected) {
      return;
    }
    const next = await this.launch(url ? { url } : undefined);
    if (next.status !== 'running' || !this.client?.connected) {
      throw new Error(next.error || 'Failed to launch embedded browser');
    }
  }

  async launch(params?: {
    readonly url?: string;
    readonly cdpUrl?: string;
    readonly executablePath?: string;
    readonly width?: number;
    readonly height?: number;
  }): Promise<BrowserState> {
    if (this.launching) return this.launching;
    this.launching = this.doLaunch(params).finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async doLaunch(params?: {
    readonly url?: string;
    readonly cdpUrl?: string;
    readonly executablePath?: string;
    readonly width?: number;
    readonly height?: number;
  }): Promise<BrowserState> {
    await this.stopInternal(false);

    if (params?.width) this.viewportWidth = Math.max(320, Math.min(2_560, Math.round(params.width)));
    if (params?.height) this.viewportHeight = Math.max(240, Math.min(2_000, Math.round(params.height)));

    let targetUrl = 'about:blank';
    if (params?.url?.trim()) {
      try {
        targetUrl = normalizeBrowserUrl(params.url);
      } catch (err) {
        this.status = 'error';
        this.error = err instanceof Error ? err.message : String(err);
        this.emitState();
        return this.getState();
      }
    }

    this.status = 'starting';
    this.error = undefined;
    this.loading = true;
    this.emitState();

    try {
      let cdpHttpOrigin: string;
      const requestedCdp = params?.cdpUrl?.trim();

      if (requestedCdp) {
        cdpHttpOrigin = requestedCdp.replace(/\/+$/u, '');
        this.executablePath = cdpHttpOrigin;
      } else {
        const execPath = discoverBrowserExecutable({
          configuredPath: params?.executablePath?.trim() || this.options.configuredExecutablePath?.(),
        });
        this.detectedExecutable = execPath;
        if (!execPath) {
          throw new Error(
            '未检测到本地 Chrome / Edge / Chromium 浏览器。请在连接设置中指定浏览器路径，或连接到已开启 --remote-debugging-port 的 CDP 地址。',
          );
        }
        this.executablePath = execPath;
        cdpHttpOrigin = await this.spawnChromium(execPath);
      }

      const pageWsUrl = await this.resolvePageTargetWsUrl(cdpHttpOrigin);
      const client = await CdpClient.connect(pageWsUrl);
      this.client = client;
      this.cdpUrl = cdpHttpOrigin;

      client.onClose(() => {
        if (this.client !== client) return;
        this.client = undefined;
        if (!this.disposed && this.status !== 'stopped') {
          this.status = 'stopped';
          this.loading = false;
          this.cdpUrl = undefined;
          this.emitState();
        }
      });

      this.wireCdpEvents(client);

      await Promise.all([
        client.send('Page.enable'),
        client.send('Runtime.enable'),
        client.send('Emulation.setDeviceMetricsOverride', {
          width: this.viewportWidth,
          height: this.viewportHeight,
          deviceScaleFactor: 1,
          mobile: this.viewportPreset === 'mobile',
        }),
      ]);

      await this.startScreencast(client);

      this.status = 'running';
      this.loading = false;
      this.error = undefined;
      this.emitState();

      if (targetUrl !== 'about:blank') {
        await this.navigate(targetUrl);
      } else {
        await this.syncNavigationState();
      }

      return this.getState();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.options.log?.(`EmbeddedBrowser launch failed: ${msg}`);
      await this.stopInternal(false);
      this.status = 'error';
      this.error = msg;
      this.loading = false;
      this.emitState();
      return this.getState();
    }
  }

  async stop(): Promise<void> {
    await this.stopInternal(true);
  }

  private async stopInternal(emit: boolean): Promise<void> {
    if (this.frameFlushTimer) {
      clearTimeout(this.frameFlushTimer);
      this.frameFlushTimer = undefined;
    }
    this.pendingFrame = undefined;

    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.send('Page.stopScreencast', undefined, 1_000).catch(() => undefined);
      } catch {
        // ignore
      }
      client.close();
    }

    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    this.status = 'stopped';
    this.loading = false;
    this.cdpUrl = undefined;
    this.lastFrame = undefined;
    if (emit && !this.disposed) {
      this.emitState();
    }
  }

  async navigate(rawUrl: string): Promise<{ readonly url: string; readonly title: string }> {
    const normalized = normalizeBrowserUrl(rawUrl);
    await this.ensureRunning();
    const client = this.requireClient();

    this.loading = true;
    this.url = normalized;
    this.error = undefined;
    this.emitState();

    const loadPromise = this.waitForLoadEvent(client, 15_000);
    const navResult = await client.send<{ frameId?: string; errorText?: string }>('Page.navigate', { url: normalized });
    if (navResult.errorText) {
      this.loading = false;
      this.error = navResult.errorText;
      this.emitState();
      throw new Error(`Navigation failed: ${navResult.errorText}`);
    }
    await loadPromise;
    await this.syncNavigationState();
    await this.captureQuickFrame();
    return { url: this.url, title: this.title };
  }

  async goBack(): Promise<{ readonly url: string; readonly title: string }> {
    const client = this.requireClient();
    const history = await client.send<{
      currentIndex: number;
      entries: readonly { id: number; url: string; title: string }[];
    }>('Page.getNavigationHistory');
    if (history.currentIndex > 0) {
      const target = history.entries[history.currentIndex - 1];
      if (target) {
        this.loading = true;
        this.emitState();
        const loadPromise = this.waitForLoadEvent(client, 10_000);
        await client.send('Page.navigateToHistoryEntry', { entryId: target.id });
        await loadPromise;
        await this.syncNavigationState();
      }
    }
    return { url: this.url, title: this.title };
  }

  async goForward(): Promise<{ readonly url: string; readonly title: string }> {
    const client = this.requireClient();
    const history = await client.send<{
      currentIndex: number;
      entries: readonly { id: number; url: string; title: string }[];
    }>('Page.getNavigationHistory');
    if (history.currentIndex + 1 < history.entries.length) {
      const target = history.entries[history.currentIndex + 1];
      if (target) {
        this.loading = true;
        this.emitState();
        const loadPromise = this.waitForLoadEvent(client, 10_000);
        await client.send('Page.navigateToHistoryEntry', { entryId: target.id });
        await loadPromise;
        await this.syncNavigationState();
      }
    }
    return { url: this.url, title: this.title };
  }

  async reload(): Promise<{ readonly url: string; readonly title: string }> {
    const client = this.requireClient();
    this.loading = true;
    this.emitState();
    const loadPromise = this.waitForLoadEvent(client, 15_000);
    await client.send('Page.reload', { ignoreCache: false });
    await loadPromise;
    await this.syncNavigationState();
    await this.captureQuickFrame();
    return { url: this.url, title: this.title };
  }

  async resize(width: number, height: number, preset?: BrowserViewportPreset): Promise<void> {
    const nextW = Math.max(320, Math.min(2_560, Math.round(width)));
    const nextH = Math.max(240, Math.min(2_000, Math.round(height)));
    const nextPreset = preset ?? this.viewportPreset;
    if (nextW === this.viewportWidth && nextH === this.viewportHeight && nextPreset === this.viewportPreset) {
      return;
    }
    this.viewportWidth = nextW;
    this.viewportHeight = nextH;
    this.viewportPreset = nextPreset;
    this.emitState();

    if (!this.client?.connected) return;
    try {
      await this.client.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewportWidth,
        height: this.viewportHeight,
        deviceScaleFactor: 1,
        mobile: this.viewportPreset === 'mobile',
      });
      await this.client.send('Page.stopScreencast').catch(() => undefined);
      await this.startScreencast(this.client);
    } catch {
      // ignore transient resize errors
    }
  }

  async dispatchMouse(input: BrowserMouseInput): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    const x = Math.max(0, Math.min(this.viewportWidth, Math.round(input.x)));
    const y = Math.max(0, Math.min(this.viewportHeight, Math.round(input.y)));
    const modifiers = input.modifiers ?? 0;

    if (input.action === 'wheel') {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers,
      });
      return;
    }

    const typeMap = {
      move: 'mouseMoved',
      down: 'mousePressed',
      up: 'mouseReleased',
    } as const;

    await client.send('Input.dispatchMouseEvent', {
      type: typeMap[input.action],
      x,
      y,
      button: input.button ?? (input.action === 'move' ? 'none' : 'left'),
      clickCount: input.clickCount ?? (input.action === 'move' ? 0 : 1),
      modifiers,
    });
  }

  async dispatchKey(input: BrowserKeyInput): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    const modifiers = input.modifiers ?? 0;

    if (input.action === 'char') {
      const text = input.text ?? input.key;
      if (text) {
        await client.send('Input.insertText', { text });
      }
      return;
    }

    const mapped = KEY_CODE_MAP[input.key];
    const hasModifier = (modifiers & (1 | 2 | 4)) !== 0; // Alt / Ctrl / Meta

    if (input.action === 'down' && !mapped && !hasModifier && input.key.length === 1) {
      await client.send('Input.insertText', { text: input.key });
      return;
    }

    const type = input.action === 'down' ? 'rawKeyDown' : 'keyUp';
    const keyCode = mapped?.keyCode ?? (input.key.length === 1 ? input.key.toUpperCase().charCodeAt(0) : 0);

    await client.send('Input.dispatchKeyEvent', {
      type,
      key: input.key,
      code: input.code ?? mapped?.code ?? '',
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      ...(input.action === 'down' && mapped?.text && !hasModifier ? { text: mapped.text, unmodifiedText: mapped.text } : {}),
    });
  }

  // ---- AI 自动化原语（供 BrowserMcpServer 调用，实时同步画面与操作高亮） ----

  async aiNavigate(url: string): Promise<{ readonly url: string; readonly title: string }> {
    this.recordAiAction('browser_navigate', `打开 ${url}`);
    const result = await this.navigate(url);
    return result;
  }

  async aiSnapshot(maxElements = 60): Promise<BrowserPageSnapshot> {
    await this.ensureRunning();
    this.recordAiAction('browser_snapshot', '读取页面结构与可交互元素');
    const client = this.requireClient();
    const clamped = Math.max(10, Math.min(150, Math.round(maxElements)));
    const expression = SNAPSHOT_SCRIPT.replace('__MAX_ELEMENTS__', String(clamped));
    const evalRes = await client.send<{
      result?: { value?: BrowserPageSnapshot };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (evalRes.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.text || 'Failed to collect page snapshot');
    }
    const snap = evalRes.result?.value;
    if (!snap) {
      throw new Error('Empty page snapshot');
    }
    this.url = snap.url || this.url;
    this.title = snap.title || this.title;
    this.emitState();
    return snap;
  }

  async aiClick(args: {
    readonly ref?: string;
    readonly selector?: string;
    readonly x?: number;
    readonly y?: number;
    readonly button?: 'left' | 'middle' | 'right';
    readonly doubleClick?: boolean;
  }): Promise<{ readonly x: number; readonly y: number; readonly label?: string }> {
    await this.ensureRunning();
    const coords = await this.resolveTargetCoords(args);
    const button = args.button ?? 'left';
    const label = coords.label || args.ref || args.selector || `(${coords.x}, ${coords.y})`;
    this.recordAiAction('browser_click', `点击 ${label}`, coords.x, coords.y);

    await this.dispatchMouse({ action: 'move', x: coords.x, y: coords.y, button: 'none' });
    await this.dispatchMouse({ action: 'down', x: coords.x, y: coords.y, button, clickCount: 1 });
    await this.dispatchMouse({ action: 'up', x: coords.x, y: coords.y, button, clickCount: 1 });
    if (args.doubleClick) {
      await this.dispatchMouse({ action: 'down', x: coords.x, y: coords.y, button, clickCount: 2 });
      await this.dispatchMouse({ action: 'up', x: coords.x, y: coords.y, button, clickCount: 2 });
    }
    await this.sleep(120);
    await this.syncNavigationState();
    return coords;
  }

  async aiType(args: {
    readonly ref?: string;
    readonly selector?: string;
    readonly text: string;
    readonly clear?: boolean;
    readonly submit?: boolean;
  }): Promise<{ readonly typed: number }> {
    await this.ensureRunning();
    const client = this.requireClient();

    if (args.ref || args.selector) {
      const coords = await this.resolveTargetCoords({ ref: args.ref, selector: args.selector });
      this.recordAiAction('browser_type', `输入文本到 ${coords.label || args.ref || args.selector}`, coords.x, coords.y);
      await this.dispatchMouse({ action: 'move', x: coords.x, y: coords.y, button: 'none' });
      await this.dispatchMouse({ action: 'down', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
      await this.dispatchMouse({ action: 'up', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    } else {
      this.recordAiAction('browser_type', `输入文本（${args.text.length} 字符）`);
    }

    if (args.clear) {
      await client.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.activeElement;
          if (!el) return;
          if ('value' in el) {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, '');
            else el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
          }
        })()`,
      });
    }

    if (args.text) {
      await client.send('Input.insertText', { text: args.text });
    }
    if (args.submit) {
      await this.dispatchKey({ action: 'down', key: 'Enter' });
      await this.dispatchKey({ action: 'up', key: 'Enter' });
    }
    await this.sleep(100);
    await this.syncNavigationState();
    return { typed: args.text.length };
  }

  async aiPressKey(args: { readonly key: string; readonly modifiers?: number }): Promise<void> {
    await this.ensureRunning();
    this.recordAiAction('browser_press_key', `按键 ${args.key}`);
    await this.dispatchKey({ action: 'down', key: args.key, modifiers: args.modifiers });
    await this.dispatchKey({ action: 'up', key: args.key, modifiers: args.modifiers });
    await this.sleep(80);
    await this.syncNavigationState();
  }

  async aiScroll(args: {
    readonly deltaY?: number;
    readonly deltaX?: number;
    readonly x?: number;
    readonly y?: number;
    readonly selector?: string;
  }): Promise<void> {
    await this.ensureRunning();
    const deltaX = args.deltaX ?? 0;
    const deltaY = args.deltaY ?? 480;
    let x = args.x ?? Math.round(this.viewportWidth / 2);
    let y = args.y ?? Math.round(this.viewportHeight / 2);
    if (args.selector) {
      const resolved = await this.resolveTargetCoords({ selector: args.selector });
      x = resolved.x;
      y = resolved.y;
    }
    this.recordAiAction('browser_scroll', `滚动 (${deltaX}, ${deltaY})`, x, y);
    await this.dispatchMouse({ action: 'wheel', x, y, deltaX, deltaY });
    await this.sleep(120);
  }

  async aiScreenshot(args?: { readonly fullPage?: boolean }): Promise<{
    readonly data: string;
    readonly mimeType: 'image/png';
    readonly url: string;
    readonly title: string;
    readonly width: number;
    readonly height: number;
  }> {
    await this.ensureRunning();
    this.recordAiAction('browser_screenshot', args?.fullPage ? '截取整页画面' : '截取当前视口画面');
    const client = this.requireClient();
    const res = await client.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      ...(args?.fullPage ? { captureBeyondViewport: true } : {}),
    });
    return {
      data: res.data,
      mimeType: 'image/png',
      url: this.url,
      title: this.title,
      width: this.viewportWidth,
      height: this.viewportHeight,
    };
  }

  async aiEvaluate(expression: string): Promise<{ readonly value?: unknown; readonly error?: string }> {
    await this.ensureRunning();
    this.recordAiAction('browser_evaluate', '执行页面脚本');
    const client = this.requireClient();
    const res = await client.send<{
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      return { error: res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluation failed' };
    }
    return { value: res.result?.value !== undefined ? res.result.value : res.result?.description };
  }

  aiConsole(args?: { readonly limit?: number; readonly level?: string }): readonly BrowserConsoleEntry[] {
    const limit = Math.max(1, Math.min(MAX_CONSOLE_LOGS, args?.limit ?? 30));
    const filtered = args?.level
      ? this.consoleLogs.filter((entry) => entry.level === args.level)
      : this.consoleLogs;
    return filtered.slice(-limit);
  }

  async aiWait(args: {
    readonly ms?: number;
    readonly selector?: string;
    readonly text?: string;
    readonly timeoutMs?: number;
  }): Promise<{ readonly matched: boolean }> {
    await this.ensureRunning();
    const timeoutMs = Math.max(100, Math.min(30_000, args.timeoutMs ?? 8_000));
    if (!args.selector && !args.text) {
      const waitMs = Math.max(50, Math.min(15_000, args.ms ?? 1_000));
      this.recordAiAction('browser_wait', `等待 ${waitMs}ms`);
      await this.sleep(waitMs);
      return { matched: true };
    }
    this.recordAiAction('browser_wait', `等待 ${args.selector || args.text}`);
    const client = this.requireClient();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const checkExpr = args.selector
        ? `Boolean(document.querySelector(${JSON.stringify(args.selector)}))`
        : `Boolean(document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(args.text ?? '')}))`;
      const res = await client.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
        expression: checkExpr,
        returnByValue: true,
      });
      if (res.result?.value) {
        return { matched: true };
      }
      await this.sleep(200);
    }
    return { matched: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopInternal(false);
  }

  // ---- 内部实现 ----

  private requireClient(): CdpClient {
    if (!this.client?.connected) {
      throw new Error('Embedded browser is not running');
    }
    return this.client;
  }

  private recordAiAction(tool: string, summary: string, x?: number, y?: number): void {
    const action: BrowserAiActionView = {
      tool,
      summary,
      at: Date.now(),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
    };
    this.lastAiAction = action;
    this.emitState();
    this.options.onAiActivity?.(action);
  }

  private async resolveTargetCoords(args: {
    readonly ref?: string;
    readonly selector?: string;
    readonly x?: number;
    readonly y?: number;
  }): Promise<{ readonly x: number; readonly y: number; readonly label?: string }> {
    if (args.x !== undefined && args.y !== undefined) {
      return { x: Math.round(args.x), y: Math.round(args.y) };
    }
    const selector = args.ref
      ? `[data-hd-ref=${JSON.stringify(args.ref.replace(/^@/u, ''))}]`
      : args.selector?.trim();
    if (!selector) {
      throw new Error('Please provide ref, selector, or (x, y) coordinates');
    }
    const client = this.requireClient();
    const res = await client.send<{
      result?: { value?: { found: boolean; x?: number; y?: number; label?: string } };
    }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
        return {
          found: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          label,
        };
      })()`,
      returnByValue: true,
    });
    const value = res.result?.value;
    if (!value?.found || value.x === undefined || value.y === undefined) {
      throw new Error(`Element not found: ${args.ref || selector}`);
    }
    return { x: value.x, y: value.y, ...(value.label ? { label: value.label } : {}) };
  }

  private async spawnChromium(execPath: string): Promise<string> {
    const profileDir = join(this.options.storageRoot, 'browser-profile');
    await mkdir(profileDir, { recursive: true });

    const isWslWinExe = process.platform === 'linux' && /\.exe$/iu.test(execPath);
    const userDataDirArg = isWslWinExe ? toWslWindowsPath(profileDir) : profileDir;

    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-popup-blocking',
      `--window-size=${this.viewportWidth},${this.viewportHeight}`,
      ...(userDataDirArg ? [`--user-data-dir=${userDataDirArg}`] : []),
      'about:blank',
    ];

    const child = spawn(execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const cdpOrigin = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let stderrBuf = '';

      const finish = (err?: Error, origin?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(origin!);
      };

      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for Chromium CDP endpoint (${stderrBuf.slice(-240)})`));
      }, 15_000);

      const handleChunk = (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 8_192) stderrBuf = stderrBuf.slice(-8_192);
        const match = /DevTools listening on ws:\/\/([^/\s]+)/u.exec(stderrBuf);
        if (match?.[1]) {
          finish(undefined, `http://${match[1]}`);
        }
      };

      child.stderr?.on('data', handleChunk);
      child.stdout?.on('data', handleChunk);
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = undefined;
        finish(new Error(`Browser exited early (code=${String(code)}, signal=${String(signal)}): ${stderrBuf.slice(-200)}`));
      });
    });

    child.once('exit', () => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!this.disposed && this.status !== 'stopped') {
        void this.stopInternal(true);
      }
    });

    return cdpOrigin;
  }

  private async resolvePageTargetWsUrl(cdpHttpOrigin: string): Promise<string> {
    const listUrl = `${cdpHttpOrigin}/json/list`;
    const res = await fetch(listUrl);
    if (!res.ok) {
      throw new Error(`CDP /json/list failed (${res.status})`);
    }
    const targets = (await res.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) {
      return page.webSocketDebuggerUrl;
    }
    const createRes = await fetch(`${cdpHttpOrigin}/json/new?about:blank`, { method: 'PUT' });
    if (createRes.ok) {
      const created = (await createRes.json()) as { webSocketDebuggerUrl?: string };
      if (created.webSocketDebuggerUrl) return created.webSocketDebuggerUrl;
    }
    throw new Error('No debuggable browser page target available');
  }

  private wireCdpEvents(client: CdpClient): void {
    client.on('Page.screencastFrame', (params) => {
      const data = typeof params.data === 'string' ? params.data : '';
      const sessionId = typeof params.sessionId === 'number' ? params.sessionId : undefined;
      const meta = (params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined) ?? {};
      if (sessionId !== undefined) {
        void client.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      }
      if (!data) return;
      this.enqueueFrame({
        data,
        width: meta.deviceWidth ?? this.viewportWidth,
        height: meta.deviceHeight ?? this.viewportHeight,
        timestamp: Date.now(),
      });
    });

    client.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && frame.url) {
        this.url = frame.url;
        this.emitState();
        void this.syncNavigationState();
      }
    });

    client.on('Page.loadEventFired', () => {
      this.loading = false;
      void this.syncNavigationState();
    });

    client.on('Page.javascriptDialogOpening', () => {
      void client.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    });

    client.on('Runtime.consoleAPICalled', (params) => {
      const rawType = typeof params.type === 'string' ? params.type : 'log';
      const level: BrowserConsoleEntry['level'] =
        rawType === 'error' || rawType === 'assert'
          ? 'error'
          : rawType === 'warning'
            ? 'warn'
            : rawType === 'info'
              ? 'info'
              : 'log';
      const args = Array.isArray(params.args) ? (params.args as { value?: unknown; description?: string }[]) : [];
      const text = args
        .map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? ''))
        .filter(Boolean)
        .join(' ')
        .slice(0, 500);
      if (text) this.pushConsole(level, text);
    });

    client.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      const text = (details?.exception?.description || details?.text || 'Uncaught exception').slice(0, 500);
      this.pushConsole('error', text);
    });
  }

  private async startScreencast(client: CdpClient): Promise<void> {
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 75,
      maxWidth: this.viewportWidth,
      maxHeight: this.viewportHeight,
      everyNthFrame: 1,
    });
  }

  private async captureQuickFrame(): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    try {
      const res = await client.send<{ data?: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 75 }, 5_000);
      if (res.data) {
        this.enqueueFrame({
          data: res.data,
          width: this.viewportWidth,
          height: this.viewportHeight,
          timestamp: Date.now(),
        });
      }
    } catch {
      // ignore
    }
  }

  private enqueueFrame(frame: BrowserFramePayload): void {
    this.lastFrame = frame;
    const now = Date.now();
    const elapsed = now - this.lastFrameSentAt;
    if (elapsed >= FRAME_MIN_INTERVAL_MS) {
      this.lastFrameSentAt = now;
      this.pendingFrame = undefined;
      if (this.frameFlushTimer) {
        clearTimeout(this.frameFlushTimer);
        this.frameFlushTimer = undefined;
      }
      this.options.onFrame(frame);
      return;
    }
    this.pendingFrame = frame;
    if (!this.frameFlushTimer) {
      this.frameFlushTimer = setTimeout(() => {
        this.frameFlushTimer = undefined;
        const latest = this.pendingFrame;
        this.pendingFrame = undefined;
        if (latest && !this.disposed) {
          this.lastFrameSentAt = Date.now();
          this.options.onFrame(latest);
        }
      }, FRAME_MIN_INTERVAL_MS - elapsed);
    }
  }

  private async syncNavigationState(): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    try {
      const history = await client.send<{
        currentIndex: number;
        entries: readonly { id: number; url: string; title: string }[];
      }>('Page.getNavigationHistory', undefined, 5_000);
      const current = history.entries[history.currentIndex];
      if (current) {
        this.url = current.url || this.url;
        this.title = current.title || '';
      }
      this.canGoBack = history.currentIndex > 0;
      this.canGoForward = history.currentIndex + 1 < history.entries.length;
      this.loading = false;
      this.emitState();
    } catch {
      // ignore
    }
  }

  private waitForLoadEvent(client: CdpClient, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubLoad();
        unsubDom();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const unsubLoad = client.on('Page.loadEventFired', finish);
      const unsubDom = client.on('Page.domContentEventFired', () => {
        setTimeout(finish, 250);
      });
    });
  }

  private pushConsole(level: BrowserConsoleEntry['level'], text: string): void {
    this.consoleLogs = [
      ...this.consoleLogs.slice(-(MAX_CONSOLE_LOGS - 1)),
      { id: ++this.consoleSeq, level, text, timestamp: Date.now() },
    ];
    this.emitState();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emitState(): void {
    if (this.disposed) return;
    this.options.onStateChange(this.getState());
  }
}

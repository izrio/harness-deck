import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpBrowserOpener } from '../src/backend/acp.ts';
import { setLocale } from '../src/i18n.ts';
import {
  BrowserBridge,
  extractAuthUrlsFromOutput,
  extractHttpUrls,
  extractUrlsFromPayload,
  formatUrlForLog,
  isWslEnvironment,
  resolveBrowserUrl,
  shouldEnableBrowserBridge,
} from '../src/runtime/browserBridge.ts';

const execFileAsync = promisify(execFile);

describe('BrowserBridge 环境判定与链接提取', () => {
  it('WSL（含 WSLg 已设置 WAYLAND_DISPLAY）始终启用浏览器桥接', () => {
    expect(
      isWslEnvironment({ WSL_DISTRO_NAME: 'Ubuntu-22.04', WAYLAND_DISPLAY: 'wayland-0' }, 'Linux version 6.6'),
    ).toBe(true);
    expect(
      shouldEnableBrowserBridge({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu-22.04', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
        procVersion: 'Linux version 6.6.0-microsoft-standard-WSL2',
        hasSystemXdgOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldEnableBrowserBridge({
        platform: 'linux',
        env: { DISPLAY: ':0' },
        procVersion: 'Linux version 6.18.33.2-microsoft-standard-WSL2',
        hasSystemXdgOpen: true,
      }),
    ).toBe(true);
  });

  it('Remote-SSH、容器、无桌面环境与缺少 xdg-open 的 Linux 启用桥接；macOS/Windows 与正常桌面 Linux 不启用', () => {
    expect(shouldEnableBrowserBridge({ platform: 'darwin', env: {} })).toBe(false);
    expect(shouldEnableBrowserBridge({ platform: 'win32', env: {} })).toBe(false);
    expect(
      shouldEnableBrowserBridge({
        platform: 'linux',
        env: { DISPLAY: ':0' },
        procVersion: 'Linux version 6.8.0-generic',
        hasSystemXdgOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableBrowserBridge({
        platform: 'linux',
        env: { DISPLAY: ':0' },
        procVersion: 'Linux version 6.8.0-generic',
        hasSystemXdgOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldEnableBrowserBridge({
        platform: 'linux',
        env: { SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22', DISPLAY: ':10' },
        procVersion: 'Linux version 6.8.0-generic',
        hasSystemXdgOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldEnableBrowserBridge({
        platform: 'linux',
        env: {},
        procVersion: 'Linux version 6.8.0-generic',
        hasSystemXdgOpen: true,
      }),
    ).toBe(true);
  });

  it('从终端输出提取 HTTP/HTTPS 链接（支持 ANSI 颜色、OSC-8 超链接与句末标点），登录输出跳过回环回调监听地址', () => {
    const ansiLine = '\u001b[32m请打开 https://copilot.tencent.com/login?state=a=b&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcb。\u001b[0m';
    expect(extractHttpUrls(ansiLine)).toEqual([
      'https://copilot.tencent.com/login?state=a=b&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcb',
    ]);

    const osc8 = 'Click \u001b]8;;https://www.codebuddy.ai/oauth?code=123\u0007Sign in\u001b]8;;\u0007 now';
    expect(extractHttpUrls(osc8)).toEqual(['https://www.codebuddy.ai/oauth?code=123']);

    // 回环回调监听地址不应在登录输出中被误触发
    expect(extractAuthUrlsFromOutput('Callback server listening on http://127.0.0.1:54321/callback')).toEqual([]);
    expect(extractAuthUrlsFromOutput('Callback server listening on http://localhost:54321/callback')).toEqual([]);
    expect(extractAuthUrlsFromOutput('Open https://www.codebuddy.ai/login?token=abc to continue.')).toEqual([
      'https://www.codebuddy.ai/login?token=abc',
    ]);
  });

  it('从 ACP 通知载荷提取常见登录链接字段，且日志摘要自动去掉敏感 query', () => {
    expect(
      extractUrlsFromPayload({
        data: {
          authUrl: 'https://copilot.tencent.com/auth?state=secret123&code=xyz',
          ignored: 'https://should-not-match.example.com',
          nested: { verification_uri_complete: 'https://www.codebuddy.ai/device?user_code=ABCD' },
        },
      }),
    ).toEqual([
      'https://copilot.tencent.com/auth?state=secret123&code=xyz',
      'https://www.codebuddy.ai/device?user_code=ABCD',
    ]);

    expect(formatUrlForLog('https://copilot.tencent.com/auth?state=secret123&token=xyz#frag')).toBe(
      'https://copilot.tencent.com/auth',
    );
  });

  it('resolveBrowserUrl 仅转发回环地址，外部 OAuth URL 原样保留查询参数', async () => {
    const oauth = 'https://copilot.tencent.com/login?state=a=b&redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fcb';
    let called = false;
    const resolvedOauth = await resolveBrowserUrl(oauth, async (origin) => {
      called = true;
      return origin;
    });
    expect(called).toBe(false);
    expect(resolvedOauth).toBe(oauth);

    const local = 'http://127.0.0.1:4321/login?a=1&b=c=d#hash';
    const resolvedLocal = await resolveBrowserUrl(local, async () => 'https://forwarded.example.com/');
    expect(resolvedLocal).toBe('https://forwarded.example.com/login?a=1&b=c=d#hash');
  });
});

describe('BrowserBridge 端到端进程桥接', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it.skipIf(process.platform === 'win32')(
    '子进程调用 xdg-open / wslview / $BROWSER 时把完整 OAuth URL 转发给宿主，且拒绝非法令牌与非 HTTP 协议',
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'hd-bridge-test-'));
      cleanups.push(() => rm(tempRoot, { recursive: true, force: true }));

      const opened: string[] = [];
      const bridge = new BrowserBridge({
        storageRoot: tempRoot,
        onOpenUrl: (url) => {
          opened.push(url);
        },
      });
      await bridge.start();
      cleanups.push(() => bridge.dispose());

      const patched = bridge.patchEnv({ PATH: process.env.PATH });
      const oauthUrl = 'https://copilot.tencent.com/oauth/authorize?client_id=cb&state=x=y&redirect_uri=http%3A%2F%2F127.0.0.1%3A18923%2Fcallback';

      // 1. xdg-open shim
      await execFileAsync('xdg-open', [oauthUrl], { env: patched as NodeJS.ProcessEnv });
      // 2. wslview shim
      await execFileAsync('wslview', ['https://www.codebuddy.ai/login?from=wslview'], { env: patched as NodeJS.ProcessEnv });
      // 3. $BROWSER shim
      expect(patched.BROWSER).toBeTruthy();
      await execFileAsync(patched.BROWSER!, ['https://www.codebuddy.ai/login?from=env'], { env: patched as NodeJS.ProcessEnv });

      expect(opened).toEqual([
        oauthUrl,
        'https://www.codebuddy.ai/login?from=wslview',
        'https://www.codebuddy.ai/login?from=env',
      ]);

      // 4. 非法令牌返回 401，非 http(s) 协议返回 400
      const unauthorized = await fetch(bridge.endpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-harness-deck-token': 'wrong' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });
      expect(unauthorized.status).toBe(401);

      const badScheme = await fetch(bridge.endpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-harness-deck-token': bridge.authToken },
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
      });
      expect(badScheme.status).toBe(400);
      expect(opened).toHaveLength(3);
    },
  );

  it.skipIf(process.platform === 'win32')(
    '对非 HTTP(S) 参数回退到系统原 xdg-open，不触发宿主桥接且不死循环',
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'hd-bridge-fallback-'));
      cleanups.push(() => rm(tempRoot, { recursive: true, force: true }));

      const fakeSysBin = join(tempRoot, 'sysbin');
      const marker = join(tempRoot, 'fallback-arg.txt');
      await execFileAsync('mkdir', ['-p', fakeSysBin]);
      const fakeXdg = join(fakeSysBin, 'xdg-open');
      await writeFile(fakeXdg, `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\n`, { mode: 0o755 });
      await chmod(fakeXdg, 0o755);

      const opened: string[] = [];
      const bridge = new BrowserBridge({
        storageRoot: tempRoot,
        onOpenUrl: (url) => {
          opened.push(url);
        },
      });
      await bridge.start();
      cleanups.push(() => bridge.dispose());

      const patched = bridge.patchEnv({ PATH: `${fakeSysBin}:${process.env.PATH ?? ''}` });
      await execFileAsync('xdg-open', ['/tmp/demo.pdf'], { env: patched as NodeJS.ProcessEnv });

      expect(opened).toEqual([]);
      const { stdout } = await execFileAsync('cat', [marker]);
      expect(stdout).toBe('/tmp/demo.pdf');
    },
  );

  it('preserveBrowser 为 true 时保留用户显式配置的 BROWSER', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'hd-bridge-preserve-'));
    cleanups.push(() => rm(tempRoot, { recursive: true, force: true }));

    const bridge = new BrowserBridge({
      storageRoot: tempRoot,
      onOpenUrl: () => undefined,
    });
    await bridge.start();
    cleanups.push(() => bridge.dispose());

    const patched = bridge.patchEnv(
      { PATH: '/usr/bin', BROWSER: '/custom/browser' },
      { preserveBrowser: true },
    );
    expect(patched.BROWSER).toBe('/custom/browser');
    expect(patched.PATH?.startsWith(`${bridge.directory}:`)).toBe(true);
  });
});

describe('createAcpBrowserOpener 登录链接去重与兜底提示', () => {
  it('同一登录链接在桥接与 stderr 同时到达时只打开一次，打开失败时提供重试与复制链接', async () => {
    setLocale('zh');
    const opened: string[] = [];
    const copied: string[] = [];
    const messages: { level: string; text: string; actions: readonly string[] }[] = [];
    let shouldSucceed = true;

    const opener = createAcpBrowserOpener('CodeBuddy', {
      openExternal: async (url) => {
        opened.push(url);
        return shouldSucceed;
      },
      resolveExternalOrigin: async (origin) => origin,
      writeClipboard: async (text) => {
        copied.push(text);
      },
      showMessage: async (level, text, actions = []) => {
        messages.push({ level, text, actions });
        return actions[actions.length - 1];
      },
      log: () => undefined,
    });

    const loginUrl = 'https://copilot.tencent.com/login?state=abc=123';
    opener.beginSignIn();
    await opener.openUrl(loginUrl, 'bridge');
    // stderr 再次打印同一链接时应去重
    opener.observeOutput(`Please open ${loginUrl} in your browser`);
    // 通知里再出现同一链接也应去重
    opener.observeNotification('auth/url', { url: loginUrl });
    await new Promise((r) => setTimeout(r, 10));

    expect(opened).toEqual([loginUrl]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.level).toBe('info');
    expect(copied).toEqual([loginUrl]);

    // 结束登录状态后，stderr 中的链接不再自动打开
    opener.endSignIn();
    opener.observeOutput('Error docs: https://example.com/docs');
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toEqual([loginUrl]);

    // 重新开始登录且 openExternal 失败时，弹出警告并提供「在浏览器打开」和「复制链接」
    shouldSucceed = false;
    opener.beginSignIn();
    await opener.openUrl(loginUrl, 'bridge');
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toEqual([loginUrl, loginUrl]);
    expect(messages[1]?.level).toBe('warning');
    expect(messages[1]?.actions).toEqual(['在浏览器打开', '复制链接']);
    expect(copied).toEqual([loginUrl, loginUrl]);
  });
});

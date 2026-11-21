import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HostSnapshot, HostToWebview } from '@harness-deck/shared';
import { JsonRpcPeer } from '../src/sidecar/protocol.ts';
import type { ResolvedDiffSpec } from '../src/vm/diffSpec.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDir, '..');
let sidecarBundlePath = '';
let bundleTempDir = '';
const tempDirs: string[] = [];

beforeAll(async () => {
  bundleTempDir = await mkdtemp(join(tmpdir(), 'hd-sidecar-bundle-'));
  sidecarBundlePath = join(bundleTempDir, 'sidecar.cjs');
  // 编译真实的 sidecar.cjs（验证无任何 vscode 依赖泄漏）
  await build({
    entryPoints: [join(extensionRoot, 'src/sidecar/entry.ts')],
    outfile: sidecarBundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'silent',
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

afterAll(async () => {
  if (bundleTempDir) {
    await rm(bundleTempDir, { recursive: true, force: true });
  }
});

describe('Node Sidecar 进程端到端协议验证（模拟 IntelliJ IDEA 宿主）', () => {
  it('启动编译后的 sidecar.cjs，完成握手、快照下发、外观持久化、PasswordSafe 密钥隔离、选区注入及断流自毁', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-sidecar-e2e-'));
    tempDirs.push(root);
    const configRoot = join(root, 'dot-harness-deck');
    const projectPath = join(root, 'sample-idea-project');
    await mkdir(projectPath, { recursive: true });

    const demoFile = join(root, 'Demo.kt');
    await writeFile(demoFile, 'fun greet() = "hello"\n', 'utf8');

    const child = spawn(process.execPath, [sidecarBundlePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const webviewMessages: HostToWebview[] = [];
    const secrets = new Map<string, string>();
    const openedDiffs: ResolvedDiffSpec[] = [];

    const waitForMessage = <T extends HostToWebview['type']>(
      type: T,
      predicate?: (msg: Extract<HostToWebview, { type: T }>) => boolean,
    ): Promise<Extract<HostToWebview, { type: T }>> =>
      new Promise((resolveMsg, rejectMsg) => {
        const existing = webviewMessages.find(
          (m): m is Extract<HostToWebview, { type: T }> =>
            m.type === type && (!predicate || predicate(m as Extract<HostToWebview, { type: T }>)),
        );
        if (existing) {
          resolveMsg(existing);
          return;
        }
        const timer = setTimeout(() => rejectMsg(new Error(`Timeout waiting for webview message ${type}`)), 8_000);
        const interval = setInterval(() => {
          const found = webviewMessages.find(
            (m): m is Extract<HostToWebview, { type: T }> =>
              m.type === type && (!predicate || predicate(m as Extract<HostToWebview, { type: T }>)),
          );
          if (found) {
            clearTimeout(timer);
            clearInterval(interval);
            resolveMsg(found);
          }
        }, 20);
      });

    const peer = new JsonRpcPeer(child.stdout, child.stdin, {
      onNotification: (method, params) => {
        if (method === 'ide/postToWebview') {
          const msg = (params as { message?: HostToWebview } | undefined)?.message;
          if (msg) webviewMessages.push(msg);
        }
      },
      onRequest: async (method, params) => {
        if (method === 'ide/secretGet') {
          const key = (params as { key: string }).key;
          return { value: secrets.get(key) ?? null };
        }
        if (method === 'ide/secretStore') {
          const { key, value } = params as { key: string; value: string };
          secrets.set(key, value);
          return {};
        }
        if (method === 'ide/secretDelete') {
          const { key } = params as { key: string };
          secrets.delete(key);
          return {};
        }
        if (method === 'ide/openDiff') {
          openedDiffs.push((params as { spec: ResolvedDiffSpec }).spec);
          return {};
        }
        if (method === 'ide/focusChatView') {
          return {};
        }
        return {};
      },
    });

    try {
      const initRes = await peer.request<{ ok: boolean }>('sidecar/init', {
        projectPath,
        workspaceFolders: [{ name: 'sample-idea-project', path: projectPath }],
        ideLanguage: 'zh-CN',
        workspaceTrusted: true,
        windowFocused: true,
        extensionVersion: '0.4.0',
        configRoot,
      });
      expect(initRes.ok).toBe(true);

      // 模拟 JCEF Webview 加载完成发送 ready
      peer.notify('sidecar/webviewMessage', { message: { type: 'ready', payload: {} } });
      const snapMsg = await waitForMessage('snapshot');
      const snap: HostSnapshot = snapMsg.payload;
      expect(snap.hostKind).toBe('jetbrains');
      expect(snap.locale).toBe('zh');

      // 修改主题与字号，验证落盘到 ~/.harness-deck/settings.json
      peer.notify('sidecar/webviewMessage', {
        message: { type: 'setAppearance', payload: { theme: 'dark', fontSize: 15 } },
      });
      await waitForMessage('appearance', (m) => m.payload.theme === 'dark' && m.payload.fontSize === 15);
      const savedSettings = JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')) as {
        ui?: { theme?: string; fontSize?: number };
      };
      expect(savedSettings.ui).toEqual({ theme: 'dark', fontSize: 15 });

      // 添加服务商与 API Key：验证 API Key 通过 ide/secretStore 存入 IDEA PasswordSafe，绝不明文写入 settings.json
      peer.notify('sidecar/webviewMessage', {
        message: {
          type: 'upsertProvider',
          payload: {
            name: 'My Gateway',
            openaiChatUrl: 'https://api.example.com/v1/chat/completions',
            apiKey: 'sk-super-secret-idea-key',
            models: [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }],
            boundBackendIds: ['claude'],
          },
        },
      });
      await waitForMessage('providers', (m) => m.payload.items.some((p) => p.name === 'My Gateway' && p.hasApiKey));
      expect([...secrets.values()]).toContain('sk-super-secret-idea-key');
      const rawSettingsText = await readFile(join(configRoot, 'settings.json'), 'utf8');
      expect(rawSettingsText).not.toContain('sk-super-secret-idea-key');

      // 模拟 IDEA 编辑器右键「添加到对话」并内联同步当前选区
      await peer.request('sidecar/executeCommand', {
        command: 'addToChat',
        activeEditor: {
          path: demoFile,
          languageId: 'kotlin',
          selection: {
            startLine: 1,
            endLine: 1,
            text: 'fun greet() = "hello"',
            diagnostics: [],
          },
        },
      });
      const ctxMsg = await waitForMessage('context', (m) => m.payload.pinned.some((p) => p.path === demoFile));
      expect(ctxMsg.payload.pinned[0]?.path).toBe(demoFile);

      // 模拟父进程（IDEA）关闭 stdin，验证 sidecar 自动清理并退出（不留孤儿进程）
      const exitPromise = new Promise<number | null>((res) => {
        child.once('exit', (code) => res(code));
      });
      child.stdin.end();
      const exitCode = await exitPromise;
      expect(exitCode).toBe(0);
    } finally {
      peer.close();
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
  });
});

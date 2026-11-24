/**
 * 一键公网临时隧道服务（Cloudflare Quick Tunnel）：
 * - 遵循只读探测原则：仅执行 `cloudflared --version` 检测是否安装
 * - 启用时拉起 `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`，解析 `https://*.trycloudflare.com`
 * - 无需注册账号即可获得 HTTPS/WSS 外网入口（同步解锁手机 Web Push 与 PWA 安装）
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { RemoteQuickTunnelView } from '@harness-deck/shared';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 3_000;
const START_TIMEOUT_MS = 18_000;
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;

export type QuickTunnelExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
export type QuickTunnelSpawn = (command: string, args: readonly string[]) => ChildProcess;

const defaultExec: QuickTunnelExec = async (args) =>
  await execFileAsync('cloudflared', [...args], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });

const defaultSpawn: QuickTunnelSpawn = (command, args) =>
  spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

export function parseCloudflaredVersion(output: string): string | undefined {
  const match = output.match(/cloudflared\s+version\s+([^\s(]+)/iu) ?? output.match(/\b(\d{4}\.\d+\.\d+)\b/u);
  return match?.[1]?.trim();
}

export function extractQuickTunnelUrl(chunk: string): string | undefined {
  const match = chunk.match(QUICK_TUNNEL_URL_RE);
  return match?.[0]?.toLowerCase();
}

export async function probeCloudflared(
  exec: QuickTunnelExec = defaultExec,
): Promise<{ readonly installed: boolean; readonly version?: string; readonly error?: string }> {
  try {
    const { stdout, stderr } = await exec(['--version']);
    const version = parseCloudflaredVersion(`${stdout}\n${stderr}`);
    return { installed: true, ...(version ? { version } : {}) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      return { installed: false };
    }
    const detail = (typeof err.stderr === 'string' && err.stderr.trim()) || err.message || String(error);
    return { installed: true, error: detail.split('\n')[0] ?? detail };
  }
}

export class QuickTunnelManager {
  private installed: boolean | undefined;
  private version: string | undefined;
  private status: RemoteQuickTunnelView['status'] = 'stopped';
  private url: string | undefined;
  private error: string | undefined;
  private child: ChildProcess | undefined;

  constructor(
    private readonly options: {
      readonly exec?: QuickTunnelExec;
      readonly spawn?: QuickTunnelSpawn;
      readonly onStateChange: () => void;
      readonly log?: (line: string) => void;
      readonly startTimeoutMs?: number;
    },
  ) {}

  getView(): RemoteQuickTunnelView | undefined {
    if (this.installed === undefined && this.status === 'stopped') return undefined;
    return {
      installed: this.installed === true,
      status: this.status,
      ...(this.version ? { version: this.version } : {}),
      ...(this.url ? { url: this.url } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  getUrl(): string | undefined {
    return this.status === 'running' ? this.url : undefined;
  }

  async probe(): Promise<RemoteQuickTunnelView> {
    const res = await probeCloudflared(this.options.exec ?? defaultExec);
    this.installed = res.installed;
    this.version = res.version;
    if (!res.installed && this.status !== 'running') {
      this.status = 'stopped';
      this.url = undefined;
      this.error = undefined;
    } else if (res.error && this.status === 'stopped') {
      this.error = res.error;
    }
    this.options.onStateChange();
    return this.getView()!;
  }

  async start(localPort: number): Promise<RemoteQuickTunnelView> {
    if (this.status === 'running' && this.url && this.child) {
      return this.getView()!;
    }
    if (this.installed === undefined) {
      await this.probe();
    }
    if (!this.installed) {
      this.status = 'error';
      this.error = 'cloudflared not installed';
      this.options.onStateChange();
      return this.getView()!;
    }

    await this.stop(false);
    this.status = 'starting';
    this.url = undefined;
    this.error = undefined;
    this.options.onStateChange();

    const spawnFn = this.options.spawn ?? defaultSpawn;
    const child = spawnFn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate']);
    this.child = child;

    return await new Promise<RemoteQuickTunnelView>((resolveStart) => {
      let settled = false;
      let lastLogLine = '';
      const finish = (nextStatus: RemoteQuickTunnelView['status'], nextUrl?: string, nextError?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.child === child) {
          this.status = nextStatus;
          this.url = nextUrl;
          this.error = nextError;
          if (nextStatus !== 'running') {
            this.killChild(child);
            this.child = undefined;
          }
        }
        this.options.onStateChange();
        resolveStart(this.getView()!);
      };

      const onOutput = (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        for (const rawLine of text.split(/\r?\n/u)) {
          const line = rawLine.trim();
          if (line) lastLogLine = line;
        }
        const found = extractQuickTunnelUrl(text);
        if (found && !settled) {
          this.options.log?.(`Cloudflare Quick Tunnel 已就绪：${found}`);
          finish('running', found, undefined);
        }
      };

      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);

      child.once('error', (err) => {
        const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (enoent) this.installed = false;
        finish('error', undefined, err.message || String(err));
      });

      child.once('exit', (code, signal) => {
        if (!settled) {
          finish('error', undefined, lastLogLine || `cloudflared exited (${code ?? signal ?? 'unknown'})`);
          return;
        }
        if (this.child === child) {
          this.child = undefined;
          this.url = undefined;
          this.status = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
          this.error = this.status === 'error' ? lastLogLine || `cloudflared exited (${code ?? signal ?? 'unknown'})` : undefined;
          this.options.onStateChange();
        }
      });

      const timer = setTimeout(() => {
        finish('error', undefined, lastLogLine || 'Timed out waiting for trycloudflare.com URL');
      }, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  async stop(notify = true): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.error = undefined;
    this.status = 'stopped';
    if (child) {
      this.killChild(child);
    }
    if (notify) {
      this.options.onStateChange();
    }
  }

  private killChild(child: ChildProcess): void {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

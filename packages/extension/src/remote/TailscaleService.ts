/**
 * Tailscale 探测与 `tailscale serve` 反代集成（HD-26）：
 * - 遵循 HD-01 只读探测无副作用红线：只执行 `tailscale status --json` 与 `tailscale serve status --json`
 * - 若因权限策略失败，降级返回准确的手动命令供用户复制，不做越权提权
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RemoteTailscaleView } from '@harness-deck/shared';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 3_000;

export type TailscaleExec = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const defaultExec: TailscaleExec = async (args) =>
  await execFileAsync('tailscale', [...args], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

export function parseTailscaleStatusJson(raw: string, serveStatusRaw?: string): RemoteTailscaleView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { installed: true, loggedIn: false, error: 'Invalid tailscale status JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { installed: true, loggedIn: false, error: 'Unexpected tailscale status output' };
  }
  const obj = parsed as Record<string, unknown>;
  const backendState = typeof obj.BackendState === 'string' ? obj.BackendState : '';
  const self = obj.Self && typeof obj.Self === 'object' ? (obj.Self as Record<string, unknown>) : undefined;
  const rawDns = typeof self?.DNSName === 'string' ? self.DNSName.trim() : '';
  const dnsName = rawDns.replace(/\.+$/u, '');
  const loggedIn = backendState === 'Running' && Boolean(dnsName);

  let serveEnabled = false;
  if (serveStatusRaw) {
    try {
      const serveObj = JSON.parse(serveStatusRaw) as Record<string, unknown>;
      const web = serveObj.Web && typeof serveObj.Web === 'object' ? (serveObj.Web as Record<string, unknown>) : undefined;
      if (web && Object.keys(web).length > 0) serveEnabled = true;
    } catch {
      // ignore invalid serve status
    }
  }

  return {
    installed: true,
    loggedIn,
    ...(dnsName ? { dnsName } : {}),
    ...(loggedIn ? { serveUrl: `https://${dnsName}`, serveEnabled } : {}),
    ...(!loggedIn && backendState ? { error: `Tailscale state: ${backendState}` } : {}),
  };
}

export async function probeTailscaleStatus(exec: TailscaleExec = defaultExec): Promise<RemoteTailscaleView> {
  try {
    const { stdout } = await exec(['status', '--json']);
    let serveOut: string | undefined;
    try {
      const serveRes = await exec(['serve', 'status', '--json']);
      serveOut = serveRes.stdout;
    } catch {
      serveOut = undefined;
    }
    return parseTailscaleStatusJson(stdout, serveOut);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      return { installed: false, loggedIn: false };
    }
    const detail = (typeof err.stderr === 'string' && err.stderr.trim()) || err.message || String(error);
    return { installed: true, loggedIn: false, error: detail.split('\n')[0] ?? detail };
  }
}

export function tailscaleServeCommand(port: number, enabled: boolean): string {
  return enabled ? `tailscale serve --bg http://127.0.0.1:${port}` : 'tailscale serve --https=443 off';
}

export async function configureTailscaleServe(
  port: number,
  enabled: boolean,
  exec: TailscaleExec = defaultExec,
): Promise<{ readonly ok: boolean; readonly manualCommand: string; readonly error?: string }> {
  const manualCommand = tailscaleServeCommand(port, enabled);
  try {
    if (enabled) {
      await exec(['serve', '--bg', `http://127.0.0.1:${port}`]);
    } else {
      await exec(['serve', '--https=443', 'off']);
    }
    return { ok: true, manualCommand };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = (typeof err.stderr === 'string' && err.stderr.trim()) || err.message || String(error);
    return { ok: false, manualCommand, error: detail.split('\n')[0] ?? detail };
  }
}

export function normalizeTunnelUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

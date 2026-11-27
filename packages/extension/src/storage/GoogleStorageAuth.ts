/**
 * Google 云盘 / Google Cloud Storage 一键浏览器授权服务：
 * 1. OAuth 2.0 + PKCE 本地 `127.0.0.1` 回环回调服务（自动拉起系统浏览器、接收回调换取 refresh_token 与用户邮箱）
 * 2. 本机 `gcloud` ADC 自动探测与一键触发 `gcloud auth application-default login`（免自建 OAuth 应用）
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FetchLike } from '../providers/proxyFetch.ts';

const execFileAsync = promisify(execFile);

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export const GOOGLE_OAUTH_CLIENT_ID_KEY = 'harnessDeck.remoteStorage.googleClientId';
export const GOOGLE_OAUTH_CLIENT_SECRET_KEY = 'harnessDeck.remoteStorage.googleClientSecret';

export type GoogleStorageAuthKind = 'google-drive' | 'google-cloud-storage';

export interface GoogleAuthResult {
  readonly secretJson: string;
  readonly email?: string;
}

export interface GcloudProbeResult {
  readonly gcloudAvailable: boolean;
  readonly adcReady: boolean;
  readonly adcPath?: string;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function scopeForKind(kind: GoogleStorageAuthKind): string {
  if (kind === 'google-drive') {
    return 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email';
  }
  return 'https://www.googleapis.com/auth/devstorage.read_write https://www.googleapis.com/auth/userinfo.email';
}

function renderCallbackHtml(ok: boolean, message: string): string {
  const title = ok ? 'Halo · 授权成功' : 'Halo · 授权未完成';
  const badgeColor = ok ? '#16a34a' : '#dc2626';
  const safeMsg = message
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#181a20;color:#eceef2;}
  .card{max-width:380px;padding:28px 32px;border-radius:16px;background:#22252e;border:1px solid rgba(255,255,255,.08);text-align:center;}
  .dot{width:12px;height:12px;border-radius:999px;background:${badgeColor};display:inline-block;margin-bottom:14px;}
  h1{margin:0 0 8px;font-size:17px;font-weight:600;}
  p{margin:0;font-size:13px;line-height:1.6;color:#a1a7b5;}
</style>
</head>
<body>
  <div class="card">
    <span class="dot"></span>
    <h1>${title}</h1>
    <p>${safeMsg}</p>
  </div>
</body>
</html>`;
}

export function resolveDefaultGcloudAdcPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platformName: NodeJS.Platform = process.platform,
): string {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicit) return explicit;
  if (platformName === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'gcloud', 'application_default_credentials.json');
  }
  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

export async function readValidGcloudAdcJson(adcPath = resolveDefaultGcloudAdcPath()): Promise<string | undefined> {
  try {
    const raw = (await readFile(adcPath, 'utf8')).trim();
    if (!raw.startsWith('{')) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const validAuthorizedUser =
      parsed.type === 'authorized_user' &&
      typeof parsed.client_id === 'string' &&
      typeof parsed.client_secret === 'string' &&
      typeof parsed.refresh_token === 'string';
    const validServiceAccount =
      parsed.type === 'service_account' &&
      typeof parsed.client_email === 'string' &&
      typeof parsed.private_key === 'string';
    return validAuthorizedUser || validServiceAccount ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** 只读探测本机是否安装了 `gcloud` 与是否已有可用 ADC 凭据（零副作用）。 */
export async function probeGcloudAuth(options?: {
  readonly adcPath?: string;
  readonly checkGcloud?: () => Promise<boolean>;
}): Promise<GcloudProbeResult> {
  const adcPath = options?.adcPath ?? resolveDefaultGcloudAdcPath();
  const [adcRaw, gcloudAvailable] = await Promise.all([
    readValidGcloudAdcJson(adcPath),
    options?.checkGcloud
      ? options.checkGcloud()
      : execFileAsync('gcloud', ['--version'], { timeout: 2_500, windowsHide: true })
          .then(() => true)
          .catch(() => false),
  ]);
  return {
    gcloudAvailable,
    adcReady: Boolean(adcRaw),
    ...(adcRaw ? { adcPath } : {}),
  };
}

export interface ActiveGoogleAuthHandle {
  readonly promise: Promise<GoogleAuthResult>;
  readonly authUrl?: string;
  readonly cancel: () => void;
}

/**
 * 启动本地 `127.0.0.1` OAuth 2.0 + PKCE 回环回调服务并打开系统浏览器完成 Google 登录授权。
 */
export async function startGoogleLoopbackOAuth(options: {
  readonly kind: GoogleStorageAuthKind;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly fetchImpl: FetchLike;
  readonly tokenEndpoint?: string;
  readonly userinfoEndpoint?: string;
  readonly timeoutMs?: number;
}): Promise<ActiveGoogleAuthHandle> {
  const clientId = options.clientId.trim();
  if (!clientId) {
    throw new Error('Google OAuth Client ID is required');
  }

  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier, 'utf8').digest());
  const expectedState = base64Url(randomBytes(16));
  const expectedStateBuf = Buffer.from(expectedState, 'utf8');

  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolvePromise!: (res: GoogleAuthResult) => void;
  let rejectPromise!: (err: Error) => void;

  const promise = new Promise<GoogleAuthResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const srv = server;
    server = undefined;
    if (srv) {
      try {
        srv.close();
      } catch {
        // ignore
      }
    }
  };

  const finishOk = (result: GoogleAuthResult): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };

  const finishErr = (err: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(err);
  };

  let redirectUri = '';

  server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const errorParam = reqUrl.searchParams.get('error');
    if (errorParam) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackHtml(false, `Google 返回取消或错误：${errorParam}`));
      finishErr(new Error(`Google OAuth error: ${errorParam}`));
      return;
    }

    const code = reqUrl.searchParams.get('code')?.trim() ?? '';
    const state = reqUrl.searchParams.get('state')?.trim() ?? '';
    const actualStateBuf = Buffer.from(state, 'utf8');
    const stateMatched =
      actualStateBuf.length === expectedStateBuf.length && timingSafeEqual(actualStateBuf, expectedStateBuf);

    if (!code || !stateMatched) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackHtml(false, '无效的授权回调参数，请回到 Halo 重新发起授权。'));
      finishErr(new Error('Invalid OAuth callback state or missing code'));
      return;
    }

    void (async () => {
      try {
        const form = new URLSearchParams({
          code,
          client_id: clientId,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        });
        if (options.clientSecret?.trim()) {
          form.set('client_secret', options.clientSecret.trim());
        }
        const tokenRes = await options.fetchImpl(options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const tokenJson = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!tokenRes.ok || typeof tokenJson.access_token !== 'string') {
          const detail = String(tokenJson.error_description ?? tokenJson.error ?? `HTTP ${tokenRes.status}`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderCallbackHtml(false, `换取授权令牌失败：${detail}`));
          finishErr(new Error(`Google token exchange failed: ${detail}`));
          return;
        }

        const accessToken = tokenJson.access_token;
        const refreshToken = typeof tokenJson.refresh_token === 'string' ? tokenJson.refresh_token : undefined;

        let email: string | undefined;
        try {
          const infoRes = await options.fetchImpl(options.userinfoEndpoint ?? GOOGLE_USERINFO_ENDPOINT, {
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (infoRes.ok) {
            const info = (await infoRes.json().catch(() => ({}))) as Record<string, unknown>;
            if (typeof info.email === 'string' && info.email.includes('@')) {
              email = info.email.trim();
            }
          }
        } catch {
          // 邮箱为可选展示信息，获取失败不影响授权成功
        }

        const secretObj: Record<string, string> = refreshToken
          ? {
              client_id: clientId,
              ...(options.clientSecret?.trim() ? { client_secret: options.clientSecret.trim() } : {}),
              refresh_token: refreshToken,
              access_token: accessToken,
            }
          : { access_token: accessToken };

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderCallbackHtml(
            true,
            email ? `已授权账号 ${email}，现在可以关闭此标签页并返回 Halo。` : '授权已完成，现在可以关闭此标签页并返回 Halo。',
          ),
        );
        finishOk({
          secretJson: JSON.stringify(secretObj),
          ...(email ? { email } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCallbackHtml(false, msg));
        finishErr(err instanceof Error ? err : new Error(msg));
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server!.once('error', rejectListen);
    server!.listen(0, '127.0.0.1', () => {
      server!.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  redirectUri = `http://127.0.0.1:${port}/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopeForKind(options.kind),
    state: expectedState,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;

  timer = setTimeout(() => {
    finishErr(new Error('Google OAuth timed out'));
  }, options.timeoutMs ?? OAUTH_TIMEOUT_MS);
  timer.unref?.();

  await options.openExternal(authUrl);

  return {
    promise,
    authUrl,
    cancel: () => finishErr(new Error('Authorization cancelled')),
  };
}

/**
 * 通过本机 `gcloud` 一键授权：
 * - 若已有有效 ADC 凭据则直接导入；
 * - 否则拉起 `gcloud auth application-default login` 打开浏览器完成官方登录并读取 ADC。
 */
export function startGcloudAdcAuth(options: {
  readonly kind: GoogleStorageAuthKind;
  readonly adcPath?: string;
}): ActiveGoogleAuthHandle {
  const adcPath = options.adcPath ?? resolveDefaultGcloudAdcPath();
  let child: ChildProcess | undefined;
  let cancelled = false;

  const promise = (async (): Promise<GoogleAuthResult> => {
    const existing = await readValidGcloudAdcJson(adcPath);
    if (existing) {
      return { secretJson: existing };
    }
    if (cancelled) throw new Error('Authorization cancelled');

    const scopes =
      options.kind === 'google-drive'
        ? 'https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive'
        : 'https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/devstorage.read_write';

    await new Promise<void>((resolveProc, rejectProc) => {
      const proc = spawn('gcloud', ['auth', 'application-default', 'login', `--scopes=${scopes}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = proc;
      let errBuf = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        errBuf = `${errBuf}${chunk.toString('utf8')}`.slice(-800);
      });
      proc.once('error', (err) => rejectProc(err));
      proc.once('exit', (code) => {
        if (cancelled) {
          rejectProc(new Error('Authorization cancelled'));
        } else if (code === 0) {
          resolveProc();
        } else {
          rejectProc(new Error(errBuf.trim() || `gcloud exited with code ${String(code ?? 1)}`));
        }
      });
    });

    const fresh = await readValidGcloudAdcJson(adcPath);
    if (!fresh) {
      throw new Error('gcloud login finished but ADC credentials file was not found');
    }
    return { secretJson: fresh };
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        child?.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}

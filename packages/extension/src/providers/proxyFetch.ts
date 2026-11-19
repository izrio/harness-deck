/**
 * 支持 HTTP/HTTPS 代理隧道的轻量级上游请求封装（零第三方依赖）：
 *
 * - VS Code 宿主内由 Electron/VS Code 接管 `fetch` 代理与系统证书，保持默认 `fetch`；
 * - JetBrains Sidecar 等纯 Node.js 运行时下，Node 原生 `fetch` 默认忽略 `HTTP_PROXY` / `HTTPS_PROXY`
 *   及 IDE 代理配置，此处在命中非回环且未在 `NO_PROXY` 列表的目标地址时自动走 HTTP CONNECT 隧道。
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import tls from 'node:tls';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower.endsWith('.localhost');
}

export function shouldBypassHttpProxy(targetUrl: URL, noProxyRaw?: string): boolean {
  const host = targetUrl.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (isLoopbackHost(host)) return true;
  const raw = noProxyRaw ?? process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (!raw.trim()) return false;
  for (const token of raw.split(',')) {
    const entry = token.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const cleanHost = entry.replace(/:\d+$/u, '').replace(/^\./u, '');
    if (!cleanHost) continue;
    if (host === cleanHost || host.endsWith(`.${cleanHost}`)) return true;
  }
  return false;
}

export function resolveHttpProxyUrl(targetUrl: URL, configuredProxy?: string): URL | undefined {
  if (shouldBypassHttpProxy(targetUrl)) return undefined;
  const isHttps = targetUrl.protocol === 'https:';
  const raw =
    configuredProxy?.trim() ||
    (isHttps
      ? (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy)
      : (process.env.HTTP_PROXY ?? process.env.http_proxy)) ||
    '';
  if (!raw.trim()) return undefined;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function normalizeHeaders(headersInit: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headersInit) return out;
  if (headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headersInit)) {
    for (const [k, v] of headersInit) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(headersInit)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}

function bodyToBuffer(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return undefined;
}

function proxyAuthHeader(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  const creds = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  return `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`;
}

function incomingToWebResponse(incoming: http.IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, val] of Object.entries(incoming.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, item);
    } else {
      headers.set(key, val);
    }
  }
  const status = incoming.statusCode ?? 502;
  const noBodyStatus = status === 204 || status === 205 || status === 304;
  const webBody = noBodyStatus ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
  return new Response(webBody, {
    status,
    statusText: incoming.statusMessage ?? '',
    headers,
  });
}

function fetchViaHttpProxy(targetUrl: URL, proxyUrl: URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init?.headers);
  const bodyBuf = bodyToBuffer(init?.body);
  if (bodyBuf && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(bodyBuf.byteLength);
  }
  const signal = init?.signal ?? undefined;
  const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : proxyUrl.protocol === 'https:' ? 443 : 80;
  const proxyAuth = proxyAuthHeader(proxyUrl);

  if (targetUrl.protocol === 'http:') {
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('The operation was aborted'));
        return;
      }
      const reqHeaders: Record<string, string> = {
        host: targetUrl.host,
        ...headers,
        ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
      };
      const req = (proxyUrl.protocol === 'https:' ? https : http).request(
        {
          host: proxyUrl.hostname,
          port: proxyPort,
          method,
          path: targetUrl.toString(),
          headers: reqHeaders,
        },
        (res) => {
          cleanup();
          resolve(incomingToWebResponse(res));
        },
      );
      const onAbort = () => {
        req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.once('error', (err) => {
        cleanup();
        reject(err);
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  // HTTPS 目标通过 HTTP CONNECT 隧道建立 TLS 连接
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('The operation was aborted'));
      return;
    }
    const targetPort = targetUrl.port ? Number(targetUrl.port) : 443;
    const authority = `${targetUrl.hostname}:${targetPort}`;
    const connectReq = (proxyUrl.protocol === 'https:' ? https : http).request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
      },
    });

    let activeReq: http.ClientRequest | undefined;
    const onAbort = () => {
      const err = signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
      connectReq.destroy(err);
      activeReq?.destroy(err);
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });

    connectReq.once('error', (err) => {
      cleanup();
      reject(err);
    });

    connectReq.once('connect', (connectRes, socket) => {
      if ((connectRes.statusCode ?? 0) < 200 || (connectRes.statusCode ?? 0) >= 300) {
        socket.destroy();
        cleanup();
        reject(new Error(`HTTP proxy CONNECT failed with status ${connectRes.statusCode ?? 0}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
      });
      const req = https.request(
        {
          host: targetUrl.hostname,
          port: targetPort,
          method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: {
            host: targetUrl.host,
            ...headers,
          },
          createConnection: () => tlsSocket,
        },
        (res) => {
          cleanup();
          resolve(incomingToWebResponse(res));
        },
      );
      activeReq = req;
      req.once('error', (err) => {
        cleanup();
        reject(err);
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });

    connectReq.end();
  });
}

export function createProxyAwareFetch(getHttpProxy?: () => string | undefined): FetchLike {
  const isElectron = Boolean((process.versions as Record<string, string | undefined>).electron);
  return async (input, init) => {
    if (!isElectron) {
      const targetUrl = input instanceof URL ? input : new URL(String(input));
      const proxyUrl = resolveHttpProxyUrl(targetUrl, getHttpProxy?.());
      if (proxyUrl) {
        return fetchViaHttpProxy(targetUrl, proxyUrl, init);
      }
    }
    return fetch(input, init);
  };
}

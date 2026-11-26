/**
 * 支持 HTTP/HTTPS 代理隧道与 WSL2 网络容错的轻量级上游请求封装（零第三方依赖）：
 *
 * - VS Code 本地 Electron 宿主内由 Electron/VS Code 接管 `fetch` 代理与系统证书，保持默认 `fetch`；
 * - VS Code Remote-WSL、JetBrains Sidecar 等纯 Node.js 运行时下，Node 原生 `fetch` 默认忽略
 *   `HTTP_PROXY` / `HTTPS_PROXY` 及 IDE 代理配置，此处在命中非回环且未在 `NO_PROXY` 列表的目标地址时
 *   自动走 HTTP CONNECT 隧道（独立 `agent: false`、自动 `gzip/deflate/br` 解压与 30x 重定向跟随）；
 * - 针对 WSL2 NAT（`autoProxy=true` / `dnsTunneling=true`）常见故障：
 *   1. 若配置的代理为回环地址（如从 Windows 同步过来的 `127.0.0.1:7890`）且连接失败，自动尝试 WSL2 Windows 宿主机网关 IP；
 *   2. 若代理不可达（如宿主机代理已关闭或被防火墙拦截），自动回退直连；
 *   3. 若原生 `fetch`（undici）在 WSL2 下触发 IPv6 黑洞 / `fetch failed`，自动回退纯 IPv4（`family: 4`）直连。
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 5;
const FALLBACK_TIMEOUT_MS = 10_000;

let cachedIsWsl: boolean | undefined;

export function isWslEnvironment(): boolean {
  if (cachedIsWsl !== undefined) return cachedIsWsl;
  if (process.platform !== 'linux') {
    cachedIsWsl = false;
    return false;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    cachedIsWsl = true;
    return true;
  }
  try {
    const version = readFileSync('/proc/version', 'utf8');
    cachedIsWsl = /microsoft|wsl/iu.test(version);
  } catch {
    cachedIsWsl = false;
  }
  return cachedIsWsl;
}

/** 解析 `/proc/net/route` 中的小端十六进制 IPv4（如 `01A01BAC` -> `172.27.160.1`）。 */
export function parseProcNetRouteGateway(content: string): string | undefined {
  const lines = content.split(/\r?\n/u);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]?.trim().split(/\s+/u);
    if (!cols || cols.length < 3) continue;
    const destination = cols[1];
    const gateway = cols[2];
    if (destination !== '00000000' || !gateway || gateway === '00000000') continue;
    if (!/^[0-9a-fA-F]{8}$/u.test(gateway)) continue;
    const b0 = parseInt(gateway.slice(6, 8), 16);
    const b1 = parseInt(gateway.slice(4, 6), 16);
    const b2 = parseInt(gateway.slice(2, 4), 16);
    const b3 = parseInt(gateway.slice(0, 2), 16);
    if ([b0, b1, b2, b3].some((n) => Number.isNaN(n))) continue;
    return `${b0}.${b1}.${b2}.${b3}`;
  }
  return undefined;
}

/** 在 WSL2 NAT 下快速探测 Windows 宿主机网关 IP（零子进程调用，不会因 WSL interop 挂起）。 */
export function detectWslHostIp(): string | undefined {
  if (!isWslEnvironment()) return undefined;
  try {
    const route = readFileSync('/proc/net/route', 'utf8');
    const gw = parseProcNetRouteGateway(route);
    if (gw && !gw.startsWith('127.')) return gw;
  } catch {
    // ignore
  }
  try {
    const resolv = readFileSync('/etc/resolv.conf', 'utf8');
    const match = /^\s*nameserver\s+(\d+\.\d+\.\d+\.\d+)/mu.exec(resolv);
    const ip = match?.[1];
    if (ip && !ip.startsWith('127.') && ip !== '10.255.255.254') return ip;
  } catch {
    // ignore
  }
  return undefined;
}

/** 展开 Node `fetch failed` 的嵌套 `cause` / `AggregateError`，输出可读错误详情。 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (text: string | undefined) => {
    const clean = text?.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    parts.push(clean);
  };

  push(error.message);
  let cursor: unknown = (error as { cause?: unknown }).cause;
  let depth = 0;
  while (cursor && depth < 4) {
    depth++;
    if (cursor instanceof Error) {
      const code = (cursor as { code?: unknown }).code;
      const codeStr = typeof code === 'string' && code ? code : undefined;
      const subErrors = (cursor as { errors?: unknown[] }).errors;
      if (Array.isArray(subErrors) && subErrors.length > 0) {
        const subParts = subErrors
          .slice(0, 3)
          .map((item) => {
            if (item instanceof Error) {
              const subCode = (item as { code?: unknown }).code;
              return typeof subCode === 'string' && subCode
                ? item.message
                  ? `${subCode}: ${item.message}`
                  : subCode
                : item.message || item.name;
            }
            return String(item);
          })
          .filter(Boolean);
        if (subParts.length > 0) push(subParts.join(', '));
      } else if (codeStr && cursor.message && !cursor.message.includes(codeStr)) {
        push(`${codeStr}: ${cursor.message}`);
      } else {
        push(cursor.message || codeStr);
      }
      cursor = (cursor as { cause?: unknown }).cause;
    } else {
      push(String(cursor));
      break;
    }
  }

  if (parts.length <= 1) return parts[0] ?? error.name;
  return `${parts[0]} (${parts.slice(1).join(' -> ')})`;
}

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
  if (noBodyStatus) {
    incoming.resume();
    return new Response(null, {
      status,
      statusText: incoming.statusMessage ?? '',
      headers,
    });
  }

  let bodyStream: Readable = incoming;
  const rawEncoding = headers.get('content-encoding')?.trim().toLowerCase();
  if (rawEncoding === 'gzip' || rawEncoding === 'x-gzip') {
    const gunzip = zlib.createGunzip();
    incoming.on('error', (err) => gunzip.destroy(err));
    bodyStream = incoming.pipe(gunzip);
    headers.delete('content-encoding');
    headers.delete('content-length');
  } else if (rawEncoding === 'deflate') {
    const inflate = zlib.createInflate();
    incoming.on('error', (err) => inflate.destroy(err));
    bodyStream = incoming.pipe(inflate);
    headers.delete('content-encoding');
    headers.delete('content-length');
  } else if (rawEncoding === 'br') {
    const brotli = zlib.createBrotliDecompress();
    incoming.on('error', (err) => brotli.destroy(err));
    bodyStream = incoming.pipe(brotli);
    headers.delete('content-encoding');
    headers.delete('content-length');
  }

  const webBody = Readable.toWeb(bodyStream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webBody, {
    status,
    statusText: incoming.statusMessage ?? '',
    headers,
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildRedirectInit(
  currentUrl: URL,
  nextUrl: URL,
  status: number,
  init?: RequestInit,
): RequestInit {
  const prevMethod = (init?.method ?? 'GET').toUpperCase();
  const switchToGet = status === 303 || ((status === 301 || status === 302) && prevMethod === 'POST');
  const headers = normalizeHeaders(init?.headers);
  if (nextUrl.origin !== currentUrl.origin) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') {
        delete headers[key];
      }
    }
  }
  if (switchToGet) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-length' || key.toLowerCase() === 'content-type') {
        delete headers[key];
      }
    }
  }
  return {
    ...init,
    method: switchToGet ? 'GET' : prevMethod,
    headers,
    ...(switchToGet ? { body: null } : {}),
  };
}

function requestViaHttpProxyOnce(targetUrl: URL, proxyUrl: URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init?.headers);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
    headers['accept-encoding'] = 'gzip, deflate, br';
  }
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
          agent: false,
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

  // HTTPS 目标通过 HTTP CONNECT 隧道建立 TLS 连接（agent: false 避免 Node 22 全局连接池复用/破坏隧道套接字）
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
      agent: false,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}),
      },
    });

    let activeReq: http.ClientRequest | undefined;
    let activeTls: tls.TLSSocket | undefined;
    let settled = false;
    const finishError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = () => {
      const err = signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
      connectReq.destroy(err);
      activeReq?.destroy(err);
      activeTls?.destroy(err);
      finishError(err);
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });

    connectReq.once('error', finishError);

    connectReq.once('connect', (connectRes, socket, head) => {
      if ((connectRes.statusCode ?? 0) < 200 || (connectRes.statusCode ?? 0) >= 300) {
        socket.destroy();
        finishError(new Error(`HTTP proxy CONNECT failed with status ${connectRes.statusCode ?? 0}`));
        return;
      }

      if (head && head.length > 0) {
        socket.unshift(head);
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
      });
      activeTls = tlsSocket;
      tlsSocket.once('error', (err) => {
        socket.destroy();
        finishError(err);
      });

      const req = https.request(
        {
          host: targetUrl.hostname,
          port: targetPort,
          agent: false,
          method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: {
            host: targetUrl.host,
            ...headers,
          },
          createConnection: () => tlsSocket,
        },
        (res) => {
          if (settled) {
            res.resume();
            return;
          }
          settled = true;
          cleanup();
          resolve(incomingToWebResponse(res));
        },
      );
      activeReq = req;
      req.once('error', (err) => {
        tlsSocket.destroy();
        finishError(err);
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });

    connectReq.end();
  });
}

async function fetchViaHttpProxy(
  targetUrl: URL,
  proxyUrl: URL,
  init?: RequestInit,
  redirectDepth = 0,
): Promise<Response> {
  const res = await requestViaHttpProxyOnce(targetUrl, proxyUrl, init);
  if (init?.redirect !== 'manual' && isRedirectStatus(res.status) && redirectDepth < MAX_REDIRECTS) {
    const location = res.headers.get('location');
    if (location) {
      await res.body?.cancel().catch(() => undefined);
      const nextUrl = new URL(location, targetUrl);
      const nextInit = buildRedirectInit(targetUrl, nextUrl, res.status, init);
      return fetchViaHttpProxy(nextUrl, proxyUrl, nextInit, redirectDepth + 1);
    }
  }
  return res;
}

function requestDirectNodeOnce(
  targetUrl: URL,
  init?: RequestInit,
  family?: 4 | 6,
): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init?.headers);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
    headers['accept-encoding'] = 'gzip, deflate, br';
  }
  const bodyBuf = bodyToBuffer(init?.body);
  if (bodyBuf && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(bodyBuf.byteLength);
  }
  const signal = init?.signal ?? undefined;
  const isHttps = targetUrl.protocol === 'https:';
  const port = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('The operation was aborted'));
      return;
    }
    let settled = false;
    const finishError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const req = (isHttps ? https : http).request(
      {
        host: targetUrl.hostname,
        port,
        agent: false,
        ...(family ? { family } : {}),
        method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: {
          host: targetUrl.host,
          ...headers,
        },
      },
      (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        cleanup();
        resolve(incomingToWebResponse(res));
      },
    );
    const onAbort = () => {
      const err = signal?.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
      req.destroy(err);
      finishError(err);
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('error', finishError);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function fetchDirectNode(
  targetUrl: URL,
  init?: RequestInit,
  family?: 4 | 6,
  redirectDepth = 0,
): Promise<Response> {
  const res = await requestDirectNodeOnce(targetUrl, init, family);
  if (init?.redirect !== 'manual' && isRedirectStatus(res.status) && redirectDepth < MAX_REDIRECTS) {
    const location = res.headers.get('location');
    if (location) {
      await res.body?.cancel().catch(() => undefined);
      const nextUrl = new URL(location, targetUrl);
      const nextInit = buildRedirectInit(targetUrl, nextUrl, res.status, init);
      return fetchDirectNode(nextUrl, nextInit, family, redirectDepth + 1);
    }
  }
  return res;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || /timeout|timed out/iu.test(err.message));
}

function isCallerManualAbort(signal: AbortSignal | null | undefined, err: unknown): boolean {
  if (!signal?.aborted) return false;
  if (isTimeoutError(signal.reason) || isTimeoutError(err)) return false;
  return true;
}

function withFreshFallbackSignal(init?: RequestInit): RequestInit | undefined {
  if (!init?.signal?.aborted) return init;
  if (!isTimeoutError(init.signal.reason)) return init;
  return { ...init, signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) };
}

export function createProxyAwareFetch(
  getHttpProxy?: () => string | undefined,
  options?: {
    readonly isElectron?: boolean;
    readonly isWsl?: boolean;
    readonly wslHostIp?: () => string | undefined;
    readonly baseFetch?: FetchLike;
  },
): FetchLike {
  const isElectron = options?.isElectron ?? Boolean((process.versions as Record<string, string | undefined>).electron);
  const inWsl = options?.isWsl ?? isWslEnvironment();
  const resolveWslHost = options?.wslHostIp ?? detectWslHostIp;
  const baseFetch: FetchLike = options?.baseFetch ?? ((input, init) => fetch(input, init));

  return async (input, init) => {
    const targetUrl = input instanceof URL ? input : new URL(String(input));

    if (!isElectron) {
      const proxyUrl = resolveHttpProxyUrl(targetUrl, getHttpProxy?.());
      if (proxyUrl) {
        try {
          return await fetchViaHttpProxy(targetUrl, proxyUrl, init);
        } catch (proxyErr) {
          if (isCallerManualAbort(init?.signal, proxyErr)) throw proxyErr;

          // WSL2 NAT：若配置了回环代理（如 Windows 同步过来的 127.0.0.1:7890），先尝试转发到 Windows 宿主机网关 IP
          if (inWsl && isLoopbackHost(proxyUrl.hostname)) {
            const hostIp = resolveWslHost();
            if (hostIp && hostIp !== proxyUrl.hostname) {
              const wslProxyUrl = new URL(proxyUrl.toString());
              wslProxyUrl.hostname = hostIp;
              try {
                return await fetchViaHttpProxy(targetUrl, wslProxyUrl, withFreshFallbackSignal(init));
              } catch (wslProxyErr) {
                if (isCallerManualAbort(init?.signal, wslProxyErr)) throw wslProxyErr;
              }
            }
          }

          // 代理不可达（如 WSL2 autoProxy 过期或宿主机代理已关闭）时回退直连，优先 IPv4 避开 WSL2 IPv6 黑洞
          const fallbackInit = withFreshFallbackSignal(init);
          try {
            return await fetchDirectNode(targetUrl, fallbackInit, 4);
          } catch {
            try {
              return await baseFetch(input, fallbackInit);
            } catch {
              throw proxyErr;
            }
          }
        }
      }
    }

    try {
      return await baseFetch(input, init);
    } catch (directErr) {
      if (isElectron || isCallerManualAbort(init?.signal, directErr)) throw directErr;
      // WSL2 / 纯 Node 运行时下原生 fetch（undici）遇 IPv6 黑洞或 DNS 隧道异常时，回退纯 IPv4 Node 直连
      if (inWsl && (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:')) {
        try {
          return await fetchDirectNode(targetUrl, withFreshFallbackSignal(init), 4);
        } catch {
          throw directErr;
        }
      }
      throw directErr;
    }
  };
}

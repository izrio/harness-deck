import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  createProxyAwareFetch,
  createProxyAwareWebSocket,
  describeFetchError,
  parseProcNetRouteGateway,
} from '../src/providers/proxyFetch.ts';

function listenServer(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('proxyFetch（WSL2 容错、压缩解压、重定向与错误展开）', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop();
      if (s) await closeServer(s);
    }
  });

  it('parseProcNetRouteGateway 正确解析小端十六进制默认网关 IPv4', () => {
    const sample = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t01A01BAC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'eth0\t00A01BAC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0',
    ].join('\n');
    expect(parseProcNetRouteGateway(sample)).toBe('172.27.160.1');
    expect(parseProcNetRouteGateway('Iface\tDestination\tGateway\n')).toBeUndefined();
  });

  it('describeFetchError 展开嵌套 cause 与 AggregateError 详情', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' });
    const wrapped = new TypeError('fetch failed', { cause: inner });
    expect(describeFetchError(wrapped)).toBe('fetch failed (connect ECONNREFUSED 127.0.0.1:7890)');

    const agg = new AggregateError(
      [
        Object.assign(new Error('2606:4700::1'), { code: 'ENETUNREACH' }),
        Object.assign(new Error('1.1.1.1'), { code: 'ETIMEDOUT' }),
      ],
      '',
    );
    const wrappedAgg = new TypeError('fetch failed', { cause: agg });
    expect(describeFetchError(wrappedAgg)).toContain('ENETUNREACH');
    expect(describeFetchError(wrappedAgg)).toContain('ETIMEDOUT');
  });

  it('通过 HTTP 代理自动解压 gzip 与 brotli 响应并跟随 302 重定向', async () => {
    const proxy = http.createServer((req, res) => {
      const target = req.url ?? '';
      if (target.endsWith('/redirect')) {
        res.writeHead(302, { Location: 'http://market.example.test/final-gzip' });
        res.end();
        return;
      }
      if (target.endsWith('/final-gzip')) {
        const body = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, enc: 'gzip' })));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        res.end(body);
        return;
      }
      if (target.endsWith('/br')) {
        const body = zlib.brotliCompressSync(Buffer.from(JSON.stringify({ ok: true, enc: 'br' })));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    servers.push(proxy);
    const proxyPort = await listenServer(proxy);

    const fetchImpl = createProxyAwareFetch(() => `http://127.0.0.1:${proxyPort}`, {
      isElectron: false,
      isWsl: false,
    });

    const redirected = await fetchImpl('http://market.example.test/redirect');
    expect(redirected.status).toBe(200);
    expect(await redirected.json()).toEqual({ ok: true, enc: 'gzip' });

    const brotli = await fetchImpl('http://market.example.test/br');
    expect(brotli.status).toBe(200);
    expect(await brotli.json()).toEqual({ ok: true, enc: 'br' });
  });

  it('WSL 环境下代理不可达时自动回退直连，且原生 fetch 失败时回退 IPv4 Node 直连', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ direct: true }));
    });
    servers.push(upstream);
    const upstreamPort = await listenServer(upstream);

    // 1. 原生 fetch 在 WSL 下模拟抛出 IPv6 黑洞错误 -> 自动回退 IPv4 Node 直连成功
    let baseFetchCalls = 0;
    const directFallbackFetch = createProxyAwareFetch(() => undefined, {
      isElectron: false,
      isWsl: true,
      baseFetch: async () => {
        baseFetchCalls++;
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' }),
        });
      },
    });
    const res = await directFallbackFetch(`http://127.0.0.1:${upstreamPort}/health`);
    expect(baseFetchCalls).toBe(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ direct: true });

    // 2. Electron 宿主下若系统/VS Code 代理不可达（如 127.0.0.1:7890 未启动），自动回退直连
    const electronFallbackFetch = createProxyAwareFetch(() => 'http://127.0.0.1:7890', {
      isElectron: true,
      isWsl: false,
      baseFetch: async () => {
        throw new Error('Failed to establish a socket connection to proxies: PROXY 127.0.0.1:7890');
      },
    });
    const electronRes = await electronFallbackFetch(`http://127.0.0.1:${upstreamPort}/health`);
    expect(electronRes.status).toBe(200);
    expect(await electronRes.json()).toEqual({ direct: true });
  });

  it('createProxyAwareWebSocket 支持 HTTP CONNECT 代理隧道，并在代理不可达时自动回退直连（兼容 WSL2 宿主机代理修复）', async () => {
    // 启动真实 WebSocket 服务端（回显消息）
    const wsHttp = http.createServer();
    const wss = new WebSocketServer({ server: wsHttp });
    wss.on('connection', (sock) => {
      sock.on('message', (data) => sock.send(`echo:${String(data)}`));
    });
    servers.push(wsHttp);
    const wsPort = await listenServer(wsHttp);

    // 启动真实 HTTP CONNECT 代理服务端，校验 Basic 认证与转发隧道
    const connectRequests: { readonly authority: string; readonly proxyAuth?: string }[] = [];
    const proxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on('connect', (req, clientSocket, head) => {
      connectRequests.push({
        authority: req.url ?? '',
        ...(typeof req.headers['proxy-authorization'] === 'string'
          ? { proxyAuth: req.headers['proxy-authorization'] }
          : {}),
      });
      const [host, portStr] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(portStr), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    servers.push(proxy);
    const proxyPort = await listenServer(proxy);

    const exchangeEcho = (factory: (url: string) => import('ws').default, url: string, msg: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const ws = factory(url);
        ws.once('open', () => ws.send(msg));
        ws.once('message', (data) => {
          ws.close();
          resolve(String(data));
        });
        ws.once('error', reject);
      });

    // 1. 代理可用时通过 HTTP CONNECT 隧道建连并携带 Proxy-Authorization
    const viaProxy = createProxyAwareWebSocket(() => `http://user:pass@127.0.0.1:${proxyPort}`, {
      isWsl: false,
      bypassLoopback: false,
    });
    expect(await exchangeEcho(viaProxy, `ws://127.0.0.1:${wsPort}`, 'hello-proxy')).toBe('echo:hello-proxy');
    expect(connectRequests).toHaveLength(1);
    expect(connectRequests[0]).toEqual({
      authority: `127.0.0.1:${wsPort}`,
      proxyAuth: `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`,
    });

    // 2. 代理不可达（模拟本地 127.0.0.1:7890 未启动）时自动回退直连，避免报 Failed to establish a socket connection to proxies
    const deadServer = net.createServer();
    const deadPort = await new Promise<number>((resolve, reject) => {
      deadServer.once('error', reject);
      deadServer.listen(0, '127.0.0.1', () => {
        const port = (deadServer.address() as AddressInfo).port;
        deadServer.close(() => resolve(port));
      });
    });
    const fallbackDirect = createProxyAwareWebSocket(() => `http://127.0.0.1:${deadPort}`, {
      isWsl: false,
      bypassLoopback: false,
      proxyConnectTimeoutMs: 1_000,
    });
    expect(await exchangeEcho(fallbackDirect, `ws://127.0.0.1:${wsPort}`, 'hello-direct')).toBe('echo:hello-direct');

    // 3. WSL2 NAT：回环代理失败后自动改试 Windows 宿主机网关 IP（此处用 localhost -> 127.0.0.1 模拟切换）
    const wslProxy = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    let wslProxyHits = 0;
    wslProxy.on('connect', (req, clientSocket, head) => {
      wslProxyHits += 1;
      const [host, portStr] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(portStr), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    servers.push(wslProxy);
    const wslProxyPort = await new Promise<number>((resolve, reject) => {
      wslProxy.once('error', reject);
      wslProxy.listen(0, '127.0.0.2', () => resolve((wslProxy.address() as AddressInfo).port));
    });
    const viaWslHost = createProxyAwareWebSocket(() => `http://127.0.0.1:${wslProxyPort}`, {
      isWsl: true,
      wslHostIp: () => '127.0.0.2',
      bypassLoopback: false,
      proxyConnectTimeoutMs: 1_000,
    });
    expect(await exchangeEcho(viaWslHost, `ws://127.0.0.1:${wsPort}`, 'hello-wsl-host')).toBe('echo:hello-wsl-host');
    expect(wslProxyHits).toBe(1);

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProxyAwareFetch,
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
  });
});

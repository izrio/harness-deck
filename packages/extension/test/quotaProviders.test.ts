import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FetchLike } from '../src/providers/proxyFetch.ts';
import {
  ANTIGRAVITY_CACHE_MS,
  clearAntigravityQuotaCache,
  queryAntigravityQuota,
} from '../src/quota/antigravity.ts';
import {
  clearCodebuddyQuotaCache,
  CODEBUDDY_CACHE_MS,
  queryCodebuddyQuota,
} from '../src/quota/codebuddy.ts';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const AGY_TOKEN = 'agy-access-token';
const AGY_EXPIRY = '2026-11-19T20:00:00.239248724Z';
const AGY_PRIMARY = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const AGY_FALLBACK = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const COOKIE = 'session=abc123; session_2=def456';
const CB_USAGE_PATH = '/billing/meter/get-enterprise-user-usage';
const CB_USAGE = { data: [{ used: 25, total: 100, resetTime: NOW / 1000 }] };

const tempDirs: string[] = [];

afterEach(async () => {
  clearAntigravityQuotaCache();
  clearCodebuddyQuotaCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jsonResponse(body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function writeToken(
  body: unknown,
  file = 'antigravity-cli/antigravity-oauth-token',
): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-antigravity-'));
  tempDirs.push(dir);
  const path = join(dir, '.gemini', file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return { HOME: dir };
}

const agyToken = (expiry = AGY_EXPIRY, accessToken = AGY_TOKEN) => ({ token: { access_token: accessToken, expiry } });

const agyQuota = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.878, resetTime: '2026-11-19T14:00:00.000Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.66, resetTime: '2026-11-22T12:00:00.123456789Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
      buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.2, resetTime: '2026-11-19T13:00:00.000Z' }],
    },
    {
      displayName: 'Gemini 4 Argon',
      description: 'For paid Pro plans, Argon quota is separate.',
      buckets: [
        {
          bucketId: 'gemini-argon-wtu-weekly',
          displayName: 'Gemini 4 Argon Weekly Limit',
          window: 'weekly',
          remainingFraction: 1,
          resetTime: '2026-11-26T12:00:00.000Z',
        },
      ],
    },
  ],
};

async function emptyHome(): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codebuddy-'));
  tempDirs.push(dir);
  return { HOME: dir };
}

describe('Antigravity 订阅额度查询', () => {
  it('纳秒级 expiry 可用，携带 CLI 版本 User-Agent，并完整映射多模型池与模型清单', async () => {
    const env = await writeToken(agyToken());
    const calls: { readonly url: string; readonly init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(agyQuota);
    };

    const quota = await queryAntigravityQuota({ env, fetchImpl, clientVersion: '1.6.2', now: () => NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(AGY_PRIMARY);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${AGY_TOKEN}`);
    expect(headers['user-agent']).toBe('antigravity/cli/1.6.2');
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0]?.init?.body).toBe('{}');
    expect(quota?.windows).toEqual([
      {
        kind: 'session',
        label: 'gemini',
        models: ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Gemini 3.8 Flash'],
        usedPercent: 12.2,
        remainingPercent: 87.8,
        resetsAt: Date.parse('2026-11-19T14:00:00.000Z'),
      },
      {
        kind: 'weekly',
        label: 'gemini',
        models: ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Gemini 3.8 Flash'],
        usedPercent: 34,
        remainingPercent: 66,
        resetsAt: Date.parse('2026-11-22T12:00:00.123Z'),
      },
      {
        kind: 'session',
        label: '3p',
        models: ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B'],
        usedPercent: 80,
        remainingPercent: 20,
        resetsAt: Date.parse('2026-11-19T13:00:00.000Z'),
      },
      {
        kind: 'weekly',
        label: 'Gemini 4 Argon',
        usedPercent: 0,
        remainingPercent: 100,
      },
    ]);
    expect(quota?.queriedAt).toBe(NOW);
    expect(JSON.stringify(quota)).not.toContain(AGY_TOKEN);
  });

  it('凭据缺失、过期或畸形时不发请求，备用凭据文件可用，未传版本时回退默认 CLI 版本', async () => {
    const missing = await writeToken({ token: { expiry: AGY_EXPIRY } });
    const expired = await writeToken(agyToken('2026-11-19T11:59:59.000Z', 'expired-token'));
    const malformed = await writeToken('not-json', 'antigravity-cli/antigravity-oauth-token');
    let calls = 0;
    let lastUa = '';
    const fetchImpl: FetchLike = async (_input, init) => {
      calls += 1;
      lastUa = (init?.headers as Record<string, string>)['user-agent'] ?? '';
      return jsonResponse(agyQuota);
    };
    for (const env of [missing, expired, malformed]) {
      expect(await queryAntigravityQuota({ env, fetchImpl, now: () => NOW })).toBeUndefined();
    }
    expect(calls).toBe(0);

    const fallback = await writeToken(agyToken(AGY_EXPIRY, 'fallback-token'), 'jetski-standalone-oauth-token');
    const quota = await queryAntigravityQuota({ env: fallback, fetchImpl, now: () => NOW });
    expect(quota?.windows).toHaveLength(4);
    expect(lastUa).toMatch(/^antigravity\/cli\/\d+\.\d+/u);
    expect(calls).toBe(1);

    // 主 CLI 凭据存在且含 refresh_token（等待 CLI 续期）时，不回退 IDE 凭据以免多账号切换时串号
    const mixedEnv = await writeToken(
      { token: { access_token: 'expired-cli', refresh_token: 'refresh-cli', expiry: '2026-11-19T11:59:59.000Z' } },
      'antigravity-cli/antigravity-oauth-token',
    );
    await writeFile(
      join(mixedEnv.HOME!, '.gemini', 'jetski-standalone-oauth-token'),
      JSON.stringify(agyToken(AGY_EXPIRY, 'other-ide-account-token')),
      'utf8',
    );
    expect(await queryAntigravityQuota({ env: mixedEnv, fetchImpl, now: () => NOW })).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('主域返回 500 时改走备用域', async () => {
    const env = await writeToken(agyToken(AGY_EXPIRY, 'region-token'));
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      urls.push(String(input));
      return urls.length === 1 ? new Response('{}', { status: 500 }) : jsonResponse(agyQuota);
    };

    const quota = await queryAntigravityQuota({ env, fetchImpl, now: () => NOW });

    expect(urls).toEqual([AGY_PRIMARY, AGY_FALLBACK]);
    expect(quota?.windows).toHaveLength(4);
  });

  it('跳过 disabled 窗口、满额时不附带占位重置时间、按 kind+label 去重；响应畸形时返回 undefined', async () => {
    const env = await writeToken(agyToken(AGY_EXPIRY, 'mapping-token'));
    const payload = {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-19T14:00:00.000Z' },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime: NOW / 1000 },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, disabled: true },
          ],
        },
        {
          displayName: '融合池',
          buckets: [{ bucketId: 'custom-5h', window: '5h', remainingFraction: 0.25 }],
        },
      ],
    };
    const quota = await queryAntigravityQuota({
      env,
      fetchImpl: async () => jsonResponse(payload),
      now: () => NOW,
    });

    expect(quota?.windows).toEqual([
      { kind: 'session', label: 'gemini', usedPercent: 0, remainingPercent: 100 },
      { kind: 'weekly', label: 'gemini', usedPercent: 100, remainingPercent: 0, resetsAt: NOW },
      { kind: 'session', label: '融合池', usedPercent: 75, remainingPercent: 25 },
    ]);

    const badEnv = await writeToken(agyToken(AGY_EXPIRY, 'bad-json-token'));
    const malformed: FetchLike = async () => new Response('<html>', { status: 200 });
    expect(await queryAntigravityQuota({ env: badEnv, fetchImpl: malformed, now: () => NOW })).toBeUndefined();
  });

  it('同一 token 在缓存有效期内不重复请求，clear 后可重新查询', async () => {
    const env = await writeToken(agyToken());
    let current = NOW;
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(agyQuota);
    };

    await queryAntigravityQuota({ env, fetchImpl, now: () => current });
    current += ANTIGRAVITY_CACHE_MS - 1;
    await queryAntigravityQuota({ env, fetchImpl, now: () => current });
    expect(calls).toBe(1);

    current += 2;
    await queryAntigravityQuota({ env, fetchImpl, now: () => current });
    expect(calls).toBe(2);

    clearAntigravityQuotaCache();
    await queryAntigravityQuota({ env, fetchImpl, now: () => current });
    expect(calls).toBe(3);
  });

  it('传入 rawTokenJson 时严格使用该账号槽位凭据，绝不误读磁盘或 IDE 备用凭据', async () => {
    const env = await writeToken(agyToken(AGY_EXPIRY, 'disk-account-a-token'), 'jetski-standalone-oauth-token');
    const seenAuth: string[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      seenAuth.push((init?.headers as Record<string, string>).authorization ?? '');
      return jsonResponse(agyQuota);
    };

    // 有效槽位 JSON：直接走该账号的 access_token
    const okQuota = await queryAntigravityQuota({
      env,
      rawTokenJson: JSON.stringify(agyToken(AGY_EXPIRY, 'slot-account-b-token')),
      fetchImpl,
      now: () => NOW,
    });
    expect(okQuota?.windows).toHaveLength(4);
    expect(seenAuth).toEqual(['Bearer slot-account-b-token']);

    // 过期槽位 JSON：直接返回 undefined，绝不回退读取磁盘上的 disk-account-a-token
    const expiredQuota = await queryAntigravityQuota({
      env,
      rawTokenJson: JSON.stringify(agyToken('2026-11-19T11:59:59.000Z', 'expired-slot-b')),
      fetchImpl,
      now: () => NOW,
    });
    expect(expiredQuota).toBeUndefined();
    expect(seenAuth).toEqual(['Bearer slot-account-b-token']);
  });

  it('同 token 并发查询合并为单次网络请求，并在失败时通过 onDebug 上报非敏感原因', async () => {
    const env = await writeToken(agyToken(AGY_EXPIRY, 'secret-concurrent-token'));
    let calls = 0;
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      await fetchGate;
      return jsonResponse(agyQuota);
    };

    const p1 = queryAntigravityQuota({ env, fetchImpl, now: () => NOW });
    const p2 = queryAntigravityQuota({ env, fetchImpl, now: () => NOW });
    releaseFetch?.();
    const [q1, q2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(q1?.windows).toHaveLength(4);
    expect(q2?.windows).toHaveLength(4);

    // onDebug 上报过期与 HTTP 失败原因，且绝不泄露 access_token
    const expiredReasons: string[] = [];
    const expiredRes = await queryAntigravityQuota({
      env,
      rawTokenJson: JSON.stringify(agyToken('2026-11-19T11:59:59.000Z', 'secret-expired-token')),
      fetchImpl,
      now: () => NOW,
      onDebug: (detail) => expiredReasons.push(detail),
    });
    expect(expiredRes).toBeUndefined();
    expect(expiredReasons).toEqual(['raw-token-expired']);
    expect(expiredReasons.join(';')).not.toContain('secret-expired-token');

    const httpReasons: string[] = [];
    const failEnv = await writeToken(agyToken(AGY_EXPIRY, 'secret-http-fail-token'));
    const failRes = await queryAntigravityQuota({
      env: failEnv,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
      now: () => NOW,
      onDebug: (detail) => httpReasons.push(detail),
    });
    expect(failRes).toBeUndefined();
    expect(httpReasons).toEqual([
      'https://daily-cloudcode-pa.googleapis.com http-401',
      'https://cloudcode-pa.googleapis.com http-401',
    ]);
    expect(httpReasons.join(';')).not.toContain('secret-http-fail-token');
  });
});

describe('CodeBuddy 订阅额度查询', () => {
  it('环境变量 Cookie 优先于文件，裸值自动补 session=' , async () => {
    const home = await emptyHome();
    await mkdir(join(home.HOME!, '.codebuddy'), { recursive: true });
    await writeFile(join(home.HOME!, '.codebuddy', 'usage-cookie'), '\nfile-cookie\n', 'utf8');
    let seen: string | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
      seen = (init?.headers as Record<string, string>).cookie;
      return jsonResponse(CB_USAGE);
    };

    await queryCodebuddyQuota({ env: { ...home, CODEBUDDY_COOKIE: ' env-cookie ' }, fetchImpl, now: () => NOW });
    expect(seen).toBe('session=env-cookie');

    clearCodebuddyQuotaCache();
    await queryCodebuddyQuota({ env: home, fetchImpl, now: () => NOW });
    expect(seen).toBe('session=file-cookie');
  });

  it('没有 Cookie 时不发请求', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(CB_USAGE);
    };
    const quota = await queryCodebuddyQuota({ env: await emptyHome(), fetchImpl, now: () => NOW });
    expect(quota).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('.cn 失败后改查 .ai，携带浏览器 UA 并自动发现企业 ID', async () => {
    const env = { ...(await emptyHome()), CODEBUDDY_COOKIE: COOKIE };
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const headers: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      urls.push(url);
      const h = init?.headers as Record<string, string>;
      headers.push(h);
      if (url.startsWith('https://www.codebuddy.cn')) return new Response('{}', { status: 401 });
      if (url.endsWith('/console/accounts')) return jsonResponse({ data: [{ enterpriseId: 'ent-42' }] });
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(CB_USAGE);
    };

    const quota = await queryCodebuddyQuota({ env, fetchImpl, now: () => NOW });

    expect(urls).toEqual([
      'https://www.codebuddy.cn/console/accounts',
      `https://www.codebuddy.cn${CB_USAGE_PATH}`,
      'https://www.codebuddy.ai/console/accounts',
      `https://www.codebuddy.ai${CB_USAGE_PATH}`,
    ]);
    expect(bodies).toEqual([{ enterpriseId: 'ent-42' }]);
    expect(headers.length).toBe(4);
    for (const h of headers) {
      expect(h.cookie).toBe(COOKIE);
      expect(h['user-agent']).toContain('Chrome/131');
    }
    expect(quota?.mode).toBe('credits');
    expect(quota?.windows).toEqual([
      {
        kind: 'cycle',
        label: '',
        usedPercent: 25,
        remainingPercent: 75,
        remainingAmount: 75,
        totalAmount: 100,
        usedAmount: 25,
        resetsAt: NOW,
      },
    ]);
  });

  it('宽容解析字段名与重置时间，保留积分数并追加命名的周期包窗口', async () => {
    const env = { ...(await emptyHome()), CODEBUDDY_COOKIE: 'session=tolerant' };
    const reset = Date.parse('2026-11-25T00:00:00.239Z');
    const fetchImpl: FetchLike = async (input, init) => {
      if (String(input).endsWith('/console/accounts')) return jsonResponse({ enterprise_id: 'ent-7' });
      expect(JSON.parse(String(init?.body))).toEqual({ enterpriseId: 'ent-7' });
      return jsonResponse({
        data: [
          {
            usedCredits: 30,
            quota: 200,
            expiresAt: '2026-11-25T00:00:00.239248724Z',
            packages: [
              { packageName: 'Pro', used: 5, total: 50, reset_at: (NOW + 1000) / 1000 },
              { name: 'Starter', usedPercent: 0.5 },
              { name: 'Bonus', balance: 320 },
              { name: 'Expired', used: 1, total: 2, reset_at: (NOW - 1000) / 1000 },
            ],
          },
        ],
      });
    };

    const quota = await queryCodebuddyQuota({ env, fetchImpl, now: () => NOW });

    expect(quota?.mode).toBe('credits');
    expect(quota?.windows).toEqual([
      {
        kind: 'cycle',
        label: '',
        usedPercent: 15,
        remainingPercent: 85,
        remainingAmount: 170,
        totalAmount: 200,
        usedAmount: 30,
        resetsAt: reset,
      },
      {
        kind: 'cycle',
        label: 'Pro',
        usedPercent: 10,
        remainingPercent: 90,
        remainingAmount: 45,
        totalAmount: 50,
        usedAmount: 5,
        resetsAt: NOW + 1000,
      },
      { kind: 'cycle', label: 'Starter', usedPercent: 50, remainingPercent: 50 },
      { kind: 'cycle', label: 'Bonus', usedPercent: 0, remainingPercent: 100, remainingAmount: 320 },
    ]);
  });

  it('总量不大于 0 时返回 undefined', async () => {
    const env = { ...(await emptyHome()), CODEBUDDY_COOKIE: 'session=zero' };
    const quota = await queryCodebuddyQuota({
      env,
      fetchImpl: async () => jsonResponse({ used: 5, total: 0 }),
      now: () => NOW,
    });
    expect(quota).toBeUndefined();
  });

  it('同一 Cookie 在缓存有效期内不重复请求，clear 后可重新查询', async () => {
    const env = { ...(await emptyHome()), CODEBUDDY_COOKIE: 'session=cache' };
    let current = NOW;
    let usageCalls = 0;
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).endsWith(CB_USAGE_PATH)) usageCalls += 1;
      return jsonResponse(CB_USAGE);
    };

    await queryCodebuddyQuota({ env, fetchImpl, now: () => current });
    current += CODEBUDDY_CACHE_MS - 1;
    await queryCodebuddyQuota({ env, fetchImpl, now: () => current });
    expect(usageCalls).toBe(1);

    current += 2;
    await queryCodebuddyQuota({ env, fetchImpl, now: () => current });
    expect(usageCalls).toBe(2);

    clearCodebuddyQuotaCache();
    await queryCodebuddyQuota({ env, fetchImpl, now: () => current });
    expect(usageCalls).toBe(3);
  });

  it('指定 CODEBUDDY_CONFIG_DIR 时不回退读取默认 ~/.codebuddy/usage-cookie 以免多账号串号', async () => {
    const home = await emptyHome();
    await mkdir(join(home.HOME!, '.codebuddy'), { recursive: true });
    await writeFile(join(home.HOME!, '.codebuddy', 'usage-cookie'), 'session=default-account', 'utf8');
    const isolatedDir = join(home.HOME!, 'isolated-cb');
    await mkdir(isolatedDir, { recursive: true });

    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(CB_USAGE);
    };
    // 隔离账号未配自己的 cookie 时返回 undefined，不串读默认账号 cookie
    expect(await queryCodebuddyQuota({ env: { ...home, CODEBUDDY_CONFIG_DIR: isolatedDir }, fetchImpl, now: () => NOW })).toBeUndefined();
    expect(calls).toBe(0);

    // 隔离账号配了自己的 cookie 文件后仅读取自己的 cookie
    let seenCookie: string | undefined;
    await writeFile(join(isolatedDir, 'usage-cookie'), 'session=isolated-account', 'utf8');
    const q = await queryCodebuddyQuota({
      env: { ...home, CODEBUDDY_CONFIG_DIR: isolatedDir },
      fetchImpl: async (_input, init) => {
        seenCookie = (init?.headers as Record<string, string>).cookie;
        return jsonResponse(CB_USAGE);
      },
      now: () => NOW,
    });
    expect(q?.mode).toBe('credits');
    expect(seenCookie).toBe('session=isolated-account');
  });
});

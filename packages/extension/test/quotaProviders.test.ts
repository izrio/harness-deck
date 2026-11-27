import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FetchLike } from '../src/providers/proxyFetch.ts';
import {
  ANTIGRAVITY_CACHE_MS,
  clearAntigravityQuotaCache,
  parseAntigravityUsageCliOutput,
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

const agyCliOutput = JSON.stringify({
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
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
    },
  },
});

async function emptyHome(): Promise<Record<string, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codebuddy-'));
  tempDirs.push(dir);
  return { HOME: dir };
}

describe('Antigravity 订阅额度查询', () => {
  it('仅通过官方 CLI 查询，严禁直连内部 HTTP 接口，并完整映射多模型池、纳秒时间与模型清单', async () => {
    const env = await writeToken(agyToken());
    let fetchCalls = 0;
    const fetchImpl: FetchLike = async () => {
      fetchCalls += 1;
      return jsonResponse({});
    };
    const cliCommands: string[] = [];

    const quota = await queryAntigravityQuota({
      env,
      fetchImpl,
      cliCommand: '/fake/agy',
      runCliUsage: async ({ command }) => {
        cliCommands.push(command);
        return agyCliOutput;
      },
      now: () => NOW,
    });

    expect(fetchCalls).toBe(0);
    expect(cliCommands).toEqual(['/fake/agy']);
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

  it('未传 cliCommand 时不发任何 HTTP 请求且不启子进程，并上报 cli-unavailable', async () => {
    const env = await writeToken(agyToken());
    let fetchCalls = 0;
    let cliCalls = 0;
    const reasons: string[] = [];
    const quota = await queryAntigravityQuota({
      env,
      rawTokenJson: JSON.stringify(agyToken()),
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({});
      },
      runCliUsage: async () => {
        cliCalls += 1;
        return agyCliOutput;
      },
      now: () => NOW,
      onDebug: (detail) => reasons.push(detail),
    });

    expect(quota).toBeUndefined();
    expect(fetchCalls).toBe(0);
    expect(cliCalls).toBe(0);
    expect(reasons).toEqual(['cli-unavailable']);
  });

  it('跳过 disabled 窗口、满额时不附带占位重置时间、按 kind+label 去重；输出畸形时返回 undefined', () => {
    const payload = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
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
        },
      },
    });
    const quota = parseAntigravityUsageCliOutput(payload, NOW);

    expect(quota?.windows).toEqual([
      { kind: 'session', label: 'gemini', usedPercent: 0, remainingPercent: 100 },
      { kind: 'weekly', label: 'gemini', usedPercent: 100, remainingPercent: 0, resetsAt: NOW },
      { kind: 'session', label: '融合池', usedPercent: 75, remainingPercent: 25 },
    ]);

    expect(parseAntigravityUsageCliOutput('<html>', NOW)).toBeUndefined();
    expect(parseAntigravityUsageCliOutput('', NOW)).toBeUndefined();
  });

  it('解析 agy -p /usage --output-format json 输出（兼容 snake_case 与剩余 0% 省略字段）', () => {
    const cliStdout = JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.7488,
                  reset_time: '2026-12-02T07:15:22Z',
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  // 模拟 Go json:",omitempty" 在剩余额度恰好为 0 时省略 remaining_fraction
                  reset_time: '2026-11-25T12:15:22Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
              buckets: [
                {
                  id: '3p-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 1,
                  reset_time: '2026-11-25T14:54:59Z',
                },
              ],
            },
          ],
        },
      },
    });

    const parsed = parseAntigravityUsageCliOutput(`non-json debug line\n${cliStdout}\n`, NOW);
    expect(parsed).toEqual({
      windows: [
        {
          kind: 'weekly',
          label: 'gemini',
          models: ['Gemini 4 Neon', 'Gemini 4 Carbon'],
          usedPercent: 25.1,
          remainingPercent: 74.9,
          resetsAt: Date.parse('2026-12-02T07:15:22Z'),
        },
        {
          kind: 'session',
          label: 'gemini',
          models: ['Gemini 4 Neon', 'Gemini 4 Carbon'],
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: Date.parse('2026-11-25T12:15:22Z'),
        },
        {
          kind: 'session',
          label: '3p',
          models: ['Claude Opus 5.5', 'GPT-OSS 120B'],
          usedPercent: 0,
          remainingPercent: 100,
        },
      ],
      queriedAt: NOW,
    });

    expect(parseAntigravityUsageCliOutput(JSON.stringify({ status: 'ERROR', command: { name: 'usage', data: {} } }), NOW)).toBeUndefined();
  });

  it('空主目录不触发 CLI；存在 ~/.gemini 时合并并发、缓存 5 分钟、clear 后可重查，并在失败时上报非敏感原因', async () => {
    const cliPayload = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-12-02T07:15:22Z' },
                { id: 'gemini-5h', window: '5h', remaining_fraction: 0.01, reset_time: '2026-11-25T12:15:22Z' },
              ],
            },
          ],
        },
      },
    });

    // 1. 全新空 HOME（从未初始化 ~/.gemini）：不启动 CLI，直接返回 undefined 并上报 disk-token-missing
    let cliCalls = 0;
    const emptyReasons: string[] = [];
    const brandNewHome = await emptyHome();
    const emptyRes = await queryAntigravityQuota({
      env: brandNewHome,
      cliCommand: '/fake/agy',
      runCliUsage: async () => {
        cliCalls += 1;
        return cliPayload;
      },
      now: () => NOW,
      onDebug: (detail) => emptyReasons.push(detail),
    });
    expect(emptyRes).toBeUndefined();
    expect(cliCalls).toBe(0);
    expect(emptyReasons).toEqual(['disk-token-missing']);

    // 2. 存在 ~/.gemini（例如 token 托管在 OS Keyring 无磁盘文件）：并发查询仅执行一次并命中 5 分钟缓存
    const keyringHome = await emptyHome();
    await mkdir(join(keyringHome.HOME!, '.gemini', 'antigravity-cli'), { recursive: true });
    let current = NOW;
    let releaseCli: (() => void) | undefined;
    const cliGate = new Promise<void>((resolve) => {
      releaseCli = resolve;
    });
    const runCliUsage = async () => {
      cliCalls += 1;
      await cliGate;
      return cliPayload;
    };
    const [q1, q2] = await Promise.all([
      queryAntigravityQuota({ env: keyringHome, cliCommand: '/fake/agy', runCliUsage, now: () => current }),
      (async () => {
        const p = queryAntigravityQuota({ env: keyringHome, cliCommand: '/fake/agy', runCliUsage, now: () => current });
        releaseCli?.();
        return p;
      })(),
    ]);
    expect(cliCalls).toBe(1);
    expect(q1?.windows.map((w) => [w.kind, w.remainingPercent])).toEqual([
      ['weekly', 75],
      ['session', 1],
    ]);
    expect(q2?.windows).toEqual(q1?.windows);

    // 缓存有效期内再次查询直接命中缓存
    current += ANTIGRAVITY_CACHE_MS - 1;
    const q3 = await queryAntigravityQuota({
      env: keyringHome,
      cliCommand: '/fake/agy',
      runCliUsage: async () => {
        cliCalls += 1;
        return cliPayload;
      },
      now: () => current,
    });
    expect(cliCalls).toBe(1);
    expect(q3?.windows).toEqual(q1?.windows);

    // 过期后重新查询
    current += 2;
    await queryAntigravityQuota({
      env: keyringHome,
      cliCommand: '/fake/agy',
      runCliUsage: async () => {
        cliCalls += 1;
        return cliPayload;
      },
      now: () => current,
    });
    expect(cliCalls).toBe(2);

    // clear 后可立即重查
    clearAntigravityQuotaCache();
    await queryAntigravityQuota({
      env: keyringHome,
      cliCommand: '/fake/agy',
      runCliUsage: async () => {
        cliCalls += 1;
        return cliPayload;
      },
      now: () => current,
    });
    expect(cliCalls).toBe(3);

    // 3. CLI 异常或空输出时上报非敏感原因
    clearAntigravityQuotaCache();
    const errReasons: string[] = [];
    const failed = await queryAntigravityQuota({
      env: keyringHome,
      cliCommand: '/fake/agy',
      runCliUsage: async () => {
        const err = new Error('spawn failed') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      now: () => current,
      onDebug: (detail) => errReasons.push(detail),
    });
    expect(failed).toBeUndefined();
    expect(errReasons).toEqual(['cli-error-ENOENT']);
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

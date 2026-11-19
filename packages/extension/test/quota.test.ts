import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../src/providers/proxyFetch.ts';
import { clearQuotaCache, queryClaudeQuota, QUOTA_CACHE_MS } from '../src/claude/quota.ts';

const TOKEN = 'sk-ant-oat01-secret-token';
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const tempDirs: string[] = [];

afterEach(async () => {
  clearQuotaCache();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeCredentials(body: unknown): Promise<{ env: Record<string, string | undefined>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-quota-'));
  tempDirs.push(dir);
  const configDir = join(dir, 'claude-config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, '.credentials.json'), JSON.stringify(body), 'utf8');
  return { env: { HOME: dir, CLAUDE_CONFIG_DIR: configDir }, dir: configDir };
}

const official = (overrides: Record<string, unknown> = {}) => ({
  claudeAiOauth: { accessToken: TOKEN, subscriptionType: 'max', expiresAt: NOW + 3_600_000, ...overrides },
});

function fetchJson(body: unknown, status = 200): FetchLike {
  return (async (input, init) => {
    expect(String(input)).toBe('https://api.anthropic.com/api/oauth/usage');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as FetchLike;
}

describe('Claude 官方订阅额度查询', () => {
  it('解析新结构 limits[]：窗口、模型名、重置时间和额外用量', async () => {
    const { env } = await writeCredentials(official());
    const fetchImpl = fetchJson({
      limits: [
        { kind: 'session', percent: 42.5, resets_at: '2026-11-19T14:00:00.000Z', severity: 'normal', is_active: true },
        { kind: 'weekly_all', percent: 76, resets_at: '2026-11-22T12:00:00.000Z', severity: 'warning' },
        { kind: 'weekly_scoped', percent: 91, severity: 'critical', scope: { model: { display_name: 'Fable' } } },
      ],
      extra_usage: { is_enabled: true, utilization: 18 },
    });
    const quota = await queryClaudeQuota({ env, fetchImpl, now: () => NOW });
    expect(quota?.windows).toEqual([
      { kind: 'session', label: '', usedPercent: 42.5, remainingPercent: 57.5, resetsAt: Date.parse('2026-11-19T14:00:00.000Z'), severity: 'normal', isActive: true },
      { kind: 'weekly', label: '', usedPercent: 76, remainingPercent: 24, resetsAt: Date.parse('2026-11-22T12:00:00.000Z'), severity: 'warning' },
      { kind: 'weeklyModel', label: 'Fable', usedPercent: 91, remainingPercent: 9, severity: 'critical' },
    ]);
    expect(quota?.extraUsage).toEqual({ usedPercent: 18, remainingPercent: 82 });
    expect(quota?.queriedAt).toBe(NOW);
    expect(JSON.stringify(quota)).not.toContain(TOKEN);
  });

  it('兼容旧的平铺字段，并把 0–1 的比例换算成百分数', async () => {
    const { env } = await writeCredentials(official());
    const fetchImpl = fetchJson({
      five_hour: { utilization: 0.3, resets_at: '2026-11-19T14:00:00.000Z' },
      seven_day: { utilization: 0.75 },
      seven_day_opus: { utilization: 0.1 },
    });
    const quota = await queryClaudeQuota({ env, fetchImpl, now: () => NOW });
    expect(quota?.windows.map((w) => [w.kind, w.label, w.usedPercent])).toEqual([
      ['session', '', 30],
      ['weekly', '', 75],
      ['weeklyModel', 'Opus', 10],
    ]);
  });

  it('没有订阅凭据或凭据过期时不发请求', async () => {
    const missing = await writeCredentials({});
    const expired = await writeCredentials(official({ expiresAt: NOW - 1 }));
    const apiKeyOnly = await writeCredentials({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 3_600_000 } });
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response('{}');
    };
    for (const env of [missing.env, expired.env, apiKeyOnly.env]) {
      expect(await queryClaudeQuota({ env, fetchImpl, now: () => NOW })).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it('请求失败、响应畸形或无可用窗口时返回 undefined', async () => {
    const { env } = await writeCredentials(official());
    const unauthorized: FetchLike = async () => new Response('{}', { status: 401 });
    expect(await queryClaudeQuota({ env, fetchImpl: unauthorized, now: () => NOW })).toBeUndefined();

    const malformed: FetchLike = async () => new Response('<html>', { status: 200 });
    expect(await queryClaudeQuota({ env, fetchImpl: malformed, now: () => NOW })).toBeUndefined();

    const empty = fetchJson({ limits: [] });
    expect(await queryClaudeQuota({ env, fetchImpl: empty, now: () => NOW })).toBeUndefined();
  });

  it('同一 token 在 5 分钟内命中缓存，过期后重新查询', async () => {
    const { env } = await writeCredentials(official());
    const payload = { limits: [{ kind: 'session', percent: 20 }] };
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    await queryClaudeQuota({ env, fetchImpl, now: () => NOW });
    await queryClaudeQuota({ env, fetchImpl, now: () => NOW + QUOTA_CACHE_MS - 1 });
    expect(calls).toBe(1);
    await queryClaudeQuota({ env, fetchImpl, now: () => NOW + QUOTA_CACHE_MS + 1 });
    expect(calls).toBe(2);
  });
});

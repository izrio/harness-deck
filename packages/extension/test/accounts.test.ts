import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { ProviderConfig } from '@harness-deck/shared';
import {
  accountApiKeySecretKey,
  accountSlotSecretKey,
  activeOfficialAccountId,
  deleteAccountSetting,
  effectiveProviderForBackend,
  maskSecretValue,
  parseAccountsSetting,
  parseBackendChannelsSetting,
  resolveBackendChannel,
  setBackendChannelSetting,
  systemAccountId,
  upsertAccountSetting,
} from '../src/accounts/AccountStore.ts';
import {
  antigravityPrimaryTokenPath,
  clearAccountCredentials,
  codebuddyAuthDir,
  codebuddyInternetEnvForRegion,
  prepareAccountLaunchPatch,
  removeIsolatedAccountData,
  switchAntigravityCredentialSlot,
  switchCodebuddyCredentialSlot,
} from '../src/accounts/AccountIsolation.ts';
import { decodeJwtPayloadUnsafe, inspectOfficialAccount } from '../src/accounts/AccountInspector.ts';
import type { SecretStore } from '../src/host/HostPlatform.ts';

function memorySecrets(): SecretStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key),
    store: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    onDidChange: () => () => undefined,
  };
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('AccountStore', () => {
  const sampleProvider: ProviderConfig = {
    id: 'volc',
    name: 'Volcengine',
    anthropicUrl: 'https://ark.example.com/anthropic',
    openaiChatUrl: 'https://ark.example.com/v3',
    models: [{ id: 'model-a', name: 'Model A' }],
    boundBackendIds: ['claude'],
  };

  it('supports adding, updating, deduplicating, and deleting official accounts', () => {
    const first = upsertAccountSetting([], { backendId: 'claude', label: 'Work Max' }, () => 1000);
    assert.equal(first.accounts.length, 1);
    assert.equal(first.account.id, 'claude-work-max');

    // 同名新增自动加后缀避免冲突
    const second = upsertAccountSetting(first.accounts, { backendId: 'claude', label: 'Work Max' }, () => 2000);
    assert.equal(second.accounts.length, 2);
    assert.equal(second.account.id, 'claude-work-max-2');

    // 更新已有账号保留 createdAt 与 id
    const updated = upsertAccountSetting(
      second.accounts,
      { id: first.account.id, backendId: 'claude', label: 'Work Max Pro', isolateSessions: true },
      () => 3000,
    );
    assert.equal(updated.accounts.length, 2);
    assert.equal(updated.account.createdAt, 1000);
    assert.equal(updated.account.isolateSessions, true);

    // 删除正被激活路由引用的账号时自动回退到本机默认官方账号
    const channels = setBackendChannelSetting({}, 'claude', { mode: 'official', accountId: first.account.id });
    const removed = deleteAccountSetting(updated.accounts, channels, first.account.id);
    assert.equal(removed.accounts.length, 1);
    assert.deepEqual(removed.channels.claude, { mode: 'official', accountId: systemAccountId('claude') });
  });

  it('keeps backward compatibility with legacy provider boundBackendIds while allowing official switching', () => {
    const { accounts, account } = upsertAccountSetting([], { backendId: 'claude', label: 'Personal' }, () => 1000);

    // 未显式设置 backendChannels 时，自动兼容旧配置里绑定的服务商
    const legacyBinding = resolveBackendChannel('claude', {}, [sampleProvider], accounts);
    assert.deepEqual(legacyBinding, { mode: 'provider', providerId: 'volc' });
    assert.equal(effectiveProviderForBackend('claude', {}, [sampleProvider], accounts)?.id, 'volc');

    // 显式切到官方账号后，即使服务商配置仍保留 boundBackendIds，也不再走服务商代理
    const switchedToOfficial = setBackendChannelSetting({}, 'claude', { mode: 'official', accountId: account.id });
    assert.deepEqual(resolveBackendChannel('claude', switchedToOfficial, [sampleProvider], accounts), {
      mode: 'official',
      accountId: account.id,
    });
    assert.equal(effectiveProviderForBackend('claude', switchedToOfficial, [sampleProvider], accounts), undefined);
    assert.equal(activeOfficialAccountId('claude', switchedToOfficial, [sampleProvider], accounts), account.id);

    // 随时可再切回服务商
    const switchedBack = setBackendChannelSetting(switchedToOfficial, 'claude', { mode: 'provider', providerId: 'volc' });
    assert.equal(effectiveProviderForBackend('claude', switchedBack, [sampleProvider], accounts)?.id, 'volc');
    assert.equal(activeOfficialAccountId('claude', switchedBack, [sampleProvider], accounts), undefined);
  });

  it('parses settings safely and masks secrets', () => {
    const parsedAccounts = parseAccountsSetting([
      { id: 'system:claude', backendId: 'claude', label: 'Bad System Override' },
      { id: 'acc-1', backendId: 'codex', label: 'Team', region: 'invalid', createdAt: 1234 },
      { id: 'acc-2', backendId: 'codebuddy', label: 'Intl', region: 'ai', isolateSessions: true },
    ]);
    assert.equal(parsedAccounts.length, 2);
    assert.equal(parsedAccounts[0]?.region, undefined);
    assert.equal(parsedAccounts[1]?.region, 'ai');

    const parsedChannels = parseBackendChannelsSetting({
      claude: { mode: 'official', accountId: 'acc-1' },
      codex: { mode: 'provider', providerId: 'volc' },
      bad: { mode: 'provider' },
    });
    assert.deepEqual(parsedChannels, {
      claude: { mode: 'official', accountId: 'acc-1' },
      codex: { mode: 'provider', providerId: 'volc' },
    });

    assert.equal(maskSecretValue('sk-1234567890abcdef'), 'sk-123…cdef');
    assert.equal(maskSecretValue('short'), '••••••••');
  });
});

describe('AccountIsolation & AccountInspector', () => {
  it('isolates L1 config directories without overriding HOME and supports shared vs isolated sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-accounts-test-'));
    try {
      const fakeHome = join(root, 'home');
      const storageRoot = join(root, 'storage');
      const secrets = memorySecrets();

      // 准备本机 ~/.claude/projects 以便验证软链共享
      await mkdir(join(fakeHome, '.claude', 'projects'), { recursive: true });
      await writeFile(join(fakeHome, '.claude', 'projects', 'marker.txt'), 'shared', 'utf8');

      const sharedPatch = await prepareAccountLaunchPatch({
        backendId: 'claude',
        accountId: 'claude-work',
        account: { id: 'claude-work', backendId: 'claude', label: 'Work', createdAt: 1 },
        storageRoot,
        baseEnv: { HOME: fakeHome },
        secrets,
      });
      assert.equal(sharedPatch.env.HOME, fakeHome);
      assert.ok(sharedPatch.configDir);
      assert.equal(sharedPatch.env.CLAUDE_CONFIG_DIR, sharedPatch.configDir);
      const sharedMarker = await readFile(join(sharedPatch.configDir, 'projects', 'marker.txt'), 'utf8');
      assert.equal(sharedMarker, 'shared');

      // 开启 isolateSessions 时不软链 projects
      const isolatedPatch = await prepareAccountLaunchPatch({
        backendId: 'claude',
        accountId: 'claude-isolated',
        account: { id: 'claude-isolated', backendId: 'claude', label: 'Iso', isolateSessions: true, createdAt: 1 },
        storageRoot,
        baseEnv: { HOME: fakeHome },
        secrets,
      });
      assert.ok(isolatedPatch.configDir);
      const hasProjects = await stat(join(isolatedPatch.configDir, 'projects'))
        .then(() => true)
        .catch(() => false);
      assert.equal(hasProjects, false);

      // 写入隔离账号的 Claude 凭据并验证只读状态探测（含脱敏身份和套餐）
      await writeFile(
        join(sharedPatch.configDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'secret-token-never-exposed',
            subscriptionType: 'max',
            expiresAt: Date.now() + 3600_000,
          },
        }),
        'utf8',
      );
      await writeFile(
        join(sharedPatch.configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } }),
        'utf8',
      );
      const inspected = await inspectOfficialAccount({
        backendId: 'claude',
        accountId: 'claude-work',
        storageRoot,
        baseEnv: { HOME: fakeHome },
        secrets,
      });
      assert.equal(inspected.status, 'authenticated');
      assert.equal(inspected.identity, 'work@example.com');
      assert.equal(inspected.plan, 'Max');
      assert.equal(JSON.stringify(inspected).includes('secret-token-never-exposed'), false);

      // 登出仅删除凭据文件，保留账号目录与共享项目文件
      await clearAccountCredentials({
        backendId: 'claude',
        accountId: 'claude-work',
        storageRoot,
        baseEnv: { HOME: fakeHome },
        secrets,
      });
      const afterLogout = await inspectOfficialAccount({
        backendId: 'claude',
        accountId: 'claude-work',
        storageRoot,
        baseEnv: { HOME: fakeHome },
        secrets,
      });
      assert.equal(afterLogout.status, 'unauthenticated');
      assert.equal(await readFile(join(fakeHome, '.claude', 'projects', 'marker.txt'), 'utf8'), 'shared');

      // 删除独立账号不触碰本机 ~/.claude
      await removeIsolatedAccountData({
        backendId: 'claude',
        accountId: 'claude-work',
        storageRoot,
        secrets,
      });
      assert.equal(await readFile(join(fakeHome, '.claude', 'projects', 'marker.txt'), 'utf8'), 'shared');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('switches Antigravity L2 credential slots atomically and inspects Codex JWT & dsh API key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-accounts-slot-'));
    try {
      const fakeHome = join(root, 'home');
      const storageRoot = join(root, 'storage');
      const secrets = memorySecrets();
      const env = { HOME: fakeHome };

      // 模拟本机已有默认 Antigravity 凭据
      const tokenPath = antigravityPrimaryTokenPath(env);
      await mkdir(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
      const sysToken = JSON.stringify({
        email: 'sys@gmail.com',
        token: { access_token: 'sys-tok', expiry: new Date(Date.now() + 3600_000).toISOString() },
      });
      const workToken = JSON.stringify({
        email: 'work@gmail.com',
        token: { access_token: 'work-tok', expiry: new Date(Date.now() + 7200_000).toISOString() },
      });
      await writeFile(tokenPath, sysToken, 'utf8');
      await secrets.store(accountSlotSecretKey('agy-work'), workToken);

      // 从默认号切到工作号：自动备份系统号并写入工作号到磁盘
      const sw = await switchAntigravityCredentialSlot({
        targetAccountId: 'agy-work',
        previousAccountId: systemAccountId('antigravity'),
        secrets,
        env,
      });
      assert.equal(sw.activated, true);
      assert.equal(await readFile(tokenPath, 'utf8'), workToken);
      assert.equal(secrets.map.get(accountSlotSecretKey(systemAccountId('antigravity'))), sysToken);

      const agyInsp = await inspectOfficialAccount({
        backendId: 'antigravity',
        accountId: 'agy-work',
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(agyInsp.status, 'authenticated');
      assert.equal(agyInsp.identity, 'work@gmail.com');

      // 验证 Codex auth.json JWT payload 提取（不泄露 token）
      const codexPatch = await prepareAccountLaunchPatch({
        backendId: 'codex',
        accountId: 'codex-pro',
        account: { id: 'codex-pro', backendId: 'codex', label: 'Pro', createdAt: 1 },
        storageRoot,
        baseEnv: env,
        secrets,
      });
      const jwt = makeFakeJwt({
        email: 'dev@openai.test',
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      });
      assert.equal(decodeJwtPayloadUnsafe(jwt)?.email, 'dev@openai.test');
      await writeFile(
        join(codexPatch.configDir!, 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'access-secret', id_token: jwt } }),
        'utf8',
      );
      const codexInsp = await inspectOfficialAccount({
        backendId: 'codex',
        accountId: 'codex-pro',
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(codexInsp.status, 'authenticated');
      assert.equal(codexInsp.identity, 'dev@openai.test');
      assert.equal(codexInsp.plan, 'Plus');

      // 验证 dsh 官方 API Key 账号注入与掩码探测
      await secrets.store(accountApiKeySecretKey('dsh-team'), 'sk-team-secret-key-9876');
      const dshPatch = await prepareAccountLaunchPatch({
        backendId: 'dsh',
        accountId: 'dsh-team',
        account: { id: 'dsh-team', backendId: 'dsh', label: 'Team Key', createdAt: 1 },
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(dshPatch.env.DEEPSEEK_API_KEY, 'sk-team-secret-key-9876');
      const dshInsp = await inspectOfficialAccount({
        backendId: 'dsh',
        accountId: 'dsh-team',
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(dshInsp.status, 'authenticated');
      assert.equal(dshInsp.identity, 'sk-tea…9876');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats expired OAuth access_token with refresh_token as authenticated and refreshes active Antigravity slot from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-accounts-refresh-'));
    try {
      const fakeHome = join(root, 'home');
      const storageRoot = join(root, 'storage');
      const secrets = memorySecrets();
      const env = { HOME: fakeHome };
      const nowMs = 1_800_000_000_000;

      // 1. Antigravity：access_token 已过期但存在 refresh_token → 仍为 authenticated
      const refreshableToken = JSON.stringify({
        email: 'user@gmail.com',
        token: {
          access_token: 'old-access',
          refresh_token: 'valid-refresh-token',
          expiry: new Date(nowMs - 3600_000).toISOString(),
        },
      });
      await secrets.store(accountSlotSecretKey('agy-refreshable'), refreshableToken);
      const agyRefreshable = await inspectOfficialAccount({
        backendId: 'antigravity',
        accountId: 'agy-refreshable',
        storageRoot,
        baseEnv: env,
        secrets,
        now: () => nowMs,
      });
      assert.equal(agyRefreshable.status, 'authenticated');
      assert.equal(agyRefreshable.identity, 'user@gmail.com');

      // 2. Antigravity：无 refresh_token 且 access_token 已过期 → expired
      const trulyExpiredToken = JSON.stringify({
        email: 'expired@gmail.com',
        token: {
          access_token: 'dead-access',
          expiry: new Date(nowMs - 3600_000).toISOString(),
        },
      });
      await secrets.store(accountSlotSecretKey('agy-expired'), trulyExpiredToken);
      const agyExpired = await inspectOfficialAccount({
        backendId: 'antigravity',
        accountId: 'agy-expired',
        storageRoot,
        baseEnv: env,
        secrets,
        now: () => nowMs,
      });
      assert.equal(agyExpired.status, 'expired');

      // 3. Antigravity 当前激活槽位优先读取磁盘上已被 CLI 刷新的最新 token，并同步回 SecretStorage
      const tokenPath = antigravityPrimaryTokenPath(env);
      await mkdir(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
      const freshDiskToken = JSON.stringify({
        email: 'user@gmail.com',
        token: {
          access_token: 'fresh-access',
          refresh_token: 'valid-refresh-token',
          expiry: new Date(nowMs + 3600_000).toISOString(),
        },
      });
      await writeFile(tokenPath, freshDiskToken, 'utf8');
      const agyActive = await inspectOfficialAccount({
        backendId: 'antigravity',
        accountId: 'agy-refreshable',
        isActiveSlot: true,
        storageRoot,
        baseEnv: env,
        secrets,
        now: () => nowMs,
      });
      assert.equal(agyActive.status, 'authenticated');
      assert.equal(agyActive.expiresAt, nowMs + 3600_000);
      assert.equal(secrets.map.get(accountSlotSecretKey('agy-refreshable')), freshDiskToken);

      // 4. Claude：accessToken 已过期但有 refreshToken → authenticated
      await mkdir(join(fakeHome, '.claude'), { recursive: true });
      await writeFile(
        join(fakeHome, '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'old-claude-access',
            refreshToken: 'valid-claude-refresh',
            subscriptionType: 'pro',
            expiresAt: nowMs - 60_000,
          },
        }),
        'utf8',
      );
      const claudeRefreshable = await inspectOfficialAccount({
        backendId: 'claude',
        accountId: systemAccountId('claude'),
        storageRoot,
        baseEnv: env,
        secrets,
        now: () => nowMs,
      });
      assert.equal(claudeRefreshable.status, 'authenticated');
      assert.equal(claudeRefreshable.plan, 'Pro');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports CodeBuddy region mapping, API Key isolation, and OAuth credential slot detection & switching', async () => {
    assert.equal(codebuddyInternetEnvForRegion('cn'), 'internal');
    assert.equal(codebuddyInternetEnvForRegion('ai'), 'external');
    assert.equal(codebuddyInternetEnvForRegion('internal'), 'ioa');
    assert.equal(codebuddyInternetEnvForRegion(undefined), undefined);

    const root = await mkdtemp(join(tmpdir(), 'hd-accounts-cb-'));
    try {
      const fakeHome = join(root, 'home');
      const storageRoot = join(root, 'storage');
      const secrets = memorySecrets();
      const env = { HOME: fakeHome };

      // 1. 独立账号配置 CODEBUDDY_API_KEY + cn 区域：注入正确环境变量且直接识别为已登录
      await secrets.store(accountApiKeySecretKey('cb-team'), 'cb-secret-api-key-9999');
      const cbAcc = { id: 'cb-team', backendId: 'codebuddy', label: '团队号', region: 'cn' as const, createdAt: 1 };
      const patch = await prepareAccountLaunchPatch({
        backendId: 'codebuddy',
        accountId: 'cb-team',
        account: cbAcc,
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(patch.env.CODEBUDDY_API_KEY, 'cb-secret-api-key-9999');
      assert.equal(patch.env.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal');
      assert.ok(patch.configDir);

      const apiKeyInsp = await inspectOfficialAccount({
        backendId: 'codebuddy',
        accountId: 'cb-team',
        account: cbAcc,
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(apiKeyInsp.status, 'authenticated');
      assert.equal(apiKeyInsp.identity, 'cb-sec…9999');
      assert.equal(apiKeyInsp.plan, 'CN · API Key');
      assert.equal(apiKeyInsp.hasSecret, true);

      // 2. OAuth 凭据槽位（CodeBuddyExtension/Data/Public/auth/*.info）识别与原子切换
      const authDir = codebuddyAuthDir(env);
      await mkdir(authDir, { recursive: true });
      await writeFile(join(authDir, 'abc123.info'), 'encrypted-sys-session', 'utf8');
      const sysInsp = await inspectOfficialAccount({
        backendId: 'codebuddy',
        accountId: systemAccountId('codebuddy'),
        isActiveSlot: true,
        storageRoot,
        baseEnv: env,
        secrets,
      });
      assert.equal(sysInsp.status, 'authenticated');

      const altSnapshot = JSON.stringify({ files: { 'abc123.info': 'encrypted-alt-session' } });
      await secrets.store(accountSlotSecretKey('cb-alt'), altSnapshot);
      const sw = await switchCodebuddyCredentialSlot({
        targetAccountId: 'cb-alt',
        previousAccountId: systemAccountId('codebuddy'),
        secrets,
        env,
      });
      assert.equal(sw.activated, true);
      assert.equal(await readFile(join(authDir, 'abc123.info'), 'utf8'), 'encrypted-alt-session');
      assert.ok(secrets.map.get(accountSlotSecretKey(systemAccountId('codebuddy')))?.includes('encrypted-sys-session'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

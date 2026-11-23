/**
 * 官方账号凭据状态只读探测与按账号额度查询。
 *
 * 安全红线：
 * - 只读取凭据文件的状态、脱敏身份（邮箱 / 提供方名 / 掩码 Key）、订阅套餐与过期时间；
 * - 绝不把任何 Token、Refresh Token、Cookie 或明文 API Key 返回给调用方或写入日志；
 * - 不主动刷新会破坏 CLI 自身 token rotation 的 OAuth 凭据。
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AccountAuthStatus, AccountConfig, QuotaView } from '@harness-deck/shared';
import { queryClaudeQuota } from '../claude/quota.ts';
import type { SecretStore } from '../host/HostPlatform.ts';
import { createProxyAwareFetch, type FetchLike } from '../providers/proxyFetch.ts';
import { queryAntigravityQuota } from '../quota/antigravity.ts';
import { queryCodebuddyQuota } from '../quota/codebuddy.ts';
import { parseEpochMs, rec, type Rec } from '../quota/util.ts';
import {
  accountApiKeySecretKey,
  accountCookieSecretKey,
  accountSlotSecretKey,
  isSystemAccountId,
  maskSecretValue,
} from './AccountStore.ts';
import {
  accountIsolationDir,
  antigravityFallbackTokenPath,
  antigravityPrimaryTokenPath,
  codebuddyInternetEnvForRegion,
  readAntigravityDiskTokenRaw,
  readCodebuddyDiskAuthSnapshot,
  resolveUserHome,
} from './AccountIsolation.ts';

export interface AccountInspectionResult {
  readonly status: AccountAuthStatus;
  readonly identity?: string;
  readonly plan?: string;
  readonly expiresAt?: number;
  readonly hasSecret?: boolean;
  readonly hasUsageCookie?: boolean;
  readonly quota?: QuotaView;
  readonly error?: string;
}

async function readJsonFile(filePath: string): Promise<Rec | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return rec(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

/** 仅解码 JWT payload（Base64URL），用于提取公开的 email / plan / exp 展示信息，不校验签名也不回传 token。 */
export function decodeJwtPayloadUnsafe(jwt: unknown): Rec | undefined {
  if (typeof jwt !== 'string') return undefined;
  const parts = jwt.trim().split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const normalized = parts[1].replace(/-/gu, '+').replace(/_/gu, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(`${normalized}${pad}`, 'base64').toString('utf8');
    return rec(JSON.parse(decoded));
  } catch {
    return undefined;
  }
}

function formatPlanLabel(raw: string | undefined): string | undefined {
  const clean = raw?.trim();
  if (!clean) return undefined;
  const lower = clean.toLowerCase();
  if (lower === 'max') return 'Max';
  if (lower === 'pro') return 'Pro';
  if (lower === 'plus') return 'Plus';
  if (lower === 'team') return 'Team';
  if (lower === 'enterprise') return 'Enterprise';
  if (lower === 'free') return 'Free';
  return clean;
}

async function inspectClaude(params: {
  readonly configDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
}): Promise<AccountInspectionResult> {
  const { configDir, env, now, includeQuota, getHttpProxy } = params;
  const creds = await readJsonFile(join(configDir, '.credentials.json'));
  const claudeJson = await readJsonFile(join(configDir, '.claude.json'));
  const oauthAccount = rec(claudeJson?.oauthAccount);
  const email =
    (typeof oauthAccount?.emailAddress === 'string' && oauthAccount.emailAddress.trim()) ||
    (typeof oauthAccount?.displayName === 'string' && oauthAccount.displayName.trim()) ||
    undefined;

  const oauth = rec(creds?.claudeAiOauth);
  const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
  const refreshToken =
    (typeof oauth?.refreshToken === 'string' && oauth.refreshToken.trim()) ||
    (typeof oauth?.refresh_token === 'string' && oauth.refresh_token.trim()) ||
    '';
  const plan = formatPlanLabel(typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : undefined);
  const expiresAt = parseEpochMs(oauth?.expiresAt);

  if (accessToken || refreshToken) {
    const accessTokenExpired = expiresAt !== undefined && expiresAt <= now;
    // 有 refreshToken 时 Claude CLI 会在运行时自动续期，不应将短时 accessToken 过期误判为账号已过期
    const expired = accessTokenExpired && !refreshToken;
    let quota: QuotaView | undefined;
    if (!accessTokenExpired && accessToken && includeQuota) {
      quota = await queryClaudeQuota({
        env: { ...env, CLAUDE_CONFIG_DIR: configDir },
        ...(getHttpProxy ? { getHttpProxy } : {}),
      }).catch(() => undefined);
    }
    return {
      status: expired ? 'expired' : 'authenticated',
      ...(email ? { identity: email } : {}),
      ...(plan ? { plan } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(quota ? { quota } : {}),
    };
  }

  const envApiKey = env.ANTHROPIC_API_KEY?.trim();
  if (envApiKey) {
    return {
      status: 'authenticated',
      identity: maskSecretValue(envApiKey),
      plan: 'API Key',
    };
  }

  return {
    status: 'unauthenticated',
    ...(email ? { identity: email } : {}),
  };
}

async function inspectCodex(params: {
  readonly codexHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
}): Promise<AccountInspectionResult> {
  const { codexHome, env, now } = params;
  const auth = await readJsonFile(join(codexHome, 'auth.json'));
  const tokens = rec(auth?.tokens);
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : '';
  const idTokenPayload = decodeJwtPayloadUnsafe(tokens?.id_token) ?? decodeJwtPayloadUnsafe(accessToken);

  const authClaim = rec(idTokenPayload?.['https://api.openai.com/auth']);
  const email =
    (typeof idTokenPayload?.email === 'string' && idTokenPayload.email.trim()) ||
    (typeof authClaim?.user_email === 'string' && authClaim.user_email.trim()) ||
    undefined;
  const plan = formatPlanLabel(
    (typeof authClaim?.chatgpt_plan_type === 'string' && authClaim.chatgpt_plan_type) ||
      (typeof auth?.auth_mode === 'string' && auth.auth_mode) ||
      undefined,
  );
  const expiresAt = parseEpochMs(idTokenPayload?.exp ?? tokens?.expires_at);

  if (accessToken || typeof tokens?.refresh_token === 'string') {
    const expired = expiresAt !== undefined && expiresAt <= now && !tokens?.refresh_token;
    return {
      status: expired ? 'expired' : 'authenticated',
      ...(email ? { identity: email } : {}),
      ...(plan ? { plan } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  const storedApiKey = typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : '';
  const envApiKey = env.OPENAI_API_KEY?.trim();
  const key = storedApiKey || envApiKey;
  if (key) {
    return {
      status: 'authenticated',
      identity: maskSecretValue(key),
      plan: 'API Key',
    };
  }

  return { status: 'unauthenticated' };
}

async function inspectPi(params: { readonly piDir: string; readonly now: number }): Promise<AccountInspectionResult> {
  const auth = await readJsonFile(join(params.piDir, 'auth.json'));
  if (!auth) return { status: 'unauthenticated' };
  const providers: string[] = [];
  let hasActive = false;
  let allExpired = true;
  let earliestExpiry: number | undefined;
  for (const [key, val] of Object.entries(auth)) {
    const entry = rec(val);
    if (!entry) continue;
    const hasCred =
      (typeof entry.access === 'string' && entry.access.trim()) ||
      (typeof entry.accessToken === 'string' && entry.accessToken.trim()) ||
      (typeof entry.key === 'string' && entry.key.trim()) ||
      (typeof entry.apiKey === 'string' && entry.apiKey.trim());
    if (!hasCred) continue;
    providers.push(key);
    const exp = parseEpochMs(entry.expires ?? entry.expiresAt);
    if (exp !== undefined) {
      earliestExpiry = earliestExpiry === undefined ? exp : Math.min(earliestExpiry, exp);
    }
    const expired = exp !== undefined && exp <= params.now && !entry.refresh && !entry.refreshToken;
    if (!expired) {
      hasActive = true;
      allExpired = false;
    }
  }
  if (providers.length === 0) return { status: 'unauthenticated' };
  return {
    status: hasActive ? 'authenticated' : allExpired ? 'expired' : 'authenticated',
    identity: providers.slice(0, 3).join(', ') + (providers.length > 3 ? ` +${providers.length - 3}` : ''),
    plan: 'OAuth / Key',
    ...(earliestExpiry !== undefined ? { expiresAt: earliestExpiry } : {}),
  };
}

async function inspectOpencode(params: { readonly dataRoot: string; readonly now: number }): Promise<AccountInspectionResult> {
  const auth = await readJsonFile(join(params.dataRoot, 'opencode', 'auth.json'));
  if (!auth) return { status: 'unauthenticated' };
  const providers: string[] = [];
  let hasActive = false;
  for (const [key, val] of Object.entries(auth)) {
    const entry = rec(val);
    if (!entry) continue;
    const hasCred =
      (typeof entry.access === 'string' && entry.access.trim()) ||
      (typeof entry.key === 'string' && entry.key.trim()) ||
      (typeof entry.token === 'string' && entry.token.trim());
    if (!hasCred) continue;
    providers.push(key);
    const exp = parseEpochMs(entry.expires);
    if (exp === undefined || exp > params.now || entry.refresh) {
      hasActive = true;
    }
  }
  if (providers.length === 0) return { status: 'unauthenticated' };
  return {
    status: hasActive ? 'authenticated' : 'expired',
    identity: providers.slice(0, 3).join(', ') + (providers.length > 3 ? ` +${providers.length - 3}` : ''),
    plan: 'OAuth / Key',
  };
}

async function inspectCodebuddy(params: {
  readonly configDir: string;
  readonly accountId: string;
  readonly account?: AccountConfig;
  readonly isActiveSlot?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
}): Promise<AccountInspectionResult> {
  const { configDir, accountId, account, isActiveSlot, env, secrets, includeQuota, getHttpProxy } = params;
  const savedCookie = (await secrets.get(accountCookieSecretKey(accountId)))?.trim();
  const hasUsageCookie = Boolean(savedCookie);
  const regionPlan = account?.region === 'ai' ? 'Global' : account?.region === 'internal' ? 'iOA' : account?.region === 'cn' ? 'CN' : undefined;

  let identity: string | undefined;
  let authenticated = false;
  let hasSecret = false;
  let plan = regionPlan;

  // 1. 优先检查独立账号保存的官方 CODEBUDDY_API_KEY
  if (!isSystemAccountId(accountId)) {
    const savedKey = (await secrets.get(accountApiKeySecretKey(accountId)))?.trim();
    if (savedKey) {
      authenticated = true;
      hasSecret = true;
      identity = maskSecretValue(savedKey);
      plan = regionPlan ? `${regionPlan} · API Key` : 'API Key';
    }
  }

  // 2. 检查 CodeBuddy OAuth 凭据槽位（CodeBuddyExtension/Data/Public/auth/*.info）
  if (!authenticated) {
    const slotKey = accountSlotSecretKey(accountId);
    const storedSlot = (await secrets.get(slotKey))?.trim();
    let slotRaw = storedSlot;
    // 只有当前激活槽位才允许读取磁盘最新凭据；非激活槽位（含非激活时的本机默认账号）与尚未登录的新增账号绝不读取磁盘，避免串号
    const canReadDisk = isSystemAccountId(accountId)
      ? isActiveSlot !== false
      : isActiveSlot === true && Boolean(storedSlot);
    if (canReadDisk) {
      const diskRaw = (await readCodebuddyDiskAuthSnapshot(env))?.trim();
      if (diskRaw) {
        slotRaw = diskRaw;
        if (isActiveSlot === true && diskRaw !== storedSlot) {
          await secrets.store(slotKey, diskRaw).catch(() => undefined);
        }
      }
    }
    if (slotRaw) {
      authenticated = true;
      hasSecret = true;
    }
  }

  // 3. 兼容检查 configDir 内的旧/自定义 JSON 凭据文件
  for (const name of ['auth.json', 'user.json', '.credentials.json', 'token.json', 'settings.json']) {
    const data = await readJsonFile(join(configDir, name));
    if (!data) continue;
    const userObj = rec(data.user) ?? rec(data.account) ?? data;
    const emailOrName =
      (typeof userObj.email === 'string' && userObj.email.trim()) ||
      (typeof userObj.username === 'string' && userObj.username.trim()) ||
      (typeof userObj.name === 'string' && userObj.name.trim()) ||
      (typeof userObj.nickName === 'string' && userObj.nickName.trim()) ||
      undefined;
    if (emailOrName && !identity) identity = emailOrName;
    if (
      typeof data.accessToken === 'string' ||
      typeof data.access_token === 'string' ||
      typeof data.token === 'string' ||
      Boolean(emailOrName)
    ) {
      authenticated = true;
    }
  }

  // 4. 兜底检查环境变量 CODEBUDDY_API_KEY（仅对本机默认账号生效）
  if (!authenticated && isSystemAccountId(accountId) && env.CODEBUDDY_API_KEY?.trim()) {
    authenticated = true;
    hasSecret = true;
    identity = maskSecretValue(env.CODEBUDDY_API_KEY);
    plan = regionPlan ? `${regionPlan} · API Key` : 'API Key';
  }

  let quota: QuotaView | undefined;
  if (includeQuota) {
    const internetEnv = codebuddyInternetEnvForRegion(account?.region);
    const quotaEnv: Record<string, string | undefined> = {
      ...env,
      CODEBUDDY_CONFIG_DIR: configDir,
      ...(internetEnv ? { CODEBUDDY_INTERNET_ENVIRONMENT: internetEnv } : {}),
      ...(savedCookie ? { CODEBUDDY_COOKIE: savedCookie } : {}),
    };
    quota = await queryCodebuddyQuota({
      env: quotaEnv,
      ...(getHttpProxy ? { getHttpProxy } : {}),
    }).catch(() => undefined);
    if (quota && !authenticated) authenticated = true;
  }

  return {
    status: authenticated ? 'authenticated' : 'unauthenticated',
    ...(identity ? { identity } : {}),
    ...(plan ? { plan } : {}),
    ...(hasSecret ? { hasSecret: true } : {}),
    ...(hasUsageCookie ? { hasUsageCookie: true } : {}),
    ...(quota ? { quota } : {}),
  };
}

async function queryAntigravitySlotQuota(params: {
  readonly rawTokenJson: string;
  readonly getHttpProxy?: () => string | undefined;
  readonly clientVersion?: string;
}): Promise<QuotaView | undefined> {
  // 通过临时 HOME 复用现有 queryAntigravityQuota，不修改真实用户主目录
  const tempHome = await mkdtemp(join(tmpdir(), 'hd-agy-quota-'));
  try {
    const tokenPath = join(tempHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, params.rawTokenJson, { encoding: 'utf8', mode: 0o600 });
    return await queryAntigravityQuota({
      env: { HOME: tempHome, USERPROFILE: tempHome },
      ...(params.getHttpProxy ? { getHttpProxy: params.getHttpProxy } : {}),
      ...(params.clientVersion ? { clientVersion: params.clientVersion } : {}),
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseAntigravityIdentityFingerprint(raw: string): { readonly refreshToken?: string; readonly email?: string } {
  try {
    const json = rec(JSON.parse(raw));
    const token = rec(json?.token);
    const refreshToken =
      (typeof token?.refresh_token === 'string' && token.refresh_token.trim()) ||
      (typeof token?.refreshToken === 'string' && token.refreshToken.trim()) ||
      (typeof json?.refresh_token === 'string' && json.refresh_token.trim()) ||
      (typeof json?.refreshToken === 'string' && json.refreshToken.trim()) ||
      undefined;
    const idPayload = decodeJwtPayloadUnsafe(token?.id_token ?? json?.id_token);
    const email =
      (typeof json?.email === 'string' && json.email.trim().toLowerCase()) ||
      (typeof idPayload?.email === 'string' && idPayload.email.trim().toLowerCase()) ||
      undefined;
    return { ...(refreshToken ? { refreshToken } : {}), ...(email ? { email } : {}) };
  } catch {
    return {};
  }
}

function antigravityTokensSameAccount(a: string, b: string): boolean {
  const fa = parseAntigravityIdentityFingerprint(a);
  const fb = parseAntigravityIdentityFingerprint(b);
  if (fa.refreshToken && fb.refreshToken && fa.refreshToken !== fb.refreshToken) return false;
  if (fa.email && fb.email && fa.email !== fb.email) return false;
  return true;
}

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_USERINFO_TIMEOUT_MS = 6_000;
const googleUserInfoCache = new Map<string, string | null>();

async function fetchGoogleUserEmail(params: {
  readonly accessToken: string;
  readonly getHttpProxy?: () => string | undefined;
  readonly fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const { accessToken, getHttpProxy, fetchImpl } = params;
  if (!fetchImpl && googleUserInfoCache.has(accessToken)) {
    return googleUserInfoCache.get(accessToken) ?? undefined;
  }
  const fetchFn = fetchImpl ?? createProxyAwareFetch(getHttpProxy);
  try {
    const response = await fetchFn(GOOGLE_USERINFO_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(GOOGLE_USERINFO_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const json = rec(await response.json());
    const identity =
      (typeof json?.email === 'string' && json.email.trim()) ||
      (typeof json?.name === 'string' && json.name.trim()) ||
      undefined;
    if (!fetchImpl) {
      if (googleUserInfoCache.size >= 64) {
        const oldest = googleUserInfoCache.keys().next().value;
        if (oldest !== undefined) googleUserInfoCache.delete(oldest);
      }
      googleUserInfoCache.set(accessToken, identity ?? null);
    }
    return identity;
  } catch {
    return undefined;
  }
}

async function inspectAntigravity(params: {
  readonly accountId: string;
  readonly isActiveSlot?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly now: number;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
  readonly fetchImpl?: FetchLike;
  readonly clientVersion?: string;
}): Promise<AccountInspectionResult> {
  const { accountId, isActiveSlot, env, secrets, now, includeQuota, getHttpProxy, fetchImpl, clientVersion } = params;
  const slotKey = accountSlotSecretKey(accountId);
  const storedRaw = (await secrets.get(slotKey))?.trim();
  let raw = storedRaw;

  // 严格按槽位隔离磁盘凭据读取：
  // - 非激活槽位（isActiveSlot === false，含本机默认账号）绝不读取磁盘文件，避免把当前激活账号的 token 与用量串给其他账号；
  // - 尚未登录过的新增独立账号（!storedRaw）即使已设为当前渠道，也绝不窃取磁盘上原账号的 token；
  // - 当前激活槽位（已有快照，或激活的本机默认账号）读取磁盘被 CLI 自动续期的新 token 时，仅在同一账号时回写同步。
  const canReadDisk = isSystemAccountId(accountId)
    ? isActiveSlot !== false
    : isActiveSlot === true && Boolean(storedRaw);
  if (canReadDisk) {
    const diskRaw = (await readAntigravityDiskTokenRaw(env))?.trim();
    if (diskRaw && (!storedRaw || antigravityTokensSameAccount(storedRaw, diskRaw))) {
      raw = diskRaw;
      if (isActiveSlot === true && diskRaw !== storedRaw) {
        await secrets.store(slotKey, diskRaw).catch(() => undefined);
      }
    }
  }
  if (!raw) {
    if (isSystemAccountId(accountId) && isActiveSlot !== false) {
      const hasPrimary = await pathExists(antigravityPrimaryTokenPath(env));
      const hasFallback = await pathExists(antigravityFallbackTokenPath(env));
      if (hasPrimary || hasFallback) {
        return { status: 'unknown' };
      }
    }
    return { status: 'unauthenticated' };
  }

  let json: Rec | undefined;
  try {
    json = rec(JSON.parse(raw));
  } catch {
    return { status: 'unauthenticated' };
  }
  const token = rec(json?.token);
  const accessToken = typeof token?.access_token === 'string' ? token.access_token.trim() : '';
  const refreshToken =
    (typeof token?.refresh_token === 'string' && token.refresh_token.trim()) ||
    (typeof token?.refreshToken === 'string' && token.refreshToken.trim()) ||
    (typeof json?.refresh_token === 'string' && json.refresh_token.trim()) ||
    (typeof json?.refreshToken === 'string' && json.refreshToken.trim()) ||
    '';
  if (!accessToken && !refreshToken) return { status: 'unauthenticated' };

  const expiresAt = parseEpochMs(token?.expiry);
  const accessTokenExpired = expiresAt !== undefined && expiresAt <= now;
  // Google OAuth access_token 约 1 小时过期，只要存在 refresh_token，`agy` 运行时会自动刷新，仍为可用登录态
  const expired = accessTokenExpired && !refreshToken;
  const idPayload = decodeJwtPayloadUnsafe(token?.id_token ?? json?.id_token);
  let email =
    (typeof json?.email === 'string' && json.email.trim()) ||
    (typeof idPayload?.email === 'string' && idPayload.email.trim()) ||
    undefined;

  const shouldQueryUserInfo = !email && !accessTokenExpired && Boolean(accessToken) && (includeQuota === true || Boolean(fetchImpl));
  const shouldQueryQuota = !accessTokenExpired && Boolean(accessToken) && includeQuota === true;

  const [fetchedEmail, quota] = await Promise.all([
    shouldQueryUserInfo
      ? fetchGoogleUserEmail({
          accessToken,
          ...(getHttpProxy ? { getHttpProxy } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
        })
      : Promise.resolve(undefined),
    shouldQueryQuota
      ? queryAntigravitySlotQuota({
          rawTokenJson: raw,
          ...(getHttpProxy ? { getHttpProxy } : {}),
          ...(clientVersion ? { clientVersion } : {}),
        }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  if (!email && fetchedEmail) email = fetchedEmail;

  return {
    status: expired ? 'expired' : 'authenticated',
    ...(email ? { identity: email } : {}),
    plan: 'Google OAuth',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    hasSecret: true,
    ...(quota ? { quota } : {}),
  };
}

async function inspectDsh(params: {
  readonly accountId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
}): Promise<AccountInspectionResult> {
  const { accountId, env, secrets } = params;
  if (!isSystemAccountId(accountId)) {
    const key = (await secrets.get(accountApiKeySecretKey(accountId)))?.trim();
    if (!key) return { status: 'unauthenticated', hasSecret: false };
    return {
      status: 'authenticated',
      identity: maskSecretValue(key),
      plan: 'DeepSeek API Key',
      hasSecret: true,
    };
  }
  const envKey = env.DEEPSEEK_API_KEY?.trim();
  if (envKey) {
    return {
      status: 'authenticated',
      identity: maskSecretValue(envKey),
      plan: 'Env API Key',
      hasSecret: true,
    };
  }
  const home = resolveUserHome(env);
  const hasDshDir =
    (await pathExists(join(home, '.dsh'))) ||
    (await pathExists(join(home, '.config', 'dsh'))) ||
    (await pathExists(join(home, '.deepseek')));
  return {
    status: hasDshDir ? 'authenticated' : 'unknown',
    plan: 'dsh Credential Store',
  };
}

async function inspectZcode(env: Readonly<Record<string, string | undefined>>): Promise<AccountInspectionResult> {
  const home = resolveUserHome(env);
  const zcodeDir = join(home, '.zcode');
  const exists = await pathExists(zcodeDir);
  if (!exists) return { status: 'unauthenticated' };
  const auth = await readJsonFile(join(zcodeDir, 'auth.json'));
  const identity =
    (typeof auth?.email === 'string' && auth.email.trim()) ||
    (typeof auth?.username === 'string' && auth.username.trim()) ||
    undefined;
  return {
    status: auth ? 'authenticated' : 'unknown',
    ...(identity ? { identity } : {}),
  };
}

/** 探测指定官方账号的登录状态、脱敏身份、套餐与可选额度。 */
export async function inspectOfficialAccount(params: {
  readonly backendId: string;
  readonly accountId: string;
  readonly account?: AccountConfig;
  readonly isActiveSlot?: boolean;
  readonly storageRoot: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
  readonly fetchImpl?: FetchLike;
  readonly clientVersion?: string;
  readonly now?: () => number;
}): Promise<AccountInspectionResult> {
  const { backendId, accountId, account, isActiveSlot, storageRoot, baseEnv, secrets, includeQuota, getHttpProxy, fetchImpl, clientVersion } = params;
  const now = (params.now ?? Date.now)();
  const normalized = backendId.toLowerCase();
  const userHome = resolveUserHome(baseEnv);
  const isSystem = isSystemAccountId(accountId);

  if (normalized === 'claude') {
    const configDir = isSystem
      ? baseEnv.CLAUDE_CONFIG_DIR?.trim()
        ? resolve(baseEnv.CLAUDE_CONFIG_DIR.trim())
        : join(userHome, '.claude')
      : accountIsolationDir(storageRoot, backendId, accountId);
    return inspectClaude({
      configDir,
      env: baseEnv,
      now,
      ...(includeQuota !== undefined ? { includeQuota } : {}),
      ...(getHttpProxy ? { getHttpProxy } : {}),
    });
  }

  if (normalized === 'codex') {
    const codexHome = isSystem
      ? baseEnv.CODEX_HOME?.trim()
        ? resolve(baseEnv.CODEX_HOME.trim())
        : join(userHome, '.codex')
      : accountIsolationDir(storageRoot, backendId, accountId);
    return inspectCodex({ codexHome, env: baseEnv, now });
  }

  if (normalized === 'pi' || normalized === 'oh-my-pi') {
    const piDir = isSystem
      ? baseEnv.PI_CODING_AGENT_DIR?.trim()
        ? resolve(baseEnv.PI_CODING_AGENT_DIR.trim())
        : join(userHome, '.pi', 'agent')
      : accountIsolationDir(storageRoot, backendId, accountId);
    return inspectPi({ piDir, now });
  }

  if (normalized === 'opencode') {
    const dataRoot = isSystem
      ? baseEnv.XDG_DATA_HOME?.trim()
        ? resolve(baseEnv.XDG_DATA_HOME.trim())
        : join(userHome, '.local', 'share')
      : join(accountIsolationDir(storageRoot, backendId, accountId), 'data');
    return inspectOpencode({ dataRoot, now });
  }

  if (normalized === 'codebuddy') {
    const configDir = isSystem
      ? baseEnv.CODEBUDDY_CONFIG_DIR?.trim()
        ? resolve(baseEnv.CODEBUDDY_CONFIG_DIR.trim())
        : join(userHome, '.codebuddy')
      : accountIsolationDir(storageRoot, backendId, accountId);
    return inspectCodebuddy({
      configDir,
      accountId,
      ...(account ? { account } : {}),
      ...(isActiveSlot !== undefined ? { isActiveSlot } : {}),
      env: baseEnv,
      secrets,
      ...(includeQuota !== undefined ? { includeQuota } : {}),
      ...(getHttpProxy ? { getHttpProxy } : {}),
    });
  }

  if (normalized === 'antigravity') {
    return inspectAntigravity({
      accountId,
      ...(isActiveSlot !== undefined ? { isActiveSlot } : {}),
      env: baseEnv,
      secrets,
      now,
      ...(includeQuota !== undefined ? { includeQuota } : {}),
      ...(getHttpProxy ? { getHttpProxy } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(clientVersion ? { clientVersion } : {}),
    });
  }

  if (normalized === 'dsh') {
    return inspectDsh({ accountId, env: baseEnv, secrets });
  }

  if (normalized === 'zcode') {
    return inspectZcode(baseEnv);
  }

  return { status: 'unknown' };
}

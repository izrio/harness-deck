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
  readAntigravityDiskTokenRaw,
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
  const plan = formatPlanLabel(typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : undefined);
  const expiresAt = parseEpochMs(oauth?.expiresAt);

  if (accessToken) {
    const expired = expiresAt !== undefined && expiresAt <= now;
    let quota: QuotaView | undefined;
    if (!expired && includeQuota) {
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
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
}): Promise<AccountInspectionResult> {
  const { configDir, accountId, account, env, secrets, includeQuota, getHttpProxy } = params;
  const savedCookie = (await secrets.get(accountCookieSecretKey(accountId)))?.trim();
  const hasUsageCookie = Boolean(savedCookie);

  let identity: string | undefined;
  let authenticated = false;

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

  if (!authenticated && env.CODEBUDDY_API_KEY?.trim()) {
    authenticated = true;
    identity = maskSecretValue(env.CODEBUDDY_API_KEY);
  }

  let quota: QuotaView | undefined;
  if (includeQuota) {
    const quotaEnv: Record<string, string | undefined> = {
      ...env,
      CODEBUDDY_CONFIG_DIR: configDir,
      ...(account?.region ? { CODEBUDDY_INTERNET_ENVIRONMENT: account.region } : {}),
      ...(savedCookie ? { CODEBUDDY_COOKIE: savedCookie } : {}),
    };
    quota = await queryCodebuddyQuota({
      env: quotaEnv,
      ...(getHttpProxy ? { getHttpProxy } : {}),
    }).catch(() => undefined);
    if (quota && !authenticated) authenticated = true;
  }

  const regionPlan = account?.region === 'ai' ? 'Global' : account?.region === 'internal' ? 'Internal' : account?.region === 'cn' ? 'CN' : undefined;
  const dirExists = await pathExists(configDir);

  return {
    status: authenticated ? 'authenticated' : isSystemAccountId(accountId) && dirExists ? 'unknown' : 'unauthenticated',
    ...(identity ? { identity } : {}),
    ...(regionPlan ? { plan: regionPlan } : {}),
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

async function inspectAntigravity(params: {
  readonly accountId: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly now: number;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
  readonly clientVersion?: string;
}): Promise<AccountInspectionResult> {
  const { accountId, env, secrets, now, includeQuota, getHttpProxy, clientVersion } = params;
  let raw = (await secrets.get(accountSlotSecretKey(accountId)))?.trim();
  if (!raw && isSystemAccountId(accountId)) {
    raw = (await readAntigravityDiskTokenRaw(env))?.trim();
  }
  if (!raw) {
    // 兼容检查两个路径均无凭据
    const hasPrimary = await pathExists(antigravityPrimaryTokenPath(env));
    const hasFallback = await pathExists(antigravityFallbackTokenPath(env));
    if (isSystemAccountId(accountId) && (hasPrimary || hasFallback)) {
      return { status: 'unknown' };
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
  if (!accessToken) return { status: 'unauthenticated' };

  const expiresAt = parseEpochMs(token?.expiry);
  const expired = expiresAt !== undefined && expiresAt <= now;
  const idPayload = decodeJwtPayloadUnsafe(token?.id_token ?? json?.id_token);
  const email =
    (typeof json?.email === 'string' && json.email.trim()) ||
    (typeof idPayload?.email === 'string' && idPayload.email.trim()) ||
    undefined;

  let quota: QuotaView | undefined;
  if (!expired && includeQuota) {
    quota = await queryAntigravitySlotQuota({
      rawTokenJson: raw,
      ...(getHttpProxy ? { getHttpProxy } : {}),
      ...(clientVersion ? { clientVersion } : {}),
    }).catch(() => undefined);
  }

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
  readonly storageRoot: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  readonly includeQuota?: boolean;
  readonly getHttpProxy?: () => string | undefined;
  readonly clientVersion?: string;
  readonly now?: () => number;
}): Promise<AccountInspectionResult> {
  const { backendId, accountId, account, storageRoot, baseEnv, secrets, includeQuota, getHttpProxy, clientVersion } = params;
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
      env: baseEnv,
      secrets,
      ...(includeQuota !== undefined ? { includeQuota } : {}),
      ...(getHttpProxy ? { getHttpProxy } : {}),
    });
  }

  if (normalized === 'antigravity') {
    return inspectAntigravity({
      accountId,
      env: baseEnv,
      secrets,
      now,
      ...(includeQuota !== undefined ? { includeQuota } : {}),
      ...(getHttpProxy ? { getHttpProxy } : {}),
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

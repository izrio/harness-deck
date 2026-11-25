/**
 * 各智能体官方多账号的隔离环境准备、凭据槽位快照切换（Antigravity）与安全清理。
 *
 * 设计原则：
 * 1. L1 原生目录隔离（Claude / Codex / Pi / CodeBuddy / OpenCode）：
 *    绝不覆写进程 `HOME`，只使用各 CLI 原生配置目录环境变量，避免破坏 bash 工具里的 ~/.ssh、~/.gitconfig。
 *    默认仅隔离凭据文件，通过软链共享项目历史会话；勾选 `isolateSessions` 时则完全独立。
 * 2. L2 凭据槽位快照（Antigravity）：
 *    将 `~/.gemini/antigravity-cli/antigravity-oauth-token` 按账号加密托管在 SecretStorage 中，
 *    切换账号时自动备份当前槽位并原子写入目标账号槽位（权限 0600）。
 * 3. L1 API Key 隔离（DeepSeek dsh）：
 *    每个官方账号的 API Key 存在 SecretStorage 中，通过环境变量 `DEEPSEEK_API_KEY` 注入。
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AccountConfig, AccountRegion } from '@harness-deck/shared';
import type { SecretStore } from '../host/HostPlatform.ts';
import { parseEpochMs, rec, type Rec } from '../quota/util.ts';
import {
  accountApiKeySecretKey,
  accountCookieSecretKey,
  accountSlotSecretKey,
  isSystemAccountId,
  systemAccountId,
} from './AccountStore.ts';

export interface AccountLaunchPatch {
  readonly env: Record<string, string | undefined>;
  /** 仅当 L1 隔离改变了配置目录时提供，供会话扫描与额度查询同步对齐。 */
  readonly configDir?: string;
}

const ANTIGRAVITY_PRIMARY_REL = join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const ANTIGRAVITY_FALLBACK_REL = join('.gemini', 'jetski-standalone-oauth-token');

export function resolveUserHome(env?: Readonly<Record<string, string | undefined>>): string {
  return env?.HOME?.trim() || env?.USERPROFILE?.trim() || homedir();
}

export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '_') || 'default';
}

/** 独立账号的受控本地隔离根目录：`<storageRoot>/accounts/<backendId>/<accountId>`。 */
export function accountIsolationDir(storageRoot: string, backendId: string, accountId: string): string {
  return join(storageRoot, 'accounts', safeSegment(backendId), safeSegment(accountId));
}

export function antigravityPrimaryTokenPath(env?: Readonly<Record<string, string | undefined>>): string {
  return join(resolveUserHome(env), ANTIGRAVITY_PRIMARY_REL);
}

export function antigravityFallbackTokenPath(env?: Readonly<Record<string, string | undefined>>): string {
  return join(resolveUserHome(env), ANTIGRAVITY_FALLBACK_REL);
}

async function ensureDirPrivate(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(dirPath, 0o700).catch(() => undefined);
  }
}

async function ensureSymlinkIfExists(src: string, dest: string, isDir: boolean): Promise<void> {
  try {
    await stat(src);
  } catch {
    return;
  }
  try {
    await stat(dest);
    return;
  } catch {
    // dest does not exist yet
  }
  await mkdir(dirname(dest), { recursive: true });
  try {
    await symlink(src, dest, isDir ? 'junction' : 'file');
  } catch {
    // 忽略无符号链接权限等平台差异
  }
}

async function writeFileAtomicPrivate(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(tmpPath, 0o600).catch(() => undefined);
  }
  await rename(tmpPath, targetPath);
}

/** 仅读取本机 Antigravity CLI 主凭据文件（不回退 IDE 备用凭据，用于多账号隔离读取与登录保存）。 */
export async function readAntigravityPrimaryTokenRaw(
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  try {
    const raw = await readFile(antigravityPrimaryTokenPath(env), 'utf8');
    if (raw.trim()) return raw;
  } catch {
    // missing or unreadable
  }
  return undefined;
}

/** 读取本机当前 Antigravity OAuth 凭据文件内容（优先 CLI 凭据，其次 IDE 凭据）。 */
export async function readAntigravityDiskTokenRaw(
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  for (const fp of [antigravityPrimaryTokenPath(env), antigravityFallbackTokenPath(env)]) {
    try {
      const raw = await readFile(fp, 'utf8');
      if (raw.trim()) return raw;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** 删除本机 Antigravity CLI 主凭据文件（不触碰 IDE 独立凭据文件）。 */
export async function clearAntigravityPrimaryDiskToken(
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await unlink(antigravityPrimaryTokenPath(env)).catch(() => undefined);
}

/** 将 Antigravity 凭据槽位原子写入本机 CLI 凭据文件（供 `agy acp` 直接使用）。 */
export async function writeAntigravityDiskTokenRaw(
  raw: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await writeFileAtomicPrivate(antigravityPrimaryTokenPath(env), raw);
}

/**
 * 将账号区域配置映射为 CodeBuddy CLI 真实识别的 `CODEBUDDY_INTERNET_ENVIRONMENT` 值：
 * - `cn`（国内版 codebuddy.cn）→ `internal`
 * - `ai`（国际版 codebuddy.ai）→ `external`
 * - `internal`（iOA 企业版）→ `ioa`
 */
export function codebuddyInternetEnvForRegion(region?: AccountRegion): string | undefined {
  if (region === 'cn') return 'internal';
  if (region === 'ai') return 'external';
  if (region === 'internal') return 'ioa';
  return undefined;
}

/** CodeBuddy CLI 实际存放 OAuth 登录态文件的目录（由 `os.homedir()` 决定，不随 `CODEBUDDY_CONFIG_DIR` 改变）。 */
export function codebuddyAuthDir(
  env?: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = resolveUserHome(env);
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  if (platform === 'win32') {
    return join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  }
  return join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/** 读取本机当前有效的 CodeBuddy OAuth 凭据快照（所有无 `.logged-out` 标记的 `.info` 文件）。 */
export async function readCodebuddyDiskAuthSnapshot(
  env?: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const authDir = codebuddyAuthDir(env, platform);
  let entries: string[];
  try {
    entries = await readdir(authDir);
  } catch {
    return undefined;
  }
  const entrySet = new Set(entries);
  const files: Record<string, string> = {};
  for (const name of entries) {
    if (!name.endsWith('.info')) continue;
    if (entrySet.has(`${name}.logged-out`)) continue;
    try {
      const content = await readFile(join(authDir, name), 'utf8');
      if (content.trim()) files[name] = content;
    } catch {
      // ignore unreadable entry
    }
  }
  if (Object.keys(files).length === 0) return undefined;
  return JSON.stringify({ files });
}

/** 清理本机 CodeBuddy OAuth 凭据目录中的 `.info` 与 `.logged-out` 文件（用于切换槽位或重新登录）。 */
export async function clearCodebuddyDiskAuth(
  env?: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const authDir = codebuddyAuthDir(env, platform);
  let entries: string[];
  try {
    entries = await readdir(authDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.info') || name.endsWith('.info.logged-out'))
      .map((name) => unlink(join(authDir, name)).catch(() => undefined)),
  );
}

/** 将 CodeBuddy OAuth 凭据快照原子写回本机 auth 目录。 */
export async function writeCodebuddyDiskAuthSnapshot(
  raw: string,
  env?: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  let files: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      files = parsed.files as Record<string, unknown>;
    }
  } catch {
    return false;
  }
  if (!files) return false;
  const validEntries = Object.entries(files).filter(
    ([name, val]) => basename(name) === name && name.endsWith('.info') && typeof val === 'string' && val.trim().length > 0,
  ) as [string, string][];
  if (validEntries.length === 0) return false;

  const authDir = codebuddyAuthDir(env, platform);
  await clearCodebuddyDiskAuth(env, platform);
  await mkdir(authDir, { recursive: true });
  for (const [name, content] of validEntries) {
    await writeFileAtomicPrivate(join(authDir, name), content);
  }
  return true;
}

/** 备份本机当前 CodeBuddy OAuth 凭据到对应槽位，再激活目标账号槽位（使用 API Key 的账号无需替换磁盘槽位）。 */
export async function switchCodebuddyCredentialSlot(params: {
  readonly targetAccountId: string;
  readonly previousAccountId?: string;
  readonly secrets: SecretStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}): Promise<{ readonly activated: boolean; readonly hasStoredSlot: boolean }> {
  const { targetAccountId, previousAccountId, secrets, env, platform = process.platform } = params;
  const sysId = systemAccountId('codebuddy');

  // 若目标账号配置了独立官方 API Key，无需改写磁盘 OAuth 槽位
  if (!isSystemAccountId(targetAccountId)) {
    const targetApiKey = (await secrets.get(accountApiKeySecretKey(targetAccountId)))?.trim();
    if (targetApiKey) return { activated: true, hasStoredSlot: true };
  }

  const currentDisk = await readCodebuddyDiskAuthSnapshot(env, platform);
  if (currentDisk) {
    const ownerId = previousAccountId || sysId;
    if (ownerId !== targetAccountId) {
      await secrets.store(accountSlotSecretKey(ownerId), currentDisk);
    } else if (ownerId === sysId) {
      const existingSys = await secrets.get(accountSlotSecretKey(sysId));
      if (!existingSys) {
        await secrets.store(accountSlotSecretKey(sysId), currentDisk);
      }
    }
  }

  const targetRaw = await secrets.get(accountSlotSecretKey(targetAccountId));
  if (targetRaw?.trim()) {
    const ok = await writeCodebuddyDiskAuthSnapshot(targetRaw, env, platform);
    return { activated: ok, hasStoredSlot: ok };
  }

  if (targetAccountId === sysId && currentDisk && (!previousAccountId || previousAccountId === sysId)) {
    await secrets.store(accountSlotSecretKey(sysId), currentDisk);
    return { activated: true, hasStoredSlot: true };
  }

  return { activated: false, hasStoredSlot: false };
}

function decodeJwtEmailUnsafe(jwt: unknown): string | undefined {
  if (typeof jwt !== 'string') return undefined;
  const parts = jwt.trim().split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const normalized = parts[1].replace(/-/gu, '+').replace(/_/gu, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(`${normalized}${pad}`, 'base64').toString('utf8');
    const payload: Rec | undefined = rec(JSON.parse(decoded));
    return typeof payload?.email === 'string' && payload.email.trim() ? payload.email.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function parseAntigravityTokenMeta(raw: string): {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly email?: string;
  readonly expiryMs?: number;
} {
  try {
    const json = rec(JSON.parse(raw));
    const token = rec(json?.token);
    const accessToken = typeof token?.access_token === 'string' && token.access_token.trim() ? token.access_token.trim() : undefined;
    const refreshToken =
      (typeof token?.refresh_token === 'string' && token.refresh_token.trim()) ||
      (typeof token?.refreshToken === 'string' && token.refreshToken.trim()) ||
      (typeof json?.refresh_token === 'string' && json.refresh_token.trim()) ||
      (typeof json?.refreshToken === 'string' && json.refreshToken.trim()) ||
      undefined;
    const email =
      (typeof json?.email === 'string' && json.email.trim().toLowerCase()) ||
      (typeof json?.id_token_email === 'string' && json.id_token_email.trim().toLowerCase()) ||
      decodeJwtEmailUnsafe(token?.id_token ?? json?.id_token) ||
      undefined;
    const expiryMs = parseEpochMs(token?.expiry);
    return {
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(email ? { email } : {}),
      ...(expiryMs !== undefined ? { expiryMs } : {}),
    };
  } catch {
    return {};
  }
}

/** 判断两份 Antigravity OAuth 凭据是否属于同一账号（同邮箱优先认定为同账号，避免重登刷新 refresh_token 后错判；避免不同账号串槽）。 */
export function antigravityTokensSameAccount(a: string, b: string): boolean {
  const fa = parseAntigravityTokenMeta(a);
  const fb = parseAntigravityTokenMeta(b);
  if (fa.email && fb.email) {
    return fa.email === fb.email;
  }
  if (fa.refreshToken && fb.refreshToken) {
    return fa.refreshToken === fb.refreshToken;
  }
  if (fa.accessToken && fb.accessToken) return fa.accessToken === fb.accessToken;
  return a.trim() === b.trim();
}

/** 判断 Antigravity OAuth 凭据 JSON 是否包含未过期的 access_token。 */
export function isAntigravityTokenUsable(raw: string | undefined, now = Date.now()): boolean {
  if (!raw?.trim()) return false;
  const meta = parseAntigravityTokenMeta(raw);
  return Boolean(meta.accessToken) && (meta.expiryMs === undefined || meta.expiryMs > now);
}

/** 判断 candidate 是否不比 existing 更旧（避免用已过期的旧快照倒灌覆盖磁盘上已被 CLI 续期的新 token）。 */
export function isNotOlderAntigravityToken(candidate: string, existing: string): boolean {
  const candidateExp = parseAntigravityTokenMeta(candidate).expiryMs;
  const existingExp = parseAntigravityTokenMeta(existing).expiryMs;
  if (candidateExp !== undefined && existingExp !== undefined) {
    return candidateExp >= existingExp;
  }
  return true;
}

/** 若磁盘上的 Antigravity 凭据与当前激活槽位同账号且更新，则同步回 SecretStorage。 */
export async function syncActiveAntigravitySlotFromDisk(params: {
  readonly accountId: string;
  readonly secrets: SecretStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const { accountId, secrets, env } = params;
  const diskRaw = await readAntigravityDiskTokenRaw(env);
  if (!diskRaw?.trim()) return;
  const slotKey = accountSlotSecretKey(accountId);
  const existingRaw = await secrets.get(slotKey);
  if (existingRaw?.trim()) {
    if (
      diskRaw.trim() !== existingRaw.trim() &&
      antigravityTokensSameAccount(existingRaw, diskRaw) &&
      isNotOlderAntigravityToken(diskRaw, existingRaw)
    ) {
      await secrets.store(slotKey, diskRaw);
    }
    return;
  }
  if (isSystemAccountId(accountId)) {
    await secrets.store(slotKey, diskRaw);
  }
}

/** 备份本机当前 Antigravity 凭据到对应槽位，再激活目标账号槽位。 */
export async function switchAntigravityCredentialSlot(params: {
  readonly targetAccountId: string;
  readonly previousAccountId?: string;
  readonly secrets: SecretStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly activated: boolean; readonly hasStoredSlot: boolean }> {
  const { targetAccountId, previousAccountId, secrets, env } = params;
  const sysId = systemAccountId('antigravity');

  // 1. 先把当前磁盘凭据写回上一个激活槽位（若尚未记录，兜底备份到系统默认槽位，避免丢失用户原始登录；
  //    同一槽位重激活时若磁盘凭据已被 CLI 续期得更新，则同步回 SecretStorage 并保留磁盘文件，避免旧快照倒灌）
  const currentDisk = await readAntigravityDiskTokenRaw(env);
  if (currentDisk?.trim()) {
    const ownerId = previousAccountId || sysId;
    const existingOwner = await secrets.get(accountSlotSecretKey(ownerId));
    if (ownerId !== targetAccountId) {
      const canSaveToOwner = existingOwner?.trim()
        ? antigravityTokensSameAccount(existingOwner, currentDisk) && isNotOlderAntigravityToken(currentDisk, existingOwner)
        : ownerId === sysId;
      if (canSaveToOwner && currentDisk.trim() !== existingOwner?.trim()) {
        await secrets.store(accountSlotSecretKey(ownerId), currentDisk);
      }
    } else if (existingOwner?.trim()) {
      if (antigravityTokensSameAccount(existingOwner, currentDisk) && isNotOlderAntigravityToken(currentDisk, existingOwner)) {
        if (currentDisk.trim() !== existingOwner.trim()) {
          await secrets.store(accountSlotSecretKey(targetAccountId), currentDisk);
        }
        return { activated: true, hasStoredSlot: true };
      }
    } else if (ownerId === sysId) {
      await secrets.store(accountSlotSecretKey(sysId), currentDisk);
      return { activated: true, hasStoredSlot: true };
    }
  }

  // 2. 读取目标槽位并激活到磁盘
  const targetRaw = await secrets.get(accountSlotSecretKey(targetAccountId));
  if (targetRaw?.trim()) {
    if (currentDisk?.trim() !== targetRaw.trim()) {
      await writeAntigravityDiskTokenRaw(targetRaw, env);
    }
    return { activated: true, hasStoredSlot: true };
  }

  // 目标是系统默认账号且此前磁盘就属于系统默认账号时，才将其视为已激活（切自其他自定义账号时绝不把对方的磁盘 token 错拷给系统默认账号）
  if (targetAccountId === sysId && currentDisk?.trim() && (!previousAccountId || previousAccountId === sysId)) {
    await secrets.store(accountSlotSecretKey(sysId), currentDisk);
    return { activated: true, hasStoredSlot: true };
  }

  // 目标是尚未登录的新槽位：不清空磁盘文件，等待用户触发 loginAccount
  return { activated: false, hasStoredSlot: false };
}

/**
 * 为指定官方账号准备底层进程启动（或登录）所需的环境变量与隔离目录。
 */
export async function prepareAccountLaunchPatch(params: {
  readonly backendId: string;
  readonly accountId: string;
  readonly account?: AccountConfig;
  readonly storageRoot: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
  /** 若为 true，且底层为 antigravity，执行凭据槽位激活。 */
  readonly activateSlot?: boolean;
  readonly previousAccountId?: string;
}): Promise<AccountLaunchPatch> {
  const { backendId, accountId, account, storageRoot, baseEnv, secrets, activateSlot, previousAccountId } = params;
  const nextEnv: Record<string, string | undefined> = { ...baseEnv };
  const userHome = resolveUserHome(baseEnv);
  const isSystem = isSystemAccountId(accountId);
  const isolateSessions = account?.isolateSessions === true;
  const normalizedBackend = backendId.toLowerCase();

  // 1. Claude Code: CLAUDE_CONFIG_DIR
  if (normalizedBackend === 'claude') {
    if (isSystem) {
      return { env: nextEnv };
    }
    const dir = accountIsolationDir(storageRoot, backendId, accountId);
    await ensureDirPrivate(dir);
    if (!isolateSessions) {
      const userClaudeDir = baseEnv.CLAUDE_CONFIG_DIR?.trim()
        ? resolve(baseEnv.CLAUDE_CONFIG_DIR.trim())
        : join(userHome, '.claude');
      await Promise.all([
        ensureSymlinkIfExists(join(userClaudeDir, 'projects'), join(dir, 'projects'), true),
        ensureSymlinkIfExists(join(userClaudeDir, 'skills'), join(dir, 'skills'), true),
      ]);
    }
    nextEnv.CLAUDE_CONFIG_DIR = dir;
    return { env: nextEnv, configDir: dir };
  }

  // 2. OpenAI Codex: CODEX_HOME
  if (normalizedBackend === 'codex') {
    if (isSystem) {
      return { env: nextEnv };
    }
    const dir = accountIsolationDir(storageRoot, backendId, accountId);
    await ensureDirPrivate(dir);
    if (!isolateSessions) {
      const userCodexDir = baseEnv.CODEX_HOME?.trim()
        ? resolve(baseEnv.CODEX_HOME.trim())
        : join(userHome, '.codex');
      await Promise.all([
        ensureSymlinkIfExists(join(userCodexDir, 'sessions'), join(dir, 'sessions'), true),
        ensureSymlinkIfExists(join(userCodexDir, 'skills'), join(dir, 'skills'), true),
      ]);
    }
    nextEnv.CODEX_HOME = dir;
    return { env: nextEnv, configDir: dir };
  }

  // 3. Pi: PI_CODING_AGENT_DIR
  if (normalizedBackend === 'pi' || normalizedBackend === 'oh-my-pi') {
    if (isSystem) {
      return { env: nextEnv };
    }
    const dir = accountIsolationDir(storageRoot, backendId, accountId);
    await ensureDirPrivate(dir);
    if (!isolateSessions) {
      const userPiDir = baseEnv.PI_CODING_AGENT_DIR?.trim()
        ? resolve(baseEnv.PI_CODING_AGENT_DIR.trim())
        : join(userHome, '.pi', 'agent');
      await Promise.all([
        ensureSymlinkIfExists(join(userPiDir, 'sessions'), join(dir, 'sessions'), true),
        ensureSymlinkIfExists(join(userPiDir, 'skills'), join(dir, 'skills'), true),
        ensureSymlinkIfExists(join(userPiDir, 'settings.json'), join(dir, 'settings.json'), false),
      ]);
    }
    nextEnv.PI_CODING_AGENT_DIR = dir;
    return { env: nextEnv, configDir: dir };
  }

  // 4. CodeBuddy: CODEBUDDY_CONFIG_DIR + 真实 CODEBUDDY_INTERNET_ENVIRONMENT + 官方 API Key / OAuth 槽位 + 可选 usage-cookie
  if (normalizedBackend === 'codebuddy') {
    const internetEnv = codebuddyInternetEnvForRegion(account?.region);
    if (internetEnv) {
      nextEnv.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    }
    if (!isSystem) {
      // 独立账号绝不继承宿主环境变量里其他账号的 CODEBUDDY_COOKIE / CODEBUDDY_API_KEY
      delete nextEnv.CODEBUDDY_COOKIE;
      delete nextEnv.CODEBUDDY_API_KEY;
    }
    const cookie = (await secrets.get(accountCookieSecretKey(accountId)))?.trim();
    if (cookie) {
      nextEnv.CODEBUDDY_COOKIE = cookie;
    }
    let hasApiKey = false;
    if (!isSystem) {
      const apiKey = (await secrets.get(accountApiKeySecretKey(accountId)))?.trim();
      if (apiKey) {
        nextEnv.CODEBUDDY_API_KEY = apiKey;
        hasApiKey = true;
      }
    }
    if (!hasApiKey && activateSlot) {
      await switchCodebuddyCredentialSlot({
        targetAccountId: accountId,
        ...(previousAccountId ? { previousAccountId } : {}),
        secrets,
        env: baseEnv,
      });
    }
    if (isSystem) {
      return { env: nextEnv };
    }
    const dir = accountIsolationDir(storageRoot, backendId, accountId);
    await ensureDirPrivate(dir);
    if (!isolateSessions) {
      const userCbDir = baseEnv.CODEBUDDY_CONFIG_DIR?.trim()
        ? resolve(baseEnv.CODEBUDDY_CONFIG_DIR.trim())
        : join(userHome, '.codebuddy');
      await ensureSymlinkIfExists(join(userCbDir, 'projects'), join(dir, 'projects'), true);
    }
    nextEnv.CODEBUDDY_CONFIG_DIR = dir;
    return { env: nextEnv, configDir: dir };
  }

  // 5. OpenCode: XDG_CONFIG_HOME / XDG_DATA_HOME
  if (normalizedBackend === 'opencode') {
    if (isSystem) {
      return { env: nextEnv };
    }
    const dir = accountIsolationDir(storageRoot, backendId, accountId);
    const xdgConfig = join(dir, 'config');
    const xdgData = join(dir, 'data');
    await Promise.all([ensureDirPrivate(dir), ensureDirPrivate(xdgConfig), ensureDirPrivate(xdgData)]);
    if (!isolateSessions) {
      const userData = baseEnv.XDG_DATA_HOME?.trim()
        ? resolve(baseEnv.XDG_DATA_HOME.trim())
        : join(userHome, '.local', 'share');
      await ensureSymlinkIfExists(
        join(userData, 'opencode', 'storage'),
        join(xdgData, 'opencode', 'storage'),
        true,
      );
    }
    nextEnv.XDG_CONFIG_HOME = xdgConfig;
    nextEnv.XDG_DATA_HOME = xdgData;
    return { env: nextEnv, configDir: dir };
  }

  // 6. DeepSeek (dsh): 官方 API Key 账号
  if (normalizedBackend === 'dsh') {
    if (!isSystem) {
      const apiKey = (await secrets.get(accountApiKeySecretKey(accountId)))?.trim();
      if (apiKey) {
        nextEnv.DEEPSEEK_API_KEY = apiKey;
      }
    }
    return { env: nextEnv };
  }

  // 7. Antigravity: L2 凭据槽位快照切换
  if (normalizedBackend === 'antigravity') {
    if (activateSlot) {
      await switchAntigravityCredentialSlot({
        targetAccountId: accountId,
        ...(previousAccountId ? { previousAccountId } : {}),
        secrets,
        env: baseEnv,
      });
    }
    return { env: nextEnv };
  }

  return { env: nextEnv };
}

/** 退出指定账号登录：只清理凭据文件与 SecretStorage 中的凭据，保留账号配置与项目历史会话。 */
export async function clearAccountCredentials(params: {
  readonly backendId: string;
  readonly accountId: string;
  readonly storageRoot: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly secrets: SecretStore;
}): Promise<void> {
  const { backendId, accountId, storageRoot, baseEnv, secrets } = params;
  const normalizedBackend = backendId.toLowerCase();
  const isSystem = isSystemAccountId(accountId);
  const userHome = resolveUserHome(baseEnv);

  const tryUnlink = async (fp: string): Promise<void> => {
    await unlink(fp).catch(() => undefined);
  };

  if (normalizedBackend === 'claude') {
    const dir = isSystem
      ? baseEnv.CLAUDE_CONFIG_DIR?.trim()
        ? resolve(baseEnv.CLAUDE_CONFIG_DIR.trim())
        : join(userHome, '.claude')
      : accountIsolationDir(storageRoot, backendId, accountId);
    await tryUnlink(join(dir, '.credentials.json'));
    return;
  }

  if (normalizedBackend === 'codex') {
    const dir = isSystem
      ? baseEnv.CODEX_HOME?.trim()
        ? resolve(baseEnv.CODEX_HOME.trim())
        : join(userHome, '.codex')
      : accountIsolationDir(storageRoot, backendId, accountId);
    await tryUnlink(join(dir, 'auth.json'));
    return;
  }

  if (normalizedBackend === 'pi' || normalizedBackend === 'oh-my-pi') {
    const dir = isSystem
      ? baseEnv.PI_CODING_AGENT_DIR?.trim()
        ? resolve(baseEnv.PI_CODING_AGENT_DIR.trim())
        : join(userHome, '.pi', 'agent')
      : accountIsolationDir(storageRoot, backendId, accountId);
    await tryUnlink(join(dir, 'auth.json'));
    return;
  }

  if (normalizedBackend === 'opencode') {
    const dataRoot = isSystem
      ? baseEnv.XDG_DATA_HOME?.trim()
        ? resolve(baseEnv.XDG_DATA_HOME.trim())
        : join(userHome, '.local', 'share')
      : join(accountIsolationDir(storageRoot, backendId, accountId), 'data');
    await tryUnlink(join(dataRoot, 'opencode', 'auth.json'));
    return;
  }

  if (normalizedBackend === 'codebuddy') {
    await Promise.all([
      secrets.delete(accountApiKeySecretKey(accountId)),
      secrets.delete(accountCookieSecretKey(accountId)),
      secrets.delete(accountSlotSecretKey(accountId)),
    ]);
    if (isSystem) {
      await clearCodebuddyDiskAuth(baseEnv);
    }
    const dir = isSystem
      ? baseEnv.CODEBUDDY_CONFIG_DIR?.trim()
        ? resolve(baseEnv.CODEBUDDY_CONFIG_DIR.trim())
        : join(userHome, '.codebuddy')
      : accountIsolationDir(storageRoot, backendId, accountId);
    await Promise.all([
      tryUnlink(join(dir, 'auth.json')),
      tryUnlink(join(dir, '.credentials.json')),
      tryUnlink(join(dir, 'token.json')),
    ]);
    return;
  }

  if (normalizedBackend === 'antigravity') {
    await secrets.delete(accountSlotSecretKey(accountId));
    if (isSystem) {
      await tryUnlink(antigravityPrimaryTokenPath(baseEnv));
    }
    return;
  }

  if (normalizedBackend === 'dsh') {
    await secrets.delete(accountApiKeySecretKey(accountId));
  }
}

/** 彻底删除一个独立官方账号的本地隔离目录与全部 SecretStorage 凭据（严禁对系统默认账号调用）。 */
export async function removeIsolatedAccountData(params: {
  readonly backendId: string;
  readonly accountId: string;
  readonly storageRoot: string;
  readonly secrets: SecretStore;
}): Promise<void> {
  const { backendId, accountId, storageRoot, secrets } = params;
  if (isSystemAccountId(accountId)) return;
  await Promise.all([
    secrets.delete(accountApiKeySecretKey(accountId)),
    secrets.delete(accountCookieSecretKey(accountId)),
    secrets.delete(accountSlotSecretKey(accountId)),
    rm(accountIsolationDir(storageRoot, backendId, accountId), { recursive: true, force: true }).catch(() => undefined),
  ]);
}

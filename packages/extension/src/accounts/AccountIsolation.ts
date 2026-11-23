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
import { chmod, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AccountConfig } from '@harness-deck/shared';
import type { SecretStore } from '../host/HostPlatform.ts';
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

/** 将 Antigravity 凭据槽位原子写入本机 CLI 凭据文件（供 `agy acp` 直接使用）。 */
export async function writeAntigravityDiskTokenRaw(
  raw: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await writeFileAtomicPrivate(antigravityPrimaryTokenPath(env), raw);
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

  // 1. 先把当前磁盘凭据写回上一个激活槽位（若尚未记录，兜底备份到系统默认槽位，避免丢失用户原始登录）
  const currentDisk = await readAntigravityDiskTokenRaw(env);
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

  // 2. 读取目标槽位并激活到磁盘
  const targetRaw = await secrets.get(accountSlotSecretKey(targetAccountId));
  if (targetRaw?.trim()) {
    await writeAntigravityDiskTokenRaw(targetRaw, env);
    return { activated: true, hasStoredSlot: true };
  }

  // 目标是系统默认账号且磁盘已有凭据时，视为已激活
  if (targetAccountId === sysId && currentDisk) {
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

  // 4. CodeBuddy: CODEBUDDY_CONFIG_DIR + region + 可选 usage-cookie
  if (normalizedBackend === 'codebuddy') {
    if (account?.region) {
      nextEnv.CODEBUDDY_INTERNET_ENVIRONMENT = account.region;
    }
    const cookie = (await secrets.get(accountCookieSecretKey(accountId)))?.trim();
    if (cookie) {
      nextEnv.CODEBUDDY_COOKIE = cookie;
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
    await secrets.delete(accountCookieSecretKey(accountId));
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

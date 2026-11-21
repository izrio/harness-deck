/**
 * 智能体运行环境与可执行文件路径持久化缓存：
 * 保存在 VS Code globalState 中，避免每次进入插件或重启窗口时重复扫描 PATH、运行 node/npm 探测子进程。
 */
import { isAbsolute } from 'node:path';
import type { NodeEnvState } from '@harness-deck/shared';
import { isWslWindowsPath } from '../runtime/wsl.ts';
import type { BackendProfile } from './types.ts';

export const BACKEND_ENV_CACHE_KEY = 'harnessDeck.backendEnvCache';

export interface CachedExecutableRecord {
  /** 生成该缓存时的命令配置签名；用户修改启动命令或 dsh.path 后自动失效。 */
  readonly commandSpec: string;
  /** 解析后的完整可执行文件路径。 */
  readonly command: string;
  readonly version?: string;
  readonly mtimeMs?: number;
  readonly size?: number;
}

export interface PersistedBackendEnvCache {
  readonly schemaVersion: 1;
  readonly platform: string;
  /** 标记该缓存是在启用 WSL 宿主机路径隔离后生成的，旧版 WSL 缓存自动失效并重检。 */
  readonly wslIsolated?: boolean;
  readonly updatedAt: number;
  readonly nodeEnv: NodeEnvState;
  readonly npmCommand?: string;
  readonly npmGlobalBin?: string;
  readonly availability: Readonly<Record<string, boolean>>;
  readonly installedVersions: Readonly<Record<string, string>>;
  readonly availableVersions: Readonly<Record<string, readonly string[]>>;
  readonly executables: Readonly<Record<string, CachedExecutableRecord>>;
}

export interface ParseBackendEnvCacheOptions {
  readonly isWsl?: boolean;
  readonly wslMountRoots?: readonly string[];
}

/** 判断命令签名是否来自自动 PATH 探测（而非用户显式指定的绝对/相对路径）。 */
export function isAutoDetectedCommandSpec(commandSpec: string): boolean {
  const sep = commandSpec.indexOf('::');
  if (sep < 0) return true;
  const kind = commandSpec.slice(0, sep);
  const value = commandSpec.slice(sep + 2).trim();
  if (kind === 'acp') {
    return !isAbsolute(value) && !/[\\/]/u.test(value);
  }
  return value.length === 0;
}

/** 计算某个底层配置的命令签名，配置变更时旧路径缓存自动失效。 */
export function commandSpecForProfile(
  profile: BackendProfile,
  dshConfiguredPath = '',
  zcodeConfiguredPath = '',
  claudeConfiguredPath = '',
  piConfiguredPath = '',
  codexConfiguredPath = '',
  codebuddyConfiguredPath = '',
): string {
  if (profile.kind === 'dsh') {
    return `dsh::${dshConfiguredPath.trim()}`;
  }
  if (profile.kind === 'zcode') {
    return `zcode::${zcodeConfiguredPath.trim()}`;
  }
  if (profile.kind === 'claude') {
    return `claude::${claudeConfiguredPath.trim()}`;
  }
  if (profile.kind === 'pi') {
    return `pi::${piConfiguredPath.trim()}`;
  }
  if (profile.kind === 'codex') {
    return `codex::${codexConfiguredPath.trim()}`;
  }
  if (profile.kind === 'codebuddy') {
    return `codebuddy::${codebuddyConfiguredPath.trim()}`;
  }
  return `acp::${profile.command.trim()}`;
}

function isStringMap(raw: unknown): raw is Readonly<Record<string, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.values(raw).every((v) => typeof v === 'string');
}

function isBooleanMap(raw: unknown): raw is Readonly<Record<string, boolean>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.values(raw).every((v) => typeof v === 'boolean');
}

/** 解析并校验 globalState 中持久化的环境缓存；平台不一致、格式损坏或 WSL 含 Windows 宿主机路径时返回 undefined。 */
export function parseBackendEnvCache(
  raw: unknown,
  platform: string = process.platform,
  options?: ParseBackendEnvCacheOptions,
): PersistedBackendEnvCache | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1 || obj.platform !== platform) return undefined;
  const wslIsolated = obj.wslIsolated === true;
  const inWsl = platform === 'linux' && options?.isWsl === true;
  if (inWsl && !wslIsolated) return undefined;

  const rawNode = obj.nodeEnv;
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return undefined;
  const n = rawNode as Record<string, unknown>;
  if (typeof n.checked !== 'boolean' || typeof n.hasNode !== 'boolean' || typeof n.hasNpm !== 'boolean') {
    return undefined;
  }
  const nodeEnv: NodeEnvState = {
    checked: n.checked,
    hasNode: n.hasNode,
    hasNpm: n.hasNpm,
    ...(typeof n.nodeVersion === 'string' && n.nodeVersion ? { nodeVersion: n.nodeVersion } : {}),
    ...(typeof n.npmVersion === 'string' && n.npmVersion ? { npmVersion: n.npmVersion } : {}),
  };

  const availability = isBooleanMap(obj.availability) ? { ...obj.availability } : {};
  const installedVersions = isStringMap(obj.installedVersions) ? { ...obj.installedVersions } : {};

  const availableVersions: Record<string, readonly string[]> = {};
  if (obj.availableVersions && typeof obj.availableVersions === 'object' && !Array.isArray(obj.availableVersions)) {
    for (const [k, v] of Object.entries(obj.availableVersions as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((item): item is string => typeof item === 'string')) {
        availableVersions[k] = v;
      }
    }
  }

  const executables: Record<string, CachedExecutableRecord> = {};
  if (obj.executables && typeof obj.executables === 'object' && !Array.isArray(obj.executables)) {
    for (const [k, v] of Object.entries(obj.executables as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const rec = v as Record<string, unknown>;
      if (typeof rec.commandSpec !== 'string' || typeof rec.command !== 'string' || !rec.command) continue;
      if (inWsl && isAutoDetectedCommandSpec(rec.commandSpec) && isWslWindowsPath(rec.command, options?.wslMountRoots)) {
        return undefined;
      }
      executables[k] = {
        commandSpec: rec.commandSpec,
        command: rec.command,
        ...(typeof rec.version === 'string' && rec.version ? { version: rec.version } : {}),
        ...(typeof rec.mtimeMs === 'number' && Number.isFinite(rec.mtimeMs) ? { mtimeMs: rec.mtimeMs } : {}),
        ...(typeof rec.size === 'number' && Number.isFinite(rec.size) ? { size: rec.size } : {}),
      };
    }
  }

  const npmCommand = typeof obj.npmCommand === 'string' && obj.npmCommand ? obj.npmCommand : undefined;
  const npmGlobalBin = typeof obj.npmGlobalBin === 'string' && obj.npmGlobalBin ? obj.npmGlobalBin : undefined;
  if (inWsl) {
    if (npmCommand && isWslWindowsPath(npmCommand, options?.wslMountRoots)) return undefined;
    if (npmGlobalBin && isWslWindowsPath(npmGlobalBin, options?.wslMountRoots)) return undefined;
  }

  return {
    schemaVersion: 1,
    platform,
    ...(wslIsolated ? { wslIsolated: true } : {}),
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
    nodeEnv,
    ...(npmCommand ? { npmCommand } : {}),
    ...(npmGlobalBin ? { npmGlobalBin } : {}),
    availability,
    installedVersions,
    availableVersions,
    executables,
  };
}

/**
 * 判断内存中的缓存是否已完整覆盖当前所有底层配置：
 * 完整命中时无需在每次打开面板时重复运行 checkAvailability()。
 */
export function isBackendEnvCacheComplete(
  state: {
    readonly nodeEnv: NodeEnvState;
    readonly availability: ReadonlyMap<string, boolean>;
    readonly executables: ReadonlyMap<string, CachedExecutableRecord>;
  },
  profiles: readonly BackendProfile[],
  dshConfiguredPath = '',
  zcodeConfiguredPath = '',
  claudeConfiguredPath = '',
  piConfiguredPath = '',
  codexConfiguredPath = '',
  codebuddyConfiguredPath = '',
): boolean {
  if (!state.nodeEnv.checked) return false;
  for (const profile of profiles) {
    if (!state.availability.has(profile.id)) return false;
    const expectedSpec = commandSpecForProfile(
      profile,
      dshConfiguredPath,
      zcodeConfiguredPath,
      claudeConfiguredPath,
      piConfiguredPath,
      codexConfiguredPath,
      codebuddyConfiguredPath,
    );
    const cachedExec = state.executables.get(profile.id);
    if (cachedExec && cachedExec.commandSpec !== expectedSpec) return false;
  }
  return true;
}

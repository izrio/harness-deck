/**
 * MCP 服务器统一管理与 Agent 启动挂载适配：
 * - 解析与持久化 `harnessDeck.mcpServers` 配置（纯函数，便于测试）；
 * - 按每个 MCP 服务器勾选的目标 Agent（backendId）筛选并在启动时注入：
 *   - ACP 代理：转换为标准 ACP `session/new` / `session/load` 的 `mcpServers` 参数；
 *   - DeepSeek (dsh)：连同已启用 Skills 一起生成临时 Cordis `--patch` 文件挂载 `@deepseek-ai/dsh-mcp-client`。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { InstalledSkillView, McpServerConfig, McpTransport } from '@harness-deck/shared';
import type { BackendProfile } from '../backend/types.ts';
import { skillsForBackend, stageSkillsForBackend } from './skillService.ts';

export interface RawMcpServerSetting {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly transport?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
  readonly enabled?: unknown;
  readonly agents?: unknown;
  readonly importedFrom?: unknown;
}

export interface UpsertMcpServerInput {
  readonly id?: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly agents: readonly string[];
  readonly importedFrom?: string;
}

export interface AcpMcpCapabilities {
  readonly http?: boolean;
  readonly sse?: boolean;
}

export type AcpMcpServerWire =
  | {
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly { readonly name: string; readonly value: string }[];
    }
  | {
      readonly type: 'http' | 'sse';
      readonly name: string;
      readonly url: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
    };

/** 规范化 MCP 服务器唯一 id。 */
export function normalizeMcpId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 100);
  return cleaned || 'mcp-server';
}

function cleanStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key || typeof v !== 'string') continue;
    out[key] = v;
  }
  return out;
}

function cleanStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueStrings(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** 解析设置 `harnessDeck.mcpServers` 中的配置项。 */
export function parseMcpServersSetting(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const result: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const item of raw as RawMcpServerSetting[]) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const id = normalizeMcpId(typeof item.id === 'string' && item.id.trim() ? item.id : name);
    if (seen.has(id)) continue;

    const rawTransport = typeof item.transport === 'string' ? item.transport.trim().toLowerCase() : '';
    const transport: McpTransport =
      rawTransport === 'http' || rawTransport === 'streamable-http'
        ? 'http'
        : rawTransport === 'sse'
          ? 'sse'
          : 'stdio';

    if (transport === 'stdio') {
      const command = typeof item.command === 'string' ? item.command.trim() : '';
      if (!command) continue;
      const args = cleanStringArray(item.args);
      const env = cleanStringRecord(item.env);
      seen.add(id);
      result.push({
        id,
        name,
        transport: 'stdio',
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        enabled: item.enabled !== false,
        agents: uniqueStrings(cleanStringArray(item.agents)),
        ...(typeof item.importedFrom === 'string' && item.importedFrom.trim()
          ? { importedFrom: item.importedFrom.trim() }
          : {}),
      });
    } else {
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (!url) continue;
      const headers = cleanStringRecord(item.headers);
      seen.add(id);
      result.push({
        id,
        name,
        transport,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        enabled: item.enabled !== false,
        agents: uniqueStrings(cleanStringArray(item.agents)),
        ...(typeof item.importedFrom === 'string' && item.importedFrom.trim()
          ? { importedFrom: item.importedFrom.trim() }
          : {}),
      });
    }
  }

  return result;
}

function serializeMcpServer(server: McpServerConfig): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.transport === 'stdio'
      ? {
          command: server.command ?? '',
          ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
          ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        }
      : {
          url: server.url ?? '',
          ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
        }),
    enabled: server.enabled,
    agents: [...server.agents],
    ...(server.importedFrom ? { importedFrom: server.importedFrom } : {}),
  };
}

/** 新增或编辑一台 MCP 服务器并生成写回设置的数组。 */
export function upsertMcpServerSetting(raw: unknown, input: UpsertMcpServerInput): Record<string, unknown>[] {
  const current = parseMcpServersSetting(raw);
  const name = input.name.trim();
  const nextId = normalizeMcpId(input.id?.trim() || name);
  const prev = current.find((s) => s.id === nextId);

  const entry: McpServerConfig =
    input.transport === 'stdio'
      ? {
          id: nextId,
          name,
          transport: 'stdio',
          command: (input.command ?? '').trim(),
          ...(input.args && input.args.filter((a) => a.trim()).length > 0
            ? { args: input.args.map((a) => a.trim()).filter(Boolean) }
            : {}),
          ...(input.env && Object.keys(cleanStringRecord(input.env)).length > 0
            ? { env: cleanStringRecord(input.env) }
            : {}),
          enabled: input.enabled ?? prev?.enabled ?? true,
          agents: uniqueStrings(input.agents),
          ...(input.importedFrom?.trim()
            ? { importedFrom: input.importedFrom.trim() }
            : prev?.importedFrom
              ? { importedFrom: prev.importedFrom }
              : {}),
        }
      : {
          id: nextId,
          name,
          transport: input.transport,
          url: (input.url ?? '').trim(),
          ...(input.headers && Object.keys(cleanStringRecord(input.headers)).length > 0
            ? { headers: cleanStringRecord(input.headers) }
            : {}),
          enabled: input.enabled ?? prev?.enabled ?? true,
          agents: uniqueStrings(input.agents),
          ...(input.importedFrom?.trim()
            ? { importedFrom: input.importedFrom.trim() }
            : prev?.importedFrom
              ? { importedFrom: prev.importedFrom }
              : {}),
        };

  let replaced = false;
  const next = current.map((item) => {
    if (item.id === nextId) {
      replaced = true;
      return entry;
    }
    return item;
  });
  const finalList = replaced ? next : [...next, entry];
  return finalList.map(serializeMcpServer);
}

/** 快捷切换某台 MCP 服务器的启用状态或目标 Agent 列表。 */
export function toggleMcpServerSetting(
  raw: unknown,
  patch: { readonly id: string; readonly enabled?: boolean; readonly agents?: readonly string[] },
): Record<string, unknown>[] {
  const targetId = normalizeMcpId(patch.id);
  const current = parseMcpServersSetting(raw);
  const updated = current.map((item) => {
    if (item.id !== targetId) return item;
    return {
      ...item,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.agents !== undefined ? { agents: uniqueStrings(patch.agents) } : {}),
    };
  });
  return updated.map(serializeMcpServer);
}

/** 删除指定 id 的 MCP 服务器。 */
export function deleteMcpServerSetting(raw: unknown, id: string): Record<string, unknown>[] {
  const targetId = normalizeMcpId(id);
  return parseMcpServersSetting(raw)
    .filter((item) => item.id !== targetId)
    .map(serializeMcpServer);
}

/** 批量导入 MCP 服务器（同名项更新连接参数并合并目标 Agent）。 */
export function importMcpServersSetting(
  raw: unknown,
  incoming: readonly Omit<UpsertMcpServerInput, 'agents'>[],
  agents: readonly string[],
): Record<string, unknown>[] {
  let state: unknown = raw;
  const targetAgents = uniqueStrings(agents);
  for (const item of incoming) {
    const existing = parseMcpServersSetting(state).find((s) => s.id === normalizeMcpId(item.name));
    const mergedAgents = existing ? uniqueStrings([...existing.agents, ...targetAgents]) : targetAgents;
    state = upsertMcpServerSetting(state, {
      ...item,
      id: existing?.id ?? normalizeMcpId(item.name),
      enabled: existing?.enabled ?? true,
      agents: mergedAgents,
    });
  }
  return Array.isArray(state) ? (state as Record<string, unknown>[]) : [];
}

/** 筛选出已启用且分配给指定 Agent 的 MCP 服务器列表（兼容旧配置中指定的 `oh-my-pi`）。 */
export function mcpServersForBackend(servers: readonly McpServerConfig[], backendId: string): McpServerConfig[] {
  return servers.filter(
    (s) => s.enabled && (s.agents.includes(backendId) || (backendId === 'pi' && s.agents.includes('oh-my-pi'))),
  );
}

/** 为原生 Claude Code (`claude -p --mcp-config`) 生成标准 `.mcp.json` 内容。 */
export function buildClaudeMcpConfigJson(servers: readonly McpServerConfig[]): string | undefined {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    if (server.transport === 'stdio') {
      if (!server.command) continue;
      mcpServers[server.name] = {
        type: 'stdio',
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
      };
    } else if (server.url) {
      mcpServers[server.name] = {
        type: server.transport,
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
      };
    }
  }
  if (Object.keys(mcpServers).length === 0) return undefined;
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * 将统一 MCP 配置转换为 ACP 协议 `session/new` 与 `session/load` 所需的 `mcpServers` 结构。
 */
export function toAcpMcpServers(
  servers: readonly McpServerConfig[],
  capabilities?: AcpMcpCapabilities,
): AcpMcpServerWire[] {
  const wire: AcpMcpServerWire[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    if (server.transport === 'stdio') {
      if (!server.command) continue;
      wire.push({
        name: server.name,
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
      });
      continue;
    }
    if (!server.url) continue;
    if (server.transport === 'http') {
      if (capabilities?.http === false) continue;
      wire.push({
        type: 'http',
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
      });
      continue;
    }
    // sse
    if (capabilities?.sse === false) {
      if (capabilities.http === true) {
        wire.push({
          type: 'http',
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        });
      }
      continue;
    }
    wire.push({
      type: 'sse',
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
    });
  }
  return wire;
}

/**
 * 为 DeepSeek Harness (dsh) 生成启动时 `--patch` 使用的 Cordis YAML。
 * 使用 JSON 字符串字面量转义（YAML 1.2 完全兼容 JSON 标量），安全处理路径反斜杠、引号和特殊字符。
 */
export function buildDshRuntimePatchYaml(params: {
  readonly skillsDir?: string;
  readonly skillCount: number;
  readonly mcpServers: readonly McpServerConfig[];
}): string | undefined {
  const lines: string[] = [];
  const activeMcp = params.mcpServers.filter(
    (s) => s.enabled && (s.transport === 'stdio' ? Boolean(s.command) : Boolean(s.url)),
  );
  const hasSkills = Boolean(params.skillsDir && params.skillCount > 0);
  if (!hasSkills && activeMcp.length === 0) return undefined;

  lines.push('- insert:');

  if (hasSkills && params.skillsDir) {
    lines.push('    - id: hd-skills');
    lines.push("      name: '@deepseek-ai/dsh-skill-filesystem'");
    lines.push('      config:');
    lines.push('        providerName: harness-deck');
    lines.push('        includeDefaultRoots: false');
    lines.push('        watch: true');
    lines.push('        customSkillDirs:');
    lines.push(`          - ${JSON.stringify(params.skillsDir)}`);
  }

  const usedIds = new Set<string>();
  for (const server of activeMcp) {
    let safeServerName = server.name.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '') || 'mcp';
    while (usedIds.has(safeServerName)) safeServerName = `${safeServerName}_1`;
    usedIds.add(safeServerName);

    lines.push(`    - id: ${JSON.stringify(`hd-mcp-${safeServerName}`)}`);
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
    lines.push('      config:');
    lines.push(`        serverName: ${JSON.stringify(safeServerName)}`);
    lines.push('        enabled: true');
    if (server.transport === 'stdio') {
      lines.push('        transport: stdio');
      lines.push(`        command: ${JSON.stringify(server.command ?? '')}`);
      if (server.args && server.args.length > 0) {
        lines.push('        args:');
        for (const arg of server.args) {
          lines.push(`          - ${JSON.stringify(arg)}`);
        }
      }
      const envEntries = Object.entries(server.env ?? {});
      if (envEntries.length > 0) {
        lines.push('        env:');
        for (const [k, v] of envEntries) {
          lines.push(`          ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
        }
      }
    } else {
      lines.push('        transport: streamable-http');
      lines.push(`        url: ${JSON.stringify(server.url ?? '')}`);
      const headerEntries = Object.entries(server.headers ?? {});
      if (headerEntries.length > 0) {
        lines.push('        headers:');
        for (const [k, v] of headerEntries) {
          lines.push(`          ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
        }
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export type AcpSkillInjectionMode = 'cli' | 'claude-meta' | 'prompt';

export interface PreparedBackendLaunch {
  /** dsh 启动器级参数（如 `['--patch', patchFile]`）。 */
  readonly launcherArgs: readonly string[];
  /** ACP 代理进程附加的命令行参数（如 Pi 的 `--skill`、CodeBuddy 的 `--add-dir`）。 */
  readonly extraArgs: readonly string[];
  /** 已挂载技能的运行时目录（供 Claude / ACP `additionalDirectories` 使用）。 */
  readonly skillBundleDir?: string;
  /** ACP 代理加载技能的方式。 */
  readonly skillMode: AcpSkillInjectionMode;
  /** 当前对该 Agent 生效的技能列表。 */
  readonly skills: readonly InstalledSkillView[];
  /** 当前分配给该 Agent 的 MCP 服务器列表。 */
  readonly mcpServers: readonly McpServerConfig[];
}

function commandStem(cmd: string): string {
  return basename(cmd)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1|cjs|mjs|js)$/iu, '');
}

/** 判断 ACP 配置对应的原生技能注入模式。 */
export function detectAcpSkillMode(profile: Extract<BackendProfile, { kind: 'acp' }>): 'omp' | 'codebuddy' | 'claude' | 'generic' {
  const stem = commandStem(profile.command);
  if (profile.id === 'oh-my-pi' || stem === 'omp' || stem === 'pi') return 'omp';
  if (profile.id === 'codebuddy' || stem === 'codebuddy') return 'codebuddy';
  if (profile.id === 'claude' || stem.includes('claude')) return 'claude';
  return 'generic';
}

/**
 * 在 Agent 进程启动前准备技能目录、dsh patch 文件与 ACP 启动参数。
 */
export async function prepareBackendLaunch(params: {
  readonly storageRoot: string;
  readonly profile: BackendProfile;
  readonly skills: readonly InstalledSkillView[];
  readonly mcpServers: readonly McpServerConfig[];
}): Promise<PreparedBackendLaunch> {
  const staged = await stageSkillsForBackend(params.storageRoot, params.profile.id, params.skills);
  const activeMcp = mcpServersForBackend(params.mcpServers, params.profile.id);

  if (params.profile.kind === 'dsh') {
    const yaml = buildDshRuntimePatchYaml({
      skillsDir: staged.skillsDir,
      skillCount: staged.skillDirs.length,
      mcpServers: activeMcp,
    });
    const patchPath = join(params.storageRoot, 'runtime', 'dsh.patch.yml');
    if (yaml) {
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, yaml, 'utf8');
      return {
        launcherArgs: ['--patch', patchPath],
        extraArgs: [],
        ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
        skillMode: 'cli',
        skills: staged.skills,
        mcpServers: activeMcp,
      };
    }
    await rm(patchPath, { force: true }).catch(() => undefined);
    return {
      launcherArgs: [],
      extraArgs: [],
      skillMode: 'cli',
      skills: [],
      mcpServers: [],
    };
  }

  if (params.profile.kind === 'claude') {
    const mcpJson = buildClaudeMcpConfigJson(activeMcp);
    const mcpPath = join(params.storageRoot, 'runtime', 'claude.mcp.json');
    const extraArgs: string[] = [];
    if (staged.skillDirs.length > 0) {
      extraArgs.push('--add-dir', staged.bundleDir);
    }
    if (mcpJson) {
      await mkdir(dirname(mcpPath), { recursive: true });
      await writeFile(mcpPath, mcpJson, 'utf8');
      extraArgs.push('--mcp-config', mcpPath);
    } else {
      await rm(mcpPath, { force: true }).catch(() => undefined);
    }
    return {
      launcherArgs: [],
      extraArgs,
      ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
      skillMode: 'cli',
      skills: staged.skills,
      mcpServers: activeMcp,
    };
  }

  if (params.profile.kind === 'pi') {
    return {
      launcherArgs: [],
      extraArgs: staged.skillDirs.flatMap((dir) => ['--skill', dir]),
      ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
      skillMode: 'cli',
      skills: staged.skills,
      mcpServers: activeMcp,
    };
  }

  if (params.profile.kind === 'zcode') {
    return {
      launcherArgs: [],
      extraArgs: [],
      ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
      skillMode: 'prompt',
      skills: staged.skills,
      mcpServers: activeMcp,
    };
  }

  const kind = detectAcpSkillMode(params.profile);
  if (kind === 'omp') {
    return {
      launcherArgs: [],
      extraArgs: staged.skillDirs.flatMap((dir) => ['--skill', dir]),
      ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
      skillMode: 'cli',
      skills: staged.skills,
      mcpServers: activeMcp,
    };
  }
  if (kind === 'codebuddy') {
    return {
      launcherArgs: [],
      extraArgs: staged.skillDirs.length > 0 ? ['--add-dir', staged.bundleDir] : [],
      ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
      skillMode: 'cli',
      skills: staged.skills,
      mcpServers: activeMcp,
    };
  }
  if (kind === 'claude') {
    return {
      launcherArgs: [],
      extraArgs: [],
      ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
      skillMode: 'claude-meta',
      skills: staged.skills,
      mcpServers: activeMcp,
    };
  }
  return {
    launcherArgs: [],
    extraArgs: [],
    ...(staged.skillDirs.length > 0 ? { skillBundleDir: staged.bundleDir } : {}),
    skillMode: 'prompt',
    skills: staged.skills,
    mcpServers: activeMcp,
  };
}

/** 计算指定 Agent 当前生效的技能与 MCP 签名（用于判断是否需要热重载当前运行的 Agent）。 */
export function backendExtensionsSignature(
  backendId: string,
  skills: readonly InstalledSkillView[],
  mcpServers: readonly McpServerConfig[],
): string {
  const effectiveSkills = skillsForBackend(skills, backendId).map((s) => ({
    id: s.id,
    updatedAt: s.updatedAt,
  }));
  const effectiveMcp = mcpServersForBackend(mcpServers, backendId);
  return JSON.stringify({ skills: effectiveSkills, mcp: effectiveMcp });
}

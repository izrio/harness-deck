/**
 * 从本机与当前工作区各 Agent 的原生配置文件中扫描并解析 MCP 服务器定义：
 * - DeepSeek (dsh): `~/.dsh/mcp-manager.json`、`~/.dsh/cordis.patch.yml`、`~/.dsh/profiles/<profile>/cordis.patch.yml`、`.dsh/mcp.json`、`.dsh/dshmm/mcp.json`
 * - Pi (oh-my-pi): `~/.omp/agent/mcp.json`、`~/.pi/agent/mcp.json`、`.omp/mcp.json`、`.pi/mcp.json`
 * - CodeBuddy: `~/.codebuddy/.mcp.json`、`~/.codebuddy/mcp.json`、`~/.codebuddy/settings.json`、`.codebuddy/.mcp.json`
 * - Claude Code: `~/.claude.json`（含全局与当前项目 `projects[path].mcpServers`）、`~/.claude/mcp.json`、`.mcp.json`
 * - Codex: `~/.codex/config.toml`、`.codex/config.toml`
 * - Gemini CLI: `~/.gemini/settings.json`、`.gemini/settings.json`
 * - OpenCode: `~/.config/opencode/opencode.json(c)`、`opencode.json(c)`
 * - 任意外部配置文件（通过文件选择器导入 JSON / JSONC / TOML / YAML）
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { McpImportCandidate, McpTransport } from '@harness-deck/shared';
import { normalizeMcpId } from './mcpService.ts';

export interface ParsedMcpCandidate {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 安全解析 JSONC（剥离字符串外的单行/多行注释与尾随逗号，不破坏 URL 中的 `//`）。
 */
export function parseJsonc(raw: string): unknown {
  const src = raw.replace(/^\uFEFF/u, '');
  let stripped = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    stripped += ch;
    i++;
  }

  // 移除对象或数组闭合前的尾随逗号（仅在字符串外）
  let normalized = '';
  inString = false;
  escaped = false;
  for (let idx = 0; idx < stripped.length; idx++) {
    const ch = stripped[idx]!;
    if (inString) {
      normalized += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      normalized += ch;
      continue;
    }
    if (ch === ',') {
      let look = idx + 1;
      while (look < stripped.length && /\s/u.test(stripped[look]!)) look++;
      if (stripped[look] === '}' || stripped[look] === ']') continue;
    }
    normalized += ch;
  }

  return JSON.parse(normalized);
}

function toStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseServerEntryObject(name: string, raw: unknown): ParsedMcpCandidate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const cleanName = name.trim();
  if (!cleanName) return undefined;

  const rawType = typeof obj.transport === 'string' ? obj.transport : typeof obj.type === 'string' ? obj.type : '';
  const typeLower = rawType.trim().toLowerCase();

  // OpenCode local 格式: command 是字符串数组 ["npx", "-y", "..."]
  if (Array.isArray(obj.command)) {
    const parts = obj.command.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (parts.length === 0) return undefined;
    const [cmd, ...restArgs] = parts;
    const extraArgs = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === 'string')
      : [];
    const env = toStringRecord(obj.environment ?? obj.env);
    return {
      name: cleanName,
      transport: 'stdio',
      command: cmd!.trim(),
      ...(restArgs.length + extraArgs.length > 0 ? { args: [...restArgs, ...extraArgs] } : {}),
      ...(env ? { env } : {}),
    };
  }

  const urlValue =
    typeof obj.url === 'string' && obj.url.trim()
      ? obj.url.trim()
      : typeof obj.httpUrl === 'string' && obj.httpUrl.trim()
        ? obj.httpUrl.trim()
        : typeof obj.serverUrl === 'string' && obj.serverUrl.trim()
          ? obj.serverUrl.trim()
          : undefined;

  const cmdValue = typeof obj.command === 'string' && obj.command.trim() ? obj.command.trim() : undefined;

  if (urlValue && (typeLower === 'http' || typeLower === 'streamable-http' || typeLower === 'sse' || typeLower === 'remote' || !cmdValue)) {
    const transport: McpTransport = typeLower === 'sse' ? 'sse' : 'http';
    const headers = toStringRecord(obj.headers ?? obj.httpHeaders);
    return {
      name: cleanName,
      transport,
      url: urlValue,
      ...(headers ? { headers } : {}),
    };
  }

  if (cmdValue) {
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
      : [];
    const env = toStringRecord(obj.env ?? obj.environment);
    return {
      name: cleanName,
      transport: 'stdio',
      command: cmdValue,
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }

  return undefined;
}

function collectFromMap(mapObj: unknown, out: Map<string, ParsedMcpCandidate>): void {
  if (!mapObj || typeof mapObj !== 'object' || Array.isArray(mapObj)) return;
  for (const [name, entry] of Object.entries(mapObj as Record<string, unknown>)) {
    const parsed = parseServerEntryObject(name, entry);
    if (parsed) out.set(parsed.name, parsed);
  }
}

/** 解析 JSON / JSONC 格式的 MCP 配置文件内容。 */
export function parseJsonMcpServers(rawText: string, workspacePath?: string): ParsedMcpCandidate[] {
  let root: unknown;
  try {
    root = parseJsonc(rawText);
  } catch {
    return [];
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
  const doc = root as Record<string, unknown>;
  const collected = new Map<string, ParsedMcpCandidate>();

  // 标准 mcpServers（Claude / CodeBuddy / Pi / DSH / Gemini / Cursor）
  collectFromMap(doc.mcpServers, collected);
  // OpenCode 的 mcp 字段
  collectFromMap(doc.mcp, collected);
  // VS Code .vscode/mcp.json 的 servers 字段
  collectFromMap(doc.servers, collected);

  // Claude Code ~/.claude.json 中的 projects[workspacePath].mcpServers
  if (doc.projects && typeof doc.projects === 'object' && !Array.isArray(doc.projects)) {
    const projects = doc.projects as Record<string, unknown>;
    if (workspacePath) {
      const normWs = resolve(workspacePath);
      for (const [projKey, projVal] of Object.entries(projects)) {
        if (resolve(projKey) === normWs && projVal && typeof projVal === 'object') {
          collectFromMap((projVal as Record<string, unknown>).mcpServers, collected);
        }
      }
    } else {
      for (const projVal of Object.values(projects)) {
        if (projVal && typeof projVal === 'object') {
          collectFromMap((projVal as Record<string, unknown>).mcpServers, collected);
        }
      }
    }
  }

  // 若整个 JSON 本身就是一个服务器映射或单个服务器定义
  if (collected.size === 0) {
    collectFromMap(doc, collected);
  }

  return [...collected.values()];
}

/** 解析 Codex `config.toml` 中的 `[mcp_servers.<name>]` 定义。 */
export function parseCodexTomlMcpServers(rawText: string): ParsedMcpCandidate[] {
  const servers = new Map<string, Record<string, unknown>>();
  let currentServer: string | undefined;
  let currentSubkey: 'env' | 'http_headers' | 'headers' | undefined;

  const ensureServer = (name: string): Record<string, unknown> => {
    let existing = servers.get(name);
    if (!existing) {
      existing = {};
      servers.set(name, existing);
    }
    return existing;
  };

  for (const rawLine of rawText.replace(/\r\n/gu, '\n').split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      currentServer = undefined;
      currentSubkey = undefined;
      const parts = splitTomlPath(sectionMatch[1]!);
      if (parts[0] === 'mcp_servers' && parts[1]) {
        currentServer = parts[1];
        ensureServer(currentServer);
        if (parts[2] === 'env' || parts[2] === 'http_headers' || parts[2] === 'headers') {
          currentSubkey = parts[2];
        }
      }
      continue;
    }

    if (!currentServer) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = unquoteTomlKey(line.slice(0, eq).trim());
    const valRaw = line.slice(eq + 1).trim();
    const target = ensureServer(currentServer);

    if (currentSubkey) {
      const subKey = currentSubkey === 'http_headers' ? 'headers' : currentSubkey;
      const subObj = (target[subKey] as Record<string, string> | undefined) ?? {};
      const parsedScalar = parseTomlScalar(valRaw);
      if (parsedScalar !== undefined) {
        subObj[key] = parsedScalar;
        target[subKey] = subObj;
      }
      continue;
    }

    if (key === 'command' || key === 'url' || key === 'type' || key === 'transport') {
      const scalar = parseTomlScalar(valRaw);
      if (scalar !== undefined) target[key] = scalar;
    } else if (key === 'args') {
      target.args = parseTomlStringArray(valRaw);
    } else if (key === 'env' || key === 'http_headers' || key === 'headers') {
      const mapKey = key === 'http_headers' ? 'headers' : key;
      target[mapKey] = { ...((target[mapKey] as Record<string, string> | undefined) ?? {}), ...parseTomlInlineTable(valRaw) };
    }
  }

  const out: ParsedMcpCandidate[] = [];
  for (const [name, obj] of servers) {
    const parsed = parseServerEntryObject(name, obj);
    if (parsed) out.push(parsed);
  }
  return out;
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function splitTomlPath(raw: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function unquoteTomlKey(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseTomlScalar(raw: string): string | undefined {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw || undefined;
}

function parseTomlStringArray(raw: string): string[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return [];
  try {
    const jsonReady = raw.replace(/'([^']*)'/gu, (_, inner: string) => JSON.stringify(inner));
    const parsed = parseJsonc(jsonReady);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseTomlInlineTable(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith('{') || !raw.endsWith('}')) return out;
  const inner = raw.slice(1, -1).trim();
  if (!inner) return out;
  for (const part of inner.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = unquoteTomlKey(part.slice(0, eq).trim());
    const v = parseTomlScalar(part.slice(eq + 1).trim());
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}

/** 解析 DeepSeek `cordis.patch.yml` 中的 `@deepseek-ai/dsh-mcp-client` 插件条目。 */
export function parseDshPatchYamlMcpServers(rawText: string): ParsedMcpCandidate[] {
  const lines = rawText.replace(/\r\n/gu, '\n').split('\n');
  const results: ParsedMcpCandidate[] = [];

  interface Block {
    id?: string;
    pluginName?: string;
    serverName?: string;
    transport?: string;
    command?: string;
    url?: string;
    args: string[];
    env: Record<string, string>;
    headers: Record<string, string>;
  }

  let current: Block | undefined;
  let itemIndent = -1;
  let configIndent = -1;
  let subMode: 'args' | 'env' | 'headers' | undefined;

  const flush = () => {
    if (!current || current.pluginName !== '@deepseek-ai/dsh-mcp-client') {
      current = undefined;
      return;
    }
    const name = current.serverName || current.id?.replace(/^(?:hd-)?mcp[-_]?/iu, '') || current.id || '';
    const parsed = parseServerEntryObject(name, {
      transport: current.transport,
      command: current.command,
      args: current.args,
      env: current.env,
      url: current.url,
      headers: current.headers,
    });
    if (parsed) results.push(parsed);
    current = undefined;
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.search(/\S/u);
    const trimmed = rawLine.trim();

    const idMatch = /^-\s+id\s*:\s*(.+)$/u.exec(trimmed);
    if (idMatch) {
      flush();
      current = { id: unquoteYaml(idMatch[1]!), args: [], env: {}, headers: {} };
      itemIndent = indent;
      configIndent = -1;
      subMode = undefined;
      continue;
    }

    if (!current) continue;
    if (indent <= itemIndent && trimmed.startsWith('- ')) {
      flush();
      continue;
    }

    if (configIndent < 0) {
      const nameMatch = /^name\s*:\s*(.+)$/u.exec(trimmed);
      if (nameMatch) {
        current.pluginName = unquoteYaml(nameMatch[1]!);
        continue;
      }
      if (/^config\s*:\s*$/u.test(trimmed)) {
        configIndent = indent;
        subMode = undefined;
        continue;
      }
    } else if (indent > configIndent) {
      if (subMode && indent > configIndent + 2) {
        if (subMode === 'args' && trimmed.startsWith('-')) {
          current.args.push(unquoteYaml(trimmed.slice(1).trim()));
          continue;
        }
        if (subMode === 'env' || subMode === 'headers') {
          const kv = /^([^:]+):\s*(.+)$/u.exec(trimmed);
          if (kv) {
            const key = unquoteYaml(kv[1]!.trim());
            const val = unquoteYaml(kv[2]!.trim());
            if (key && !val.startsWith('!!js')) {
              current[subMode][key] = val;
            }
          }
          continue;
        }
      }
      subMode = undefined;
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(trimmed);
      if (!kv) continue;
      const [, k, vRaw] = kv;
      const v = vRaw!.trim();
      if (k === 'args' && !v) subMode = 'args';
      else if (k === 'env' && !v) subMode = 'env';
      else if (k === 'headers' && !v) subMode = 'headers';
      else if (k === 'args' && v.startsWith('[')) current.args = parseTomlStringArray(v);
      else if (k === 'serverName') current.serverName = unquoteYaml(v);
      else if (k === 'transport') current.transport = unquoteYaml(v);
      else if (k === 'command') current.command = unquoteYaml(v);
      else if (k === 'url') current.url = unquoteYaml(v);
    }
  }
  flush();
  return results;
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 按文件扩展名自动选择解析器，提取配置文件中的 MCP 服务器列表。 */
export function parseMcpConfigFileContent(content: string, filePath: string, workspacePath?: string): ParsedMcpCandidate[] {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.toml') return parseCodexTomlMcpServers(content);
  if (ext === '.yml' || ext === '.yaml') return parseDshPatchYamlMcpServers(content);
  return parseJsonMcpServers(content, workspacePath);
}

interface SourceProbe {
  readonly agentId: string;
  readonly agentName: string;
  readonly path: string;
}

export interface ScanMcpConfigsOptions {
  readonly homeDir?: string;
  readonly workspacePath?: string;
  readonly dshHome?: string;
  readonly dshProfile?: string;
  readonly existingIds?: ReadonlySet<string>;
}

/**
 * 扫描本机和当前工作区中各 Agent 的 MCP 配置文件。
 */
export async function scanAgentMcpConfigs(options: ScanMcpConfigsOptions = {}): Promise<{
  readonly items: McpImportCandidate[];
  readonly scannedSources: string[];
}> {
  const home = options.homeDir ?? homedir();
  const ws = options.workspacePath;
  const dshHome = options.dshHome || process.env.DSH_HOME || join(home, '.dsh');
  const dshProfile = options.dshProfile || 'web';
  const existingIds = options.existingIds ?? new Set<string>();

  const probes: SourceProbe[] = [
    // DeepSeek (dsh)
    { agentId: 'dsh', agentName: 'DeepSeek', path: join(dshHome, 'mcp-manager.json') },
    { agentId: 'dsh', agentName: 'DeepSeek', path: join(dshHome, 'mcp.json') },
    { agentId: 'dsh', agentName: 'DeepSeek', path: join(dshHome, 'cordis.patch.yml') },
    { agentId: 'dsh', agentName: 'DeepSeek', path: join(dshHome, 'profiles', dshProfile, 'cordis.patch.yml') },
    ...(ws
      ? [
          { agentId: 'dsh', agentName: 'DeepSeek', path: join(ws, '.dsh', 'mcp.json') },
          { agentId: 'dsh', agentName: 'DeepSeek', path: join(ws, '.dsh', 'dshmm', 'mcp.json') },
        ]
      : []),

    // Claude Code
    { agentId: 'claude', agentName: 'Claude Code', path: join(home, '.claude.json') },
    { agentId: 'claude', agentName: 'Claude Code', path: join(home, '.claude', 'mcp.json') },
    { agentId: 'claude', agentName: 'Claude Code', path: join(home, '.claude', 'settings.json') },
    ...(ws ? [{ agentId: 'claude', agentName: 'Claude Code', path: join(ws, '.mcp.json') }] : []),

    // Pi / oh-my-pi
    { agentId: 'pi', agentName: 'Pi', path: join(home, '.pi', 'agent', 'mcp.json') },
    { agentId: 'pi', agentName: 'Pi', path: join(home, '.omp', 'agent', 'mcp.json') },
    ...(ws
      ? [
          { agentId: 'pi', agentName: 'Pi', path: join(ws, '.pi', 'mcp.json') },
          { agentId: 'pi', agentName: 'Pi', path: join(ws, '.omp', 'mcp.json') },
        ]
      : []),

    // CodeBuddy
    { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(home, '.codebuddy', '.mcp.json') },
    { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(home, '.codebuddy', 'mcp.json') },
    { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(home, '.codebuddy', 'settings.json') },
    ...(ws
      ? [
          { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(ws, '.codebuddy', '.mcp.json') },
          { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(ws, '.codebuddy', 'mcp.json') },
        ]
      : []),

    // Codex
    { agentId: 'codex', agentName: 'Codex', path: join(home, '.codex', 'config.toml') },
    ...(ws ? [{ agentId: 'codex', agentName: 'Codex', path: join(ws, '.codex', 'config.toml') }] : []),

    // Gemini CLI
    { agentId: 'gemini', agentName: 'Gemini CLI', path: join(home, '.gemini', 'settings.json') },
    ...(ws ? [{ agentId: 'gemini', agentName: 'Gemini CLI', path: join(ws, '.gemini', 'settings.json') }] : []),

    // Antigravity
    { agentId: 'antigravity', agentName: 'Antigravity', path: join(home, '.gemini', 'config', 'mcp_config.json') },
    { agentId: 'antigravity', agentName: 'Antigravity', path: join(home, '.gemini', 'antigravity', 'mcp_config.json') },
    ...(ws ? [{ agentId: 'antigravity', agentName: 'Antigravity', path: join(ws, '.agents', 'mcp_config.json') }] : []),

    // OpenCode
    { agentId: 'opencode', agentName: 'OpenCode', path: join(home, '.config', 'opencode', 'opencode.json') },
    { agentId: 'opencode', agentName: 'OpenCode', path: join(home, '.config', 'opencode', 'opencode.jsonc') },
    ...(ws
      ? [
          { agentId: 'opencode', agentName: 'OpenCode', path: join(ws, 'opencode.json') },
          { agentId: 'opencode', agentName: 'OpenCode', path: join(ws, 'opencode.jsonc') },
          { agentId: 'opencode', agentName: 'OpenCode', path: join(ws, '.opencode', 'opencode.json') },
        ]
      : []),

    // ZCode
    { agentId: 'zcode', agentName: 'ZCode', path: join(home, '.zcode', 'mcp.json') },
    { agentId: 'zcode', agentName: 'ZCode', path: join(home, '.zcode', 'settings.json') },
    ...(ws ? [{ agentId: 'zcode', agentName: 'ZCode', path: join(ws, '.zcode', 'mcp.json') }] : []),

    // Cursor / VS Code
    { agentId: 'cursor', agentName: 'Cursor', path: join(home, '.cursor', 'mcp.json') },
    ...(ws ? [{ agentId: 'vscode', agentName: 'VS Code', path: join(ws, '.vscode', 'mcp.json') }] : []),
  ];

  const items: McpImportCandidate[] = [];
  const scannedSources: string[] = [];
  const seenKeys = new Set<string>();

  for (const probe of probes) {
    const fileStat = await stat(probe.path).catch(() => undefined);
    if (!fileStat || !fileStat.isFile()) continue;
    const content = await readFile(probe.path, 'utf8').catch(() => undefined);
    if (!content) continue;
    scannedSources.push(probe.path);

    const parsed = parseMcpConfigFileContent(content, probe.path, ws);
    for (const server of parsed) {
      const key = `${probe.agentId}:${probe.path}:${server.name}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      items.push({
        key,
        ...server,
        sourceAgentId: probe.agentId,
        sourceAgentName: probe.agentName,
        sourcePath: probe.path,
        ...(existingIds.has(normalizeMcpId(server.name)) ? { conflict: true } : {}),
      });
    }
  }

  return { items, scannedSources };
}

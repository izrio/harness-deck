import type { McpServerConfig, McpTransport } from '@harness-deck/shared';

export interface McpFormState {
  readonly id?: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly url: string;
  readonly headersText: string;
  readonly enabled: boolean;
  readonly agents: readonly string[];
  readonly importedFrom?: string;
}

export function splitCommandArgs(raw: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/gu;
  for (const match of raw.matchAll(regex)) {
    const quotedDouble = match[1];
    const quotedSingle = match[2];
    const plain = match[3];
    if (quotedDouble !== undefined) tokens.push(quotedDouble.replace(/\\"/gu, '"'));
    else if (quotedSingle !== undefined) tokens.push(quotedSingle.replace(/\\'/gu, "'"));
    else if (plain !== undefined) tokens.push(plain);
  }
  return tokens;
}

export function formatArgs(args: readonly string[] | undefined): string {
  if (!args || args.length === 0) return '';
  return args.map((arg) => (/\s/u.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

export function parseKeyValueLines(raw: string, allowColon = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let sepIdx = trimmed.indexOf('=');
    if (allowColon) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0 && (sepIdx < 0 || colonIdx < sepIdx)) {
        sepIdx = colonIdx;
      }
    }
    if (sepIdx <= 0) continue;
    const key = trimmed.slice(0, sepIdx).trim();
    const val = trimmed.slice(sepIdx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export function formatKeyValueLines(map: Readonly<Record<string, string>> | undefined, sep = '='): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}

export function emptyMcpForm(defaultAgents: readonly string[]): McpFormState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
    enabled: true,
    agents: defaultAgents,
  };
}

export function formFromServer(server: McpServerConfig): McpFormState {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: formatArgs(server.args),
    envText: formatKeyValueLines(server.env, '='),
    url: server.url ?? '',
    headersText: formatKeyValueLines(server.headers, ': '),
    enabled: server.enabled,
    agents: server.agents,
    importedFrom: server.importedFrom,
  };
}

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/** 解析用户粘贴的单条或包含 mcpServers 的 JSON 配置片段。 */
export function parsePastedMcpSnippet(
  raw: string,
  currentForm: McpFormState,
): Partial<McpFormState> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // 兼容仅粘贴 `"github": { "command": ... }` 的外层缺括号片段
    try {
      parsed = JSON.parse(`{${raw.trim().replace(/,\s*$/u, '')}}`);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;

  let inferredName = currentForm.name;
  let spec: Record<string, unknown> = parsed;

  if (isRecord(parsed.mcpServers)) {
    const first = Object.entries(parsed.mcpServers)[0];
    if (!first || !isRecord(first[1])) return undefined;
    inferredName = first[0];
    spec = first[1];
  } else if (!('command' in parsed) && !('url' in parsed) && !('serverUrl' in parsed)) {
    const entries = Object.entries(parsed);
    if (entries.length === 1 && isRecord(entries[0]![1])) {
      inferredName = entries[0]![0];
      spec = entries[0]![1];
    }
  }

  const rawType = typeof spec.type === 'string' ? spec.type.toLowerCase() : '';
  const url =
    typeof spec.url === 'string'
      ? spec.url.trim()
      : typeof spec.serverUrl === 'string'
        ? spec.serverUrl.trim()
        : '';
  const command = typeof spec.command === 'string' ? spec.command.trim() : '';

  if (url) {
    const transport: McpTransport = rawType === 'sse' ? 'sse' : 'http';
    const headers: Record<string, string> = {};
    if (isRecord(spec.headers)) {
      for (const [k, v] of Object.entries(spec.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return {
      ...(inferredName ? { name: inferredName } : {}),
      transport,
      url,
      headersText: formatKeyValueLines(headers, ': '),
    };
  }

  if (command || Array.isArray(spec.command)) {
    const cmdParts = Array.isArray(spec.command)
      ? spec.command.filter((x): x is string => typeof x === 'string')
      : [command];
    const extraArgs = Array.isArray(spec.args) ? spec.args.filter((x): x is string => typeof x === 'string') : [];
    const primaryCmd = cmdParts[0] ?? '';
    const mergedArgs = [...cmdParts.slice(1), ...extraArgs];
    const env: Record<string, string> = {};
    const envObj = isRecord(spec.env) ? spec.env : isRecord(spec.environment) ? spec.environment : undefined;
    if (envObj) {
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          env[k] = String(v);
        }
      }
    }
    return {
      ...(inferredName ? { name: inferredName } : {}),
      transport: 'stdio',
      command: primaryCmd,
      argsText: formatArgs(mergedArgs),
      envText: formatKeyValueLines(env, '='),
    };
  }

  return undefined;
}

export function serverSummary(server: {
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}): string {
  if (server.transport === 'stdio') {
    return [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return server.url ?? '';
}

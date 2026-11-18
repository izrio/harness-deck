/**
 * Pi Coding Agent（`pi --mode rpc`）本地会话扫描与 JSONL 解析：
 * Pi 默认将会话树保存在 `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<id>.jsonl`。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface PiDiskSession {
  readonly id: string;
  readonly sessionPath: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly title?: string;
}

const MAX_TITLE_CHARS = 80;
const MAX_SCAN_DIRS = 40;
const MAX_SESSIONS_PER_DIR = 80;

export function resolvePiAgentDir(env?: Readonly<Record<string, string | undefined>>): string {
  const custom = env?.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (custom) return resolve(custom);
  const home = env?.HOME ?? env?.USERPROFILE ?? homedir();
  return join(home, '.pi', 'agent');
}

/** 扫描当前工作区与其他最近项目的 Pi 历史 `.jsonl` 会话文件。 */
export async function scanPiSessions(
  workspacePath: string,
  piAgentDir = resolvePiAgentDir(),
): Promise<PiDiskSession[]> {
  const defaultAgentDir = join(homedir(), '.pi', 'agent');
  const roots = [
    join(piAgentDir, 'sessions'),
    ...(resolve(piAgentDir) !== resolve(defaultAgentDir) ? [join(defaultAgentDir, 'sessions')] : []),
  ];

  const byId = new Map<string, PiDiskSession>();
  const normWs = resolve(workspacePath);
  const encodedHint = normWs.replace(/^[/\\]+/u, '').replace(/[^a-zA-Z0-9._-]+/gu, '-');

  for (const sessionsRoot of roots) {
    const dirEntries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
    const subdirs = dirEntries.filter((d) => d.isDirectory());

    const prioritized = [
      ...subdirs.filter((d) => d.name.includes(encodedHint)),
      ...subdirs.filter((d) => !d.name.includes(encodedHint)),
    ].slice(0, MAX_SCAN_DIRS);

    for (const sub of prioritized) {
      const absDir = join(sessionsRoot, sub.name);
      const files = await readdir(absDir, { withFileTypes: true }).catch(() => []);
      const jsonlFiles = files.filter((f) => f.isFile() && f.name.endsWith('.jsonl'));

      const withStats = await Promise.all(
        jsonlFiles.map(async (f) => {
          const fp = join(absDir, f.name);
          const st = await stat(fp).catch(() => undefined);
          return st ? { name: f.name, filePath: fp, mtimeMs: st.mtimeMs, size: st.size } : undefined;
        }),
      );

      const sorted = withStats
        .filter((x): x is NonNullable<typeof x> => x !== undefined && x.size > 0)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_SESSIONS_PER_DIR);

      for (const entry of sorted) {
        const summary = await readPiSessionSummary(entry.filePath);
        if (!summary || byId.has(summary.id)) continue;
        byId.set(summary.id, {
          id: summary.id,
          sessionPath: entry.filePath,
          cwd: summary.cwd,
          updatedAt: Math.round(entry.mtimeMs),
          ...(summary.title ? { title: summary.title } : {}),
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 从磁盘 `.jsonl` 会话文件解析线性消息列表（当 RPC 进程忙于另一会话流式生成时直接预览历史标签页）。 */
export async function readPiSessionMessagesFromDisk(sessionPath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(sessionPath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  interface NodeEntry {
    readonly id?: string;
    readonly parentId?: string | null;
    readonly type?: string;
    readonly message?: Record<string, unknown>;
  }

  const nodes: NodeEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as NodeEntry;
      if (obj && typeof obj === 'object' && obj.type !== 'session') {
        nodes.push(obj);
      }
    } catch {
      // 忽略残行
    }
  }
  if (nodes.length === 0) return [];

  // 若节点带 id / parentId，沿最后一个节点的父链回溯得到当前活跃分支；否则按顺序提取 message
  const byId = new Map<string, NodeEntry>();
  for (const n of nodes) {
    if (typeof n.id === 'string' && n.id) byId.set(n.id, n);
  }
  const last = nodes[nodes.length - 1];
  if (last?.id && byId.size > 0) {
    const chain: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    let cur: NodeEntry | undefined = last;
    while (cur && cur.id && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (cur.type === 'message' && cur.message) {
        chain.push(cur.message);
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain.reverse();
  }

  return nodes.flatMap((n) => (n.type === 'message' && n.message ? [n.message] : []));
}

async function readPiSessionSummary(
  filePath: string,
): Promise<{ readonly id: string; readonly cwd: string; readonly title?: string } | undefined> {
  const content = await readFile(filePath, 'utf8').catch(() => '');
  if (!content.trim()) return undefined;

  const lines = content.split('\n');
  let id: string | undefined;
  let cwd: string | undefined;
  let explicitName: string | undefined;
  let firstPrompt: string | undefined;
  let hasMessages = false;

  const headLimit = Math.min(lines.length, 50);
  for (let i = 0; i < headLimit; i++) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      if (typeof rec.id === 'string' && rec.id.trim()) id = rec.id.trim();
      if (typeof rec.cwd === 'string' && rec.cwd.trim()) cwd = resolve(rec.cwd.trim());
    } else if (rec.type === 'session_info' && typeof rec.name === 'string' && rec.name.trim()) {
      explicitName = rec.name.trim();
    } else if (rec.type === 'message' && rec.message && typeof rec.message === 'object') {
      const msg = rec.message as Record<string, unknown>;
      hasMessages = true;
      if (!firstPrompt && msg.role === 'user') {
        firstPrompt = extractPiUserText(msg.content);
      }
    }
  }

  if (lines.length > headLimit) {
    for (let i = Math.max(headLimit, lines.length - 15); i < lines.length; i++) {
      const trimmed = lines[i]?.trim();
      if (!trimmed || !trimmed.includes('session_info')) continue;
      try {
        const rec = JSON.parse(trimmed) as Record<string, unknown>;
        if (rec.type === 'session_info' && typeof rec.name === 'string' && rec.name.trim()) {
          explicitName = rec.name.trim();
        }
      } catch {
        // ignore
      }
    }
  }

  if (!cwd || (!hasMessages && !explicitName)) return undefined;
  const fallbackId = basename(filePath, '.jsonl');
  const rawTitle = explicitName ?? firstPrompt;
  const title = rawTitle ? rawTitle.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS) : undefined;
  return {
    id: id ?? fallbackId,
    cwd,
    ...(title ? { title } : {}),
  };
}

function extractPiUserText(content: unknown): string | undefined {
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = (content as Record<string, unknown>[])
      .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  const cleaned = raw
    .replace(/<harness-deck-context>[\s\S]*?<\/harness-deck-context>/gu, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gu, '')
    .trim();
  return cleaned || undefined;
}

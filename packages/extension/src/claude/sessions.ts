/**
 * Claude Code 本地历史会话扫描与读取：
 * Claude Code 将会话以 JSONL 保存在 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface ClaudeDiskSession {
  readonly id: string;
  readonly filePath: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly title?: string;
}

const MAX_TITLE_CHARS = 80;
const MAX_SCAN_DIRS = 40;
const MAX_SESSIONS_PER_DIR = 80;

/** Claude Code 将工作区绝对路径中的非字母数字字符替换为 `-` 作为项目目录名。 */
export function encodeClaudeProjectDir(workspacePath: string): string {
  return resolve(workspacePath).replace(/[^a-zA-Z0-9]/gu, '-');
}

export function resolveClaudeConfigDir(env?: Readonly<Record<string, string | undefined>>): string {
  const custom = (env ? env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR)?.trim();
  if (custom) return resolve(custom);
  const home = env?.HOME ?? env?.USERPROFILE ?? homedir();
  return join(home, '.claude');
}

/** 扫描当前工作区及最近项目的 Claude Code 历史会话。 */
export async function scanClaudeSessions(
  workspacePath: string,
  claudeConfigDir = resolveClaudeConfigDir(),
  extraProjectPaths: readonly string[] = [],
): Promise<ClaudeDiskSession[]> {
  const projectsRoot = join(claudeConfigDir, 'projects');
  const encodedCurrent = encodeClaudeProjectDir(workspacePath);
  const priorityFallback = new Map<string, string>([[encodedCurrent, resolve(workspacePath)]]);
  for (const extra of extraProjectPaths) {
    const trimmed = extra.trim();
    if (!trimmed) continue;
    const encoded = encodeClaudeProjectDir(trimmed);
    if (!priorityFallback.has(encoded)) {
      priorityFallback.set(encoded, resolve(trimmed));
    }
  }

  const dirEntries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const subdirs = dirEntries.filter((d) => d.isDirectory());

  // 当前工作区及已知最近项目优先，其余项目目录按最近修改时间排序后再截取（供跨项目会话面板展示）
  const priorityDirs: string[] = [];
  if (subdirs.some((d) => d.name === encodedCurrent)) {
    priorityDirs.push(encodedCurrent);
  }
  for (const d of subdirs) {
    if (d.name !== encodedCurrent && priorityFallback.has(d.name)) {
      priorityDirs.push(d.name);
    }
  }
  const remaining = subdirs.filter((d) => !priorityFallback.has(d.name));
  const remainingWithStats = await Promise.all(
    remaining.map(async (d) => {
      const st = await stat(join(projectsRoot, d.name)).catch(() => undefined);
      return { name: d.name, mtimeMs: st?.mtimeMs ?? 0 };
    }),
  );
  remainingWithStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const orderedDirs = [
    ...priorityDirs,
    ...remainingWithStats.map((d) => d.name),
  ].slice(0, Math.max(MAX_SCAN_DIRS, priorityDirs.length));

  const results: ClaudeDiskSession[] = [];
  for (const dirName of orderedDirs) {
    const absDir = join(projectsRoot, dirName);
    const files = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    const jsonlFiles = files.filter((f) => f.isFile() && f.name.endsWith('.jsonl') && !f.name.startsWith('agent-'));

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

    const fallbackCwd = priorityFallback.get(dirName);
    for (const entry of sorted) {
      const id = basename(entry.name, '.jsonl');
      const meta = await readSessionSummary(entry.filePath, fallbackCwd);
      if (!meta) continue;
      results.push({
        id,
        filePath: entry.filePath,
        cwd: meta.cwd,
        updatedAt: Math.round(entry.mtimeMs),
        ...(meta.title ? { title: meta.title } : {}),
      });
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读取单个 `.jsonl` 会话文件的所有记录（用于打开历史会话回放）。 */
export async function readClaudeSessionEvents(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 忽略写入中断的残行
    }
  }
  return out;
}

/** 根据 sessionId 查找对应的 `.jsonl` 文件路径。 */
export async function findClaudeSessionFile(
  sessionId: string,
  workspacePath: string,
  claudeConfigDir = resolveClaudeConfigDir(),
): Promise<string | undefined> {
  const direct = join(claudeConfigDir, 'projects', encodeClaudeProjectDir(workspacePath), `${sessionId}.jsonl`);
  const directStat = await stat(direct).catch(() => undefined);
  if (directStat?.isFile()) return direct;

  const projectsRoot = join(claudeConfigDir, 'projects');
  const dirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = join(projectsRoot, d.name, `${sessionId}.jsonl`);
    const st = await stat(candidate).catch(() => undefined);
    if (st?.isFile()) return candidate;
  }
  return undefined;
}

async function readSessionSummary(
  filePath: string,
  fallbackCwd?: string,
): Promise<{ readonly cwd: string; readonly title?: string } | undefined> {
  const content = await readFile(filePath, 'utf8').catch(() => '');
  if (!content.trim()) return undefined;

  let cwd = fallbackCwd;
  let customTitle: string | undefined;
  let summaryTitle: string | undefined;
  let firstPrompt: string | undefined;
  let hasConversation = false;

  const lines = content.split('\n');
  const limit = Math.min(lines.length, 60);
  for (let i = 0; i < limit; i++) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd && typeof rec.cwd === 'string' && rec.cwd.trim()) {
      cwd = resolve(rec.cwd.trim());
    }
    if (rec.isSidechain === true) return undefined;

    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
      customTitle = rec.customTitle.trim();
    } else if (rec.type === 'summary' && typeof rec.summary === 'string' && rec.summary.trim()) {
      summaryTitle = rec.summary.trim();
    } else if (rec.type === 'user' && rec.isMeta !== true) {
      const promptText = extractUserPromptTitle(rec.message);
      if (promptText) {
        hasConversation = true;
        if (!firstPrompt) firstPrompt = promptText;
      }
    } else if (rec.type === 'assistant') {
      hasConversation = true;
    }
  }

  // 若末尾被重命名（custom-title 追加在文件尾部），额外扫最后 15 行
  if (!customTitle && lines.length > limit) {
    for (let i = Math.max(limit, lines.length - 15); i < lines.length; i++) {
      const trimmed = lines[i]?.trim();
      if (!trimmed || !trimmed.includes('custom-title')) continue;
      try {
        const rec = JSON.parse(trimmed) as Record<string, unknown>;
        if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
          customTitle = rec.customTitle.trim();
        }
      } catch {
        // ignore
      }
    }
  }

  if (!cwd || (!hasConversation && !summaryTitle && !customTitle)) return undefined;
  const rawTitle = customTitle ?? summaryTitle ?? firstPrompt;
  const title = rawTitle ? rawTitle.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS) : undefined;
  return { cwd, ...(title ? { title } : {}) };
}

function extractUserPromptTitle(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const msg = message as { content?: unknown };
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content as Record<string, unknown>[]) {
      if (part?.type === 'tool_result') return undefined;
      if (part?.type === 'text' && typeof part.text === 'string') {
        text += `${part.text}\n`;
      }
    }
  }
  const cleaned = text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gu, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/gu, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, '')
    .replace(/<harness-deck-context>[\s\S]*?<\/harness-deck-context>/gu, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gu, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/gu, '')
    .trim();
  return cleaned || undefined;
}

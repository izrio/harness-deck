/**
 * CodeBuddy 本地历史会话扫描与读取：
 * CodeBuddy 将会话以 JSONL 保存在 `~/.codebuddy/projects/<encoded-cwd>/<sessionId>.jsonl`。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface CodebuddyDiskSession {
  readonly id: string;
  readonly filePath: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly title?: string;
}

const MAX_TITLE_CHARS = 80;
const MAX_SCAN_DIRS = 40;
const MAX_SESSIONS_PER_DIR = 80;

/**
 * CodeBuddy 将工作区绝对路径编码为项目目录名：
 * 去除前导斜杠并将路径分隔符/冒号替换为 `-`（如 `/tmp/My_Proj.v2` -> `tmp-My_Proj.v2`）。
 */
export function encodeCodebuddyProjectDir(workspacePath: string): string {
  return resolve(workspacePath)
    .replace(/^[\\/]+/u, '')
    .replace(/[\\/:]+/gu, '-')
    .replace(/-+/gu, '-');
}

export function resolveCodebuddyConfigDir(env?: Readonly<Record<string, string | undefined>>): string {
  const custom = env?.CODEBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim();
  if (custom) return resolve(custom);
  const home = env?.HOME ?? env?.USERPROFILE ?? homedir();
  return join(home, '.codebuddy');
}

/** 扫描当前工作区及最近项目的 CodeBuddy 历史会话。 */
export async function scanCodebuddySessions(
  workspacePath: string,
  configDir = resolveCodebuddyConfigDir(),
  extraProjectPaths: readonly string[] = [],
): Promise<CodebuddyDiskSession[]> {
  const projectsRoot = join(configDir, 'projects');
  const encodedCurrent = encodeCodebuddyProjectDir(workspacePath);
  const priorityFallback = new Map<string, string>([[encodedCurrent, resolve(workspacePath)]]);
  for (const extra of extraProjectPaths) {
    const trimmed = extra.trim();
    if (!trimmed) continue;
    const encoded = encodeCodebuddyProjectDir(trimmed);
    if (!priorityFallback.has(encoded)) {
      priorityFallback.set(encoded, resolve(trimmed));
    }
  }

  const dirEntries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const subdirs = dirEntries.filter((d) => d.isDirectory());

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

  const results: CodebuddyDiskSession[] = [];
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
        updatedAt: meta.updatedAt || Math.round(entry.mtimeMs),
        ...(meta.title ? { title: meta.title } : {}),
      });
    }
  }

  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 查找指定会话 id 对应的 JSONL 文件（优先当前工作区，再遍历其它项目目录）。 */
export async function findCodebuddySessionFile(
  sessionId: string,
  workspacePath: string,
  configDir = resolveCodebuddyConfigDir(),
): Promise<string | undefined> {
  const safeName = `${sessionId}.jsonl`;
  const projectsRoot = join(configDir, 'projects');
  const primary = join(projectsRoot, encodeCodebuddyProjectDir(workspacePath), safeName);
  if (await stat(primary).then((s) => s.isFile()).catch(() => false)) {
    return primary;
  }
  const dirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = join(projectsRoot, d.name, safeName);
    if (await stat(candidate).then((s) => s.isFile()).catch(() => false)) {
      return candidate;
    }
  }
  return undefined;
}

/** 读取指定会话 JSONL 文件中的全部合法记录。 */
export async function readCodebuddySessionEvents(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw) return [];
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 跳过残缺行
    }
  }
  return records;
}

async function readSessionSummary(
  filePath: string,
  fallbackCwd?: string,
): Promise<{ readonly cwd: string; readonly title?: string; readonly updatedAt?: number } | undefined> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  if (!raw) return undefined;
  const lines = raw.split('\n');
  let cwd = '';
  let title: string | undefined;
  let customTitle: string | undefined;
  let summaryTitle: string | undefined;
  let updatedAt: number | undefined;
  let hasConversation = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd.trim()) {
      cwd = obj.cwd.trim();
    }
    if (typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp) && obj.timestamp > 0) {
      updatedAt = obj.timestamp;
    } else if (typeof obj.timestamp === 'string') {
      const ts = Date.parse(obj.timestamp);
      if (Number.isFinite(ts) && ts > 0) updatedAt = ts;
    }

    const type = typeof obj.type === 'string' ? obj.type : '';
    if (type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
      customTitle = obj.customTitle.trim();
      continue;
    }
    if (type === 'summary' && typeof obj.summary === 'string' && obj.summary.trim()) {
      summaryTitle = obj.summary.trim();
      continue;
    }

    if (type === 'message') {
      const role = typeof obj.role === 'string' ? obj.role : '';
      const providerData =
        obj.providerData && typeof obj.providerData === 'object'
          ? (obj.providerData as Record<string, unknown>)
          : undefined;
      if (providerData?.isMeta === true || providerData?.skipRun === true) continue;
      if (role === 'user' || role === 'assistant') {
        hasConversation = true;
      }
      if (role === 'user' && !title) {
        const extracted = extractTextContent(obj.content);
        if (extracted) title = cleanTitle(extracted);
      }
      continue;
    }

    if (type === 'function_call' || type === 'assistant') {
      hasConversation = true;
    } else if (type === 'user' && obj.isMeta !== true) {
      hasConversation = true;
      if (!title) {
        const msg = obj.message && typeof obj.message === 'object' ? (obj.message as Record<string, unknown>) : obj;
        const extracted = extractTextContent(msg.content);
        if (extracted) title = cleanTitle(extracted);
      }
    }
  }

  if (!hasConversation) return undefined;
  const resolvedCwd = cwd || fallbackCwd || '';
  if (!resolvedCwd) return undefined;
  const finalTitle = customTitle ?? summaryTitle ?? title;
  return {
    cwd: resolvedCwd,
    ...(finalTitle ? { title: finalTitle.slice(0, MAX_TITLE_CHARS) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Record<string, unknown>[]) {
      if ((block?.type === 'input_text' || block?.type === 'text') && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function cleanTitle(raw: string): string | undefined {
  const cleaned = raw
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gu, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gu, '')
    .replace(/<context>[\s\S]*?<\/context>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_TITLE_CHARS);
}

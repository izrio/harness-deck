/**
 * Agent Skills（SKILL.md）管理服务：
 * - 解析 GitHub 简写、GitHub/GitLab 子目录树 URL、HTTPS/SSH/本地 Git 仓库地址；
 * - 浅克隆仓库并扫描包含 SKILL.md 的技能目录，解析 YAML Frontmatter；
 * - 安全安装到扩展全局存储目录（过滤越界符号链接与 .git），支持启用开关、目标 Agent 限定、同步更新与卸载；
 * - 在 Agent 启动前按后端类型生成运行时挂载目录（兼容 dsh / Pi / CodeBuddy / Claude Code 及通用 ACP 代理）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { DiscoveredGitSkill, InstalledSkillView, SkillImportCandidate } from '@harness-deck/shared';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_SCAN_DEPTH = 6;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target']);

export interface ParsedGitSource {
  readonly repoUrl: string;
  readonly displayRepo: string;
  readonly ref?: string;
  readonly subpath?: string;
}

export interface ParsedSkillMeta {
  readonly name: string;
  readonly description: string;
}

interface StoredSkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly repoUrl: string;
  readonly sourceKind?: 'git' | 'local';
  readonly importedFrom?: string;
  readonly ref?: string;
  readonly subpath?: string;
  readonly commit?: string;
  readonly enabled: boolean;
  readonly agents?: readonly string[];
  readonly installedAt: number;
  readonly updatedAt: number;
}

/** 规范化技能目录标识（仅保留安全文件名字符，防止路径穿越）。 */
export function normalizeSkillId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 80);
  return cleaned || 'skill';
}

/** 清理仓库内相对子路径，拒绝 `..` 越界段。 */
export function normalizeSubpath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\/SKILL\.md$/iu, '');
  if (!trimmed) return undefined;
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.some((seg) => seg === '.' || seg === '..')) {
    throw new Error(`Invalid skill subpath: ${raw}`);
  }
  return segments.join('/');
}

/**
 * 解析用户输入的 Git 仓库来源：
 * - `owner/repo` -> `https://github.com/owner/repo.git`
 * - `https://github.com/owner/repo/tree/<ref>/<subpath>` -> 自动拆分仓库、分支与子路径
 * - `https://gitlab.com/group/repo/-/tree/<ref>/<subpath>` -> 自动拆分
 * - 标准 HTTPS / SSH / file:// / 本地目录路径
 */
export function parseGitSkillSource(
  rawInput: string,
  explicitRef?: string,
  explicitSubpath?: string,
): ParsedGitSource {
  const input = rawInput.trim();
  if (!input) throw new Error('Repository URL is required');
  if (input.startsWith('-')) throw new Error(`Invalid repository URL: ${input}`);
  if (/^ext::/iu.test(input)) throw new Error('Unsupported git remote protocol');

  const cleanExplicitRef = explicitRef?.trim() || undefined;
  if (cleanExplicitRef?.startsWith('-')) {
    throw new Error(`Invalid git ref: ${cleanExplicitRef}`);
  }
  const cleanExplicitSubpath = normalizeSubpath(explicitSubpath);

  // GitHub tree/blob URL: https://github.com/<owner>/<repo>/(tree|blob)/<ref>[/<subpath>]
  const ghMatch = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/(?:tree|blob)\/([^/\s#?]+)(?:\/([^#?]*))?/iu.exec(
    input,
  );
  if (ghMatch) {
    const [, owner, repo, urlRef, urlSubpath] = ghMatch;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const mergedSubpath = cleanExplicitSubpath ?? normalizeSubpath(decodeURIComponent(urlSubpath ?? ''));
    return {
      repoUrl,
      displayRepo: `${owner}/${repo}`,
      ref: cleanExplicitRef ?? decodeURIComponent(urlRef!),
      ...(mergedSubpath ? { subpath: mergedSubpath } : {}),
    };
  }

  // GitLab tree/blob URL: https://gitlab.com/<ns>/<repo>/-/(tree|blob)/<ref>[/<subpath>]
  const glMatch = /^(https?:\/\/[^/\s]+\/[^#?]+?)(?:\.git)?\/-\/(?:tree|blob)\/([^/\s#?]+)(?:\/([^#?]*))?/iu.exec(input);
  if (glMatch) {
    const [, baseRepo, urlRef, urlSubpath] = glMatch;
    const mergedSubpath = cleanExplicitSubpath ?? normalizeSubpath(decodeURIComponent(urlSubpath ?? ''));
    return {
      repoUrl: `${baseRepo}.git`,
      displayRepo: baseRepo!.replace(/^https?:\/\/[^/]+\//iu, ''),
      ref: cleanExplicitRef ?? decodeURIComponent(urlRef!),
      ...(mergedSubpath ? { subpath: mergedSubpath } : {}),
    };
  }

  // GitHub owner/repo 简写（优先检查不是已存在的本地路径）
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input) && !input.startsWith('.') && !existsSync(input)) {
    const cleanRepo = input.replace(/\.git$/iu, '');
    return {
      repoUrl: `https://github.com/${cleanRepo}.git`,
      displayRepo: cleanRepo,
      ...(cleanExplicitRef ? { ref: cleanExplicitRef } : {}),
      ...(cleanExplicitSubpath ? { subpath: cleanExplicitSubpath } : {}),
    };
  }

  // 标准 GitHub 仓库根链接规范化
  const ghRoot = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/iu.exec(input);
  if (ghRoot) {
    const [, owner, repo] = ghRoot;
    return {
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      displayRepo: `${owner}/${repo}`,
      ...(cleanExplicitRef ? { ref: cleanExplicitRef } : {}),
      ...(cleanExplicitSubpath ? { subpath: cleanExplicitSubpath } : {}),
    };
  }

  return {
    repoUrl: input,
    displayRepo: input.replace(/\.git$/iu, ''),
    ...(cleanExplicitRef ? { ref: cleanExplicitRef } : {}),
    ...(cleanExplicitSubpath ? { subpath: cleanExplicitSubpath } : {}),
  };
}

/**
 * 解析 SKILL.md 的 YAML Frontmatter 与正文摘要。
 */
export function parseSkillMarkdown(markdown: string, fallbackName: string): ParsedSkillMeta {
  const normalized = markdown.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  const fields: Record<string, string> = {};
  let body = normalized;

  if (fmMatch) {
    body = normalized.slice(fmMatch[0].length);
    const lines = fmMatch[1]!.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line);
      if (!kv) {
        i++;
        continue;
      }
      const key = kv[1]!;
      const rest = kv[2]!.trim();
      if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
        const folded = rest.startsWith('>');
        const blockLines: string[] = [];
        i++;
        while (i < lines.length && (/^\s+\S/u.test(lines[i]!) || lines[i]!.trim() === '')) {
          blockLines.push(lines[i]!.trim());
          i++;
        }
        fields[key] = (folded ? blockLines.filter(Boolean).join(' ') : blockLines.join('\n')).trim();
        continue;
      }
      fields[key] = unquoteYamlScalar(rest);
      i++;
    }
  }

  const rawName = fields.name || fields.displayName || fallbackName;
  let description = fields.description || fields.whenToUse || '';
  if (!description) {
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('```')) continue;
      description = line.slice(0, 240);
      break;
    }
  }

  return {
    name: rawName.trim() || fallbackName,
    description: description.trim(),
  };
}

function unquoteYamlScalar(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\"/gu, '"').replace(/\\n/gu, ' ').trim();
  }
  return raw.trim();
}

export interface DiscoveredSkillDir extends DiscoveredGitSkill {
  readonly absDir: string;
  readonly skillFileName: string;
}

/**
 * 在克隆下来的仓库目录中查找所有包含 SKILL.md 的技能目录。
 * 命中某个目录的 SKILL.md 后不再递归其内部子目录（避免将技能自带的 examples/ 当成独立技能）。
 */
export async function discoverSkillsInDir(repoRoot: string, subpath?: string): Promise<DiscoveredSkillDir[]> {
  const rootResolved = resolve(repoRoot);
  const startDir = subpath ? resolve(rootResolved, subpath) : rootResolved;
  if (!isSameOrInsideDir(rootResolved, startDir)) {
    throw new Error(`Subpath escapes repository root: ${subpath}`);
  }
  const info = await stat(startDir).catch(() => undefined);
  if (!info || !info.isDirectory()) {
    throw new Error(subpath ? `Subpath not found in repository: ${subpath}` : 'Repository directory not found');
  }

  const found: DiscoveredSkillDir[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillEntry = entries.find((e) => e.isFile() && /^skill\.md$/iu.test(e.name));
    if (skillEntry) {
      const rel = toPosixRel(rootResolved, dir);
      const fallback = rel ? posix.basename(rel) : basename(rootResolved);
      const content = await readFile(join(dir, skillEntry.name), 'utf8');
      const meta = parseSkillMarkdown(content, fallback);
      found.push({
        name: meta.name,
        description: meta.description,
        subpath: rel,
        absDir: dir,
        skillFileName: skillEntry.name,
      });
      return;
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    const subdirs = entries
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of subdirs) {
      await walk(join(dir, sub.name), depth + 1);
    }
  };

  await walk(startDir, 0);
  return found;
}

function skillsInstalledRoot(storageRoot: string): string {
  return join(storageRoot, 'skills', 'installed');
}

function skillsRegistryPath(storageRoot: string): string {
  return join(storageRoot, 'skills', 'registry.json');
}

function toInstalledView(storageRoot: string, rec: StoredSkillRecord): InstalledSkillView {
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    repoUrl: rec.repoUrl,
    ...(rec.sourceKind ? { sourceKind: rec.sourceKind } : {}),
    ...(rec.importedFrom ? { importedFrom: rec.importedFrom } : {}),
    ...(rec.ref ? { ref: rec.ref } : {}),
    ...(rec.subpath ? { subpath: rec.subpath } : {}),
    ...(rec.commit ? { commit: rec.commit } : {}),
    skillMdPath: join(skillsInstalledRoot(storageRoot), rec.id, 'SKILL.md'),
    enabled: rec.enabled,
    ...(rec.agents && rec.agents.length > 0 ? { agents: rec.agents } : {}),
    installedAt: rec.installedAt,
    updatedAt: rec.updatedAt,
  };
}

async function readRegistryRecords(storageRoot: string): Promise<StoredSkillRecord[]> {
  const regFile = skillsRegistryPath(storageRoot);
  const rawText = await readFile(regFile, 'utf8').catch(() => '');
  if (!rawText.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const valid: StoredSkillRecord[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? normalizeSkillId(obj.id) : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const repoUrl = typeof obj.repoUrl === 'string' ? obj.repoUrl.trim() : '';
    if (!id || !name || !repoUrl || seen.has(id)) continue;
    const mdPath = join(skillsInstalledRoot(storageRoot), id, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    seen.add(id);
    const agents = Array.isArray(obj.agents)
      ? obj.agents.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      : undefined;
    valid.push({
      id,
      name,
      description: typeof obj.description === 'string' ? obj.description : '',
      repoUrl,
      ...(obj.sourceKind === 'local' || obj.sourceKind === 'git' ? { sourceKind: obj.sourceKind } : {}),
      ...(typeof obj.importedFrom === 'string' && obj.importedFrom.trim() ? { importedFrom: obj.importedFrom.trim() } : {}),
      ...(typeof obj.ref === 'string' && obj.ref.trim() ? { ref: obj.ref.trim() } : {}),
      ...(typeof obj.subpath === 'string' && obj.subpath.trim() ? { subpath: obj.subpath.trim() } : {}),
      ...(typeof obj.commit === 'string' && obj.commit.trim() ? { commit: obj.commit.trim() } : {}),
      enabled: obj.enabled !== false,
      ...(agents && agents.length > 0 ? { agents } : {}),
      installedAt: typeof obj.installedAt === 'number' ? obj.installedAt : 0,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
    });
  }
  return valid;
}

async function writeRegistryRecords(storageRoot: string, records: readonly StoredSkillRecord[]): Promise<void> {
  const regFile = skillsRegistryPath(storageRoot);
  await mkdir(dirname(regFile), { recursive: true });
  await writeFile(regFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

/** 读取本地已安装的 Agent Skills 列表。 */
export async function loadInstalledSkills(storageRoot: string): Promise<InstalledSkillView[]> {
  const records = await readRegistryRecords(storageRoot);
  return records.map((rec) => toInstalledView(storageRoot, rec));
}

async function cloneGitRepoToTemp(
  source: ParsedGitSource,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly tempRoot: string; readonly repoDir: string; readonly commit?: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hd-skill-git-'));
  const repoDir = join(tempRoot, 'repo');
  const gitEnv = {
    ...process.env,
    ...env,
    GIT_TERMINAL_PROMPT: '0',
  } as NodeJS.ProcessEnv;

  const baseArgs = ['-c', 'protocol.ext.allow=never'];
  try {
    if (source.ref) {
      try {
        await execFileAsync(
          'git',
          [...baseArgs, 'clone', '--depth', '1', '--branch', source.ref, '--', source.repoUrl, repoDir],
          { env: gitEnv, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        );
      } catch {
        // ref 可能是 commit SHA，回退到先浅克隆默认分支再 fetch 指定引用
        await rm(repoDir, { recursive: true, force: true });
        await execFileAsync('git', [...baseArgs, 'clone', '--depth', '1', '--', source.repoUrl, repoDir], {
          env: gitEnv,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        });
        await execFileAsync('git', [...baseArgs, 'fetch', '--depth', '1', 'origin', source.ref], {
          cwd: repoDir,
          env: gitEnv,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        });
        await execFileAsync('git', ['checkout', '--detach', 'FETCH_HEAD'], {
          cwd: repoDir,
          env: gitEnv,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        });
      }
    } else {
      await execFileAsync('git', [...baseArgs, 'clone', '--depth', '1', '--', source.repoUrl, repoDir], {
        env: gitEnv,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      });
    }

    const commitOut = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoDir,
      env: gitEnv,
      timeout: 10_000,
      windowsHide: true,
    }).catch(() => ({ stdout: '' }));
    const commit = String(commitOut.stdout).trim() || undefined;
    return { tempRoot, repoDir, ...(commit ? { commit } : {}) };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** 扫描 Git 仓库中的候选 SKILL.md 列表（不写入本地已安装目录）。 */
export async function scanSkillsFromGit(params: {
  readonly repoUrl: string;
  readonly ref?: string;
  readonly subpath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly repoUrl: string; readonly ref?: string; readonly skills: DiscoveredGitSkill[] }> {
  const source = parseGitSkillSource(params.repoUrl, params.ref, params.subpath);
  const cloned = await cloneGitRepoToTemp(source, params.env);
  try {
    let discovered: DiscoveredSkillDir[];
    try {
      discovered = await discoverSkillsInDir(cloned.repoDir, source.subpath);
    } catch (err) {
      if (!source.subpath) throw err;
      // skills.sh 返回的技能可能位于根目录或自定义子目录（而非固定 skills/<id>）：回退全仓扫描并按技能名/目录名精确匹配
      const targetName = posix.basename(source.subpath).toLowerCase();
      const allInRepo = await discoverSkillsInDir(cloned.repoDir);
      const matched = allInRepo.filter(
        (d) => d.name.toLowerCase() === targetName || posix.basename(d.subpath).toLowerCase() === targetName,
      );
      if (matched.length === 0) throw err;
      discovered = matched;
    }
    return {
      repoUrl: source.repoUrl,
      ...(source.ref ? { ref: source.ref } : {}),
      skills: discovered.map(({ name, description, subpath }) => ({ name, description, subpath })),
    };
  } finally {
    await rm(cloned.tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 从 Git 仓库安装一个或多个 Agent Skills。 */
export async function installSkillsFromGit(params: {
  readonly storageRoot: string;
  readonly repoUrl: string;
  readonly ref?: string;
  readonly subpath?: string;
  readonly selectedSubpaths?: readonly string[];
  readonly agents?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
}): Promise<{ readonly installed: InstalledSkillView[]; readonly all: InstalledSkillView[] }> {
  const source = parseGitSkillSource(params.repoUrl, params.ref, params.subpath);
  const cloned = await cloneGitRepoToTemp(source, params.env);
  try {
    let discovered: DiscoveredSkillDir[];
    try {
      discovered = await discoverSkillsInDir(cloned.repoDir, source.subpath);
    } catch (err) {
      if (!source.subpath) throw err;
      // skills.sh 返回的技能可能位于根目录或自定义子目录（而非固定 skills/<id>）：回退全仓扫描并按技能名/目录名精确匹配
      const targetName = posix.basename(source.subpath).toLowerCase();
      const allInRepo = await discoverSkillsInDir(cloned.repoDir);
      const matched = allInRepo.filter(
        (d) => d.name.toLowerCase() === targetName || posix.basename(d.subpath).toLowerCase() === targetName,
      );
      if (matched.length === 0) throw err;
      discovered = matched;
    }
    const pickedSet = params.selectedSubpaths ? new Set(params.selectedSubpaths) : undefined;
    const toInstall = pickedSet ? discovered.filter((d) => pickedSet.has(d.subpath)) : discovered;
    if (toInstall.length === 0) {
      throw new Error('No SKILL.md found in the specified Git repository');
    }

    const realRepoRoot = await realpath(cloned.repoDir);
    const installBase = skillsInstalledRoot(params.storageRoot);
    await mkdir(installBase, { recursive: true });

    const existing = await readRegistryRecords(params.storageRoot);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const order = existing.map((r) => r.id);
    const timestamp = params.now ?? Date.now();
    const cleanedAgents = params.agents?.map((a) => a.trim()).filter(Boolean);
    const installedRecords: StoredSkillRecord[] = [];

    for (const skill of toInstall) {
      const fallbackDirName = skill.subpath ? posix.basename(skill.subpath) : basename(source.displayRepo);
      const id = normalizeSkillId(skill.name || fallbackDirName);
      const targetDir = join(installBase, id);
      const stagingDir = `${targetDir}.tmp-${timestamp}`;
      await rm(stagingDir, { recursive: true, force: true });
      await copySkillDirectorySafely(skill.absDir, stagingDir, realRepoRoot, skill.skillFileName);
      await rm(targetDir, { recursive: true, force: true });
      await rename(stagingDir, targetDir);

      const prev = byId.get(id);
      const record: StoredSkillRecord = {
        id,
        name: skill.name,
        description: skill.description,
        repoUrl: source.repoUrl,
        ...(source.ref ? { ref: source.ref } : {}),
        ...(skill.subpath ? { subpath: skill.subpath } : {}),
        ...(cloned.commit ? { commit: cloned.commit } : {}),
        enabled: prev ? prev.enabled : true,
        ...(cleanedAgents && cleanedAgents.length > 0
          ? { agents: cleanedAgents }
          : prev?.agents?.length
            ? { agents: prev.agents }
            : {}),
        installedAt: prev?.installedAt ?? timestamp,
        updatedAt: timestamp,
      };
      byId.set(id, record);
      if (!order.includes(id)) order.push(id);
      installedRecords.push(record);
    }

    const nextRecords = order.map((id) => byId.get(id)).filter((r): r is StoredSkillRecord => r !== undefined);
    await writeRegistryRecords(params.storageRoot, nextRecords);
    return {
      installed: installedRecords.map((r) => toInstalledView(params.storageRoot, r)),
      all: nextRecords.map((r) => toInstalledView(params.storageRoot, r)),
    };
  } finally {
    await rm(cloned.tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface ScanAgentSkillsOptions {
  readonly homeDir?: string;
  readonly workspacePath?: string;
  readonly dshHome?: string;
  readonly storageRoot?: string;
  readonly existingIds?: ReadonlySet<string>;
}

interface SkillDirProbe {
  readonly agentId: string;
  readonly agentName: string;
  readonly path: string;
}

/**
 * 扫描本机及当前工作区中各 Agent 约定目录里的 SKILL.md 技能，返回可导入候选列表。
 */
export async function scanAgentSkills(options: ScanAgentSkillsOptions = {}): Promise<{
  readonly items: SkillImportCandidate[];
  readonly scannedSources: string[];
}> {
  const home = options.homeDir ?? homedir();
  const ws = options.workspacePath;
  const dshHome = options.dshHome || process.env.DSH_HOME || join(home, '.dsh');
  const existingIds = options.existingIds ?? new Set<string>();
  const resolvedStorage = options.storageRoot
    ? await realpath(options.storageRoot).catch(() => resolve(options.storageRoot!))
    : undefined;

  const probes: SkillDirProbe[] = [
    ...(ws
      ? [
          { agentId: 'workspace', agentName: 'Workspace (.agents)', path: join(ws, '.agents', 'skills') },
          { agentId: 'claude', agentName: 'Claude Code', path: join(ws, '.claude', 'skills') },
          { agentId: 'codex', agentName: 'Codex', path: join(ws, '.codex', 'skills') },
          { agentId: 'dsh', agentName: 'DeepSeek', path: join(ws, '.dsh', 'skills') },
          { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(ws, '.codebuddy', 'skills') },
          { agentId: 'pi', agentName: 'Pi', path: join(ws, '.pi', 'skills') },
          { agentId: 'pi', agentName: 'Pi', path: join(ws, '.omp', 'skills') },
          { agentId: 'opencode', agentName: 'OpenCode', path: join(ws, '.opencode', 'skills') },
          { agentId: 'cursor', agentName: 'Cursor', path: join(ws, '.cursor', 'skills') },
        ]
      : []),
    { agentId: 'agents', agentName: 'Agents (~/.agents)', path: join(home, '.agents', 'skills') },
    { agentId: 'claude', agentName: 'Claude Code', path: join(home, '.claude', 'skills') },
    { agentId: 'codex', agentName: 'Codex', path: join(home, '.codex', 'skills') },
    { agentId: 'dsh', agentName: 'DeepSeek', path: join(dshHome, 'skills') },
    { agentId: 'codebuddy', agentName: 'CodeBuddy', path: join(home, '.codebuddy', 'skills') },
    { agentId: 'pi', agentName: 'Pi', path: join(home, '.pi', 'agent', 'skills') },
    { agentId: 'pi', agentName: 'Pi', path: join(home, '.omp', 'agent', 'skills') },
    { agentId: 'antigravity', agentName: 'Antigravity', path: join(home, '.gemini', 'antigravity', 'skills') },
    { agentId: 'antigravity', agentName: 'Antigravity', path: join(home, '.gemini', 'antigravity-cli', 'skills') },
    { agentId: 'gemini', agentName: 'Gemini CLI', path: join(home, '.gemini', 'skills') },
    { agentId: 'opencode', agentName: 'OpenCode', path: join(home, '.config', 'opencode', 'skills') },
    { agentId: 'zcode', agentName: 'ZCode', path: join(home, '.zcode', 'skills') },
    { agentId: 'cursor', agentName: 'Cursor', path: join(home, '.cursor', 'skills') },
  ];

  const items: SkillImportCandidate[] = [];
  const scannedSources: string[] = [];
  const seenRealDirs = new Set<string>();

  for (const probe of probes) {
    const dirInfo = await stat(probe.path).catch(() => undefined);
    if (!dirInfo || !dirInfo.isDirectory()) continue;
    const realProbe = await realpath(probe.path).catch(() => resolve(probe.path));
    if (resolvedStorage && isSameOrInsideDir(resolvedStorage, realProbe)) continue;

    const discovered = await discoverSkillsInDir(probe.path).catch(() => []);
    if (discovered.length === 0) continue;
    scannedSources.push(probe.path);

    for (const skill of discovered) {
      const realSkillDir = await realpath(skill.absDir).catch(() => resolve(skill.absDir));
      if (resolvedStorage && isSameOrInsideDir(resolvedStorage, realSkillDir)) continue;
      if (seenRealDirs.has(realSkillDir)) continue;
      seenRealDirs.add(realSkillDir);
      const id = normalizeSkillId(skill.name || basename(realSkillDir));
      items.push({
        key: `${probe.agentId}:${realSkillDir}`,
        name: skill.name,
        description: skill.description,
        sourceDir: realSkillDir,
        sourceAgentId: probe.agentId,
        sourceAgentName: probe.agentName,
        ...(existingIds.has(id) ? { conflict: true } : {}),
      });
    }
  }

  return { items, scannedSources };
}

/** 扫描用户手动选择的本地目录中的 SKILL.md 技能。 */
export async function scanLocalSkillDirectory(
  dirPath: string,
  existingIds: ReadonlySet<string> = new Set<string>(),
): Promise<SkillImportCandidate[]> {
  const realRoot = await realpath(dirPath).catch(() => resolve(dirPath));
  const discovered = await discoverSkillsInDir(realRoot);
  const label = basename(realRoot) || realRoot;
  return discovered.map((skill) => {
    const absDir = resolve(skill.absDir);
    const id = normalizeSkillId(skill.name || basename(absDir));
    return {
      key: `local:${absDir}`,
      name: skill.name,
      description: skill.description,
      sourceDir: absDir,
      sourceAgentId: 'local',
      sourceAgentName: label,
      ...(existingIds.has(id) ? { conflict: true } : {}),
    };
  });
}

/** 将一个或多个本地技能目录（含 SKILL.md）安全导入到扩展存储目录。 */
export async function importLocalSkills(params: {
  readonly storageRoot: string;
  readonly skills: readonly { readonly sourceDir: string; readonly importedFrom?: string }[];
  readonly agents?: readonly string[];
  readonly now?: number;
}): Promise<{ readonly installed: InstalledSkillView[]; readonly all: InstalledSkillView[] }> {
  if (params.skills.length === 0) {
    throw new Error('No local skills selected');
  }

  const installBase = skillsInstalledRoot(params.storageRoot);
  await mkdir(installBase, { recursive: true });

  const existing = await readRegistryRecords(params.storageRoot);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const order = existing.map((r) => r.id);
  const timestamp = params.now ?? Date.now();
  const cleanedAgents = params.agents?.map((a) => a.trim()).filter(Boolean);
  const installedRecords: StoredSkillRecord[] = [];

  for (const item of params.skills) {
    const realSourceDir = await realpath(item.sourceDir).catch(() => resolve(item.sourceDir));
    const discovered = await discoverSkillsInDir(realSourceDir);
    const direct = discovered.find((d) => resolve(d.absDir) === realSourceDir) ?? discovered[0];
    if (!direct) {
      throw new Error(`No SKILL.md found in ${item.sourceDir}`);
    }

    const realSkillDir = await realpath(direct.absDir).catch(() => resolve(direct.absDir));
    const id = normalizeSkillId(direct.name || basename(realSkillDir));
    const targetDir = join(installBase, id);
    const stagingDir = `${targetDir}.tmp-${timestamp}`;
    await rm(stagingDir, { recursive: true, force: true });
    await copySkillDirectorySafely(realSkillDir, stagingDir, realSkillDir, direct.skillFileName);
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);

    const prev = byId.get(id);
    const importedFrom = item.importedFrom?.trim() || prev?.importedFrom;
    const record: StoredSkillRecord = {
      id,
      name: direct.name,
      description: direct.description,
      repoUrl: realSkillDir,
      sourceKind: 'local',
      ...(importedFrom ? { importedFrom } : {}),
      enabled: prev ? prev.enabled : true,
      ...(cleanedAgents && cleanedAgents.length > 0
        ? { agents: cleanedAgents }
        : prev?.agents?.length
          ? { agents: prev.agents }
          : {}),
      installedAt: prev?.installedAt ?? timestamp,
      updatedAt: timestamp,
    };
    byId.set(id, record);
    if (!order.includes(id)) order.push(id);
    installedRecords.push(record);
  }

  const nextRecords = order.map((id) => byId.get(id)).filter((r): r is StoredSkillRecord => r !== undefined);
  await writeRegistryRecords(params.storageRoot, nextRecords);
  return {
    installed: installedRecords.map((r) => toInstalledView(params.storageRoot, r)),
    all: nextRecords.map((r) => toInstalledView(params.storageRoot, r)),
  };
}

/** 从记录的源 Git 仓库或本地目录重新同步并更新单个已安装 Skill。 */
export async function syncInstalledSkill(params: {
  readonly storageRoot: string;
  readonly id: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
}): Promise<InstalledSkillView[]> {
  const targetId = normalizeSkillId(params.id);
  const records = await readRegistryRecords(params.storageRoot);
  const existing = records.find((r) => r.id === targetId);
  if (!existing) throw new Error(`Skill not found: ${params.id}`);

  if (existing.sourceKind === 'local') {
    const realSourceDir = await realpath(existing.repoUrl).catch(() => undefined);
    if (!realSourceDir) throw new Error(`Local skill directory not found: ${existing.repoUrl}`);
    const discovered = await discoverSkillsInDir(realSourceDir);
    const matched = discovered.find((d) => resolve(d.absDir) === realSourceDir) ?? discovered[0];
    if (!matched) throw new Error(`SKILL.md no longer found in ${existing.repoUrl}`);

    const installBase = skillsInstalledRoot(params.storageRoot);
    const targetDir = join(installBase, targetId);
    const timestamp = params.now ?? Date.now();
    const stagingDir = `${targetDir}.tmp-${timestamp}`;
    await rm(stagingDir, { recursive: true, force: true });
    await copySkillDirectorySafely(matched.absDir, stagingDir, realSourceDir, matched.skillFileName);
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);

    const updated = records.map((rec) =>
      rec.id === targetId
        ? {
            ...rec,
            name: matched.name,
            description: matched.description,
            updatedAt: timestamp,
          }
        : rec,
    );
    await writeRegistryRecords(params.storageRoot, updated);
    return updated.map((r) => toInstalledView(params.storageRoot, r));
  }

  const source = parseGitSkillSource(existing.repoUrl, existing.ref, existing.subpath);
  const cloned = await cloneGitRepoToTemp(source, params.env);
  try {
    let discovered: DiscoveredSkillDir[];
    try {
      discovered = await discoverSkillsInDir(cloned.repoDir, source.subpath);
    } catch (err) {
      if (!source.subpath) throw err;
      // skills.sh 返回的技能可能位于根目录或自定义子目录（而非固定 skills/<id>）：回退全仓扫描并按技能名/目录名精确匹配
      const targetName = posix.basename(source.subpath).toLowerCase();
      const allInRepo = await discoverSkillsInDir(cloned.repoDir);
      const matched = allInRepo.filter(
        (d) => d.name.toLowerCase() === targetName || posix.basename(d.subpath).toLowerCase() === targetName,
      );
      if (matched.length === 0) throw err;
      discovered = matched;
    }
    const matched =
      discovered.find((d) => d.subpath === (existing.subpath ?? '')) ??
      discovered.find((d) => normalizeSkillId(d.name) === targetId) ??
      discovered[0];
    if (!matched) throw new Error(`SKILL.md no longer found in ${existing.repoUrl}`);

    const realRepoRoot = await realpath(cloned.repoDir);
    const installBase = skillsInstalledRoot(params.storageRoot);
    const targetDir = join(installBase, targetId);
    const timestamp = params.now ?? Date.now();
    const stagingDir = `${targetDir}.tmp-${timestamp}`;
    await rm(stagingDir, { recursive: true, force: true });
    await copySkillDirectorySafely(matched.absDir, stagingDir, realRepoRoot, matched.skillFileName);
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);

    const updated = records.map((rec) =>
      rec.id === targetId
        ? {
            ...rec,
            name: matched.name,
            description: matched.description,
            ...(cloned.commit ? { commit: cloned.commit } : {}),
            updatedAt: timestamp,
          }
        : rec,
    );
    await writeRegistryRecords(params.storageRoot, updated);
    return updated.map((r) => toInstalledView(params.storageRoot, r));
  } finally {
    await rm(cloned.tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 更新某个已安装 Skill 的启用状态或目标 Agent 范围。 */
export async function updateSkillEntry(params: {
  readonly storageRoot: string;
  readonly id: string;
  readonly enabled?: boolean;
  readonly agents?: readonly string[] | null;
}): Promise<InstalledSkillView[]> {
  const targetId = normalizeSkillId(params.id);
  const records = await readRegistryRecords(params.storageRoot);
  const updated = records.map((rec) => {
    if (rec.id !== targetId) return rec;
    const nextAgents =
      params.agents === undefined
        ? rec.agents
        : params.agents === null
          ? undefined
          : params.agents.map((a) => a.trim()).filter(Boolean);
    const { agents: _prevAgents, ...rest } = rec;
    return {
      ...rest,
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(nextAgents && nextAgents.length > 0 ? { agents: nextAgents } : {}),
    };
  });
  await writeRegistryRecords(params.storageRoot, updated);
  return updated.map((r) => toInstalledView(params.storageRoot, r));
}

/** 卸载并删除本地已安装的 Skill。 */
export async function deleteInstalledSkill(storageRoot: string, id: string): Promise<InstalledSkillView[]> {
  const targetId = normalizeSkillId(id);
  const records = await readRegistryRecords(storageRoot);
  const next = records.filter((rec) => rec.id !== targetId);
  await writeRegistryRecords(storageRoot, next);
  await rm(join(skillsInstalledRoot(storageRoot), targetId), { recursive: true, force: true }).catch(() => undefined);
  return next.map((r) => toInstalledView(storageRoot, r));
}

/** 筛选对指定 Agent 生效的已启用技能（兼容旧配置中指定的 `oh-my-pi`）。 */
export function skillsForBackend(skills: readonly InstalledSkillView[], backendId: string): InstalledSkillView[] {
  return skills.filter(
    (s) =>
      s.enabled &&
      (!s.agents ||
        s.agents.length === 0 ||
        s.agents.includes(backendId) ||
        (backendId === 'pi' && s.agents.includes('oh-my-pi'))),
  );
}

export interface StagedBackendSkills {
  readonly bundleDir: string;
  readonly skillsDir: string;
  readonly skillDirs: readonly string[];
  readonly skills: readonly InstalledSkillView[];
}

/**
 * 为目标 Agent 构建干净的运行时技能挂载目录：
 * - `<bundleDir>/skills/<id>` -> dsh (`customSkillDirs`) 与 Pi (`--skill`) 使用
 * - `<bundleDir>/.claude/skills/<id>` -> Claude Code (`additionalDirectories`) 使用
 * - `<bundleDir>/.codebuddy/skills/<id>` -> CodeBuddy (`--add-dir`) 使用
 * - `<bundleDir>/.agents/skills/<id>` -> 通用 Agent Skills 约定目录
 */
export async function stageSkillsForBackend(
  storageRoot: string,
  backendId: string,
  allSkills: readonly InstalledSkillView[],
): Promise<StagedBackendSkills> {
  const active = skillsForBackend(allSkills, backendId);
  const safeId = normalizeSkillId(backendId);
  const bundleDir = join(storageRoot, 'runtime', 'bundles', safeId);
  const skillsDir = join(bundleDir, 'skills');
  await rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);

  if (active.length === 0) {
    return { bundleDir, skillsDir, skillDirs: [], skills: [] };
  }

  const claudeSkillsDir = join(bundleDir, '.claude', 'skills');
  const codebuddySkillsDir = join(bundleDir, '.codebuddy', 'skills');
  const agentsSkillsDir = join(bundleDir, '.agents', 'skills');
  await Promise.all([
    mkdir(skillsDir, { recursive: true }),
    mkdir(claudeSkillsDir, { recursive: true }),
    mkdir(codebuddySkillsDir, { recursive: true }),
    mkdir(agentsSkillsDir, { recursive: true }),
  ]);

  const skillDirs: string[] = [];
  for (const skill of active) {
    const srcDir = dirname(skill.skillMdPath);
    if (!existsSync(skill.skillMdPath)) continue;
    const primaryTarget = join(skillsDir, skill.id);
    await linkOrCopyDir(srcDir, primaryTarget);
    await Promise.all([
      linkOrCopyDir(srcDir, join(claudeSkillsDir, skill.id)),
      linkOrCopyDir(srcDir, join(codebuddySkillsDir, skill.id)),
      linkOrCopyDir(srcDir, join(agentsSkillsDir, skill.id)),
    ]);
    skillDirs.push(primaryTarget);
  }

  return { bundleDir, skillsDir, skillDirs, skills: active };
}

/** 为不具备原生目录挂载入口的自定义 ACP 代理生成标准 `<available_skills>` 摘要索引。 */
export function formatSkillsPromptCatalog(skills: readonly InstalledSkillView[]): string {
  if (skills.length === 0) return '';
  const entries = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.skillMdPath)}</location>\n  </skill>`,
    )
    .join('\n');
  return `<available_skills>\nWhen a task matches one of the following Agent Skills, read its SKILL.md file at <location> before proceeding:\n${entries}\n</available_skills>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

async function linkOrCopyDir(srcDir: string, dstDir: string): Promise<void> {
  try {
    await symlink(srcDir, dstDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    await cp(srcDir, dstDir, { recursive: true });
  }
}

async function copySkillDirectorySafely(
  srcDir: string,
  dstDir: string,
  realRepoRoot: string,
  skillFileName: string,
): Promise<void> {
  await mkdir(dstDir, { recursive: true });
  const copyWalk = async (currentSrc: string, currentDst: string): Promise<void> => {
    const entries = await readdir(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const srcPath = join(currentSrc, entry.name);
      const dstName = currentSrc === srcDir && entry.name === skillFileName ? 'SKILL.md' : entry.name;
      const dstPath = join(currentDst, dstName);
      const linkStat = await lstat(srcPath);
      if (linkStat.isSymbolicLink()) {
        const resolved = await realpath(srcPath).catch(() => undefined);
        if (!resolved || !isSameOrInsideDir(realRepoRoot, resolved)) {
          continue;
        }
        const targetInfo = await stat(resolved);
        if (targetInfo.isDirectory()) {
          await cp(resolved, dstPath, { recursive: true });
        } else if (targetInfo.isFile()) {
          await cp(resolved, dstPath);
        }
        continue;
      }
      if (linkStat.isDirectory()) {
        await mkdir(dstPath, { recursive: true });
        await copyWalk(srcPath, dstPath);
      } else if (linkStat.isFile()) {
        await cp(srcPath, dstPath);
      }
    }
  };
  await copyWalk(srcDir, dstDir);
}

function isSameOrInsideDir(root: string, target: string): boolean {
  const normRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const rel = relative(normRoot, normTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosixRel(root: string, target: string): string {
  const rel = relative(root, target);
  if (!rel) return '';
  return rel.split(sep).join('/');
}

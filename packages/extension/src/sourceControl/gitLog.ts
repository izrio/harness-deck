/**
 * Git 提交日志与提交详情查询（借鉴 IntelliJ IDEA / vs-idea-gittool 的 Git Log 与提交文件检查）：
 * - 支持全分支 DAG 图谱数据（含父提交列表与分支/标签装饰）
 * - 支持按关键字（提交信息 / 作者 / 哈希 / 分支名）、指定分支过滤及分页加载
 * - 支持查询单次提交完整正文与改动文件列表（含增删行统计与重命名旧路径）
 */
import type {
  SourceControlCommitDetailView,
  SourceControlCommitFileView,
  SourceControlCommitView,
  SourceControlFileStatus,
  SourceControlRefBadge,
} from '@harness-deck/shared';
import { parseNumstatZ, runGit } from './gitStatus.ts';

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

const DEFAULT_REMOTE_PREFIXES = new Set(['origin', 'upstream']);

export function parseRefDecorations(
  raw: string,
  remoteNames: ReadonlySet<string> = DEFAULT_REMOTE_PREFIXES,
): SourceControlRefBadge[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const badges: SourceControlRefBadge[] = [];
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const headArrow = /^HEAD\s*->\s*(.+)$/u.exec(token);
    if (headArrow) {
      badges.push({ name: 'HEAD', kind: 'head' });
      const rawBranch = headArrow[1]?.trim() ?? '';
      const branch = rawBranch.startsWith('refs/heads/') ? rawBranch.slice('refs/heads/'.length) : rawBranch;
      if (branch) badges.push({ name: branch, kind: 'local' });
      continue;
    }
    if (token === 'HEAD') {
      badges.push({ name: 'HEAD', kind: 'head' });
      continue;
    }
    const tagMatch = /^tag:\s*(.+)$/u.exec(token);
    if (tagMatch) {
      const rawTag = tagMatch[1]?.trim() ?? '';
      const tag = rawTag.startsWith('refs/tags/') ? rawTag.slice('refs/tags/'.length) : rawTag;
      if (tag) badges.push({ name: tag, kind: 'tag' });
      continue;
    }
    if (token === 'refs/stash') {
      continue;
    }
    if (token.startsWith('refs/heads/')) {
      const name = token.slice('refs/heads/'.length);
      if (name) badges.push({ name, kind: 'local' });
      continue;
    }
    if (token.startsWith('refs/remotes/')) {
      const name = token.slice('refs/remotes/'.length);
      if (!name || name.endsWith('/HEAD')) continue;
      badges.push({ name, kind: 'remote' });
      continue;
    }
    if (token.includes('/')) {
      if (token.endsWith('/HEAD')) continue;
      const prefix = token.slice(0, token.indexOf('/'));
      badges.push({ name: token, kind: remoteNames.has(prefix) ? 'remote' : 'local' });
    } else {
      badges.push({ name: token, kind: 'local' });
    }
  }
  return badges;
}

/** 解析自定义分隔符的 `git log` 输出。 */
export function parseGitLogOutput(stdout: string): SourceControlCommitView[] {
  const commits: SourceControlCommitView[] = [];
  for (const rawRecord of stdout.split(RECORD_SEP)) {
    const record = rawRecord.replace(/^\r?\n/u, '');
    if (!record) continue;
    const fields = record.split(FIELD_SEP);
    if (fields.length < 7) continue;
    const hash = fields[0]?.trim() ?? '';
    const shortHash = fields[1]?.trim() ?? hash.slice(0, 7);
    if (!hash) continue;
    const parentsRaw = fields[2]?.trim() ?? '';
    const parents = parentsRaw ? parentsRaw.split(/\s+/u).filter(Boolean) : [];
    const author = fields[3]?.trim() ?? '';
    const email = fields[4]?.trim() || undefined;
    const timestampSec = Number.parseInt(fields[5]?.trim() ?? '0', 10);
    const date = Number.isFinite(timestampSec) && timestampSec > 0 ? timestampSec * 1000 : 0;
    const subject = fields[6]?.trim() ?? '';
    const refs = parseRefDecorations(fields[7] ?? '');
    commits.push({
      hash,
      shortHash,
      parents,
      author,
      ...(email ? { email } : {}),
      date,
      subject,
      refs,
    });
  }
  return commits;
}

export function mapGitStatusCode(code: string): SourceControlFileStatus {
  const letter = code.charAt(0).toUpperCase();
  switch (letter) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

/** 解析 `git diff-tree / git show --name-status -z` 的输出。 */
export function parseNameStatusZ(
  stdout: string,
): Array<{ readonly path: string; readonly oldPath?: string; readonly status: SourceControlFileStatus }> {
  const tokens = stdout.split('\0');
  const out: Array<{ readonly path: string; readonly oldPath?: string; readonly status: SourceControlFileStatus }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i]?.trim();
    if (!code) continue;
    const letter = code.charAt(0).toUpperCase();
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (newPath) {
        out.push({ path: newPath, ...(oldPath ? { oldPath } : {}), status: mapGitStatusCode(code) });
      }
      continue;
    }
    const filePath = tokens[i + 1] ?? '';
    i += 1;
    if (filePath) {
      out.push({ path: filePath, status: mapGitStatusCode(code) });
    }
  }
  return out;
}

export async function readGitLog(
  cwd: string,
  options?: {
    readonly query?: string;
    readonly branch?: string;
    readonly limit?: number;
    readonly skip?: number;
  },
): Promise<{ readonly commits: readonly SourceControlCommitView[]; readonly hasMore: boolean }> {
  const limit = Math.min(200, Math.max(1, options?.limit ?? 60));
  const skip = Math.max(0, options?.skip ?? 0);
  const query = options?.query?.trim().toLowerCase() ?? '';
  const branch = options?.branch?.trim() ?? '';

  const format = `%H${FIELD_SEP}%h${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%s${FIELD_SEP}%D${RECORD_SEP}`;
  const refArgs = branch && branch !== '__all__' ? [branch] : ['--all'];

  try {
    if (query) {
      // 通用关键字过滤（同时匹配提交说明、作者、邮箱、哈希与分支/标签名），最多扫描最近 500 条提交保持毫秒级响应
      const raw = await runGit(
        ['log', ...refArgs, '--topo-order', '--decorate=full', '-n', '500', `--format=${format}`],
        cwd,
      );
      const all = parseGitLogOutput(raw).filter((c) => {
        if (c.subject.toLowerCase().includes(query)) return true;
        if (c.author.toLowerCase().includes(query)) return true;
        if (c.email?.toLowerCase().includes(query)) return true;
        if (c.hash.toLowerCase().startsWith(query)) return true;
        return c.refs.some((r) => r.name.toLowerCase().includes(query));
      });
      const slice = all.slice(skip, skip + limit);
      return { commits: slice, hasMore: skip + limit < all.length };
    }

    const raw = await runGit(
      [
        'log',
        ...refArgs,
        '--topo-order',
        '--decorate=full',
        `--skip=${String(skip)}`,
        `-n`,
        String(limit + 1),
        `--format=${format}`,
      ],
      cwd,
    );
    const parsed = parseGitLogOutput(raw);
    const hasMore = parsed.length > limit;
    return { commits: hasMore ? parsed.slice(0, limit) : parsed, hasMore };
  } catch {
    return { commits: [], hasMore: false };
  }
}

export async function readGitCommitDetail(cwd: string, hash: string): Promise<SourceControlCommitDetailView | undefined> {
  const cleanHash = hash.trim();
  if (!/^[0-9a-fA-F]{4,64}$/u.test(cleanHash)) return undefined;

  const metaFormat = `%H${FIELD_SEP}%h${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%s${FIELD_SEP}%b`;
  const [metaRaw, nameStatusRaw, numstatRaw] = await Promise.all([
    runGit(['show', '-s', `--format=${metaFormat}`, cleanHash], cwd),
    runGit(['diff-tree', '--no-commit-id', '--name-status', '-r', '-m', '--first-parent', '--root', '-z', cleanHash], cwd).catch(() => ''),
    runGit(['diff-tree', '--no-commit-id', '--numstat', '-r', '-m', '--first-parent', '--root', '-z', cleanHash], cwd).catch(() => ''),
  ]);

  const fields = metaRaw.split(FIELD_SEP);
  const fullHash = fields[0]?.trim() ?? '';
  if (!fullHash) return undefined;
  const shortHash = fields[1]?.trim() ?? fullHash.slice(0, 7);
  const parentsRaw = fields[2]?.trim() ?? '';
  const parents = parentsRaw ? parentsRaw.split(/\s+/u).filter(Boolean) : [];
  const author = fields[3]?.trim() ?? '';
  const email = fields[4]?.trim() || undefined;
  const timestampSec = Number.parseInt(fields[5]?.trim() ?? '0', 10);
  const date = Number.isFinite(timestampSec) && timestampSec > 0 ? timestampSec * 1000 : 0;
  const subject = fields[6]?.trim() ?? '';
  const body = fields.slice(7).join(FIELD_SEP).trim();

  const stats = parseNumstatZ(numstatRaw);
  const files: SourceControlCommitFileView[] = parseNameStatusZ(nameStatusRaw).map((entry) => {
    const stat = stats.get(entry.path);
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      ...(stat ? { additions: stat.additions, deletions: stat.deletions } : {}),
    };
  });

  return {
    hash: fullHash,
    shortHash,
    parents,
    author,
    ...(email ? { email } : {}),
    date,
    subject,
    body,
    files,
  };
}

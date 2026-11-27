/**
 * Git 工作台共享纯函数：路径拆分、目录树压缩构建、IntelliJ 日期/图谱着色/引用标签合并与 DAG 泳道算法。
 * 不依赖 DOM 或 React，便于单测直接验证。
 */
import type {
  SourceControlBranchView,
  SourceControlCommitView,
  SourceControlFileStatus,
  SourceControlFileView,
  SourceControlRefBadge,
  SourceControlRefKind,
} from '@harness-deck/shared';

/** Halo 语义主题文件状态样式（自动兼容浅/深色模式与全部主题预设）。 */
export const STATUS_STYLE: Record<
  SourceControlFileStatus,
  { readonly letter: string; readonly nameCls: string; readonly badgeCls: string }
> = {
  modified: { letter: 'M', nameCls: 'text-ink', badgeCls: 'bg-accent-tint text-accent-ink' },
  added: { letter: 'A', nameCls: 'text-ink', badgeCls: 'bg-green-tint text-green' },
  deleted: { letter: 'D', nameCls: 'text-ink-3 line-through', badgeCls: 'bg-red-tint text-red' },
  renamed: { letter: 'R', nameCls: 'text-ink', badgeCls: 'bg-accent-tint text-accent-ink' },
  untracked: { letter: 'U', nameCls: 'text-ink', badgeCls: 'bg-orange-tint text-orange' },
  conflicted: { letter: '!', nameCls: 'text-red', badgeCls: 'bg-red-tint text-red' },
};

/** DAG 图谱泳道颜色（全部使用项目语义 CSS 变量，自动适配浅色/深色与主题预设）。 */
export const GRAPH_LANE_COLORS = [
  'var(--brand)',
  'var(--green)',
  'var(--orange)',
  'var(--accent-ink)',
  'var(--red)',
  'var(--ink-2)',
] as const;

export function laneColor(index: number): string {
  return GRAPH_LANE_COLORS[Math.abs(index) % GRAPH_LANE_COLORS.length]!;
}

/** vs-idea-gittool 同款本地日期格式：`2026/3/20, 17:00`。 */
export function formatIdeaDate(epochMs: number | undefined): string {
  if (!epochMs || epochMs <= 0) return '';
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 复刻 IntelliJ LabelPainter（vs-idea-gittool src/webview/log/refs.tsx）：
 * 将指向同一提交的本地分支与对应远程跟踪分支合并为 `origin & main` 双色书签徽标。
 */
export interface GroupedRefLabel {
  readonly text: string;
  readonly kinds: readonly SourceControlRefKind[];
  readonly tip: string;
}

export function groupRefLabels(
  refs: readonly SourceControlRefBadge[],
  currentBranch?: string,
): readonly GroupedRefLabel[] {
  const locals: string[] = [];
  const remotes: string[] = [];
  const tags: string[] = [];
  let hasHead = false;
  for (const r of refs) {
    if (r.kind === 'head') hasHead = true;
    else if (r.kind === 'local') locals.push(r.name);
    else if (r.kind === 'remote') remotes.push(r.name);
    else if (r.kind === 'tag') tags.push(r.name);
  }
  const out: GroupedRefLabel[] = [];
  if (hasHead && !(currentBranch && locals.includes(currentBranch))) {
    out.push({ text: 'HEAD', kinds: ['head'], tip: 'HEAD' });
  }
  const usedRemotes = new Set<string>();
  const sortedLocals = [...locals].sort((a, b) =>
    a === currentBranch ? -1 : b === currentBranch ? 1 : a.localeCompare(b),
  );
  for (const local of sortedLocals) {
    const kind: SourceControlRefKind = local === currentBranch ? 'head' : 'local';
    const tracking = remotes.filter((rem) => {
      const slash = rem.indexOf('/');
      return slash > 0 && rem.slice(slash + 1) === local;
    });
    for (const r of tracking) usedRemotes.add(r);
    if (tracking.length > 0) {
      const remoteNames = tracking.map((r) => r.slice(0, r.indexOf('/')));
      out.push({
        text: `${remoteNames.join(' & ')} & ${local}`,
        kinds: [kind, 'remote'],
        tip: [local, ...tracking].join(', '),
      });
    } else {
      out.push({ text: local, kinds: [kind], tip: local });
    }
  }
  for (const rem of remotes) {
    if (!usedRemotes.has(rem)) {
      out.push({ text: rem, kinds: ['remote'], tip: rem });
    }
  }
  for (const tag of tags) {
    out.push({ text: tag, kinds: ['tag'], tip: tag });
  }
  return out;
}

/** 按 `/` 分组构建分支目录树（对应 IntelliJ Branches 的 Group by Directory）。 */
export interface BranchFolderNode {
  readonly name: string;
  readonly fullPath: string;
  readonly folders: readonly BranchFolderNode[];
  readonly branches: readonly SourceControlBranchView[];
}

export function buildBranchFolderTree(branches: readonly SourceControlBranchView[]): {
  readonly folders: readonly BranchFolderNode[];
  readonly rootBranches: readonly SourceControlBranchView[];
} {
  interface MutableNode {
    name: string;
    fullPath: string;
    folders: Map<string, MutableNode>;
    branches: SourceControlBranchView[];
  }
  const rootFolders = new Map<string, MutableNode>();
  const rootBranches: SourceControlBranchView[] = [];

  for (const b of branches) {
    const slash = b.name.lastIndexOf('/');
    if (slash <= 0) {
      rootBranches.push(b);
      continue;
    }
    const dirParts = b.name.slice(0, slash).split('/').filter(Boolean);
    let map = rootFolders;
    let curPath = '';
    let node: MutableNode | undefined;
    for (const part of dirParts) {
      curPath = curPath ? `${curPath}/${part}` : part;
      let next = map.get(part);
      if (!next) {
        next = { name: part, fullPath: curPath, folders: new Map(), branches: [] };
        map.set(part, next);
      }
      node = next;
      map = next.folders;
    }
    node?.branches.push(b);
  }

  const finalize = (raw: MutableNode): BranchFolderNode => ({
    name: raw.name,
    fullPath: raw.fullPath,
    folders: [...raw.folders.values()].map(finalize).sort((a, b) => a.name.localeCompare(b.name)),
    branches: [...raw.branches].sort((a, b) => a.name.localeCompare(b.name)),
  });

  return {
    folders: [...rootFolders.values()].map(finalize).sort((a, b) => a.name.localeCompare(b.name)),
    rootBranches: [...rootBranches].sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name))),
  };
}

export function splitFilePath(rawPath: string): { readonly normalized: string; readonly name: string; readonly dir: string } {
  const normalized = rawPath.replace(/\\/gu, '/');
  const slash = normalized.lastIndexOf('/');
  return {
    normalized,
    name: slash >= 0 ? normalized.slice(slash + 1) : normalized,
    dir: slash >= 0 ? normalized.slice(0, slash) : '',
  };
}

export interface ChangeDirNode {
  readonly name: string;
  readonly fullPath: string;
  readonly dirs: readonly ChangeDirNode[];
  readonly files: readonly SourceControlFileView[];
  readonly totalFiles: number;
}

interface MutableChangeDirNode {
  name: string;
  fullPath: string;
  readonly dirs: Map<string, MutableChangeDirNode>;
  readonly files: SourceControlFileView[];
}

function finalizeChangeDirNode(raw: MutableChangeDirNode): ChangeDirNode {
  let dirs = [...raw.dirs.values()]
    .map(finalizeChangeDirNode)
    .sort((a, b) => a.name.localeCompare(b.name));
  let files = [...raw.files].sort((a, b) => splitFilePath(a.path).name.localeCompare(splitFilePath(b.path).name));
  let name = raw.name;
  let fullPath = raw.fullPath;

  while (files.length === 0 && dirs.length === 1) {
    const only = dirs[0]!;
    name = `${name}/${only.name}`;
    fullPath = only.fullPath;
    dirs = [...only.dirs];
    files = [...only.files];
  }

  const totalFiles = files.length + dirs.reduce((sum, child) => sum + child.totalFiles, 0);
  return { name, fullPath, dirs, files, totalFiles };
}

export function buildChangeDirTree(files: readonly SourceControlFileView[]): {
  readonly dirs: readonly ChangeDirNode[];
  readonly rootFiles: readonly SourceControlFileView[];
} {
  const rootDirs = new Map<string, MutableChangeDirNode>();
  const rootFiles: SourceControlFileView[] = [];

  for (const file of files) {
    const { dir } = splitFilePath(file.path);
    const segments = dir ? dir.split('/').filter(Boolean) : [];
    if (segments.length === 0) {
      rootFiles.push(file);
      continue;
    }
    let currentMap = rootDirs;
    let currentPath = '';
    let targetNode: MutableChangeDirNode | undefined;
    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      let next = currentMap.get(seg);
      if (!next) {
        next = { name: seg, fullPath: currentPath, dirs: new Map(), files: [] };
        currentMap.set(seg, next);
      }
      targetNode = next;
      currentMap = next.dirs;
    }
    targetNode?.files.push(file);
  }

  const dirs = [...rootDirs.values()]
    .map(finalizeChangeDirNode)
    .sort((a, b) => a.name.localeCompare(b.name));
  rootFiles.sort((a, b) => splitFilePath(a.path).name.localeCompare(splitFilePath(b.path).name));
  return { dirs, rootFiles };
}

export function formatRelativeTime(epochMs: number | undefined, locale: 'zh' | 'en', now = Date.now()): string {
  if (!epochMs || epochMs <= 0) return '';
  const diffSec = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (diffSec < 60) return locale === 'zh' ? '刚刚' : 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return locale === 'zh' ? `${diffMin} 分钟前` : `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return locale === 'zh' ? `${diffHour} 小时前` : `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return locale === 'zh' ? `${diffDay} 天前` : `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return locale === 'zh' ? `${diffMonth} 个月前` : `${diffMonth}mo ago`;
  const diffYear = Math.floor(diffDay / 365);
  return locale === 'zh' ? `${diffYear} 年前` : `${diffYear}y ago`;
}

export interface CommitGraphEdge {
  readonly fromCol: number;
  readonly toCol: number;
  readonly colorIdx: number;
}

export interface CommitGraphRow {
  readonly commit: SourceControlCommitView;
  readonly col: number;
  readonly colorIdx: number;
  readonly isHead: boolean;
  readonly incomingCols: readonly { readonly col: number; readonly colorIdx: number }[];
  readonly outgoingEdges: readonly CommitGraphEdge[];
  readonly passThroughCols: readonly { readonly col: number; readonly colorIdx: number }[];
  readonly laneCount: number;
}

/**
 * 为按拓扑序排列的提交列表分配多分支彩色泳道（IDEA Git Log 风格 DAG 图谱）。
 */
export function computeCommitGraph(commits: readonly SourceControlCommitView[]): {
  readonly rows: readonly CommitGraphRow[];
  readonly maxLanes: number;
} {
  const lanes: Array<{ hash: string; colorIdx: number } | null> = [];
  let nextColor = 0;
  let maxLanes = 1;
  const rows: CommitGraphRow[] = [];

  const allocLane = (hash: string, preferredColor?: number): number => {
    const colorIdx = preferredColor ?? nextColor++;
    const emptyIdx = lanes.indexOf(null);
    if (emptyIdx >= 0) {
      lanes[emptyIdx] = { hash, colorIdx };
      return emptyIdx;
    }
    lanes.push({ hash, colorIdx });
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // 1. 找出所有期待本提交的入边泳道
    const matchedCols: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i]?.hash === commit.hash) matchedCols.push(i);
    }

    let col: number;
    let colorIdx: number;
    if (matchedCols.length > 0) {
      col = matchedCols[0]!;
      colorIdx = lanes[col]!.colorIdx;
    } else {
      col = allocLane(commit.hash);
      colorIdx = lanes[col]!.colorIdx;
    }

    const incomingCols = matchedCols.map((c) => ({ col: c, colorIdx: lanes[c]!.colorIdx }));

    // 记录贯穿本行的其他活跃泳道（既不是当前节点也不汇入当前节点）
    const matchedSet = new Set(matchedCols);
    matchedSet.add(col);
    const passThroughCols: { readonly col: number; readonly colorIdx: number }[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      const slot = lanes[i];
      if (slot && !matchedSet.has(i)) {
        passThroughCols.push({ col: i, colorIdx: slot.colorIdx });
      }
    }

    // 释放所有汇入本提交的重复泳道
    for (const dupCol of matchedCols) {
      lanes[dupCol] = null;
    }
    lanes[col] = null;

    // 2. 为父提交分配出边
    const outgoingEdges: CommitGraphEdge[] = [];
    commit.parents.forEach((parentHash, pIdx) => {
      const existingParentCol = lanes.findIndex((slot) => slot?.hash === parentHash);
      if (existingParentCol >= 0) {
        outgoingEdges.push({
          fromCol: col,
          toCol: existingParentCol,
          colorIdx: pIdx === 0 ? colorIdx : lanes[existingParentCol]!.colorIdx,
        });
      } else if (pIdx === 0) {
        lanes[col] = { hash: parentHash, colorIdx };
        outgoingEdges.push({ fromCol: col, toCol: col, colorIdx });
      } else {
        const branchCol = allocLane(parentHash);
        outgoingEdges.push({ fromCol: col, toCol: branchCol, colorIdx: lanes[branchCol]!.colorIdx });
      }
    });

    // 裁剪尾部连续空泳道，避免宽度无限制膨胀
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    const rowWidth = Math.max(
      col + 1,
      lanes.length,
      ...incomingCols.map((x) => x.col + 1),
      ...outgoingEdges.map((e) => Math.max(e.fromCol, e.toCol) + 1),
      ...passThroughCols.map((p) => p.col + 1),
    );
    if (rowWidth > maxLanes) maxLanes = rowWidth;

    rows.push({
      commit,
      col,
      colorIdx,
      isHead: commit.refs.some((r) => r.kind === 'head'),
      incomingCols,
      outgoingEdges,
      passThroughCols,
      laneCount: rowWidth,
    });
  }

  return { rows, maxLanes };
}

/**
 * Git 工作台 · 历史（Log）子面板（Halo 语义主题样式 + IDEA 风格交互）：
 * - 搜索框 + shadcn Select 分支筛选 + Cherry-Pick / 刷新操作
 * - SVG 多泳道 DAG 提交图谱（使用项目语义主题变量）+ 合并引用徽章（`origin & main`）+ 右键历史操作
 * - 可拖拽调节高度的提交详情面板：变更文件目录树（点击打开 Diff）+ 提交正文与元数据
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SourceControlCommitDetailView,
  SourceControlCommitFileView,
  SourceControlCommitView,
  SourceControlRefKind,
  SourceControlState,
} from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { useView } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  FileTypeIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  RefreshIcon,
  RotateCcwIcon,
  SearchIcon,
  SpinnerIcon,
  TagIcon,
  UndoIcon,
  VscodeFolderIcon,
  VscodeFolderOpenIcon,
} from '../../icons.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/context-menu.tsx';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  buildChangeDirTree,
  computeCommitGraph,
  formatIdeaDate,
  groupRefLabels,
  laneColor,
  splitFilePath,
  STATUS_STYLE,
  type ChangeDirNode,
  type CommitGraphRow,
  type GroupedRefLabel,
} from './gitHelpers.ts';

const LANE_WIDTH = 13;
const ROW_HEIGHT = 28;
const NODE_R = 3.2;
const PAGE_SIZE = 50;

let logReqSeq = 1;
let detailReqSeq = 1;

const REF_BADGE_CLASS: Record<SourceControlRefKind, string> = {
  head: 'bg-brand/15 text-brand',
  local: 'bg-green-tint text-green',
  remote: 'bg-accent-tint text-accent-ink',
  tag: 'bg-field text-ink-2',
};

function SemanticRefBadges({ labels }: { readonly labels: readonly GroupedRefLabel[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-1 overflow-hidden">
      {labels.map((label) => {
        const primaryKind = label.kinds[0] ?? 'local';
        return (
          <span
            key={label.tip}
            title={label.tip}
            className={cn(
              'inline-flex max-w-[132px] items-center gap-1 rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium',
              REF_BADGE_CLASS[primaryKind],
            )}
          >
            {primaryKind === 'tag' ? <TagIcon className="size-2.5 shrink-0" /> : null}
            <span className="truncate">{label.text}</span>
          </span>
        );
      })}
    </span>
  );
}

function CommitGraphCell({ row, maxLanes }: { readonly row: CommitGraphRow; readonly maxLanes: number }) {
  const clampedLanes = Math.min(Math.max(maxLanes, 1), 8);
  const width = clampedLanes * LANE_WIDTH + 6;
  const midY = ROW_HEIGHT / 2;
  const cx = (col: number) => Math.min(col, clampedLanes - 1) * LANE_WIDTH + LANE_WIDTH / 2 + 2;

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      {row.passThroughCols.map((p) => (
        <line
          key={`pt-${p.col}`}
          x1={cx(p.col)}
          y1={0}
          x2={cx(p.col)}
          y2={ROW_HEIGHT}
          stroke={laneColor(p.colorIdx)}
          strokeWidth={1.6}
          strokeOpacity={0.75}
          strokeLinecap="round"
        />
      ))}
      {row.incomingCols.map((inc) => {
        const x1 = cx(inc.col);
        const x2 = cx(row.col);
        if (x1 === x2) {
          return (
            <line
              key={`in-${inc.col}`}
              x1={x1}
              y1={0}
              x2={x2}
              y2={midY}
              stroke={laneColor(inc.colorIdx)}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          );
        }
        return (
          <path
            key={`in-${inc.col}`}
            d={`M ${x1} 0 C ${x1} ${midY * 0.65}, ${x2} ${midY * 0.35}, ${x2} ${midY}`}
            fill="none"
            stroke={laneColor(inc.colorIdx)}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        );
      })}
      {row.outgoingEdges.map((edge, idx) => {
        const x1 = cx(edge.fromCol);
        const x2 = cx(edge.toCol);
        if (x1 === x2) {
          return (
            <line
              key={`out-${idx}`}
              x1={x1}
              y1={midY}
              x2={x2}
              y2={ROW_HEIGHT}
              stroke={laneColor(edge.colorIdx)}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          );
        }
        return (
          <path
            key={`out-${idx}`}
            d={`M ${x1} ${midY} C ${x1} ${midY + (ROW_HEIGHT - midY) * 0.55}, ${x2} ${midY + (ROW_HEIGHT - midY) * 0.35}, ${x2} ${ROW_HEIGHT}`}
            fill="none"
            stroke={laneColor(edge.colorIdx)}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        );
      })}
      <circle
        cx={cx(row.col)}
        cy={midY}
        r={row.isHead ? NODE_R + 0.8 : NODE_R}
        fill={laneColor(row.colorIdx)}
      />
      {row.isHead ? <circle cx={cx(row.col)} cy={midY} r={NODE_R - 1.3} fill="var(--canvas)" /> : null}
    </svg>
  );
}

export interface GitLogPaneProps {
  readonly state: SourceControlState;
  readonly busy: boolean;
  readonly remoteReadOnly: boolean;
  readonly onCherryPick: (hash: string) => void;
  readonly onRevertCommit: (hash: string) => void;
  readonly onResetCommit: (hash: string, mode: 'soft' | 'mixed' | 'hard') => void;
  readonly onNewBranchFrom: (startPoint: string) => void;
  readonly onOpenCommitFileDiff: (hash: string, file: SourceControlCommitFileView) => void;
}

export function GitLogPane({
  state,
  busy,
  remoteReadOnly,
  onCherryPick,
  onRevertCommit,
  onResetCommit,
  onNewBranchFrom,
  onOpenCommitFileDiff,
}: GitLogPaneProps) {
  const t = useT();
  const logResult = useView((s) => s.gitLogResult);
  const detailResult = useView((s) => s.gitCommitDetailResult);

  const [query, setQuery] = useState('');
  const [branchFilter, setBranchFilter] = useState('__all__');
  const [commits, setCommits] = useState<readonly SourceControlCommitView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<SourceControlCommitDetailView | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailGroupByDir, setDetailGroupByDir] = useState(true);
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [inspectorHeight, setInspectorHeight] = useState(240);
  const [draggingSplit, setDraggingSplit] = useState(false);

  const pendingLogReqRef = useRef<number | undefined>(undefined);
  const pendingDetailReqRef = useRef<number | undefined>(undefined);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const fetchLog = useCallback((opts: { readonly query: string; readonly branch: string; readonly skip: number }) => {
    const reqId = ++logReqSeq;
    pendingLogReqRef.current = reqId;
    setLoading(true);
    postToHost({
      type: 'sourceControlFetchLog',
      payload: {
        requestId: reqId,
        ...(opts.query.trim() ? { query: opts.query.trim() } : {}),
        ...(opts.branch && opts.branch !== '__all__' ? { branch: opts.branch } : {}),
        limit: PAGE_SIZE,
        skip: opts.skip,
      },
    });
  }, []);

  useEffect(() => {
    fetchLog({ query, branch: branchFilter, skip: 0 });
  }, [branchFilter, state.updatedAt, fetchLog]);

  useEffect(() => {
    if (!logResult || logResult.requestId !== pendingLogReqRef.current) return;
    pendingLogReqRef.current = undefined;
    setLoading(false);
    if (logResult.append) {
      setCommits((prev) => {
        const seen = new Set(prev.map((c) => c.hash));
        return [...prev, ...logResult.commits.filter((c) => !seen.has(c.hash))];
      });
    } else {
      setCommits(logResult.commits);
    }
    setHasMore(logResult.hasMore);
  }, [logResult]);

  useEffect(() => {
    if (!detailResult || detailResult.requestId !== pendingDetailReqRef.current) return;
    pendingDetailReqRef.current = undefined;
    setLoadingDetail(false);
    setDetail(detailResult.detail ?? null);
    setCollapsedDirs({});
  }, [detailResult]);

  const selectCommit = (hash: string) => {
    if (selectedHash === hash) {
      setSelectedHash(null);
      setDetail(null);
      return;
    }
    setSelectedHash(hash);
    setDetail(null);
    const reqId = ++detailReqSeq;
    pendingDetailReqRef.current = reqId;
    setLoadingDetail(true);
    postToHost({ type: 'sourceControlFetchCommitDetail', payload: { requestId: reqId, hash } });
  };

  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: inspectorHeight };
    setDraggingSplit(true);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setInspectorHeight(Math.max(120, Math.min(440, d.startH - (ev.clientY - d.startY))));
    };
    const onUp = () => {
      dragRef.current = null;
      setDraggingSplit(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const graph = useMemo(() => computeCommitGraph(commits), [commits]);

  const branchOptions = useMemo(() => {
    const locals = state.branches ?? [];
    const remotes = state.remoteBranches ?? [];
    return [...locals, ...remotes];
  }, [state.branches, state.remoteBranches]);

  const selectedCommit = useMemo(
    () => (selectedHash ? commits.find((c) => c.hash === selectedHash) : undefined),
    [commits, selectedHash],
  );

  const detailFileTree = useMemo(() => {
    if (!detail || !detailGroupByDir) return null;
    return buildChangeDirTree(
      detail.files.map((f) => ({
        path: f.path,
        status: f.status,
        staged: false,
        ...(f.additions !== undefined ? { additions: f.additions } : {}),
        ...(f.deletions !== undefined ? { deletions: f.deletions } : {}),
      })),
    );
  }, [detail, detailGroupByDir]);

  const detailFileMap = useMemo(() => {
    const map = new Map<string, SourceControlCommitFileView>();
    if (detail) {
      for (const f of detail.files) map.set(f.path, f);
    }
    return map;
  }, [detail]);

  const renderCommitFileRow = (file: SourceControlCommitFileView, depth: number, inDirTree: boolean) => {
    if (!detail) return null;
    const { normalized, name, dir } = splitFilePath(file.path);
    const style = STATUS_STYLE[file.status];
    const padLeft = 8 + depth * 14;
    return (
      <div
        key={file.path}
        data-testid={`git-commit-file-${normalized}`}
        className="mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control pr-1.5 text-[11.5px] transition-colors select-none hover:bg-hover/80"
        style={{ paddingLeft: `${padLeft}px` }}
        title={file.oldPath ? `${file.oldPath} → ${normalized}` : normalized}
        onClick={() => onOpenCommitFileDiff(detail.hash, file)}
      >
        <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
        <span className={cn('max-w-[58%] shrink-0 truncate font-medium', style.nameCls)}>{name}</span>
        {!inDirTree && dir ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3/85">{dir}</span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
          {file.additions ? <span className="text-green">+{file.additions}</span> : null}
          {file.deletions ? <span className="text-red">−{file.deletions}</span> : null}
        </span>
        <span
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-semibold',
            style.badgeCls,
          )}
        >
          {style.letter}
        </span>
      </div>
    );
  };

  const renderDetailDirNode = (node: ChangeDirNode, depth: number) => {
    const collapsed = Boolean(collapsedDirs[node.fullPath]);
    const padLeft = 8 + depth * 14;
    return (
      <div key={node.fullPath}>
        <div
          className="mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control pr-2 text-[11.5px] text-ink-2 transition-colors select-none hover:bg-hover/80 hover:text-ink"
          style={{ paddingLeft: `${padLeft}px` }}
          onClick={() => setCollapsedDirs((prev) => ({ ...prev, [node.fullPath]: !prev[node.fullPath] }))}
        >
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-ink-3">
            {collapsed ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          </span>
          {collapsed ? (
            <VscodeFolderIcon className="size-3.5 shrink-0" />
          ) : (
            <VscodeFolderOpenIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate font-mono">{node.name}</span>
        </div>
        {!collapsed ? (
          <div>
            {node.dirs.map((child) => renderDetailDirNode(child, depth + 1))}
            {node.files.map((f) => {
              const orig = detailFileMap.get(f.path);
              return orig ? renderCommitFileRow(orig, depth + 1, true) : null;
            })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="git-log-pane">
      {/* 顶部筛选条 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border/60 bg-inset/25 px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-3" />
          <Input
            size="xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fetchLog({ query, branch: branchFilter, skip: 0 });
              else if (e.key === 'Escape' && query) {
                setQuery('');
                fetchLog({ query: '', branch: branchFilter, skip: 0 });
              }
            }}
            placeholder={t('wb.git.logSearchPlaceholder')}
            data-testid="git-log-search"
            className="pl-6"
          />
        </div>
        <Select value={branchFilter} onValueChange={setBranchFilter}>
          <SelectTrigger
            size="xs"
            data-testid="git-log-branch-filter"
            className="w-28 shrink-0 font-mono text-[11px]"
            aria-label={t('wb.git.logAllBranches')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="__all__" className="text-[12px]">
              {t('wb.git.logAllBranches')}
            </SelectItem>
            {branchOptions.map((b) => (
              <SelectItem key={b} value={b} className="font-mono text-[11.5px]">
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('wb.git.cherryPick')}
          title={t('wb.git.cherryPick')}
          disabled={busy || remoteReadOnly || !selectedCommit || Boolean(state.inProgressOp)}
          onClick={() => selectedCommit && onCherryPick(selectedCommit.hash)}
          className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
        >
          <GitCompareIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('wb.changes.refresh')}
          title={t('wb.changes.refresh')}
          disabled={loading}
          onClick={() => fetchLog({ query, branch: branchFilter, skip: 0 })}
          className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
        >
          <RefreshIcon className={cn('size-3.5', loading && 'spin')} />
        </Button>
      </div>

      {/* DAG 提交历史列表 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col py-1" data-testid="git-log-list">
          {loading && commits.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-ink-3">
              <SpinnerIcon className="size-3.5" />
              <span>{t('wb.git.logLoading')}</span>
            </div>
          ) : graph.rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center text-[12px] text-ink-3">
              <GitCommitIcon className="size-5 opacity-60" />
              <span>{t('wb.git.logEmpty')}</span>
            </div>
          ) : (
            <>
              {graph.rows.map((row) => {
                const { commit } = row;
                const selected = selectedHash === commit.hash;
                const isMerge = commit.parents.length > 1;
                const groupedRefs = groupRefLabels(commit.refs, state.branch);
                return (
                  <ContextMenu key={commit.hash}>
                    <ContextMenuTrigger asChild>
                      <div
                        data-testid={`git-log-row-${commit.shortHash}`}
                        onClick={() => selectCommit(commit.hash)}
                        className={cn(
                          'relative mx-1.5 flex h-7 cursor-pointer items-center gap-1 rounded-control pr-2 text-left text-[12px] transition-colors duration-100 select-none',
                          selected
                            ? 'bg-surface text-ink shadow-hairline before:absolute before:inset-y-0 before:-left-1.5 before:w-0.5 before:rounded-full before:bg-brand dark:bg-white/[0.08]'
                            : 'hover:bg-hover/75',
                          isMerge && !selected && 'text-ink-3',
                        )}
                      >
                        <CommitGraphCell row={row} maxLanes={graph.maxLanes} />
                        <div className="flex min-w-0 flex-1 items-center gap-1 pl-0.5">
                          <span className="min-w-0 flex-1 truncate" title={commit.subject}>
                            {commit.subject}
                          </span>
                          <SemanticRefBadges labels={groupedRefs} />
                        </div>
                        <span
                          className="ml-1.5 hidden w-20 shrink-0 truncate text-[11px] text-ink-2 sm:inline"
                          title={commit.email ? `${commit.author} <${commit.email}>` : commit.author}
                        >
                          {commit.author}
                        </span>
                        <span className="ml-1 shrink-0 font-mono text-[10.5px] text-ink-3 tabular-nums">
                          {formatIdeaDate(commit.date)}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(commit.hash)}>
                        <CopyIcon className="size-3.5" />
                        <span>{t('wb.git.copyHash')}</span>
                      </ContextMenuItem>
                      {!remoteReadOnly ? (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem disabled={busy} onSelect={() => onNewBranchFrom(commit.hash)}>
                            <GitBranchIcon className="size-3.5" />
                            <span>{t('wb.git.newBranchFromCommit')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem disabled={busy} onSelect={() => onCherryPick(commit.hash)}>
                            <GitCompareIcon className="size-3.5" />
                            <span>{t('wb.git.cherryPick')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem disabled={busy} onSelect={() => onRevertCommit(commit.hash)}>
                            <UndoIcon className="size-3.5" />
                            <span>{t('wb.git.revertCommit')}</span>
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem disabled={busy} onSelect={() => onResetCommit(commit.hash, 'soft')}>
                            <RotateCcwIcon className="size-3.5" />
                            <span>{t('wb.git.resetSoft')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem disabled={busy} onSelect={() => onResetCommit(commit.hash, 'mixed')}>
                            <RotateCcwIcon className="size-3.5" />
                            <span>{t('wb.git.resetMixed')}</span>
                          </ContextMenuItem>
                          <ContextMenuItem
                            variant="destructive"
                            disabled={busy}
                            onSelect={() => onResetCommit(commit.hash, 'hard')}
                          >
                            <RotateCcwIcon className="size-3.5" />
                            <span>{t('wb.git.resetHard')}</span>
                          </ContextMenuItem>
                        </>
                      ) : null}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
              {hasMore ? (
                <div className="flex justify-center py-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={loading}
                    onClick={() => fetchLog({ query, branch: branchFilter, skip: commits.length })}
                    className="text-ink-2 hover:text-ink"
                  >
                    {loading ? t('wb.git.logLoading') : t('wb.git.logLoadMore')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>

      {/* 可拖拽分割线 + 提交详情检查器 */}
      {selectedHash ? (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            onMouseDown={startSplitDrag}
            className={cn(
              'relative h-px shrink-0 cursor-row-resize bg-sidebar-border transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-brand',
              draggingSplit && 'bg-brand',
            )}
          />
          <div
            className="flex shrink-0 flex-col overflow-hidden bg-inset/45"
            style={{ height: `${inspectorHeight}px` }}
            data-testid="git-commit-detail"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-sidebar-border/60 px-2.5 py-1">
              <span className="truncate text-[11.5px] font-medium text-ink-2 tabular-nums">
                {detail ? t('wb.git.commitFiles', detail.files.length) : selectedHash.slice(0, 8)}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={detailGroupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
                  title={detailGroupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
                  aria-pressed={detailGroupByDir}
                  onClick={() => setDetailGroupByDir((v) => !v)}
                  className={cn('text-ink-2 hover:bg-hover hover:text-ink', detailGroupByDir && 'bg-hover text-ink')}
                >
                  <FolderTreeIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setSelectedHash(null);
                    setDetail(null);
                  }}
                  aria-label={t('common.close')}
                  className="text-ink-3 hover:text-ink"
                >
                  <CloseIcon className="size-3.5" />
                </Button>
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              {loadingDetail ? (
                <div className="flex items-center justify-center gap-1.5 py-6 text-[11.5px] text-ink-3">
                  <SpinnerIcon className="size-3.5" />
                  <span>{t('wb.git.commitDetailLoading')}</span>
                </div>
              ) : detail ? (
                <div className="flex flex-col">
                  <div className="border-b border-sidebar-border/60 py-1">
                    {detailFileTree ? (
                      <>
                        {detailFileTree.dirs.map((d) => renderDetailDirNode(d, 0))}
                        {detailFileTree.rootFiles.map((f) => {
                          const orig = detailFileMap.get(f.path);
                          return orig ? renderCommitFileRow(orig, 0, true) : null;
                        })}
                      </>
                    ) : (
                      detail.files.map((f) => renderCommitFileRow(f, 0, false))
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5 px-3 py-2.5 text-[12px] select-text">
                    <div className="font-mono font-semibold text-ink break-words">{detail.subject}</div>
                    {detail.body ? (
                      <pre className="m-0 whitespace-pre-wrap rounded-lg bg-surface/75 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink-2">
                        {detail.body}
                      </pre>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-3 tabular-nums">
                      <button
                        type="button"
                        className="font-mono text-accent-ink hover:underline"
                        title={t('wb.git.copyHash')}
                        onClick={() => void navigator.clipboard?.writeText(detail.hash)}
                      >
                        {detail.shortHash}
                      </button>
                      <span>{detail.author}</span>
                      {detail.email ? <span>{`<${detail.email}>`}</span> : null}
                      {detail.date ? <span>{formatIdeaDate(detail.date)}</span> : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </ScrollArea>
          </div>
        </>
      ) : null}
    </div>
  );
}

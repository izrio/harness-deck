/**
 * Git 工作台 · 提交（Commit）子面板（Halo 语义主题样式 + IDEA 风格交互）：
 * - 进行中操作（Merge / Rebase / Cherry-pick / Revert）与冲突解决横幅
 * - IDEA 风格文件与分组勾选框（免暂存区心智负担），同时支持单文件/批量暂存、贮藏与撤销
 * - 支持目录树/平铺切换、全部展开/收起、本会话筛选、每行右键菜单与冲突快捷解决
 * - 可拖拽调节高度的底部提交面板：Amend 勾选（自动回填上次提交说明）+ AI 生成 + Commit / Commit and Push
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SourceControlFileView, SourceControlState } from '@harness-deck/shared';
import type { MessageKey } from '../../../i18n.ts';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import {
  AlertTriangleIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DiffIcon,
  FileTypeIcon,
  FilterIcon,
  FolderTreeIcon,
  ListIcon,
  MinusIcon,
  PlusIcon,
  SparklesIcon,
  SpinnerIcon,
  UndoIcon,
  UploadIcon,
  VscodeFolderIcon,
  VscodeFolderOpenIcon,
} from '../../icons.tsx';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/context-menu.tsx';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { buildChangeDirTree, splitFilePath, STATUS_STYLE, type ChangeDirNode } from './gitHelpers.ts';

interface ChangeGroup {
  readonly id: 'conflicted' | 'staged' | 'changes' | 'untracked';
  readonly labelKey: MessageKey;
  readonly files: readonly SourceControlFileView[];
}

const GROUP_DOT_CLASS: Record<ChangeGroup['id'], string> = {
  conflicted: 'bg-red',
  staged: 'bg-green',
  changes: 'bg-accent-ink',
  untracked: 'bg-orange',
};

export interface GitCommitPaneProps {
  readonly state: SourceControlState;
  readonly sessionPaths: ReadonlySet<string>;
  readonly activeDiffPath?: string;
  readonly busy: boolean;
  readonly remoteReadOnly: boolean;
  readonly commitMessage: string;
  readonly onCommitMessageChange: (value: string) => void;
  readonly amend: boolean;
  readonly onAmendChange: (checked: boolean) => void;
  readonly generatingCommit: boolean;
  readonly onRequestAiCommit: () => void;
  readonly onCommit: (options: { readonly files?: readonly string[]; readonly amend: boolean; readonly push: boolean }) => void;
  readonly onOpenPushDialog: () => void;
  readonly onOpenDiff: (file: SourceControlFileView) => void;
  readonly onStageFile: (file: SourceControlFileView) => void;
  readonly onUnstageFile: (file: SourceControlFileView) => void;
  readonly onStageAll: () => void;
  readonly onUnstageAll: () => void;
  readonly onRequestDiscardFile: (file: SourceControlFileView) => void;
  readonly onRequestDiscardAll: () => void;
  readonly onOpenStashSave: (paths?: readonly string[]) => void;
  readonly onContinueOp: () => void;
  readonly onAbortOp: () => void;
  readonly onResolveConflict: (path: string, strategy: 'ours' | 'theirs' | 'mark') => void;
}

export function GitCommitPane({
  state,
  sessionPaths,
  activeDiffPath,
  busy,
  remoteReadOnly,
  commitMessage,
  onCommitMessageChange,
  amend,
  onAmendChange,
  generatingCommit,
  onRequestAiCommit,
  onCommit,
  onOpenPushDialog,
  onOpenDiff,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onRequestDiscardFile,
  onRequestDiscardAll,
  onOpenStashSave,
  onContinueOp,
  onAbortOp,
  onResolveConflict,
}: GitCommitPaneProps) {
  const t = useT();
  const [sessionOnly, setSessionOnly] = useState(false);
  const [groupByDir, setGroupByDir] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [uncheckedPaths, setUncheckedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [commitPanelHeight, setCommitPanelHeight] = useState(176);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const existing = new Set(state.files.map((f) => f.path));
    setUncheckedPaths((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (existing.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [state.files]);

  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: commitPanelHeight };
    setDraggingSplit(true);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setCommitPanelHeight(Math.max(132, Math.min(360, d.startH - (ev.clientY - d.startY))));
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

  const visibleFiles = useMemo(() => {
    const files = state.files;
    if (!sessionOnly || sessionPaths.size === 0) return files;
    return files.filter((f) => sessionPaths.has(f.path.replace(/\\/gu, '/')));
  }, [state.files, sessionOnly, sessionPaths]);

  const groups = useMemo<readonly ChangeGroup[]>(() => {
    const conflicted: SourceControlFileView[] = [];
    const staged: SourceControlFileView[] = [];
    const changes: SourceControlFileView[] = [];
    const untracked: SourceControlFileView[] = [];
    for (const file of visibleFiles) {
      if (file.status === 'conflicted') conflicted.push(file);
      else if (file.staged) staged.push(file);
      else if (file.status === 'untracked') untracked.push(file);
      else changes.push(file);
    }
    const list: ChangeGroup[] = [];
    if (conflicted.length > 0) list.push({ id: 'conflicted', labelKey: 'wb.git.conflictGroup', files: conflicted });
    if (staged.length > 0) list.push({ id: 'staged', labelKey: 'wb.changes.groupStaged', files: staged });
    if (changes.length > 0) list.push({ id: 'changes', labelKey: 'wb.changes.groupChanges', files: changes });
    if (untracked.length > 0) list.push({ id: 'untracked', labelKey: 'wb.changes.groupUntracked', files: untracked });
    return list;
  }, [visibleFiles]);

  const selectableFiles = useMemo(
    () => visibleFiles.filter((f) => f.status !== 'conflicted'),
    [visibleFiles],
  );
  const selectedFiles = useMemo(
    () => selectableFiles.filter((f) => !uncheckedPaths.has(f.path)),
    [selectableFiles, uncheckedPaths],
  );
  const conflictedCount = useMemo(
    () => state.files.filter((f) => f.status === 'conflicted').length,
    [state.files],
  );
  const stagedCount = useMemo(() => state.files.filter((f) => f.staged).length, [state.files]);
  const unstagedCount = state.files.length - stagedCount - conflictedCount;

  const isFileChecked = (path: string) => !uncheckedPaths.has(path);

  const toggleFileChecked = (path: string, checked: boolean) => {
    setUncheckedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleGroupChecked = (files: readonly SourceControlFileView[], checked: boolean) => {
    setUncheckedPaths((prev) => {
      const next = new Set(prev);
      for (const f of files) {
        if (f.status === 'conflicted') continue;
        if (checked) next.delete(f.path);
        else next.add(f.path);
      }
      return next;
    });
  };

  const toggleAllChecked = (checked: boolean) => {
    toggleGroupChecked(selectableFiles, checked);
  };

  const allSelected = selectableFiles.length > 0 && selectedFiles.length === selectableFiles.length;
  const someSelected = selectedFiles.length > 0 && selectedFiles.length < selectableFiles.length;

  const canCommit =
    !busy &&
    !remoteReadOnly &&
    Boolean(commitMessage.trim()) &&
    conflictedCount === 0 &&
    (amend || selectedFiles.length > 0);

  const triggerCommit = (push: boolean) => {
    if (!canCommit) return;
    const isAllWorkspaceSelected =
      !sessionOnly && selectedFiles.length === state.files.length && state.files.length > 0;
    onCommit({
      ...(!isAllWorkspaceSelected && selectedFiles.length > 0
        ? { files: selectedFiles.map((f) => f.path) }
        : {}),
      amend,
      push,
    });
  };

  const handleToggleAmend = (next: boolean) => {
    onAmendChange(next);
    if (next && !commitMessage.trim() && state.lastCommitMessage) {
      onCommitMessageChange(state.lastCommitMessage);
    }
  };

  const toggleGroup = (id: string) => setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  const toggleDir = (key: string) => setCollapsedDirs((prev) => ({ ...prev, [key]: !prev[key] }));

  const expandAll = () => {
    setCollapsedGroups({});
    setCollapsedDirs({});
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const g of groups) next[g.id] = true;
    setCollapsedGroups(next);
  };

  const renderFileRow = (file: SourceControlFileView, depth: number, inDirTree: boolean) => {
    const style = STATUS_STYLE[file.status];
    const { normalized, name, dir } = splitFilePath(file.path);
    const active = activeDiffPath === file.path;
    const isConflict = file.status === 'conflicted';
    const checked = !isConflict && isFileChecked(file.path);
    const padLeft = 8 + depth * 14;

    return (
      <ContextMenu key={`${file.staged ? 's' : 'u'}:${file.path}`}>
        <ContextMenuTrigger asChild>
          <div
            data-testid={`changes-file-${normalized}`}
            data-active={active ? 'true' : undefined}
            className={cn(
              'group mx-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-control pr-1.5 text-[12px] transition-colors duration-100 select-none',
              active ? 'bg-surface text-ink shadow-hairline dark:bg-white/[0.08]' : 'hover:bg-hover/80',
            )}
            style={{ paddingLeft: `${padLeft}px` }}
            title={file.path}
            onClick={() => onOpenDiff(file)}
          >
            {!remoteReadOnly && !isConflict ? (
              <span className="inline-flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => toggleFileChecked(file.path, v === true)}
                  data-testid={`changes-check-${normalized}`}
                  aria-label={normalized}
                />
              </span>
            ) : null}

            <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
            <span className={cn('max-w-[65%] shrink-0 truncate font-medium', style.nameCls)}>{name}</span>
            {!inDirTree && dir ? (
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3/85">{dir}</span>
            ) : (
              <span className="flex-1" />
            )}

            {!remoteReadOnly && isConflict ? (
              <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid={`changes-conflict-ours-${normalized}`}
                  disabled={busy}
                  onClick={() => onResolveConflict(file.path, 'ours')}
                  className="px-1.5 text-[10.5px] text-ink-2 hover:bg-hover hover:text-ink"
                >
                  {t('wb.git.acceptYours')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid={`changes-conflict-theirs-${normalized}`}
                  disabled={busy}
                  onClick={() => onResolveConflict(file.path, 'theirs')}
                  className="px-1.5 text-[10.5px] text-ink-2 hover:bg-hover hover:text-ink"
                >
                  {t('wb.git.acceptTheirs')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid={`changes-conflict-mark-${normalized}`}
                  disabled={busy}
                  onClick={() => onResolveConflict(file.path, 'mark')}
                  className="px-1.5 text-[10.5px] text-green hover:bg-green-tint hover:text-green"
                >
                  {t('wb.git.markResolved')}
                </Button>
              </div>
            ) : (
              <>
                <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums group-hover:hidden">
                  {file.additions ? <span className="text-green">+{file.additions}</span> : null}
                  {file.deletions ? <span className="text-red">−{file.deletions}</span> : null}
                  <span
                    className={cn(
                      'inline-flex size-4 items-center justify-center rounded-[4px] text-[10px] font-semibold',
                      style.badgeCls,
                    )}
                  >
                    {style.letter}
                  </span>
                </span>
                {!remoteReadOnly ? (
                  <div
                    className="hidden shrink-0 items-center gap-0.5 group-hover:flex"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      data-testid={`changes-${file.staged ? 'unstage' : 'stage'}-${normalized}`}
                      aria-label={file.staged ? t('wb.changes.unstageFile') : t('wb.changes.stageFile')}
                      title={file.staged ? t('wb.changes.unstageFile') : t('wb.changes.stageFile')}
                      disabled={busy}
                      onClick={() => (file.staged ? onUnstageFile(file) : onStageFile(file))}
                      className="text-ink-2 hover:bg-hover hover:text-ink"
                    >
                      {file.staged ? <MinusIcon className="size-3" /> : <PlusIcon className="size-3" />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      data-testid={`changes-discard-${normalized}`}
                      aria-label={t('wb.changes.discardFile')}
                      title={t('wb.changes.discardFile')}
                      disabled={busy}
                      onClick={() => onRequestDiscardFile(file)}
                      className="text-ink-2 hover:bg-red-tint hover:text-red"
                    >
                      <UndoIcon className="size-3" />
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => onOpenDiff(file)}>
            <DiffIcon className="size-3.5" />
            <span>{t('wb.git.openDiff')}</span>
          </ContextMenuItem>
          {!remoteReadOnly && isConflict ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={busy} onSelect={() => onResolveConflict(file.path, 'ours')}>
                <CheckIcon className="size-3.5" />
                <span>{t('wb.git.acceptYours')}</span>
              </ContextMenuItem>
              <ContextMenuItem disabled={busy} onSelect={() => onResolveConflict(file.path, 'theirs')}>
                <CheckIcon className="size-3.5" />
                <span>{t('wb.git.acceptTheirs')}</span>
              </ContextMenuItem>
              <ContextMenuItem disabled={busy} onSelect={() => onResolveConflict(file.path, 'mark')}>
                <CheckIcon className="size-3.5" />
                <span>{t('wb.git.markResolved')}</span>
              </ContextMenuItem>
            </>
          ) : !remoteReadOnly ? (
            <>
              <ContextMenuItem
                disabled={busy}
                onSelect={() => (file.staged ? onUnstageFile(file) : onStageFile(file))}
              >
                {file.staged ? <MinusIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                <span>{file.staged ? t('wb.changes.unstageFile') : t('wb.changes.stageFile')}</span>
              </ContextMenuItem>
              <ContextMenuItem disabled={busy} onSelect={() => onOpenStashSave([file.path])}>
                <ArchiveIcon className="size-3.5" />
                <span>{t('wb.git.stashFile')}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={busy}
                onSelect={() => onRequestDiscardFile(file)}
              >
                <UndoIcon className="size-3.5" />
                <span>{t('wb.changes.discardFile')}</span>
              </ContextMenuItem>
            </>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(normalized)}>
            <CopyIcon className="size-3.5" />
            <span>{t('wb.git.copyPath')}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderDirNode = (groupId: string, node: ChangeDirNode, depth: number) => {
    const dirKey = `${groupId}:${node.fullPath}`;
    const collapsed = Boolean(collapsedDirs[dirKey]);
    const padLeft = 8 + depth * 14;
    return (
      <div key={dirKey}>
        <div
          className="mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control pr-2 text-[11.5px] text-ink-2 transition-colors select-none hover:bg-hover/80 hover:text-ink"
          style={{ paddingLeft: `${padLeft}px` }}
          onClick={() => toggleDir(dirKey)}
          title={node.fullPath}
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
          <span className="ml-auto font-mono text-[10.5px] text-ink-3 tabular-nums">{node.totalFiles}</span>
        </div>
        {!collapsed ? (
          <div>
            {node.dirs.map((child) => renderDirNode(groupId, child, depth + 1))}
            {node.files.map((file) => renderFileRow(file, depth + 1, true))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="git-commit-pane">
      {/* 进行中操作（Merge / Rebase / Cherry-pick / Revert）与冲突提示横幅 */}
      {state.inProgressOp || conflictedCount > 0 ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-red/25 bg-red-tint/55 px-2.5 py-1.5 text-[11.5px]"
          data-testid="git-in-progress-banner"
        >
          <div className="flex min-w-0 items-center gap-1.5 text-red">
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <span className="truncate font-medium">
              {state.inProgressOp
                ? t('wb.git.opInProgress', t(`wb.git.op.${state.inProgressOp}` as MessageKey))
                : `${t('wb.git.conflictGroup')} (${conflictedCount})`}
            </span>
            {state.inProgressOp && conflictedCount > 0 ? (
              <span className="shrink-0 rounded-full bg-red/15 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums">
                {conflictedCount}
              </span>
            ) : null}
          </div>
          {!remoteReadOnly && state.inProgressOp ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="secondary"
                data-testid="git-op-continue-btn"
                disabled={busy || conflictedCount > 0}
                onClick={onContinueOp}
              >
                {t('wb.git.continueOp')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-testid="git-op-abort-btn"
                disabled={busy}
                className="text-red hover:bg-red-tint hover:text-red"
                onClick={onAbortOp}
              >
                {t('wb.git.abortOp')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 变更列表二级工具栏：全选 + 视图/展开切换 + 批量暂存/贮藏/撤销 */}
      <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-sidebar-border/60 bg-inset/25 px-2.5 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {selectableFiles.length > 0 && !remoteReadOnly ? (
            <label className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-ink-2 select-none hover:text-ink">
              <Checkbox
                checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                onCheckedChange={(v) => toggleAllChecked(v === true)}
                aria-label={t('wb.git.selectAll')}
                data-testid="git-select-all-checkbox"
              />
              <span className="truncate tabular-nums">
                {t('wb.git.selectedCount', selectedFiles.length, selectableFiles.length)}
              </span>
            </label>
          ) : (
            <span className="truncate text-[11px] text-ink-3 tabular-nums">
              {t('wb.changes.fileCount', visibleFiles.length)}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="changes-group-toggle"
            aria-label={groupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
            title={groupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
            aria-pressed={groupByDir}
            onClick={() => setGroupByDir((v) => !v)}
            className={cn('text-ink-2 hover:bg-hover hover:text-ink', groupByDir && 'bg-hover text-ink')}
          >
            {groupByDir ? <ListIcon className="size-3.5" /> : <FolderTreeIcon className="size-3.5" />}
          </Button>
          {sessionPaths.size > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="changes-session-filter"
              aria-label={t('wb.changes.sessionOnly', sessionPaths.size)}
              title={t('wb.changes.sessionOnly', sessionPaths.size)}
              aria-pressed={sessionOnly}
              onClick={() => setSessionOnly((v) => !v)}
              className={cn('text-ink-2 hover:bg-hover hover:text-ink', sessionOnly && 'bg-hover text-ink')}
            >
              <FilterIcon className="size-3.5" />
            </Button>
          ) : null}
          {groups.length > 0 ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Expand All"
                title="Expand All"
                onClick={expandAll}
                className="text-ink-2 hover:bg-hover hover:text-ink"
              >
                <ArrowDownIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Collapse All"
                title="Collapse All"
                onClick={collapseAll}
                className="text-ink-2 hover:bg-hover hover:text-ink"
              >
                <ArrowUpIcon className="size-3" />
              </Button>
            </>
          ) : null}
          {!remoteReadOnly && unstagedCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="git-stage-all-btn"
              aria-label={t('wb.git.stageAll')}
              title={t('wb.git.stageAll')}
              disabled={busy}
              onClick={onStageAll}
              className="text-ink-2 hover:bg-hover hover:text-ink"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          ) : null}
          {!remoteReadOnly && stagedCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="git-unstage-all-btn"
              aria-label={t('wb.git.unstageAll')}
              title={t('wb.git.unstageAll')}
              disabled={busy}
              onClick={onUnstageAll}
              className="text-ink-2 hover:bg-hover hover:text-ink"
            >
              <MinusIcon className="size-3.5" />
            </Button>
          ) : null}
          {!remoteReadOnly && state.files.length > 0 ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="git-stash-changes-btn"
                aria-label={t('wb.git.stashSave')}
                title={t('wb.git.stashSave')}
                disabled={busy}
                onClick={() => onOpenStashSave()}
                className="text-ink-2 hover:bg-hover hover:text-ink"
              >
                <ArchiveIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="git-discard-all-btn"
                aria-label={t('wb.git.discardAll')}
                title={t('wb.git.discardAll')}
                disabled={busy}
                onClick={onRequestDiscardAll}
                className="text-ink-2 hover:bg-red-tint hover:text-red"
              >
                <UndoIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* 上半区：变更文件树 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 py-1.5">
          {visibleFiles.length === 0 ? (
            <div className="px-3 py-10 text-center text-[12px] text-ink-3">{t('wb.changes.empty')}</div>
          ) : (
            groups.map((group) => {
              const collapsed = Boolean(collapsedGroups[group.id]);
              const isConflictGroup = group.id === 'conflicted';
              const checkedCount = group.files.filter((f) => isFileChecked(f.path)).length;
              const groupCheckedState: boolean | 'indeterminate' =
                checkedCount === 0 ? false : checkedCount === group.files.length ? true : 'indeterminate';
              const tree = groupByDir ? buildChangeDirTree(group.files) : null;

              return (
                <div key={group.id} className="flex flex-col gap-0.5">
                  <div
                    className="group mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control px-1.5 text-[11px] font-medium text-ink-2 select-none hover:bg-hover/75 hover:text-ink"
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-ink-3">
                      {collapsed ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
                    </span>
                    {!remoteReadOnly && !isConflictGroup ? (
                      <span className="inline-flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={groupCheckedState}
                          onCheckedChange={(v) => toggleGroupChecked(group.files, v === true)}
                          data-testid={`git-group-check-${group.id}`}
                          aria-label={t(group.labelKey)}
                        />
                      </span>
                    ) : null}
                    <span className={cn('size-1.5 shrink-0 rounded-full', GROUP_DOT_CLASS[group.id])} />
                    <span className={cn('truncate', isConflictGroup && 'text-red')}>{t(group.labelKey)}</span>
                    <span className="font-mono text-[10.5px] text-ink-3 tabular-nums">{group.files.length}</span>
                    <span className="flex-1" />
                    {!remoteReadOnly && (group.id === 'staged' || group.id === 'changes') ? (
                      <span
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={busy}
                          aria-label={group.id === 'staged' ? t('wb.git.unstageAll') : t('wb.git.stageAll')}
                          title={group.id === 'staged' ? t('wb.git.unstageAll') : t('wb.git.stageAll')}
                          onClick={group.id === 'staged' ? onUnstageAll : onStageAll}
                          className="text-ink-2 hover:bg-hover hover:text-ink"
                        >
                          {group.id === 'staged' ? (
                            <MinusIcon className="size-3" />
                          ) : (
                            <PlusIcon className="size-3" />
                          )}
                        </Button>
                      </span>
                    ) : null}
                  </div>

                  {!collapsed ? (
                    tree ? (
                      <div data-testid={`changes-dir-tree-${group.id}`}>
                        {tree.dirs.map((node) => renderDirNode(group.id, node, 1))}
                        {tree.rootFiles.map((file) => renderFileRow(file, 1, true))}
                      </div>
                    ) : (
                      <div>{group.files.map((file) => renderFileRow(file, 1, false))}</div>
                    )
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* 可拖拽分割线 + 下半区 Halo 语义风格提交面板 */}
      {!remoteReadOnly ? (
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
            className="flex shrink-0 flex-col gap-2 bg-inset/35 p-2.5"
            style={{ height: `${commitPanelHeight}px` }}
          >
            <div className="flex shrink-0 items-center gap-2">
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-2 select-none hover:text-ink"
                title={t('wb.git.amendTitle')}
              >
                <Checkbox
                  checked={amend}
                  onCheckedChange={(v) => handleToggleAmend(v === true)}
                  disabled={busy || Boolean(state.inProgressOp)}
                  data-testid="git-amend-checkbox"
                />
                <span>{t('wb.git.amend')}</span>
              </label>
              {state.lastCommitMessage ? (
                <button
                  type="button"
                  className="min-w-0 truncate rounded-control px-1.5 py-0.5 text-[11px] text-accent-ink transition-colors hover:bg-hover"
                  title={state.lastCommitMessage}
                  disabled={busy || Boolean(state.inProgressOp)}
                  onClick={() => handleToggleAmend(!amend)}
                >
                  {state.lastCommitMessage}
                </button>
              ) : null}
              <span className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="changes-ai-commit-btn"
                disabled={busy || generatingCommit || state.files.length === 0}
                onClick={onRequestAiCommit}
                title={t('wb.changes.aiCommit')}
                aria-label={t('wb.changes.aiCommit')}
                className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
              >
                {generatingCommit ? <SpinnerIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
              </Button>
            </div>

            <Textarea
              rows={3}
              value={commitMessage}
              onChange={(e) => onCommitMessageChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) {
                  e.preventDefault();
                  triggerCommit(e.shiftKey);
                }
              }}
              placeholder={t('wb.changes.commitPlaceholder')}
              data-testid="changes-commit-input"
              disabled={busy || generatingCommit}
              className="min-h-[56px] flex-1 resize-none bg-surface/90 font-mono text-[12px] leading-relaxed"
            />

            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                data-testid="git-commit-btn"
                disabled={!canCommit}
                onClick={() => triggerCommit(false)}
                className="shrink-0"
              >
                {t('wb.changes.commit')}
              </Button>
              {state.remote ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="git-commit-push-btn"
                  disabled={!canCommit}
                  onClick={() => triggerCommit(true)}
                  className="min-w-0 truncate"
                >
                  {t('wb.git.commitAndPush')}
                </Button>
              ) : null}
              <span className="flex-1" />
              {state.remote ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="changes-push-btn"
                  disabled={busy}
                  onClick={onOpenPushDialog}
                  title={t('wb.changes.push')}
                  aria-label={t('wb.changes.push')}
                  className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
                >
                  <UploadIcon className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

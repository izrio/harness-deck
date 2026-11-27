/**
 * Git 工作台 · 分支（Branches）子面板（Halo 语义主题样式 + IDEA 分支树交互）：
 * - 搜索过滤（关键字高亮）+ 按目录分组切换 + 快速新建分支
 * - 本地 / 远程 / 标签三大可折叠分组，支持 `/` 目录折叠、↑ahead ↓behind、双击检出与右键操作菜单
 */
import { useMemo, useState } from 'react';
import type { SourceControlBranchView, SourceControlState } from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCompareIcon,
  GitMergeIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  TrashIcon,
  VscodeFolderIcon,
  VscodeFolderOpenIcon,
} from '../../icons.tsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/context-menu.tsx';
import { ScrollArea } from '@/components/ui/scroll-area';
import { buildBranchFolderTree, type BranchFolderNode } from './gitHelpers.ts';

export interface GitBranchesPaneProps {
  readonly state: SourceControlState;
  readonly busy: boolean;
  readonly remoteReadOnly: boolean;
  readonly onCheckoutBranch: (branch: string) => void;
  readonly onCreateBranch: (branch: string, startPoint?: string) => void;
  readonly onRenameBranch: (branch: string) => void;
  readonly onMergeBranch: (branch: string) => void;
  readonly onRebaseBranch: (branch: string) => void;
  readonly onDeleteBranch: (branch: string) => void;
  readonly onNewBranchFrom: (startPoint: string) => void;
}

function HighlightMatch({ text, query }: { readonly text: string; readonly query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-brand">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

export function GitBranchesPane({
  state,
  busy,
  remoteReadOnly,
  onCheckoutBranch,
  onCreateBranch,
  onRenameBranch,
  onMergeBranch,
  onRebaseBranch,
  onDeleteBranch,
  onNewBranchFrom,
}: GitBranchesPaneProps) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [groupByDir, setGroupByDir] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const allDetails = useMemo<readonly SourceControlBranchView[]>(() => {
    if (state.branchDetails && state.branchDetails.length > 0) return state.branchDetails;
    const out: SourceControlBranchView[] = [];
    for (const name of state.branches ?? []) {
      out.push({ name, kind: 'local', current: name === state.branch });
    }
    for (const name of state.remoteBranches ?? []) {
      out.push({ name, kind: 'remote' });
    }
    for (const name of state.tags ?? []) {
      out.push({ name, kind: 'tag' });
    }
    return out;
  }, [state.branchDetails, state.branches, state.remoteBranches, state.tags, state.branch]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return allDetails;
    return allDetails.filter(
      (b) => b.name.toLowerCase().includes(q) || b.lastCommitSubject?.toLowerCase().includes(q),
    );
  }, [allDetails, q]);

  const locals = useMemo(() => filtered.filter((b) => b.kind === 'local'), [filtered]);
  const remotes = useMemo(() => filtered.filter((b) => b.kind === 'remote'), [filtered]);
  const tags = useMemo(() => filtered.filter((b) => b.kind === 'tag'), [filtered]);

  const handleCreate = () => {
    const trimmed = newBranchName.trim();
    if (!trimmed || busy || remoteReadOnly) return;
    onCreateBranch(trimmed);
    setNewBranchName('');
  };

  const renderBranchRow = (b: SourceControlBranchView, depth: number, displayName: string) => {
    const rowId = `${b.kind}:${b.name}`;
    const isCurrent = Boolean(b.current);
    const isLocal = b.kind === 'local';
    const isTag = b.kind === 'tag';
    const selected = selectedId === rowId;
    const padLeft = 8 + depth * 14;

    return (
      <ContextMenu key={rowId}>
        <ContextMenuTrigger asChild>
          <div
            data-testid={`git-branch-row-${b.kind}-${b.name}`}
            className={cn(
              'group mx-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-control pr-1.5 text-[12px] transition-colors select-none',
              selected || isCurrent ? 'bg-surface text-ink shadow-hairline dark:bg-white/[0.08]' : 'text-ink-2 hover:bg-hover/80 hover:text-ink',
            )}
            style={{ paddingLeft: `${padLeft}px` }}
            title={b.lastCommitSubject ? `${b.name} — ${b.lastCommitSubject}` : b.name}
            onClick={() => setSelectedId(rowId)}
            onDoubleClick={() => {
              if (!isCurrent && !busy && !remoteReadOnly) onCheckoutBranch(b.name);
            }}
          >
            <span className="inline-flex size-4 shrink-0 items-center justify-center">
              {isTag ? (
                <TagIcon className="size-3.5 text-ink-3" />
              ) : isCurrent ? (
                <GitBranchIcon className="size-3.5 text-brand" />
              ) : (
                <GitBranchIcon className={cn('size-3.5', isLocal ? 'text-green' : 'text-accent-ink')} />
              )}
            </span>

            <span className={cn('min-w-0 truncate font-mono text-[11.5px]', isCurrent && 'font-semibold text-ink')}>
              <HighlightMatch text={displayName} query={search} />
            </span>

            {b.ahead || b.behind ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-field/85 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums">
                {b.ahead ? <span className="text-green">↑{b.ahead}</span> : null}
                {b.behind ? <span className="text-orange">↓{b.behind}</span> : null}
              </span>
            ) : null}

            {b.lastCommitSubject ? (
              <span className="ml-1 min-w-0 flex-1 truncate text-[11px] text-ink-3">{b.lastCommitSubject}</span>
            ) : (
              <span className="flex-1" />
            )}

            {!remoteReadOnly && !isCurrent ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onCheckoutBranch(b.name);
                }}
                className="shrink-0 px-1.5 text-[11px] text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-ink"
              >
                {t('wb.git.checkout')}
              </Button>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {!remoteReadOnly && !isCurrent ? (
            <ContextMenuItem disabled={busy} onSelect={() => onCheckoutBranch(b.name)}>
              <CheckIcon className="size-3.5" />
              <span>{t('wb.git.checkout')}</span>
            </ContextMenuItem>
          ) : null}
          {!remoteReadOnly ? (
            <ContextMenuItem disabled={busy} onSelect={() => onNewBranchFrom(b.name)}>
              <PlusIcon className="size-3.5" />
              <span>{t('wb.git.newBranchFromHere')}</span>
            </ContextMenuItem>
          ) : null}
          {!remoteReadOnly && !isCurrent && !isTag ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={busy} onSelect={() => onMergeBranch(b.name)}>
                <GitMergeIcon className="size-3.5" />
                <span>{t('wb.git.mergeIntoCurrent')}</span>
              </ContextMenuItem>
              <ContextMenuItem disabled={busy} onSelect={() => onRebaseBranch(b.name)}>
                <GitCompareIcon className="size-3.5" />
                <span>{t('wb.git.rebaseOnto')}</span>
              </ContextMenuItem>
            </>
          ) : null}
          {!remoteReadOnly && isLocal ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={busy} onSelect={() => onRenameBranch(b.name)}>
                <PencilIcon className="size-3.5" />
                <span>{t('wb.git.renameBranch')}</span>
              </ContextMenuItem>
              {!isCurrent ? (
                <ContextMenuItem
                  variant="destructive"
                  disabled={busy}
                  onSelect={() => onDeleteBranch(b.name)}
                >
                  <TrashIcon className="size-3.5" />
                  <span>{t('wb.changes.deleteBranch')}</span>
                </ContextMenuItem>
              ) : null}
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderFolderNode = (sectionKey: string, node: BranchFolderNode, depth: number) => {
    const key = `${sectionKey}:${node.fullPath}`;
    const isCollapsed = !q && Boolean(collapsedFolders[key]);
    const padLeft = 8 + depth * 14;
    return (
      <div key={key}>
        <div
          className="mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control pr-2 text-[11.5px] text-ink-2 transition-colors select-none hover:bg-hover/80 hover:text-ink"
          style={{ paddingLeft: `${padLeft}px` }}
          onClick={() => setCollapsedFolders((prev) => ({ ...prev, [key]: !prev[key] }))}
        >
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-ink-3">
            {isCollapsed ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          </span>
          {isCollapsed ? (
            <VscodeFolderIcon className="size-3.5 shrink-0" />
          ) : (
            <VscodeFolderOpenIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate font-mono">{node.name}</span>
        </div>
        {!isCollapsed ? (
          <div>
            {node.folders.map((f) => renderFolderNode(sectionKey, f, depth + 1))}
            {node.branches.map((b) => {
              const short = b.name.slice(b.name.lastIndexOf('/') + 1);
              return renderBranchRow(b, depth + 1, short);
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderSection = (key: 'local' | 'remote' | 'tags', title: string, items: readonly SourceControlBranchView[]) => {
    const isCollapsed = !q && Boolean(collapsed[key]);
    const tree = groupByDir && !q && key !== 'tags' ? buildBranchFolderTree(items) : null;
    return (
      <div key={key} className="flex flex-col gap-0.5">
        <div
          className="mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control px-1.5 text-[11px] font-medium text-ink-2 select-none hover:bg-hover/75 hover:text-ink"
          onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
        >
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-ink-3">
            {isCollapsed ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          </span>
          <span>{title}</span>
          <span className="font-mono text-[10.5px] text-ink-3 tabular-nums">{items.length}</span>
        </div>
        {!isCollapsed ? (
          items.length === 0 ? (
            <div className="py-1 pl-7 text-[11px] text-ink-3">—</div>
          ) : tree ? (
            <div>
              {tree.folders.map((f) => renderFolderNode(key, f, 1))}
              {tree.rootBranches.map((b) => renderBranchRow(b, 1, b.name))}
            </div>
          ) : (
            <div>{items.map((b) => renderBranchRow(b, 1, b.name))}</div>
          )
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="git-branches-pane">
      {/* 顶部搜索与目录分组切换 */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-sidebar-border/60 bg-inset/25 px-2.5 py-2">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-3" />
            <Input
              size="xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('wb.git.branchesSearchPlaceholder')}
              data-testid="git-branches-search"
              className="pl-6"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={groupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
            title={groupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
            aria-pressed={groupByDir}
            onClick={() => setGroupByDir((v) => !v)}
            className={cn('shrink-0 text-ink-2 hover:bg-hover hover:text-ink', groupByDir && 'bg-hover text-ink')}
          >
            <FolderTreeIcon className="size-3.5" />
          </Button>
        </div>

        {!remoteReadOnly ? (
          <div className="flex items-center gap-1">
            <Input
              size="xs"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
              placeholder={t('wb.changes.newBranchPlaceholder')}
              data-testid="git-branches-new-input"
              disabled={busy}
              className="min-w-0 flex-1 font-mono"
            />
            <Button
              type="button"
              size="xs"
              variant="secondary"
              data-testid="git-branches-new-btn"
              disabled={busy || !newBranchName.trim()}
              onClick={handleCreate}
              className="shrink-0"
            >
              <PlusIcon className="size-3" />
              <span>{t('wb.changes.createBranch')}</span>
            </Button>
          </div>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 py-1.5">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-ink-3">{t('wb.git.branchesEmpty')}</div>
          ) : (
            <>
              {renderSection('local', t('wb.git.branchesLocal'), locals)}
              {renderSection('remote', t('wb.git.branchesRemote'), remotes)}
              {renderSection('tags', t('wb.git.branchesTags'), tags)}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

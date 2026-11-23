/**
 * 工作台右侧面板（WorkbenchRightPanel）：
 *
 * 包含「文件」与「Git」两个 Tabs 标签页：
 * - 文件：以目录树/搜索列表展示当前工作区文件（默认全部目录收起，按后缀显示对应图标），
 *   点击后在插件内置查看器中只读查看（不联动外部 IDE 编辑器），并叠加 Git 改动标记
 * - Git：复用 ChangesView 展示分支、未提交改动、内置 Diff 审阅、提交、推送与创建 PR
 * - 宽屏桌面（>=768px）：停靠在主内容区右侧；窄屏 / 移动端（<768px）：通过 shadcn/ui Sheet 右侧抽屉展开
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { FileCandidate, SourceControlFileView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '../../hooks/use-mobile.ts';
import { usePanelPresence } from '../../hooks/usePanelPresence.ts';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { requestPanelFiles, setRightPanelOpen, setRightPanelTab, useView, type RightPanelTab } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  FilesIcon,
  FileTypeIcon,
  GitBranchIcon,
  RefreshIcon,
  SearchIcon,
  TerminalIcon,
  VscodeFolderIcon,
  VscodeFolderOpenIcon,
} from '../icons.tsx';
import { ChangesView } from './ChangesView.tsx';

const LazyTerminalView = lazy(() => import('./TerminalView.tsx'));

interface FileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly children: FileTreeNode[];
}

function buildFileTree(items: readonly FileCandidate[]): readonly FileTreeNode[] {
  interface MutableDir {
    name: string;
    path: string;
    dirs: Map<string, MutableDir>;
    files: Map<string, FileTreeNode>;
  }

  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: new Map() };

  for (const item of items) {
    const normalized = item.path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
    if (!normalized) continue;
    const parts = normalized.split('/');
    let cursor = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const nodePath = parts.slice(0, i + 1).join('/');
      if (isLast && item.kind === 'file') {
        cursor.files.set(part, { name: part, path: normalized, kind: 'file', children: [] });
      } else {
        let next = cursor.dirs.get(part);
        if (!next) {
          next = { name: part, path: nodePath, dirs: new Map(), files: new Map() };
          cursor.dirs.set(part, next);
        }
        cursor = next;
      }
    }
  }

  const toNodes = (dir: MutableDir): FileTreeNode[] => {
    const dirNodes: FileTreeNode[] = [...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((sub) => ({
        name: sub.name,
        path: sub.path,
        kind: 'directory',
        children: toNodes(sub),
      }));
    const fileNodes: FileTreeNode[] = [...dir.files.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [...dirNodes, ...fileNodes];
  };

  return toNodes(root);
}

const STATUS_BADGE_MAP: Record<SourceControlFileView['status'], { readonly letter: string; readonly cls: string }> = {
  modified: { letter: 'M', cls: 'text-orange' },
  added: { letter: 'A', cls: 'text-green' },
  deleted: { letter: 'D', cls: 'text-red' },
  renamed: { letter: 'R', cls: 'text-accent-ink' },
  untracked: { letter: 'U', cls: 'text-green' },
  conflicted: { letter: '!', cls: 'text-red' },
};

export function WorkbenchRightPanel() {
  const t = useT();
  const isMobile = useIsMobile();
  const open = useView((s) => s.rightPanelOpen);
  const panelPresence = usePanelPresence(open);
  const tab = useView((s) => s.rightPanelTab);
  const sourceControl = useView((s) => s.workbench.sourceControl);
  const dirtyFiles = useView((s) => s.workspace.dirtyFiles);
  const terminalSessions = useView((s) => s.terminal.sessions);

  const changesCount = sourceControl?.available ? sourceControl.files.length : dirtyFiles;
  const runningTerminals = terminalSessions.filter((s) => s.running).length;

  const panelBody = (
    <Tabs
      value={tab}
      onValueChange={(v) => setRightPanelTab(v as RightPanelTab)}
      className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-2.5">
        <TabsList variant="line" className="h-9 gap-2 p-0">
          <TabsTrigger
            value="files"
            data-testid="right-panel-tab-files"
            className="h-9 flex-none gap-1.5 rounded-none px-2 text-[12.5px] after:bottom-0 after:bg-brand"
            onClick={() => setRightPanelTab('files')}
          >
            <FilesIcon className="size-3.5 shrink-0" />
            <span>{t('wb.rightPanel.files')}</span>
          </TabsTrigger>
          <TabsTrigger
            value="git"
            data-testid="right-panel-tab-git"
            className="h-9 flex-none gap-1.5 rounded-none px-2 text-[12.5px] after:bottom-0 after:bg-brand"
            onClick={() => setRightPanelTab('git')}
          >
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span>{t('wb.rightPanel.git')}</span>
            {changesCount > 0 ? (
              <span className="rounded-full bg-field px-1.5 text-[10.5px] font-medium text-ink-2 tabular-nums">
                {changesCount}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger
            value="terminal"
            data-testid="right-panel-tab-terminal"
            className="h-9 flex-none gap-1.5 rounded-none px-2 text-[12.5px] after:bottom-0 after:bg-brand"
            onClick={() => setRightPanelTab('terminal')}
          >
            <TerminalIcon className="size-3.5 shrink-0" />
            <span>{t('wb.rightPanel.terminal')}</span>
            {runningTerminals > 0 ? (
              <span className="rounded-full bg-green-tint px-1.5 text-[10.5px] font-medium text-green tabular-nums">
                {runningTerminals}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        {!isMobile ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="right-panel-close"
            aria-label={t('wb.rightPanel.close')}
            title={t('wb.rightPanel.close')}
            className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
            onClick={() => setRightPanelOpen(false)}
          >
            <CloseIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <TabsContent value="files" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
        <WorkspaceFilesPane />
      </TabsContent>
      <TabsContent value="git" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
        <ChangesView compact />
      </TabsContent>
      <TabsContent value="terminal" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
        {tab === 'terminal' ? (
          <Suspense fallback={<div className="p-4 text-[12px] text-ink-3">{t('thread.opening')}</div>}>
            <LazyTerminalView />
          </Suspense>
        ) : null}
      </TabsContent>
    </Tabs>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => setRightPanelOpen(next)}>
        <SheetContent
          side="right"
          className="flex w-[88vw] max-w-96 flex-col gap-0 bg-sidebar p-0"
          data-testid="workbench-right-panel"
        >
          <SheetHeader className="border-b border-sidebar-border px-3.5 py-2.5">
            <SheetTitle className="text-[13px]">{t('wb.rightPanel.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('wb.rightPanel.title')}</SheetDescription>
          </SheetHeader>
          {panelBody}
        </SheetContent>
      </Sheet>
    );
  }

  if (!panelPresence.mounted) return null;

  return (
    <aside
      aria-label={t('wb.rightPanel.title')}
      data-testid="workbench-right-panel"
      data-state={panelPresence.shown ? 'expanded' : 'collapsed'}
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden bg-sidebar transition-[width] duration-[260ms] ease-[var(--ease-drawer)]',
        panelPresence.shown ? 'w-80 border-l border-sidebar-border min-[1180px]:w-[360px]' : 'w-0',
      )}
    >
      <div
        className={cn(
          'flex h-full w-80 flex-col transition-transform duration-[260ms] ease-[var(--ease-drawer)] min-[1180px]:w-[360px]',
          panelPresence.shown ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {panelBody}
      </div>
    </aside>
  );
}

function WorkspaceFilesPane() {
  const t = useT();
  const isMobile = useIsMobile();
  const ready = useView((s) => s.ready);
  const panelFiles = useView((s) => s.panelFiles);
  const sourceControl = useView((s) => s.workbench.sourceControl);
  const activePreviewPath = useView((s) => (s.diffContent?.kind === 'file' ? s.diffContent.path.replace(/\\/gu, '/') : undefined));
  const [query, setQuery] = useState('');
  /** 目录默认全部收起，仅记录用户手动展开的目录路径。 */
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!ready) return;
    const trimmed = query.trim();
    if (!trimmed) {
      requestPanelFiles('');
      return;
    }
    const timer = setTimeout(() => {
      requestPanelFiles(trimmed);
    }, 150);
    return () => clearTimeout(timer);
  }, [ready, query]);

  const statusByPath = useMemo(() => {
    const map = new Map<string, SourceControlFileView['status']>();
    for (const file of sourceControl?.files ?? []) {
      map.set(file.path.replace(/\\/gu, '/'), file.status);
    }
    return map;
  }, [sourceControl?.files]);

  const tree = useMemo(() => buildFileTree(panelFiles.items), [panelFiles.items]);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));
  };

  const previewFile = (path: string) => {
    postToHost({ type: 'previewFile', payload: { path } });
    if (isMobile) setRightPanelOpen(false);
  };

  const trimmedQuery = query.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="right-panel-files">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-sidebar-border px-2.5 py-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('wb.rightPanel.filesSearch')}
            aria-label={t('wb.rightPanel.filesSearch')}
            data-testid="right-panel-files-search"
            className="bg-surface/90 pr-7 pl-8 text-[12px]"
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('common.close')}
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-ink-3 hover:bg-hover hover:text-ink"
            >
              <CloseIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          data-testid="right-panel-files-refresh"
          aria-label={t('wb.rightPanel.filesRefresh')}
          title={t('wb.rightPanel.filesRefresh')}
          onClick={() => requestPanelFiles(trimmedQuery)}
        >
          <RefreshIcon className="size-3.5" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {panelFiles.loading && panelFiles.items.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] text-ink-3">{t('wb.rightPanel.filesLoading')}</div>
        ) : panelFiles.items.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] text-ink-3">
            {trimmedQuery ? t('wb.rightPanel.filesNoMatch') : t('wb.rightPanel.filesEmpty')}
          </div>
        ) : trimmedQuery ? (
          <div className="flex flex-col gap-0.5" data-testid="right-panel-files-flat">
            {panelFiles.items.map((item) => {
              const normalized = item.path.replace(/\\/gu, '/');
              const slash = normalized.lastIndexOf('/');
              const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
              const dir = slash >= 0 ? normalized.slice(0, slash) : '';
              const status = statusByPath.get(normalized);
              const badge = status ? STATUS_BADGE_MAP[status] : undefined;
              const isSelected = item.kind === 'file' && activePreviewPath === normalized;
              return (
                <button
                  key={`${item.kind}:${normalized}`}
                  type="button"
                  title={normalized}
                  data-testid={`right-panel-file-${normalized}`}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover',
                    isSelected && 'bg-hover font-medium',
                  )}
                  onClick={() => {
                    if (item.kind === 'file') previewFile(normalized);
                  }}
                >
                  {item.kind === 'directory' ? (
                    <VscodeFolderIcon className="size-4 shrink-0" />
                  ) : (
                    <FileTypeIcon path={normalized} className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{name}</span>
                  {dir ? <span className="max-w-28 shrink-0 truncate font-mono text-[11px] text-ink-3">{dir}</span> : null}
                  {badge ? (
                    <span className={cn('shrink-0 font-mono text-[11px] font-semibold', badge.cls)}>{badge.letter}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5" data-testid="right-panel-files-tree">
            <FileTreeNodes
              nodes={tree}
              depth={0}
              expandedDirs={expandedDirs}
              activePreviewPath={activePreviewPath}
              statusByPath={statusByPath}
              onToggleDir={toggleDir}
              onPreviewFile={previewFile}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function FileTreeNodes({
  nodes,
  depth,
  expandedDirs,
  activePreviewPath,
  statusByPath,
  onToggleDir,
  onPreviewFile,
}: {
  readonly nodes: readonly FileTreeNode[];
  readonly depth: number;
  readonly expandedDirs: Readonly<Record<string, boolean>>;
  readonly activePreviewPath?: string;
  readonly statusByPath: ReadonlyMap<string, SourceControlFileView['status']>;
  readonly onToggleDir: (path: string) => void;
  readonly onPreviewFile: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'directory') {
          const expanded = Boolean(expandedDirs[node.path]);
          return (
            <div key={`dir:${node.path}`} className="flex flex-col">
              <button
                type="button"
                title={node.path}
                data-testid={`right-panel-dir-${node.path}`}
                aria-expanded={expanded}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                className="flex w-full items-center gap-1.5 rounded-control py-1 pr-2 text-left text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                onClick={() => onToggleDir(node.path)}
              >
                {expanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-ink-3" />
                )}
                {expanded ? (
                  <VscodeFolderOpenIcon className="size-4 shrink-0" />
                ) : (
                  <VscodeFolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              </button>
              {expanded && node.children.length > 0 ? (
                <FileTreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  expandedDirs={expandedDirs}
                  activePreviewPath={activePreviewPath}
                  statusByPath={statusByPath}
                  onToggleDir={onToggleDir}
                  onPreviewFile={onPreviewFile}
                />
              ) : null}
            </div>
          );
        }

        const status = statusByPath.get(node.path);
        const badge = status ? STATUS_BADGE_MAP[status] : undefined;
        const isSelected = activePreviewPath === node.path;
        return (
          <button
            key={`file:${node.path}`}
            type="button"
            title={node.path}
            data-testid={`right-panel-file-${node.path}`}
            style={{ paddingLeft: `${24 + depth * 14}px` }}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-control py-1 pr-2 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover',
              isSelected && 'bg-hover font-medium',
            )}
            onClick={() => onPreviewFile(node.path)}
          >
            <FileTypeIcon path={node.path} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {badge ? (
              <span className={cn('shrink-0 font-mono text-[11px] font-semibold', badge.cls)}>{badge.letter}</span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

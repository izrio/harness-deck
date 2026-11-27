/**
 * 工作台左侧栏（WorkbenchSidebar）：
 *
 * 顶部纵向呈现工作台核心模块导航（总览 / 任务 / 智能体 / 会话），
 * 在「会话」下方直接以扁平双行列表展示所有会话（不再按项目折叠分组），左下角固定放置「设置」入口。
 * - 宽屏桌面（>=768px）：固定左侧栏，可由顶栏按钮折叠/展开
 * - 窄屏 / 移动端（<768px）：通过 shadcn/ui Sheet 左侧抽屉承接完整导航、会话列表与设置入口
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { GroupedSessionItem, ProjectSessionGroup } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useIsMobile } from '../../hooks/use-mobile.ts';
import { usePanelPresence } from '../../hooks/usePanelPresence.ts';
import { useT, type MessageKey } from '../../i18n.ts';
import { relativeTime } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { requestCreateTask, setActiveModule, toggleSettingsPage, useView } from '../../store.ts';
import { loadState, postToHost, saveState } from '../../vscode.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import { CloudEnvironmentDialog } from '../CloudEnvironmentDialog.tsx';
import {
  ChatIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  ErrorIcon,
  FolderIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SlidersVerticalIcon,
  SpinnerIcon,
  TrashIcon,
  UsersIcon,
} from '../icons.tsx';

export const SIDEBAR_MODULES = ['overview', 'tasks', 'agents', 'sessions'] as const;
export type SidebarModule = (typeof SIDEBAR_MODULES)[number];

type SessionFilter = 'all' | 'running' | 'attention' | 'unread';

interface FallbackGroup extends ProjectSessionGroup {
  readonly isFallback?: boolean;
}

interface FlatSessionEntry {
  readonly session: GroupedSessionItem;
  readonly projectName: string;
  readonly isCurrentProject: boolean;
  readonly isFallback: boolean;
  readonly branch?: string;
}

export function WorkbenchSidebar({
  open = true,
  mobileOpen = false,
  onMobileOpenChange,
  onNewWorktree,
}: {
  readonly open?: boolean;
  readonly mobileOpen?: boolean;
  readonly onMobileOpenChange?: (open: boolean) => void;
  readonly onNewWorktree?: () => void;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const panelPresence = usePanelPresence(open);
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);
  const isMobileRemote = clientSurface === 'mobile-web';
  const remoteReadOnly = isMobileRemote && clientScope === 'read-only';
  const canManageCloud = !isMobileRemote || clientScope === 'owner';

  const activeModule = useView((s) => s.activeModule);
  const settingsOpen = useView((s) => s.settingsOpen);
  const session = useView((s) => s.session);
  const sessions = useView((s) => s.sessions);
  const backends = useView((s) => s.backends);
  const overview = useView((s) => s.workbench.overview);
  const tasks = useView((s) => s.workbench.tasks.items);
  const sessionGroups = useView((s) => s.workbench.sessionGroups);
  const sourceControl = useView((s) => s.workbench.sourceControl);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [projectsExpanded, setProjectsExpanded] = useState<boolean>(() => loadState().projectsExpanded ?? false);
  const [pendingDelete, setPendingDelete] = useState<GroupedSessionItem | undefined>(undefined);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  const overviewBadge = overview.waiting.length + overview.unread.length;
  const tasksActiveCount = tasks.filter((item) => item.status === 'in_progress' || item.status === 'review').length;

  const activeBackendId = backends.active;
  const activeBackendName = backends.items.find((b) => b.id === activeBackendId)?.name ?? activeBackendId;
  const currentSessionId = session.id;

  const effectiveGroups = useMemo<readonly FallbackGroup[]>(() => {
    if (sessionGroups.length > 0) return sessionGroups;
    if (sessions.length === 0) return [];
    return [
      {
        projectPath: '',
        projectName: t('wb.sessions.noProject'),
        isCurrent: true,
        isFallback: true,
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          projectPath: '',
          backendId: activeBackendId,
          backendName: activeBackendName,
          updatedAt: s.updatedAt,
          running: s.running,
          ...(s.needsAttention ? { needsAttention: true } : {}),
        })),
      },
    ];
  }, [sessionGroups, sessions, activeBackendId, activeBackendName, t]);

  const flatSessions = useMemo<readonly FlatSessionEntry[]>(() => {
    const activeBranch = sourceControl?.available ? sourceControl.branch : undefined;
    const list: FlatSessionEntry[] = [];
    for (const group of effectiveGroups) {
      for (const item of group.sessions) {
        const branch = item.branch ?? (group.isCurrent ? activeBranch : undefined);
        list.push({
          session: item,
          projectName: group.projectName,
          isCurrentProject: group.isCurrent,
          isFallback: Boolean(group.isFallback),
          ...(branch ? { branch } : {}),
        });
      }
    }
    list.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return list;
  }, [effectiveGroups, sourceControl]);

  const totalSessions = flatSessions.length;
  const q = query.trim().toLowerCase();

  const visibleSessions = useMemo(() => {
    const matchesFilter = (item: GroupedSessionItem) => {
      if (sessionFilter === 'running') return item.running;
      if (sessionFilter === 'attention') return Boolean(item.needsAttention);
      if (sessionFilter === 'unread') return Boolean(item.unread);
      return true;
    };

    return flatSessions.filter((entry) => {
      const { session: item, projectName, branch } = entry;
      if (!matchesFilter(item)) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        projectName.toLowerCase().includes(q) ||
        (branch?.toLowerCase().includes(q) ?? false) ||
        item.backendName.toLowerCase().includes(q) ||
        (item.agentName?.toLowerCase().includes(q) ?? false) ||
        (item.model?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [flatSessions, q, sessionFilter]);

  const toggleProjectsSection = () => {
    setProjectsExpanded((prev) => {
      const next = !prev;
      saveState({ projectsExpanded: next });
      return next;
    });
  };

  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = SIDEBAR_MODULES.indexOf(activeModule as SidebarModule);
    if (idx < 0) return;
    let nextIdx = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') nextIdx = (idx + 1) % SIDEBAR_MODULES.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') nextIdx = (idx - 1 + SIDEBAR_MODULES.length) % SIDEBAR_MODULES.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = SIDEBAR_MODULES.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const nextMod = SIDEBAR_MODULES[nextIdx]!;
    setActiveModule(nextMod);
    tabRefs.current[nextIdx]?.focus();
  };

  const renderModuleIcon = (mod: SidebarModule) => {
    switch (mod) {
      case 'overview':
        return <LayoutDashboardIcon className="size-4 shrink-0" />;
      case 'agents':
        return <UsersIcon className="size-4 shrink-0" />;
      case 'tasks':
        return <ListTodoIcon className="size-4 shrink-0" />;
      case 'sessions':
        return <ChatIcon className="size-4 shrink-0" />;
    }
  };

  const filterLabelKey: Record<SessionFilter, MessageKey> = {
    all: 'wb.sessions.filterAll',
    running: 'wb.sessions.filterRunning',
    attention: 'wb.sessions.filterAttention',
    unread: 'wb.sessions.filterUnread',
  };

  const renderSidebarInner = (onPicked?: () => void) => (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* 顶部工作台模块导航（总览 / 定时 / 智能体 / 任务 / 项目） */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('wb.nav.label')}
        data-testid="workbench-nav"
        onKeyDown={onNavKeyDown}
        className="flex shrink-0 flex-col gap-0.5 px-2.5 pt-2.5 pb-1"
      >
        {SIDEBAR_MODULES.map((mod, index) => {
          const active = !settingsOpen && activeModule === mod;
          return (
            <div
              key={mod}
              className={cn(
                'group/nav-row flex items-center rounded-control transition-colors duration-100',
                active
                  ? 'bg-surface text-ink shadow-hairline'
                  : 'text-ink-2 hover:bg-hover hover:text-ink',
              )}
            >
              <button
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`workbench-tab-${mod}`}
                data-testid={`workbench-tab-${mod}`}
                aria-selected={active}
                aria-controls={`workbench-panel-${mod}`}
                tabIndex={activeModule === mod ? 0 : -1}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left text-[13px] leading-5"
                onClick={() => {
                  if (mod === 'sessions') {
                    if (active) {
                      toggleProjectsSection();
                    } else {
                      setActiveModule('sessions');
                      if (!projectsExpanded) toggleProjectsSection();
                    }
                    return;
                  }
                  setActiveModule(mod);
                  onPicked?.();
                }}
              >
                <span className={cn('inline-flex size-4 shrink-0 items-center justify-center', active ? 'text-ink' : 'text-ink-2')}>
                  {renderModuleIcon(mod)}
                </span>
                <span className={cn('truncate', active ? 'font-medium text-ink' : 'font-normal')}>
                  {t(`wb.nav.${mod}` as MessageKey)}
                </span>

                {mod === 'overview' && overviewBadge > 0 ? (
                  <span
                    data-testid="overview-badge"
                    className={cn(
                      'ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums',
                      overview.waiting.length > 0
                        ? 'bg-orange-tint text-orange ring-1 ring-inset ring-orange/35'
                        : 'bg-accent-tint text-accent-ink ring-1 ring-inset ring-accent/30',
                    )}
                  >
                    {overviewBadge}
                  </span>
                ) : null}

                {mod === 'tasks' && tasksActiveCount > 0 ? (
                  <span className="text-[11.5px] leading-4 font-normal text-ink-3 tabular-nums">{tasksActiveCount}</span>
                ) : null}

                {mod === 'sessions' && totalSessions > 0 ? (
                  <span className="text-[11.5px] leading-4 font-normal text-ink-3 tabular-nums">{totalSessions}</span>
                ) : null}
              </button>

              {mod === 'tasks' ? (
                <div className="flex shrink-0 items-center pr-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-testid="sidebar-new-task-btn"
                    aria-label={t('wb.tasks.new')}
                    title={t('wb.tasks.new')}
                    className="text-ink-2 hover:bg-hover-2 hover:text-ink"
                    onClick={() => {
                      requestCreateTask();
                      onPicked?.();
                    }}
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>
                </div>
              ) : null}

              {mod === 'sessions' ? (
                <div className="flex shrink-0 items-center gap-1 pr-1.5">
                  <Button
                    type="button"
                    variant={searchOpen || query ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    data-testid="sidebar-search-toggle"
                    aria-label={t('header.search')}
                    aria-pressed={searchOpen}
                    title={t('header.search')}
                    className="text-ink-2 hover:bg-hover-2 hover:text-ink"
                    onClick={() => {
                      if (searchOpen && !query) {
                        setSearchOpen(false);
                      } else if (searchOpen) {
                        searchInputRef.current?.focus();
                      } else {
                        setSearchOpen(true);
                      }
                    }}
                  >
                    <SearchIcon className="size-3.5" />
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant={sessionFilter !== 'all' ? 'secondary' : 'ghost'}
                        size="icon-xs"
                        data-testid="sidebar-session-filter-btn"
                        aria-label={t('wb.sessions.filter')}
                        title={t('wb.sessions.filter')}
                        className="text-ink-2 hover:bg-hover-2 hover:text-ink"
                      >
                        <SlidersVerticalIcon className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      {(['all', 'running', 'attention', 'unread'] as const).map((filter) => (
                        <DropdownMenuItem
                          key={filter}
                          data-testid={`sidebar-filter-${filter}`}
                          className="gap-2 text-[12px]"
                          onSelect={() => setSessionFilter(filter)}
                        >
                          <span className="flex-1">{t(filterLabelKey[filter])}</span>
                          {sessionFilter === filter ? <CheckIcon className="size-3.5 text-accent-ink" /> : null}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      {!isMobileRemote ? (
                        <DropdownMenuItem
                          data-testid="sidebar-add-project-item"
                          className="gap-2 text-[12px]"
                          onSelect={() => postToHost({ type: 'addRecentProject', payload: {} })}
                        >
                          <FolderIcon className="size-3.5 text-ink-2" />
                          <span>{t('wb.sessions.addProject')}</span>
                        </DropdownMenuItem>
                      ) : null}
                      {canManageCloud ? (
                        <DropdownMenuItem
                          data-testid="sidebar-connect-cloud-item"
                          className="gap-2 text-[12px]"
                          onSelect={() => setCloudDialogOpen(true)}
                        >
                          <CloudIcon className="size-3.5 text-accent-ink" />
                          <span>{t('composer.connectCloud')}</span>
                        </DropdownMenuItem>
                      ) : null}
                      {onNewWorktree ? (
                        <DropdownMenuItem
                          disabled={remoteReadOnly}
                          data-testid="sidebar-worktree-session-item"
                          className="gap-2 text-[12px]"
                          onSelect={() => {
                            onNewWorktree();
                            onPicked?.();
                          }}
                        >
                          <GitBranchIcon className="size-3.5 text-ink-2" />
                          <span>{t('wb.sessions.worktreeSession')}</span>
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={remoteReadOnly}
                    data-testid="sidebar-new-session-btn"
                    aria-label={t('header.new')}
                    title={t('header.newTab')}
                    className="text-ink-2 hover:bg-hover-2 hover:text-ink"
                    onClick={() => {
                      setActiveModule('sessions');
                      postToHost({ type: 'newSession', payload: {} });
                      onPicked?.();
                    }}
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-testid="sidebar-projects-toggle"
                    aria-expanded={projectsExpanded || q.length > 0 || sessionFilter !== 'all'}
                    aria-label={t('wb.sessions.toggleProjects')}
                    title={t('wb.sessions.toggleProjects')}
                    className="text-ink-2 hover:bg-hover-2 hover:text-ink"
                    onClick={toggleProjectsSection}
                  >
                    <ChevronRightIcon
                      data-testid="sidebar-projects-chevron"
                      className={cn(
                        'size-3.5 transition-transform duration-150',
                        (projectsExpanded || q.length > 0 || sessionFilter !== 'all') && 'rotate-90',
                      )}
                    />
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 会话搜索输入栏（点击搜索图标展开） */}
      {searchOpen || query ? (
        <div className="relative shrink-0 px-3 pt-1 pb-1.5">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            ref={searchInputRef}
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                setSearchOpen(false);
              }
            }}
            placeholder={t('header.search')}
            aria-label={t('header.search')}
            data-testid="sidebar-search-input"
            className="bg-surface/90 pr-7 pl-8 text-[12px]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('common.close')}
            onClick={() => {
              setQuery('');
              setSearchOpen(false);
            }}
            className="absolute top-1/2 right-4 -translate-y-1/2 text-ink-3 hover:bg-hover hover:text-ink"
          >
            <CloseIcon className="size-3" />
          </Button>
        </div>
      ) : null}

      {/* 当前生效筛选状态条（提供一键清除入口） */}
      {sessionFilter !== 'all' ? (
        <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-0.5 pb-1 text-[11.5px] text-ink-2">
          <span>
            {t('wb.sessions.filter')}：{t(filterLabelKey[sessionFilter])}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="sidebar-clear-filter"
            onClick={() => setSessionFilter('all')}
          >
            {t('wb.sessions.clearFilter')}
          </Button>
        </div>
      ) : null}

      {/* 扁平会话列表：直接承接在「会话」大菜单下方，受展开/收起控制，不再按项目折叠分组 */}
      <SidebarContent className="gap-1 px-2.5 pt-0.5 pb-3">
        {projectsExpanded || q.length > 0 || sessionFilter !== 'all' ? (
          flatSessions.length === 0 ? (
            <div className="px-2.5 py-4 text-[12px] text-ink-3">{t('wb.sessions.noSessions')}</div>
          ) : visibleSessions.length === 0 ? (
            <div className="px-2.5 py-6 text-center text-[12px] text-ink-3">{t('header.noMatch')}</div>
          ) : (
            <SidebarMenu className="gap-1.5">
              {visibleSessions.map((entry) => {
                const { session: sess, projectName, isCurrentProject, isFallback, branch } = entry;
                const isActiveRow =
                  activeModule === 'sessions' &&
                  !settingsOpen &&
                  isCurrentProject &&
                  sess.id === currentSessionId &&
                  sess.backendId === activeBackendId;
                return (
                  <SessionListItemRow
                    key={`${sess.backendId}:${sess.id}`}
                    session={sess}
                    projectName={projectName}
                    {...(branch ? { branch } : {})}
                    isFallback={isFallback}
                    isActiveRow={isActiveRow}
                    onRequestDelete={setPendingDelete}
                    {...(onPicked ? { onPicked } : {})}
                  />
                );
              })}
            </SidebarMenu>
          )
        ) : null}
      </SidebarContent>

      {/* 左下角固定设置入口 */}
      <SidebarFooter className="mt-auto shrink-0 border-t border-sidebar-border px-2.5 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="settings-button"
          aria-label={t('header.settings')}
          title={t('header.settings')}
          aria-pressed={settingsOpen}
          onClick={() => {
            toggleSettingsPage();
            onPicked?.();
          }}
          className={cn(
            'w-full justify-start gap-2.5 rounded-control px-2.5 text-[13px] font-normal',
            settingsOpen
              ? 'bg-surface font-medium text-ink shadow-hairline hover:bg-surface dark:bg-white/[0.07]'
              : 'text-ink-2 hover:bg-hover hover:text-ink',
          )}
        >
          <SettingsIcon className="size-4 shrink-0" />
          <span className="truncate">{t('header.settings')}</span>
        </Button>
      </SidebarFooter>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <Sheet open={mobileOpen} onOpenChange={(next) => onMobileOpenChange?.(next)}>
          <SheetContent
            side="left"
            className="flex w-[86vw] max-w-76 flex-col gap-0 bg-sidebar p-0"
            data-testid="mobile-sessions-sheet"
          >
            <SheetHeader className="border-b border-sidebar-border px-3.5 py-2.5">
              <SheetTitle className="text-[13px]">{t('wb.sidebar.title')}</SheetTitle>
              <SheetDescription className="sr-only">{t('wb.nav.label')}</SheetDescription>
            </SheetHeader>
            {renderSidebarInner(() => onMobileOpenChange?.(false))}
          </SheetContent>
        </Sheet>
      ) : panelPresence.mounted ? (
        <Sidebar
          collapsible="none"
          aria-label={t('wb.sidebar.title')}
          data-testid="project-sessions-sidebar"
          data-state={panelPresence.shown ? 'expanded' : 'collapsed'}
          style={
            {
              '--sidebar-width': panelPresence.shown ? '16rem' : '0px',
            } as CSSProperties
          }
          className={cn(
            'h-full shrink-0 overflow-hidden border-r transition-[width,border-color] duration-[260ms] ease-[var(--ease-drawer)] will-change-[width]',
            panelPresence.shown ? 'border-sidebar-border' : 'border-transparent',
          )}
        >
          <div
            className={cn(
              'flex h-full min-h-0 w-64 flex-col transition-[transform,opacity] duration-[260ms] ease-[var(--ease-drawer)] will-change-transform',
              panelPresence.shown ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0',
            )}
          >
            {renderSidebarInner()}
          </div>
        </Sidebar>
      ) : null}

      <Dialog open={pendingDelete !== undefined} onOpenChange={(next) => !next && setPendingDelete(undefined)}>
        <DialogContent data-testid="delete-session-dialog" className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-[14px]">{t('wb.sessions.deleteTitle')}</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-relaxed">
              {t('wb.sessions.deleteHint', pendingDelete?.title ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setPendingDelete(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="delete-session-confirm"
              onClick={() => {
                if (!pendingDelete) return;
                postToHost({
                  type: 'deleteProjectSession',
                  payload: { sessionId: pendingDelete.id, backendId: pendingDelete.backendId },
                });
                setPendingDelete(undefined);
              }}
            >
              <TrashIcon className="size-3.5" />
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CloudEnvironmentDialog open={cloudDialogOpen} onOpenChange={setCloudDialogOpen} />
    </>
  );
}

function SessionListItemRow({
  session,
  projectName,
  branch,
  isFallback,
  isActiveRow,
  onRequestDelete,
  onPicked,
}: {
  readonly session: GroupedSessionItem;
  readonly projectName: string;
  readonly branch?: string;
  readonly isFallback: boolean;
  readonly isActiveRow: boolean;
  readonly onRequestDelete: (session: GroupedSessionItem) => void;
  readonly onPicked?: () => void;
}) {
  const t = useT();
  const canDelete = !session.running && !isFallback;
  const deleteTitle = session.running ? t('wb.sessions.deleteRunning') : t('wb.sessions.deleteSession');
  const projectBranchLabel = branch ? `${projectName}/${branch}` : projectName;
  const statusKind = session.needsAttention
    ? 'attention'
    : session.running
      ? 'running'
      : session.unread
        ? 'unread'
        : undefined;
  const statusLabel =
    statusKind === 'attention'
      ? t('wb.sessions.statusWaiting')
      : statusKind === 'running'
        ? t('wb.sessions.statusRunning')
        : statusKind === 'unread'
          ? t('wb.sessions.filterUnread')
          : undefined;

  const openSession = () => {
    setActiveModule('sessions');
    if (isFallback) {
      postToHost({ type: 'switchSession', payload: { sessionId: session.id } });
    } else {
      postToHost({
        type: 'openProjectSession',
        payload: {
          projectPath: session.projectPath,
          sessionId: session.id,
          backendId: session.backendId,
        },
      });
    }
    onPicked?.();
  };

  const buttonNode = (
    <SidebarMenuButton
      type="button"
      isActive={isActiveRow}
      data-testid={`grouped-session-${session.id}`}
      title={session.title}
      className={cn(
        'h-auto items-start rounded-control px-2.5 py-2 transition-colors duration-100 group-has-data-[sidebar=menu-action]/menu-item:pr-2.5',
        isActiveRow
          ? 'bg-surface text-ink shadow-hairline hover:bg-surface data-[active=true]:bg-surface data-[active=true]:text-ink dark:bg-white/[0.07] dark:hover:bg-white/[0.08] dark:data-[active=true]:bg-white/[0.07]'
          : 'text-ink-2 hover:bg-hover hover:text-ink',
      )}
      onClick={openSession}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* 第一行：状态标识 + 会话标题（左）+ 相对时间（右，悬停可删除时淡出让位给删除按钮） */}
        <div className="flex w-full min-w-0 items-center gap-1.5">
          {statusKind ? (
            <span
              className="inline-flex shrink-0 items-center justify-center"
              data-testid={`session-status-${session.id}`}
              data-status={statusKind}
              title={statusLabel}
              aria-label={statusLabel}
            >
              {statusKind === 'attention' ? (
                <ErrorIcon className="size-3.5 text-orange" aria-hidden="true" />
              ) : statusKind === 'running' ? (
                <SpinnerIcon className="size-3.5 text-accent-ink" aria-hidden="true" />
              ) : (
                <span className="size-1.5 rounded-full bg-accent-ink" aria-hidden="true" />
              )}
            </span>
          ) : null}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-snug',
              isActiveRow ? 'font-medium text-ink' : 'font-normal text-ink/90',
            )}
          >
            {session.title}
          </span>

          {session.updatedAt > 0 ? (
            <span
              className={cn(
                'shrink-0 text-[11.5px] leading-snug text-ink-3 tabular-nums transition-opacity duration-100',
                canDelete && 'group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0',
              )}
            >
              {relativeTime(session.updatedAt, t)}
            </span>
          ) : null}
        </div>

        {/* 第二行：项目/分支（左）+ 模型/底层图标（右，不展示具体模型名） */}
        <div className="flex w-full min-w-0 items-center justify-between gap-2 text-[11.5px] leading-snug text-ink-3">
          <span
            className="min-w-0 flex-1 truncate"
            title={projectBranchLabel}
            data-testid={`session-project-branch-${session.id}`}
          >
            {projectBranchLabel}
          </span>

          <span
            className="inline-flex size-4 shrink-0 items-center justify-center"
            data-testid={`session-model-icon-${session.id}`}
            title={session.agentName ? `${session.backendName} · ${session.agentName}` : session.backendName}
          >
            <BackendLogo backend={{ id: session.backendId, name: session.backendName }} size="sm" />
            <span className="sr-only">{session.backendName}</span>
          </span>
        </div>
      </div>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem className="group/menu-item relative">
      {isFallback ? (
        buttonNode
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{buttonNode}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem variant="destructive" disabled={!canDelete} onSelect={() => onRequestDelete(session)}>
              <TrashIcon />
              {deleteTitle}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {!isFallback ? (
        <SidebarMenuAction
          disabled={!canDelete}
          title={deleteTitle}
          aria-label={deleteTitle}
          data-testid={`delete-session-${session.id}`}
          className={cn(
            'top-2 right-1.5 text-ink-3 hover:bg-hover-2 hover:text-ink',
            canDelete
              ? 'opacity-0 focus-visible:opacity-100 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100'
              : 'hidden',
          )}
          onClick={() => onRequestDelete(session)}
        >
          <TrashIcon />
        </SidebarMenuAction>
      ) : null}
    </SidebarMenuItem>
  );
}

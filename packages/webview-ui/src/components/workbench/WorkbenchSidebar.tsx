/**
 * 工作台左侧栏（WorkbenchSidebar）：
 *
 * 顶部纵向呈现工作台核心模块导航（总览 / 定时 / 智能体 / 任务 / 项目），
 * 在「项目」下方直接以树形结构展示各项目的会话列表，左下角固定放置「设置」入口。
 * - 宽屏桌面（>=768px）：固定左侧栏，可由顶栏按钮折叠/展开
 * - 窄屏 / 移动端（<768px）：通过 shadcn/ui Sheet 左侧抽屉承接完整导航、项目列表与设置入口
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
  SidebarGroup,
  SidebarGroupContent,
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
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SlidersVerticalIcon,
  TrashIcon,
  UsersIcon,
} from '../icons.tsx';

export const SIDEBAR_MODULES = ['overview', 'tasks', 'agents', 'sessions'] as const;
export type SidebarModule = (typeof SIDEBAR_MODULES)[number];

type SessionFilter = 'all' | 'running' | 'attention' | 'unread';

interface FallbackGroup extends ProjectSessionGroup {
  readonly isFallback?: boolean;
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

  const activeModule = useView((s) => s.activeModule);
  const settingsOpen = useView((s) => s.settingsOpen);
  const session = useView((s) => s.session);
  const sessions = useView((s) => s.sessions);
  const backends = useView((s) => s.backends);
  const overview = useView((s) => s.workbench.overview);
  const tasks = useView((s) => s.workbench.tasks.items);
  const sessionGroups = useView((s) => s.workbench.sessionGroups);
  const currentModelLabel = useView((s) => {
    const current = s.models.current;
    if (!current) return undefined;
    return s.models.options.find((o) => o.provider === current.provider && o.model === current.model)?.name ?? current.model;
  });

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [projectsExpanded, setProjectsExpanded] = useState<boolean>(() => loadState().projectsExpanded ?? false);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>(() => ({
    ...(loadState().expandedProjectPaths ?? {}),
  }));
  const [pendingDelete, setPendingDelete] = useState<GroupedSessionItem | undefined>(undefined);

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

  const totalSessions = useMemo(
    () => effectiveGroups.reduce((sum, g) => sum + g.sessions.length, 0),
    [effectiveGroups],
  );

  const q = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    const matchesFilter = (item: GroupedSessionItem) => {
      if (sessionFilter === 'running') return item.running;
      if (sessionFilter === 'attention') return Boolean(item.needsAttention);
      if (sessionFilter === 'unread') return Boolean(item.unread);
      return true;
    };

    return effectiveGroups
      .map((group) => {
        const groupNameMatches = !q || group.projectName.toLowerCase().includes(q);
        const filteredSessions = group.sessions.filter((item) => {
          if (!matchesFilter(item)) return false;
          if (!q) return true;
          return (
            item.title.toLowerCase().includes(q) ||
            group.projectName.toLowerCase().includes(q) ||
            item.backendName.toLowerCase().includes(q) ||
            (item.agentName?.toLowerCase().includes(q) ?? false) ||
            (item.model?.toLowerCase().includes(q) ?? false)
          );
        });
        const visible =
          sessionFilter !== 'all'
            ? filteredSessions.length > 0
            : q
              ? groupNameMatches || filteredSessions.length > 0
              : true;
        return { group, filteredSessions, visible };
      })
      .filter((entry) => entry.visible);
  }, [effectiveGroups, q, sessionFilter]);

  const toggleProjectsSection = () => {
    setProjectsExpanded((prev) => {
      const next = !prev;
      saveState({ projectsExpanded: next });
      return next;
    });
  };

  const toggleGroup = (path: string) => {
    setExpandedPaths((prev) => {
      const next = { ...prev, [path]: !prev[path] };
      saveState({ expandedProjectPaths: next });
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
        return <FolderTreeIcon className="size-4 shrink-0" />;
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
                    className={cn(
                      'ml-auto inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-brand-foreground tabular-nums',
                      overview.waiting.length > 0 ? 'bg-orange' : 'bg-brand',
                    )}
                  >
                    {overviewBadge}
                  </span>
                ) : null}

                {mod === 'tasks' && tasksActiveCount > 0 ? (
                  <span className="text-[11.5px] font-normal text-ink-3 tabular-nums">{tasksActiveCount}</span>
                ) : null}

                {mod === 'sessions' && totalSessions > 0 ? (
                  <span className="text-[12px] font-normal text-ink-3 tabular-nums">{totalSessions}</span>
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
                <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
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

      {/* 项目会话树：直接承接在「项目」大菜单下方，受「项目」大菜单展开/收起控制 */}
      <SidebarContent className="gap-1 px-2.5 pt-0.5 pb-3">
        {projectsExpanded || q.length > 0 || sessionFilter !== 'all' ? (
          effectiveGroups.length === 0 ? (
            <div className="px-2.5 py-4 text-[12px] text-ink-3">{t('wb.sessions.noSessions')}</div>
          ) : visibleGroups.length === 0 ? (
            <div className="px-2.5 py-6 text-center text-[12px] text-ink-3">{t('header.noMatch')}</div>
          ) : (
            visibleGroups.map(({ group, filteredSessions }) => {
              const groupKey = group.projectPath || '__no_project__';
              const hasFilter = q.length > 0 || sessionFilter !== 'all';
              const collapsed = hasFilter ? false : !expandedPaths[groupKey];
              return (
                <ProjectSessionGroupBlock
                  key={groupKey}
                  group={group}
                  filteredSessions={filteredSessions}
                  collapsed={collapsed}
                  hasFilter={hasFilter}
                  currentSessionId={currentSessionId}
                  activeBackendId={activeBackendId}
                  isSessionsModule={activeModule === 'sessions' && !settingsOpen}
                  currentModelLabel={currentModelLabel}
                  remoteReadOnly={remoteReadOnly}
                  onToggle={() => toggleGroup(groupKey)}
                  onRequestDelete={setPendingDelete}
                  {...(onPicked ? { onPicked } : {})}
                />
              );
            })
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
          className={cn(
            'h-full shrink-0 overflow-hidden transition-[width] duration-[260ms] ease-[var(--ease-drawer)]',
            panelPresence.shown ? 'w-64 border-r border-sidebar-border' : 'w-0',
          )}
        >
          <div
            className={cn(
              'flex h-full min-h-0 w-64 flex-col transition-transform duration-[260ms] ease-[var(--ease-drawer)]',
              panelPresence.shown ? 'translate-x-0' : '-translate-x-full',
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
    </>
  );
}

function ProjectSessionGroupBlock({
  group,
  filteredSessions,
  collapsed,
  hasFilter,
  currentSessionId,
  activeBackendId,
  isSessionsModule,
  currentModelLabel,
  remoteReadOnly,
  onToggle,
  onRequestDelete,
  onPicked,
}: {
  readonly group: FallbackGroup;
  readonly filteredSessions: readonly GroupedSessionItem[];
  readonly collapsed: boolean;
  readonly hasFilter: boolean;
  readonly currentSessionId: string | undefined;
  readonly activeBackendId: string;
  readonly isSessionsModule: boolean;
  readonly currentModelLabel: string | undefined;
  readonly remoteReadOnly: boolean;
  readonly onToggle: () => void;
  readonly onRequestDelete: (session: GroupedSessionItem) => void;
  readonly onPicked?: () => void;
}) {
  const t = useT();

  return (
    <SidebarGroup className="gap-0.5 p-0" data-testid={`project-group-${group.projectName}`}>
      <div className="group/project flex items-center rounded-control transition-colors duration-100 hover:bg-hover">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left"
          onClick={onToggle}
          title={group.projectPath || group.projectName}
          aria-expanded={!collapsed}
        >
          <FolderIcon className={cn('size-4 shrink-0', collapsed ? 'text-ink-3' : 'text-ink-2')} />
          <span className="truncate text-[13px] font-normal text-ink-2">{group.projectName}</span>
          <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{filteredSessions.length}</span>
        </button>

        {!group.isFallback && !remoteReadOnly ? (
          <div className="flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity duration-100 group-focus-within/project:opacity-100 group-hover/project:opacity-100">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid={`project-new-session-${group.projectName}`}
              title={t('wb.sessions.newInProject')}
              aria-label={`${group.projectName} · ${t('wb.sessions.newInProject')}`}
              className="text-ink-2 hover:bg-hover-2 hover:text-ink"
              onClick={() => {
                setActiveModule('sessions');
                postToHost({
                  type: 'startProjectSession',
                  payload: { projectPath: group.projectPath, backendId: activeBackendId },
                });
                onPicked?.();
              }}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <SidebarGroupContent className="relative before:pointer-events-none before:absolute before:top-0 before:bottom-1 before:left-[18px] before:w-px before:bg-sidebar-border">
          {filteredSessions.length === 0 ? (
            <div className="py-1.5 pr-2.5 pl-[42px] text-[11.5px] text-ink-3">
              {hasFilter && group.sessions.length > 0 ? t('header.noMatch') : t('wb.sessions.noSessions')}
            </div>
          ) : (
            <SidebarMenu className="gap-0.5">
              {filteredSessions.map((sess) => (
                <SessionListItemRow
                  key={`${sess.backendId}:${sess.id}`}
                  session={sess}
                  isFallback={Boolean(group.isFallback)}
                  isCurrent={group.isCurrent && sess.id === currentSessionId && sess.backendId === activeBackendId}
                  isActiveRow={
                    isSessionsModule &&
                    group.isCurrent &&
                    sess.id === currentSessionId &&
                    sess.backendId === activeBackendId
                  }
                  currentModelLabel={currentModelLabel}
                  onRequestDelete={onRequestDelete}
                  {...(onPicked ? { onPicked } : {})}
                />
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      ) : null}
    </SidebarGroup>
  );
}

function SessionListItemRow({
  session,
  isFallback,
  isCurrent,
  isActiveRow,
  currentModelLabel,
  onRequestDelete,
  onPicked,
}: {
  readonly session: GroupedSessionItem;
  readonly isFallback: boolean;
  readonly isCurrent: boolean;
  readonly isActiveRow: boolean;
  readonly currentModelLabel?: string | undefined;
  readonly onRequestDelete: (session: GroupedSessionItem) => void;
  readonly onPicked?: () => void;
}) {
  const t = useT();
  const modelLabel = session.model ?? (isCurrent ? currentModelLabel : undefined);
  const canDelete = !session.running && !isFallback;
  const deleteTitle = session.running ? t('wb.sessions.deleteRunning') : t('wb.sessions.deleteSession');

  const statusText = session.running
    ? t('wb.sessions.statusRunning')
    : session.needsAttention
      ? t('wb.sessions.statusWaiting')
      : t('wb.sessions.statusIdle');

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
        'h-auto items-start gap-2.5 rounded-control px-2.5 py-1.5 transition-colors duration-100 group-has-data-[sidebar=menu-action]/menu-item:pr-2.5',
        isActiveRow
          ? 'bg-surface text-ink shadow-hairline hover:bg-surface data-[active=true]:bg-surface data-[active=true]:text-ink dark:bg-white/[0.07] dark:hover:bg-white/[0.08] dark:data-[active=true]:bg-white/[0.07]'
          : 'text-ink-2 hover:bg-hover hover:text-ink',
      )}
      onClick={openSession}
    >
      {/* 图标与上方文件夹和菜单图标保持同一垂直基准线，覆盖在树形引导线上 */}
      <span
        className={cn(
          'relative z-10 mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full',
          isActiveRow ? 'bg-surface' : 'bg-sidebar group-hover/menu-item:bg-hover',
        )}
        title={session.agentName ? `${session.backendName} · ${session.agentName}` : session.backendName}
      >
        <BackendLogo backend={{ id: session.backendId, name: session.backendName }} size="sm" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex w-full min-w-0 items-center gap-1.5">
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

        <div className="flex w-full min-w-0 items-center gap-1 text-[11.5px] leading-snug text-ink-3">
          <span
            className={cn(
              'shrink-0',
              session.running ? 'text-accent-ink' : session.needsAttention ? 'text-orange' : 'text-ink-3',
            )}
          >
            {statusText}
          </span>
          {modelLabel ? (
            <span className="min-w-0 truncate" title={modelLabel}>
              · {modelLabel}
            </span>
          ) : null}
          <span className="sr-only">{session.backendName}</span>
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
            'top-1.5 right-1.5 text-ink-3 hover:bg-hover-2 hover:text-ink',
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

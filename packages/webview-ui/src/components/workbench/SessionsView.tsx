/**
 * 工作台 · 会话模块（SessionsView）
 *
 * 使用 shadcn/ui Sidebar 架构按项目分组展示会话列表：
 * - 无嵌套卡片边框，让会话标题拥有完整水平空间
 * - 双行会话条目：主行展示状态与完整标题，次行展示底层智能体标识与相对时间
 * - 右侧（窄屏为下方）承载完整的标签栏、运行状态栏、对话消息流与输入框
 */
import { Fragment, useState, type ReactNode } from 'react';
import type { GroupedSessionItem, ProjectSessionGroup } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { useT } from '../../i18n.ts';
import { relativeTime } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { useView } from '../../store.ts';
import { loadState, postToHost, saveState } from '../../vscode.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import { ValuePill } from '../beautifului/index.ts';
import {
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  SpinnerIcon,
} from '../icons.tsx';

export function SessionsView({
  hidden,
  children,
}: {
  readonly hidden?: boolean;
  readonly children: ReactNode;
}) {
  const t = useT();
  const sessionGroups = useView((s) => s.workbench.sessionGroups);
  const currentSessionId = useView((s) => s.session.id);
  const activeBackendId = useView((s) => s.backends.active);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return loadState().sessionsSidebarOpen ?? true;
    } catch {
      return true;
    }
  });
  const [query, setQuery] = useState('');
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try {
      saveState({ sessionsSidebarOpen: next });
    } catch {
      // ignore in test env
    }
  };

  const toggleGroup = (path: string) => {
    setCollapsedPaths((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  // 当没有 workbench.sessionGroups（例如纯 ChatController 独立测试环境）时，保持原有单栏纯净布局
  if (sessionGroups.length === 0) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')} aria-hidden={hidden || undefined}>
        {children}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const totalSessions = sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0);
  const visibleGroups = sessionGroups
    .map((group) => {
      const groupMatches = !q || group.projectName.toLowerCase().includes(q);
      const filteredSessions = q
        ? group.sessions.filter(
            (s) =>
              s.title.toLowerCase().includes(q) ||
              group.projectName.toLowerCase().includes(q) ||
              s.backendName.toLowerCase().includes(q) ||
              (s.agentName?.toLowerCase().includes(q) ?? false),
          )
        : group.sessions;
      return { group, filteredSessions, visible: groupMatches || filteredSessions.length > 0 };
    })
    .filter((item) => item.visible);

  return (
    <SidebarProvider
      keyboardShortcut={false}
      persistCookie={false}
      className={cn('min-h-0 flex-1 flex-col overflow-hidden min-[760px]:flex-row', hidden && 'hidden')}
      aria-hidden={hidden || undefined}
      data-testid="workbench-sessions"
    >
      {/* 折叠状态下窄条开关 */}
      {!sidebarOpen ? (
        <div className="flex shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar px-2.5 py-1.5 min-[760px]:flex-col min-[760px]:justify-start min-[760px]:border-r min-[760px]:border-b-0 min-[760px]:px-1.5 min-[760px]:py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="toggle-project-groups"
            aria-label={t('wb.sessions.toggleSidebar')}
            title={t('wb.sessions.toggleSidebar')}
            className="text-ink-2 hover:bg-hover hover:text-ink min-[760px]:size-7 min-[760px]:px-0"
            onClick={toggleSidebar}
          >
            <SidebarIcon className="size-3.5" />
            <span className="min-[760px]:hidden">{t('wb.sessions.groupsTitle')}</span>
          </Button>
        </div>
      ) : (
        <Sidebar
          collapsible="none"
          aria-label={t('wb.sessions.groupsTitle')}
          data-testid="project-sessions-sidebar"
          className="h-auto max-h-60 w-full shrink-0 border-b border-sidebar-border min-[760px]:h-full min-[760px]:max-h-none min-[760px]:w-72 min-[760px]:border-r min-[760px]:border-b-0"
        >
          <SidebarHeader className="gap-2 border-b border-sidebar-border px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12.5px] font-semibold tracking-tight text-ink">
                {t('wb.sessions.groupsTitle')}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={t('wb.sessions.addProject')}
                  aria-label={t('wb.sessions.addProject')}
                  className="text-ink-2 hover:bg-hover hover:text-ink"
                  onClick={() => postToHost({ type: 'addRecentProject', payload: {} })}
                >
                  <PlusIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="toggle-project-groups"
                  aria-label={t('wb.sessions.toggleSidebar')}
                  title={t('wb.sessions.toggleSidebar')}
                  className="text-ink-2 hover:bg-hover hover:text-ink"
                  onClick={toggleSidebar}
                >
                  <SidebarIcon className="size-3.5" />
                </Button>
              </div>
            </div>

            {sessionGroups.length > 1 || totalSessions > 3 ? (
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
                <SidebarInput
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('header.search')}
                  aria-label={t('header.search')}
                  className="h-8 bg-surface/90 pr-7 pl-8 text-[12px]"
                />
                {query ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('common.close')}
                    onClick={() => setQuery('')}
                    className="absolute top-1/2 right-1 size-6 -translate-y-1/2 text-ink-3 hover:bg-hover hover:text-ink"
                  >
                    <CloseIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SidebarHeader>

          <SidebarContent className="gap-0 px-2 py-2.5">
            {visibleGroups.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-ink-3">{t('header.noMatch')}</div>
            ) : (
              visibleGroups.map(({ group, filteredSessions }, index) => (
                <Fragment key={group.projectPath}>
                  {index > 0 ? <SidebarSeparator className="mx-1 my-2" /> : null}
                  <ProjectSessionGroupBlock
                    group={group}
                    filteredSessions={filteredSessions}
                    collapsed={Boolean(collapsedPaths[group.projectPath])}
                    hasQuery={q.length > 0}
                    currentSessionId={currentSessionId}
                    activeBackendId={activeBackendId}
                    onToggle={() => toggleGroup(group.projectPath)}
                  />
                </Fragment>
              ))
            )}
          </SidebarContent>
        </Sidebar>
      )}

      {/* 右侧主对话工作区 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </SidebarProvider>
  );
}

function ProjectSessionGroupBlock({
  group,
  filteredSessions,
  collapsed,
  hasQuery,
  currentSessionId,
  activeBackendId,
  onToggle,
}: {
  readonly group: ProjectSessionGroup;
  readonly filteredSessions: readonly GroupedSessionItem[];
  readonly collapsed: boolean;
  readonly hasQuery: boolean;
  readonly currentSessionId: string | undefined;
  readonly activeBackendId: string;
  readonly onToggle: () => void;
}) {
  const t = useT();

  return (
    <SidebarGroup className="gap-1 p-0" data-testid={`project-group-${group.projectName}`}>
      <div className="flex items-center justify-between gap-1 px-0.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-control px-1.5 py-1 text-left transition-colors duration-100 hover:bg-hover"
          onClick={onToggle}
          title={group.projectPath}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-ink-3" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-ink-3" />
          )}
          <FolderIcon className={cn('size-3.5 shrink-0', group.isCurrent ? 'text-accent-ink' : 'text-ink-2')} />
          <span className="truncate text-[12px] font-semibold text-ink">{group.projectName}</span>
          {group.isCurrent ? (
            <ValuePill tone="accent" className="shrink-0 px-1.5 py-0 text-[10.5px]">
              {t('wb.sessions.currentProject')}
            </ValuePill>
          ) : (
            <span className="shrink-0 rounded-full bg-field px-1.5 py-0.5 text-[10.5px] leading-none font-medium text-ink-3 tabular-nums">
              {filteredSessions.length}
            </span>
          )}
        </button>

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid={`project-new-session-${group.projectName}`}
          title={t('wb.sessions.newInProject')}
          aria-label={`${group.projectName} · ${t('wb.sessions.newInProject')}`}
          className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
          onClick={() =>
            postToHost({
              type: 'startProjectSession',
              payload: { projectPath: group.projectPath, backendId: activeBackendId },
            })
          }
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>

      {!collapsed ? (
        <SidebarGroupContent>
          {filteredSessions.length === 0 ? (
            <div className="px-2.5 py-2 text-[11.5px] text-ink-3">
              {hasQuery && group.sessions.length > 0 ? t('header.noMatch') : t('wb.sessions.noSessions')}
            </div>
          ) : (
            <SidebarMenu className="gap-1">
              {filteredSessions.map((sess) => (
                <SessionListItemRow
                  key={`${sess.backendId}:${sess.id}`}
                  session={sess}
                  isCurrent={group.isCurrent && sess.id === currentSessionId && sess.backendId === activeBackendId}
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
  isCurrent,
}: {
  readonly session: GroupedSessionItem;
  readonly isCurrent: boolean;
}) {
  const t = useT();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        isActive={isCurrent}
        data-testid={`grouped-session-${session.id}`}
        title={session.title}
        className={cn(
          'h-auto flex-col items-stretch gap-1.5 rounded-control px-2.5 py-2 transition-colors duration-100',
          isCurrent
            ? 'bg-surface text-ink shadow-card hover:bg-surface data-[active=true]:bg-surface data-[active=true]:text-ink'
            : 'text-ink-2 hover:bg-hover hover:text-ink',
        )}
        onClick={() =>
          postToHost({
            type: 'openProjectSession',
            payload: {
              projectPath: session.projectPath,
              sessionId: session.id,
              backendId: session.backendId,
            },
          })
        }
      >
        <div className="flex w-full min-w-0 items-center gap-2">
          {session.running ? (
            <SpinnerIcon className="size-3.5 shrink-0 text-accent-ink" />
          ) : (
            <ChatIcon className={cn('size-3.5 shrink-0', isCurrent ? 'text-accent-ink' : 'text-ink-3')} />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12.5px] leading-snug',
              isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink/90',
            )}
          >
            {session.title}
          </span>
          {session.needsAttention ? (
            <span
              className="size-2 shrink-0 rounded-full bg-orange ring-2 ring-orange-tint"
              title={t('approval.label')}
            />
          ) : session.unread ? (
            <span className="size-2 shrink-0 rounded-full bg-brand ring-2 ring-accent-tint" />
          ) : null}
        </div>

        <div className="flex w-full min-w-0 items-center justify-between gap-2 pl-5.5 text-[11px] leading-4 text-ink-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <BackendLogo backend={{ id: session.backendId, name: session.backendName }} size="sm" />
            <span className="truncate">{session.backendName}</span>
            {session.agentName ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{session.agentName}</span>
              </>
            ) : null}
          </span>
          {session.updatedAt > 0 ? (
            <span className="shrink-0 tabular-nums">{relativeTime(session.updatedAt, t)}</span>
          ) : null}
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

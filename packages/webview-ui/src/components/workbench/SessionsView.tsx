/**
 * 工作台 · 会话模块（SessionsView）
 *
 * 按项目分组展示会话列表，支持在任意项目分组下直接开启新分组会话或切换已有会话；
 * 右侧（窄屏为下方）承载完整的标签栏、运行状态栏、对话消息流与输入框。
 */
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { useView } from '../../store.ts';
import { loadState, postToHost, saveState } from '../../vscode.ts';
import {
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  SpinnerIcon,
} from '../icons.tsx';
import { Button } from '../ui/Button.tsx';
import { Input } from '../ui/FormControls.tsx';
import { ValuePill } from '../ui/ValuePill.tsx';

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

  const q = query.trim().toLowerCase();

  // 当没有 workbench.sessionGroups（例如纯 ChatController 独立测试环境）时，保持原有单栏纯净布局
  if (sessionGroups.length === 0) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')} aria-hidden={hidden || undefined}>
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col min-[760px]:flex-row', hidden && 'hidden')}
      aria-hidden={hidden || undefined}
      data-testid="workbench-sessions"
    >
      {/* 折叠状态下窄条开关 */}
      {!sidebarOpen ? (
        <div className="flex shrink-0 items-center justify-between border-b border-line bg-inset/40 px-2.5 py-1 min-[760px]:flex-col min-[760px]:justify-start min-[760px]:border-r min-[760px]:border-b-0 min-[760px]:px-1.5 min-[760px]:py-2">
          <button
            type="button"
            data-testid="toggle-project-groups"
            aria-label={t('wb.sessions.toggleSidebar')}
            title={t('wb.sessions.toggleSidebar')}
            className="flex items-center gap-1.5 rounded-control px-1.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
            onClick={toggleSidebar}
          >
            <SidebarIcon className="size-3.5" />
            <span className="min-[760px]:hidden">{t('wb.sessions.groupsTitle')}</span>
          </button>
        </div>
      ) : (
        <aside
          className="flex max-h-48 shrink-0 flex-col border-b border-line bg-inset/35 min-[760px]:max-h-none min-[760px]:w-64 min-[760px]:border-r min-[760px]:border-b-0"
          data-testid="project-sessions-sidebar"
        >
          <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-line px-2.5 py-1.5">
            <span className="truncate text-[12px] font-semibold text-ink">{t('wb.sessions.groupsTitle')}</span>
            <div className="flex items-center gap-1">
              <Button
                variant="quiet"
                size="xs"
                title={t('wb.sessions.addProject')}
                aria-label={t('wb.sessions.addProject')}
                onClick={() => postToHost({ type: 'addRecentProject', payload: {} })}
              >
                <PlusIcon className="size-3.5" />
              </Button>
              <button
                type="button"
                data-testid="toggle-project-groups"
                aria-label={t('wb.sessions.toggleSidebar')}
                title={t('wb.sessions.toggleSidebar')}
                className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink"
                onClick={toggleSidebar}
              >
                <SidebarIcon className="size-3.5" />
              </button>
            </div>
          </div>

          {sessionGroups.length > 1 || (sessionGroups[0]?.sessions.length ?? 0) > 3 ? (
            <div className="relative shrink-0 border-b border-line px-2 py-1.5">
              <SearchIcon className="pointer-events-none absolute top-3.5 left-4 size-3 text-ink-3" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('header.search')}
                className="h-7 pl-7 text-[12px]"
              />
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
            {sessionGroups.map((group) => {
              const filteredSessions = q
                ? group.sessions.filter(
                    (s) =>
                      s.title.toLowerCase().includes(q) ||
                      group.projectName.toLowerCase().includes(q) ||
                      s.backendName.toLowerCase().includes(q),
                  )
                : group.sessions;
              if (q && filteredSessions.length === 0 && !group.projectName.toLowerCase().includes(q)) {
                return null;
              }
              const collapsed = Boolean(collapsedPaths[group.projectPath]);

              return (
                <div
                  key={group.projectPath}
                  className="flex flex-col rounded-control border border-line bg-surface/85"
                  data-testid={`project-group-${group.projectName}`}
                >
                  <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      onClick={() => toggleGroup(group.projectPath)}
                      title={group.projectPath}
                    >
                      {collapsed ? (
                        <ChevronRightIcon className="size-3 shrink-0 text-ink-3" />
                      ) : (
                        <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                      )}
                      <FolderIcon className="size-3.5 shrink-0 text-accent-ink" />
                      <span className="truncate text-[12px] font-semibold text-ink">{group.projectName}</span>
                      {group.isCurrent ? (
                        <ValuePill tone="accent">{t('wb.sessions.currentProject')}</ValuePill>
                      ) : (
                        <ValuePill>{group.sessions.length}</ValuePill>
                      )}
                    </button>

                    <button
                      type="button"
                      data-testid={`project-new-session-${group.projectName}`}
                      title={t('wb.sessions.newInProject')}
                      aria-label={`${group.projectName} · ${t('wb.sessions.newInProject')}`}
                      className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                      onClick={() =>
                        postToHost({
                          type: 'startProjectSession',
                          payload: { projectPath: group.projectPath, backendId: activeBackendId },
                        })
                      }
                    >
                      <PlusIcon className="size-3.5" />
                    </button>
                  </div>

                  {!collapsed ? (
                    <div className="flex flex-col gap-0.5 border-t border-line/70 p-1">
                      {filteredSessions.length === 0 ? (
                        <div className="px-2 py-1.5 text-[11px] text-ink-3">{t('wb.sessions.noSessions')}</div>
                      ) : (
                        filteredSessions.map((sess) => {
                          const isCurrentSess =
                            group.isCurrent && sess.id === currentSessionId && sess.backendId === activeBackendId;
                          return (
                            <button
                              key={`${sess.backendId}:${sess.id}`}
                              type="button"
                              data-testid={`grouped-session-${sess.id}`}
                              className={cn(
                                'flex items-center justify-between gap-1.5 rounded-[5px] px-2 py-1 text-left text-[12px] transition-colors duration-100',
                                isCurrentSess
                                  ? 'bg-accent/12 font-medium text-ink'
                                  : 'text-ink-2 hover:bg-hover hover:text-ink',
                              )}
                              onClick={() =>
                                postToHost({
                                  type: 'openProjectSession',
                                  payload: {
                                    projectPath: sess.projectPath,
                                    sessionId: sess.id,
                                    backendId: sess.backendId,
                                  },
                                })
                              }
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                {sess.running ? (
                                  <SpinnerIcon className="size-3 shrink-0 text-accent-ink" />
                                ) : (
                                  <ChatIcon className="size-3 shrink-0 text-ink-3" />
                                )}
                                <span className="truncate">{sess.title}</span>
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                {sess.needsAttention ? (
                                  <span className="size-2 rounded-full bg-orange" />
                                ) : sess.unread ? (
                                  <span className="size-2 rounded-full bg-accent" />
                                ) : null}
                                <span className="text-[10.5px] text-ink-3">{sess.backendName}</span>
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* 右侧主对话工作区 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * 历史会话列表页面：
 * 由顶栏设置按钮左侧的「历史」图标按钮进入，支持搜索与按项目/时间查看历史会话，
 * 点击任意会话后打开并返回对话界面。
 */
import { useEffect, useMemo, useState } from 'react';
import type { GroupedSessionItem, ProjectSessionGroup, SessionListItem } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '../i18n.ts';
import { relativeTime } from '../lib/time.ts';
import { closeHistoryPage, setActiveModule, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { BackendLogo } from './BackendLogo.tsx';
import { GlideMenu, MenuItem, ValuePill } from './beautifului/index.ts';
import {
  ArrowLeftIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  HistoryIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
} from './icons.tsx';

export function SessionHistoryPage() {
  const t = useT();
  const session = useView((s) => s.session);
  const sessions = useView((s) => s.sessions);
  const sessionGroups = useView((s) => s.workbench.sessionGroups);
  const backends = useView((s) => s.backends);
  const activeBackendId = backends.active;
  const activeBackend = backends.items.find((b) => b.id === activeBackendId) ?? (activeBackendId ? { id: activeBackendId, name: activeBackendId } : undefined);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHistoryPage();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const hasGroups = sessionGroups.length > 0;
  const q = query.trim().toLowerCase();

  const filteredGroups = useMemo<readonly ProjectSessionGroup[]>(() => {
    if (!hasGroups) return [];
    if (!q) return sessionGroups;
    return sessionGroups
      .map((group) => {
        const groupMatches = group.projectName.toLowerCase().includes(q);
        const matchedSessions = groupMatches
          ? group.sessions
          : group.sessions.filter(
              (s) =>
                s.title.toLowerCase().includes(q) ||
                s.backendName.toLowerCase().includes(q) ||
                (s.agentName?.toLowerCase().includes(q) ?? false),
            );
        return { ...group, sessions: matchedSessions };
      })
      .filter((group) => group.sessions.length > 0 || group.projectName.toLowerCase().includes(q));
  }, [hasGroups, q, sessionGroups]);

  const filteredFlat = useMemo<readonly SessionListItem[]>(() => {
    if (hasGroups) return [];
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [hasGroups, q, sessions]);

  const totalCount = useMemo(() => {
    if (hasGroups) return sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0);
    return sessions.length;
  }, [hasGroups, sessionGroups, sessions.length]);

  const visibleCount = hasGroups
    ? filteredGroups.reduce((sum, g) => sum + g.sessions.length, 0)
    : filteredFlat.length;

  const startNewSession = (projectPath?: string) => {
    closeHistoryPage();
    setActiveModule('sessions');
    if (projectPath) {
      postToHost({ type: 'startProjectSession', payload: { projectPath, backendId: activeBackendId } });
    } else {
      postToHost({ type: 'newSession', payload: {} });
    }
  };

  const openGroupedSession = (sess: GroupedSessionItem) => {
    closeHistoryPage();
    setActiveModule('sessions');
    postToHost({
      type: 'openProjectSession',
      payload: { projectPath: sess.projectPath, sessionId: sess.id, backendId: sess.backendId },
    });
  };

  const openFlatSession = (sessionId: string) => {
    closeHistoryPage();
    setActiveModule('sessions');
    postToHost({ type: 'switchSession', payload: { sessionId } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" data-testid="session-history-page">
      {/* 顶部标题栏 + 返回与新建 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="xs" data-testid="history-back" onClick={closeHistoryPage}>
            <ArrowLeftIcon className="size-3.5" />
            <span>{t('history.back')}</span>
          </Button>
          <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
            <HistoryIcon className="size-3.5 shrink-0 text-accent-ink" />
            <span>{t('history.title')}</span>
          </span>
          <ValuePill>{t('history.allCount', totalCount)}</ValuePill>
        </div>
        <Button type="button" size="xs" data-testid="history-new-session" onClick={() => startNewSession()}>
          <PlusIcon className="size-3.5" />
          <span>{t('header.new')}</span>
        </Button>
      </div>

      {/* 主体列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-3">
          {/* 搜索框 */}
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              size="sm"
              data-testid="history-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('header.search')}
              aria-label={t('header.search')}
              className="bg-surface pr-8 pl-8 text-[13px] shadow-card"
            />
            {query ? (
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
              >
                <CloseIcon className="size-3" />
              </button>
            ) : null}
          </div>

          {session.listLoading && totalCount === 0 ? (
            <div className="flex items-center gap-2 rounded-card bg-surface px-4 py-6 text-[12.5px] text-ink-3 shadow-card">
              <SpinnerIcon className="size-4" />
              <span>{t('header.loadingSessions')}</span>
            </div>
          ) : visibleCount === 0 && (!hasGroups || filteredGroups.length === 0) ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-card bg-surface px-4 py-10 text-center shadow-card" data-testid="history-empty">
              <span className="flex size-9 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
                {totalCount === 0 ? <ChatIcon className="size-4" /> : <SearchIcon className="size-4" />}
              </span>
              <span className="text-[13px] font-medium text-ink">
                {totalCount === 0 ? t('header.noSessions') : t('header.noMatch')}
              </span>
              {totalCount === 0 ? (
                <Button type="button" variant="outline" size="xs" className="mt-1" onClick={() => startNewSession()}>
                  <PlusIcon className="size-3.5" />
                  <span>{t('header.new')}</span>
                </Button>
              ) : null}
            </div>
          ) : hasGroups ? (
            <div className="flex flex-col gap-2.5" data-testid="history-grouped-list">
              {filteredGroups.map((group) => (
                <section
                  key={group.projectPath}
                  className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
                  data-testid={`history-group-${group.projectName}`}
                >
                  <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
                    <div className="flex min-w-0 items-center gap-1.5" title={group.projectPath}>
                      <FolderIcon className="size-3.5 shrink-0 text-accent-ink" />
                      <span className="truncate text-[12.5px] font-semibold text-ink">{group.projectName}</span>
                      {group.isCurrent ? (
                        <ValuePill tone="accent">{t('wb.sessions.currentProject')}</ValuePill>
                      ) : (
                        <ValuePill>{group.sessions.length}</ValuePill>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`history-new-in-${group.projectName}`}
                      title={t('wb.sessions.newInProject')}
                      aria-label={`${group.projectName} · ${t('wb.sessions.newInProject')}`}
                      onClick={() => startNewSession(group.projectPath)}
                    >
                      <PlusIcon className="size-3.5" />
                      <span className="hidden sm:inline">{t('wb.sessions.newInProject')}</span>
                    </Button>
                  </div>

                  {group.sessions.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] text-ink-3">{t('wb.sessions.noSessions')}</div>
                  ) : (
                    <div className="p-1">
                      <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
                        {group.sessions.map((sess) => {
                          const active =
                            group.isCurrent && sess.id === session.id && sess.backendId === activeBackendId;
                          return (
                            <MenuItem
                              key={`${sess.backendId}:${sess.id}`}
                              active={active}
                              className="history-session-item"
                              data-testid={`history-session-${sess.id}`}
                              icon={
                                sess.running ? (
                                  <SpinnerIcon className="size-3.5" />
                                ) : active ? (
                                  <CheckIcon className="size-3.5" />
                                ) : (
                                  <ChatIcon className="size-3.5" />
                                )
                              }
                              hint={
                                <span className="inline-flex items-center gap-1.5">
                                  {sess.needsAttention ? (
                                    <span
                                      className="dot dot--attention inline-block size-2 rounded-full bg-orange"
                                      title={t('approval.label')}
                                    />
                                  ) : sess.unread ? (
                                    <span className="inline-block size-2 rounded-full bg-brand" />
                                  ) : null}
                                  <span className="rounded-chip bg-field px-1.5 py-0.5 text-[10.5px] text-ink-3 shadow-hairline">
                                    {sess.backendName}
                                  </span>
                                  <span>{relativeTime(sess.updatedAt, t)}</span>
                                </span>
                              }
                              onSelect={() => openGroupedSession(sess)}
                            >
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                <BackendLogo backend={{ id: sess.backendId, name: sess.backendName }} size="sm" />
                                <span className="min-w-0 truncate">{sess.title}</span>
                              </span>
                            </MenuItem>
                          );
                        })}
                      </GlideMenu>
                    </div>
                  )}
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded-card bg-surface p-1 shadow-card" data-testid="history-flat-list">
              <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
                {filteredFlat.map((s) => (
                  <MenuItem
                    key={s.id}
                    active={s.id === session.id}
                    className="history-session-item"
                    data-testid={`history-session-${s.id}`}
                    icon={
                      s.running ? (
                        <SpinnerIcon className="size-3.5" />
                      ) : s.id === session.id ? (
                        <CheckIcon className="size-3.5" />
                      ) : (
                        <ChatIcon className="size-3.5" />
                      )
                    }
                    hint={
                      s.needsAttention ? (
                        <span
                          className="dot dot--attention inline-block size-2 rounded-full bg-orange"
                          title={t('approval.label')}
                        />
                      ) : (
                        relativeTime(s.updatedAt, t)
                      )
                    }
                    onSelect={() => openFlatSession(s.id)}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {activeBackend ? <BackendLogo backend={activeBackend} size="sm" /> : null}
                      <span className="min-w-0 truncate">{s.title}</span>
                    </span>
                  </MenuItem>
                ))}
              </GlideMenu>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

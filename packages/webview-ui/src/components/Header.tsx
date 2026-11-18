/**
 * 工作台顶栏：
 * - 第一层：五大核心模块导航（总览 / 定时 / 智能体 / 任务 / 会话）+ 新建会话 / 全宽工作台 / 设置按钮
 * - 第二层（会话模块激活且设置未打开时）：当前会话标题与快速会话搜索浮层（SearchList + GlideMenu）
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { WORKBENCH_MODULES, type WorkbenchModule } from '@harness-deck/shared/limits';
import { closeSettingsPage, setActiveModule, toggleSettingsPage, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu } from './ui/GlideMenu.tsx';
import {
  AgentIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  DashboardIcon,
  ExpandPanelIcon,
  KanbanIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SpinnerIcon,
} from './icons.tsx';
import { MenuItem, Popover } from './Popover.tsx';
import { useT, type MessageKey, type Translate } from '../i18n.ts';

export function Header() {
  const session = useView((s) => s.session);
  const sessions = useView((s) => s.sessions);
  const settingsOpen = useView((s) => s.settingsOpen);
  const activeModule = useView((s) => s.activeModule);
  const overview = useView((s) => s.workbench.overview);
  const tasks = useView((s) => s.workbench.tasks.items);
  const schedules = useView((s) => s.workbench.schedules);

  const [menu, setMenu] = useState<'sessions' | undefined>();
  const [query, setQuery] = useState('');
  const close = useCallback(() => setMenu(undefined), []);
  const t = useT();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  const overviewBadge = overview.waiting.length + overview.unread.length;
  const tasksActiveCount = tasks.filter((item) => item.status === 'in_progress' || item.status === 'review').length;
  const schedulesRunning = schedules.some((r) => r.lastStatus === 'running');

  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = WORKBENCH_MODULES.indexOf(activeModule);
    const nextIdx =
      e.key === 'ArrowRight'
        ? (idx + 1) % WORKBENCH_MODULES.length
        : (idx - 1 + WORKBENCH_MODULES.length) % WORKBENCH_MODULES.length;
    const nextMod = WORKBENCH_MODULES[nextIdx]!;
    setActiveModule(nextMod);
  };

  const renderModuleIcon = (mod: WorkbenchModule) => {
    switch (mod) {
      case 'overview':
        return <DashboardIcon className="size-3.5 shrink-0" />;
      case 'schedules':
        return <ClockIcon className="size-3.5 shrink-0" />;
      case 'agents':
        return <AgentIcon className="size-3.5 shrink-0" />;
      case 'tasks':
        return <KanbanIcon className="size-3.5 shrink-0" />;
      case 'sessions':
        return <ChatIcon className="size-3.5 shrink-0" />;
    }
  };

  return (
    <header className="header flex shrink-0 flex-col border-b border-line bg-surface">
      {/* 顶层：五大工作台模块导航 + 快捷动作 */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <div
          role="tablist"
          aria-label={t('wb.nav.label')}
          data-testid="workbench-nav"
          onKeyDown={onNavKeyDown}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {WORKBENCH_MODULES.map((mod) => {
            const active = !settingsOpen && activeModule === mod;
            return (
              <button
                key={mod}
                type="button"
                role="tab"
                data-testid={`workbench-tab-${mod}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors duration-100',
                  active
                    ? 'bg-field text-ink shadow-hairline'
                    : 'text-ink-3 hover:bg-hover hover:text-ink-2',
                )}
                onClick={() => {
                  close();
                  setActiveModule(mod);
                }}
              >
                {renderModuleIcon(mod)}
                <span>{t(`wb.nav.${mod}` as MessageKey)}</span>
                {mod === 'overview' && overviewBadge > 0 ? (
                  <span
                    className={cn(
                      'ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-white',
                      overview.waiting.length > 0 ? 'bg-orange' : 'bg-accent',
                    )}
                  >
                    {overviewBadge}
                  </span>
                ) : null}
                {mod === 'schedules' && schedulesRunning ? (
                  <span className="size-1.5 rounded-full bg-accent" style={{ animation: 'pulse 1.4s ease-in-out infinite' }} />
                ) : null}
                {mod === 'tasks' && tasksActiveCount > 0 ? (
                  <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-[10px] leading-4 font-semibold text-accent-ink">
                    {tasksActiveCount}
                  </span>
                ) : null}
                {mod === 'sessions' && session.running ? (
                  <span className="size-1.5 rounded-full bg-accent" style={{ animation: 'pulse 1.4s ease-in-out infinite' }} />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={t('header.new')}
            title={t('header.newTab')}
            className="flex size-6.5 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
            onClick={() => {
              close();
              setActiveModule('sessions');
              postToHost({ type: 'newSession', payload: {} });
            }}
          >
            <PlusIcon className="size-4" />
          </button>
          <button
            type="button"
            data-testid="open-workbench-panel-btn"
            aria-label={t('wb.openPanel')}
            title={t('wb.openPanel')}
            className="flex size-6.5 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
            onClick={() => {
              close();
              postToHost({ type: 'openWorkbenchPanel', payload: {} });
            }}
          >
            <ExpandPanelIcon className="size-3.5" />
          </button>
          <button
            type="button"
            data-testid="settings-button"
            aria-label={t('header.settings')}
            title={t('header.settings')}
            aria-pressed={settingsOpen}
            className={cn(
              'flex size-6.5 items-center justify-center rounded-[6px] transition-colors duration-100',
              settingsOpen
                ? 'bg-field text-ink shadow-hairline'
                : 'text-ink-3 hover:bg-hover hover:text-ink-2',
            )}
            onClick={() => {
              close();
              toggleSettingsPage();
            }}
          >
            <SettingsIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* 第二层（会话模块下）：当前会话标题与快速搜索浮层 */}
      {!settingsOpen && activeModule === 'sessions' ? (
        <div className="flex items-center justify-between border-t border-line/60 px-2 py-1">
          <div className="header__title-wrap relative min-w-0 flex-1">
            <button
              type="button"
              className="header__title flex max-w-full items-center gap-1.5 rounded-[6px] px-2 py-[2px] text-[12.5px] font-medium text-ink transition-colors duration-100 hover:bg-hover"
              aria-haspopup="dialog"
              aria-expanded={menu === 'sessions'}
              onClick={() => {
                setQuery('');
                setMenu(menu === 'sessions' ? undefined : 'sessions');
              }}
              title={session.title}
            >
              {session.sync === 'opening' && session.id ? (
                <SpinnerIcon className="header__spinner size-3.5 shrink-0 text-ink-3" />
              ) : session.running ? (
                <span
                  className="dot dot--running inline-block size-2 shrink-0 rounded-full bg-accent"
                  style={{ animation: 'pulse 1.4s ease-in-out infinite' }}
                  aria-label={t('header.running')}
                />
              ) : null}
              <span className="header__title-text truncate">{session.title}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-ink-3" />
            </button>

            <Popover
              open={menu === 'sessions'}
              onClose={close}
              className="sessions-menu left-0 w-[min(340px,calc(100vw-16px))] p-0"
              label={t('header.sessions')}
            >
              <div className="sessions-menu__search flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover">
                <SearchIcon className="size-3.5 shrink-0 text-ink-3" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('header.search')}
                  aria-label={t('header.search')}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
                />
                {query ? (
                  <button
                    type="button"
                    aria-label={t('common.close')}
                    onClick={() => setQuery('')}
                    className="flex size-5 items-center justify-center rounded-full text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
                    style={{ animation: 'fade-in 150ms ease-out both' }}
                  >
                    <CloseIcon className="size-3" />
                  </button>
                ) : null}
              </div>
              <div role="menu" className="sessions-menu__list max-h-80 overflow-y-auto p-1">
                {session.listLoading && sessions.length === 0 ? (
                  <div className="menu-empty menu-empty--loading flex items-center gap-2 px-2 py-3 text-[12.5px] text-ink-3">
                    <SpinnerIcon className="size-3.5" />
                    {t('header.loadingSessions')}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="menu-empty flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
                    <span className="mb-1 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
                      <SearchIcon className="size-3.5" />
                    </span>
                    <span className="text-[12.5px] font-medium text-ink">
                      {sessions.length === 0 ? t('header.noSessions') : t('header.noMatch')}
                    </span>
                  </div>
                ) : (
                  <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
                    {filtered.map((s) => (
                      <MenuItem
                        key={s.id}
                        active={s.id === session.id}
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
                        onSelect={() => {
                          close();
                          closeSettingsPage();
                          postToHost({ type: 'switchSession', payload: { sessionId: s.id } });
                        }}
                      >
                        {s.title}
                      </MenuItem>
                    ))}
                  </GlideMenu>
                )}
              </div>
            </Popover>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function relativeTime(time: number, t: Translate): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return t('time.now');
  if (minutes < 60) return t('time.minutes', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hours', hours);
  const days = Math.round(hours / 24);
  return days < 30 ? t('time.days', days) : new Date(time).toLocaleDateString();
}

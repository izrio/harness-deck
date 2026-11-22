/**
 * 工作台顶栏：
 * 六大核心模块导航（总览 / 改动 / 定时 / 智能体 / 任务 / 会话）+ 新建会话 / 全宽工作台 / 历史会话 / 设置按钮
 */
import { useRef, type KeyboardEvent } from 'react';
import { WORKBENCH_MODULES, type WorkbenchModule } from '@harness-deck/shared/limits';
import { setActiveModule, toggleHistoryPage, toggleSettingsPage, useView } from '../store.ts';
import { postToHost, reconnectMobileTransport, useTransportState } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import {
  AgentIcon,
  ChatIcon,
  ClockIcon,
  DashboardIcon,
  ExpandPanelIcon,
  GitBranchIcon,
  HistoryIcon,
  KanbanIcon,
  PlusIcon,
  SettingsIcon,
  WifiIcon,
  WifiOffIcon,
} from './icons.tsx';
import { Button } from '@/components/ui/button';
import { useT, type MessageKey } from '../i18n.ts';

export function Header() {
  const session = useView((s) => s.session);
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);
  const remoteReadOnly = clientSurface === 'mobile-web' && clientScope === 'read-only';
  const historyOpen = useView((s) => s.historyOpen);
  const settingsOpen = useView((s) => s.settingsOpen);
  const activeModule = useView((s) => s.activeModule);
  const overview = useView((s) => s.workbench.overview);
  const tasks = useView((s) => s.workbench.tasks.items);
  const schedules = useView((s) => s.workbench.schedules);
  const transport = useTransportState();
  const t = useT();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const overviewBadge = overview.waiting.length + overview.unread.length;
  const tasksActiveCount = tasks.filter((item) => item.status === 'in_progress' || item.status === 'review').length;
  const schedulesRunning = schedules.some((r) => r.lastStatus === 'running');

  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = WORKBENCH_MODULES.indexOf(activeModule);
    if (idx < 0) return;
    let nextIdx = -1;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % WORKBENCH_MODULES.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + WORKBENCH_MODULES.length) % WORKBENCH_MODULES.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = WORKBENCH_MODULES.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const nextMod = WORKBENCH_MODULES[nextIdx]!;
    setActiveModule(nextMod);
    tabRefs.current[nextIdx]?.focus();
  };

  const renderModuleIcon = (mod: WorkbenchModule) => {
    switch (mod) {
      case 'overview':
        return <DashboardIcon className="size-3.5 shrink-0" />;
      case 'changes':
        return <GitBranchIcon className="size-3.5 shrink-0" />;
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
          {WORKBENCH_MODULES.map((mod, index) => {
            const active = !settingsOpen && !historyOpen && activeModule === mod;
            return (
              <button
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                key={mod}
                type="button"
                role="tab"
                id={`workbench-tab-${mod}`}
                data-testid={`workbench-tab-${mod}`}
                aria-selected={active}
                aria-controls={`workbench-panel-${mod}`}
                tabIndex={activeModule === mod ? 0 : -1}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors duration-100',
                  active
                    ? 'bg-field text-ink shadow-hairline'
                    : 'text-ink-3 hover:bg-hover hover:text-ink-2',
                )}
                onClick={() => setActiveModule(mod)}
              >
                {renderModuleIcon(mod)}
                <span>{t(`wb.nav.${mod}` as MessageKey)}</span>
                {mod === 'overview' && overviewBadge > 0 ? (
                  <span
                    className={cn(
                      'ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-brand-foreground',
                      overview.waiting.length > 0 ? 'bg-orange' : 'bg-brand',
                    )}
                  >
                    {overviewBadge}
                  </span>
                ) : null}
                {mod === 'schedules' && schedulesRunning ? (
                  <span className="size-1.5 rounded-full bg-brand" style={{ animation: 'pulse 1.4s ease-in-out infinite' }} />
                ) : null}
                {mod === 'tasks' && tasksActiveCount > 0 ? (
                  <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-brand/15 px-1 text-[10px] leading-4 font-semibold text-accent-ink">
                    {tasksActiveCount}
                  </span>
                ) : null}
                {mod === 'sessions' && session.running ? (
                  <span className="size-1.5 rounded-full bg-brand" style={{ animation: 'pulse 1.4s ease-in-out infinite' }} />
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5" data-testid="header-actions">
          {clientSurface === 'mobile-web' || transport.mode === 'mobile-web' ? (
            <button
              type="button"
              data-testid="mobile-conn-pill"
              onClick={reconnectMobileTransport}
              className={cn(
                'mr-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium shadow-hairline transition-colors',
                transport.status === 'connected'
                  ? 'bg-green-tint text-green'
                  : transport.status === 'reconnecting' || transport.status === 'connecting'
                    ? 'bg-orange-tint text-orange'
                    : 'bg-red-tint text-red',
              )}
              title={t(
                transport.status === 'connected'
                  ? 'mobile.conn.connected'
                  : transport.status === 'reconnecting'
                    ? 'mobile.conn.reconnecting'
                    : transport.status === 'connecting'
                      ? 'mobile.conn.connecting'
                      : 'mobile.conn.offline',
              )}
            >
              {transport.status === 'connected' ? (
                <WifiIcon className="size-3" />
              ) : (
                <WifiOffIcon className="size-3" />
              )}
              <span className="hidden sm:inline">
                {t(
                  transport.status === 'connected'
                    ? 'mobile.conn.connected'
                    : transport.status === 'reconnecting'
                      ? 'mobile.conn.reconnecting'
                      : transport.status === 'connecting'
                        ? 'mobile.conn.connecting'
                        : 'mobile.conn.offline',
                )}
              </span>
            </button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={remoteReadOnly}
            aria-label={t('header.new')}
            title={t('header.newTab')}
            onClick={() => {
              setActiveModule('sessions');
              postToHost({ type: 'newSession', payload: {} });
            }}
          >
            <PlusIcon className="size-4" />
          </Button>
          {clientSurface !== 'mobile-web' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="open-workbench-panel-btn"
              aria-label={t('wb.openPanel')}
              title={t('wb.openPanel')}
              onClick={() => {
                postToHost({ type: 'openWorkbenchPanel', payload: {} });
              }}
            >
              <ExpandPanelIcon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant={historyOpen ? 'secondary' : 'ghost'}
            size="icon-xs"
            data-testid="history-button"
            aria-label={t('header.history')}
            title={t('header.history')}
            aria-pressed={historyOpen}
            onClick={toggleHistoryPage}
          >
            <HistoryIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant={settingsOpen ? 'secondary' : 'ghost'}
            size="icon-xs"
            data-testid="settings-button"
            aria-label={t('header.settings')}
            title={t('header.settings')}
            aria-pressed={settingsOpen}
            onClick={toggleSettingsPage}
          >
            <SettingsIcon className="size-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}

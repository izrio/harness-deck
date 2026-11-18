/**
 * 工作台顶栏：
 * 五大核心模块导航（总览 / 定时 / 智能体 / 任务 / 会话）+ 新建会话 / 全宽工作台 / 历史会话 / 设置按钮
 */
import type { KeyboardEvent } from 'react';
import { WORKBENCH_MODULES, type WorkbenchModule } from '@harness-deck/shared/limits';
import { setActiveModule, toggleHistoryPage, toggleSettingsPage, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import {
  AgentIcon,
  ChatIcon,
  ClockIcon,
  DashboardIcon,
  ExpandPanelIcon,
  HistoryIcon,
  KanbanIcon,
  PlusIcon,
  SettingsIcon,
} from './icons.tsx';
import { Button } from '@/components/ui/button';
import { useT, type MessageKey } from '../i18n.ts';

export function Header() {
  const session = useView((s) => s.session);
  const historyOpen = useView((s) => s.historyOpen);
  const settingsOpen = useView((s) => s.settingsOpen);
  const activeModule = useView((s) => s.activeModule);
  const overview = useView((s) => s.workbench.overview);
  const tasks = useView((s) => s.workbench.tasks.items);
  const schedules = useView((s) => s.workbench.schedules);
  const t = useT();

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
            const active = !settingsOpen && !historyOpen && activeModule === mod;
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
                onClick={() => setActiveModule(mod)}
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

        <div className="flex shrink-0 items-center gap-0.5" data-testid="header-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('header.new')}
            title={t('header.newTab')}
            onClick={() => {
              setActiveModule('sessions');
              postToHost({ type: 'newSession', payload: {} });
            }}
          >
            <PlusIcon className="size-4" />
          </Button>
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

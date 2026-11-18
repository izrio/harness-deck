/**
 * 设置页面（多 Tab 架构）：
 * 1. 界面（interface）：外观模块（主题 + 5 套整套配色、阅读与聊天排版、终端、语言）+ 交互与上下文 + 系统通知
 * 2. Agent（agents）：智能体配置（Node/npm 环境、内置与外部 ACP 智能体管理）+ 运行时与诊断
 * 3. 项目（projects）：工作区与最近项目切换 + Worktree 自动化与验收配置
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageKey } from '../i18n.ts';
import { useT } from '../i18n.ts';
import { cn } from '../lib/utils.ts';
import { closeSettingsPage, setSettingsTab, useView, type SettingsTab } from '../store.ts';
import { AgentIcon, ArrowLeftIcon, FolderIcon, PaletteIcon } from './icons.tsx';
import { AgentSettings } from './settings/AgentSettings.tsx';
import { AppearanceSettings } from './settings/AppearanceSettings.tsx';
import { NotificationSettings } from './settings/NotificationSettings.tsx';
import { AdvancedSettings, GeneralSettings } from './settings/OtherSettings.tsx';
import { ProjectSettings } from './settings/ProjectSettings.tsx';
import { Button } from './ui/Button.tsx';

interface TabSpec {
  readonly id: SettingsTab;
  readonly labelKey: MessageKey;
  readonly icon: ReactNode;
}

const TABS: readonly TabSpec[] = [
  { id: 'interface', labelKey: 'settings.nav.interface', icon: <PaletteIcon className="size-3.5" /> },
  { id: 'agents', labelKey: 'settings.nav.agent', icon: <AgentIcon className="size-3.5" /> },
  { id: 'projects', labelKey: 'settings.nav.project', icon: <FolderIcon className="size-3.5" /> },
];

export function SettingsPage() {
  const t = useT();
  const activeTab = useView((s) => s.settingsTab);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const idx = TABS.findIndex((item) => item.id === activeTab);
    if (idx < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (idx + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next >= 0) {
      event.preventDefault();
      const target = TABS[next]!;
      setSettingsTab(target.id);
      tabRefs.current[next]?.focus();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" data-testid="settings-page">
      {/* 顶部标题栏 + 多 Tab 切换条 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" data-testid="settings-back" onClick={closeSettingsPage}>
            <ArrowLeftIcon className="size-3.5" />
            <span>{t('settings.back')}</span>
          </Button>
          <h2 className="m-0 text-[13.5px] font-semibold text-ink">{t('settings.title')}</h2>
        </div>

        <div
          role="tablist"
          aria-label={t('settings.title')}
          data-testid="settings-tabs"
          onKeyDown={onTabKeyDown}
          className="inline-flex items-center gap-1 rounded-control bg-field p-0.5 shadow-hairline"
        >
          {TABS.map((tab, index) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                data-testid={`settings-tab-${tab.id}`}
                onClick={() => setSettingsTab(tab.id)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12.5px] transition-all duration-150',
                  selected
                    ? 'bg-surface font-medium text-ink shadow-card'
                    : 'text-ink-2 hover:text-ink',
                )}
              >
                <span className={cn('inline-flex shrink-0', selected ? 'text-accent-ink' : 'text-ink-3')}>
                  {tab.icon}
                </span>
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 当前激活 Tab 面板 */}
      <div
        role="tabpanel"
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3.5 py-3"
      >
        <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-3">
          {renderActiveTab(activeTab)}
        </div>
      </div>
    </div>
  );
}

function renderActiveTab(tab: SettingsTab): ReactNode {
  switch (tab) {
    case 'interface':
      return (
        <>
          <AppearanceSettings />
          <GeneralSettings />
          <NotificationSettings />
        </>
      );
    case 'agents':
      return (
        <>
          <AgentSettings />
          <AdvancedSettings />
        </>
      );
    case 'projects':
      return <ProjectSettings />;
  }
}

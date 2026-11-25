/**
 * 设置页面（shadcn/ui Sidebar 架构）：
 * 去线留白：左侧柔和底色导航栏与右侧画布自然过渡，不设边框分割线与冗余面包屑。
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { useT } from '../i18n.ts';
import { closeSettingsPage, setSettingsTab, useView, type SettingsTab } from '../store.ts';
import {
  AgentIcon,
  ArrowLeftIcon,
  BellIcon,
  ChatIcon,
  FolderIcon,
  KeyIcon,
  PaletteIcon,
  PlugIcon,
  PuzzleIcon,
  ServerIcon,
  SlashIcon,
  SmartphoneIcon,
  UsersIcon,
} from './icons.tsx';
import { useIsMobile } from '../hooks/use-mobile.ts';
import { AccountSettings } from './settings/AccountSettings.tsx';
import { AgentSettings } from './settings/AgentSettings.tsx';
import { AppearanceSettings } from './settings/AppearanceSettings.tsx';
import { ChatCommandSettings } from './settings/ChatCommandSettings.tsx';
import { McpSettings } from './settings/McpSettings.tsx';
import { NotificationSettings } from './settings/NotificationSettings.tsx';
import { AdvancedSettings, GeneralSettings } from './settings/OtherSettings.tsx';
import { ProjectSettings } from './settings/ProjectSettings.tsx';
import { ProviderSettings } from './settings/ProviderSettings.tsx';
import { RemoteSettings } from './settings/RemoteSettings.tsx';
import { SkillSettings } from './settings/SkillSettings.tsx';

interface SettingsNavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly {
    readonly id: SettingsTab;
    readonly label: string;
    readonly icon: ReactNode;
  }[];
}

export function SettingsPage() {
  const t = useT();
  const isMobile = useIsMobile();
  const activeTab = useView((s) => s.settingsTab);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      closeSettingsPage();
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, []);

  const groups: readonly SettingsNavGroup[] = [
    {
      id: 'interface',
      label: t('settings.nav.interface'),
      items: [
        { id: 'appearance', label: t('settings.nav.appearance'), icon: <PaletteIcon className="size-3.5" /> },
        { id: 'notifications', label: t('settings.nav.notifications'), icon: <BellIcon className="size-3.5" /> },
      ],
    },
    {
      id: 'agent',
      label: t('settings.nav.agent'),
      items: [
        { id: 'agents', label: t('settings.nav.agents'), icon: <AgentIcon className="size-3.5" /> },
        { id: 'accounts', label: t('settings.nav.accounts'), icon: <UsersIcon className="size-3.5" /> },
        { id: 'providers', label: t('settings.nav.providers'), icon: <KeyIcon className="size-3.5" /> },
      ],
    },
    {
      id: 'extensions',
      label: t('settings.nav.extensions'),
      items: [
        { id: 'skills', label: t('settings.nav.skills'), icon: <PuzzleIcon className="size-3.5" /> },
        { id: 'mcp', label: t('settings.nav.mcp'), icon: <PlugIcon className="size-3.5" /> },
      ],
    },
    {
      id: 'sessionGroup',
      label: t('settings.nav.sessionGroup'),
      items: [
        { id: 'session', label: t('settings.nav.session'), icon: <ChatIcon className="size-3.5" /> },
        { id: 'commands', label: t('settings.nav.commands'), icon: <SlashIcon className="size-3.5" /> },
      ],
    },
    {
      id: 'project',
      label: t('settings.nav.project'),
      items: [
        { id: 'projects', label: t('settings.nav.projects'), icon: <FolderIcon className="size-3.5" /> },
      ],
    },
    {
      id: 'other',
      label: t('settings.nav.other'),
      items: [
        { id: 'other', label: t('settings.nav.advanced'), icon: <ServerIcon className="size-3.5" /> },
        { id: 'remote', label: t('settings.nav.remote'), icon: <SmartphoneIcon className="size-3.5" /> },
      ],
    },
  ];

  const flatItems = groups.flatMap((group) => group.items);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const idx = flatItems.findIndex((item) => item.id === activeTab);
    if (idx < 0 || flatItems.length === 0) return;
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (idx + 1) % flatItems.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (idx - 1 + flatItems.length) % flatItems.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = flatItems.length - 1;
    if (next >= 0) {
      event.preventDefault();
      const target = flatItems[next]!;
      setSettingsTab(target.id);
      buttonRefs.current[next]?.focus();
    }
  };

  let itemCursor = 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" data-testid="settings-page">
      {isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-ml-1 text-ink-2 hover:text-ink"
              data-testid="settings-back"
              onClick={closeSettingsPage}
            >
              <ArrowLeftIcon className="size-3.5" />
              <span>{t('settings.back')}</span>
            </Button>
          </div>
          <div
            role="tablist"
            aria-orientation="horizontal"
            aria-label={t('settings.title')}
            data-testid="settings-tabs"
            onKeyDown={onKeyDown}
            className="flex shrink-0 items-center gap-1 overflow-x-auto px-3 py-2"
          >
            {flatItems.map((item, index) => {
              const selected = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    buttonRefs.current[index] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${item.id}`}
                  tabIndex={selected ? 0 : -1}
                  data-testid={`settings-tab-${item.id}`}
                  onClick={() => setSettingsTab(item.id)}
                  className={
                    selected
                      ? 'inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-field px-3 py-1.5 text-[12px] font-medium text-ink dark:bg-surface'
                      : 'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-hover/70 hover:text-ink'
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <ScrollArea
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
            data-testid="settings-content"
            className="topbar-scroll-fade min-h-0 min-w-0 flex-1"
          >
            <div className="mx-auto flex w-full max-w-[680px] flex-col gap-8 px-4 pt-3 pb-10">
              {renderActiveTab(activeTab)}
            </div>
          </ScrollArea>
        </div>
      ) : (
        <SidebarProvider keyboardShortcut={false} persistCookie={false} className="min-h-0 flex-1 overflow-hidden">
          <Sidebar
            collapsible="none"
            aria-label={t('settings.title')}
            className="w-44 shrink-0 overflow-y-auto bg-inset/85 sm:w-52 dark:bg-page/75"
          >
            <SidebarHeader className="px-3 pt-4 pb-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit justify-start px-2 text-ink-2 hover:bg-hover/70 hover:text-ink"
                data-testid="settings-back"
                onClick={closeSettingsPage}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span>{t('settings.back')}</span>
              </Button>
            </SidebarHeader>

            <SidebarContent
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('settings.title')}
              data-testid="settings-tabs"
              onKeyDown={onKeyDown}
              className="gap-4 px-2.5 pt-1 pb-8"
            >
              {groups.map((group) => (
                <SidebarGroup key={group.id} className="p-0" data-testid={`sidebar-group-${group.id}`}>
                  <SidebarGroupLabel className="h-6 px-2.5 text-[11px] font-medium text-ink-3/85">
                    {group.label}
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-0.5">
                      {group.items.map((item) => {
                        const index = itemCursor++;
                        const selected = activeTab === item.id;
                        return (
                          <SidebarMenuItem key={item.id}>
                            <SidebarMenuButton
                              ref={(el) => {
                                buttonRefs.current[index] = el;
                              }}
                              type="button"
                              role="tab"
                              size="default"
                              isActive={selected}
                              id={`settings-tab-${item.id}`}
                              aria-selected={selected}
                              aria-controls={`settings-panel-${item.id}`}
                              tabIndex={selected ? 0 : -1}
                              data-testid={`settings-tab-${item.id}`}
                              onClick={() => setSettingsTab(item.id)}
                              className="rounded-lg px-2.5 text-[12.5px] text-ink-2 hover:bg-hover/70 hover:text-ink data-[active=true]:bg-field/95 data-[active=true]:font-medium data-[active=true]:text-ink dark:data-[active=true]:bg-surface/90"
                            >
                              {item.icon}
                              <span>{item.label}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
          </Sidebar>

          <ScrollArea
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
            data-testid="settings-content"
            className="topbar-scroll-fade min-h-0 min-w-0 flex-1"
          >
            <div className="mx-auto flex w-full max-w-[680px] flex-col gap-9 px-6 py-7 pb-8 sm:px-10 sm:py-9">
              {renderActiveTab(activeTab)}
            </div>
          </ScrollArea>
        </SidebarProvider>
      )}
    </div>
  );
}

function renderActiveTab(tab: SettingsTab): ReactNode {
  switch (tab) {
    case 'appearance':
      return <AppearanceSettings />;
    case 'notifications':
      return <NotificationSettings />;
    case 'agents':
      return <AgentSettings />;
    case 'accounts':
      return <AccountSettings />;
    case 'providers':
      return <ProviderSettings />;
    case 'skills':
      return <SkillSettings />;
    case 'mcp':
      return <McpSettings />;
    case 'session':
      return <GeneralSettings />;
    case 'commands':
      return <ChatCommandSettings />;
    case 'projects':
      return <ProjectSettings />;
    case 'other':
      return <AdvancedSettings />;
    case 'remote':
      return <RemoteSettings />;
  }
}

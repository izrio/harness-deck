/**
 * 设置页面（shadcn/ui Sidebar 架构）：
 * 左侧为分组侧边栏导航（Sidebar），右侧为对应设置内容区：
 * - 界面 -> 外观（appearance）：主题、阅读与聊天排版、终端、界面语言
 * - 界面 -> 通知（notifications）：系统通知开关、触发时机与测试通知
 * - Agent -> 外部智能体（agents）：Node.js/npm 环境检测、内置与外部 ACP 智能体管理
 * - Agent -> 服务商（providers）：第三方编程套餐与自定义模型接口及智能体绑定
 * - 扩展 -> 技能（skills）：从 Git 仓库安装 Agent Skills（SKILL.md），Agent 启动时自动带上
 * - 扩展 -> MCP（mcp）：统一管理 MCP 服务器，启动时交给选中的 Agent，支持从各 Agent 配置导入
 * - 会话 -> 会话（session）：编辑器上下文与每轮改动卡片开关、重命名会话
 * - 会话 -> 聊天命令（commands）：存好的提示词，在输入框输入 / 选用，填入后可改再发；所有 Agent 通用
 * - 项目 -> 项目（projects）：最近项目切换、Worktree 复制文件、准备与验收命令
 * - 其他 -> 运行时与诊断（other）：定时任务默认权限、dsh 路径与 Profile、ACP 日志与 VS Code 原生设置
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
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
  const activeGroup = groups.find((g) => g.items.some((item) => item.id === activeTab));
  const activeItem = activeGroup?.items.find((item) => item.id === activeTab);

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
      {/* 顶部标题栏 + 面包屑 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="xs" data-testid="settings-back" onClick={closeSettingsPage}>
            <ArrowLeftIcon className="size-3.5" />
            <span>{t('settings.back')}</span>
          </Button>
          <h2 className="m-0 text-[13.5px] font-semibold text-ink">{t('settings.title')}</h2>
          {activeGroup && activeItem ? (
            <span
              className="hidden items-center gap-1.5 truncate text-[12px] text-ink-3 sm:inline-flex"
              data-testid="settings-breadcrumb"
            >
              <span>/</span>
              <span>{activeGroup.label}</span>
              <span>/</span>
              <span className="font-medium text-ink-2">{activeItem.label}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* 主体：桌面端左侧 shadcn/ui Sidebar；窄屏移动端顶部横向标签条 + 内容区 */}
      {isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            role="tablist"
            aria-orientation="horizontal"
            aria-label={t('settings.title')}
            data-testid="settings-tabs"
            onKeyDown={onKeyDown}
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-sidebar px-2.5 py-1.5"
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
                      ? 'inline-flex shrink-0 items-center gap-1.5 rounded-[7px] bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink shadow-card'
                      : 'inline-flex shrink-0 items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-hover hover:text-ink'
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <div
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
            data-testid="settings-content"
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3"
          >
            <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-3">
              {renderActiveTab(activeTab)}
            </div>
          </div>
        </div>
      ) : (
        <SidebarProvider keyboardShortcut={false} persistCookie={false} className="min-h-0 flex-1 overflow-hidden">
          <Sidebar
            collapsible="none"
            aria-label={t('settings.title')}
            className="w-36 shrink-0 overflow-y-auto border-r border-sidebar-border sm:w-48"
          >
            <SidebarContent
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('settings.title')}
              data-testid="settings-tabs"
              onKeyDown={onKeyDown}
              className="gap-2 p-1.5"
            >
              {groups.map((group) => (
                <SidebarGroup key={group.id} className="p-1" data-testid={`sidebar-group-${group.id}`}>
                  <SidebarGroupLabel className="h-6 px-2 text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">
                    {group.label}
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
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
                              className="text-[12.5px] data-[active=true]:bg-surface data-[active=true]:shadow-card"
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

          <div
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
            data-testid="settings-content"
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3.5 py-3"
          >
            <div className="mx-auto flex w-full max-w-[var(--content-width)] flex-col gap-3">
              {renderActiveTab(activeTab)}
            </div>
          </div>
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

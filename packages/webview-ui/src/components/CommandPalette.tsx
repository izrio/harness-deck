/**
 * 应用内全局命令面板（P1-6，Cmd/Ctrl+K）：
 * 基于官方 shadcn/ui `CommandDialog` 组合，覆盖跨 IDE（VS Code / JetBrains / Mobile Web / Electron Desktop）
 * 的高频快捷操作：新建会话/Worktree、切换右侧栏（文件/Git/终端）、切换会话、打开设置与主题快捷切换。
 */
import type { ThemePreset } from '@harness-deck/shared';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useT, type MessageKey } from '../i18n.ts';
import {
  openSettingsPage,
  setActiveModule,
  setAppearanceLocal,
  setRightPanelOpen,
  setRightPanelTab,
  useView,
} from '../store.ts';
import type { ThemeMode } from '../theme.ts';
import { postToHost } from '../vscode.ts';
import {
  FilesIcon,
  GitBranchIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  SunIcon,
  TerminalIcon,
  UsersIcon,
} from './icons.tsx';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onNewWorktree: () => void;
}

const PRESETS: readonly ThemePreset[] = ['default', 'grove', 'ocean', 'ember', 'iris'];

export function CommandPalette({ open, onOpenChange, onNewWorktree }: CommandPaletteProps) {
  const t = useT();
  const sessions = useView((s) => s.sessions);
  const appearance = useView((s) => s.appearance);
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const switchTheme = (theme: ThemeMode) => {
    setAppearanceLocal({ ...appearance, theme });
    postToHost({ type: 'setAppearance', payload: { theme } });
  };

  const switchPreset = (preset: ThemePreset) => {
    setAppearanceLocal({ ...appearance, preset });
    postToHost({ type: 'setAppearance', payload: { preset } });
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('cmdPalette.trigger')}
      description={t('cmdPalette.placeholder')}
    >
      <CommandInput placeholder={t('cmdPalette.placeholder')} data-testid="command-palette-input" />
      <CommandList>
        <CommandEmpty>{t('cmdPalette.empty')}</CommandEmpty>

        <CommandGroup heading={t('cmdPalette.groupActions')}>
          {!remoteReadOnly ? (
            <>
              <CommandItem
                onSelect={() =>
                  run(() => {
                    setActiveModule('sessions');
                    postToHost({ type: 'newSession', payload: {} });
                  })
                }
              >
                <PlusIcon className="size-3.5" />
                <span>{t('header.new')}</span>
              </CommandItem>
              <CommandItem onSelect={() => run(onNewWorktree)}>
                <GitBranchIcon className="size-3.5" />
                <span>{t('wb.sessions.worktreeSession')}</span>
              </CommandItem>
            </>
          ) : null}
          <CommandItem
            onSelect={() =>
              run(() => {
                postToHost({ type: 'refreshSourceControl', payload: {} });
                setRightPanelTab('git');
                setRightPanelOpen(true);
              })
            }
          >
            <RefreshIcon className="size-3.5" />
            <span>{t('wb.changes.refresh')}</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => openSettingsPage())}>
            <SettingsIcon className="size-3.5" />
            <span>{t('cmdPalette.openSettings')}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('cmdPalette.groupPanels')}>
          <CommandItem onSelect={() => run(() => setActiveModule('overview'))}>
            <LayoutDashboardIcon className="size-3.5" />
            <span>{t('wb.nav.overview')}</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => setActiveModule('tasks'))}>
            <ListTodoIcon className="size-3.5" />
            <span>{t('wb.nav.tasks')}</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => setActiveModule('agents'))}>
            <UsersIcon className="size-3.5" />
            <span>{t('wb.nav.agents')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                setRightPanelTab('files');
                setRightPanelOpen(true);
              })
            }
          >
            <FilesIcon className="size-3.5" />
            <span>{t('cmdPalette.openFiles')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                setRightPanelTab('git');
                setRightPanelOpen(true);
              })
            }
          >
            <GitBranchIcon className="size-3.5" />
            <span>{t('cmdPalette.openGit')}</span>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                setRightPanelTab('terminal');
                setRightPanelOpen(true);
              })
            }
          >
            <TerminalIcon className="size-3.5" />
            <span>{t('cmdPalette.openTerminal')}</span>
            <CommandShortcut>Ctrl+J</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                setRightPanelTab('browser');
                setRightPanelOpen(true);
              })
            }
          >
            <GlobeIcon className="size-3.5" />
            <span>{t('cmdPalette.openBrowser')}</span>
          </CommandItem>
        </CommandGroup>

        {sessions.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('cmdPalette.groupSessions')}>
              {sessions.slice(0, 12).map((session) => (
                <CommandItem
                  key={session.id}
                  onSelect={() =>
                    run(() => {
                      setActiveModule('sessions');
                      postToHost({ type: 'switchSession', payload: { sessionId: session.id } });
                    })
                  }
                >
                  <span className="truncate">{session.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />

        <CommandGroup heading={t('cmdPalette.groupTheme')}>
          <CommandItem onSelect={() => run(() => switchTheme('light'))}>
            <SunIcon className="size-3.5" />
            <span>{t('settings.appearance.theme.light')}</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => switchTheme('dark'))}>
            <MoonIcon className="size-3.5" />
            <span>{t('settings.appearance.theme.dark')}</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => switchTheme('system'))}>
            <MonitorIcon className="size-3.5" />
            <span>{t('settings.appearance.theme.system')}</span>
          </CommandItem>
          {PRESETS.map((preset) => (
            <CommandItem key={preset} onSelect={() => run(() => switchPreset(preset))}>
              <PaletteIcon className="size-3.5" />
              <span>
                {t('settings.appearance.preset')} · {t(`settings.appearance.preset.${preset}` as MessageKey)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

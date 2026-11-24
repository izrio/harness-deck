import { useEffect, useRef, useState } from 'react';
import {
  applyHostMessage,
  requestPrefill,
  setActiveModule,
  setRightPanelOpen,
  setRightPanelTab,
  useView,
} from './store.ts';
import { cn } from './lib/utils.ts';
import { applyHighContrast, applyThemeMode, applyThemePreset } from './theme.ts';
import {
  consumePendingDeepLinkSession,
  loadState,
  navigateToRemoteRoute,
  postToHost,
  saveState,
  startHostBridge,
  useTransportState,
} from './vscode.ts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SidebarProvider } from '@/components/ui/sidebar';
import { LoaderGrid, Shimmer } from './components/beautifului/index.ts';
import { BackendLogo } from './components/BackendLogo.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { DiffViewerModal } from './components/DiffViewerModal.tsx';
import { HarnessDeckLogo } from './components/HarnessDeckLogo.tsx';
import { Composer } from './components/Composer.tsx';
import { Header } from './components/Header.tsx';
import { MarkdownPreviewModal } from './components/MarkdownPreviewModal.tsx';
import { MobilePairingGate } from './components/MobilePairingGate.tsx';
import { RuntimeBanner } from './components/RuntimeBanner.tsx';
import { RuntimeSetupView } from './components/RuntimeSetupView.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { TabBar } from './components/TabBar.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';
import { AgentsView } from './components/workbench/AgentsView.tsx';
import { OverviewView } from './components/workbench/OverviewView.tsx';
import { SessionsView } from './components/workbench/SessionsView.tsx';
import { TasksView } from './components/workbench/TasksView.tsx';
import { WorkbenchRightPanel } from './components/workbench/WorkbenchRightPanel.tsx';
import { WorkbenchSidebar } from './components/workbench/WorkbenchSidebar.tsx';
import {
  ArrowRightIcon,
  BeakerIcon,
  BookIcon,
  BugIcon,
  CheckIcon,
  ChevronDownIcon,
  DiffIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyIcon,
} from './components/icons.tsx';
import type { MessageKey } from './i18n.ts';
import { useT } from './i18n.ts';

export function App() {
  useEffect(() => startHostBridge((msg) => applyHostMessage(msg)), []);

  const transport = useTransportState();
  const ready = useView((s) => s.ready);
  const runtime = useView((s) => s.runtime);
  const connection = useView((s) => s.connection);
  const backends = useView((s) => s.backends);
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);
  const settingsOpen = useView((s) => s.settingsOpen);
  const hasPreview = useView((s) => s.markdownPreview !== undefined);
  const hasDiff = useView((s) => s.diffContent !== undefined);
  const activeModule = useView((s) => s.activeModule);
  const empty = useView((s) => s.items.length === 0 && s.interactions.length === 0 && !s.session.running && !s.session.hasOlder);
  const failure = useView((s) => (s.session.sync === 'failed' ? s.session.failure : undefined));
  const opening = useView((s) => s.session.id !== undefined && s.items.length === 0 && s.session.sync === 'opening');
  const t = useT();
  const appearance = useView((s) => s.appearance);
  const sessionGroups = useView((s) => s.workbench.sessionGroups);
  const deepLinkedRef = useRef(false);
  const isMobileRemote = clientSurface === 'mobile-web';

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return loadState().sessionsSidebarOpen ?? true;
    } catch {
      return true;
    }
  });
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const rightPanelOpen = useView((s) => s.rightPanelOpen);
  const rightPanelTab = useView((s) => s.rightPanelTab);

  // 全局快捷键：Cmd/Ctrl+K 打开命令面板，Ctrl/Cmd+J 快速切换右侧栏终端
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        if (rightPanelOpen && rightPanelTab === 'terminal') {
          setRightPanelOpen(false);
        } else {
          setRightPanelTab('terminal');
          setRightPanelOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rightPanelOpen, rightPanelTab]);

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try {
      saveState({ sessionsSidebarOpen: next });
    } catch {
      // ignore in test env
    }
  };

  const openNewWorktree = () => {
    if (isMobileRemote) {
      setWorktreeBranch('');
      setWorktreeDialogOpen(true);
      return;
    }
    postToHost({ type: 'newWorktreeSession', payload: {} });
  };

  // 手机端 PWA 从推送通知点开 `/?session=<id>` 时，首屏快照到达后自动跳到对应会话（支持跨项目/跨底层）
  useEffect(() => {
    if (!ready || deepLinkedRef.current || typeof window === 'undefined') return;
    deepLinkedRef.current = true;
    const targetSession =
      consumePendingDeepLinkSession() ?? new URLSearchParams(window.location.search).get('session');
    if (targetSession) {
      setActiveModule('sessions');
      let matched: { projectPath: string; backendId: string } | undefined;
      for (const group of sessionGroups) {
        const hit = group.sessions.find((s) => s.id === targetSession);
        if (hit) {
          matched = { projectPath: hit.projectPath, backendId: hit.backendId };
          break;
        }
      }
      if (matched) {
        postToHost({
          type: 'openProjectSession',
          payload: { sessionId: targetSession, projectPath: matched.projectPath, backendId: matched.backendId },
        });
      } else {
        postToHost({ type: 'switchSession', payload: { sessionId: targetSession } });
      }
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch {
        // ignore
      }
    }
  }, [ready, sessionGroups]);

  // 适配移动端软键盘（visualViewport）与安全区高度，避免输入框/审批按钮被遮挡
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const syncViewport = () => {
      const keyboardInset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--hd-keyboard-inset', `${keyboardInset}px`);
    };
    syncViewport();
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    return () => {
      vv.removeEventListener('resize', syncViewport);
      vv.removeEventListener('scroll', syncViewport);
      document.documentElement.style.removeProperty('--hd-keyboard-inset');
    };
  }, []);

  useEffect(() => {
    const style = document.documentElement.style;
    const apply = (name: string, value: string | undefined) => (value ? style.setProperty(name, value) : style.removeProperty(name));

    // 阅读与聊天：聊天回复、计划和 Markdown 文件预览共用，与主题完全正交独立
    apply('--prose-font-family', appearance.fontFamily);
    apply('--prose-font-size', appearance.fontSize ? `${appearance.fontSize}px` : undefined);
    apply('--prose-line-height', appearance.lineHeight ? String(appearance.lineHeight) : undefined);
    apply('--prose-paragraph-spacing', appearance.paragraphSpacing !== undefined ? `${appearance.paragraphSpacing}px` : undefined);
    apply('--content-width', appearance.contentWidth ? `${appearance.contentWidth}px` : undefined);

    // 终端与代码
    apply('--hd-code-font-family', appearance.codeFontFamily);
    apply('--terminal-font-size', appearance.terminalFontSize ? `${appearance.terminalFontSize}px` : undefined);
    apply('--terminal-line-height', appearance.terminalLineHeight ? String(appearance.terminalLineHeight) : undefined);

    // 主题模式、OKLCH 预设与高对比度（无闪烁切换，不影响阅读排版参数）
    applyThemeMode(appearance.theme ?? 'dark');
    applyThemePreset(appearance.preset ?? 'default');
    applyHighContrast(Boolean(appearance.highContrast));
  }, [appearance]);

  if (transport.mode === 'mobile-web') {
    if (transport.status === 'checking') {
      return (
        <div className="app flex min-h-dvh items-center justify-center bg-canvas" data-testid="mobile-checking">
          <div className="flex items-center gap-2 text-[13px] text-ink-2">
            <LoaderGrid />
            <Shimmer>{t('mobile.pair.connecting')}</Shimmer>
          </div>
        </div>
      );
    }
    if (transport.status === 'unauthenticated') {
      return (
        <div className="app flex min-h-dvh flex-col bg-canvas">
          <MobilePairingGate />
        </div>
      );
    }
  }

  const viewerOpen = !settingsOpen && (hasPreview || hasDiff);
  const hideChat = settingsOpen || viewerOpen || activeModule !== 'sessions';
  const currentBackend = backends.items.find((b) => b.id === backends.active);
  const runtimeHealthyOrStarting =
    runtime.kind === 'connected' ||
    runtime.kind === 'starting' ||
    runtime.kind === 'locating' ||
    connection === 'connected' ||
    connection === 'connecting';
  const allBackendsMissing =
    backends.items.length > 0 && backends.items.every((b) => b.available === false);
  const activeBackendMissing =
    runtime.kind === 'notInstalled' || (currentBackend !== undefined && currentBackend.available === false);
  const noBackendConfigured =
    backends.items.length === 0 || (!backends.active && runtime.kind === 'idle');
  const needsRuntimeSetup =
    ready &&
    empty &&
    !opening &&
    !runtimeHealthyOrStarting &&
    (allBackendsMissing || activeBackendMissing || noBackendConfigured);

  return (
    <div className="app" style={{ paddingBottom: 'var(--hd-keyboard-inset, 0px)' }}>
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        onOpenMobileDrawer={() => setMobileDrawerOpen(true)}
      />
      {transport.mode === 'mobile-web' && transport.status !== 'connected' && transport.suggestedRoute ? (
        <button
          type="button"
          data-testid="mobile-route-fallback-banner"
          onClick={() => void navigateToRemoteRoute(transport.suggestedRoute!.url)}
          className="block w-full shrink-0 border-b border-line bg-accent-tint px-3 py-1.5 text-center text-[12px] font-medium text-accent-ink hover:underline"
        >
          {t('mobile.conn.switchRoute', t(`remote.route.${transport.suggestedRoute.kind}` as MessageKey))}
        </button>
      ) : null}
      {clientSurface === 'mobile-web' && clientScope === 'read-only' ? (
        <div
          className="shrink-0 border-b border-line bg-field px-3 py-1 text-center text-[11.5px] text-ink-2"
          data-testid="mobile-readonly-banner"
        >
          {t('mobile.readOnlyBanner')}
        </div>
      ) : null}
      {settingsOpen && hasPreview ? <MarkdownPreviewModal /> : settingsOpen ? <SettingsPage /> : null}

      <SidebarProvider
        keyboardShortcut={false}
        persistCookie={false}
        className={cn('min-h-0 flex-1 flex-row overflow-hidden', settingsOpen && 'hidden')}
        aria-hidden={settingsOpen || undefined}
        data-testid="workbench-shell"
      >
        <WorkbenchSidebar
          open={sidebarOpen}
          mobileOpen={mobileDrawerOpen}
          onMobileOpenChange={setMobileDrawerOpen}
          onNewWorktree={openNewWorktree}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!settingsOpen && hasDiff ? <DiffViewerModal /> : !settingsOpen && hasPreview ? <MarkdownPreviewModal /> : null}
          {!settingsOpen && !viewerOpen && activeModule === 'overview' ? (
            <div
              id="workbench-panel-overview"
              role="tabpanel"
              aria-labelledby="workbench-tab-overview"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <OverviewView />
            </div>
          ) : null}
          {!settingsOpen && !viewerOpen && activeModule === 'agents' ? (
            <div
              id="workbench-panel-agents"
              role="tabpanel"
              aria-labelledby="workbench-tab-agents"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <AgentsView />
            </div>
          ) : null}
          {!settingsOpen && !viewerOpen && activeModule === 'tasks' ? (
            <div
              id="workbench-panel-tasks"
              role="tabpanel"
              aria-labelledby="workbench-tab-tasks"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <TasksView />
            </div>
          ) : null}
          <SessionsView hidden={hideChat}>
            {!needsRuntimeSetup ? <TabBar /> : null}
            {ready && !needsRuntimeSetup ? <RuntimeBanner status={runtime} connection={connection} /> : null}
            {failure && !needsRuntimeSetup ? (
              <div className="content-column mt-2">
                <div className="banner flex items-center gap-2 rounded-card bg-surface px-3 py-2 text-[12.5px] text-ink-2 shadow-card">
                  <span className="size-2 shrink-0 rounded-full bg-orange" />
                  <span>{t('session.failed', failure)}</span>
                </div>
              </div>
            ) : null}
            {needsRuntimeSetup ? (
              <RuntimeSetupView />
            ) : opening ? (
              <SessionLoading />
            ) : empty ? (
              <EmptyState />
            ) : (
              <Thread />
            )}
            {!needsRuntimeSetup ? <Composer onNewWorktree={openNewWorktree} /> : null}
          </SessionsView>
        </main>
        {!settingsOpen ? <WorkbenchRightPanel /> : null}
      </SidebarProvider>

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onNewWorktree={openNewWorktree}
      />

      <Dialog open={worktreeDialogOpen} onOpenChange={setWorktreeDialogOpen}>
        <DialogContent data-testid="mobile-worktree-session-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.worktreeTitle')}</DialogTitle>
            <DialogDescription className="sr-only">{t('mobile.confirm.worktreePlaceholder')}</DialogDescription>
          </DialogHeader>
          <Input
            size="sm"
            data-testid="mobile-worktree-session-input"
            value={worktreeBranch}
            placeholder={t('mobile.confirm.worktreePlaceholder')}
            onChange={(e) => setWorktreeBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                postToHost({ type: 'newWorktreeSession', payload: { branch: worktreeBranch.trim() } });
                setWorktreeDialogOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setWorktreeDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="mobile-worktree-session-confirm"
              onClick={() => {
                postToHost({ type: 'newWorktreeSession', payload: { branch: worktreeBranch.trim() } });
                setWorktreeDialogOpen(false);
              }}
            >
              {t('wb.sessions.worktreeSession')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div
        data-testid="toast-viewport"
        className="pointer-events-none fixed top-12 right-3 z-40 max-sm:left-3 [&_.toast]:pointer-events-auto"
      >
        <Toasts />
      </div>
    </div>
  );
}

function EmptyState() {
  const t = useT();
  const needsApiKey = useView((s) => s.models.needsApiKey === true && s.connection === 'connected');
  if (needsApiKey) {
    return (
      <div className="empty flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-6 text-center" data-testid="api-key-setup">
        <div
          className="mb-3 flex size-12 items-center justify-center rounded-window bg-surface text-ink shadow-raised"
          aria-hidden="true"
        >
          <KeyIcon className="size-5" />
        </div>
        <p className="mt-0 mb-1.5 text-[16px] font-semibold tracking-tight text-ink">{t('apiKey.title')}</p>
        <p className="mx-auto my-0 max-w-72 text-[13px] leading-relaxed text-ink-2">{t('apiKey.hint')}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button type="button" size="sm" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
            <KeyIcon className="size-3.5" />
            {t('apiKey.configure')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => postToHost({ type: 'openExternal', payload: { url: 'https://platform.deepseek.com/api_keys' } })}>
            <GlobeIcon className="size-3.5" />
            {t('apiKey.get')}
          </Button>
        </div>
      </div>
    );
  }
  return <Home />;
}

/** 首页（Halo 视觉风格：品牌徽章 + 实时工作区上下文条 + 快捷任务卡片）。 */
function Home() {
  const t = useT();
  const backends = useView((s) => s.backends);
  const sourceControl = useView((s) => s.workbench.sourceControl);
  const dirtyFiles = useView((s) => s.workspace.dirtyFiles);
  const folder = backends.workspace;
  const current = backends.items.find((b) => b.id === backends.active);
  // 只允许切换到已安装的智能体
  const installed = backends.items.filter((b) => b.available !== false);
  const branch = sourceControl?.available ? sourceControl.branch : undefined;
  const changesCount = sourceControl?.available ? sourceControl.files.length : dirtyFiles;

  const kbdClass =
    'inline-flex min-w-[1.5em] items-center justify-center rounded-[5px] border border-line/80 bg-surface/80 px-1.5 py-0.5 text-center font-mono text-[10.5px] leading-none text-ink-2 shadow-[0_1px_0_var(--line)]';

  return (
    <div className="empty relative flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 py-8 text-center">
      <div className="home-backdrop pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative z-10 mx-auto flex w-full max-w-[500px] flex-col items-center">
        {/* 品牌徽标 + 柔和光晕 */}
        <div className="relative mb-4 flex items-center justify-center" aria-hidden="true">
          <div className="home-emblem-glow pointer-events-none absolute -inset-4 rounded-full blur-md" />
          <div className="relative flex size-13 items-center justify-center rounded-2xl border border-line/70 bg-surface/85 p-1 shadow-raised backdrop-blur-sm dark:inset-shadow-[0_1px_rgb(255_255_255/8%)]">
            <HarnessDeckLogo className="size-10 rounded-[11px]" />
          </div>
        </div>

        <h1 className="m-0 text-[22px] leading-tight font-semibold tracking-[-0.025em] text-balance text-ink">
          {t('empty.title')}
        </h1>

        {/* 统一实时上下文条：当前智能体 · 工作区目录 · Git 分支与改动 */}
        {(current || folder || branch) ? (
          <div className="surface-glass mt-3.5 inline-flex max-w-full flex-wrap items-center justify-center divide-x divide-line/60 overflow-hidden rounded-full border border-line/70 shadow-xs dark:inset-shadow-[0_1px_rgb(255_255_255/4%)]">
            {current && installed.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="home__chip inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-hover"
                    data-testid="home-backend"
                    title={t('home.switchBackend')}
                  >
                    <BackendLogo backend={current} size="sm" />
                    <span className="truncate">{current.name}</span>
                    {current.available === false ? <span className="size-1.5 rounded-full bg-orange" title={t('backend.missing')} /> : null}
                    <ChevronDownIcon className="size-3 text-ink-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="min-w-44">
                  {installed.map((backend) => (
                    <DropdownMenuItem
                      key={backend.id}
                      data-testid={`home-backend-${backend.id}`}
                      className="gap-2 text-[12px]"
                      onSelect={() => {
                        if (backend.id !== backends.active) postToHost({ type: 'selectBackend', payload: { id: backend.id } });
                      }}
                    >
                      <BackendLogo backend={backend} size="sm" />
                      <span className="truncate">{backend.name}</span>
                      {backend.id === backends.active ? <CheckIcon className="ml-auto size-3.5 text-accent-ink" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : current ? (
              <span className="home__chip inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ink" data-testid="home-backend">
                <BackendLogo backend={current} size="sm" />
                <span className="truncate">{current.name}</span>
                {current.available === false ? <span className="size-1.5 rounded-full bg-orange" title={t('backend.missing')} /> : null}
              </span>
            ) : null}

            {folder ? (
              <span className="home__chip inline-flex max-w-44 items-center gap-1.5 px-3 py-1.5 font-mono text-[11.5px] text-ink-2" title={folder}>
                <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
                <span className="truncate">{folder}</span>
              </span>
            ) : null}

            {branch ? (
              <button
                type="button"
                className="home__chip inline-flex max-w-44 items-center gap-1.5 px-3 py-1.5 font-mono text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
                title={branch}
                onClick={() => {
                  setRightPanelTab('git');
                  setRightPanelOpen(true);
                }}
              >
                <GitBranchIcon className="size-3 shrink-0 text-ink-3" />
                <span className="truncate">{branch}</span>
                {changesCount > 0 ? (
                  <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-orange-tint px-1.5 py-0.5 text-[10px] leading-none font-semibold text-orange tabular-nums">
                    {changesCount}
                  </span>
                ) : null}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 快捷起步任务网格 */}
        <div
          className="suggestions mt-6 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2"
          data-testid="suggestions"
        >
          {SUGGESTIONS.map(({ key, icon, tone }) => (
            <button
              key={key}
              type="button"
              className="suggestion group relative flex items-center gap-3 overflow-hidden rounded-xl border border-line/70 bg-surface/75 px-3.5 py-3 text-left text-ink shadow-xs backdrop-blur-sm transition-[transform,border-color,background-color,box-shadow] duration-150 hover:-translate-y-px hover:border-line-strong hover:bg-surface hover:shadow-raised active:translate-y-0 active:scale-[0.985] dark:inset-shadow-[0_1px_rgb(255_255_255/4%)]"
              onClick={() => requestPrefill(t(`empty.suggest.${key}Prompt` as MessageKey))}
            >
              <span className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-transform duration-150 group-hover:scale-105', tone)}>
                {icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[12.5px] leading-snug font-medium text-ink">
                  {t(`empty.suggest.${key}` as MessageKey)}
                </span>
                <span className="truncate text-[11.5px] leading-snug text-ink-3">
                  {t(`empty.suggest.${key}Desc` as MessageKey)}
                </span>
              </span>
              <ArrowRightIcon className="size-3.5 shrink-0 -translate-x-1 text-ink-3 opacity-0 transition-[transform,opacity] duration-150 group-hover:translate-x-0 group-hover:opacity-100" />
            </button>
          ))}
        </div>

        {/* 键帽快捷键提示 */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-3" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <kbd className={kbdClass}>@</kbd>
            <span>{t('home.tips.mention')}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className={kbdClass}>/</kbd>
            <span>{t('home.tips.command')}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5">
              <kbd className={kbdClass}>⇧</kbd>
              <kbd className={kbdClass}>↵</kbd>
            </span>
            <span>{t('home.tips.newline')}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  { key: 'project', icon: <BookIcon className="size-4" />, tone: 'bg-accent-tint text-accent-ink ring-1 ring-inset ring-accent/20' },
  { key: 'bugs', icon: <BugIcon className="size-4" />, tone: 'bg-orange-tint text-orange ring-1 ring-inset ring-orange/25' },
  { key: 'tests', icon: <BeakerIcon className="size-4" />, tone: 'bg-green-tint text-green ring-1 ring-inset ring-green/25' },
  { key: 'commit', icon: <DiffIcon className="size-4" />, tone: 'bg-field text-ink-2 ring-1 ring-inset ring-line-strong/60' },
] as const;

function SessionLoading() {
  const t = useT();
  return (
    <div className="content-column flex flex-1 flex-col gap-3 py-4" role="status" aria-label={t('thread.opening')} data-testid="session-loading">
      <div className="flex items-center gap-2 text-[12.5px]">
        <LoaderGrid />
        <Shimmer>{t('thread.opening')}</Shimmer>
      </div>
      <div className="skeleton h-8 w-[55%] self-end rounded-window" />
      <div className="skeleton h-3 w-[90%]" />
      <div className="skeleton h-3 w-[60%]" />
      <div className="skeleton h-8 w-[45%] self-end rounded-window" />
      <div className="skeleton h-3 w-[82%]" />
    </div>
  );
}

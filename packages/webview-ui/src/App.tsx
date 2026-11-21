import { useEffect } from 'react';
import type { HostToWebview } from '@harness-deck/shared';
import { applyHostMessage, requestPrefill, useView } from './store.ts';
import { cn } from './lib/utils.ts';
import { applyThemeMode } from './theme.ts';
import { postToHost } from './vscode.ts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LoaderGrid, Shimmer } from './components/beautifului/index.ts';
import { BackendLogo } from './components/BackendLogo.tsx';
import { HarnessDeckLogo } from './components/HarnessDeckLogo.tsx';
import { Composer } from './components/Composer.tsx';
import { Header } from './components/Header.tsx';
import { MarkdownPreviewModal } from './components/MarkdownPreviewModal.tsx';
import { RuntimeBanner } from './components/RuntimeBanner.tsx';
import { SessionHistoryPage } from './components/SessionHistoryPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { TabBar } from './components/TabBar.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';
import { AgentsView } from './components/workbench/AgentsView.tsx';
import { ChangesView } from './components/workbench/ChangesView.tsx';
import { OverviewView } from './components/workbench/OverviewView.tsx';
import { SchedulesView } from './components/workbench/SchedulesView.tsx';
import { SessionsView } from './components/workbench/SessionsView.tsx';
import { TasksView } from './components/workbench/TasksView.tsx';
import { BeakerIcon, BookIcon, BugIcon, CheckIcon, ChevronDownIcon, DiffIcon, FolderIcon, GlobeIcon, KeyIcon } from './components/icons.tsx';
import type { MessageKey } from './i18n.ts';
import { useT } from './i18n.ts';

export function App() {
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => applyHostMessage(event.data);
    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready', payload: {} });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const ready = useView((s) => s.ready);
  const runtime = useView((s) => s.runtime);
  const connection = useView((s) => s.connection);
  const historyOpen = useView((s) => s.historyOpen);
  const settingsOpen = useView((s) => s.settingsOpen);
  const hasPreview = useView((s) => s.markdownPreview !== undefined);
  const activeModule = useView((s) => s.activeModule);
  const empty = useView((s) => s.items.length === 0 && s.interactions.length === 0 && !s.session.running && !s.session.hasOlder);
  const failure = useView((s) => (s.session.sync === 'failed' ? s.session.failure : undefined));
  const opening = useView((s) => s.session.id !== undefined && s.items.length === 0 && s.session.sync === 'opening');
  const t = useT();
  const appearance = useView((s) => s.appearance);

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

    // 主题模式（浅色 / 深色 / 跟随系统）
    applyThemeMode(appearance.theme ?? 'system');
  }, [appearance]);

  const overlayOpen = settingsOpen || historyOpen || hasPreview;
  const hideChat = overlayOpen || activeModule !== 'sessions';

  return (
    <div className="app">
      <Header />
      {hasPreview ? <MarkdownPreviewModal /> : settingsOpen ? <SettingsPage /> : historyOpen ? <SessionHistoryPage /> : null}
      {!overlayOpen && activeModule === 'overview' ? <OverviewView /> : null}
      {!overlayOpen && activeModule === 'changes' ? <ChangesView /> : null}
      {!overlayOpen && activeModule === 'schedules' ? <SchedulesView /> : null}
      {!overlayOpen && activeModule === 'agents' ? <AgentsView /> : null}
      {!overlayOpen && activeModule === 'tasks' ? <TasksView /> : null}
      <SessionsView hidden={hideChat}>
        <TabBar />
        {ready ? <RuntimeBanner status={runtime} connection={connection} /> : null}
        {failure ? (
          <div className="content-column mt-2">
            <div className="banner flex items-center gap-2 rounded-card bg-surface px-3 py-2 text-[12.5px] text-ink-2 shadow-card">
              <span className="size-2 shrink-0 rounded-full bg-orange" />
              <span>{t('session.failed', failure)}</span>
            </div>
          </div>
        ) : null}
        {opening ? <SessionLoading /> : empty ? <EmptyState /> : <Thread />}
        <Composer />
      </SessionsView>
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 z-40 [&_.toast]:pointer-events-auto',
          hideChat ? 'bottom-3' : 'bottom-32',
        )}
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
          <Button type="button" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
            <KeyIcon className="size-3.5" />
            {t('apiKey.configure')}
          </Button>
          <Button type="button" variant="outline" onClick={() => postToHost({ type: 'openExternal', payload: { url: 'https://platform.deepseek.com/api_keys' } })}>
            <GlobeIcon className="size-3.5" />
            {t('apiKey.get')}
          </Button>
        </div>
      </div>
    );
  }
  return <Home />;
}

/** 首页（Beautiful UI Recommendation / Context 卡片网格 + 胶囊上下文芯片）。 */
function Home() {
  const t = useT();
  const backends = useView((s) => s.backends);
  const folder = backends.workspace;
  const current = backends.items.find((b) => b.id === backends.active);
  // 只允许切换到已安装的智能体
  const installed = backends.items.filter((b) => b.available !== false);
  const chipClass =
    'home__chip inline-flex max-w-full items-center gap-1.5 rounded-chip bg-surface px-2.5 py-1 text-[12px] font-medium text-ink shadow-card transition-colors duration-150';
  return (
    <div className="empty flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 py-6 text-center">
      <div className="flex flex-col items-center">
        <div className="mb-3" aria-hidden="true">
          <HarnessDeckLogo />
        </div>
        <p className="mt-0 mb-1.5 text-[17px] font-semibold tracking-tight text-ink">{t('empty.title')}</p>
        <p className="mx-auto my-0 max-w-76 text-[13px] leading-relaxed text-ink-2">{t('empty.hint')}</p>
        <div className="mt-3.5 flex flex-wrap justify-center gap-1.5">
          {current && installed.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(chipClass, 'hover:bg-hover')} data-testid="home-backend" title={t('home.switchBackend')}>
                  <BackendLogo backend={current} size="sm" />
                  <span>{current.name}</span>
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
            <span className={chipClass} data-testid="home-backend">
              <BackendLogo backend={current} size="sm" />
              <span>{current.name}</span>
              {current.available === false ? <span className="size-1.5 rounded-full bg-orange" title={t('backend.missing')} /> : null}
            </span>
          ) : null}
          {folder ? (
            <span className="home__chip inline-flex max-w-full items-center gap-1.5 rounded-chip bg-field px-2.5 py-1 text-[12px] text-ink-2 shadow-hairline" title={folder}>
              <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
              <span className="truncate">{folder}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="suggestions mx-auto mt-5 grid w-full max-w-[420px] grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2" data-testid="suggestions">
        {SUGGESTIONS.map(({ key, icon }) => (
          <button
            key={key}
            type="button"
            className="suggestion flex items-start gap-2.5 rounded-card bg-surface p-3 text-left text-ink shadow-card transition-[transform,background-color,box-shadow] duration-150 hover:-translate-y-px hover:bg-inset hover:shadow-raised active:translate-y-0"
            onClick={() => requestPrefill(t(`empty.suggest.${key}Prompt` as MessageKey))}
          >
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-field text-ink-2">
              {icon}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12.5px] leading-snug font-medium text-ink">{t(`empty.suggest.${key}` as MessageKey)}</span>
              <span className="text-[11.5px] leading-snug text-ink-3">{t(`empty.suggest.${key}Desc` as MessageKey)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap justify-center gap-x-3.5 gap-y-1.5 text-[11.5px] text-ink-3" aria-hidden="true">
        <span className="inline-flex items-center gap-1">
          <kbd className="inline-block min-w-[1.5em] rounded-[5px] bg-surface px-1 py-0.5 text-center font-mono text-[11px] leading-none text-ink-2 shadow-hairline">@</kbd>
          {t('home.tips.mention')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="inline-block min-w-[1.5em] rounded-[5px] bg-surface px-1 py-0.5 text-center font-mono text-[11px] leading-none text-ink-2 shadow-hairline">/</kbd>
          {t('home.tips.command')}
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="inline-block min-w-[1.5em] rounded-[5px] bg-surface px-1 py-0.5 text-center font-mono text-[11px] leading-none text-ink-2 shadow-hairline">⇧</kbd>
          <kbd className="inline-block min-w-[1.5em] rounded-[5px] bg-surface px-1 py-0.5 text-center font-mono text-[11px] leading-none text-ink-2 shadow-hairline">↵</kbd>
          {t('home.tips.newline')}
        </span>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  { key: 'project', icon: <BookIcon className="size-3.5" /> },
  { key: 'bugs', icon: <BugIcon className="size-3.5" /> },
  { key: 'tests', icon: <BeakerIcon className="size-3.5" /> },
  { key: 'commit', icon: <DiffIcon className="size-3.5" /> },
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

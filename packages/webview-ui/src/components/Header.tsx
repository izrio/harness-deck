/**
 * 工作台顶栏（精简工具条）：
 * 左侧：侧边栏展开/收起按钮（移动端为抽屉入口）+ 当前页面标题
 * 右侧：移动端连接状态 / 新建会话 / 全宽工作台 / 右侧工作区面板展开按钮
 */
import { useEffect, useRef, useState } from 'react';
import type { RemoteRouteKind } from '@harness-deck/shared';
import type { WorkbenchModule } from '@harness-deck/shared/limits';
import { openSettingsPage, setActiveModule, setSettingsTab, toggleRightPanel, useView } from '../store.ts';
import { postToHost, reconnectMobileTransport, useTransportState } from '../vscode.ts';
import { useIsMobile } from '../hooks/use-mobile.ts';
import { cn } from '../lib/utils.ts';
import {
  ChatIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ExpandPanelIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  PanelRightIcon,
  QrCodeIcon,
  SettingsIcon,
  SidebarIcon,
  SmartphoneIcon,
  UsersIcon,
  WifiIcon,
  WifiOffIcon,
} from './icons.tsx';
import { BackendLogo } from './BackendLogo.tsx';
import { QrCodeSvg } from './QrCodeSvg.tsx';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '../i18n.ts';

function renderModuleIcon(mod: WorkbenchModule) {
  switch (mod) {
    case 'overview':
      return <LayoutDashboardIcon className="size-3.5 shrink-0" />;
    case 'changes':
      return <GitBranchIcon className="size-3.5 shrink-0" />;
    case 'schedules':
      return <ClockIcon className="size-3.5 shrink-0" />;
    case 'agents':
      return <UsersIcon className="size-3.5 shrink-0" />;
    case 'tasks':
      return <ListTodoIcon className="size-3.5 shrink-0" />;
    case 'sessions':
      return <ChatIcon className="size-3.5 shrink-0" />;
  }
}

export function Header({
  sidebarOpen = true,
  onToggleSidebar,
  onOpenMobileDrawer,
}: {
  readonly sidebarOpen?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly onOpenMobileDrawer?: () => void;
}) {
  const isMobile = useIsMobile();
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);
  const remoteReadOnly = clientSurface === 'mobile-web' && clientScope === 'read-only';
  const settingsOpen = useView((s) => s.settingsOpen);
  const activeModule = useView((s) => s.activeModule);
  const rightPanelOpen = useView((s) => s.rightPanelOpen);
  const backends = useView((s) => s.backends);
  const connection = useView((s) => s.connection);
  const runtime = useView((s) => s.runtime);
  const sessionRunning = useView((s) => s.session.running);
  const interactionsCount = useView((s) => s.interactions.length);
  const sessionGroups = useView((s) => s.workbench.sessionGroups);
  const tabs = useView((s) => s.tabs.items);
  const transport = useTransportState();
  const t = useT();

  const startedRuntimes = backends.items.filter((b) => {
    if (b.alive || b.running) return true;
    if (b.id === backends.active && (connection === 'connected' || runtime.kind === 'connected' || runtime.kind === 'starting')) {
      return true;
    }
    return false;
  });

  const attentionBackendIds = new Set<string>();
  if (interactionsCount > 0 && backends.active) {
    attentionBackendIds.add(backends.active);
  }
  for (const tab of tabs) {
    if (tab.needsAttention && tab.backendId) attentionBackendIds.add(tab.backendId);
  }
  for (const group of sessionGroups) {
    for (const s of group.sessions) {
      if (s.needsAttention) attentionBackendIds.add(s.backendId);
    }
  }

  const currentTitle = settingsOpen
    ? t('header.settings')
    : t(`wb.nav.${activeModule}` as MessageKey);

  return (
    <header className="header surface-glass flex shrink-0 flex-col border-b border-line">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {isMobile ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="mobile-sessions-drawer-btn"
              aria-label={t('wb.sidebar.title')}
              onClick={onOpenMobileDrawer}
              className="text-ink-2 hover:bg-hover hover:text-ink"
            >
              <SidebarIcon className="size-3.5" />
              <span className="truncate font-medium text-ink">{currentTitle}</span>
            </Button>
          ) : (
            <>
              {!settingsOpen ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="toggle-project-groups"
                  aria-label={t('wb.sessions.toggleSidebar')}
                  aria-expanded={sidebarOpen}
                  title={t('wb.sessions.toggleSidebar')}
                  className="text-ink-2 hover:bg-hover hover:text-ink"
                  onClick={onToggleSidebar}
                >
                  <SidebarIcon className="size-3.5" />
                </Button>
              ) : null}
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-4 font-medium text-ink">
                <span className="inline-flex shrink-0 items-center text-ink-2">
                  {settingsOpen ? (
                    <SettingsIcon className="size-3.5 shrink-0" />
                  ) : (
                    renderModuleIcon(activeModule)
                  )}
                </span>
                <span className="truncate leading-4">{currentTitle}</span>
              </span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1" data-testid="header-actions">
          {startedRuntimes.length > 0 ? (
            <div
              className="mr-1 flex items-center gap-1"
              role="group"
              aria-label={t('header.runtime.listLabel')}
              data-testid="header-started-runtimes"
            >
              {startedRuntimes.map((backend) => {
                const isActive = backend.id === backends.active;
                const isAttention = attentionBackendIds.has(backend.id);
                const isRunning = Boolean(backend.running || (isActive && sessionRunning));
                const statusKind = isAttention ? 'attention' : isRunning ? 'running' : 'idle';
                const statusTitle =
                  statusKind === 'attention'
                    ? t('header.runtime.attention', backend.name)
                    : statusKind === 'running'
                      ? t('header.runtime.running', backend.name)
                      : t('header.runtime.idle', backend.name);
                return (
                  <Button
                    key={backend.id}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={remoteReadOnly}
                    data-testid={`header-runtime-${backend.id}`}
                    data-runtime-status={statusKind}
                    aria-label={statusTitle}
                    aria-pressed={isActive}
                    title={statusTitle}
                    onClick={() => {
                      setActiveModule('sessions');
                      if (backend.id !== backends.active) {
                        postToHost({ type: 'selectBackend', payload: { id: backend.id } });
                      }
                    }}
                    className={cn(
                      'relative rounded-full transition-colors',
                      isActive
                        ? 'bg-surface shadow-hairline ring-1 ring-brand/45 hover:bg-surface'
                        : 'bg-field/75 hover:bg-hover',
                    )}
                  >
                    <BackendLogo backend={backend} size="sm" />
                    <span
                      aria-hidden="true"
                      data-testid={`header-runtime-dot-${backend.id}`}
                      className={cn(
                        'pointer-events-none absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-[1.5px] ring-sidebar',
                        statusKind === 'attention'
                          ? 'bg-orange'
                          : statusKind === 'running'
                            ? 'bg-brand animate-pulse'
                            : 'bg-green',
                      )}
                    />
                  </Button>
                );
              })}
              <span aria-hidden="true" className="ml-0.5 h-3.5 w-px bg-line/70" />
            </div>
          ) : null}
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
              {transport.pendingOutboxCount > 0 ? (
                <span
                  data-testid="mobile-outbox-badge"
                  className="rounded-full bg-canvas/80 px-1 text-[10px] font-semibold tabular-nums"
                  title={t('mobile.conn.pendingOutbox', transport.pendingOutboxCount)}
                >
                  {transport.pendingOutboxCount}
                </span>
              ) : null}
            </button>
          ) : null}
          {clientSurface !== 'mobile-web' ? <IdeRemoteQuickPopover /> : null}
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
          {!settingsOpen ? (
            <Button
              type="button"
              variant={rightPanelOpen ? 'secondary' : 'ghost'}
              size="icon-xs"
              data-testid="toggle-right-panel"
              aria-label={t('wb.rightPanel.toggle')}
              aria-expanded={rightPanelOpen}
              title={t('wb.rightPanel.toggle')}
              onClick={toggleRightPanel}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function IdeRemoteQuickPopover() {
  const t = useT();
  const remote = useView((s) => s.remote);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  const enabled = remote?.enabled === true;
  const running = remote?.running === true;
  const connectedCount = remote?.connectedClients ?? 0;
  const pairing = remote?.pairing;

  const preferredRoute: RemoteRouteKind = remote?.quickTunnel?.url
    ? 'quick-tunnel'
    : remote?.tailscale?.serveEnabled && remote.tailscale.serveUrl
      ? 'tailscale'
      : remote?.tunnelUrl
        ? 'tunnel'
        : 'lan';

  const copyPairing = () => {
    if (!pairing?.url) return;
    void navigator.clipboard?.writeText(pairing.url).catch(() => undefined);
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={connectedCount > 0 ? 'xs' : 'icon-xs'}
          data-testid="ide-remote-btn"
          aria-label={t('remote.header.title')}
          title={
            running
              ? connectedCount > 0
                ? t('remote.header.onlineCount', connectedCount)
                : t('remote.header.title')
              : `${t('remote.header.title')} (${t('remote.header.offline')})`
          }
          className={cn(
            'relative text-ink-2 hover:text-ink',
            connectedCount > 0 && 'gap-1 px-1.5 text-[11px] text-green hover:text-green',
          )}
        >
          <SmartphoneIcon className="size-3.5" />
          {running && connectedCount === 0 ? (
            <span className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-green" />
          ) : null}
          {connectedCount > 0 ? <span className="font-medium tabular-nums">{connectedCount}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3.5" data-testid="ide-remote-popover">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', running ? 'bg-green' : 'bg-ink-4')} />
              <span className="truncate text-[12.5px] font-semibold text-ink">{t('remote.header.title')}</span>
            </div>
            <Switch
              data-testid="ide-remote-switch"
              aria-label={t('remote.enabled')}
              checked={enabled}
              onCheckedChange={(checked) => postToHost({ type: 'setRemoteEnabled', payload: { enabled: checked } })}
            />
          </div>

          {running ? (
            <div className="flex flex-col gap-2.5">
              {pairing ? (
                <div className="flex flex-col items-center gap-2.5 rounded-xl bg-field/65 p-3 dark:bg-surface/80">
                  <QrCodeSvg value={pairing.url} size={156} />
                  <div className="flex w-full items-center justify-between gap-1.5">
                    <span className="truncate text-[11px] text-ink-3">
                      {t(`remote.route.${pairing.routeKind}` as MessageKey)}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      data-testid="ide-remote-copy-btn"
                      onClick={copyPairing}
                    >
                      {copied ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                      <span>{t('remote.copyPairing')}</span>
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  data-testid="ide-remote-generate-qr"
                  onClick={() =>
                    postToHost({
                      type: 'generateRemotePairing',
                      payload: { scope: remote?.scope ?? 'operate', routeKind: preferredRoute },
                    })
                  }
                >
                  <QrCodeIcon className="size-3.5" />
                  <span>{t('remote.generatePairing')}</span>
                </Button>
              )}

              {connectedCount > 0 ? (
                <div className="flex items-center justify-between text-[11.5px] text-ink-2">
                  <span>{t('remote.header.onlineCount', connectedCount)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-ink-3 hover:text-ink"
                    onClick={() => postToHost({ type: 'disconnectAllRemote', payload: {} })}
                  >
                    {t('remote.disconnectAll')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-ink-2 hover:text-ink"
              data-testid="ide-remote-open-settings"
              onClick={() => {
                setOpen(false);
                setSettingsTab('remote');
                openSettingsPage();
              }}
            >
              <SettingsIcon className="size-3" />
              <span>{t('remote.header.openSettings')}</span>
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

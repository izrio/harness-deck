/**
 * 设置 -> 手机端远程互通（HD-23 / HD-26 / HD-27）：
 * - IDE 端：总开关、LAN 网卡与作用域、一键公网临时隧道（Cloudflare Quick Tunnel）、Tailscale、BYO 隧道、
 *   QR 配对码、已授权设备管理（重命名 / 实时切换只读或可操作 / 吊销）、Web Push 与主流 IM Webhook 推送
 * - 手机端（mobile-web）：当前设备权限、Web Push 订阅、免重扫跨入口切换（Handoff 票据）与安全退出
 */
import { useEffect, useRef, useState } from 'react';
import type { RemoteDeviceView, RemoteRouteKind, RemoteScope, RemoteWebhookPreset } from '@harness-deck/shared';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { relativeTime } from '../../lib/time.ts';
import { showToast, useView } from '../../store.ts';
import {
  logoutMobileDevice,
  navigateToRemoteRoute,
  postToHost,
  registerMobilePush,
  unregisterMobilePush,
  useTransportState,
} from '../../vscode.ts';
import {
  BellIcon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  LinkIcon,
  LogOutIcon,
  MoreIcon,
  PencilIcon,
  QrCodeIcon,
  RefreshIcon,
  ShieldIcon,
  ShieldOffIcon,
  SmartphoneIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { QrCodeSvg } from '../QrCodeSvg.tsx';
import { SettingsSection } from './SettingsSection.tsx';

const WEBHOOK_PRESETS: readonly RemoteWebhookPreset[] = [
  'bark',
  'ntfy',
  'feishu',
  'wecom',
  'dingtalk',
  'telegram',
  'slack',
  'discord',
  'custom',
];

function webhookUrlPlaceholder(preset: RemoteWebhookPreset, fallback: string): string {
  switch (preset) {
    case 'bark':
      return 'https://api.day.app/<key>/';
    case 'ntfy':
      return 'https://ntfy.sh/<topic>';
    case 'feishu':
      return 'https://open.feishu.cn/open-apis/bot/v2/hook/<token>';
    case 'wecom':
      return 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>';
    case 'dingtalk':
      return 'https://oapi.dingtalk.com/robot/send?access_token=<token>';
    case 'telegram':
      return 'https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>';
    case 'slack':
      return 'https://hooks.slack.com/services/T.../B.../...';
    case 'discord':
      return 'https://discord.com/api/webhooks/<id>/<token>';
    default:
      return fallback;
  }
}

function presetSupportsSecret(preset: RemoteWebhookPreset): boolean {
  return preset === 'feishu' || preset === 'dingtalk' || preset === 'telegram';
}

function formatExpiryClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(ts);
  }
}

export function RemoteSettings() {
  const clientSurface = useView((s) => s.clientSurface);
  if (clientSurface === 'mobile-web') {
    return <MobileRemoteSelfPanel />;
  }
  return <IdeRemoteSettingsPanel />;
}

function MobileRemoteSelfPanel() {
  const t = useT();
  const scope = useView((s) => s.clientScope);
  const remote = useView((s) => s.remote);
  const transport = useTransportState();
  const vapidPublicKey = remote?.push?.vapidPublicKey ?? transport.vapidPublicKey;
  const pushSupported =
    typeof window !== 'undefined' &&
    typeof Notification !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    Boolean(vapidPublicKey);
  const [pushBusy, setPushBusy] = useState(false);

  return (
    <div className="flex flex-col gap-8" data-testid="settings-remote-mobile">
      <SettingsSection title={t('remote.mobileCardTitle')} testId="remote-mobile-self">
        <div className="flex flex-col gap-5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
              <SmartphoneIcon className="size-4 text-accent-ink" />
              <span>{transport.device?.name ?? 'Mobile Browser'}</span>
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[11px]',
                  scope === 'operate'
                    ? 'bg-accent-tint/75 text-accent-ink'
                    : 'bg-canvas/80 text-ink-2 dark:bg-page/55',
                )}
              >
                {t('remote.mobileCardScope', scope)}
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="mobile-logout-btn"
              onClick={() => void logoutMobileDevice()}
            >
              <LogOutIcon className="size-3.5" />
              <span>{t('remote.mobileLogout')}</span>
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-medium text-ink">{t('remote.mobilePushToggle')}</span>
            {pushSupported && vapidPublicKey ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  data-testid="mobile-push-subscribe-btn"
                  disabled={pushBusy}
                  onClick={() => {
                    setPushBusy(true);
                    void registerMobilePush(vapidPublicKey)
                      .then((ok) => {
                        showToast(ok ? 'info' : 'error', t(ok ? 'remote.mobilePushEnabledToast' : 'remote.mobilePushDeniedToast'));
                      })
                      .catch(() => {
                        showToast('error', t('remote.mobilePushDeniedToast'));
                      })
                      .finally(() => setPushBusy(false));
                  }}
                >
                  <BellIcon className="size-3.5" />
                  <span>{t('remote.mobilePushBtn')}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="mobile-push-unsubscribe-btn"
                  disabled={pushBusy}
                  onClick={() => {
                    setPushBusy(true);
                    void unregisterMobilePush()
                      .then(() => showToast('info', t('remote.mobilePushDisabledToast')))
                      .finally(() => setPushBusy(false));
                  }}
                >
                  <span>{t('remote.mobilePushOffBtn')}</span>
                </Button>
              </div>
            ) : (
              <p className="m-0 text-[11.5px] text-ink-3">{t('remote.mobilePushUnsupported')}</p>
            )}
          </div>

          {transport.routes.length > 0 ? (
            <div className="flex flex-col gap-2" data-testid="mobile-routes-list">
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                <LinkIcon className="size-3.5 text-ink-2" />
                <span>{t('remote.mobileRoutesTitle')}</span>
              </span>
              <div className="flex flex-col gap-1.5">
                {transport.routes.map((route) => (
                  <button
                    key={`${route.kind}:${route.url}`}
                    type="button"
                    onClick={() => void navigateToRemoteRoute(route.url)}
                    className="flex w-full items-center justify-between gap-2.5 rounded-xl bg-canvas/80 px-3 py-2 text-left text-[12px] text-ink transition-colors hover:bg-canvas dark:bg-page/55 dark:hover:bg-page/80"
                  >
                    <span className={cn('shrink-0 text-[11px] font-medium', route.kind === 'lan' ? 'text-ink-2' : 'text-accent-ink')}>
                      {t(`remote.route.${route.kind}` as MessageKey)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{route.url}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <p className="m-0 text-[11.5px] text-ink-3">{t('remote.mobileBlockedHint')}</p>
        </div>
      </SettingsSection>
    </div>
  );
}

function IdeRemoteSettingsPanel() {
  const t = useT();
  const remote = useView((s) => s.remote);
  const [routeKind, setRouteKind] = useState<RemoteRouteKind>('lan');
  const [pairScope, setPairScope] = useState<RemoteScope>(remote?.scope ?? 'operate');
  const [tunnelDraft, setTunnelDraft] = useState(remote?.tunnelUrl ?? '');
  const [webhookUrlDraft, setWebhookUrlDraft] = useState(remote?.push?.webhook.url ?? '');
  const [webhookSecretDraft, setWebhookSecretDraft] = useState(remote?.push?.webhook.secret ?? '');
  const [copiedPairing, setCopiedPairing] = useState(false);
  const [copiedWslCmd, setCopiedWslCmd] = useState(false);
  const [copiedQuickTunnel, setCopiedQuickTunnel] = useState(false);
  const [renamingDevice, setRenamingDevice] = useState<RemoteDeviceView | undefined>();
  const [renameDraft, setRenameDraft] = useState('');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyWslTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyQtTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(copyTimerRef.current);
      clearTimeout(copyWslTimerRef.current);
      clearTimeout(copyQtTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (remote?.scope) setPairScope(remote.scope);
  }, [remote?.scope]);

  useEffect(() => {
    setTunnelDraft(remote?.tunnelUrl ?? '');
  }, [remote?.tunnelUrl]);

  useEffect(() => {
    setWebhookUrlDraft(remote?.push?.webhook.url ?? '');
    setWebhookSecretDraft(remote?.push?.webhook.secret ?? '');
  }, [remote?.push?.webhook.url, remote?.push?.webhook.secret]);

  const enabled = remote?.enabled === true;
  const running = remote?.running === true;
  const devices = remote?.devices ?? [];
  const pairing = remote?.pairing;
  const tailscale = remote?.tailscale;
  const quickTunnel = remote?.quickTunnel;
  const push = remote?.push ?? {
    webPushEnabled: true,
    suppressWhenFocused: true,
    webhook: { enabled: false, preset: 'bark' as RemoteWebhookPreset, url: '' },
  };

  const copyPairingUrl = () => {
    if (!pairing?.url) return;
    void navigator.clipboard?.writeText(pairing.url).catch(() => undefined);
    setCopiedPairing(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedPairing(false), 1_500);
  };

  const copyWslSetupCommand = () => {
    const cmd = remote?.wslNat?.setupCommand;
    if (!cmd) return;
    void navigator.clipboard?.writeText(cmd).catch(() => undefined);
    setCopiedWslCmd(true);
    clearTimeout(copyWslTimerRef.current);
    copyWslTimerRef.current = setTimeout(() => setCopiedWslCmd(false), 1_500);
  };

  const copyQuickTunnelUrl = () => {
    if (!quickTunnel?.url) return;
    void navigator.clipboard?.writeText(quickTunnel.url).catch(() => undefined);
    setCopiedQuickTunnel(true);
    clearTimeout(copyQtTimerRef.current);
    copyQtTimerRef.current = setTimeout(() => setCopiedQuickTunnel(false), 1_500);
  };

  const submitDeviceRename = () => {
    if (!renamingDevice || !renameDraft.trim()) return;
    postToHost({
      type: 'updateRemoteDevice',
      payload: { deviceId: renamingDevice.id, name: renameDraft.trim() },
    });
    setRenamingDevice(undefined);
  };

  return (
    <div className="flex flex-col gap-8" data-testid="settings-remote">
      {/* 1. 总开关与运行状态 */}
      <SettingsSection
        title={t('remote.title')}
        testId="remote-bridge-section"
        actions={
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex items-center gap-1.5 text-[11.5px] tabular-nums', running ? 'text-green' : 'text-ink-3')}>
              <span className={cn('size-1.5 rounded-full', running ? 'bg-green' : 'bg-ink-4')} />
              <span>
                {running
                  ? t('remote.status.running', remote?.port ?? 0, remote?.connectedClients ?? 0)
                  : t('remote.status.stopped')}
              </span>
            </span>
            {running && ((remote?.connectedClients ?? 0) > 0 || Boolean(pairing)) ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-ink-2 hover:text-ink"
                data-testid="remote-disconnect-all-btn"
                onClick={() => postToHost({ type: 'disconnectAllRemote', payload: {} })}
              >
                <ShieldOffIcon className="size-3" />
                <span>{t('remote.disconnectAll')}</span>
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-[12.5px] font-medium text-ink">{t('remote.enabled')}</span>
            <Switch
              data-testid="remote-enabled-switch"
              aria-label={t('remote.enabled')}
              checked={enabled}
              onCheckedChange={(checked) => postToHost({ type: 'setRemoteEnabled', payload: { enabled: checked } })}
            />
          </div>
          {remote?.error ? (
            <p className="m-0 rounded-xl bg-red-tint px-3 py-2 text-[12px] text-red">{remote.error}</p>
          ) : null}
        </div>
      </SettingsSection>

      {/* 2. 网络入口、一键公网隧道、Tailscale 与自定义隧道 */}
      <SettingsSection
        title={t('remote.networkTitle')}
        testId="remote-network-section"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-ink-2 hover:text-ink"
            data-testid="remote-refresh-network-btn"
            onClick={() => postToHost({ type: 'refreshRemoteNetwork', payload: {} })}
          >
            <RefreshIcon className="size-3" />
            <span>{t('remote.refreshNetwork')}</span>
          </Button>
        }
      >
        <div className="flex flex-col gap-5 p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="remote-lan-select" className="text-[12px] font-medium text-ink-2">
                {t('remote.lanHost')}
              </label>
              <Select
                value={remote?.selectedHost || ((remote?.interfaces ?? []).length === 0 ? '127.0.0.1' : undefined)}
                onValueChange={(value) => postToHost({ type: 'setRemoteConfig', payload: { selectedHost: value } })}
              >
                <SelectTrigger
                  id="remote-lan-select"
                  size="sm"
                  className="w-full"
                  data-testid="remote-lan-select"
                  aria-label={t('remote.lanHost')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(remote?.interfaces ?? []).length === 0 ? (
                    <SelectItem value="127.0.0.1">127.0.0.1</SelectItem>
                  ) : (
                    (remote?.interfaces ?? []).map((iface) => (
                      <SelectItem key={`${iface.name}-${iface.address}`} value={iface.address}>
                        {iface.address} ({iface.name})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">{t('remote.defaultScope')}</span>
              <Select
                value={pairScope}
                onValueChange={(value) => {
                  const next = value as RemoteScope;
                  setPairScope(next);
                  postToHost({ type: 'setRemoteConfig', payload: { scope: next } });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  data-testid="remote-scope-select"
                  aria-label={t('remote.defaultScope')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="operate">{t('remote.scope.operate')}</SelectItem>
                  <SelectItem value="read-only">{t('remote.scope.readOnly')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {remote?.wslNat?.active ? (
            <div
              data-testid="remote-wsl-nat-card"
              className="flex flex-col gap-2 rounded-xl bg-canvas/80 px-3.5 py-3 dark:bg-page/55"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink">{t('remote.wslNatTitle')}</span>
                <span className={cn('text-[11px] font-medium', remote.wslNat.portProxyConfigured ? 'text-green' : 'text-ink-3')}>
                  {remote.wslNat.portProxyConfigured ? t('remote.wslNatReady') : t('remote.wslNatNeeded')}
                </span>
              </div>
              <p className="m-0 text-[11.5px] text-ink-3">
                {remote.wslNat.portProxyConfigured
                  ? t(
                      'remote.wslNatReadyHint',
                      remote.wslNat.windowsAddress,
                      remote.port ?? 37890,
                      remote.wslNat.wslAddress,
                    )
                  : t('remote.wslNatNeededHint', remote.wslNat.windowsAddress, remote.wslNat.wslAddress)}
              </p>
              {!remote.wslNat.portProxyConfigured ? (
                <>
                  <code
                    data-testid="remote-wsl-nat-cmd"
                    className="block rounded-lg bg-field/80 px-2.5 py-2 font-mono text-[11px] break-all text-ink dark:bg-surface/80"
                  >
                    {remote.wslNat.setupCommand}
                  </code>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      data-testid="remote-copy-wsl-cmd-btn"
                      onClick={copyWslSetupCommand}
                    >
                      {copiedWslCmd ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                      <span>{t('remote.wslNatCopyCmd')}</span>
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {/* 一键公网临时隧道（Cloudflare Quick Tunnel） */}
          <div className="flex flex-col gap-2" data-testid="remote-quick-tunnel-block">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
                <GlobeIcon className="size-3.5" />
                <span>{t('remote.quickTunnelTitle')}</span>
                {quickTunnel?.status === 'starting' ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-accent-ink">
                    <SpinnerIcon className="size-3" />
                    <span>{t('remote.quickTunnelStarting')}</span>
                  </span>
                ) : quickTunnel?.status === 'running' ? (
                  <span className="text-[11px] text-green">{t('remote.quickTunnelReady')}</span>
                ) : null}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-ink-2 hover:text-ink"
                  data-testid="remote-quick-tunnel-probe-btn"
                  onClick={() => postToHost({ type: 'probeQuickTunnel', payload: {} })}
                >
                  <RefreshIcon className="size-3" />
                  <span>{t('remote.quickTunnelProbe')}</span>
                </Button>
                <Switch
                  data-testid="remote-quick-tunnel-switch"
                  aria-label={t('remote.quickTunnelToggle')}
                  disabled={quickTunnel?.status === 'starting' || quickTunnel?.installed === false}
                  checked={quickTunnel?.status === 'running' || quickTunnel?.status === 'starting'}
                  onCheckedChange={(checked) =>
                    postToHost({ type: 'setQuickTunnelEnabled', payload: { enabled: checked } })
                  }
                />
              </div>
            </div>
            {quickTunnel && !quickTunnel.installed ? (
              <p className="m-0 text-[11.5px] text-ink-3">{t('remote.quickTunnelNotInstalled')}</p>
            ) : quickTunnel?.url ? (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-canvas/80 px-3 py-2 dark:bg-page/55">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink" data-testid="remote-quick-tunnel-url">
                  {quickTunnel.url}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  data-testid="remote-quick-tunnel-copy-btn"
                  onClick={copyQuickTunnelUrl}
                >
                  {copiedQuickTunnel ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                  <span>{t('remote.quickTunnelCopyUrl')}</span>
                </Button>
              </div>
            ) : quickTunnel?.error ? (
              <p className="m-0 text-[11.5px] text-red">{quickTunnel.error}</p>
            ) : null}
          </div>

          {/* Tailscale */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
                <GlobeIcon className="size-3.5" />
                <span>{t('remote.tailscaleTitle')}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-ink-2 hover:text-ink"
                data-testid="remote-tailscale-probe-btn"
                onClick={() => postToHost({ type: 'probeTailscale', payload: {} })}
              >
                <RefreshIcon className="size-3" />
                <span>{t('remote.tailscaleProbe')}</span>
              </Button>
            </div>
            {!tailscale ? null : !tailscale.installed ? (
              <p className="m-0 text-[11.5px] text-ink-3">{t('remote.tailscaleNotInstalled')}</p>
            ) : !tailscale.loggedIn ? (
              <p className="m-0 text-[11.5px] text-ink-3">
                {t('remote.tailscaleNotLoggedIn', tailscale.error ?? 'Not running')}
              </p>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-canvas/80 px-3 py-2.5 dark:bg-page/55">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-ink">
                    {t('remote.tailscaleReady', tailscale.dnsName ?? '')}
                  </div>
                  <div className="truncate text-[11px] text-ink-3">
                    {t('remote.tailscaleServeHint', tailscale.serveUrl ?? '')}
                  </div>
                </div>
                <Switch
                  data-testid="remote-tailscale-serve-switch"
                  aria-label={t('remote.tailscaleServeToggle')}
                  checked={tailscale.serveEnabled === true}
                  onCheckedChange={(checked) =>
                    postToHost({ type: 'configureTailscaleServe', payload: { enabled: checked } })
                  }
                />
              </div>
            )}
          </div>

          {/* BYO Tunnel */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">{t('remote.tunnelUrl')}</span>
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                data-testid="remote-tunnel-input"
                className="flex-1 font-mono"
                value={tunnelDraft}
                placeholder={t('remote.tunnelUrlPlaceholder')}
                onChange={(e) => setTunnelDraft(e.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="remote-tunnel-save-btn"
                onClick={() => postToHost({ type: 'setRemoteConfig', payload: { tunnelUrl: tunnelDraft.trim() } })}
              >
                {t('remote.tunnelSave')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* 3. 扫码配对 */}
      <SettingsSection title={t('remote.pairingTitle')} testId="remote-pairing-section">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={routeKind}
              onValueChange={(value) => setRouteKind(value as RemoteRouteKind)}
            >
              <SelectTrigger
                size="sm"
                aria-label={t('remote.pairingRoute')}
                data-testid="remote-pairing-route-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lan">{t('remote.route.lan')}</SelectItem>
                <SelectItem value="quick-tunnel" disabled={!quickTunnel?.url}>
                  {t('remote.route.quick-tunnel')}
                </SelectItem>
                <SelectItem value="tailscale" disabled={!tailscale?.serveUrl}>
                  {t('remote.route.tailscale')}
                </SelectItem>
                <SelectItem value="tunnel" disabled={!remote?.tunnelUrl}>
                  {t('remote.route.tunnel')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              data-testid="remote-generate-pairing-btn"
              onClick={() => postToHost({ type: 'generateRemotePairing', payload: { scope: pairScope, routeKind } })}
            >
              <QrCodeIcon className="size-3.5" />
              <span>{t('remote.generatePairing')}</span>
            </Button>
            {pairing ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-ink-2 hover:text-ink"
                data-testid="remote-clear-pairing-btn"
                onClick={() => postToHost({ type: 'clearRemotePairing', payload: {} })}
              >
                <span>{t('remote.clearPairing')}</span>
              </Button>
            ) : null}
          </div>

          {pairing ? (
            <div className="flex flex-col items-start gap-4 rounded-xl bg-canvas/85 p-3.5 sm:flex-row sm:items-center dark:bg-page/55">
              <QrCodeSvg value={pairing.url} />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
                  <span className="font-medium text-accent-ink">{pairing.scope}</span>
                  <span>·</span>
                  <span>{t(`remote.route.${pairing.routeKind}` as MessageKey)}</span>
                  <span>·</span>
                  <span className="tabular-nums">{t('remote.pairingExpires', formatExpiryClock(pairing.expiresAt))}</span>
                </div>
                <code className="block rounded-lg bg-field/80 px-2.5 py-2 font-mono text-[11px] break-all text-ink dark:bg-surface/80">
                  {pairing.url}
                </code>
                <div>
                  <Button type="button" variant="secondary" size="xs" data-testid="remote-copy-pairing-btn" onClick={copyPairingUrl}>
                    {copiedPairing ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                    <span>{t('remote.copyPairing')}</span>
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      {/* 4. 已授权设备列表（支持重命名、实时切换权限与吊销） */}
      <SettingsSection title={t('remote.devicesTitle', devices.length)} testId="remote-devices-section">
        {devices.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-ink-3">
            {t('remote.devicesEmpty')}
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-1.5">
            {devices.map((dev) => {
              const nextScope: RemoteScope = dev.scope === 'operate' ? 'read-only' : 'operate';
              return (
                <div
                  key={dev.id}
                  data-testid={`remote-device-${dev.id}`}
                  className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/70 dark:hover:bg-hover/35"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={cn('size-2 shrink-0 rounded-full', dev.connected ? 'bg-green' : 'bg-ink-4')} />
                      <span className="truncate text-[12.5px] font-medium text-ink">{dev.name}</span>
                      <span className={cn('text-[11.5px]', dev.scope === 'operate' ? 'text-accent-ink' : 'text-ink-3')}>
                        {dev.scope}
                      </span>
                      {dev.pushSubscribed ? (
                        <span className="text-[11px] text-green">{t('remote.devicePushOn')}</span>
                      ) : null}
                    </div>
                    <span className="pl-4 text-[11px] text-ink-3">
                      {dev.connected ? t('remote.deviceOnline') : t('remote.deviceOffline')} · {t('remote.deviceLastSeen', relativeTime(dev.lastSeenAt, t))}
                    </span>
                  </div>
                  <div className="shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-ink-2 hover:text-ink"
                          data-testid={`remote-device-actions-${dev.id}`}
                          aria-label={t('common.moreActions')}
                          title={t('common.moreActions')}
                        >
                          <MoreIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40">
                        <DropdownMenuItem
                          className="gap-2 text-[12.5px]"
                          data-testid={`remote-toggle-scope-${dev.id}`}
                          onSelect={() =>
                            postToHost({
                              type: 'updateRemoteDevice',
                              payload: { deviceId: dev.id, scope: nextScope },
                            })
                          }
                        >
                          <ShieldIcon className="size-3.5 text-ink-2" />
                          <span>
                            {nextScope === 'read-only'
                              ? t('remote.deviceSwitchToReadOnly')
                              : t('remote.deviceSwitchToOperate')}
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="gap-2 text-[12.5px]"
                          data-testid={`remote-rename-${dev.id}`}
                          onSelect={() => {
                            setRenamingDevice(dev);
                            setRenameDraft(dev.name);
                          }}
                        >
                          <PencilIcon className="size-3.5 text-ink-2" />
                          <span>{t('remote.deviceRename')}</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          className="gap-2 text-[12.5px]"
                          data-testid={`remote-revoke-${dev.id}`}
                          onSelect={() => postToHost({ type: 'revokeRemoteDevice', payload: { deviceId: dev.id } })}
                        >
                          <TrashIcon className="size-3.5" />
                          <span>{t('remote.revokeDevice')}</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {/* 5. 推送通知（Web Push + 主流 IM / Webhook） */}
      <SettingsSection
        title={t('remote.pushTitle')}
        testId="remote-push-section"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-ink-2 hover:text-ink"
            data-testid="remote-test-push-btn"
            onClick={() => postToHost({ type: 'testRemotePush', payload: {} })}
          >
            <BellIcon className="size-3" />
            <span>{t('remote.testPush')}</span>
          </Button>
        }
      >
        <div className="flex flex-col gap-1 p-1.5">
          <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/65 dark:hover:bg-hover/35">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">{t('remote.webPushEnabled')}</span>
            <Switch
              data-testid="remote-webpush-switch"
              aria-label={t('remote.webPushEnabled')}
              checked={push.webPushEnabled}
              onCheckedChange={(checked) => postToHost({ type: 'setRemotePushConfig', payload: { webPushEnabled: checked } })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-canvas/65 dark:hover:bg-hover/35">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">{t('remote.suppressFocused')}</span>
            <Switch
              data-testid="remote-suppress-focused-switch"
              aria-label={t('remote.suppressFocused')}
              checked={push.suppressWhenFocused}
              onCheckedChange={(checked) =>
                postToHost({ type: 'setRemotePushConfig', payload: { suppressWhenFocused: checked } })
              }
            />
          </div>

          <div className="flex flex-col gap-3 rounded-xl px-3 py-2.5">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[12.5px] font-medium text-ink">{t('remote.webhookEnabled')}</span>
              <Switch
                data-testid="remote-webhook-switch"
                aria-label={t('remote.webhookEnabled')}
                checked={push.webhook.enabled}
                onCheckedChange={(checked) =>
                  postToHost({ type: 'setRemotePushConfig', payload: { webhook: { enabled: checked } } })
                }
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={push.webhook.preset}
                onValueChange={(value) =>
                  postToHost({
                    type: 'setRemotePushConfig',
                    payload: { webhook: { preset: value as RemoteWebhookPreset } },
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="sm:w-40"
                  aria-label={t('remote.webhookPreset')}
                  data-testid="remote-webhook-preset"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEBHOOK_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {t(`remote.webhookPreset.${preset}` as MessageKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                size="sm"
                aria-label={t('remote.webhookUrl')}
                data-testid="remote-webhook-url"
                className="flex-1 font-mono"
                value={webhookUrlDraft}
                placeholder={webhookUrlPlaceholder(push.webhook.preset, t('remote.webhookUrlPlaceholder'))}
                onChange={(e) => setWebhookUrlDraft(e.target.value)}
                onBlur={() =>
                  webhookUrlDraft.trim() !== push.webhook.url &&
                  postToHost({ type: 'setRemotePushConfig', payload: { webhook: { url: webhookUrlDraft.trim() } } })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    postToHost({ type: 'setRemotePushConfig', payload: { webhook: { url: webhookUrlDraft.trim() } } });
                  }
                }}
              />
            </div>

            {presetSupportsSecret(push.webhook.preset) ? (
              <Input
                size="sm"
                type={push.webhook.preset === 'telegram' ? 'text' : 'password'}
                aria-label={
                  push.webhook.preset === 'telegram' ? t('remote.webhookTelegramChatId') : t('remote.webhookSecret')
                }
                data-testid="remote-webhook-secret"
                className="font-mono"
                value={webhookSecretDraft}
                placeholder={
                  push.webhook.preset === 'telegram'
                    ? t('remote.webhookTelegramChatIdPlaceholder')
                    : t('remote.webhookSecretPlaceholder')
                }
                onChange={(e) => setWebhookSecretDraft(e.target.value)}
                onBlur={() =>
                  webhookSecretDraft.trim() !== (push.webhook.secret ?? '') &&
                  postToHost({
                    type: 'setRemotePushConfig',
                    payload: { webhook: { secret: webhookSecretDraft.trim() } },
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    postToHost({
                      type: 'setRemotePushConfig',
                      payload: { webhook: { secret: webhookSecretDraft.trim() } },
                    });
                  }
                }}
              />
            ) : null}
          </div>
        </div>
      </SettingsSection>

      {/* 重命名远程设备弹窗 */}
      <Dialog open={Boolean(renamingDevice)} onOpenChange={(open) => !open && setRenamingDevice(undefined)}>
        <DialogContent className="sm:max-w-sm" data-testid="remote-device-rename-dialog">
          <DialogHeader>
            <DialogTitle>{t('remote.deviceRenameTitle')}</DialogTitle>
            <DialogDescription className="sr-only">{t('remote.deviceRenamePlaceholder')}</DialogDescription>
          </DialogHeader>
          <Input
            size="sm"
            autoFocus
            data-testid="remote-device-rename-input"
            value={renameDraft}
            placeholder={t('remote.deviceRenamePlaceholder')}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitDeviceRename();
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setRenamingDevice(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="remote-device-rename-confirm"
              disabled={!renameDraft.trim()}
              onClick={submitDeviceRename}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

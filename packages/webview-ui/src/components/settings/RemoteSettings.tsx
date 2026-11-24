/**
 * 设置 -> 手机端远程互通（HD-23 / HD-26 / HD-27）：
 * - IDE 端：总开关、LAN 网卡与作用域配置、Tailscale 探测与反代、BYO 隧道、QR 配对码、已授权设备管理与吊销、Web Push/Webhook 推送配置
 * - 手机端（mobile-web）：展示当前设备权限、浏览器 Web Push 订阅开关与安全退出按钮
 */
import { useEffect, useRef, useState } from 'react';
import type { RemoteRouteKind, RemoteScope, RemoteWebhookPreset } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT } from '../../i18n.ts';
import { relativeTime } from '../../lib/time.ts';
import { showToast, useView } from '../../store.ts';
import {
  logoutMobileDevice,
  postToHost,
  registerMobilePush,
  unregisterMobilePush,
  useTransportState,
} from '../../vscode.ts';
import { ValuePill } from '../beautifului/index.ts';
import {
  BellIcon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  LinkIcon,
  LogOutIcon,
  MoreIcon,
  QrCodeIcon,
  RefreshIcon,
  ShieldOffIcon,
  SmartphoneIcon,
  TrashIcon,
} from '../icons.tsx';
import { QrCodeSvg } from '../QrCodeSvg.tsx';
import { SettingsSection } from './SettingsSection.tsx';

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
    <div className="flex flex-col gap-5" data-testid="settings-remote-mobile">
      <SettingsSection title={t('remote.mobileCardTitle')} testId="remote-mobile-self">
        <div className="primitive-card-pad flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
              <SmartphoneIcon className="size-4 text-accent-ink" />
              <span>{transport.device?.name ?? 'Mobile Browser'}</span>
              <ValuePill tone={scope === 'operate' ? 'accent' : 'neutral'}>
                {t('remote.mobileCardScope', scope)}
              </ValuePill>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="mobile-logout-btn"
              onClick={() => void logoutMobileDevice()}
            >
              <LogOutIcon className="size-3.5" />
              <span>{t('remote.mobileLogout')}</span>
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <span className="text-[12.5px] font-medium text-ink">{t('remote.mobilePushToggle')}</span>
            <span className="text-[11.5px] text-ink-3">{t('remote.mobilePushHint')}</span>
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
                  variant="outline"
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
            <div className="flex flex-col gap-1.5 border-t border-line pt-3" data-testid="mobile-routes-list">
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                <LinkIcon className="size-3.5 text-ink-2" />
                <span>{t('remote.mobileRoutesTitle')}</span>
              </span>
              <div className="flex flex-col gap-1">
                {transport.routes.map((route) => (
                  <a
                    key={`${route.kind}:${route.url}`}
                    href={route.url}
                    className="flex items-center justify-between gap-2 rounded-control bg-field px-2.5 py-1.5 text-[12px] text-ink shadow-hairline hover:bg-hover"
                  >
                    <ValuePill tone={route.kind === 'lan' ? 'neutral' : 'accent'}>{t(`remote.route.${route.kind}`)}</ValuePill>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{route.url}</span>
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          <p className="m-0 border-t border-line pt-2 text-[11.5px] text-ink-3">{t('remote.mobileBlockedHint')}</p>
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
  const [copiedPairing, setCopiedPairing] = useState(false);
  const [copiedWslCmd, setCopiedWslCmd] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyWslTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(copyTimerRef.current);
      clearTimeout(copyWslTimerRef.current);
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
  }, [remote?.push?.webhook.url]);

  const enabled = remote?.enabled === true;
  const running = remote?.running === true;
  const devices = remote?.devices ?? [];
  const pairing = remote?.pairing;
  const tailscale = remote?.tailscale;
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

  return (
    <div className="flex flex-col gap-5" data-testid="settings-remote">
      {/* 1. 总开关与运行状态 */}
      <SettingsSection
        title={t('remote.title')}
        testId="remote-bridge-section"
        actions={
          <div className="flex items-center gap-1.5">
            <ValuePill tone={running ? 'green' : 'neutral'}>
              {running
                ? t('remote.status.running', remote?.port ?? 0, remote?.connectedClients ?? 0)
                : t('remote.status.stopped')}
            </ValuePill>
            {running && ((remote?.connectedClients ?? 0) > 0 || Boolean(pairing)) ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
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
        <div className="primitive-card-pad flex flex-col gap-3">
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
            <p className="m-0 rounded-control bg-red-tint px-2.5 py-1.5 text-[12px] text-red">{remote.error}</p>
          ) : null}
        </div>
      </SettingsSection>

      {/* 2. 局域网接口、作用域、Tailscale 与自定义隧道 */}
      <SettingsSection title={t('remote.networkTitle')} testId="remote-network-section">
        <div className="primitive-card-pad flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="remote-lan-select" className="text-[12.5px] font-medium text-ink">
                {t('remote.lanHost')}
              </label>
              <Button
                type="button"
                variant="outline"
                size="xs"
                data-testid="remote-refresh-network-btn"
                onClick={() => postToHost({ type: 'refreshRemoteNetwork', payload: {} })}
              >
                <RefreshIcon className="size-3" />
                <span>{t('remote.refreshNetwork')}</span>
              </Button>
            </div>
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

          {remote?.wslNat?.active ? (
            <div
              data-testid="remote-wsl-nat-card"
              className="flex flex-col gap-2 rounded-control bg-field px-2.5 py-2 shadow-hairline"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink">{t('remote.wslNatTitle')}</span>
                <ValuePill tone={remote.wslNat.portProxyConfigured ? 'green' : 'neutral'}>
                  {remote.wslNat.portProxyConfigured ? t('remote.wslNatReady') : t('remote.wslNatNeeded')}
                </ValuePill>
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
                    className="block rounded-control bg-surface px-2 py-1.5 font-mono text-[11px] break-all text-ink shadow-hairline"
                  >
                    {remote.wslNat.setupCommand}
                  </code>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
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

          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-ink">{t('remote.defaultScope')}</span>
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

          {/* Tailscale */}
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                <GlobeIcon className="size-3.5 text-ink-2" />
                <span>{t('remote.tailscaleTitle')}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
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
              <div className="flex items-center justify-between gap-3 rounded-control bg-field px-2.5 py-2 shadow-hairline">
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
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <span className="text-[12.5px] font-medium text-ink">{t('remote.tunnelUrl')}</span>
            <div className="flex items-center gap-1.5">
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
                variant="outline"
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
        <div className="primitive-card-pad flex flex-col gap-3">
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
                variant="outline"
                size="sm"
                data-testid="remote-clear-pairing-btn"
                onClick={() => postToHost({ type: 'clearRemotePairing', payload: {} })}
              >
                <span>{t('remote.clearPairing')}</span>
              </Button>
            ) : null}
          </div>

          {pairing ? (
            <div className="flex flex-col items-start gap-3 rounded-card bg-field p-3 shadow-hairline sm:flex-row sm:items-center">
              <QrCodeSvg value={pairing.url} />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ValuePill tone="accent">{pairing.scope}</ValuePill>
                  <ValuePill tone="neutral">{t(`remote.route.${pairing.routeKind}`)}</ValuePill>
                  <span className="text-[11px] text-ink-3">{t('remote.pairingExpires', formatExpiryClock(pairing.expiresAt))}</span>
                </div>
                <code className="block rounded-control bg-surface px-2 py-1.5 font-mono text-[11px] break-all text-ink shadow-hairline">
                  {pairing.url}
                </code>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="xs" data-testid="remote-copy-pairing-btn" onClick={copyPairingUrl}>
                    {copiedPairing ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                    <span>{t('remote.copyPairing')}</span>
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      {/* 4. 已授权设备列表 */}
      <SettingsSection title={t('remote.devicesTitle', devices.length)} testId="remote-devices-section">
        {devices.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-ink-3">
            {t('remote.devicesEmpty')}
          </div>
        ) : (
          <div className="divide-y divide-line/60">
            {devices.map((dev) => (
              <div
                key={dev.id}
                data-testid={`remote-device-${dev.id}`}
                className="flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors hover:bg-hover/35"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SmartphoneIcon className="size-3.5 shrink-0 text-ink-2" />
                    <span className="truncate text-[12.5px] font-medium text-ink">{dev.name}</span>
                    <ValuePill tone={dev.connected ? 'green' : 'neutral'}>
                      {dev.connected ? t('remote.deviceOnline') : t('remote.deviceOffline')}
                    </ValuePill>
                    <ValuePill tone={dev.scope === 'operate' ? 'accent' : 'neutral'}>{dev.scope}</ValuePill>
                    {dev.pushSubscribed ? <ValuePill tone="green">{t('remote.devicePushOn')}</ValuePill> : null}
                  </div>
                  <span className="text-[11px] text-ink-3">
                    {t('remote.deviceLastSeen', relativeTime(dev.lastSeenAt, t))}
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
                    <DropdownMenuContent align="end" className="min-w-36">
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
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 5. 推送通知（Web Push + Webhook） */}
      <SettingsSection
        title={t('remote.pushTitle')}
        testId="remote-push-section"
        actions={
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="remote-test-push-btn"
            onClick={() => postToHost({ type: 'testRemotePush', payload: {} })}
          >
            <BellIcon className="size-3" />
            <span>{t('remote.testPush')}</span>
          </Button>
        }
      >
        <div className="divide-y divide-line/60">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">{t('remote.webPushEnabled')}</span>
            <Switch
              data-testid="remote-webpush-switch"
              aria-label={t('remote.webPushEnabled')}
              checked={push.webPushEnabled}
              onCheckedChange={(checked) => postToHost({ type: 'setRemotePushConfig', payload: { webPushEnabled: checked } })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-4 py-3">
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

          <div className="flex flex-col gap-2.5 px-4 py-3">
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

            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
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
                  aria-label={t('remote.webhookPreset')}
                  data-testid="remote-webhook-preset"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bark">Bark</SelectItem>
                  <SelectItem value="ntfy">ntfy</SelectItem>
                  <SelectItem value="custom">Custom JSON</SelectItem>
                </SelectContent>
              </Select>
              <Input
                size="sm"
                aria-label={t('remote.webhookUrl')}
                data-testid="remote-webhook-url"
                className="flex-1 font-mono"
                value={webhookUrlDraft}
                placeholder={t('remote.webhookUrlPlaceholder')}
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
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

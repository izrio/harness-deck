/**
 * 设置 -> 远程互通 -> IM 机器人双向聊天（企微 / 飞书 / 钉钉 / Telegram）：
 * 严格按线性使用顺序组织为两张卡片：
 * 1. 配置机器人通道：零公网 IP 长连接 / 长轮询，4 平台独立配置、测试连接与启停
 * 2. 授权配对与已绑定用户：生成一次性 6 位 `/pair <码>` 配对指令并管理已授权的 IM 用户
 */
import { useEffect, useState } from 'react';
import type {
  ImBotChannelView,
  ImBotFeishuDomain,
  ImBotPlatform,
  ImBotsState,
} from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { relativeTime } from '../../lib/time.ts';
import { showToast } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  ErrorIcon,
  KeyIcon,
  QuestionIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { SettingsSection } from './SettingsSection.tsx';
import { WebhookChannelLogo } from './WebhookChannelLogo.tsx';

const IM_BOT_PLATFORMS: readonly ImBotPlatform[] = ['wecom', 'feishu', 'dingtalk', 'telegram'];

function defaultBotsState(): ImBotsState {
  const make = (platform: ImBotPlatform): ImBotChannelView => ({
    platform,
    enabled: false,
    status: 'stopped',
    hasSecret: false,
    ...(platform === 'feishu' ? { domain: 'feishu' as const } : {}),
    allowlist: [],
    requireMentionInGroup: true,
  });
  return {
    channels: {
      wecom: make('wecom'),
      feishu: make('feishu'),
      dingtalk: make('dingtalk'),
      telegram: make('telegram'),
    },
    boundUsers: [],
  };
}

function formatExpiryClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function statusMeta(
  status: ImBotChannelView['status'],
  enabled: boolean,
): { readonly dotClass: string; readonly textClass: string; readonly labelKey: MessageKey } {
  if (!enabled && status === 'stopped') {
    return { dotClass: 'bg-ink-3/50', textClass: 'text-ink-3', labelKey: 'remote.imBot.status.stopped' };
  }
  switch (status) {
    case 'connected':
      return { dotClass: 'bg-green', textClass: 'text-green', labelKey: 'remote.imBot.status.connected' };
    case 'connecting':
      return { dotClass: 'bg-orange', textClass: 'text-orange', labelKey: 'remote.imBot.status.connecting' };
    case 'reconnecting':
      return { dotClass: 'bg-orange', textClass: 'text-orange', labelKey: 'remote.imBot.status.reconnecting' };
    case 'error':
      return { dotClass: 'bg-red', textClass: 'text-red', labelKey: 'remote.imBot.status.error' };
    default:
      return { dotClass: 'bg-ink-3/50', textClass: 'text-ink-3', labelKey: 'remote.imBot.status.stopped' };
  }
}

export function ImBotSettingsSection({ bots }: { readonly bots?: ImBotsState }) {
  const t = useT();
  const state = bots ?? defaultBotsState();
  const [expanded, setExpanded] = useState<ImBotPlatform | undefined>(undefined);
  const [copiedPair, setCopiedPair] = useState(false);

  const hasEnabledChannel = IM_BOT_PLATFORMS.some((p) => state.channels[p].enabled);

  const copyPairCommand = async (code: string) => {
    try {
      await navigator.clipboard.writeText(`/pair ${code}`);
      setCopiedPair(true);
      showToast('info', t('remote.imBot.pairingCopied'));
      setTimeout(() => setCopiedPair(false), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {/* 步骤 1：配置并启用机器人通道 */}
      <SettingsSection
        title={t('remote.imBot.stepChannels')}
        testId="remote-imbot-section"
        actions={
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('remote.imBot.commandsHelpTitle')}
                title={t('remote.imBot.commandsHelpTitle')}
                data-testid="remote-imbot-commands-help"
                className="shrink-0 text-ink-3 hover:text-ink"
              >
                <QuestionIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="w-80 p-3.5"
              data-testid="remote-imbot-commands-help-popover"
            >
              <div className="flex flex-col gap-2">
                <div className="text-[12.5px] leading-4 font-semibold text-ink">
                  {t('remote.imBot.commandsHelpTitle')}
                </div>
                <p className="m-0 text-[12px] leading-relaxed text-ink-2">
                  {t('remote.imBot.commandsHelpDetail')}
                </p>
                <p className="m-0 rounded-lg bg-field/70 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
                  {t('remote.imBot.commandsHelpList')}
                </p>
              </div>
            </PopoverContent>
          </Popover>
        }
      >
        <div className="flex flex-col divide-y divide-line/55 px-4">
          {IM_BOT_PLATFORMS.map((platform) => {
            const channel = state.channels[platform];
            const isOpen = expanded === platform;
            return (
              <ImBotChannelRow
                key={platform}
                channel={channel}
                expanded={isOpen}
                onToggleExpand={() => setExpanded(isOpen ? undefined : platform)}
              />
            );
          })}
        </div>
      </SettingsSection>

      {/* 步骤 2：授权配对与已绑定用户 */}
      <SettingsSection
        title={t('remote.imBot.stepAuth', state.boundUsers.length)}
        testId="remote-imbot-auth-section"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-ink-2 hover:text-ink"
            data-testid="remote-imbot-generate-pairing-btn"
            onClick={() => postToHost({ type: 'generateImBotPairing', payload: {} })}
          >
            <KeyIcon className="size-3" />
            <span>{t('remote.imBot.generatePairing')}</span>
          </Button>
        }
      >
        <div className="flex flex-col divide-y divide-line/55 px-4">
          {state.pairing ? (
            <div className="py-4">
              <div
                data-testid="remote-imbot-pairing-card"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-canvas/70 px-3.5 py-3 dark:bg-page/50"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11.5px] leading-4 font-medium text-ink-2">
                      {t('remote.imBot.pairingCodeLabel')}
                    </span>
                    <code
                      data-testid="remote-imbot-pairing-code"
                      className="rounded-md bg-field px-2 py-0.5 font-mono text-[13px] font-semibold tracking-wider text-ink"
                    >
                      /pair {state.pairing.code}
                    </code>
                  </div>
                  <span className="text-[11.5px] leading-4 text-ink-3 tabular-nums">
                    {t('remote.imBot.pairingCodeHint', formatExpiryClock(state.pairing.expiresAt))}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    data-testid="remote-imbot-copy-pairing-btn"
                    onClick={() => void copyPairCommand(state.pairing!.code)}
                  >
                    {copiedPair ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                    <span>{t('remote.imBot.copyPairCmd')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('remote.clearPairing')}
                    title={t('remote.clearPairing')}
                    data-testid="remote-imbot-clear-pairing-btn"
                    className="text-ink-3 hover:text-ink"
                    onClick={() => postToHost({ type: 'clearImBotPairing', payload: {} })}
                  >
                    <CloseIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col" data-testid="remote-imbot-bound-users">
            {state.boundUsers.length === 0 ? (
              <div className="py-7 text-center text-[12px] leading-relaxed text-ink-3">
                {hasEnabledChannel
                  ? t('remote.imBot.boundUsersEmpty')
                  : t('remote.imBot.enableChannelFirstHint')}
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-line/55">
                {state.boundUsers.map((user) => (
                  <div
                    key={user.id}
                    data-testid={`remote-imbot-user-${user.id}`}
                    className="flex items-center justify-between gap-3 py-3.5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <WebhookChannelLogo preset={user.platform} className="size-4 shrink-0" />
                      <div className="flex min-w-0 flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] leading-5 font-medium text-ink">
                            {user.userName || user.userId}
                          </span>
                          {user.userName && user.userName !== user.userId ? (
                            <span className="truncate font-mono text-[11px] leading-4 text-ink-3">
                              {user.userId}
                            </span>
                          ) : null}
                        </div>
                        <span className="text-[11px] leading-4 text-ink-3">
                          {t(`remote.imBot.platform.${user.platform}` as MessageKey)} ·{' '}
                          {t('remote.deviceLastSeen', relativeTime(user.lastActiveAt, t))}
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`remote-imbot-revoke-${user.id}`}
                      className="shrink-0 text-ink-2 hover:text-red"
                      onClick={() => postToHost({ type: 'revokeImBotUser', payload: { id: user.id } })}
                    >
                      <TrashIcon className="size-3" />
                      <span>{t('remote.imBot.unbindUser')}</span>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function ImBotChannelRow({
  channel,
  expanded,
  onToggleExpand,
}: {
  readonly channel: ImBotChannelView;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
}) {
  const t = useT();
  const { platform } = channel;
  const meta = statusMeta(channel.status, channel.enabled);
  const isBusy = channel.status === 'connecting' || channel.status === 'reconnecting';

  const [appIdDraft, setAppIdDraft] = useState(channel.appId ?? '');
  const [secretDraft, setSecretDraft] = useState('');
  const [domainDraft, setDomainDraft] = useState<ImBotFeishuDomain>(channel.domain ?? 'feishu');
  const [apiBaseDraft, setApiBaseDraft] = useState(channel.apiBase ?? '');
  const savedAllowlist = channel.allowlist.join(', ');
  const [allowlistDraft, setAllowlistDraft] = useState(savedAllowlist);

  useEffect(() => {
    setAppIdDraft(channel.appId ?? '');
  }, [channel.appId]);

  useEffect(() => {
    setDomainDraft(channel.domain ?? 'feishu');
  }, [channel.domain]);

  useEffect(() => {
    setApiBaseDraft(channel.apiBase ?? '');
  }, [channel.apiBase]);

  useEffect(() => {
    setAllowlistDraft(savedAllowlist);
  }, [savedAllowlist]);

  const parsedAllowlist = allowlistDraft
    .split(/[\s,，]+/u)
    .map((s) => s.trim())
    .filter(Boolean);

  const isDirty =
    appIdDraft.trim() !== (channel.appId ?? '') ||
    secretDraft.trim().length > 0 ||
    (platform === 'feishu' && domainDraft !== (channel.domain ?? 'feishu')) ||
    (platform === 'telegram' && apiBaseDraft.trim() !== (channel.apiBase ?? '')) ||
    parsedAllowlist.join(',') !== channel.allowlist.join(',');

  const hasSavedCredentials =
    platform === 'telegram' ? channel.hasSecret : Boolean(channel.appId && channel.hasSecret);

  const hasCredentials =
    platform === 'telegram'
      ? channel.hasSecret || secretDraft.trim().length > 0
      : Boolean((appIdDraft.trim() || channel.appId) && (channel.hasSecret || secretDraft.trim()));

  const saveConfig = () => {
    postToHost({
      type: 'updateImBotChannel',
      payload: {
        platform,
        ...(platform !== 'telegram' ? { appId: appIdDraft.trim() } : {}),
        ...(secretDraft.trim() ? { secret: secretDraft.trim() } : {}),
        ...(platform === 'feishu' ? { domain: domainDraft } : {}),
        ...(platform === 'telegram' ? { apiBase: apiBaseDraft.trim() } : {}),
        allowlist: parsedAllowlist,
      },
    });
    setSecretDraft('');
    showToast('info', t('remote.imBot.saved'));
  };

  const clearSecret = () => {
    postToHost({
      type: 'updateImBotChannel',
      payload: { platform, secret: '' },
    });
    setSecretDraft('');
  };

  const handleToggleEnabled = (checked: boolean) => {
    if (checked && !hasCredentials) {
      if (!expanded) onToggleExpand();
    }
    postToHost({
      type: 'updateImBotChannel',
      payload: {
        platform,
        enabled: checked,
        ...(isDirty && platform !== 'telegram' ? { appId: appIdDraft.trim() } : {}),
        ...(secretDraft.trim() ? { secret: secretDraft.trim() } : {}),
        ...(platform === 'feishu' ? { domain: domainDraft } : {}),
        ...(platform === 'telegram' && apiBaseDraft.trim() !== (channel.apiBase ?? '')
          ? { apiBase: apiBaseDraft.trim() }
          : {}),
        ...(parsedAllowlist.join(',') !== channel.allowlist.join(',') ? { allowlist: parsedAllowlist } : {}),
      },
    });
    if (secretDraft.trim()) setSecretDraft('');
  };

  return (
    <div className="flex flex-col py-3.5" data-testid={`remote-imbot-row-${platform}`}>
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onToggleExpand}
          data-testid={`remote-imbot-expand-${platform}`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left"
        >
          <span className="inline-flex shrink-0 items-center text-ink-3">
            {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </span>
          <WebhookChannelLogo preset={platform} className="size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-[13px] leading-5 font-medium text-ink">
              {t(`remote.imBot.platform.${platform}` as MessageKey)}
            </span>
            <span
              data-testid={`remote-imbot-status-${platform}`}
              className={cn('inline-flex items-center gap-1 text-[11.5px] leading-4', meta.textClass)}
            >
              {isBusy ? (
                <SpinnerIcon className="size-3" />
              ) : (
                <span aria-hidden="true" className={cn('size-1.5 rounded-full', meta.dotClass)} />
              )}
              <span>{t(meta.labelKey)}</span>
              {channel.botName ? <span className="font-mono text-ink-3">({channel.botName})</span> : null}
            </span>
            {!channel.enabled && hasSavedCredentials ? (
              <span className="text-[11px] leading-4 text-ink-3">· {t('remote.imBot.configuredTag')}</span>
            ) : null}
          </div>
        </button>

        <Switch
          data-testid={`remote-imbot-switch-${platform}`}
          aria-label={t(`remote.imBot.platform.${platform}` as MessageKey)}
          checked={channel.enabled}
          onCheckedChange={handleToggleEnabled}
        />
      </div>

      {expanded ? (
        <div
          data-testid={`remote-imbot-panel-${platform}`}
          className="mt-3 flex flex-col gap-3 rounded-xl bg-canvas/70 p-3.5 dark:bg-page/50"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] leading-4 text-ink-2">
              {t(`remote.imBot.modeHint.${platform}` as MessageKey)}
            </span>
            <ImBotGuidePopover platform={platform} />
          </div>

          {platform !== 'telegram' ? (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11.5px] leading-4 font-medium text-ink-2">
                  {t(`remote.imBot.field.${platform}.appId` as MessageKey)}
                </span>
                <Input
                  size="sm"
                  className="font-mono"
                  data-testid={`remote-imbot-appid-${platform}`}
                  aria-label={t(`remote.imBot.field.${platform}.appId` as MessageKey)}
                  value={appIdDraft}
                  placeholder={t(`remote.imBot.field.${platform}.appIdPlaceholder` as MessageKey)}
                  onChange={(e) => setAppIdDraft(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] leading-4 font-medium text-ink-2">
                    {t(`remote.imBot.field.${platform}.secret` as MessageKey)}
                  </span>
                  {channel.hasSecret ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`remote-imbot-clear-secret-${platform}`}
                      className="text-ink-3 hover:text-red"
                      onClick={clearSecret}
                    >
                      {t('remote.imBot.clearSecret')}
                    </Button>
                  ) : null}
                </div>
                <Input
                  size="sm"
                  type="password"
                  className="font-mono"
                  data-testid={`remote-imbot-secret-${platform}`}
                  aria-label={t(`remote.imBot.field.${platform}.secret` as MessageKey)}
                  value={secretDraft}
                  placeholder={
                    channel.hasSecret
                      ? t('remote.imBot.secretSavedPlaceholder')
                      : t(`remote.imBot.field.${platform}.secretPlaceholder` as MessageKey)
                  }
                  onChange={(e) => setSecretDraft(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] leading-4 font-medium text-ink-2">
                    {t('remote.imBot.field.telegram.secret')}
                  </span>
                  {channel.hasSecret ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="remote-imbot-clear-secret-telegram"
                      className="text-ink-3 hover:text-red"
                      onClick={clearSecret}
                    >
                      {t('remote.imBot.clearSecret')}
                    </Button>
                  ) : null}
                </div>
                <Input
                  size="sm"
                  type="password"
                  className="font-mono"
                  data-testid="remote-imbot-secret-telegram"
                  aria-label={t('remote.imBot.field.telegram.secret')}
                  value={secretDraft}
                  placeholder={
                    channel.hasSecret
                      ? t('remote.imBot.secretSavedPlaceholder')
                      : t('remote.imBot.field.telegram.secretPlaceholder')
                  }
                  onChange={(e) => setSecretDraft(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11.5px] leading-4 font-medium text-ink-2">
                  {t('remote.webhookField.telegramApiBase')}
                </span>
                <Input
                  size="sm"
                  className="font-mono"
                  data-testid="remote-imbot-apibase-telegram"
                  aria-label={t('remote.webhookField.telegramApiBase')}
                  value={apiBaseDraft}
                  placeholder={t('remote.webhookField.telegramApiBasePlaceholder')}
                  onChange={(e) => setApiBaseDraft(e.target.value)}
                />
              </div>
            </div>
          )}

          {platform === 'feishu' ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11.5px] leading-4 font-medium text-ink-2">
                {t('remote.imBot.field.feishu.domain')}
              </span>
              <Select
                value={domainDraft}
                onValueChange={(value) => setDomainDraft(value as ImBotFeishuDomain)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full max-w-[260px]"
                  data-testid="remote-imbot-feishu-domain"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="feishu">{t('remote.imBot.feishuDomain.feishu')}</SelectItem>
                  <SelectItem value="lark">{t('remote.imBot.feishuDomain.lark')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] leading-4 font-medium text-ink-2">
              {t('remote.imBot.allowlistLabel')}
            </span>
            <Input
              size="sm"
              className="font-mono"
              data-testid={`remote-imbot-allowlist-${platform}`}
              aria-label={t('remote.imBot.allowlistLabel')}
              value={allowlistDraft}
              placeholder={t('remote.imBot.allowlistPlaceholder')}
              onChange={(e) => setAllowlistDraft(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-4 pt-0.5">
            <span className="text-[12.5px] leading-5 text-ink">{t('remote.imBot.requireMention')}</span>
            <Switch
              data-testid={`remote-imbot-mention-${platform}`}
              aria-label={t('remote.imBot.requireMention')}
              checked={channel.requireMentionInGroup}
              onCheckedChange={(checked) =>
                postToHost({
                  type: 'updateImBotChannel',
                  payload: { platform, requireMentionInGroup: checked },
                })
              }
            />
          </div>

          {channel.error ? (
            <div
              role="status"
              data-testid={`remote-imbot-error-${platform}`}
              className="flex items-start gap-1.5 rounded-lg bg-red-tint/70 px-2.5 py-2 text-[11.5px] leading-4 text-red"
            >
              <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-all">{channel.error}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`remote-imbot-test-${platform}`}
              disabled={!hasCredentials}
              onClick={() => {
                if (isDirty) {
                  postToHost({
                    type: 'updateImBotChannel',
                    payload: {
                      platform,
                      ...(platform !== 'telegram' ? { appId: appIdDraft.trim() } : {}),
                      ...(secretDraft.trim() ? { secret: secretDraft.trim() } : {}),
                      ...(platform === 'feishu' ? { domain: domainDraft } : {}),
                      ...(platform === 'telegram' ? { apiBase: apiBaseDraft.trim() } : {}),
                      allowlist: parsedAllowlist,
                    },
                  });
                  if (secretDraft.trim()) setSecretDraft('');
                }
                postToHost({ type: 'testImBotChannel', payload: { platform } });
              }}
            >
              <RefreshIcon className="size-3.5" />
              <span>{t('remote.imBot.testConnection')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid={`remote-imbot-save-${platform}`}
              disabled={!isDirty}
              onClick={saveConfig}
            >
              <span>{t('common.save')}</span>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImBotGuidePopover({ platform }: { readonly platform: ImBotPlatform }) {
  const t = useT();
  const name = t(`remote.imBot.platform.${platform}` as MessageKey);
  const summary = t(`remote.imBot.guide.${platform}.summary` as MessageKey);
  const steps = t(`remote.imBot.guide.${platform}.steps` as MessageKey)
    .split('\n')
    .filter(Boolean);
  const note = t(`remote.imBot.guide.${platform}.note` as MessageKey);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('remote.webhookChannelHelpAria')}
          title={`${name} · ${t('remote.webhookGuideBadge')}`}
          data-testid={`remote-imbot-guide-${platform}`}
          className="shrink-0 text-ink-3 hover:text-ink"
        >
          <QuestionIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-84 max-w-[calc(100vw-2rem)] p-3.5"
        data-testid={`remote-imbot-guide-popover-${platform}`}
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <WebhookChannelLogo preset={platform} className="size-4 shrink-0" />
            <span className="truncate text-[13px] leading-4 font-semibold text-ink">{name}</span>
            <span className="ml-auto shrink-0 rounded-md bg-field px-1.5 py-0.5 text-[10.5px] leading-none font-medium text-ink-3">
              {t('remote.webhookGuideBadge')}
            </span>
          </div>
          <p className="m-0 text-[12px] leading-relaxed text-ink-2">{summary}</p>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-[11.5px] leading-relaxed text-ink">
            {steps.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <p className="m-0 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-3">{note}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

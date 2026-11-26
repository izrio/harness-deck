/**
 * 推送渠道官方厂商图标（本地静态内联资源，零网络请求，适配严格 Webview CSP）：
 * 覆盖 Bark、ntfy、飞书、企业微信、钉钉、Telegram、Slack、Discord 官方徽标，
 * 自定义 JSON 回退到离线 Iconify `CodeIcon`。
 */
import type { RemoteWebhookPreset } from '@harness-deck/shared';
import barkLogo from '../../assets/channels/bark.png?inline';
import ntfyLogo from '../../assets/channels/ntfy.svg?inline';
import feishuLogo from '../../assets/channels/feishu.svg?inline';
import wecomLogo from '../../assets/channels/wecom.png?inline';
import dingtalkLogo from '../../assets/channels/dingtalk.svg?inline';
import telegramLogo from '../../assets/channels/telegram.svg?inline';
import slackLogo from '../../assets/channels/slack.svg?inline';
import discordLogo from '../../assets/channels/discord.svg?inline';
import { cn } from '../../lib/utils.ts';
import { CodeIcon } from '../icons.tsx';

const OFFICIAL_CHANNEL_LOGOS: Readonly<Partial<Record<RemoteWebhookPreset, string>>> = {
  bark: barkLogo,
  ntfy: ntfyLogo,
  feishu: feishuLogo,
  wecom: wecomLogo,
  dingtalk: dingtalkLogo,
  telegram: telegramLogo,
  slack: slackLogo,
  discord: discordLogo,
};

export function WebhookChannelLogo({
  preset,
  className = 'size-4 shrink-0',
}: {
  readonly preset: RemoteWebhookPreset;
  readonly className?: string;
}) {
  const src = OFFICIAL_CHANNEL_LOGOS[preset];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        aria-hidden="true"
        data-webhook-channel={preset}
        className={cn('inline-block shrink-0 object-contain', preset === 'bark' && 'rounded-[3px]', className)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-webhook-channel="custom"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[4px] bg-field text-ink-2 ring-1 ring-inset ring-line',
        className,
      )}
    >
      <CodeIcon className="size-3 text-ink-2" />
    </span>
  );
}

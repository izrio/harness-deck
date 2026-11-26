/**
 * 各推送渠道的表单校验与配置状态辅助（方案 A：单活渠道 + 专属表单）。
 */
import type { RemoteWebhookChannelConfig, RemoteWebhookPreset } from '@harness-deck/shared';
import type { MessageKey } from '../../i18n.ts';

export interface WebhookDraft {
  readonly url: string;
  readonly secret: string;
  readonly chatId: string;
  readonly group: string;
}

function parseHttpUrl(raw: string): URL | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 判断指定渠道是否已具备基本可用配置（用于在下拉列表中显示已配置状态圆点）。 */
export function isWebhookChannelConfigured(
  preset: RemoteWebhookPreset,
  channel: RemoteWebhookChannelConfig | undefined,
): boolean {
  if (!channel) return false;
  if (preset === 'telegram') {
    const url = channel.url.trim();
    if (/\/bot[^/]+\/sendMessage/iu.test(url)) return true;
    return Boolean(channel.secret?.trim() && channel.chatId?.trim());
  }
  return Boolean(channel.url.trim());
}

/** 实时校验当前渠道输入格式；空状态返回 undefined，仅在填写有误时给出温和提示 key。 */
export function validateWebhookDraft(preset: RemoteWebhookPreset, draft: WebhookDraft): MessageKey | undefined {
  const url = draft.url.trim();
  const secret = draft.secret.trim();
  const chatId = draft.chatId.trim();

  switch (preset) {
    case 'bark': {
      if (!url) return undefined;
      if (parseHttpUrl(url)) return undefined;
      if (!/[\s/?#]/u.test(url)) return undefined;
      return 'remote.webhookWarn.bark';
    }

    case 'ntfy': {
      if (!url) return undefined;
      const parsed = parseHttpUrl(url);
      if (!parsed || parsed.pathname === '/' || !parsed.pathname) {
        return 'remote.webhookWarn.ntfy';
      }
      return undefined;
    }

    case 'feishu': {
      if (!url) return undefined;
      const parsed = parseHttpUrl(url);
      if (
        !parsed ||
        (!/(?:^|\.)feishu\.cn$/iu.test(parsed.hostname) &&
          !/(?:^|\.)larksuite\.com$/iu.test(parsed.hostname) &&
          !parsed.pathname.includes('/open-apis/bot/v2/hook/'))
      ) {
        return 'remote.webhookWarn.feishu';
      }
      return undefined;
    }

    case 'wecom': {
      if (!url) return undefined;
      const parsed = parseHttpUrl(url);
      if (
        !parsed ||
        !/(?:^|\.)weixin\.qq\.com$/iu.test(parsed.hostname) ||
        !parsed.searchParams.get('key')
      ) {
        return 'remote.webhookWarn.wecom';
      }
      return undefined;
    }

    case 'dingtalk': {
      if (url) {
        const parsed = parseHttpUrl(url);
        if (
          !parsed ||
          !/(?:^|\.)dingtalk\.com$/iu.test(parsed.hostname) ||
          !parsed.searchParams.get('access_token')
        ) {
          return 'remote.webhookWarn.dingtalkUrl';
        }
      }
      if (secret && !secret.startsWith('SEC')) {
        return 'remote.webhookWarn.dingtalkSecret';
      }
      return undefined;
    }

    case 'telegram': {
      if (url) {
        const parsed = parseHttpUrl(url);
        if (!parsed) return 'remote.webhookWarn.url';
        if (/\/bot[^/]+\/sendMessage/iu.test(parsed.pathname)) {
          if (!parsed.searchParams.get('chat_id')?.trim() && !chatId) {
            return 'remote.webhookWarn.telegramChatId';
          }
          return undefined;
        }
      }
      if (secret && !/^(?:bot)?\d+:\S+$/iu.test(secret)) {
        return 'remote.webhookWarn.telegramToken';
      }
      if (secret && !chatId) {
        return 'remote.webhookWarn.telegramChatId';
      }
      if (!secret && chatId) {
        return 'remote.webhookWarn.telegramTokenMissing';
      }
      return undefined;
    }

    case 'slack': {
      if (!url) return undefined;
      const parsed = parseHttpUrl(url);
      if (!parsed || parsed.hostname.toLowerCase() !== 'hooks.slack.com' || !parsed.pathname.startsWith('/services/')) {
        return 'remote.webhookWarn.slack';
      }
      return undefined;
    }

    case 'discord': {
      if (!url) return undefined;
      const parsed = parseHttpUrl(url);
      if (
        !parsed ||
        (!/(?:^|\.)discord\.com$/iu.test(parsed.hostname) && !/(?:^|\.)discordapp\.com$/iu.test(parsed.hostname)) ||
        !parsed.pathname.includes('/api/webhooks/')
      ) {
        return 'remote.webhookWarn.discord';
      }
      return undefined;
    }

    default: {
      if (!url) return undefined;
      return parseHttpUrl(url) ? undefined : 'remote.webhookWarn.url';
    }
  }
}

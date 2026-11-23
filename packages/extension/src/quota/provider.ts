/**
 * 订阅额度查询的分发：根据激活后端的 profile 决定用哪个提供方服务。
 * 供宿主 `fetchQuota` 处理器单点导入，也便于单测覆盖判断规则。
 */
import { backendCapabilities, type QuotaProviderId } from '@harness-deck/shared';
import type { BackendProfile } from '../backend/types.ts';
import { clearQuotaCache, queryClaudeQuota } from '../claude/quota.ts';
import { clearAntigravityQuotaCache, queryAntigravityQuota } from './antigravity.ts';
import { clearCodebuddyQuotaCache, queryCodebuddyQuota } from './codebuddy.ts';
import type { QuotaServiceOptions } from './util.ts';

export type { QuotaProviderId } from '@harness-deck/shared';

export { queryAntigravityQuota, queryClaudeQuota, queryCodebuddyQuota };
export type { QuotaServiceOptions };

/** 切换账号或重新登录后清空对应提供方的额度缓存，确保立即拿到新账号的实时额度。 */
export function clearQuotaCacheFor(providerId: QuotaProviderId | undefined): void {
  if (providerId === 'claude') clearQuotaCache();
  else if (providerId === 'antigravity') clearAntigravityQuotaCache();
  else if (providerId === 'codebuddy') clearCodebuddyQuotaCache();
}

/**
 * 哪些后端能查订阅额度：由 `capabilities.ts` 的能力描述符决定。
 * Claude、Antigravity、CodeBuddy 之外返回 undefined。
 */
export function quotaProviderFor(profile: BackendProfile | undefined): QuotaProviderId | undefined {
  return profile ? backendCapabilities(profile).quota : undefined;
}

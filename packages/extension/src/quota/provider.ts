/**
 * 订阅额度查询的分发：根据激活后端的 profile 决定用哪个提供方服务。
 * 供宿主 `fetchQuota` 处理器单点导入，也便于单测覆盖判断规则。
 */
import type { BackendProfile } from '../backend/types.ts';
import { queryClaudeQuota } from '../claude/quota.ts';
import { queryAntigravityQuota } from './antigravity.ts';
import { queryCodebuddyQuota } from './codebuddy.ts';
import type { QuotaServiceOptions } from './util.ts';

export type QuotaProviderId = 'claude' | 'antigravity' | 'codebuddy';

export { queryAntigravityQuota, queryClaudeQuota, queryCodebuddyQuota };
export type { QuotaServiceOptions };

/** 取命令的首个 token 的文件名：`/usr/local/bin/agy acp` → `agy`。 */
function commandBin(command: string): string {
  const head = command.trim().split(/\s+/u)[0] ?? '';
  return (head.split(/[\\/]/u).pop() ?? '').toLowerCase();
}

/**
 * 哪些后端能查订阅额度：
 * - Claude（kind claude）；
 * - Antigravity（ACP，命令 `agy`）；
 * - CodeBuddy（ACP，命令 `codebuddy` / `cbc`）。
 * 用户自定义的 ACP 后端按命令名同样能识别。
 */
export function quotaProviderFor(profile: BackendProfile | undefined): QuotaProviderId | undefined {
  if (!profile) return undefined;
  if (profile.kind === 'claude') return 'claude';
  if (profile.kind !== 'acp') return undefined;
  const bin = commandBin(profile.command);
  if (bin === 'agy' || bin === 'antigravity') return 'antigravity';
  if (bin === 'codebuddy' || bin === 'cbc') return 'codebuddy';
  return undefined;
}

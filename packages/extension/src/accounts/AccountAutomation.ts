/**
 * 参考 cockpit-tools 的账号配额健康度评估与低配额自动切号引擎（纯函数，无副作用）。
 */
import type {
  AccountAutomationConfig,
  AccountAutoSwitchStrategy,
  AccountView,
  QuotaWindowView,
} from '@harness-deck/shared';

export const ACCOUNT_AUTOMATION_STORAGE_KEY = 'harnessDeck.accounts.automation';

export const DEFAULT_ACCOUNT_AUTOMATION: AccountAutomationConfig = {
  autoSwitchEnabled: false,
  autoSwitchThresholdPercent: 5,
  autoSwitchStrategy: 'highest-quota',
  autoRefreshIntervalMin: 0,
};

export function parseAccountAutomationConfig(raw: unknown): AccountAutomationConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_ACCOUNT_AUTOMATION;
  const obj = raw as Record<string, unknown>;
  const threshold =
    typeof obj.autoSwitchThresholdPercent === 'number' && Number.isFinite(obj.autoSwitchThresholdPercent)
      ? Math.max(0, Math.min(50, Math.round(obj.autoSwitchThresholdPercent)))
      : DEFAULT_ACCOUNT_AUTOMATION.autoSwitchThresholdPercent;
  const strategy: AccountAutoSwitchStrategy =
    obj.autoSwitchStrategy === 'round-robin' ? 'round-robin' : 'highest-quota';
  const interval =
    typeof obj.autoRefreshIntervalMin === 'number' && Number.isFinite(obj.autoRefreshIntervalMin)
      ? Math.max(0, Math.min(1_440, Math.round(obj.autoRefreshIntervalMin)))
      : DEFAULT_ACCOUNT_AUTOMATION.autoRefreshIntervalMin;

  let lastAutoSwitch: AccountAutomationConfig['lastAutoSwitch'];
  if (obj.lastAutoSwitch && typeof obj.lastAutoSwitch === 'object') {
    const ls = obj.lastAutoSwitch as Record<string, unknown>;
    if (
      typeof ls.backendId === 'string' &&
      typeof ls.fromAccountId === 'string' &&
      typeof ls.toAccountId === 'string' &&
      typeof ls.toLabel === 'string' &&
      (ls.reason === 'quota-low' || ls.reason === 'expired') &&
      typeof ls.at === 'number'
    ) {
      lastAutoSwitch = {
        backendId: ls.backendId,
        fromAccountId: ls.fromAccountId,
        toAccountId: ls.toAccountId,
        toLabel: ls.toLabel,
        reason: ls.reason,
        at: ls.at,
      };
    }
  }

  return {
    autoSwitchEnabled: obj.autoSwitchEnabled === true,
    autoSwitchThresholdPercent: threshold,
    autoSwitchStrategy: strategy,
    autoRefreshIntervalMin: interval,
    ...(lastAutoSwitch ? { lastAutoSwitch } : {}),
  };
}

/** 过滤掉 Antigravity 内部 3p 池，仅保留面向用户的有效配额窗口。 */
export function visibleQuotaWindowsForAccount(account: AccountView): readonly QuotaWindowView[] {
  return (account.quota?.windows ?? []).filter((w) => w.label.trim().toLowerCase() !== '3p');
}

/** 计算账号的最低剩余配额百分比（无额度数据时返回 undefined）。 */
export function accountMinRemainingPercent(account: AccountView): number | undefined {
  const windows = visibleQuotaWindowsForAccount(account);
  if (windows.length === 0) return undefined;
  let min = 100;
  for (const w of windows) {
    if (Number.isFinite(w.remainingPercent)) {
      min = Math.min(min, Math.max(0, Math.min(100, w.remainingPercent)));
    }
  }
  return min;
}

export interface AutoSwitchDecision {
  readonly target: AccountView;
  readonly reason: 'quota-low' | 'expired';
}

/**
 * 为指定智能体评估是否应触发自动切号，并选出最合适的备用官方账号。
 * - 仅在 `autoSwitchEnabled === true` 且当前为官方账号模式时调用；
 * - 跳过已禁用（`disabled`）、未登录或过期的候选账号；
 * - 当目标账号与当前账号均处于低配额状态且没有更健康的候选时，返回 undefined，避免来回抖动切号。
 */
export function pickBestAutoSwitchTarget(
  backendAccounts: readonly AccountView[],
  activeAccountId: string,
  config: AccountAutomationConfig,
): AutoSwitchDecision | undefined {
  if (!config.autoSwitchEnabled) return undefined;
  const active = backendAccounts.find((a) => a.id === activeAccountId);
  if (!active) return undefined;

  const activeQuota = accountMinRemainingPercent(active);
  const isExpired = active.status === 'expired' || active.status === 'unauthenticated';
  const isLowQuota = activeQuota !== undefined && activeQuota <= config.autoSwitchThresholdPercent;

  if (!isExpired && !isLowQuota) return undefined;

  const reason: 'quota-low' | 'expired' = isExpired ? 'expired' : 'quota-low';
  const candidates = backendAccounts.filter((acc) => {
    if (acc.id === activeAccountId) return false;
    if (acc.disabled) return false;
    if (acc.status !== 'authenticated') return false;
    const rem = accountMinRemainingPercent(acc);
    // 候选账号若已知额度，必须严格高于阈值（且比当前账号更充裕）
    if (rem !== undefined) {
      if (rem <= config.autoSwitchThresholdPercent) return false;
      if (activeQuota !== undefined && rem <= activeQuota) return false;
    }
    return true;
  });

  if (candidates.length === 0) return undefined;

  if (config.autoSwitchStrategy === 'round-robin') {
    const activeIdx = backendAccounts.findIndex((a) => a.id === activeAccountId);
    const ordered = [
      ...backendAccounts.slice(activeIdx + 1),
      ...backendAccounts.slice(0, Math.max(0, activeIdx)),
    ];
    const candidateIds = new Set(candidates.map((c) => c.id));
    const next = ordered.find((a) => candidateIds.has(a.id));
    return next ? { target: next, reason } : undefined;
  }

  // highest-quota：优先剩余额度最高的账号；未知额度的已认证账号视为 50% 中性分，排在已知高额度之后
  const score = (acc: AccountView): number => accountMinRemainingPercent(acc) ?? 50;
  const sorted = [...candidates].sort((a, b) => score(b) - score(a));
  return sorted[0] ? { target: sorted[0], reason } : undefined;
}

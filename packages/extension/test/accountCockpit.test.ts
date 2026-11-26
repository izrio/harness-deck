import { describe, expect, it } from 'vitest';
import type { AccountConfig, AccountView } from '@harness-deck/shared';
import {
  accountMinRemainingPercent,
  DEFAULT_ACCOUNT_AUTOMATION,
  parseAccountAutomationConfig,
  pickBestAutoSwitchTarget,
} from '../src/accounts/AccountAutomation.ts';
import {
  buildAccountsExportJson,
  parseImportedAccountsJson,
} from '../src/accounts/AccountPortability.ts';
import {
  parseAccountsSetting,
  toggleAccountDisabledSetting,
  upsertAccountSetting,
} from '../src/accounts/AccountStore.ts';
import { authorizeRemoteMessage } from '../src/remote/ScopeGuard.ts';

function makeAccount(id: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id,
    backendId: 'antigravity',
    label: id,
    status: 'authenticated',
    ...overrides,
  };
}

describe('AccountStore tags, notes, and disabled state', () => {
  it('persists tags, notes, and disabled flags cleanly and toggles disabled state', () => {
    const { accounts } = upsertAccountSetting([], {
      backendId: 'claude',
      label: '主力号',
      tags: ['主力', 'Team', '主力', '  '],
      notes: '  每月 1 号重置  ',
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.tags).toEqual(['主力', 'Team']);
    expect(accounts[0]!.notes).toBe('每月 1 号重置');
    expect(accounts[0]!.disabled).toBeUndefined();

    const parsed = parseAccountsSetting(accounts);
    expect(parsed[0]!.tags).toEqual(['主力', 'Team']);
    expect(parsed[0]!.notes).toBe('每月 1 号重置');

    const { accounts: disabledList, target } = toggleAccountDisabledSetting(parsed, parsed[0]!.id, true);
    expect(target?.disabled).toBe(true);
    expect(disabledList[0]!.disabled).toBe(true);

    const { accounts: reEnabled } = toggleAccountDisabledSetting(disabledList, parsed[0]!.id, false);
    expect(reEnabled[0]!.disabled).toBeUndefined();
  });
});

describe('AccountAutomation (cockpit-tools low-quota & expiry auto-switch)', () => {
  it('picks highest-quota healthy backup while skipping disabled, expired, and 3p windows', () => {
    const active = makeAccount('system:antigravity', {
      quota: {
        queriedAt: 1000,
        windows: [
          { kind: 'session', label: 'gemini', usedPercent: 97, remainingPercent: 3 },
          // 3p 窗口应被忽略
          { kind: 'session', label: '3p', usedPercent: 0, remainingPercent: 100 },
        ],
      },
    });
    const disabledHigh = makeAccount('agy-disabled', {
      disabled: true,
      quota: {
        queriedAt: 1000,
        windows: [{ kind: 'session', label: 'gemini', usedPercent: 5, remainingPercent: 95 }],
      },
    });
    const backupMid = makeAccount('agy-mid', {
      quota: {
        queriedAt: 1000,
        windows: [{ kind: 'session', label: 'gemini', usedPercent: 50, remainingPercent: 50 }],
      },
    });
    const backupBest = makeAccount('agy-best', {
      quota: {
        queriedAt: 1000,
        windows: [{ kind: 'session', label: 'gemini', usedPercent: 15, remainingPercent: 85 }],
      },
    });

    expect(accountMinRemainingPercent(active)).toBe(3);

    const cfg = parseAccountAutomationConfig({
      autoSwitchEnabled: true,
      autoSwitchThresholdPercent: 5,
      autoSwitchStrategy: 'highest-quota',
    });

    const decision = pickBestAutoSwitchTarget(
      [active, disabledHigh, backupMid, backupBest],
      'system:antigravity',
      cfg,
    );
    expect(decision).toEqual({ target: backupBest, reason: 'quota-low' });

    // 轮换策略按列表顺序选下一个可用号
    const rrDecision = pickBestAutoSwitchTarget(
      [active, disabledHigh, backupMid, backupBest],
      'system:antigravity',
      { ...cfg, autoSwitchStrategy: 'round-robin' },
    );
    expect(rrDecision).toEqual({ target: backupMid, reason: 'quota-low' });
  });

  it('triggers on expired active account and respects disabled auto-switch config', () => {
    const expired = makeAccount('acc-1', { status: 'expired' });
    const backup = makeAccount('acc-2', { status: 'authenticated' });

    expect(pickBestAutoSwitchTarget([expired, backup], 'acc-1', DEFAULT_ACCOUNT_AUTOMATION)).toBeUndefined();

    const enabled = { ...DEFAULT_ACCOUNT_AUTOMATION, autoSwitchEnabled: true };
    const decision = pickBestAutoSwitchTarget([expired, backup], 'acc-1', enabled);
    expect(decision).toEqual({ target: backup, reason: 'expired' });
  });
});

describe('AccountPortability (Halo JSON & cockpit-tools compatible import/export)', () => {
  it('parses cockpit-tools style JSON with email, refresh_token, group, and platform aliases', () => {
    const raw = JSON.stringify([
      {
        platform: 'agy',
        email: 'pool1@gmail.com',
        refresh_token: '1//0g_refresh_abc',
        access_token: 'ya29.access_xyz',
        group: '主力池',
        note: 'Pro 订阅',
      },
      {
        platform: 'codebuddy-ai',
        name: '国际版账号',
        api_key: 'cb_live_key',
        tags: '团队, 备用',
      },
    ]);

    const { entries, warnings } = parseImportedAccountsJson(raw);
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      backendId: 'antigravity',
      label: 'pool1@gmail.com',
      tags: ['主力池'],
      notes: 'Pro 订阅',
    });
    const slotObj = JSON.parse(entries[0]!.antigravitySlotRaw!) as {
      token: { refresh_token: string; access_token: string };
      email: string;
    };
    expect(slotObj.email).toBe('pool1@gmail.com');
    expect(slotObj.token.refresh_token).toBe('1//0g_refresh_abc');
    expect(slotObj.token.access_token).toBe('ya29.access_xyz');

    expect(entries[1]).toMatchObject({
      backendId: 'codebuddy',
      region: 'ai',
      label: '国际版账号',
      apiKey: 'cb_live_key',
      tags: ['团队', '备用'],
    });

    // 兼容 accounts 为对象字典的导出结构
    const dictParsed = parseImportedAccountsJson(
      JSON.stringify({
        accounts: {
          a1: { email: 'dict@example.com', refresh_token: 'rt_dict' },
        },
      }),
      'antigravity',
    );
    expect(dictParsed.entries).toHaveLength(1);
    expect(dictParsed.entries[0]!.label).toBe('dict@example.com');
  });

  it('exports accounts without secrets by default and includes secrets only when requested', () => {
    const acc: AccountConfig & { identity: string } = {
      id: 'dsh-main',
      backendId: 'dsh',
      label: 'DeepSeek 主号',
      identity: 'sk-12…abcd',
      tags: ['主力'],
      notes: '办公',
      createdAt: 1000,
    };
    const secrets = new Map([['dsh-main', { apiKey: 'sk-secret-value-1234' }]]);

    const safeJson = buildAccountsExportJson([acc], secrets, { includeSecrets: false });
    expect(safeJson).not.toContain('sk-secret-value-1234');

    const fullJson = buildAccountsExportJson([acc], secrets, { includeSecrets: true });
    expect(fullJson).toContain('sk-secret-value-1234');
    const roundtrip = parseImportedAccountsJson(fullJson);
    expect(roundtrip.entries[0]).toMatchObject({
      backendId: 'dsh',
      label: 'DeepSeek 主号',
      apiKey: 'sk-secret-value-1234',
      tags: ['主力'],
      notes: '办公',
    });
  });

  it('blocks sensitive account import/export/automation messages from remote mobile clients', () => {
    expect(
      authorizeRemoteMessage('operate', {
        type: 'exportAccounts',
        payload: { requestId: 1, includeSecrets: true },
      }).ok,
    ).toBe(false);
    expect(
      authorizeRemoteMessage('operate', {
        type: 'importAccounts',
        payload: { rawJson: '[]' },
      }).ok,
    ).toBe(false);
    expect(
      authorizeRemoteMessage('operate', {
        type: 'setAccountAutomation',
        payload: { autoSwitchEnabled: true },
      }).ok,
    ).toBe(false);
  });
});

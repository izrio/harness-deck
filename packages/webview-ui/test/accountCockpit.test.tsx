// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { backendCapabilities, type HostSnapshot } from '@harness-deck/shared';
import { AccountSettings } from '../src/components/settings/AccountSettings.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { mockVsCodeApi } from './setup.ts';

const vscodeMock = mockVsCodeApi();

function makeSnapshot(): HostSnapshot {
  const resetsAt = Date.now() + 2 * 60 * 60_000 + 15 * 60_000;
  return {
    runtime: { kind: 'connected', version: '1.0.0', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: 'New', running: false }], active: 't1' },
    session: { title: 'New', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: {
      active: 'antigravity',
      items: [
        {
          id: 'antigravity',
          name: 'Antigravity',
          kind: 'acp',
          capabilities: backendCapabilities({ id: 'antigravity', kind: 'acp', command: 'agy' }),
          activeChannel: { mode: 'official', accountId: 'system:antigravity' },
        },
      ],
    },
    providers: { items: [] },
    accounts: {
      items: [
        {
          id: 'system:antigravity',
          backendId: 'antigravity',
          label: '主力号',
          isSystemDefault: true,
          status: 'authenticated',
          identity: 'main@gmail.com',
          quota: {
            queriedAt: Date.now(),
            windows: [
              { kind: 'session', label: 'gemini', usedPercent: 92, remainingPercent: 8, resetsAt },
              { kind: 'session', label: '3p', usedPercent: 0, remainingPercent: 100 },
            ],
          },
        },
        {
          id: 'agy-backup',
          backendId: 'antigravity',
          label: '备用号',
          status: 'authenticated',
          identity: 'backup@gmail.com',
          tags: ['备用', 'Pro'],
          notes: '自动切号候选',
          quota: {
            queriedAt: Date.now(),
            windows: [{ kind: 'session', label: 'gemini', usedPercent: 10, remainingPercent: 90, resetsAt }],
          },
        },
      ],
      channels: {
        antigravity: { mode: 'official', accountId: 'system:antigravity' },
      },
      automation: {
        autoSwitchEnabled: false,
        autoSwitchThresholdPercent: 5,
        autoSwitchStrategy: 'highest-quota',
        autoRefreshIntervalMin: 0,
      },
    },
  };
}

beforeEach(() => {
  resetStoreForTests();
  vscodeMock.reset();
  applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
});

describe('AccountSettings cockpit-tools enhancements', () => {
  it('renders quota progress bars with reset countdown, one-click switch, single refresh, and tag filtering', () => {
    render(<AccountSettings />);
    vscodeMock.reset();

    // 渲染配额进度条与重置倒计时，同时继续隐藏 3p 窗口
    const quotaBars = screen.getByTestId('account-quota-bars-system:antigravity');
    expect(quotaBars.textContent).toContain('剩余 8%');
    expect(quotaBars.textContent).toContain('后重置');
    expect(quotaBars.textContent).not.toContain('3p');

    // 标签与备注展示 + 标签过滤
    expect(screen.getByTestId('account-row-agy-backup').textContent).toContain('#备用');
    expect(screen.getByTestId('account-row-agy-backup').textContent).toContain('自动切号候选');
    fireEvent.click(screen.getByTestId('accounts-tag-filter-备用'));
    expect(screen.queryByTestId('account-row-system:antigravity')).toBeNull();
    expect(screen.getByTestId('account-row-agy-backup')).toBeTruthy();
    fireEvent.click(screen.getByTestId('accounts-tag-filter-备用'));

    // 外置一键切号与单号刷新按钮
    fireEvent.click(screen.getByTestId('account-quick-use-agy-backup'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'setBackendChannel',
      payload: { backendId: 'antigravity', mode: 'official', accountId: 'agy-backup' },
    });

    fireEvent.click(screen.getByTestId('account-refresh-agy-backup'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'refreshAccount',
      payload: { id: 'agy-backup', backendId: 'antigravity', includeQuota: true },
    });
  });

  it('configures auto-switch automation and imports accounts JSON via dialogs', () => {
    render(<AccountSettings />);
    vscodeMock.reset();

    // 打开自动切号弹窗并启用开关
    fireEvent.click(screen.getByTestId('accounts-automation-btn'));
    expect(screen.getByTestId('account-automation-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('account-auto-switch-toggle'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'setAccountAutomation',
      payload: { autoSwitchEnabled: true },
    });

    // 打开导入/导出弹窗并提交 cockpit-tools 格式 JSON
    fireEvent.click(screen.getByTestId('accounts-portability-btn'));
    expect(screen.getByTestId('account-portability-dialog')).toBeTruthy();
    const sample = JSON.stringify([{ email: 'new@gmail.com', refresh_token: 'rt_123' }]);
    fireEvent.change(screen.getByTestId('account-import-textarea'), { target: { value: sample } });
    fireEvent.click(screen.getByTestId('account-import-submit'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'importAccounts',
      payload: { rawJson: sample, defaultBackendId: 'antigravity' },
    });
  });
});

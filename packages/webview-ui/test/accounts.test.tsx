// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { backendCapabilities, type HostSnapshot } from '@harness-deck/shared';
import { applyHostMessage, getState, resetStoreForTests } from '../src/store.ts';
import { AccountSettings } from '../src/components/settings/AccountSettings.tsx';
import { ModelPicker } from '../src/components/ModelPicker.tsx';
import { mockVsCodeApi } from './setup.ts';

const vscodeMock = mockVsCodeApi();

function openActionsMenu(testId: string) {
  const trigger = screen.getByTestId(testId);
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

function makeSnapshot(): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1.0.0', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: 'New', running: false }], active: 't1' },
    session: { title: 'New', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
    items: [],
    models: {
      options: [
        { provider: 'anthropic', model: 'claude-sonnet', name: 'Claude Sonnet', group: 'Anthropic', efforts: [] },
      ],
      current: { provider: 'anthropic', model: 'claude-sonnet' },
    },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: {
      active: 'claude',
      items: [
        {
          id: 'claude',
          name: 'Claude Code',
          kind: 'claude',
          capabilities: backendCapabilities({ id: 'claude', kind: 'claude' }),
          activeChannel: { mode: 'official', accountId: 'system:claude' },
        },
        {
          id: 'antigravity',
          name: 'Antigravity',
          kind: 'acp',
          capabilities: backendCapabilities({ id: 'antigravity', kind: 'acp', command: 'agy' }),
          activeChannel: { mode: 'official', accountId: 'system:antigravity' },
        },
      ],
    },
    providers: {
      items: [
        {
          id: 'volc',
          name: '火山方舟',
          anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding',
          models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
          boundBackendIds: [],
          hasApiKey: true,
        },
      ],
    },
    accounts: {
      items: [
        {
          id: 'system:claude',
          backendId: 'claude',
          label: '本机默认账号',
          isSystemDefault: true,
          status: 'authenticated',
          identity: 'me@example.com',
          plan: 'Max',
        },
        {
          id: 'claude-work',
          backendId: 'claude',
          label: '公司号',
          status: 'authenticated',
          identity: 'work@corp.com',
          plan: 'Pro',
        },
        {
          id: 'system:antigravity',
          backendId: 'antigravity',
          label: '本机默认账号',
          isSystemDefault: true,
          status: 'authenticated',
          identity: 'dev@gmail.com',
        },
      ],
      channels: {
        claude: { mode: 'official', accountId: 'system:claude' },
        antigravity: { mode: 'official', accountId: 'system:antigravity' },
      },
    },
  };
}

describe('AccountSettings & ModelPicker channel switching', () => {
  beforeEach(() => {
    resetStoreForTests();
    vscodeMock.reset();
    applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
  });

  it('renders official accounts, switches between official accounts and providers, and disables providers for account-only agents', () => {
    render(<AccountSettings />);

    // 挂载时触发一次状态与额度刷新；不展示筛选条，且每个运行时为独立 Card
    expect(vscodeMock.posted.some((m) => m.type === 'refreshAccounts')).toBe(true);
    expect(screen.queryByTestId('accounts-filter-bar')).toBeNull();
    expect(screen.getByTestId('account-backend-card-claude').getAttribute('data-slot')).toBe('card');
    expect(screen.getByTestId('account-backend-card-antigravity').getAttribute('data-slot')).toBe('card');
    expect(screen.getByTestId('account-row-system:claude')).toBeTruthy();
    expect(screen.getByTestId('account-row-claude-work')).toBeTruthy();

    // 选中账号前面显示绿色圆点（不显示「当前使用」胶囊文字），未选中账号显示灰色圆点
    const activeDot = screen.getByTestId('account-active-system:claude');
    expect(activeDot.className).toContain('bg-green');
    expect(screen.getByTestId('account-row-system:claude').textContent).not.toContain('当前使用');
    const inactiveDot = screen.getByTestId('account-dot-claude-work');
    expect(inactiveDot.className).toContain('bg-ink-4');

    // Antigravity 为 account-only，服务商按钮置灰
    const agyProviderBtn = screen.getByTestId('channel-provider-antigravity') as HTMLButtonElement;
    expect(agyProviderBtn.disabled).toBe(true);

    // 切换 Claude Code 到另一个官方账号
    openActionsMenu('account-actions-claude-work');
    fireEvent.click(screen.getByTestId('account-use-claude-work'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'setBackendChannel',
      payload: { backendId: 'claude', mode: 'official', accountId: 'claude-work' },
    });

    // 切换 Claude Code 到第三方服务商
    fireEvent.click(screen.getByTestId('channel-provider-claude'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'setBackendChannel',
      payload: { backendId: 'claude', mode: 'provider', providerId: 'volc' },
    });
  });

  it('adds a new account via modal and confirms before deleting', () => {
    render(<AccountSettings />);
    vscodeMock.reset();

    fireEvent.click(screen.getByTestId('add-account-claude'));
    const labelInput = screen.getByTestId('account-form-label');
    fireEvent.change(labelInput, { target: { value: '备用号' } });
    fireEvent.click(screen.getByTestId('account-form-save-login'));

    expect(vscodeMock.posted).toContainEqual({
      type: 'upsertAccount',
      payload: {
        backendId: 'claude',
        label: '备用号',
        isolateSessions: false,
        setActive: true,
      },
    });

    // 删除独立账号弹出二次确认
    openActionsMenu('account-actions-claude-work');
    fireEvent.click(screen.getByTestId('account-delete-claude-work'));
    expect(screen.getByTestId('account-delete-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('account-delete-confirm'));
    expect(vscodeMock.posted).toContainEqual({
      type: 'deleteAccount',
      payload: { id: 'claude-work' },
    });
  });

  it('supports quick official/provider channel switching inside ModelPicker', () => {
    render(<ModelPicker disabled={false} />);
    vscodeMock.reset();

    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByTestId('model-channel-toggle'));
    expect(screen.queryByText('管理账号')).toBeNull();
    expect(screen.queryByText('管理服务商')).toBeNull();

    // 默认灰色圆点、选中项绿色圆点，且不显示后面的 plan 文本或勾选图标
    const activeOfficialBtn = screen.getByTestId('quick-channel-official-system:claude');
    const inactiveOfficialBtn = screen.getByTestId('quick-channel-official-claude-work');
    expect(screen.getByTestId('quick-channel-official-dot-system:claude').className).toContain('bg-green');
    expect(screen.getByTestId('quick-channel-official-dot-claude-work').className).toContain('bg-ink-3/45');
    expect(screen.getByTestId('quick-channel-provider-dot-volc').className).toContain('bg-ink-3/45');
    expect(activeOfficialBtn.textContent).not.toContain('Max');
    expect(inactiveOfficialBtn.textContent).not.toContain('Pro');
    expect(activeOfficialBtn.querySelector('svg')).toBeNull();
    expect(screen.getByTestId('quick-channel-provider-volc').querySelector('svg')).toBeNull();

    const manageOfficial = screen.getByTestId('quick-channel-official-manage-system:claude');
    expect(manageOfficial.parentElement?.className).toContain('group-hover/channel:opacity-100');
    fireEvent.click(manageOfficial);
    expect(getState().settingsOpen).toBe(true);
    expect(getState().settingsTab).toBe('accounts');

    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByTestId('model-channel-toggle'));
    const manageProvider = screen.getByTestId('quick-channel-provider-manage-volc');
    expect(manageProvider.parentElement?.className).toContain('group-hover/channel:opacity-100');
    fireEvent.click(manageProvider);
    expect(getState().settingsOpen).toBe(true);
    expect(getState().settingsTab).toBe('providers');

    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByTestId('model-channel-toggle'));
    fireEvent.click(screen.getByTestId('quick-channel-provider-volc'));

    expect(vscodeMock.posted).toContainEqual({
      type: 'setBackendChannel',
      payload: { backendId: 'claude', mode: 'provider', providerId: 'volc' },
    });
  });
});

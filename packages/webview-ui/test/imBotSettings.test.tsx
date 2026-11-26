// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ImBotsState } from '@harness-deck/shared';
import { RemoteSettings } from '../src/components/settings/RemoteSettings.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

function makeBotsState(overrides: Partial<ImBotsState> = {}): ImBotsState {
  return {
    channels: {
      wecom: {
        platform: 'wecom',
        enabled: true,
        status: 'connected',
        appId: 'bot_wecom_1',
        hasSecret: true,
        allowlist: [],
        requireMentionInGroup: true,
      },
      feishu: {
        platform: 'feishu',
        enabled: false,
        status: 'stopped',
        hasSecret: false,
        domain: 'feishu',
        allowlist: [],
        requireMentionInGroup: true,
      },
      dingtalk: {
        platform: 'dingtalk',
        enabled: false,
        status: 'stopped',
        hasSecret: false,
        allowlist: [],
        requireMentionInGroup: true,
      },
      telegram: {
        platform: 'telegram',
        enabled: false,
        status: 'stopped',
        hasSecret: false,
        allowlist: [],
        requireMentionInGroup: true,
      },
    },
    boundUsers: [
      {
        id: 'wecom:zhangsan',
        platform: 'wecom',
        userId: 'zhangsan',
        userName: '张三',
        chatId: 'zhangsan',
        chatType: 'single',
        boundAt: Date.now() - 60_000,
        lastActiveAt: Date.now() - 10_000,
      },
    ],
    ...overrides,
  };
}

function hydrateRemote(bots: ImBotsState) {
  applyHostMessage({
    type: 'snapshot',
    payload: makeSnapshot({
      remote: {
        enabled: true,
        running: true,
        port: 37890,
        bindHost: '0.0.0.0',
        interfaces: [{ name: 'eth0', address: '192.168.1.10' }],
        selectedHost: '192.168.1.10',
        scope: 'operate',
        connectedClients: 0,
        devices: [],
        bots,
      },
    }),
  });
}

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('ImBotSettingsSection UI', () => {
  it('renders all 4 platforms, saves credentials, tests connection, generates pairing, and unbinds users', () => {
    hydrateRemote(
      makeBotsState({
        pairing: { code: 'AB34CD', expiresAt: Date.now() + 300_000 },
      }),
    );

    render(<RemoteSettings />);
    fireEvent.click(screen.getByTestId('remote-tab-imbot'));

    // 顺序性校验：步骤 1（机器人通道配置）在步骤 2（配对与已绑定用户）之前
    const channelsSection = screen.getByTestId('remote-imbot-section');
    const authSection = screen.getByTestId('remote-imbot-auth-section');
    expect(channelsSection.compareDocumentPosition(authSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 4 个平台行均已渲染且企微显示已连接
    expect(screen.getByTestId('remote-imbot-row-wecom')).toBeTruthy();
    expect(screen.getByTestId('remote-imbot-row-feishu')).toBeTruthy();
    expect(screen.getByTestId('remote-imbot-row-dingtalk')).toBeTruthy();
    expect(screen.getByTestId('remote-imbot-row-telegram')).toBeTruthy();
    expect(screen.getByTestId('remote-imbot-status-wecom').textContent).toContain('已连接');

    // 配对码卡片展示 /pair AB34CD，点击生成/作废按钮分别发送消息
    expect(screen.getByTestId('remote-imbot-pairing-code').textContent).toContain('/pair AB34CD');
    fireEvent.click(screen.getByTestId('remote-imbot-generate-pairing-btn'));
    expect(vscode.posted).toContainEqual({ type: 'generateImBotPairing', payload: {} });

    fireEvent.click(screen.getByTestId('remote-imbot-clear-pairing-btn'));
    expect(vscode.posted).toContainEqual({ type: 'clearImBotPairing', payload: {} });

    // 展开飞书配置面板并填写 App ID / App Secret / 白名单后保存
    fireEvent.click(screen.getByTestId('remote-imbot-expand-feishu'));
    fireEvent.change(screen.getByTestId('remote-imbot-appid-feishu'), { target: { value: 'cli_test_99' } });
    fireEvent.change(screen.getByTestId('remote-imbot-secret-feishu'), { target: { value: 'sec_feishu_99' } });
    fireEvent.change(screen.getByTestId('remote-imbot-allowlist-feishu'), { target: { value: 'ou_1, ou_2' } });
    fireEvent.click(screen.getByTestId('remote-imbot-save-feishu'));

    expect(vscode.posted).toContainEqual({
      type: 'updateImBotChannel',
      payload: {
        platform: 'feishu',
        appId: 'cli_test_99',
        secret: 'sec_feishu_99',
        domain: 'feishu',
        allowlist: ['ou_1', 'ou_2'],
      },
    });

    // 展开企业微信点击测试连接
    fireEvent.click(screen.getByTestId('remote-imbot-expand-wecom'));
    fireEvent.click(screen.getByTestId('remote-imbot-test-wecom'));
    expect(vscode.posted).toContainEqual({ type: 'testImBotChannel', payload: { platform: 'wecom' } });

    // 解绑已绑定用户
    fireEvent.click(screen.getByTestId('remote-imbot-revoke-wecom:zhangsan'));
    expect(vscode.posted).toContainEqual({
      type: 'revokeImBotUser',
      payload: { id: 'wecom:zhangsan' },
    });

    // 输入未保存凭据后直接点击「测试连接」时，先自动落盘保存再发起测试
    vscode.reset();
    fireEvent.click(screen.getByTestId('remote-imbot-expand-telegram'));
    fireEvent.change(screen.getByTestId('remote-imbot-secret-telegram'), { target: { value: '12345:AAH_NEW' } });
    fireEvent.click(screen.getByTestId('remote-imbot-test-telegram'));
    expect(vscode.posted[0]).toEqual({
      type: 'updateImBotChannel',
      payload: {
        platform: 'telegram',
        secret: '12345:AAH_NEW',
        apiBase: '',
        allowlist: [],
      },
    });
    expect(vscode.posted[1]).toEqual({
      type: 'testImBotChannel',
      payload: { platform: 'telegram' },
    });
  });
});

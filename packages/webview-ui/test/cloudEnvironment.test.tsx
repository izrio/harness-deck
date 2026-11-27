// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ComposerFooter } from '../src/components/ComposerFooter.tsx';
import { ProjectSettings } from '../src/components/settings/ProjectSettings.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('项目切换器与云环境管理', () => {
  it('ComposerFooter 同时展示本地项目与云环境，并支持通过弹窗配对新云环境', () => {
    render(<ComposerFooter />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          projects: {
            currentPath: '/local/harness-deck',
            recent: [
              { path: '/local/harness-deck', name: 'harness-deck', lastOpenedAt: 2, isCurrent: true },
              { path: '/local/sudoku', name: 'sudoku', lastOpenedAt: 1 },
            ],
            configs: {},
            activeEnvironment: { kind: 'local' },
            cloudEnvironments: [
              {
                id: 'colab-1',
                name: 'Colab CPU',
                endpointUrl: 'https://demo.trycloudflare.com',
                provider: 'colab',
                status: 'disconnected',
                hasCredentials: true,
                remoteProjectName: 'workspace',
                remoteProjectPath: '/content/drive/MyDrive/workspace',
              },
            ],
          },
        }),
      });
    });
    vscode.posted.length = 0;

    // 打开左下角项目切换 Popover
    fireEvent.click(screen.getByTestId('composer-project-trigger'));
    expect(screen.getByTestId('composer-project-item-harness-deck')).toBeTruthy();
    expect(screen.getByTestId('composer-cloud-section')).toBeTruthy();
    expect(screen.getByTestId('composer-cloud-item-colab-1')).toBeTruthy();

    // 点击已配对云环境直接发起连接
    fireEvent.click(screen.getByTestId('composer-cloud-item-colab-1'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'connectCloudEnvironment',
      payload: { id: 'colab-1' },
    });

    // 重新打开 Popover 并点「连接云环境」打开配对弹窗
    fireEvent.click(screen.getByTestId('composer-project-trigger'));
    fireEvent.click(screen.getByTestId('composer-add-cloud-env'));
    expect(screen.getByTestId('cloud-env-dialog')).toBeTruthy();
    // 默认收起配对码输入框，且指引在标题问号 Popover 中按需弹出
    expect(screen.queryByTestId('cloud-env-code-input')).toBeNull();
    fireEvent.click(screen.getByTestId('cloud-env-guide-toggle'));
    expect(screen.getByTestId('cloud-env-guide-popover')).toBeTruthy();

    // 输入纯地址（无 #code=）时按需展开配对码输入框
    fireEvent.change(screen.getByTestId('cloud-env-endpoint-input'), {
      target: { value: 'https://new-box.trycloudflare.com' },
    });
    expect(screen.getByTestId('cloud-env-code-input')).toBeTruthy();

    fireEvent.change(screen.getByTestId('cloud-env-endpoint-input'), {
      target: { value: 'https://new-box.trycloudflare.com/pair#code=oneTime123' },
    });
    expect(screen.queryByTestId('cloud-env-code-input')).toBeNull();
    fireEvent.change(screen.getByTestId('cloud-env-name-input'), {
      target: { value: 'Colab Pro' },
    });
    fireEvent.click(screen.getByTestId('cloud-env-submit-btn'));

    expect(vscode.posted.at(-1)).toEqual({
      type: 'addCloudEnvironment',
      payload: {
        name: 'Colab Pro',
        provider: 'colab',
        pairingUrlOrEndpoint: 'https://new-box.trycloudflare.com/pair#code=oneTime123',
        connectNow: true,
      },
    });
  });

  it('处于云环境激活态时支持切回本地项目或一键断开云环境', () => {
    render(<ComposerFooter />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          projects: {
            currentPath: '/local/harness-deck',
            recent: [{ path: '/local/harness-deck', name: 'harness-deck', lastOpenedAt: 2, isCurrent: true }],
            configs: {},
            activeEnvironment: {
              kind: 'cloud',
              envId: 'colab-1',
              name: 'Colab CPU',
              provider: 'colab',
              endpointUrl: 'https://demo.trycloudflare.com',
              status: 'connected',
              remoteProjectName: 'workspace',
              remoteProjectPath: '/content/drive/MyDrive/workspace',
            },
            cloudEnvironments: [
              {
                id: 'colab-1',
                name: 'Colab CPU',
                endpointUrl: 'https://demo.trycloudflare.com',
                provider: 'colab',
                status: 'connected',
                hasCredentials: true,
                remoteProjectName: 'workspace',
                remoteProjectPath: '/content/drive/MyDrive/workspace',
              },
            ],
            cloudRecent: [
              { path: '/content/drive/MyDrive/workspace', name: 'workspace', lastOpenedAt: 2, isCurrent: true },
              { path: '/content/drive/MyDrive/other', name: 'other', lastOpenedAt: 1 },
            ],
          },
        }),
      });
    });
    vscode.posted.length = 0;

    expect(screen.getByTestId('composer-project-trigger').textContent).toContain('Colab CPU');

    fireEvent.click(screen.getByTestId('composer-project-trigger'));
    fireEvent.click(screen.getByTestId('composer-disconnect-cloud'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'disconnectCloudEnvironment',
      payload: {},
    });

    // 即使在云环境里，点击本地当前项目也会发送 openProject 切回本地
    fireEvent.click(screen.getByTestId('composer-project-trigger'));
    fireEvent.click(screen.getByTestId('composer-project-item-harness-deck'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'openProject',
      payload: { path: '/local/harness-deck', inPlace: true },
    });
  });

  it('ProjectSettings 渲染云端开发环境卡片并支持连接与断开', () => {
    render(<ProjectSettings />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          projects: {
            currentPath: '/local/harness-deck',
            recent: [{ path: '/local/harness-deck', name: 'harness-deck', lastOpenedAt: 1, isCurrent: true }],
            configs: {},
            activeEnvironment: { kind: 'local' },
            cloudEnvironments: [
              {
                id: 'vps-1',
                name: 'Linux VPS',
                endpointUrl: 'https://vps.example.com',
                provider: 'linux',
                status: 'disconnected',
                hasCredentials: true,
              },
            ],
          },
        }),
      });
    });
    vscode.posted.length = 0;

    expect(screen.getByTestId('settings-cloud-environments')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-cloud-connect-vps-1'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'connectCloudEnvironment',
      payload: { id: 'vps-1' },
    });
  });
});

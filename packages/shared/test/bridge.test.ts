import { describe, expect, it } from 'vitest';
import { parseWebviewMessage } from '../src/index.ts';

describe('parseWebviewMessage', () => {
  it('接受合法消息', () => {
    expect(parseWebviewMessage({ type: 'ready', payload: {} })).toEqual({ type: 'ready', payload: {} });
    expect(parseWebviewMessage({ type: 'checkBackendEnv', payload: {} })).toEqual({ type: 'checkBackendEnv', payload: {} });
    expect(parseWebviewMessage({ type: 'installBackend', payload: { id: 'dsh', version: '0.2.2-alpha.3' } })).toEqual({
      type: 'installBackend',
      payload: { id: 'dsh', version: '0.2.2-alpha.3' },
    });
    expect(parseWebviewMessage({ type: 'uninstallBackend', payload: { id: 'dsh' } })).toEqual({
      type: 'uninstallBackend',
      payload: { id: 'dsh' },
    });
    expect(parseWebviewMessage({ type: 'setPreferences', payload: { language: 'zh', showTurnChanges: true } })).toEqual({
      type: 'setPreferences',
      payload: { language: 'zh', showTurnChanges: true },
    });
    expect(
      parseWebviewMessage({
        type: 'setAppearance',
        payload: {
          theme: 'dark',
          colorScheme: 'forest',
          fontSize: 16,
          lineHeight: 1.7,
          paragraphSpacing: 12,
          contentWidth: 920,
          terminalFontSize: 13,
          terminalLineHeight: 1.5,
        },
      }),
    ).toEqual({
      type: 'setAppearance',
      payload: {
        theme: 'dark',
        colorScheme: 'forest',
        fontSize: 16,
        lineHeight: 1.7,
        paragraphSpacing: 12,
        contentWidth: 920,
        terminalFontSize: 13,
        terminalLineHeight: 1.5,
      },
    });
    expect(parseWebviewMessage({ type: 'previewMarkdown', payload: { path: 'docs/DESIGN.md' } })).toEqual({
      type: 'previewMarkdown',
      payload: { path: 'docs/DESIGN.md' },
    });
    expect(
      parseWebviewMessage({
        type: 'setPreferences',
        payload: { notifications: { enabled: true, onlyWhenUnfocused: true, onAttention: true } },
      }),
    ).toEqual({
      type: 'setPreferences',
      payload: { notifications: { enabled: true, onlyWhenUnfocused: true, onAttention: true } },
    });
    expect(
      parseWebviewMessage({
        type: 'upsertBackendProfile',
        payload: { id: 'custom-acp', name: 'Custom', command: 'my-agent', args: ['acp'], env: { FOO: 'bar' } },
      }),
    ).toEqual({
      type: 'upsertBackendProfile',
      payload: { id: 'custom-acp', name: 'Custom', command: 'my-agent', args: ['acp'], env: { FOO: 'bar' } },
    });
    expect(
      parseWebviewMessage({
        type: 'setProjectWorktreeConfig',
        payload: { path: '/repo', copyFiles: ['.env'], setupCommands: ['pnpm install'], verifyCommands: ['pnpm test'] },
      }),
    ).toEqual({
      type: 'setProjectWorktreeConfig',
      payload: { path: '/repo', copyFiles: ['.env'], setupCommands: ['pnpm install'], verifyCommands: ['pnpm test'] },
    });
    expect(parseWebviewMessage({ type: 'pickFiles', payload: {} })).toEqual({ type: 'pickFiles', payload: {} });
  });

  it('拒绝未知类型和缺少 payload 的消息', () => {
    expect(parseWebviewMessage({ type: 'runCommand', payload: { command: 'rm -rf /' } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'ready' })).toBeUndefined();
    expect(parseWebviewMessage('ready')).toBeUndefined();
  });
});

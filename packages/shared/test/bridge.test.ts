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
    expect(
      parseWebviewMessage({
        type: 'setPreferences',
        payload: {
          chatCommands: [
            { name: 'review', description: '代码审查', prompt: '请审查以下改动：' },
          ],
        },
      }),
    ).toEqual({
      type: 'setPreferences',
      payload: {
        chatCommands: [
          { name: 'review', description: '代码审查', prompt: '请审查以下改动：' },
        ],
      },
    });
    expect(parseWebviewMessage({ type: 'pickFiles', payload: {} })).toEqual({ type: 'pickFiles', payload: {} });
    expect(
      parseWebviewMessage({
        type: 'upsertProvider',
        payload: {
          name: '火山方舟',
          presetId: 'volcengine-coding',
          apiKey: 'rk-secret',
          anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding',
          models: [{ id: 'ark-code-latest', contextWindow: '256k', efforts: ['low', 'high'], vision: true }],
          defaultModel: 'ark-code-latest',
          boundBackendIds: ['claude', 'dsh'],
        },
      }),
    ).toEqual({
      type: 'upsertProvider',
      payload: {
        name: '火山方舟',
        presetId: 'volcengine-coding',
        apiKey: 'rk-secret',
        anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding',
        models: [{ id: 'ark-code-latest', contextWindow: '256k', efforts: ['low', 'high'], vision: true }],
        defaultModel: 'ark-code-latest',
        boundBackendIds: ['claude', 'dsh'],
      },
    });
    expect(parseWebviewMessage({ type: 'deleteProvider', payload: { id: 'volcengine' } })).toEqual({
      type: 'deleteProvider',
      payload: { id: 'volcengine' },
    });
    expect(parseWebviewMessage({ type: 'setProtocolGateway', payload: { enabled: true } })).toEqual({
      type: 'setProtocolGateway',
      payload: { enabled: true },
    });
    expect(
      parseWebviewMessage({
        type: 'fetchProviderModels',
        payload: { requestId: 1, openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
      }),
    ).toEqual({
      type: 'fetchProviderModels',
      payload: { requestId: 1, openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
    });
    expect(
      parseWebviewMessage({
        type: 'scanGitSkills',
        payload: { repoUrl: 'anthropics/skills', ref: 'main', subpath: 'skills' },
      }),
    ).toEqual({
      type: 'scanGitSkills',
      payload: { repoUrl: 'anthropics/skills', ref: 'main', subpath: 'skills' },
    });
    expect(
      parseWebviewMessage({
        type: 'installGitSkills',
        payload: {
          repoUrl: 'https://github.com/anthropics/skills',
          selectedSubpaths: ['skills/frontend-design'],
          agents: ['dsh', 'claude'],
        },
      }),
    ).toEqual({
      type: 'installGitSkills',
      payload: {
        repoUrl: 'https://github.com/anthropics/skills',
        selectedSubpaths: ['skills/frontend-design'],
        agents: ['dsh', 'claude'],
      },
    });
    expect(parseWebviewMessage({ type: 'updateSkill', payload: { id: 'frontend-design', enabled: false, agents: null } })).toEqual({
      type: 'updateSkill',
      payload: { id: 'frontend-design', enabled: false, agents: null },
    });
    expect(parseWebviewMessage({ type: 'syncSkill', payload: { id: 'frontend-design' } })).toEqual({
      type: 'syncSkill',
      payload: { id: 'frontend-design' },
    });
    expect(parseWebviewMessage({ type: 'deleteSkill', payload: { id: 'frontend-design' } })).toEqual({
      type: 'deleteSkill',
      payload: { id: 'frontend-design' },
    });
    expect(
      parseWebviewMessage({
        type: 'upsertMcpServer',
        payload: {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'],
          env: { NODE_ENV: 'production' },
          enabled: true,
          agents: ['dsh', 'claude', 'oh-my-pi'],
        },
      }),
    ).toEqual({
      type: 'upsertMcpServer',
      payload: {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'],
        env: { NODE_ENV: 'production' },
        enabled: true,
        agents: ['dsh', 'claude', 'oh-my-pi'],
      },
    });
    expect(parseWebviewMessage({ type: 'toggleMcpServer', payload: { id: 'filesystem', agents: ['dsh'] } })).toEqual({
      type: 'toggleMcpServer',
      payload: { id: 'filesystem', agents: ['dsh'] },
    });
    expect(parseWebviewMessage({ type: 'deleteMcpServer', payload: { id: 'filesystem' } })).toEqual({
      type: 'deleteMcpServer',
      payload: { id: 'filesystem' },
    });
    expect(parseWebviewMessage({ type: 'scanAgentMcpConfigs', payload: {} })).toEqual({
      type: 'scanAgentMcpConfigs',
      payload: {},
    });
    expect(parseWebviewMessage({ type: 'pickMcpConfigFile', payload: {} })).toEqual({
      type: 'pickMcpConfigFile',
      payload: {},
    });
    expect(
      parseWebviewMessage({
        type: 'importMcpServers',
        payload: {
          servers: [{ name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp', importedFrom: 'Claude Code' }],
          agents: ['dsh', 'claude'],
        },
      }),
    ).toEqual({
      type: 'importMcpServers',
      payload: {
        servers: [{ name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp', importedFrom: 'Claude Code' }],
        agents: ['dsh', 'claude'],
      },
    });
  });

  it('拒绝未知类型和缺少 payload 的消息', () => {
    expect(parseWebviewMessage({ type: 'runCommand', payload: { command: 'rm -rf /' } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'setPreferences', payload: { chatCommands: [{ name: '', prompt: 'hi' }] } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'installGitSkills', payload: { repoUrl: '' } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'importMcpServers', payload: { servers: [], agents: ['dsh'] } })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'ready' })).toBeUndefined();
    expect(parseWebviewMessage('ready')).toBeUndefined();
  });
});

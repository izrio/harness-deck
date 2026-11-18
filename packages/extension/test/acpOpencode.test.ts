import { describe, expect, it } from 'vitest';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { AcpSessionProjection } from '../src/acp/projection.ts';
import { builtinProfiles, npmPackageFor, parseProfiles, profileView } from '../src/backend/profiles.ts';
import { setLocale } from '../src/i18n.ts';

describe('OpenCode 内置 ACP 底层', () => {
  it('内置配置包含 opencode acp 与 npm 包 opencode-ai，支持在 harnessDeck.backends 中覆盖命令路径', () => {
    const builtins = builtinProfiles((id) => `hint:${id}`);
    const opencode = builtins.find((p) => p.id === 'opencode');
    expect(opencode).toEqual({
      id: 'opencode',
      kind: 'acp',
      name: 'OpenCode',
      command: 'opencode',
      args: ['acp'],
      env: {},
      installHint: 'hint:opencode',
      signInHint: 'hint:opencode-sign-in',
    });
    expect(npmPackageFor('opencode')).toBe('opencode-ai');

    const view = profileView(opencode!, { builtinIds: new Set(['opencode']), available: false });
    expect(view).toMatchObject({
      id: 'opencode',
      name: 'OpenCode',
      kind: 'acp',
      builtin: true,
      command: 'opencode acp',
      npmPackage: 'opencode-ai',
      installCommand: 'npm install -g opencode-ai',
    });

    const overridden = parseProfiles(
      [{ id: 'opencode', name: 'OpenCode', command: '/usr/local/bin/opencode', args: ['acp'] }],
      undefined,
      builtins,
    );
    expect(overridden.find((p) => p.id === 'opencode')).toMatchObject({
      command: '/usr/local/bin/opencode',
      args: ['acp'],
      installHint: 'hint:opencode',
      signInHint: 'hint:opencode-sign-in',
    });
  });

  it('兼容 OpenCode ACP 工具参数 filePath（驼峰）、patch 编辑与 todowrite 待办列表', () => {
    setLocale('zh');
    const p = new AcpSessionProjection('/repo');
    p.addUserMessage('检查并修改配置');
    p.startTurn(1000);

    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc_read_1',
      name: 'read',
      kind: 'read',
      status: 'completed',
      rawInput: { filePath: '/repo/src/config.ts' },
    });

    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc_patch_1',
      name: 'patch',
      kind: 'other',
      status: 'completed',
      rawInput: { filePath: '/repo/src/config.ts' },
      content: [
        {
          type: 'diff',
          path: '/repo/src/config.ts',
          oldText: 'export const PORT = 3000;\n',
          newText: 'export const PORT = 8080;\n',
        },
      ],
    });

    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc_todo_1',
      name: 'todowrite',
      kind: 'other',
      status: 'completed',
      rawInput: {
        todos: [
          { content: '修改默认端口', status: 'completed' },
          { content: '补充单元测试', status: 'in_progress' },
        ],
      },
    });

    p.apply({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: '端口已改为 8080。' },
    });
    p.endTurn(2500, 'end_turn');

    const items = p.snapshotItems().filter((i) => i.kind !== 'turnDone');
    expect(items).toMatchObject([
      { kind: 'user', text: '检查并修改配置' },
      { kind: 'explore', summary: '读取 1 个文件', entries: [{ label: 'read  src/config.ts', path: 'src/config.ts' }] },
      { kind: 'activity', variant: 'edit', tool: 'patch', label: 'src/config.ts', stats: { additions: 1, deletions: 1 } },
      { kind: 'assistant', markdown: '端口已改为 8080。', streaming: false },
    ]);

    expect(p.todos).toEqual([
      { content: '修改默认端口', status: 'completed' },
      { content: '补充单元测试', status: 'in_progress' },
    ]);

    expect(p.fileChanges()).toMatchObject([
      { path: '/repo/src/config.ts', additions: 1, deletions: 1, created: false },
    ]);
  });

  it('兼容 session/new 返回 models / modes 字段，并调用 session/set_model 与 session/set_mode', async () => {
    setLocale('zh');
    const calls: { method: string; params: unknown }[] = [];
    const link: AcpLink = {
      request: async <T,>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'session/new') {
          return {
            sessionId: 'ses_oc_1',
            models: {
              currentModelId: 'anthropic/claude-sonnet-4-5',
              availableModels: [
                { modelId: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
                { modelId: 'openai/gpt-5', name: 'GPT-5' },
              ],
            },
            modes: {
              currentModeId: 'build',
              availableModes: [
                { id: 'build', name: 'Build' },
                { id: 'plan', name: 'Plan' },
              ],
            },
          } as T;
        }
        return null as T;
      },
      notify: () => undefined,
    };

    const controller = new AcpController({
      workspacePath: '/repo',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      renderDelayMs: 0,
      backends: () => ({ items: [{ id: 'opencode', name: 'OpenCode', kind: 'acp' }], active: 'opencode' }),
    });

    controller.setLink(link, { protocolVersion: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const snap1 = controller.snapshot();
    expect(snap1.models.current?.model).toBe('anthropic/claude-sonnet-4-5');
    expect(snap1.models.options.map((m) => m.model)).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
    expect(snap1.permissions.current).toBe('build');
    expect(snap1.permissions.options).toEqual(['build', 'plan']);

    await controller.handle({ type: 'selectModel', payload: { provider: 'acp', model: 'openai/gpt-5' } });
    await controller.handle({ type: 'selectPermission', payload: { preset: 'plan' } });

    expect(calls).toContainEqual({ method: 'session/set_model', params: { sessionId: 'ses_oc_1', modelId: 'openai/gpt-5' } });
    expect(calls).toContainEqual({ method: 'session/set_mode', params: { sessionId: 'ses_oc_1', modeId: 'plan' } });

    const snap2 = controller.snapshot();
    expect(snap2.models.current?.model).toBe('openai/gpt-5');
    expect(snap2.permissions.current).toBe('plan');
    expect(snap2.session.planMode).toBe(true);

    controller.dispose();
  });
});

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backendProtocolCapability } from '@harness-deck/shared';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { AcpSessionProjection } from '../src/acp/projection.ts';
import { builtinProfiles, npmPackageFor, parseProfiles, profileView } from '../src/backend/profiles.ts';
import { scanAgentMcpConfigs } from '../src/extensions/mcpImporter.ts';
import { detectAcpSkillMode, prepareBackendLaunch } from '../src/extensions/mcpService.ts';
import { setLocale } from '../src/i18n.ts';
import { extraSearchDirsForCommand, locateExecutable } from '../src/runtime/locate.ts';

describe('Antigravity 内置 ACP 底层', () => {
  it('内置配置包含 agy acp（无 npm 包），支持在 harnessDeck.backends 中覆盖命令路径', () => {
    const builtins = builtinProfiles((id) => `hint:${id}`);
    const agy = builtins.find((p) => p.id === 'antigravity');
    expect(agy).toEqual({
      id: 'antigravity',
      kind: 'acp',
      name: 'Antigravity',
      command: 'agy',
      args: ['acp'],
      env: {},
      installHint: 'hint:antigravity',
      signInHint: 'hint:antigravity-sign-in',
    });
    expect(npmPackageFor('antigravity')).toBeUndefined();

    const view = profileView(agy!, { builtinIds: new Set(['antigravity']), available: false });
    expect(view).toMatchObject({
      id: 'antigravity',
      name: 'Antigravity',
      kind: 'acp',
      builtin: true,
      command: 'agy acp',
      executable: 'agy',
      args: ['acp'],
      installHint: 'hint:antigravity',
    });
    expect(view.npmPackage).toBeUndefined();

    const overridden = parseProfiles(
      [{ id: 'antigravity', name: 'Antigravity', command: '/opt/agy/bin/agy', args: ['acp', '--sandbox'] }],
      undefined,
      builtins,
    );
    expect(overridden.find((p) => p.id === 'antigravity')).toMatchObject({
      command: '/opt/agy/bin/agy',
      args: ['acp', '--sandbox'],
      installHint: 'hint:antigravity',
      signInHint: 'hint:antigravity-sign-in',
    });
  });

  it('将 antigravity 与自定义 agy 命令识别为仅账号登录（account-only）', () => {
    expect(backendProtocolCapability({ id: 'antigravity', kind: 'acp', name: 'Antigravity', executable: 'agy' })).toEqual({
      kind: 'account-only',
    });
    expect(backendProtocolCapability({ id: 'my-agent', kind: 'acp', name: 'Custom', executable: 'agy', command: 'agy acp' })).toEqual({
      kind: 'account-only',
    });
  });

  it('PATH 不包含 ~/.local/bin 时也能通过回退目录定位 agy 可执行文件', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'hd-agy-home-'));
    try {
      const binDir = join(fakeHome, '.local', 'bin');
      await mkdir(binDir, { recursive: true });
      const agyName = process.platform === 'win32' ? 'agy.exe' : 'agy';
      const agyPath = join(binDir, agyName);
      await writeFile(agyPath, '#!/bin/sh\necho 1.5.12\n', 'utf8');
      if (process.platform !== 'win32') await chmod(agyPath, 0o755);

      const env =
        process.platform === 'win32'
          ? { PATH: '', USERPROFILE: fakeHome }
          : { PATH: '', HOME: fakeHome };
      const extraDirs = extraSearchDirsForCommand('agy', env, process.platform);
      expect(extraDirs).toContain(binDir);

      const located = await locateExecutable('agy', {
        env,
        platform: process.platform,
        extraDirs,
      });
      expect(located).toEqual({ kind: 'found', command: agyPath, source: 'path' });
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('session/new 同时返回 configOptions 与旧版 models.currentModelId 时不被组合模型 ID 覆盖，且切换模型时不发送不支持的思考档位', async () => {
    setLocale('zh');
    const calls: { method: string; params: unknown }[] = [];
    const baseModelOptions = [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ];
    const modeOptions = [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ];

    const link: AcpLink = {
      request: async <T,>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'session/new') {
          return {
            sessionId: 'ses_agy_1',
            models: {
              currentModelId: 'gemini-4-neon-xhigh',
              availableModels: [
                { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
              ],
            },
            modes: {
              currentModeId: 'default',
              availableModes: modeOptions.map((m) => ({ id: m.value, name: m.name })),
            },
            configOptions: [
              { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: baseModelOptions },
              {
                id: 'thought_level',
                name: 'Thinking Level',
                category: 'thought_level',
                type: 'select',
                currentValue: 'xhigh',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra' },
                ],
              },
              { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: modeOptions },
            ],
          } as T;
        }
        if (method === 'session/set_config_option') {
          const p = params as { configId: string; value: string };
          if (p.configId === 'model' && p.value === 'gemini-3.8-flash') {
            return {
              configOptions: [
                { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: baseModelOptions },
                {
                  id: 'thought_level',
                  name: 'Thinking Level',
                  category: 'thought_level',
                  type: 'select',
                  currentValue: 'high',
                  options: [
                    { value: 'low', name: 'Low' },
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                  ],
                },
                { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: modeOptions },
              ],
            } as T;
          }
          if (p.configId === 'mode') {
            return {
              configOptions: [
                { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: baseModelOptions },
                {
                  id: 'thought_level',
                  name: 'Thinking Level',
                  category: 'thought_level',
                  type: 'select',
                  currentValue: 'high',
                  options: [
                    { value: 'low', name: 'Low' },
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                  ],
                },
                { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: p.value, options: modeOptions },
              ],
            } as T;
          }
        }
        return null as T;
      },
      notify: () => undefined,
    };

    const controller = new AcpController({
      workspacePath: '/repo',
      backendName: 'Antigravity',
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
      backends: () => ({ items: [{ id: 'antigravity', name: 'Antigravity', kind: 'acp' }], active: 'antigravity' }),
    });

    controller.setLink(link, { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' } });
    await new Promise((r) => setTimeout(r, 20));

    const snap1 = controller.snapshot();
    expect(snap1.models.current).toEqual({ provider: 'acp', model: 'gemini-4-neon', reasoningEffort: 'xhigh' });
    expect(snap1.models.options.map((m) => m.model)).toEqual(['gemini-4-neon', 'gemini-3.8-flash']);

    // 若代理同时推送旧版 current_model_update（组合 ID），不应破坏 configOptions 的 model 值
    controller.onSessionUpdate({
      sessionId: 'ses_agy_1',
      update: { sessionUpdate: 'current_model_update', currentModelId: 'gemini-4-neon-xhigh' },
    });
    expect(controller.snapshot().models.current?.model).toBe('gemini-4-neon');

    // 从支持 xhigh 的模型切到只支持 low/medium/high 的模型时，不应发出 thought_level=xhigh 请求
    await controller.handle({
      type: 'selectModel',
      payload: { provider: 'acp', model: 'gemini-3.8-flash', reasoningEffort: 'xhigh' },
    });
    expect(calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 'ses_agy_1', configId: 'model', value: 'gemini-3.8-flash' },
    });
    expect(calls.some((c) => c.method === 'session/set_config_option' && (c.params as { configId: string }).configId === 'thought_level')).toBe(
      false,
    );
    expect(controller.snapshot().models.current).toEqual({
      provider: 'acp',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'high',
    });

    await controller.handle({ type: 'selectPermission', payload: { preset: 'plan' } });
    expect(calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 'ses_agy_1', configId: 'mode', value: 'plan' },
    });
    expect(controller.snapshot().session.planMode).toBe(true);

    controller.dispose();
  });

  it('投影兼容 Antigravity 工具参数（CommandLine、Path、Target/Replacement、Content）与 usage_update', () => {
    setLocale('zh');
    const p = new AcpSessionProjection('/repo');
    p.addUserMessage('检查并更新配置');
    p.startTurn(1000);

    p.apply({
      sessionUpdate: 'usage_update',
      used: 12000,
      size: 1048576,
    });
    p.apply({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '先读取配置文件。' },
    });
    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_read_1',
      name: 'read_file',
      kind: 'read',
      status: 'completed',
      rawInput: { Path: '/repo/src/app.ts' },
    });
    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_cmd_1',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'pnpm test' },
      rawOutput: { output: 'Tests passed' },
    });
    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_edit_1',
      name: 'edit_file',
      kind: 'edit',
      status: 'completed',
      rawInput: {
        Path: '/repo/src/app.ts',
        Target: 'export const PORT = 3000;',
        Replacement: 'export const PORT = 8080;',
      },
    });
    p.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_write_1',
      name: 'write_file',
      kind: 'edit',
      status: 'completed',
      rawInput: {
        Path: '/repo/src/new.ts',
        Content: 'export const ok = true;\nexport const n = 1;\n',
      },
    });
    p.apply({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '已完成修改。' },
    });
    p.endTurn(2500, 'end_turn');

    expect(p.usage).toEqual({ used: 12000, size: 1048576 });

    const items = p.snapshotItems().filter((i) => i.kind !== 'turnDone');
    expect(items).toMatchObject([
      { kind: 'user', text: '检查并更新配置' },
      { kind: 'assistant', reasoning: '先读取配置文件。', markdown: '' },
      { kind: 'explore', summary: '读取 1 个文件', entries: [{ label: 'read_file  src/app.ts', path: 'src/app.ts' }] },
      { kind: 'activity', variant: 'command', tool: 'run_command', label: 'run_command  pnpm test', output: 'Tests passed' },
      {
        kind: 'activity',
        variant: 'edit',
        tool: 'edit_file',
        label: 'src/app.ts',
        stats: { additions: 1, deletions: 1 },
        diff: { kind: 'tool', callId: 'call_edit_1' },
      },
      {
        kind: 'activity',
        variant: 'edit',
        tool: 'write_file',
        label: 'src/new.ts',
        stats: { additions: 2, deletions: 0 },
      },
      { kind: 'assistant', markdown: '已完成修改。', streaming: false },
    ]);

    expect(p.diffsOf('call_edit_1')).toEqual([
      { path: '/repo/src/app.ts', oldText: 'export const PORT = 3000;', newText: 'export const PORT = 8080;' },
    ]);
    expect(p.fileChanges()).toMatchObject([
      { path: '/repo/src/app.ts', additions: 1, deletions: 1, created: false },
      { path: '/repo/src/new.ts', additions: 2, deletions: 0 },
    ]);
  });

  it('审批卡片正确提取 Antigravity run_command 的 CommandLine 与 edit_file 的 Path', async () => {
    setLocale('zh');
    const link: AcpLink = {
      request: async <T,>(method: string): Promise<T> => {
        if (method === 'session/new') return { sessionId: 'ses_perm_1' } as T;
        return null as T;
      },
      notify: () => undefined,
    };

    const controller = new AcpController({
      workspacePath: '/repo',
      backendName: 'Antigravity',
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
    });

    controller.setLink(link, { protocolVersion: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const cmdPerm = controller.onAgentRequest('session/request_permission', {
      sessionId: 'ses_perm_1',
      toolCall: {
        toolCallId: 'tc_cmd',
        name: 'run_command',
        kind: 'execute',
        title: 'Run tests',
        rawInput: { CommandLine: 'pnpm vitest run' },
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ],
    });

    const editPerm = controller.onAgentRequest('session/request_permission', {
      sessionId: 'ses_perm_1',
      toolCall: {
        toolCallId: 'tc_edit',
        name: 'edit_file',
        kind: 'edit',
        title: 'Edit README',
        rawInput: { Path: '/repo/README.md', Target: 'a', Replacement: 'b' },
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ],
    });

    const interactions = controller.snapshot().interactions;
    expect(interactions).toMatchObject([
      { kind: 'approval', toolName: 'run_command', subject: 'pnpm vitest run', subjectKind: 'command' },
      { kind: 'approval', toolName: 'edit_file', subject: 'README.md', subjectKind: 'file' },
    ]);

    controller.dispose();
    await Promise.all([cmdPerm, editPerm]);
  });

  it('Skills 挂载使用 --add-dir（cli 模式），并能扫描 Antigravity 原生 MCP 配置', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hd-agy-ext-'));
    try {
      const skillDir = join(tmp, 'skills', 'installed', 'my-skill');
      await mkdir(skillDir, { recursive: true });
      const skillMdPath = join(skillDir, 'SKILL.md');
      await writeFile(skillMdPath, '---\nname: my-skill\ndescription: demo\n---\n', 'utf8');

      const profile = {
        id: 'antigravity',
        kind: 'acp' as const,
        name: 'Antigravity',
        command: 'agy',
        args: ['acp'],
        env: {},
      };
      expect(detectAcpSkillMode(profile)).toBe('antigravity');

      const prepared = await prepareBackendLaunch({
        storageRoot: tmp,
        profile,
        skills: [
          {
            id: 'my-skill',
            name: 'my-skill',
            description: 'demo',
            repoUrl: 'https://example.com/repo.git',
            skillMdPath,
            enabled: true,
            installedAt: 1,
            updatedAt: 1,
          },
        ],
        mcpServers: [],
      });
      expect(prepared.skillMode).toBe('cli');
      expect(prepared.skillBundleDir).toBeTruthy();
      expect(prepared.extraArgs).toEqual(['--add-dir', prepared.skillBundleDir]);

      // 扫描 Antigravity 全局与工作区 MCP 配置
      const fakeHome = join(tmp, 'home');
      const fakeWs = join(tmp, 'ws');
      await mkdir(join(fakeHome, '.gemini', 'config'), { recursive: true });
      await mkdir(join(fakeWs, '.agents'), { recursive: true });
      await writeFile(
        join(fakeHome, '.gemini', 'config', 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'global-agy-mcp': { command: 'npx', args: ['-y', '@example/mcp'] },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(fakeWs, '.agents', 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            'ws-agy-mcp': { url: 'https://mcp.example.com/mcp' },
          },
        }),
        'utf8',
      );

      const scanned = await scanAgentMcpConfigs({ homeDir: fakeHome, workspacePath: fakeWs });
      expect(scanned.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'global-agy-mcp', sourceAgentId: 'antigravity', transport: 'stdio' }),
          expect.objectContaining({ name: 'ws-agy-mcp', sourceAgentId: 'antigravity', transport: 'http' }),
        ]),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

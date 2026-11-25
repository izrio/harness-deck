import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview, Item } from '@harness-deck/shared';
import { CLAUDE_PROFILE, npmPackageFor } from '../src/backend/profiles.ts';
import { buildClaudeArgs, ClaudeConnection, type ClaudeLink } from '../src/claude/connection.ts';
import { ClaudeController } from '../src/claude/ClaudeController.ts';
import { locateClaude } from '../src/claude/locate.ts';
import { ClaudeSessionProjection } from '../src/claude/projection.ts';
import { encodeClaudeProjectDir, readClaudeSessionEvents, scanClaudeSessions } from '../src/claude/sessions.ts';
import { prepareBackendLaunch } from '../src/extensions/mcpService.ts';
import { UnattendedRunner } from '../src/hub/UnattendedRunner.ts';
import { setLocale } from '../src/i18n.ts';
import { prepareClaudeProviderRuntime } from '../src/providers/ProviderRuntime.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Claude Code 原生接入（claude -p）', () => {
  it('内置配置为原生 kind=claude，npm 包为 @anthropic-ai/claude-code，启动参数包含 -p 与 stream-json', async () => {
    expect(CLAUDE_PROFILE).toEqual({ id: 'claude', kind: 'claude', name: 'Claude Code' });
    expect(npmPackageFor('claude')).toBe('@anthropic-ai/claude-code');
    expect(
      buildClaudeArgs({
        resumeSessionId: 'sess-abc',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        extraArgs: ['--add-dir', '/bundle', '--mcp-config', '/mcp.json'],
      }),
    ).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--resume',
      'sess-abc',
      '--model',
      'sonnet',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      '/bundle',
      '--mcp-config',
      '/mcp.json',
    ]);

    const dir = await mkdtemp(join(tmpdir(), 'hd-claude-loc-'));
    tempDirs.push(dir);
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const fakeClaude = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    await writeFile(fakeClaude, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(fakeClaude, 0o755);

    const located = await locateClaude({ env: { PATH: binDir }, platform: process.platform });
    expect(located).toEqual({ kind: 'found', command: fakeClaude, source: 'path' });

    const invalid = await locateClaude({
      configuredPath: join(dir, 'missing-claude'),
      env: { PATH: binDir },
      platform: process.platform,
    });
    expect(invalid).toEqual({ kind: 'notFound', configuredPathInvalid: true });
  });

  it('为原生 Claude Code 准备服务商代理环境变量，并通过 --add-dir 与 --mcp-config 挂载 Skills 和 MCP', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'hd-claude-ext-'));
    tempDirs.push(storageRoot);
    const skillDir = join(storageRoot, 'skills', 'installed', 'ui-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: ui-review\ndescription: UI review\n---\nBody', 'utf8');

    const prepared = await prepareBackendLaunch({
      storageRoot,
      profile: CLAUDE_PROFILE,
      skills: [
        {
          id: 'ui-review',
          name: 'ui-review',
          description: 'UI review',
          repoUrl: 'https://github.com/org/repo.git',
          skillMdPath: join(skillDir, 'SKILL.md'),
          enabled: true,
          installedAt: 1,
          updatedAt: 1,
        },
      ],
      mcpServers: [
        {
          id: 'fs',
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'server-fs'],
          enabled: true,
          agents: ['claude'],
        },
      ],
    });
    expect(prepared.extraArgs).toContain('--add-dir');
    expect(prepared.extraArgs).toContain('--mcp-config');

    const providerEnv = prepareClaudeProviderRuntime({
      provider: {
        id: 'ark',
        name: 'Volcengine',
        anthropicUrl: 'https://ark.example.com/api/coding',
        models: [{ id: 'ark-code-latest' }],
        defaultModel: 'ark-code-latest',
        boundBackendIds: ['claude'],
      },
      proxyOrigin: 'http://127.0.0.1:43210',
      proxyToken: 'tok-local',
      baseEnv: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'secret-leak' },
    });
    expect(providerEnv?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(providerEnv?.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:43210/p/ark/anthropic');
    expect(providerEnv?.env.ANTHROPIC_API_KEY).toBe('tok-local');
  });

  it('投影 stream_event 增量与 assistant 完整消息不重复拼接，合并只读工具，提取文件 Diff 与 TodoWrite', () => {
    setLocale('zh');
    const p = new ClaudeSessionProjection('/repo');
    p.addUserMessage('重构配置');
    p.startTurn(1_000);

    p.applyEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'cs-1',
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
      slash_commands: ['/compact', '/review'],
    });

    // 流式分块（thinking_delta + text_delta）
    p.applyEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { usage: { input_tokens: 1200, cache_read_input_tokens: 800 } } },
    });
    p.applyEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先查看配置。' } },
    });
    p.applyEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '我来检查并修改文件。' } },
    });

    // 随后到达的 assistant 完整消息不应把已流式输出的文本重复拼一遍
    p.applyEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: '先查看配置。' },
          { type: 'text', text: '我来检查并修改文件。' },
          { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
          { type: 'tool_use', id: 'tu_grep', name: 'Grep', input: { pattern: 'PORT' } },
        ],
      },
    });
    p.applyEvent({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_read', content: 'export const PORT = 3000;' },
          { type: 'tool_result', tool_use_id: 'tu_grep', content: 'src/a.ts:1' },
        ],
      },
    });

    // 编辑文件 + TodoWrite
    p.applyEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_todo',
            name: 'TodoWrite',
            input: { todos: [{ content: '更新端口', status: 'completed' }] },
          },
          {
            type: 'tool_use',
            id: 'tu_edit',
            name: 'Edit',
            input: {
              file_path: '/repo/src/a.ts',
              old_string: 'export const PORT = 3000;',
              new_string: 'export const PORT = 8080;\nexport const HOST = "127.0.0.1";',
            },
          },
        ],
      },
    });
    p.applyEvent({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'File updated' }],
      },
    });
    p.applyEvent(
      {
        type: 'result',
        subtype: 'success',
        session_id: 'cs-1',
        is_error: false,
        usage: { input_tokens: 2500, output_tokens: 500 },
        modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200_000 } },
      },
      2_500,
    );

    const items = p.snapshotItems();
    expect(items).toMatchObject([
      { kind: 'user', text: '重构配置' },
      { kind: 'assistant', markdown: '我来检查并修改文件。', reasoning: '先查看配置。', streaming: false },
      { kind: 'explore', status: 'ok', entries: [{ label: 'Read  src/a.ts' }, { label: 'Grep  PORT' }] },
      { kind: 'activity', variant: 'edit', label: 'src/a.ts', status: 'ok', stats: { additions: 2, deletions: 1 } },
      { kind: 'turnDone', completed: true, durationMs: 1_500 },
    ]);
    expect(p.todos).toEqual([{ content: '更新端口', status: 'completed' }]);
    expect(p.fileChanges()).toHaveLength(1);
    expect(p.usage).toEqual({ used: 3_000, size: 200_000 });
  });

  it('扫描并回放 ~/.claude/projects/<encoded-cwd>/*.jsonl 历史会话', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'hd-claude-hist-'));
    tempDirs.push(claudeDir);
    const ws = '/workspace/demo-app';
    const projDir = join(claudeDir, 'projects', encodeClaudeProjectDir(ws));
    await mkdir(projDir, { recursive: true });
    const sessionFile = join(projDir, 'sess-history-1.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', cwd: ws, message: { role: 'user', content: '帮我加个健康检查接口' } }),
      JSON.stringify({
        type: 'assistant',
        cwd: ws,
        message: { role: 'assistant', content: [{ type: 'text', text: '已添加 `/healthz` 路由。' }] },
      }),
      JSON.stringify({ type: 'custom-title', sessionId: 'sess-history-1', customTitle: '添加健康检查接口' }),
    ];
    await writeFile(sessionFile, `${lines.join('\n')}\n`, 'utf8');

    const scanned = await scanClaudeSessions(ws, claudeDir);
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({
      id: 'sess-history-1',
      cwd: ws,
      title: '添加健康检查接口',
    });

    const records = await readClaudeSessionEvents(sessionFile);
    const p = new ClaudeSessionProjection(ws);
    p.applyHistoryRecords(records);
    expect(p.title).toBe('添加健康检查接口');
    expect(p.snapshotItems()).toMatchObject([
      { kind: 'user', text: '帮我加个健康检查接口' },
      { kind: 'assistant', markdown: '已添加 `/healthz` 路由。', streaming: false },
    ]);
  });

  it('ClaudeController 处理临时会话转正、can_use_tool 权限审批、AskUserQuestion 提问以及模型/模式切换', async () => {
    setLocale('zh');
    const posted: HostToWebview[] = [];
    const userSent: unknown[] = [];
    const controlSent: Record<string, unknown>[] = [];
    let emitEvent: ((ev: Record<string, unknown>) => void) | undefined;
    let askControl: ((reqId: string, req: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

    const fakeLink: ClaudeLink = {
      running: true,
      sendUserMessage: (content, sid) => {
        userSent.push({ content, sid });
      },
      sendControlRequest: async <T,>(req: Record<string, unknown>) => {
        controlSent.push(req);
        return {} as T;
      },
      dispose: async () => undefined,
    };

    let savedActive: string | undefined;
    const controller = new ClaudeController({
      workspacePath: '/repo',
      renderDelayMs: 0,
      post: (msg) => posted.push(msg),
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => savedActive,
      saveActiveSessionId: (sid) => {
        savedActive = sid;
      },
      loadSessions: () => [],
      saveSessions: () => undefined,
    });

    controller.setSpawner(async (params) => {
      emitEvent = params.onEvent;
      askControl = params.onControlRequest;
      return fakeLink;
    });

    await controller.handle({ type: 'sendMessage', payload: { text: '部署检查' } });
    expect(userSent).toHaveLength(1);

    // 收到 init 后 pending 会话自动转正为真实 session_id
    emitEvent!({ type: 'system', subtype: 'init', session_id: 'claude-real-99', model: 'sonnet' });
    expect(savedActive).toBe('claude-real-99');

    // 1. 普通工具审批 + 始终允许携带 updatedPermissions
    const permPromise = askControl!('req_1', {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'pnpm test' },
      decision_reason: 'Run test suite',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
    });
    const permSnap = controller.snapshot();
    expect(permSnap.interactions).toHaveLength(1);
    expect(permSnap.interactions[0]).toMatchObject({
      kind: 'approval',
      toolName: 'Bash',
      subject: 'pnpm test',
      subjectKind: 'command',
    });
    await controller.handle({
      type: 'respondApproval',
      payload: { id: permSnap.interactions[0]!.id, decision: 'allowAlways' },
    });
    await expect(permPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pnpm test' },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
    });

    // 2. AskUserQuestion 提问卡片经 updatedInput.answers 回传
    const questionPromise = askControl!('req_2', {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            id: 'env',
            header: '环境',
            question: '部署到哪个环境？',
            options: [{ label: 'Staging' }, { label: 'Production' }],
          },
        ],
      },
    });
    const qSnap = controller.snapshot();
    expect(qSnap.interactions[0]).toMatchObject({ kind: 'question' });
    await controller.handle({
      type: 'answerQuestion',
      payload: { id: qSnap.interactions[0]!.id, answers: [{ id: 'env', selected: ['Staging'] }] },
    });
    await expect(questionPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            id: 'env',
            header: '环境',
            question: '部署到哪个环境？',
            options: [{ label: 'Staging' }, { label: 'Production' }],
          },
        ],
        answers: { '部署到哪个环境？': 'Staging' },
      },
    });

    // 3. 在线切换模型（立即生效）与权限模式（回复进行中延后到下一轮生效）
    await controller.handle({ type: 'selectModel', payload: { provider: 'anthropic', model: 'opus' } });
    expect(controlSent).toContainEqual({ subtype: 'set_model', model: 'opus' });

    await controller.handle({ type: 'selectPermission', payload: { preset: 'plan' } });
    expect(controlSent).not.toContainEqual({ subtype: 'set_permission_mode', mode: 'plan' });
    expect(controller.snapshot().permissions.current).toBe('plan');

    emitEvent!({ type: 'assistant', message: { content: [{ type: 'text', text: '检查完毕。' }] } });
    emitEvent!({ type: 'result', subtype: 'success', session_id: 'claude-real-99', is_error: false });

    const finalAssistant = controller.snapshot().items.find((i): i is Extract<Item, { kind: 'assistant' }> => i.kind === 'assistant');
    expect(finalAssistant?.markdown).toBe('检查完毕。');

    // 下一轮发送前自动下发延后的权限切换
    await controller.handle({ type: 'sendMessage', payload: { text: '第二轮继续' } });
    expect(controlSent).toContainEqual({ subtype: 'set_permission_mode', mode: 'plan' });
    controller.dispose();
  });

  it('ClaudeConnection 与 UnattendedRunner 通过真实 claude -p 子进程双向跑通无人值守流式对话', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'hd-claude-proc-'));
    tempDirs.push(dir);
    const fakeClaude = join(dir, 'claude');
    const mockScript = `#!/usr/bin/env node
const readline = require('node:readline');
if (!process.argv.includes('-p') || !process.argv.includes('stream-json')) {
  process.stderr.write('missing -p or stream-json flags\\n');
  process.exit(2);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let pendingPerm = false;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    send({ type: 'system', subtype: 'init', session_id: 'claude-bg-1', model: 'sonnet' });
    pendingPerm = true;
    send({
      type: 'control_request',
      request_id: 'perm_1',
      request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'README.md' } },
    });
    return;
  }
  if (msg.type === 'control_response' && pendingPerm) {
    pendingPerm = false;
    const allow = msg.response?.response?.behavior === 'allow';
    send({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: allow ? 'Claude 定时报告生成成功。' : '被拒绝' } },
    });
    send({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: allow ? 'Claude 定时报告生成成功。' : '被拒绝' }] },
    });
    send({ type: 'result', subtype: 'success', session_id: 'claude-bg-1', is_error: false });
  }
});
`;
    await writeFile(fakeClaude, mockScript, 'utf8');
    await chmod(fakeClaude, 0o755);

    const hiddenIds: string[] = [];
    const runner = new UnattendedRunner({
      getActiveDshClient: () => undefined,
      getDshConfig: () => ({ configuredPath: '', profile: 'web', env: {} }),
      getClaudeConfig: () => ({ configuredPath: fakeClaude, env: process.env }),
      getEnvForProfile: () => process.env,
      extensionVersion: '0.4.0',
      log: () => undefined,
    });

    const outcome = await runner.run({
      profile: CLAUDE_PROFILE,
      projectPath: dir,
      prompt: '生成巡检报告',
      permission: 'read-only',
      onSessionCreated: (sid) => hiddenIds.push(sid),
    });

    expect(hiddenIds).toEqual(['claude-bg-1']);
    expect(outcome).toEqual({
      status: 'succeeded',
      sessionId: 'claude-bg-1',
      output: 'Claude 定时报告生成成功。',
    });

    // 验证直接连接控制指令
    const conn = new ClaudeConnection({
      command: fakeClaude,
      cwd: dir,
      env: process.env,
      onControlRequest: async () => ({ behavior: 'allow', updatedInput: {} }),
      onEvent: () => undefined,
      onExit: () => undefined,
    });
    await conn.start();
    await conn.dispose();
  });
});

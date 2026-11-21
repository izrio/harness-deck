import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview, Item, ProviderConfig } from '@harness-deck/shared';
import { CODEX_PROFILE, npmPackageFor } from '../src/backend/profiles.ts';
import { CodexConnection, type CodexLink } from '../src/codex/connection.ts';
import { CodexController } from '../src/codex/CodexController.ts';
import { locateCodex } from '../src/codex/locate.ts';
import { CodexSessionProjection, parseUnifiedDiff } from '../src/codex/projection.ts';
import { buildCodexMcpCliArgs } from '../src/extensions/mcpService.ts';
import { UnattendedRunner } from '../src/hub/UnattendedRunner.ts';
import { setLocale } from '../src/i18n.ts';
import { prepareCodexProviderRuntime } from '../src/providers/ProviderRuntime.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Codex 运行时查找（locateCodex）', () => {
  it('支持通过配置路径、环境变量与 PATH 查找 codex，且 npm 包名为 @openai/codex', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-codex-loc-'));
    tempDirs.push(dir);
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const codexBin = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    await writeFile(codexBin, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(codexBin, 0o755);

    const bySetting = await locateCodex({
      configuredPath: codexBin,
      env: {},
      platform: process.platform,
    });
    expect(bySetting).toEqual({ kind: 'found', command: codexBin, source: 'setting' });

    const byEnv = await locateCodex({
      env: { CODEX_BIN: codexBin },
      platform: process.platform,
    });
    expect(byEnv).toEqual({ kind: 'found', command: codexBin, source: 'setting' });

    const byPath = await locateCodex({
      env: { PATH: binDir },
      platform: process.platform,
    });
    expect(byPath).toEqual({ kind: 'found', command: codexBin, source: 'path' });

    const missing = await locateCodex({
      configuredPath: join(dir, 'nope'),
      env: {},
      platform: process.platform,
    });
    expect(missing).toEqual({ kind: 'notFound', configuredPathInvalid: true });

    expect(npmPackageFor('codex')).toBe('@openai/codex');
  });
});

describe('Codex app-server NDJSON 连接与握手', () => {
  it('支持 initialize + initialized 握手、通知接收与反向请求应答', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-codex-conn-'));
    tempDirs.push(dir);
    const serverScript = join(dir, 'mock-codex.mjs');
    await writeFile(
      serverScript,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let sawInitialized = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'codex-test/0.125.0' } }) + '\\n');
    return;
  }
  if (msg.method === 'initialized') {
    sawInitialized = true;
    return;
  }
  if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ id: 'srv-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1', command: 'echo ok' } }) + '\\n');
    return;
  }
  if (msg.id === 'srv-approval') {
    process.stdout.write(JSON.stringify({ method: 'thread/name/updated', params: { threadId: 't1', threadName: '测试线程' } }) + '\\n');
    process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: 't1' }, sawInitialized, decision: msg.result?.decision } }) + '\\n');
  }
});
`,
      'utf8',
    );

    const notifications: { method: string; params: unknown }[] = [];
    const reverseMethods: string[] = [];

    const conn = new CodexConnection({
      command: process.execPath,
      args: [serverScript],
      cwd: dir,
      env: process.env,
      onNotification: (method, params) => notifications.push({ method, params }),
      onRequest: async (method) => {
        reverseMethods.push(method);
        return { decision: 'accept' };
      },
      onExit: () => undefined,
    });

    await conn.start();
    const init = await conn.initialize('0.7.0', 5_000);
    expect(init.userAgent).toBe('codex-test/0.125.0');

    const started = await conn.request<{ thread: { id: string }; sawInitialized: boolean; decision: string }>(
      'thread/start',
      { cwd: dir, experimentalRawEvents: false, persistExtendedHistory: true },
      5_000,
    );
    expect(started).toEqual({
      thread: { id: 't1' },
      sawInitialized: true,
      decision: 'accept',
    });
    expect(reverseMethods).toEqual(['item/commandExecution/requestApproval']);
    expect(notifications).toContainEqual({
      method: 'thread/name/updated',
      params: { threadId: 't1', threadName: '测试线程' },
    });

    await conn.dispose();
  });
});

describe('CodexSessionProjection 与 unified diff 解析', () => {
  it('正确解析 unified diff 统计增删行数与 Diff hunks', () => {
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-old2',
      '+new2',
      '+new3',
      ' line3',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff, '/w/a.ts', false);
    expect(parsed.stats).toEqual({ additions: 2, deletions: 1 });
    expect(parsed.hunks).toEqual([
      { path: '/w/a.ts', oldText: 'line1\nold2\nline3', newText: 'line1\nnew2\nnew3\nline3' },
    ]);
  });

  it('实时投影流式推理、回复、探索命令、Shell 命令、文件改动、子代理、待办与用量', () => {
    setLocale('zh');
    const p = new CodexSessionProjection('/w');
    p.addUserMessage('帮我改一下 foo.ts');
    p.applyNotification('turn/started', { threadId: 't1', turn: { id: 'turn_1', status: 'inProgress', startedAt: 100 } }, 100_000);
    p.applyNotification('item/reasoning/summaryTextDelta', { threadId: 't1', turnId: 'turn_1', itemId: 'r1', delta: '先读文件' }, 100_100);
    p.applyNotification('item/agentMessage/delta', { threadId: 't1', turnId: 'turn_1', itemId: 'm1', delta: '我来查看一下。' }, 100_200);
    p.applyNotification('item/completed', { threadId: 't1', turnId: 'turn_1', item: { type: 'agentMessage', id: 'm1', text: '我来查看一下。' } }, 100_300);

    // 只读命令归类到 explore 组
    p.applyNotification('item/started', {
      threadId: 't1',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'c_read',
        command: 'cat foo.ts',
        status: 'inProgress',
        commandActions: [{ type: 'read', command: 'cat foo.ts', name: 'foo.ts', path: '/w/foo.ts' }],
      },
    }, 100_400);
    p.applyNotification('item/completed', {
      threadId: 't1',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'c_read',
        command: 'cat foo.ts',
        status: 'completed',
        exitCode: 0,
        commandActions: [{ type: 'read', command: 'cat foo.ts', name: 'foo.ts', path: '/w/foo.ts' }],
      },
    }, 100_500);

    // 普通命令 + 流式输出
    p.applyNotification('item/started', {
      threadId: 't1',
      turnId: 'turn_1',
      item: { type: 'commandExecution', id: 'c_test', command: 'pnpm test', status: 'inProgress', commandActions: [] },
    }, 100_600);
    p.applyNotification('item/commandExecution/outputDelta', { threadId: 't1', turnId: 'turn_1', itemId: 'c_test', delta: 'PASS\n' }, 100_700);
    p.applyNotification('item/completed', {
      threadId: 't1',
      turnId: 'turn_1',
      item: { type: 'commandExecution', id: 'c_test', command: 'pnpm test', status: 'completed', exitCode: 0, aggregatedOutput: 'PASS\n', commandActions: [] },
    }, 100_800);

    // 文件改动
    p.applyNotification('item/completed', {
      threadId: 't1',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'f1',
        status: 'completed',
        changes: [
          {
            path: '/w/foo.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+export { a };',
          },
        ],
      },
    }, 100_900);

    // 子代理
    p.applyNotification('item/completed', {
      threadId: 't1',
      turnId: 'turn_1',
      item: {
        type: 'collabAgentToolCall',
        id: 'sub1',
        tool: 'spawnAgent',
        status: 'completed',
        prompt: '检查边缘情况',
        agentsStates: { worker1: { status: 'completed', message: '全部通过' } },
      },
    }, 101_000);

    // 计划待办与 Token 用量
    p.applyNotification('turn/plan/updated', {
      threadId: 't1',
      turnId: 'turn_1',
      plan: [
        { step: '修改 foo.ts', status: 'completed' },
        { step: '跑单测', status: 'inProgress' },
      ],
    }, 101_100);
    p.applyNotification('thread/tokenUsage/updated', {
      threadId: 't1',
      turnId: 'turn_1',
      tokenUsage: {
        total: {
          totalTokens: 5000,
          inputTokens: 4000,
          cachedInputTokens: 2500,
          outputTokens: 1000,
          reasoningOutputTokens: 300,
        },
        last: {
          totalTokens: 2000,
          inputTokens: 1600,
          cachedInputTokens: 1000,
          outputTokens: 400,
          reasoningOutputTokens: 120,
        },
        modelContextWindow: 200000,
      },
    }, 101_200);

    const endRes = p.applyNotification('turn/completed', {
      threadId: 't1',
      turn: { id: 'turn_1', status: 'completed' },
    }, 102_000);
    expect(endRes.turnEnded).toBe(true);
    expect(p.running).toBe(false);
    expect(p.todos).toEqual([
      { content: '修改 foo.ts', status: 'completed' },
      { content: '跑单测', status: 'in_progress' },
    ]);
    expect(p.usage).toEqual({ used: 2000, size: 200000 });
    expect(p.contextDetail()).toEqual({
      lastRequest: { input: 600, cacheRead: 1000, cacheWrite: 0, output: 400, reasoning: 120 },
      session: { input: 1500, cacheRead: 2500, cacheWrite: 0, output: 1000, reasoning: 300 },
      requests: 1,
    });
    expect(p.fileChanges()).toMatchObject([{ path: '/w/foo.ts', additions: 2, deletions: 1, created: false }]);

    const items = p.snapshotItems();
    expect(items).toMatchObject([
      { kind: 'user', text: '帮我改一下 foo.ts' },
      { kind: 'assistant', reasoning: '先读文件', markdown: '我来查看一下。', streaming: false },
      { kind: 'explore', status: 'ok', entries: [{ label: 'Read  foo.ts', status: 'ok' }] },
      { kind: 'activity', variant: 'command', status: 'ok', output: 'PASS' },
      { kind: 'activity', variant: 'edit', label: 'foo.ts', status: 'ok', stats: { additions: 2, deletions: 1 } },
      { kind: 'activity', variant: 'subagent', status: 'ok', subagent: { state: 'done', prompt: '检查边缘情况' } },
      { kind: 'turnDone', completed: true },
    ]);
  });

  it('通过 applyThreadSnapshot 还原历史会话内容', () => {
    const p = new CodexSessionProjection('/w');
    p.applyThreadSnapshot({
      id: 't_hist',
      name: '历史会话',
      turns: [
        {
          id: 'turn_1',
          status: 'completed',
          items: [
            { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '你好' }] },
            { type: 'reasoning', id: 'r1', summary: ['思考中'], content: [] },
            { type: 'agentMessage', id: 'a1', text: '你好！有什么可以帮你？' },
          ],
        },
      ],
    });
    expect(p.title).toBe('历史会话');
    expect(p.snapshotItems()).toMatchObject([
      { kind: 'user', text: '你好' },
      { kind: 'assistant', reasoning: '思考中', markdown: '你好！有什么可以帮你？', streaming: false },
    ]);
  });
});

describe('CodexController 交互、模型切换、插队与审批/提问', () => {
  it('支持模型列表与思考等级、发消息、运行中 turn/steer 插队、命令审批与提问卡片', async () => {
    setLocale('zh');
    const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
    const posted: HostToWebview[] = [];
    let dirtyFiles: string[] = [];

    let catalogsResolved = 0;
    let markCatalogsDone!: () => void;
    const catalogsDone = new Promise<void>((resolve) => {
      markCatalogsDone = resolve;
    });

    const link: CodexLink = {
      request: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push({ method, params });
        if (method === 'model/list') {
          if (++catalogsResolved === 2) queueMicrotask(markCatalogsDone);
          return {
            data: [
              {
                id: 'gpt-5.4',
                model: 'gpt-5.4',
                displayName: 'GPT-5.4',
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'fast' },
                  { reasoningEffort: 'medium', description: 'balanced' },
                  { reasoningEffort: 'high', description: 'deep' },
                ],
              },
            ],
          } as T;
        }
        if (method === 'skills/list') {
          if (++catalogsResolved === 2) queueMicrotask(markCatalogsDone);
          return {
            data: [{ cwd: '/w', skills: [{ name: 'review', description: 'Code review', enabled: true }] }],
          } as T;
        }
        if (method === 'thread/list') {
          return { data: [] } as T;
        }
        if (method === 'thread/start') {
          return { thread: { id: 'thr_1' } } as T;
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn_1', status: 'inProgress' } } as T;
        }
        if (method === 'turn/steer') {
          return { turnId: 'turn_1' } as T;
        }
        return {} as T;
      },
      notify: () => undefined,
    };

    const controller = new CodexController({
      workspacePath: '/w',
      post: (m) => posted.push(m),
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      renderDelayMs: 0,
      workbench: {
        ...noWorkbench,
        dirtyFiles: () => dirtyFiles,
      },
      backends: () => ({ items: [{ id: 'codex', name: 'Codex', kind: 'codex' }], active: 'codex' }),
    });

    controller.setLink(link);
    await catalogsDone;
    await Promise.resolve();
    await Promise.resolve();

    const snap = controller.snapshot();
    expect(snap.models.options).toHaveLength(1);
    expect(snap.models.current).toEqual({ provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium' });
    expect(snap.commands.some((c) => c.name === 'review' && c.source === 'skill')).toBe(true);

    // 切换思考等级为 high 后发送第一条消息
    await controller.handle({ type: 'selectModel', payload: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' } });
    await controller.handle({ type: 'sendMessage', payload: { text: '修复 bug', includeActive: false } });

    expect(calls.find((c) => c.method === 'thread/start')?.params).toMatchObject({
      cwd: '/w',
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    expect(calls.find((c) => c.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thr_1',
      model: 'gpt-5.4',
      effort: 'high',
    });

    // 运行中再发消息会排队，点 steer 插队调用 turn/steer
    await controller.handle({ type: 'sendMessage', payload: { text: '顺便加单测', includeActive: false } });
    const queuedItem = controller.snapshot().items.find(
      (i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user' && i.pending === 'queued',
    );
    expect(queuedItem?.queue?.itemId).toBeDefined();

    await controller.handle({
      type: 'queueAction',
      payload: { action: 'steer', itemId: queuedItem!.queue!.itemId },
    });
    expect(calls.find((c) => c.method === 'turn/steer')?.params).toMatchObject({
      threadId: 'thr_1',
      expectedTurnId: 'turn_1',
    });

    // 审批卡片：命令执行（带 execpolicy amendment）
    const cmdApprovalPromise = controller.onAgentRequest(
      'item/commandExecution/requestApproval',
      {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'cmd_1',
        command: 'git status',
        proposedExecpolicyAmendment: ['git', 'status'],
      },
      'req_cmd_1',
    );
    const approvalCard = controller.snapshot().interactions[0];
    expect(approvalCard).toMatchObject({ kind: 'approval', toolName: 'Shell', subject: 'git status' });
    await controller.handle({ type: 'respondApproval', payload: { id: approvalCard!.id, decision: 'allowAlways' } });
    expect(await cmdApprovalPromise).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } },
    });

    // 文件修改审批遇到未保存脏文件时应阻止批准
    controller.onNotification('item/started', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'fc_1',
        status: 'inProgress',
        changes: [{ path: '/w/app.ts', kind: { type: 'update', move_path: null }, diff: '' }],
      },
    });
    dirtyFiles = ['/w/app.ts'];
    const fileApprovalPromise = controller.onAgentRequest(
      'item/fileChange/requestApproval',
      { threadId: 'thr_1', turnId: 'turn_1', itemId: 'fc_1' },
      'req_fc_1',
    );
    const fileCard = controller.snapshot().interactions[0];
    expect(fileCard).toMatchObject({ kind: 'approval', dirtyFiles: ['app.ts'] });
    await controller.handle({ type: 'respondApproval', payload: { id: fileCard!.id, decision: 'allow' } });
    // 未保存时仍处于等待状态
    expect(controller.snapshot().interactions).toHaveLength(1);
    dirtyFiles = [];
    await controller.handle({ type: 'respondApproval', payload: { id: fileCard!.id, decision: 'allow' } });
    expect(await fileApprovalPromise).toEqual({ decision: 'accept' });

    // 提问卡片
    const qPromise = controller.onAgentRequest(
      'item/tool/requestUserInput',
      {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'q_1',
        questions: [
          {
            id: 'framework',
            header: '框架',
            question: '选择测试框架？',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Vitest', description: '快速' },
              { label: 'Jest', description: '传统' },
            ],
          },
        ],
      },
      'req_q_1',
    );
    const qCard = controller.snapshot().interactions[0];
    expect(qCard).toMatchObject({ kind: 'question' });
    await controller.handle({
      type: 'answerQuestion',
      payload: { id: qCard!.id, answers: [{ id: 'framework', selected: ['Vitest'] }] },
    });
    expect(await qPromise).toEqual({ answers: { framework: { answers: ['Vitest'] } } });

    controller.dispose();
  });
});

describe('Codex 第三方服务商与 MCP 参数生成', () => {
  it('优先使用 OpenAI Responses 接口生成 -c 覆盖参数并隔离代理令牌', () => {
    const provider: ProviderConfig = {
      id: 'my-openai',
      name: 'My OpenAI',
      openaiResponsesUrl: 'https://api.example.com/v1',
      openaiChatUrl: 'https://api.example.com/chat',
      models: [{ id: 'gpt-5.4' }],
      defaultModel: 'gpt-5.4',
      boundBackendIds: ['codex'],
    };
    const adapted = prepareCodexProviderRuntime({
      provider,
      proxyOrigin: 'http://127.0.0.1:43210',
      proxyToken: 'tok_secret',
      baseEnv: {},
    });
    expect(adapted?.args).toEqual([
      '-c',
      'model_provider="hd_my-openai"',
      '-c',
      'model_providers.hd_my-openai.name="My OpenAI"',
      '-c',
      'model_providers.hd_my-openai.base_url="http://127.0.0.1:43210/p/my-openai/openai-responses"',
      '-c',
      'model_providers.hd_my-openai.wire_api="responses"',
      '-c',
      'model_providers.hd_my-openai.env_key="HARNESS_DECK_CODEX_API_KEY"',
      '-c',
      'model="gpt-5.4"',
    ]);
    expect(adapted?.env.HARNESS_DECK_CODEX_API_KEY).toBe('tok_secret');
  });

  it('为 Codex 构造 stdio 与 http MCP 服务器的 -c 参数', () => {
    const args = buildCodexMcpCliArgs([
      {
        id: '1',
        name: 'context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: { API_TOKEN: 'abc' },
        enabled: true,
        agents: ['codex'],
      },
      {
        id: '2',
        name: 'remote-docs',
        transport: 'http',
        url: 'https://docs.example.com/mcp',
        enabled: true,
        agents: ['codex'],
      },
    ]);
    expect(args).toContain('mcp_servers.context7.command="npx"');
    expect(args).toContain('mcp_servers.context7.args=["-y","@upstash/context7-mcp"]');
    expect(args).toContain('mcp_servers.context7.env.API_TOKEN="abc"');
    expect(args).toContain('mcp_servers.remote-docs.url="https://docs.example.com/mcp"');
  });

  it('非 ASCII 名称的 MCP 服务器自动回退到安全 id 避免名称碰撞', () => {
    const args = buildCodexMcpCliArgs([
      {
        id: 'doc-a',
        name: '本地文档',
        transport: 'http',
        url: 'https://a.example.com/mcp',
        enabled: true,
        agents: ['codex'],
      },
      {
        id: 'doc-b',
        name: '内部知识库',
        transport: 'http',
        url: 'https://b.example.com/mcp',
        enabled: true,
        agents: ['codex'],
      },
    ]);
    expect(args).toContain('mcp_servers.doc-a.url="https://a.example.com/mcp"');
    expect(args).toContain('mcp_servers.doc-b.url="https://b.example.com/mcp"');
  });

  it('绑定第三方服务商时模型列表与默认模型隔离旧的 OpenAI 选择', () => {
    const selectedCallbacks: Array<{ providerId: string; model: string }> = [];
    let bound: ProviderConfig | undefined = {
      id: 'custom-p',
      name: 'Custom Provider',
      openaiResponsesUrl: 'https://custom.example.com/v1',
      models: [{ id: 'custom-model', name: 'Custom Model' }],
      defaultModel: 'custom-model',
      boundBackendIds: ['codex'],
    };
    const controller = new CodexController({
      workspacePath: '/w',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      loadPreferredModel: () => ({ provider: 'openai', model: 'gpt-5.4' }),
      boundProvider: () => bound,
      onProviderModelSelected: (providerId, model) => selectedCallbacks.push({ providerId, model }),
      renderDelayMs: 0,
    });
    const boundState = controller.modelState();
    expect(boundState.options.map((o) => `${o.provider}:${o.model}`)).toEqual(['custom-p:custom-model']);
    expect(boundState.current).toEqual({ provider: 'custom-p', model: 'custom-model' });
    expect(selectedCallbacks).toContainEqual({ providerId: 'custom-p', model: 'custom-model' });

    // 解绑后不残留 custom-model
    bound = undefined;
    expect(controller.modelState().options).toEqual([]);
    controller.dispose();
  });
});

describe('UnattendedRunner 支持 Codex 定时无人值守任务', () => {
  it('启动隔离 Codex 进程、自动批准命令并回收 Markdown 输出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-codex-unattended-'));
    tempDirs.push(dir);
    const fakeCodex = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const runnerScript = join(dir, 'fake-codex.mjs');
    await writeFile(
      runnerScript,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'codex/0.125.0' } }) + '\\n');
  } else if (msg.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thr_bg_1' } } }) + '\\n');
  } else if (msg.method === 'turn/start') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn_bg_1', status: 'inProgress' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'thr_bg_1', turn: { id: 'turn_bg_1', status: 'inProgress' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ id: 'srv_1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr_bg_1', turnId: 'turn_bg_1', itemId: 'c1', command: 'ls' } }) + '\\n');
  } else if (msg.id === 'srv_1') {
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr_bg_1', turnId: 'turn_bg_1', itemId: 'm1', delta: '巡检完成：一切正常。' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_bg_1', turn: { id: 'turn_bg_1', status: 'completed' } } }) + '\\n');
  }
});
`,
      'utf8',
    );
    if (process.platform === 'win32') {
      await writeFile(fakeCodex, `@echo off\r\n"${process.execPath}" "${runnerScript}" %*\r\n`, 'utf8');
    } else {
      await writeFile(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${runnerScript}" "$@"\n`, 'utf8');
      await chmod(fakeCodex, 0o755);
    }

    const createdSessions: string[] = [];
    const runner = new UnattendedRunner({
      getActiveDshClient: () => undefined,
      getDshConfig: () => ({ configuredPath: '', profile: 'web', env: process.env }),
      getCodexConfig: () => ({ configuredPath: fakeCodex, env: process.env }),
      getEnvForProfile: () => process.env,
      extensionVersion: '0.7.0',
      log: () => undefined,
    });

    const outcome = await runner.run({
      profile: CODEX_PROFILE,
      projectPath: dir,
      prompt: '做一次每日巡检',
      permission: 'danger-full-access',
      onSessionCreated: (sid) => createdSessions.push(sid),
      timeoutMs: 10_000,
    });

    expect(outcome).toEqual({
      status: 'succeeded',
      sessionId: 'thr_bg_1',
      output: '巡检完成：一切正常。',
    });
    expect(createdSessions).toEqual(['thr_bg_1']);
  });
});

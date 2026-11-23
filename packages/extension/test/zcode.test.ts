import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview, Item, ProviderConfig } from '@harness-deck/shared';
import { UnattendedRunner } from '../src/hub/UnattendedRunner.ts';
import { setLocale } from '../src/i18n.ts';
import { prepareZcodeProviderRuntime } from '../src/providers/ProviderRuntime.ts';
import { ZcodeConnection, ZcodeError, type ZcodeLink } from '../src/zcode/connection.ts';
import { defaultRuntimePreferences, extractZcodeSessionId } from '../src/zcode/interactions.ts';
import { locateZcode } from '../src/zcode/locate.ts';
import { ZcodeSessionProjection } from '../src/zcode/projection.ts';
import { ZcodeController } from '../src/zcode/ZcodeController.ts';
import { ZCODE_PROFILE, npmPackageFor } from '../src/backend/profiles.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('ZCode 运行时查找（locateZcode）', () => {
  it('支持在 PATH 中查找 zcode 可执行文件，以及识别桌面端 zcode.cjs 脚本并用 node 启动', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-zcode-loc-'));
    tempDirs.push(dir);

    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const fakeNode = join(binDir, process.platform === 'win32' ? 'node.cmd' : 'node');
    await writeFile(fakeNode, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(fakeNode, 0o755);

    const scriptPath = join(dir, 'zcode.cjs');
    await writeFile(scriptPath, 'console.log("zcode");\n', 'utf8');

    const byScript = await locateZcode({
      configuredPath: scriptPath,
      env: { PATH: binDir },
      platform: process.platform,
    });
    expect(byScript).toEqual({
      kind: 'found',
      command: fakeNode,
      scriptArgs: [scriptPath],
      extraEnv: {},
      targetPath: scriptPath,
      source: 'setting',
    });

    const zcodeBin = join(binDir, process.platform === 'win32' ? 'zcode.cmd' : 'zcode');
    await writeFile(zcodeBin, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(zcodeBin, 0o755);

    const byPath = await locateZcode({
      env: { PATH: binDir },
      platform: process.platform,
    });
    expect(byPath).toEqual({
      kind: 'found',
      command: zcodeBin,
      scriptArgs: [],
      extraEnv: {},
      targetPath: zcodeBin,
      source: 'path',
    });

    expect(npmPackageFor('zcode')).toBe('zcode-app-cli');
  });
});

describe('ZCode NDJSON 连接（不含 jsonrpc 信封字段）', () => {
  it('双向请求、通知与反向请求应答均不附带 jsonrpc 字段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-zcode-conn-'));
    tempDirs.push(dir);
    const serverScript = join(dir, 'mock-zcode.mjs');
    await writeFile(
      serverScript,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if ('jsonrpc' in msg) {
    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'Unrecognized key: "jsonrpc"' } }) + '\\n');
    return;
  }
  if (msg.method === 'session/create') {
    // 发起反向请求 session/requestRuntimePreferences
    process.stdout.write(JSON.stringify({ id: 'srv-1', method: 'session/requestRuntimePreferences', params: {} }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessionId: 'sess_123' } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'session/event', params: { sessionId: 'sess_123', event: { type: 'session.titleUpdated', title: '测试会话' } } }) + '\\n');
    }, 15);
  }
});
`,
      'utf8',
    );

    const receivedNotifications: { method: string; params: unknown }[] = [];
    const reverseRequests: string[] = [];
    const outboundLines: string[] = [];

    const conn = new ZcodeConnection({
      command: process.execPath,
      args: [serverScript],
      cwd: dir,
      env: process.env,
      trace: (direction, line) => {
        if (direction === 'out') outboundLines.push(line);
      },
      onNotification: (method, params) => receivedNotifications.push({ method, params }),
      onRequest: async (method) => {
        reverseRequests.push(method);
        return { nativeSearchEnhancementsEnabled: true, memoryEnabled: true };
      },
      onExit: () => undefined,
    });

    await conn.start();
    const res = await conn.request<{ sessionId: string }>('session/create', {
      workspace: { workspacePath: dir, workspaceKey: dir },
    });
    expect(res.sessionId).toBe('sess_123');
    await new Promise((r) => setTimeout(r, 30));

    expect(reverseRequests).toEqual(['session/requestRuntimePreferences']);
    expect(receivedNotifications).toHaveLength(1);
    expect(outboundLines.length).toBeGreaterThanOrEqual(2);
    for (const line of outboundLines) {
      expect(JSON.parse(line)).not.toHaveProperty('jsonrpc');
    }

    await conn.dispose();
  });
});

describe('ZCode 会话投影与控制器', () => {
  it('实时流式输出（推理 + 正文）、浏览归并、文件修改 Diff、待办、子代理与目标状态', () => {
    setLocale('zh');
    const p = new ZcodeSessionProjection('/repo');
    p.addUserMessage('重构并运行测试');
    p.applyEvent({ type: 'turn.started', executionStartedAt: 1000 });
    p.applyEvent({
      type: 'model.streaming',
      delta: { reasoning_content: '先读一下入口文件。', content: '正在检查项目结构。' },
    });
    p.applyEvent({
      type: 'tool.updated',
      toolCallId: 'call_read',
      toolName: 'Read',
      status: 'success',
      input: { file_path: '/repo/src/index.ts' },
    });
    p.applyEvent({
      type: 'tool.updated',
      toolCallId: 'call_grep',
      toolName: 'Grep',
      status: 'success',
      input: { pattern: 'initApp' },
    });
    p.applyEvent({
      type: 'tool.updated',
      toolCallId: 'call_edit',
      toolName: 'Edit',
      status: 'success',
      input: {
        file_path: '/repo/src/index.ts',
        old_string: 'const debug = false;\n',
        new_string: 'const debug = true;\nexport { debug };\n',
      },
    });
    p.applyEvent({
      type: 'tool.updated',
      toolCallId: 'call_todo',
      toolName: 'TodoWrite',
      status: 'success',
      input: {
        todos: [
          { content: '修改 debug 导出', status: 'completed' },
          { content: '执行单元测试', status: 'in_progress' },
        ],
      },
    });
    p.applyEvent({
      type: 'tool.updated',
      toolCallId: 'call_sub',
      toolName: 'Task',
      status: 'success',
      input: { description: '验证类型检查' },
      output: '所有类型检查已通过',
    });
    p.applyEvent({
      type: 'goal.updated',
      goal: { objective: '完成全量测试收敛', phase: 'active', round: 2, maxRounds: 5 },
    });
    p.applyEvent({
      type: 'model.streaming',
      delta: { content: '已完成全部修改。' },
    });
    p.applyEvent({
      type: 'turn.completed',
      usage: { contextUsed: 12_000, contextWindow: 128_000 },
    }, 3200);

    const items = p.snapshotItems().filter((i) => i.kind !== 'turnDone');
    expect(items).toMatchObject([
      { kind: 'user', text: '重构并运行测试' },
      { kind: 'assistant', reasoning: '先读一下入口文件。', markdown: '正在检查项目结构。', streaming: false },
      { kind: 'explore', summary: '读取 1 个文件，搜索 1 次' },
      { kind: 'activity', variant: 'edit', tool: 'Edit', label: 'src/index.ts', stats: { additions: 2, deletions: 1 } },
      {
        kind: 'activity',
        variant: 'subagent',
        subagent: { state: 'done', prompt: '验证类型检查', result: '所有类型检查已通过' },
      },
      { kind: 'assistant', markdown: '已完成全部修改。', streaming: false },
    ]);
    expect(p.todos).toHaveLength(2);
    expect(p.goal).toEqual({ objective: '完成全量测试收敛', phase: 'active', round: 2, maxRounds: 5 });
    expect(p.usage).toEqual({ used: 12_000, size: 128_000 });
    expect(p.fileChanges()).toMatchObject([{ path: '/repo/src/index.ts', additions: 2, deletions: 1 }]);
  });

  it('兼容 ZCode Protocol v1 字符串 delta 流式帧、tool.updated kind 状态与嵌套快照', () => {
    setLocale('zh');
    expect(defaultRuntimePreferences(false)).toEqual({
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: true,
      askUserQuestionAutoResolutionEnabled: false,
      modelContextBudgetStrategy: 'preflight-v1',
    });
    expect(defaultRuntimePreferences(true).askUserQuestionAutoResolutionEnabled).toBe(true);
    expect(extractZcodeSessionId({ session: { sessionId: 'sess_v1' } })).toBe('sess_v1');
    expect(extractZcodeSessionId({ sessionId: 'sess_flat' })).toBe('sess_flat');

    const p = new ZcodeSessionProjection('/repo');
    p.applyMetadata({
      session: { title: '实时任务', mode: 'build' },
      projection: { contextUsed: 1_500, contextWindow: 200_000, mode: 'build', status: 'idle' },
    });
    expect(p.title).toBe('实时任务');
    expect(p.mode).toBe('build');
    expect(p.usage).toEqual({ used: 1_500, size: 200_000 });

    p.addUserMessage('检查状态');
    p.applyEvent({ type: 'turn.started', executionStartedAt: 1000 });
    p.applyEvent({ type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '思考中…' } });
    p.applyEvent({ type: 'model.streaming', payload: { kind: 'text_delta', delta: '开始检查' } });
    p.applyEvent({
      type: 'tool.updated',
      payload: { kind: 'scheduled', toolCallId: 'tc_bash', toolName: 'Bash', input: { command: 'git status' } },
    });
    p.applyEvent({
      type: 'tool.updated',
      payload: { kind: 'result', toolCallId: 'tc_bash', result: { stdout: 'clean' }, duration: 12 },
    });
    p.applyEvent({ type: 'turn.completed', payload: { resultType: 'success', response: '开始检查' } }, 2500);

    const items = p.snapshotItems().filter((i) => i.kind !== 'turnDone');
    expect(items).toMatchObject([
      { kind: 'user', text: '检查状态' },
      { kind: 'assistant', reasoning: '思考中…', markdown: '开始检查', streaming: false },
      { kind: 'activity', variant: 'command', tool: 'Bash', status: 'ok', output: 'clean' },
    ]);
  });

  it('控制器支持空闲逐出自动恢复（-32004 -> session/resume）、未保存文件审批保护、提问卡片与运行中插队（steer）', async () => {
    setLocale('zh');
    const posted: HostToWebview[] = [];
    const rpcCalls: { method: string; params: unknown }[] = [];
    let sendAttempt = 0;
    let dirtyList: string[] = [];

    const link: ZcodeLink = {
      request: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
        rpcCalls.push({ method, params });
        if (method === 'session/create') {
          return {
            session: { sessionId: 'sess_z1', mode: 'build' },
            projection: { contextUsed: 0, contextWindow: 200_000, mode: 'build', status: 'idle' },
          } as T;
        }
        if (method === 'session/subscribe') return { subscribed: true } as T;
        if (method === 'model/list') {
          return {
            models: [
              { providerId: 'zai', modelId: 'glm-5.3', name: 'GLM-5.3' },
              { providerId: 'zai', modelId: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
            ],
          } as T;
        }
        if (method === 'session/send') {
          sendAttempt++;
          if (sendAttempt === 1) {
            throw new ZcodeError('session/send', -32004, 'Session is not active');
          }
          return { ok: true } as T;
        }
        if (method === 'session/steer') return { ok: true } as T;
        return {} as T;
      },
      notify: () => undefined,
    };

    const controller = new ZcodeController({
      workspacePath: '/repo',
      post: (msg) => posted.push(msg),
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
        openDiff: async () => undefined,
        openFile: async () => undefined,
        readFile: async () => undefined,
        writeFile: async (path, content) => {
          await writeFile(path, content, 'utf8');
        },
        deleteFile: async () => undefined,
        dirtyFiles: () => dirtyList,
        saveAll: async () => {
          dirtyList = [];
        },
        confirm: async () => true,
        input: async () => undefined,
        activeEditor: () => undefined,
        findFiles: async () => [],
      },
      backends: () => ({ items: [{ id: 'zcode', name: 'ZCode', kind: 'zcode' }], active: 'zcode' }),
    });

    controller.setLink(link);
    await new Promise((r) => setTimeout(r, 15));

    // 1. 发送首条消息：触发 session/create -> session/subscribe（含 deliveryKind）-> session/send 遇到 -32004 -> 自动 session/resume + subscribe 并重试成功
    await controller.handle({ type: 'sendMessage', payload: { text: '你好 ZCode', includeActive: false } });
    expect(rpcCalls).toContainEqual({
      method: 'session/subscribe',
      params: { sessionId: 'sess_z1', deliveryKind: 'desktop-continuous' },
    });
    expect(rpcCalls.filter((c) => c.method === 'session/send')).toHaveLength(2);
    expect(rpcCalls.some((c) => c.method === 'session/resume')).toBe(true);

    // 2. 运行中收到新消息进入队列，点击插队调用 session/steer
    await controller.handle({ type: 'sendMessage', payload: { text: '顺便加个日志', includeActive: false } });
    const queuedSnap = controller.snapshot();
    const queuedItem = queuedSnap.items.find((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user' && i.pending === 'queued');
    expect(queuedItem?.queue?.itemId).toBeDefined();
    await controller.handle({ type: 'queueAction', payload: { action: 'steer', itemId: queuedItem!.queue!.itemId } });
    expect(rpcCalls).toContainEqual({ method: 'session/steer', params: { sessionId: 'sess_z1', content: '顺便加个日志' } });

    // 3. 审批请求：目标文件有未保存内容时拦截放行，保存后放行（严格遵循 ZCode V4 响应 schema）
    dirtyList = ['/repo/src/app.ts'];
    const suggestedRules = [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Edit' }] }];
    const permPromise = controller.onAgentRequest('interaction/requestPermission', {
      sessionId: 'sess_z1',
      toolCallId: 'tc_edit_1',
      toolName: 'Edit',
      input: { file_path: '/repo/src/app.ts' },
      reason: '修改应用入口',
      suggestedPermissionUpdates: suggestedRules,
    });
    const permSnap = controller.snapshot();
    expect(permSnap.interactions).toHaveLength(1);
    const permId = permSnap.interactions[0]!.id;

    // 未保存时点击 allow 被拦截
    await controller.handle({ type: 'respondApproval', payload: { id: permId, decision: 'allow' } });
    expect(controller.snapshot().interactions).toHaveLength(1);

    // 保存后点击 allowAlways 放行
    dirtyList = [];
    await controller.handle({ type: 'respondApproval', payload: { id: permId, decision: 'allowAlways' } });
    await expect(permPromise).resolves.toEqual({ decision: 'allow', permissionUpdates: suggestedRules });

    // 4. 提问卡片交互（interaction/requestUserInput，严格遵循 ZCode jLe 响应 schema）
    const questionPromise = controller.onAgentRequest('interaction/requestUserInput', {
      sessionId: 'sess_z1',
      requestId: 'req_q1',
      questions: [
        {
          id: 'db',
          question: '使用哪种数据库？',
          options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
        },
      ],
    });
    const qSnap = controller.snapshot();
    expect(qSnap.interactions[0]).toMatchObject({ kind: 'question' });
    await controller.handle({
      type: 'answerQuestion',
      payload: { id: qSnap.interactions[0]!.id, answers: [{ id: 'db', selected: ['SQLite'] }] },
    });
    await expect(questionPromise).resolves.toEqual({
      action: 'accept',
      content: { answer: 'SQLite', answers: { db: 'SQLite' } },
    });

    // 5. 反向请求 session/requestRuntimePreferences 返回合法 modelContextBudgetStrategy
    await expect(controller.onAgentRequest('session/requestRuntimePreferences', {})).resolves.toMatchObject({
      modelContextBudgetStrategy: 'preflight-v1',
    });

    controller.dispose();
  });

  it('UnattendedRunner 支持以无人值守模式运行 ZCode 定时任务', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-zcode-unattended-'));
    tempDirs.push(dir);
    const scriptPath = join(dir, 'fake-zcode.cjs');
    await writeFile(
      scriptPath,
      `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let pendingCreateId = null;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'session/create') {
    const ws = msg.params?.workspace;
    if (!ws || typeof ws.workspacePath !== 'string' || typeof ws.workspaceKey !== 'string' || 'path' in ws) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'invalid workspace payload' } }) + '\\n');
      return;
    }
    pendingCreateId = msg.id;
    process.stdout.write(JSON.stringify({ id: 'p1', method: 'session/requestRuntimePreferences', params: {} }) + '\\n');
  } else if (msg.id === 'p1' && msg.result) {
    const strategy = msg.result.modelContextBudgetStrategy;
    if (strategy !== 'legacy' && strategy !== 'preflight-v1') {
      process.stdout.write(JSON.stringify({ id: pendingCreateId, error: { code: -32602, message: 'invalid modelContextBudgetStrategy' } }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ id: pendingCreateId, result: { session: { sessionId: 'sess_cron_1' } } }) + '\\n');
  } else if (msg.method === 'session/subscribe') {
    if (msg.params?.deliveryKind !== 'desktop-continuous') {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'missing deliveryKind' } }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n');
  } else if (msg.method === 'session/setMode') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n');
  } else if (msg.method === 'session/send') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'session/event', params: { sessionId: 'sess_cron_1', event: { type: 'turn.started' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ id: 'perm1', method: 'interaction/requestPermission', params: { sessionId: 'sess_cron_1', toolName: 'Read', input: { path: 'README.md' } } }) + '\\n');
  } else if (msg.id === 'perm1' && msg.result) {
    process.stdout.write(JSON.stringify({ method: 'session/event', params: { sessionId: 'sess_cron_1', event: { type: 'model.streaming', payload: { kind: 'text_delta', delta: '巡检报告：一切正常。' } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'session/event', params: { sessionId: 'sess_cron_1', event: { type: 'turn.completed', payload: { resultType: 'success' } } } }) + '\\n');
  }
});
`,
      'utf8',
    );

    const hiddenIds: string[] = [];
    const runner = new UnattendedRunner({
      getActiveDshClient: () => undefined,
      getDshConfig: () => ({ configuredPath: '', profile: 'web', env: process.env }),
      getZcodeConfig: () => ({ configuredPath: scriptPath, env: process.env }),
      getEnvForProfile: () => process.env,
      extensionVersion: '0.4.0',
      log: () => undefined,
    });

    const outcome = await runner.run({
      profile: ZCODE_PROFILE,
      projectPath: dir,
      prompt: '执行健康巡检',
      permission: 'read-only',
      onSessionCreated: (id) => hiddenIds.push(id),
    });

    expect(outcome).toEqual({
      status: 'succeeded',
      sessionId: 'sess_cron_1',
      output: '巡检报告：一切正常。',
    });
    expect(hiddenIds).toEqual(['sess_cron_1']);
  });

  it('绑定自定义服务商时生成 ZCode provider_config.json（schemaVersion=1）并注入 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-zcode-provider-'));
    tempDirs.push(dir);
    const provider: ProviderConfig = {
      id: 'aco',
      name: 'ACO',
      openaiChatUrl: 'https://api.example.com/v1',
      models: [{ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', contextWindow: '128k', maxOutputTokens: '16k' }],
      defaultModel: 'GLM-5.3-Flash',
      boundBackendIds: ['zcode'],
    };

    const patch = await prepareZcodeProviderRuntime({
      provider,
      proxyOrigin: 'http://127.0.0.1:43123',
      proxyToken: 'local-proxy-token-only',
      storageDir: dir,
      baseEnv: {},
    });

    expect(patch).toBeTruthy();
    const configPath = patch?.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    expect(configPath).toBeTruthy();
    expect(patch?.env.NO_PROXY).toContain('127.0.0.1');

    const raw = await readFile(configPath!, 'utf8');
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      config: {
        providerConfigRules: { providerRules: Array<{ providerId: string; config: { api: { type: string; baseUrl: string }; access: { apiKey: string }; personalModelIds: string[] } }> };
        modelConfigRules: { providerModelRules: Array<{ providerId: string; modelId: string }> };
        defaultModelSelection: { providerId: string; modelId: string };
      };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.config.providerConfigRules.providerRules[0]).toMatchObject({
      providerId: 'aco',
      config: {
        access: { apiKey: 'local-proxy-token-only' },
        api: {
          type: 'openai-chat-completions',
          baseUrl: 'http://127.0.0.1:43123/p/aco/openai-chat',
        },
        personalModelIds: ['GLM-5.3-Flash'],
      },
    });
    expect(parsed.config.modelConfigRules.providerModelRules[0]).toMatchObject({
      providerId: 'aco',
      modelId: 'GLM-5.3-Flash',
    });
    expect(parsed.config.defaultModelSelection).toEqual({
      providerId: 'aco',
      modelId: 'GLM-5.3-Flash',
    });
  });

  it('ZcodeController 从 session/create 解析 settings.model.available 并在 session/send 时自动补齐 reasoningLevel', async () => {
    const sentRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const link: ZcodeLink = {
      request: async <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        sentRequests.push({ method, params });
        if (method === 'session/create') {
          return {
            session: { sessionId: 'sess_custom_1', model: { providerId: 'aco', modelId: 'GLM-5.3-Flash' } },
            settings: {
              model: {
                available: [
                  {
                    ref: { providerId: 'aco', modelId: 'GLM-5.3-Flash' },
                    label: 'GLM-5.3-Flash',
                    providerLabel: 'ACO',
                    reasoning: {
                      levels: [
                        { value: 'low', label: 'low' },
                        { value: 'high', label: 'high' },
                        { value: 'max', label: 'max' },
                      ],
                      defaultLevel: 'max',
                    },
                  },
                ],
              },
            },
          } as T;
        }
        return { ok: true } as T;
      },
      notify: () => undefined,
    };

    const provider: ProviderConfig = {
      id: 'aco',
      name: 'ACO',
      openaiChatUrl: 'https://api.example.com/v1',
      models: [{ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }],
      defaultModel: 'GLM-5.3-Flash',
      boundBackendIds: ['zcode'],
    };

    const controller = new ZcodeController({
      workspacePath: '/tmp/ws',
      workbench: {
        activeEditor: () => undefined,
        dirtyFiles: () => [],
        openFile: async () => undefined,
        openDiff: async () => undefined,
        readFile: async () => undefined,
        writeFile: async () => undefined,
        deleteFile: async () => undefined,
        saveAll: async () => undefined,
        confirm: async () => true,
        input: async () => undefined,
        findFiles: async () => [],
      },
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      loadPreferredModel: () => ({ provider: 'aco', model: 'GLM-5.3-Flash' }),
      savePreferredModel: () => undefined,
      loadOpenTabs: () => [],
      saveOpenTabs: () => undefined,
      boundProvider: () => provider,
      backends: () => ({ items: [{ id: 'zcode', name: 'ZCode', kind: 'zcode' }], active: 'zcode' }),
    });
    controller.setLink(link);

    await controller.send('你好');

    const sendCall = sentRequests.find((r) => r.method === 'session/send');
    expect(sendCall?.params.modelSelection).toEqual({
      providerId: 'aco',
      modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'max' },
    });

    const snap = controller.snapshot();
    expect(snap.models.options).toHaveLength(1);
    expect(snap.models.options[0]).toMatchObject({
      provider: 'aco',
      model: 'GLM-5.3-Flash',
      defaultEffort: 'max',
    });

    controller.dispose();
  });
});

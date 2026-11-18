import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview, Item } from '@harness-deck/shared';
import { npmPackageFor, PI_PROFILE } from '../src/backend/profiles.ts';
import { prepareBackendLaunch } from '../src/extensions/mcpService.ts';
import { UnattendedRunner } from '../src/hub/UnattendedRunner.ts';
import { setLocale } from '../src/i18n.ts';
import { type PiLink } from '../src/pi/connection.ts';
import { locatePi } from '../src/pi/locate.ts';
import { PiController } from '../src/pi/PiController.ts';
import { PiSessionProjection } from '../src/pi/projection.ts';
import { readPiSessionMessagesFromDisk, scanPiSessions } from '../src/pi/sessions.ts';
import { preparePiProviderRuntime } from '../src/providers/ProviderRuntime.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('Pi 原生接入（pi --mode rpc）', () => {
  it('内置配置为原生 kind=pi，支持在 PATH 查找 pi 命令及准备 models.json 服务商代理配置', async () => {
    expect(PI_PROFILE).toEqual({ id: 'pi', kind: 'pi', name: 'Pi' });
    expect(npmPackageFor('pi')).toBe('@earendil-works/pi-coding-agent');

    const dir = await mkdtemp(join(tmpdir(), 'hd-pi-loc-'));
    tempDirs.push(dir);
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const fakePi = join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
    await writeFile(fakePi, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') await chmod(fakePi, 0o755);

    const located = await locatePi({ env: { PATH: binDir }, platform: process.platform });
    expect(located).toEqual({ kind: 'found', command: fakePi, source: 'path' });

    // 验证 preparePiProviderRuntime 生成标准 models.json 且仅含本地代理地址与一次性令牌
    const adapted = await preparePiProviderRuntime({
      provider: {
        id: 'glm-plan',
        name: '智谱 GLM',
        openaiChatUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        models: [{ id: 'glm-5', name: 'GLM-5', contextWindow: '200k', maxOutputTokens: '64k', efforts: ['low', 'high'], vision: true }],
        defaultModel: 'glm-5',
        boundBackendIds: ['pi'],
      },
      proxyOrigin: 'http://127.0.0.1:45555',
      proxyToken: 'sk-local-pi-token',
      storageDir: dir,
      baseEnv: { PATH: binDir },
    });
    expect(adapted?.args).toEqual(['--provider', 'glm-plan', '--model', 'glm-5']);
    const modelsJsonText = await readFile(join(adapted!.env.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8');
    const modelsJson = JSON.parse(modelsJsonText) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: { id: string; reasoning?: boolean }[] }>;
    };
    expect(modelsJson.providers['glm-plan']).toMatchObject({
      baseUrl: 'http://127.0.0.1:45555/p/glm-plan/openai-chat',
      api: 'openai-completions',
      apiKey: 'sk-local-pi-token',
    });
    expect(modelsJson.providers['glm-plan']?.models[0]?.reasoning).toBe(true);

    // 验证 prepareBackendLaunch 对 kind='pi' 自动生成 --skill 参数
    const skillDir = join(dir, 'skills', 'installed', 'perf-audit');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: perf-audit\ndescription: Perf\n---\nBody', 'utf8');
    const launchPrepared = await prepareBackendLaunch({
      storageRoot: dir,
      profile: PI_PROFILE,
      skills: [
        {
          id: 'perf-audit',
          name: 'perf-audit',
          description: 'Perf',
          repoUrl: 'https://github.com/org/repo.git',
          skillMdPath: join(skillDir, 'SKILL.md'),
          enabled: true,
          installedAt: 1,
          updatedAt: 1,
        },
      ],
      mcpServers: [],
    });
    expect(launchPrepared.extraArgs[0]).toBe('--skill');
  });

  it('投影 message_update 思考与正文增量、find/read 浏览合并、edit oldText/newText 改动统计及 get_messages 快照', () => {
    setLocale('zh');
    const p = new PiSessionProjection('/repo');
    p.setContextWindow(128_000);
    p.addUserMessage('优化日志模块');
    p.startTurn(1_000);

    p.applyEvent({ type: 'agent_start' }, 1_000);
    p.applyEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: '先查找日志文件。' },
    });
    p.applyEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '正在读取并重构日志模块。' },
    });
    p.applyEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: { input: 1_500, output: 300, cacheRead: 200 },
        content: [
          { type: 'thinking', thinking: '先查找日志文件。' },
          { type: 'text', text: '正在读取并重构日志模块。' },
        ],
      },
    });

    // find + read 归并为 explore
    p.applyEvent({ type: 'tool_execution_start', toolCallId: 'tc_find', toolName: 'find', args: { pattern: '*.ts' } });
    p.applyEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc_find',
      toolName: 'find',
      result: { content: [{ type: 'text', text: 'src/logger.ts' }] },
      isError: false,
    });
    p.applyEvent({ type: 'tool_execution_start', toolCallId: 'tc_read', toolName: 'read', args: { path: 'src/logger.ts' } });
    p.applyEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc_read',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'console.log("old");' }] },
      isError: false,
    });

    // edit (oldText / newText) + bash 流式输出
    p.applyEvent({
      type: 'tool_execution_start',
      toolCallId: 'tc_edit',
      toolName: 'edit',
      args: { path: '/repo/src/logger.ts', oldText: 'console.log("old");', newText: 'logger.info("ready");\nlogger.flush();' },
    });
    p.applyEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc_edit',
      toolName: 'edit',
      result: { content: [{ type: 'text', text: 'Edited' }] },
      isError: false,
    });
    p.applyEvent({ type: 'tool_execution_start', toolCallId: 'tc_bash', toolName: 'bash', args: { command: 'pnpm test' } });
    p.applyEvent({
      type: 'tool_execution_update',
      toolCallId: 'tc_bash',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'running...' }] },
    });
    p.applyEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc_bash',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '12 passed' }] },
      isError: false,
    });
    p.applyEvent({ type: 'agent_end' }, 2_600);

    expect(p.snapshotItems()).toMatchObject([
      { kind: 'user', text: '优化日志模块' },
      { kind: 'assistant', markdown: '正在读取并重构日志模块。', reasoning: '先查找日志文件。', streaming: false },
      { kind: 'explore', status: 'ok', entries: [{ label: 'find  *.ts' }, { label: 'read  src/logger.ts' }] },
      { kind: 'activity', variant: 'edit', label: 'src/logger.ts', status: 'ok', stats: { additions: 2, deletions: 1 } },
      { kind: 'activity', variant: 'command', label: 'bash  pnpm test', status: 'ok', output: '12 passed' },
      { kind: 'turnDone', completed: true, durationMs: 1_600 },
    ]);
    expect(p.usage).toEqual({ used: 2_000, size: 128_000 });
    expect(p.fileChanges()).toHaveLength(1);
  });

  it('扫描并解析 ~/.pi/agent/sessions 树状 JSONL 会话文件（沿 parentId 还原当前活跃分支）', async () => {
    const piDir = await mkdtemp(join(tmpdir(), 'hd-pi-sess-'));
    tempDirs.push(piDir);
    const ws = '/workspace/pi-demo';
    const subDir = join(piDir, 'sessions', '--workspace-pi-demo--');
    await mkdir(subDir, { recursive: true });
    const sessionFile = join(subDir, '2026-11-18_s1.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'pi-sess-1', cwd: ws }),
      JSON.stringify({ id: 'n1', parentId: null, type: 'message', message: { role: 'user', content: '第一问' } }),
      // 被放弃的旧分支 n2
      JSON.stringify({
        id: 'n2',
        parentId: 'n1',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: '旧分支回复' }] },
      }),
      // 当前活跃分支 n3
      JSON.stringify({
        id: 'n3',
        parentId: 'n1',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: '新分支回复' }] },
      }),
      JSON.stringify({ id: 'n4', parentId: 'n3', type: 'session_info', name: '分支重构会话' }),
    ];
    await writeFile(sessionFile, `${lines.join('\n')}\n`, 'utf8');

    const scanned = await scanPiSessions(ws, piDir);
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({ id: 'pi-sess-1', cwd: ws, title: '分支重构会话', sessionPath: sessionFile });

    const branchMsgs = await readPiSessionMessagesFromDisk(sessionFile);
    expect(branchMsgs).toHaveLength(2);
    const p = new PiSessionProjection(ws);
    p.applyMessagesSnapshot(branchMsgs);
    expect(p.snapshotItems()).toMatchObject([
      { kind: 'user', text: '第一问' },
      { kind: 'assistant', markdown: '新分支回复', streaming: false },
    ]);
  });

  it('PiController 支持 new_session、prompt、运行中 steer 插队、extension_ui_request 审批/提问及模型档位切换', async () => {
    setLocale('zh');
    const posted: HostToWebview[] = [];
    const calls: { readonly cmd: string; readonly params?: Record<string, unknown> }[] = [];

    const fakeLink: PiLink = {
      running: true,
      request: async <T,>(cmd: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push({ cmd, ...(params ? { params } : {}) });
        if (cmd === 'get_available_models') {
          return {
            models: [{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true }],
          } as T;
        }
        if (cmd === 'get_commands') {
          return { commands: [{ name: 'compact', description: 'Compact context', source: 'extension' }] } as T;
        }
        if (cmd === 'new_session') return { cancelled: false } as T;
        if (cmd === 'get_state') {
          return { sessionId: 'pi-live-1', sessionFile: '/tmp/pi-live-1.jsonl' } as T;
        }
        return {} as T;
      },
      sendUiResponse: () => undefined,
      dispose: async () => undefined,
    };

    const controller = new PiController({
      workspacePath: '/repo',
      renderDelayMs: 0,
      post: (msg) => posted.push(msg),
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
    });

    controller.setLink(fakeLink, { sessionId: 'boot-empty' });
    await new Promise((r) => setTimeout(r, 10));

    // 发送首条消息：自动 new_session -> prompt
    await controller.handle({ type: 'sendMessage', payload: { text: '分析模块依赖' } });
    expect(calls.some((c) => c.cmd === 'new_session')).toBe(true);
    expect(calls.some((c) => c.cmd === 'prompt')).toBe(true);

    // 运行中再发一条进入队列，点插队触发原生 steer 命令
    await controller.handle({ type: 'sendMessage', payload: { text: '顺便检查循环依赖' } });
    const queuedItem = controller
      .snapshot()
      .items.find((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user' && i.pending === 'queued');
    expect(queuedItem?.queue?.itemId).toBeTruthy();
    await controller.handle({ type: 'queueAction', payload: { action: 'steer', itemId: queuedItem!.queue!.itemId } });
    expect(calls.find((c) => c.cmd === 'steer')?.params).toMatchObject({ message: '顺便检查循环依赖' });

    // Extension UI confirm 请求 -> ApprovalCard 批准
    const uiConfirm = controller.onUiRequest({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'confirm',
      title: 'Deploy Extension',
      message: 'Allow deployment dry-run?',
    });
    const snapConfirm = controller.snapshot();
    expect(snapConfirm.interactions[0]).toMatchObject({ kind: 'approval', toolName: 'Deploy Extension' });
    await controller.handle({
      type: 'respondApproval',
      payload: { id: snapConfirm.interactions[0]!.id, decision: 'allow' },
    });
    await expect(uiConfirm).resolves.toEqual({ confirmed: true });

    // 切换模型与思考档位 -> set_model + set_thinking_level
    await controller.handle({
      type: 'selectModel',
      payload: { provider: 'anthropic', model: 'claude-sonnet-4-6', reasoningEffort: 'high' },
    });
    expect([...calls].reverse().find((c) => c.cmd === 'set_model')?.params).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect([...calls].reverse().find((c) => c.cmd === 'set_thinking_level')?.params).toEqual({ level: 'high' });

    controller.onEvent({ type: 'agent_end' });
    controller.dispose();
  });

  it('PiConnection 与 UnattendedRunner 通过真实 pi --mode rpc 子进程双向跑通无人值守任务', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'hd-pi-proc-'));
    tempDirs.push(dir);
    const fakePi = join(dir, 'pi');
    const mockScript = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] !== '--mode' || process.argv[3] !== 'rpc') {
  process.stderr.write('expected --mode rpc\\n');
  process.exit(2);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let confirmDone = false;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'get_state') {
    send({ id: msg.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-bg-77' } });
    return;
  }
  if (msg.type === 'prompt') {
    send({ id: msg.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'extension_ui_request', id: 'ui_c1', method: 'confirm', title: 'Guard', message: 'Proceed?' });
    return;
  }
  if (msg.type === 'extension_ui_response' && !confirmDone) {
    confirmDone = true;
    const text = msg.confirmed ? 'Pi 定时巡检通过。' : '未确认跳过。';
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    send({ type: 'agent_end' });
  }
});
`;
    await writeFile(fakePi, mockScript, 'utf8');
    await chmod(fakePi, 0o755);

    const hiddenIds: string[] = [];
    const runner = new UnattendedRunner({
      getActiveDshClient: () => undefined,
      getDshConfig: () => ({ configuredPath: '', profile: 'web', env: {} }),
      getPiConfig: () => ({ configuredPath: fakePi, env: process.env }),
      getEnvForProfile: () => process.env,
      extensionVersion: '0.4.0',
      log: () => undefined,
    });

    const outcome = await runner.run({
      profile: PI_PROFILE,
      projectPath: dir,
      prompt: '每日代码巡检',
      permission: 'danger-full-access',
      onSessionCreated: (sid) => hiddenIds.push(sid),
    });

    expect(hiddenIds).toEqual(['pi-bg-77']);
    expect(outcome).toEqual({
      status: 'succeeded',
      sessionId: 'pi-bg-77',
      output: 'Pi 定时巡检通过。',
    });
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '@harness-deck/shared';
import { CodebuddyController, type CodebuddySpawnSessionParams } from '../src/codebuddy/CodebuddyController.ts';
import { buildCodebuddyArgs, type CodebuddyLink } from '../src/codebuddy/connection.ts';
import { CodebuddyInteractionManager } from '../src/codebuddy/interactions.ts';
import {
  cleanCodebuddyCommandOutput,
  CodebuddySessionProjection,
  extractCodebuddyDiffs,
} from '../src/codebuddy/projection.ts';
import {
  encodeCodebuddyProjectDir,
  findCodebuddySessionFile,
  readCodebuddySessionEvents,
  scanCodebuddySessions,
} from '../src/codebuddy/sessions.ts';
import { prepareCodebuddyProviderRuntime } from '../src/providers/ProviderRuntime.ts';
import { prepareBackendLaunch } from '../src/extensions/mcpService.ts';
import { CODEBUDDY_PROFILE } from '../src/backend/profiles.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

class FakeCodebuddyLink implements CodebuddyLink {
  running = true;
  readonly sentMessages: { readonly content: unknown; readonly sessionId?: string }[] = [];
  readonly controlRequests: Record<string, unknown>[] = [];
  disposed = false;

  constructor(private readonly params: CodebuddySpawnSessionParams) {}

  sendUserMessage(content: string | readonly Record<string, unknown>[], sessionId?: string): void {
    this.sentMessages.push({ content, ...(sessionId !== undefined ? { sessionId } : {}) });
  }

  async sendControlRequest<T = unknown>(request: Record<string, unknown>): Promise<T> {
    this.controlRequests.push(request);
    if (request.subtype === 'initialize') {
      return {
        models: [
          { id: 'default-model', name: 'Auto' },
          { id: 'fast-model', name: 'Fast' },
        ],
        currentModelId: 'default-model',
        commands: [{ name: '/compact', description: 'Compact context' }],
      } as T;
    }
    return {} as T;
  }

  emit(event: Record<string, unknown>): void {
    this.params.onEvent(event);
  }

  ask(requestId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.params.onControlRequest(requestId, request);
  }

  async dispose(): Promise<void> {
    this.running = false;
    this.disposed = true;
  }
}

describe('CodeBuddy 原生参数与命令输出清洗', () => {
  it('buildCodebuddyArgs 构造流式 JSON 参数且不传不支持的 --permission-prompt-tool', () => {
    const args = buildCodebuddyArgs({
      resumeSessionId: 'sid-123',
      model: 'fast-model',
      effort: 'high',
      permissionMode: 'acceptEdits',
      extraArgs: ['--add-dir', '/tmp/skills'],
    });
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--resume',
      'sid-123',
      '--model',
      'fast-model',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
      '--add-dir',
      '/tmp/skills',
    ]);
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('cleanCodebuddyCommandOutput 清洗 Stdout/Stderr/Exit Code 封装格式', () => {
    expect(cleanCodebuddyCommandOutput('Stdout: hello_world\n\nStderr: (empty)\nExit Code: 0\nSignal: (none)')).toBe('hello_world');
    expect(cleanCodebuddyCommandOutput('Stdout: (empty)\n\nStderr: boom\nExit Code: 1\nSignal: (none)')).toBe('boom\nexit 1');
  });
});

describe('CodebuddyInteractionManager（can_use_tool 协议）', () => {
  it('使用 CodeBuddy 原生 allowed 布尔载荷应答允许、始终允许与拒绝，并拦截未保存文件', async () => {
    let dirty: string[] = [];
    const mgr = new CodebuddyInteractionManager(() => '/ws', () => dirty, () => undefined);

    // 1. 允许本次
    const p1 = mgr.handleControlRequest('s1', {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'echo hi' },
    });
    const views1 = mgr.viewsFor('s1');
    expect(views1).toHaveLength(1);
    expect(mgr.respondApproval(views1[0]!.id, 'allow')).toEqual({ ok: true });
    expect(await p1).toEqual({ allowed: true, updatedInput: { command: 'echo hi' } });

    // 2. 拒绝
    const p2 = mgr.handleControlRequest('s1', {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'rm -rf tmp' },
    });
    const views2 = mgr.viewsFor('s1');
    expect(mgr.respondApproval(views2[0]!.id, 'reject')).toEqual({ ok: true });
    expect(await p2).toEqual({ allowed: false, message: 'Rejected by user' });

    // 3. 未保存文件拦截 & 始终允许
    dirty = ['/ws/app.ts'];
    const p3 = mgr.handleControlRequest('s1', {
      subtype: 'can_use_tool',
      tool_name: 'Edit',
      input: { file_path: '/ws/app.ts', old_string: 'a', new_string: 'b' },
    });
    const views3 = mgr.viewsFor('s1');
    expect(mgr.respondApproval(views3[0]!.id, 'allowAlways').ok).toBe(false);
    dirty = [];
    expect(mgr.respondApproval(views3[0]!.id, 'allowAlways')).toEqual({ ok: true });
    expect(await p3).toEqual({
      allowed: true,
      updatedInput: { file_path: '/ws/app.ts', old_string: 'a', new_string: 'b' },
    });

    // 同会话再次调用 Edit 自动放行
    const auto = await mgr.handleControlRequest('s1', {
      subtype: 'can_use_tool',
      tool_name: 'Edit',
      input: { file_path: '/ws/other.ts', old_string: 'x', new_string: 'y' },
    });
    expect(auto).toEqual({
      allowed: true,
      updatedInput: { file_path: '/ws/other.ts', old_string: 'x', new_string: 'y' },
    });
  });
});

describe('CodebuddySessionProjection（实时流 + JSONL 历史回放）', () => {
  it('实时流式文本、命令清洗、Edit Diff、TaskCreate/TaskUpdate 待办与中断保护', () => {
    const proj = new CodebuddySessionProjection('/ws');
    proj.addUserMessage('帮我改一下');
    proj.startTurn(1_000);

    proj.applyEvent({
      type: 'stream_event',
      session_id: 'cb-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '正在处理' } },
    });
    proj.applyEvent({
      type: 'assistant',
      session_id: 'cb-1',
      message: {
        id: 'm1',
        model: 'fast-model',
        content: [
          { type: 'text', text: '正在处理' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/ws/a.ts', old_string: 'a', new_string: 'b\nc' } },
        ],
      },
    });
    proj.applyEvent({
      type: 'user',
      session_id: 'cb-1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Successfully edited file' }], is_error: false }],
      },
    });
    proj.applyEvent({
      type: 'assistant',
      session_id: 'cb-1',
      message: {
        id: 'm2',
        content: [
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo ok' } },
          { type: 'tool_use', id: 't3', name: 'TaskCreate', input: { subject: '步骤一' } },
        ],
      },
    });
    proj.applyEvent({
      type: 'user',
      session_id: 'cb-1',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: 'Stdout: ok\n\nStderr: (empty)\nExit Code: 0\nSignal: (none)' }],
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 't3',
            content: [{ type: 'text', text: 'Task #1 created' }],
            is_error: false,
            _meta: { rawResponse: { todos: [{ id: '1', content: '步骤一', status: 'in_progress' }] } },
          },
        ],
      },
    });
    proj.applyEvent({ type: 'result', subtype: 'success', is_error: false, session_id: 'cb-1' }, 2_500);

    // 结束后滞后的 "Interrupted by user" 应被忽略
    proj.applyEvent({
      type: 'assistant',
      session_id: 'cb-1',
      message: { id: 'm3', content: [{ type: 'text', text: 'Interrupted by user' }] },
    });

    const items = proj.snapshotItems();
    expect(items.some((i) => i.kind === 'assistant' && i.markdown === '正在处理')).toBe(true);
    expect(items.some((i) => i.kind === 'assistant' && i.markdown.includes('Interrupted by user'))).toBe(false);
    expect(items.find((i) => i.kind === 'activity' && i.variant === 'edit')).toMatchObject({
      label: 'a.ts',
      status: 'ok',
      stats: { additions: 2, deletions: 1 },
    });
    expect(items.find((i) => i.kind === 'activity' && i.variant === 'command')).toMatchObject({
      status: 'ok',
      output: 'ok',
    });
    // TaskCreate 不生成普通工具行，只同步到 todos
    expect(items.some((i) => i.kind === 'activity' && i.tool === 'TaskCreate')).toBe(false);
    expect(proj.todos).toEqual([{ content: '步骤一', status: 'in_progress' }]);
    expect(extractCodebuddyDiffs('Write', { file_path: '/ws/n.txt', content: 'hi' })).toEqual([
      { path: '/ws/n.txt', oldText: null, newText: 'hi' },
    ]);
  });

  it('回放 CodeBuddy 原生 JSONL 历史记录（message / function_call / function_call_result）', () => {
    const proj = new CodebuddySessionProjection('/ws');
    proj.applyHistoryRecords([
      {
        type: 'message',
        role: 'user',
        sessionId: 'cb-hist',
        cwd: '/ws',
        content: [{ type: 'input_text', text: '查看 README' }],
        providerData: { startsNewUserRequest: true },
      },
      {
        type: 'message',
        role: 'user',
        sessionId: 'cb-hist',
        content: [{ type: 'input_text', text: '<system-reminder>meta</system-reminder>' }],
        providerData: { isMeta: true },
      },
      {
        type: 'function_call',
        callId: 'c1',
        name: 'Read',
        arguments: JSON.stringify({ file_path: '/ws/README.md' }),
        providerData: { model: 'fast-model' },
      },
      {
        type: 'function_call_result',
        callId: 'c1',
        name: 'Read',
        status: 'completed',
        output: { type: 'text', text: '1-># hi' },
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '已读取完成。' }],
        providerData: { model: 'fast-model' },
      },
    ]);

    const items = proj.snapshotItems();
    expect(items).toMatchObject([
      { kind: 'user', text: '查看 README' },
      { kind: 'explore', status: 'ok', entries: [{ id: 'c1', status: 'ok' }] },
      { kind: 'assistant', markdown: '已读取完成。', streaming: false },
    ]);
    expect(proj.model).toBe('fast-model');
  });
});

describe('CodeBuddy 本地会话扫描与读取', () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('按实测目录编码规则扫描并读取 ~/.codebuddy/projects/<dir>/<id>.jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-cb-sess-'));
    temps.push(root);
    const ws = '/tmp/My_Proj.v2';
    const encoded = encodeCodebuddyProjectDir(ws);
    expect(encoded).toBe('tmp-My_Proj.v2');

    const projDir = join(root, 'projects', encoded);
    await mkdir(projDir, { recursive: true });
    const sessionFile = join(projDir, 'sess-001.jsonl');
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'message',
          role: 'user',
          sessionId: 'sess-001',
          cwd: ws,
          timestamp: 1_700_000_000_000,
          content: [{ type: 'input_text', text: '重构模块' }],
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          sessionId: 'sess-001',
          cwd: ws,
          timestamp: 1_700_000_001_000,
          content: [{ type: 'output_text', text: '好的' }],
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const list = await scanCodebuddySessions(ws, root);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'sess-001', cwd: ws, title: '重构模块' });
    expect(await findCodebuddySessionFile('sess-001', ws, root)).toBe(sessionFile);
    expect(await readCodebuddySessionEvents(sessionFile)).toHaveLength(2);
  });
});

describe('CodebuddyController 多标签并发会话', () => {
  it('允许两个会话同时运行且互不阻塞、各自独立维护流式状态', async () => {
    const posted: HostToWebview[] = [];
    const spawned: FakeCodebuddyLink[] = [];
    let activeSaved: string | undefined;
    let storedSessions: { id: string; title: string; updatedAt: number }[] = [];

    const controller = new CodebuddyController({
      workspacePath: '/ws',
      post: (msg) => posted.push(msg),
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => activeSaved,
      saveActiveSessionId: (id) => {
        activeSaved = id;
      },
      loadSessions: () => storedSessions,
      saveSessions: (list) => {
        storedSessions = [...list];
      },
      codebuddyConfigDir: () => '/nonexistent-codebuddy-dir',
      renderDelayMs: 0,
    });

    controller.setSpawner(async (params) => {
      const link = new FakeCodebuddyLink(params);
      spawned.push(link);
      return link;
    });

    // 会话 1 开始发送（保持运行中，不发 result）
    expect(await controller.send('任务一')).toBe(true);
    expect(spawned).toHaveLength(1);
    const link1 = spawned[0]!;
    link1.emit({ type: 'system', subtype: 'init', session_id: 'cb-s1' });
    link1.emit({
      type: 'stream_event',
      session_id: 'cb-s1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '正在做任务一' } },
    });

    // 会话 1 运行中，直接新开标签并发送会话 2
    await controller.handle({ type: 'newSession', payload: {} });
    expect(await controller.send('任务二')).toBe(true);
    expect(spawned).toHaveLength(2);
    const link2 = spawned[1]!;
    link2.emit({ type: 'system', subtype: 'init', session_id: 'cb-s2' });
    link2.emit({
      type: 'stream_event',
      session_id: 'cb-s2',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '任务二结果' } },
    });
    link2.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'cb-s2' });

    // 验证会话 2 已结束，而会话 1 仍在独立运行，且没有任何单会话阻止提示
    const snap2 = controller.snapshot();
    expect(snap2.session.id).toBe('cb-s2');
    expect(snap2.session.running).toBe(false);
    expect(snap2.tabs.items).toHaveLength(2);
    expect(snap2.tabs.items.find((tab) => tab.sessionId === 'cb-s1')?.running).toBe(true);
    expect(posted.some((m) => m.type === 'toast' && m.payload.text.includes('同一时间只能进行一个会话'))).toBe(false);

    // 结束会话 1 并切回验证内容完整
    link1.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'cb-s1' });
    const tab1 = snap2.tabs.items.find((tab) => tab.sessionId === 'cb-s1')!;
    await controller.handle({ type: 'activateTab', payload: { key: tab1.key } });
    const snap1 = controller.snapshot();
    expect(snap1.session.id).toBe('cb-s1');
    expect(snap1.session.running).toBe(false);
    expect(snap1.items.some((i) => i.kind === 'assistant' && i.markdown === '正在做任务一')).toBe(true);
    expect(link1.disposed).toBe(false);
    expect(link2.disposed).toBe(false);

    controller.dispose();
  });

  it('bypassPermissions 模式下仍将 ask_user_question / ExitPlanMode 交给交互卡片处理', async () => {
    const spawned: FakeCodebuddyLink[] = [];
    const controller = new CodebuddyController({
      workspacePath: '/ws',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      workbench: {
        ...noWorkbench,
        confirm: async () => true,
      },
      codebuddyConfigDir: () => '/nonexistent-codebuddy-dir',
      renderDelayMs: 0,
    });
    controller.setSpawner(async (params) => {
      const link = new FakeCodebuddyLink(params);
      spawned.push(link);
      return link;
    });

    await controller.handle({ type: 'selectPermission', payload: { preset: 'bypassPermissions' } });
    expect(await controller.send('继续')).toBe(true);
    const link = spawned[0]!;
    link.emit({ type: 'system', subtype: 'init', session_id: 'cb-bypass' });

    // 普通工具自动放行
    const bashResp = await link.ask('r1', { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } });
    expect(bashResp).toEqual({ allowed: true, updatedInput: { command: 'ls' } });

    // 小写下划线形式的 ask_user_question 仍应弹出提问卡片而非直接放行
    const qPromise = link.ask('r2', {
      subtype: 'can_use_tool',
      toolName: 'ask_user_question',
      input: { questions: [{ id: 'q1', question: '确认继续？', options: [{ label: '是' }] }] },
    });
    const card = controller.snapshot().interactions[0];
    expect(card?.kind).toBe('question');
    await controller.handle({
      type: 'answerQuestion',
      payload: { id: card!.id, answers: [{ id: 'q1', selected: ['是'] }] },
    });
    expect(await qPromise).toMatchObject({ allowed: true });

    controller.dispose();
  });
});

describe('CodeBuddy 原生服务商与 MCP 挂载', () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('prepareCodebuddyProviderRuntime 注入 CODEBUDDY_BASE_URL 与 CODEBUDDY_API_KEY', () => {
    const patch = prepareCodebuddyProviderRuntime({
      provider: {
        id: 'my-openai',
        name: 'My OpenAI',
        openaiChatUrl: 'https://example.com/v1',
        models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
        boundBackendIds: ['codebuddy'],
      },
      proxyOrigin: 'http://127.0.0.1:43210',
      proxyToken: 'tok-1',
      baseEnv: {},
    });
    expect(patch?.env.CODEBUDDY_BASE_URL).toBe('http://127.0.0.1:43210/p/my-openai/openai-chat');
    expect(patch?.env.CODEBUDDY_API_KEY).toBe('tok-1');
  });

  it('prepareBackendLaunch 为原生 CodeBuddy 生成 --mcp-config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-cb-mcp-'));
    temps.push(root);
    const prepared = await prepareBackendLaunch({
      storageRoot: root,
      profile: CODEBUDDY_PROFILE,
      skills: [],
      mcpServers: [
        {
          id: 'fs',
          name: 'fs',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          agents: ['codebuddy'],
        },
      ],
    });
    expect(prepared.extraArgs[0]).toBe('--mcp-config');
    expect(prepared.extraArgs[1]).toContain('codebuddy.mcp.json');
  });
});

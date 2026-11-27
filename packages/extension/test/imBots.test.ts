import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { HostSnapshot, ImBotPlatform, PendingInteraction, WebviewToHost } from '@harness-deck/shared';
import type { KeyValueStore, SecretStore } from '../src/host/HostPlatform.ts';
import { authorizeRemoteMessage } from '../src/remote/ScopeGuard.ts';
import { DingTalkBotAdapter } from '../src/remote/bots/DingTalkBotAdapter.ts';
import { FeishuBotAdapter } from '../src/remote/bots/FeishuBotAdapter.ts';
import {
  decodeFeishuPbFrame,
  encodeFeishuPbFrame,
  FEISHU_FRAME_METHOD_CONTROL,
  FEISHU_FRAME_METHOD_DATA,
  getFeishuHeader,
} from '../src/remote/bots/feishuProtobuf.ts';
import {
  formatInteractionForIm,
  ImBotManager,
  parseApprovalReply,
  parseQuestionReply,
} from '../src/remote/bots/ImBotManager.ts';
import { TelegramBotAdapter } from '../src/remote/bots/TelegramBotAdapter.ts';
import { WeComBotAdapter } from '../src/remote/bots/WeComBotAdapter.ts';
import type {
  ImBotAdapter,
  ImBotAdapterCallbacks,
  ImBotAdapterStatus,
  ImBotInboundMessage,
  ImBotReplyContext,
  ImBotSocketLike,
  ImBotStreamHandle,
} from '../src/remote/bots/types.ts';

class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }
}

class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  onDidChange(): () => void {
    return () => undefined;
  }
}

class MockWs extends EventEmitter implements ImBotSocketLike {
  readyState = 0;
  readonly sent: (string | Buffer | Uint8Array)[] = [];
  closed = false;

  send(data: string | Buffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason, 'utf8'));
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit('open');
  }

  emitMessage(data: string | Buffer): void {
    const isBinary = Buffer.isBuffer(data);
    this.emit('message', data, isBinary);
  }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFakeSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1.0.0', newerThanTested: false },
    connection: 'connected',
    sessions: [
      { id: 'sess-1', title: 'Fix login bug', updatedAt: 1000, running: false },
      { id: 'sess-2', title: 'Refactor API', updatedAt: 2000, running: false },
    ],
    tabs: { items: [], active: '' },
    session: {
      id: 'sess-1',
      title: 'Fix login bug',
      running: false,
      hasOlder: false,
      loadingOlder: false,
      sync: 'live',
    },
    items: [],
    models: {
      options: [],
      current: { provider: 'anthropic', model: 'claude-sonnet-4' },
    },
    interactions: [],
    permissions: { options: ['workspace-write'], current: 'workspace-write' },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: {
      active: 'claude',
      workspace: 'halo',
      items: [
        {
          id: 'claude',
          kind: 'claude',
          name: 'Claude Code',
        },
      ],
    },
    ...overrides,
  };
}

describe('Feishu PBBP2 Protobuf codec', () => {
  it('encodes and decodes Frame with headers, uint64 ids, and binary payload', () => {
    const original = {
      seqId: 42n,
      logId: 9007199254740993n,
      service: 33554433,
      method: FEISHU_FRAME_METHOD_DATA,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'msg_123' },
      ],
      payloadEncoding: 'identity',
      payloadType: 'json',
      payload: Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8'),
      logIdNew: 'trace-abc-999',
    };
    const encoded = encodeFeishuPbFrame(original);
    const decoded = decodeFeishuPbFrame(encoded);
    expect(decoded.seqId).toBe(42n);
    expect(decoded.logId).toBe(9007199254740993n);
    expect(decoded.service).toBe(33554433);
    expect(decoded.method).toBe(FEISHU_FRAME_METHOD_DATA);
    expect(decoded.headers).toEqual(original.headers);
    expect(decoded.payloadEncoding).toBe('identity');
    expect(decoded.payloadType).toBe('json');
    expect(decoded.payload?.toString('utf8')).toBe('{"hello":"world"}');
    expect(decoded.logIdNew).toBe('trace-abc-999');
    expect(getFeishuHeader(decoded.headers, 'type')).toBe('event');
  });
});

describe('WeComBotAdapter (智能机器人长连接)', () => {
  it('authenticates via aibot_subscribe, parses inbound messages, and streams aibot_respond_msg', async () => {
    const sockets: MockWs[] = [];
    const inbound: ImBotInboundMessage[] = [];
    const statuses: ImBotAdapterStatus[] = [];
    let clock = 10_000;

    const adapter = new WeComBotAdapter(
      {
        botId: 'bot_123',
        secret: 'sec_456',
        createWebSocket: () => {
          const ws = new MockWs();
          sockets.push(ws);
          return ws;
        },
        now: () => clock,
      },
      {
        onMessage: (m) => inbound.push(m),
        onStatusChange: (s) => statuses.push(s),
        log: () => undefined,
      },
    );

    await adapter.start();
    const ws = sockets[0]!;
    ws.emitOpen();

    // 校验已发送 aibot_subscribe 认证帧
    const subFrame = JSON.parse(String(ws.sent[0])) as {
      cmd: string;
      headers: { req_id: string };
      body: { bot_id: string; secret: string };
    };
    expect(subFrame.cmd).toBe('aibot_subscribe');
    expect(subFrame.body).toEqual({ bot_id: 'bot_123', secret: 'sec_456' });

    // 模拟企微返回认证成功
    ws.emitMessage(
      JSON.stringify({
        cmd: 'aibot_subscribe',
        headers: { req_id: subFrame.headers.req_id },
        errcode: 0,
        errmsg: 'ok',
      }),
    );
    expect(adapter.getStatus().status).toBe('connected');

    // 模拟收到群聊消息回调
    ws.emitMessage(
      JSON.stringify({
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req_001' },
        body: {
          msgid: 'm_001',
          chatid: 'room_99',
          chattype: 'group',
          from: { userid: 'zhangsan', name: '张三' },
          msgtype: 'text',
          text: { content: '@Halo 帮我看下 build 日志' },
        },
      }),
    );

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      platform: 'wecom',
      senderId: 'zhangsan',
      senderName: '张三',
      chatId: 'room_99',
      chatType: 'group',
      mentionedBot: true,
      text: '帮我看下 build 日志',
    });

    // 测试原生流式回复
    const handle = await adapter.beginReply(inbound[0]!.replyContext, '思考中…');
    clock += 1_000;
    await handle.update('第一段输出');
    clock += 1_000;
    await handle.finish('最终完整回答');

    const replyFrames = ws.sent
      .slice(1)
      .map((raw) => JSON.parse(String(raw)) as { cmd: string; body: { stream?: { finish: boolean; content: string } } })
      .filter((f) => f.cmd === 'aibot_respond_msg');
    expect(replyFrames).toHaveLength(3);
    expect(replyFrames[0]!.body.stream?.finish).toBe(false);
    expect(replyFrames[1]!.body.stream?.content).toBe('第一段输出');
    expect(replyFrames[2]!.body.stream?.finish).toBe(true);
    expect(replyFrames[2]!.body.stream?.content).toBe('最终完整回答');

    await adapter.stop();
    expect(adapter.getStatus().status).toBe('stopped');
  });

  it('surfaces underlying socket error message on empty-reason close(1006) instead of opaque code 1006', async () => {
    const sockets: MockWs[] = [];
    const statuses: ImBotAdapterStatus[] = [];
    const adapter = new WeComBotAdapter(
      {
        botId: 'bot_err',
        secret: 'sec_err',
        reconnectBaseMs: 60_000,
        createWebSocket: () => {
          const ws = new MockWs();
          sockets.push(ws);
          return ws;
        },
      },
      {
        onMessage: () => undefined,
        onStatusChange: (s) => statuses.push(s),
        log: () => undefined,
      },
    );

    await adapter.start();
    const ws = sockets[0]!;
    ws.emit('error', new Error('connect ETIMEDOUT 1.2.3.4:443'));
    ws.close(1006, '');

    expect(adapter.getStatus().status).toBe('reconnecting');
    expect(adapter.getStatus().error).toBe('connect ETIMEDOUT 1.2.3.4:443');
    await adapter.stop();
  });
});

describe('FeishuBotAdapter (飞书长连接 PBBP2)', () => {
  it('bootstraps WS endpoint, ACKs protobuf event frames, strips mentions, and replies/patches card', async () => {
    const sockets: MockWs[] = [];
    const inbound: ImBotInboundMessage[] = [];
    const fetchCalls: { url: string; method: string; body?: string }[] = [];
    let clock = 50_000;

    const fetchMock: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      fetchCalls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/callback/ws/endpoint')) {
        return makeJsonResponse({
          code: 0,
          data: {
            URL: 'wss://msg-frontier.feishu.cn/ws/v2?service_id=77',
            ClientConfig: { PingInterval: 120 },
          },
        });
      }
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return makeJsonResponse({ code: 0, tenant_access_token: 't-token-1', expire: 7200 });
      }
      if (url.includes('/reply')) {
        return makeJsonResponse({ code: 0, data: { message_id: 'om_reply_1' } });
      }
      if (method === 'PATCH') {
        return makeJsonResponse({ code: 0 });
      }
      return makeJsonResponse({ code: 0 });
    }) as typeof fetch;

    const adapter = new FeishuBotAdapter(
      {
        appId: 'cli_app_1',
        appSecret: 'secret_1',
        fetchImpl: fetchMock,
        createWebSocket: () => {
          const ws = new MockWs();
          sockets.push(ws);
          return ws;
        },
        now: () => clock,
      },
      {
        onMessage: (m) => inbound.push(m),
        onStatusChange: () => undefined,
        log: () => undefined,
      },
    );

    await adapter.start();
    const ws = sockets[0]!;
    ws.emitOpen();
    expect(adapter.getStatus().status).toBe('connected');

    // 首包应发送 CONTROL ping
    const pingFrame = decodeFeishuPbFrame(ws.sent[0] as Buffer);
    expect(pingFrame.method).toBe(FEISHU_FRAME_METHOD_CONTROL);
    expect(getFeishuHeader(pingFrame.headers, 'type')).toBe('ping');
    expect(pingFrame.service).toBe(77);

    // 模拟飞书下发 im.message.receive_v1 事件帧
    const eventJson = JSON.stringify({
      header: { event_id: 'ev_1', event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_alice' } },
        message: {
          message_id: 'om_in_1',
          chat_id: 'oc_group_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 检查测试失败原因' }),
          mentions: [{ key: '@_user_1', name: 'Halo' }],
        },
      },
    });
    ws.emitMessage(
      encodeFeishuPbFrame({
        seqId: 10n,
        logId: 20n,
        service: 77,
        method: FEISHU_FRAME_METHOD_DATA,
        headers: [{ key: 'type', value: 'event' }],
        payload: Buffer.from(eventJson, 'utf8'),
      }),
    );

    // 应立即回发 ACK 帧
    const ackFrame = decodeFeishuPbFrame(ws.sent[1] as Buffer);
    expect(ackFrame.seqId).toBe(10n);
    expect(JSON.parse(ackFrame.payload!.toString('utf8'))).toEqual({ code: 200 });

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      platform: 'feishu',
      senderId: 'ou_alice',
      chatId: 'oc_group_1',
      chatType: 'group',
      mentionedBot: true,
      text: '检查测试失败原因',
    });

    // 发送流式卡片 + PATCH 更新
    const stream = await adapter.beginReply(inbound[0]!.replyContext, '正在分析…');
    clock += 2_000;
    await stream.finish('分析完成：测试通过。');

    expect(fetchCalls.some((c) => c.url.includes('/messages/om_in_1/reply') && c.method === 'POST')).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes('/messages/om_reply_1') && c.method === 'PATCH')).toBe(true);

    await adapter.stop();
  });
});

describe('DingTalkBotAdapter (钉钉 Stream 模式)', () => {
  it('opens gateway, echoes SYSTEM ping opaque, ACKs callback, and replies via sessionWebhook', async () => {
    const sockets: MockWs[] = [];
    const inbound: ImBotInboundMessage[] = [];
    const webhookPosts: unknown[] = [];

    const fetchMock: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1.0/gateway/connections/open')) {
        return makeJsonResponse({
          endpoint: 'wss://wss-open-connection.dingtalk.com/connect',
          ticket: 'tk_999',
        });
      }
      if (url.startsWith('https://oapi.dingtalk.com/robot/sendBySession')) {
        webhookPosts.push(JSON.parse(String(init?.body ?? '{}')));
        return makeJsonResponse({ errcode: 0 });
      }
      return makeJsonResponse({ ok: true });
    }) as typeof fetch;

    const adapter = new DingTalkBotAdapter(
      {
        clientId: 'ding_id',
        clientSecret: 'ding_sec',
        fetchImpl: fetchMock,
        createWebSocket: () => {
          const ws = new MockWs();
          sockets.push(ws);
          return ws;
        },
      },
      {
        onMessage: (m) => inbound.push(m),
        onStatusChange: () => undefined,
        log: () => undefined,
      },
    );

    await adapter.start();
    const ws = sockets[0]!;
    ws.emitOpen();
    expect(adapter.getStatus().status).toBe('connected');

    // SYSTEM/ping 需原样回传 opaque
    ws.emitMessage(
      JSON.stringify({
        type: 'SYSTEM',
        headers: { topic: 'ping', messageId: 'ping-1' },
        data: JSON.stringify({ opaque: 'op-xyz' }),
      }),
    );
    const pingAck = JSON.parse(String(ws.sent[0])) as { headers: { messageId: string }; data: string };
    expect(pingAck.headers.messageId).toBe('ping-1');
    expect(pingAck.data).toBe(JSON.stringify({ opaque: 'op-xyz' }));

    // CALLBACK 机器人消息
    ws.emitMessage(
      JSON.stringify({
        type: 'CALLBACK',
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-1' },
        data: JSON.stringify({
          msgId: 'dt_m1',
          senderStaffId: 'staff_01',
          senderNick: '李四',
          conversationId: 'cid_1',
          conversationType: '1',
          text: { content: '跑一下 pnpm test' },
          sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
        }),
      }),
    );

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      platform: 'dingtalk',
      senderId: 'staff_01',
      senderName: '李四',
      chatType: 'single',
      text: '跑一下 pnpm test',
    });

    const handle = await adapter.beginReply(inbound[0]!.replyContext);
    await handle.finish('全部测试通过');
    expect(webhookPosts).toHaveLength(1);
    expect(webhookPosts[0]).toMatchObject({
      msgtype: 'markdown',
      markdown: { text: '全部测试通过' },
    });

    await adapter.stop();
  });
});

describe('TelegramBotAdapter (长轮询)', () => {
  it('verifies getMe, strips @botUsername in groups, and sends/edits replies', async () => {
    const inbound: ImBotInboundMessage[] = [];
    const apiCalls: { method: string; body: Record<string, unknown> }[] = [];
    let pollCount = 0;

    const fetchMock: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = url.split('/').pop() ?? '';
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      apiCalls.push({ method, body });
      if (method === 'getMe') {
        return makeJsonResponse({ ok: true, result: { id: 99, is_bot: true, username: 'halo_dev_bot' } });
      }
      if (method === 'getUpdates') {
        pollCount += 1;
        if (pollCount === 1) {
          return makeJsonResponse({
            ok: true,
            result: [
              {
                update_id: 100,
                message: {
                  message_id: 55,
                  text: '@halo_dev_bot /status',
                  from: { id: 777, username: 'dev_bob' },
                  chat: { id: -1001234, type: 'supergroup' },
                },
              },
            ],
          });
        }
        // 后续轮询阻塞直到 stop() abort
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      if (method === 'sendMessage') {
        return makeJsonResponse({ ok: true, result: { message_id: 88 } });
      }
      return makeJsonResponse({ ok: true, result: true });
    }) as typeof fetch;

    const adapter = new TelegramBotAdapter(
      { botToken: '12345:AAH_TEST', fetchImpl: fetchMock, pollTimeoutSec: 1 },
      {
        onMessage: (m) => inbound.push(m),
        onStatusChange: () => undefined,
        log: () => undefined,
      },
    );

    await adapter.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(inbound[0]).toMatchObject({
      platform: 'telegram',
      senderId: '777',
      senderName: '@dev_bob',
      chatId: '-1001234',
      chatType: 'group',
      mentionedBot: true,
      text: '/status',
    });
    expect(adapter.getStatus().botName).toBe('@halo_dev_bot');

    const handle = await adapter.beginReply(inbound[0]!.replyContext, 'Working…');
    await handle.finish('All green!');
    expect(apiCalls.some((c) => c.method === 'sendMessage')).toBe(true);
    expect(apiCalls.some((c) => c.method === 'editMessageText' && c.body.text === 'All green!')).toBe(true);

    await adapter.stop();
  });
});

describe('ImBotManager (配对授权 + 斜杠指令 + 双向对话 + 审批/提问)', () => {
  it('enforces pairing/allowlist, executes slash commands, streams replies, and resolves approvals & questions', async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretStore();
    const dispatched: WebviewToHost[] = [];
    const sentMessages: { platform: ImBotPlatform; chatId: string; text: string }[] = [];
    const streamFinishes: string[] = [];
    const adapterCallbacks = new Map<ImBotPlatform, ImBotAdapterCallbacks>();
    let snapshot = makeFakeSnapshot();

    const manager = new ImBotManager({
      globalState: store,
      secrets,
      locale: () => 'zh',
      isWindowFocused: () => false,
      getSnapshot: () => snapshot,
      ensureBackendStarted: () => undefined,
      dispatchMessage: (msg) => dispatched.push(msg),
      onStateChange: () => undefined,
      log: () => undefined,
      adapterFactory: (creds, cbs): ImBotAdapter => {
        adapterCallbacks.set(creds.platform, cbs);
        let st: ImBotAdapterStatus = { status: 'stopped' };
        return {
          platform: creds.platform,
          start: async () => {
            st = { status: 'connected', lastConnectedAt: Date.now() };
            cbs.onStatusChange(st);
          },
          stop: async () => {
            st = { status: 'stopped' };
            cbs.onStatusChange(st);
          },
          getStatus: () => st,
          beginReply: async (ctx: ImBotReplyContext): Promise<ImBotStreamHandle> => ({
            update: async () => undefined,
            finish: async (md: string) => {
              streamFinishes.push(md);
              sentMessages.push({ platform: ctx.platform, chatId: ctx.chatId, text: md });
            },
          }),
          sendMessage: async (chatId: string, text: string) => {
            sentMessages.push({ platform: creds.platform, chatId, text });
          },
          testConnection: async () => ({ ok: true, detail: 'mock-ok' }),
        };
      },
    });

    await manager.updateChannel({
      platform: 'wecom',
      enabled: true,
      appId: 'bot_demo',
      secret: 'super_secret_token',
    });

    // 密钥不外泄到视图模型
    const state = manager.getState();
    expect(state.channels.wecom.hasSecret).toBe(true);
    expect(JSON.stringify(state)).not.toContain('super_secret_token');

    const emitWeCom = (partial: Partial<ImBotInboundMessage> & { text: string; messageId: string }) => {
      const chatType = partial.chatType ?? 'single';
      const senderId = partial.senderId ?? 'u_alice';
      const chatId = partial.chatId ?? 'c_alice';
      adapterCallbacks.get('wecom')!.onMessage({
        platform: 'wecom',
        senderId,
        senderName: 'Alice',
        chatId,
        chatType,
        mentionedBot: partial.mentionedBot ?? false,
        replyContext: { platform: 'wecom', chatId, chatType, senderId, reqId: `req_${partial.messageId}` },
        timestamp: Date.now(),
        ...partial,
      });
    };

    // 1. 未授权用户发消息应被拦截并提示配对
    emitWeCom({ messageId: 'm1', text: 'hello' });
    await vi.waitFor(() => expect(sentMessages.some((m) => m.text.includes('/pair'))).toBe(true));
    expect(dispatched).toHaveLength(0);

    // 2. 群聊未 @机器人 时忽略
    emitWeCom({ messageId: 'm2', text: '闲聊消息', chatType: 'group', mentionedBot: false });
    await Promise.resolve();
    expect(dispatched).toHaveLength(0);

    // 3. 生成一次性配对码并通过 /pair 完成绑定
    const pairing = manager.generatePairing();
    emitWeCom({ messageId: 'm3', text: `/pair ${pairing.code}` });
    await vi.waitFor(() => expect(manager.getState().boundUsers).toHaveLength(1));
    expect(manager.getState().pairing).toBeUndefined();
    expect(manager.getState().boundUsers[0]!.userId).toBe('u_alice');

    // 4. 测试斜杠指令 /status、/sessions、/switch 2、/new、/stop
    emitWeCom({ messageId: 'm4', text: '/status' });
    await vi.waitFor(() => expect(sentMessages.some((m) => m.text.includes('Claude Code'))).toBe(true));

    emitWeCom({ messageId: 'm5', text: '/switch 2' });
    await vi.waitFor(() =>
      expect(dispatched.some((d) => d.type === 'switchSession' && d.payload.sessionId === 'sess-2')).toBe(true),
    );

    emitWeCom({ messageId: 'm6', text: '/new' });
    await vi.waitFor(() => expect(dispatched.some((d) => d.type === 'newSession')).toBe(true));

    // 5. 发送普通对话 -> 分发 sendMessage 并流式收口回复
    emitWeCom({ messageId: 'm7', text: '帮我修复单测' });
    await vi.waitFor(() =>
      expect(dispatched.some((d) => d.type === 'sendMessage' && d.payload.text === '帮我修复单测')).toBe(true),
    );

    manager.observeHostMessage({
      type: 'session',
      payload: { ...snapshot.session, running: true },
    });
    manager.observeHostMessage({
      type: 'items',
      payload: {
        sessionKey: 'sess-1',
        reset: false,
        order: ['a1'],
        upsert: [{ kind: 'assistant', id: 'a1', markdown: '已定位并修复单测问题。', streaming: false }],
      },
    });
    manager.observeHostMessage({
      type: 'session',
      payload: { ...snapshot.session, running: false },
    });

    await vi.waitFor(() => expect(streamFinishes).toContain('已定位并修复单测问题。'));

    // 6. 审批卡片推送 + IM 内直接回复「始终允许」
    const approval: PendingInteraction = {
      kind: 'approval',
      id: 'appr-1',
      toolName: 'bash',
      reason: '需要运行测试命令',
      subject: 'pnpm test',
      subjectKind: 'command',
      previewable: false,
      dirtyFiles: [],
      allowAlways: '始终允许运行 bash',
    };
    snapshot = makeFakeSnapshot({ interactions: [approval] });
    manager.observeHostMessage({ type: 'interactions', payload: [approval] });
    await vi.waitFor(() => expect(sentMessages.some((m) => m.text.includes('需要审批：bash'))).toBe(true));

    emitWeCom({ messageId: 'm8', text: '始终允许' });
    await vi.waitFor(() =>
      expect(
        dispatched.some(
          (d) =>
            d.type === 'respondApproval' &&
            d.payload.id === 'appr-1' &&
            d.payload.decision === 'allowAlways',
        ),
      ).toBe(true),
    );

    // 7. 提问卡片推送 + IM 内回复选项编号
    const question: PendingInteraction = {
      kind: 'question',
      id: 'q-1',
      questions: [
        {
          id: 'framework',
          question: '使用哪个测试框架？',
          options: [{ label: 'Vitest' }, { label: 'Jest' }],
          multiSelect: false,
        },
      ],
    };
    snapshot = makeFakeSnapshot({ interactions: [question] });
    manager.observeHostMessage({ type: 'interactions', payload: [question] });
    await vi.waitFor(() => expect(sentMessages.some((m) => m.text.includes('使用哪个测试框架'))).toBe(true));

    emitWeCom({ messageId: 'm9', text: '1' });
    await vi.waitFor(() =>
      expect(
        dispatched.some(
          (d) =>
            d.type === 'answerQuestion' &&
            'answers' in d.payload &&
            d.payload.id === 'q-1' &&
            d.payload.answers[0]?.selected[0] === 'Vitest',
        ),
      ).toBe(true),
    );

    await manager.dispose();
  });

  it('parses approval/question replies and enforces ScopeGuard blocks on remote mobile clients', () => {
    expect(parseApprovalReply('允许', false)).toBe('allow');
    expect(parseApprovalReply('2', false)).toBe('reject');
    expect(parseApprovalReply('2', true)).toBe('allowAlways');
    expect(parseApprovalReply('3', true)).toBe('reject');

    const q: Extract<PendingInteraction, { readonly kind: 'question' }> = {
      kind: 'question',
      id: 'q2',
      questions: [
        {
          id: 'p1',
          question: 'Pick',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
        },
      ],
    };
    expect(parseQuestionReply(q, '1,3')).toEqual({
      id: 'q2',
      answers: [{ id: 'p1', selected: ['A', 'C'] }],
    });
    expect(parseQuestionReply(q, '取消')).toEqual({ id: 'q2', cancelled: true });
    expect(formatInteractionForIm(q, 'en')).toContain('Agent Question');

    expect(
      authorizeRemoteMessage('operate', {
        type: 'updateImBotChannel',
        payload: { platform: 'wecom', enabled: true },
      }).ok,
    ).toBe(false);
    expect(
      authorizeRemoteMessage('operate', {
        type: 'generateImBotPairing',
        payload: {},
      }).ok,
    ).toBe(false);
  });

  it('strips reqId when sending mid-turn WeCom approvals and does not prematurely finish active stream', async () => {
    const store = new MemoryStore();
    const secrets = new MemorySecretStore();
    const sentWithCtx: { text: string; ctx?: ImBotReplyContext }[] = [];
    const finishes: string[] = [];
    let dispatchedCount = 0;
    let cb: ImBotAdapterCallbacks | undefined;
    let snapshot = makeFakeSnapshot();

    const manager = new ImBotManager({
      globalState: store,
      secrets,
      locale: () => 'zh',
      isWindowFocused: () => false,
      getSnapshot: () => snapshot,
      ensureBackendStarted: () => undefined,
      dispatchMessage: () => {
        dispatchedCount += 1;
      },
      onStateChange: () => undefined,
      log: () => undefined,
      adapterFactory: (creds, callbacks): ImBotAdapter => {
        cb = callbacks;
        const st: ImBotAdapterStatus = { status: 'connected', lastConnectedAt: Date.now() };
        return {
          platform: creds.platform,
          start: async () => callbacks.onStatusChange(st),
          stop: async () => undefined,
          getStatus: () => st,
          beginReply: async (): Promise<ImBotStreamHandle> => ({
            update: async () => undefined,
            finish: async (md: string) => {
              finishes.push(md);
            },
          }),
          sendMessage: async (_chatId: string, text: string, ctx?: ImBotReplyContext) => {
            sentWithCtx.push({ text, ctx });
          },
          testConnection: async () => ({ ok: true }),
        };
      },
    });

    await manager.updateChannel({
      platform: 'wecom',
      enabled: true,
      appId: 'bot_1',
      secret: 'sec_1',
      allowlist: ['u_dev'],
    });

    cb!.onMessage({
      platform: 'wecom',
      messageId: 'm_turn',
      senderId: 'u_dev',
      chatId: 'c_dev',
      chatType: 'single',
      mentionedBot: false,
      text: '修改配置并运行测试',
      replyContext: { platform: 'wecom', chatId: 'c_dev', chatType: 'single', senderId: 'u_dev', reqId: 'req_stream_1' },
      timestamp: Date.now(),
    });
    // 等待 handleChatPrompt 完成 beginReply 与 sendMessage 分发
    await vi.waitFor(() => expect(dispatchedCount).toBe(1));

    // 模拟本轮中途输出前置文本并弹出待审批卡片，同时 running 短暂抖动为 false
    const approval: PendingInteraction = {
      kind: 'approval',
      id: 'appr-mid',
      toolName: 'bash',
      reason: '执行测试',
      subject: 'pnpm test',
      subjectKind: 'command',
      previewable: false,
      dirtyFiles: [],
    };
    snapshot = makeFakeSnapshot({ interactions: [approval] });
    manager.observeHostMessage({ type: 'interactions', payload: [approval] });
    manager.observeHostMessage({
      type: 'items',
      payload: {
        sessionKey: 'sess-1',
        reset: false,
        order: ['a_mid'],
        upsert: [{ kind: 'assistant', id: 'a_mid', markdown: '准备运行测试', streaming: false }],
      },
    });
    manager.observeHostMessage({ type: 'session', payload: { ...snapshot.session, running: false } });

    // 审批推送必须剥离 reqId，以免提前结束企微流式响应
    await vi.waitFor(() => expect(sentWithCtx.some((s) => s.text.includes('需要审批：bash'))).toBe(true));
    const approvalSend = sentWithCtx.find((s) => s.text.includes('需要审批：bash'))!;
    expect(approvalSend.ctx?.reqId).toBeUndefined();
    // 审批未完成前绝不提前 finish 流
    expect(finishes).toHaveLength(0);

    // 审批清空且最终输出完成后，再正常收口流
    snapshot = makeFakeSnapshot({ interactions: [] });
    manager.observeHostMessage({ type: 'interactions', payload: [] });
    manager.observeHostMessage({
      type: 'items',
      payload: {
        sessionKey: 'sess-1',
        reset: false,
        order: ['a_mid', 'a_final'],
        upsert: [{ kind: 'assistant', id: 'a_final', markdown: '测试已全部通过！', streaming: false }],
      },
    });
    manager.observeHostMessage({ type: 'session', payload: { ...snapshot.session, running: false } });

    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    expect(finishes[0]).toContain('测试已全部通过！');

    await manager.dispose();
  });
});

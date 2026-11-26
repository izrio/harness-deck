import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountConfig, BackendChannelBinding, ProviderConfig } from '@harness-deck/shared';
import {
  buildProviderProxyScope,
  parseProviderProxyScope,
  ScopedProviderModelRegistry,
  SessionChannelStore,
  type SessionChannelRecord,
} from '../src/accounts/SessionIsolationStore.ts';
import { systemAccountId } from '../src/accounts/AccountStore.ts';
import { ClaudeController, type ClaudePreferredModel } from '../src/claude/ClaudeController.ts';
import { CodexController, type CodexPreferredModel } from '../src/codex/CodexController.ts';
import { ProviderProxy } from '../src/providers/ProviderProxy.ts';
import {
  prepareClaudeProviderRuntime,
  prepareCodexProviderRuntime,
  prepareDshProviderRuntime,
  prepareZcodeProviderRuntime,
  writeClaudeProviderSettingsFile,
} from '../src/providers/ProviderRuntime.ts';

const SHARED_PROVIDER: ProviderConfig = {
  id: 'shared-gw',
  name: 'Shared Gateway',
  anthropicUrl: 'https://gw.example.com/anthropic',
  openaiChatUrl: 'https://gw.example.com/openai',
  openaiResponsesUrl: 'https://gw.example.com/openai',
  models: [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'Model B' },
    { id: 'model-c', name: 'Model C' },
  ],
  defaultModel: 'model-a',
  boundBackendIds: [],
};

const CLAUDE_ACC_WORK: AccountConfig = {
  id: 'claude-work',
  backendId: 'claude',
  label: 'Work Claude',
  createdAt: 1000,
};

const CLAUDE_ACC_PERSONAL: AccountConfig = {
  id: 'claude-personal',
  backendId: 'claude',
  label: 'Personal Claude',
  createdAt: 2000,
};

describe('SessionChannelStore: per-session and cross-tool channel isolation', () => {
  it('isolates account/provider bindings across sessions and protects committed sessions from default changes', () => {
    let persisted: SessionChannelRecord = {};
    const store = new SessionChannelStore({
      load: () => persisted,
      save: (next) => {
        persisted = next;
      },
    });
    const providers = [SHARED_PROVIDER];
    const accounts = [CLAUDE_ACC_WORK, CLAUDE_ACC_PERSONAL];
    let backendChannels: Record<string, BackendChannelBinding> = {
      claude: { mode: 'official', accountId: CLAUDE_ACC_WORK.id },
      codex: { mode: 'provider', providerId: SHARED_PROVIDER.id },
    };

    // 新会话 s1 从草稿提交时快照当前默认账号（claude-work）
    store.commitDraftToSession('claude', 'pending:1', 'tab-1', backendChannels.claude!);
    store.rekeySession('claude', 'pending:1', 'sess-1');

    // 新会话 s2 在草稿上单独切到第三方服务商，不改工具默认渠道
    store.setDraftTabChannel('tab-2', 'claude', { mode: 'provider', providerId: SHARED_PROVIDER.id });
    store.commitDraftToSession('claude', 'sess-2', 'tab-2', backendChannels.claude!);

    // 之后在设置里把 claude 全局默认改成 claude-personal
    backendChannels = {
      ...backendChannels,
      claude: { mode: 'official', accountId: CLAUDE_ACC_PERSONAL.id },
    };

    // sess-1 依然保持 claude-work，sess-2 依然保持 shared-gw，未绑定的新标签 tab-3 继承新默认 claude-personal
    expect(
      store.resolveEffectiveChannel({
        backendId: 'claude',
        sessionId: 'sess-1',
        backendChannels,
        providers,
        accounts,
      }),
    ).toEqual({ mode: 'official', accountId: 'claude-work' });

    expect(
      store.resolveEffectiveChannel({
        backendId: 'claude',
        sessionId: 'sess-2',
        backendChannels,
        providers,
        accounts,
      }),
    ).toEqual({ mode: 'provider', providerId: 'shared-gw' });

    expect(
      store.resolveEffectiveChannel({
        backendId: 'claude',
        tabKey: 'tab-3',
        backendChannels,
        providers,
        accounts,
      }),
    ).toEqual({ mode: 'official', accountId: 'claude-personal' });

    // 同一 sessionId 在另一个工具（codex）上不会串读 claude 的绑定
    expect(
      store.resolveEffectiveChannel({
        backendId: 'codex',
        sessionId: 'sess-1',
        backendChannels,
        providers,
        accounts,
      }),
    ).toEqual({ mode: 'provider', providerId: 'shared-gw' });

    // 重新实例化后持久化记录正确恢复
    const reloaded = new SessionChannelStore({
      load: () => persisted,
      save: () => undefined,
    });
    expect(reloaded.getSessionBinding('claude', 'sess-1')).toEqual({ mode: 'official', accountId: 'claude-work' });
    expect(reloaded.getSessionBinding('claude', 'sess-2')).toEqual({ mode: 'provider', providerId: 'shared-gw' });
  });

  it('does not leak draft tab channel when switching backend and falls back cleanly on deleted account/provider', () => {
    const store = new SessionChannelStore({
      load: () => ({}),
      save: () => undefined,
    });
    const providers = [SHARED_PROVIDER];
    const accounts = [CLAUDE_ACC_WORK];
    const backendChannels: Record<string, BackendChannelBinding> = {
      claude: { mode: 'official', accountId: systemAccountId('claude') },
      codex: { mode: 'official', accountId: systemAccountId('codex') },
    };

    store.setDraftTabChannel('tab-blank', 'claude', { mode: 'provider', providerId: SHARED_PROVIDER.id });
    // 同一个空白标签切换到底层 codex 后，不应沿用 claude 的草稿绑定
    expect(
      store.resolveEffectiveChannel({
        backendId: 'codex',
        tabKey: 'tab-blank',
        backendChannels,
        providers,
        accounts,
      }),
    ).toEqual({ mode: 'official', accountId: systemAccountId('codex') });

    // 删除账号或服务商后自动清理并回退默认渠道
    store.setSessionChannel('claude', 'sess-a', { mode: 'official', accountId: CLAUDE_ACC_WORK.id });
    store.setSessionChannel('claude', 'sess-b', { mode: 'provider', providerId: SHARED_PROVIDER.id });
    expect(store.pruneAccount('claude', CLAUDE_ACC_WORK.id)).toBe(true);
    expect(store.pruneProvider(SHARED_PROVIDER.id)).toBe(true);
    expect(store.getSessionBinding('claude', 'sess-a')).toBeUndefined();
    expect(store.getSessionBinding('claude', 'sess-b')).toBeUndefined();
  });
});

describe('ScopedProviderModelRegistry + ProviderProxy: cross-tool and per-session model isolation', () => {
  let proxy: ProviderProxy | undefined;

  afterEach(async () => {
    await proxy?.dispose();
    proxy = undefined;
  });

  it('routes identical provider requests to isolated models per tool and per session', async () => {
    const registry = new ScopedProviderModelRegistry();
    registry.set(SHARED_PROVIDER.id, 'model-a', { backendId: 'claude', sessionId: 'sess-1' });
    registry.set(SHARED_PROVIDER.id, 'model-b', { backendId: 'claude', sessionId: 'sess-2' });
    registry.set(SHARED_PROVIDER.id, 'model-c', { backendId: 'codex' });
    registry.setBackendActive('codex', SHARED_PROVIDER.id, 'model-c');

    // 验证作用域解析与 rekey
    expect(parseProviderProxyScope(buildProviderProxyScope('claude', 'sess-1'))).toEqual({
      backendId: 'claude',
      sessionId: 'sess-1',
    });
    expect(registry.resolve(SHARED_PROVIDER.id, buildProviderProxyScope('claude', 'sess-1'))).toBe('model-a');
    expect(registry.resolve(SHARED_PROVIDER.id, buildProviderProxyScope('claude', 'sess-2'))).toBe('model-b');
    expect(registry.resolve(SHARED_PROVIDER.id, buildProviderProxyScope('codex'))).toBe('model-c');
    // 未选过模型的工具（如 pi）绝不串读 codex/claude 的模型
    expect(registry.resolve(SHARED_PROVIDER.id, buildProviderProxyScope('pi'))).toBeUndefined();

    const upstreamModels: string[] = [];
    proxy = new ProviderProxy({
      getProvider: (id) => (id === SHARED_PROVIDER.id ? SHARED_PROVIDER : undefined),
      getApiKey: async () => 'sk-real-secret',
      getSelectedModel: (providerId, scope) => registry.resolve(providerId, scope),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as { model?: string };
        upstreamModels.push(body.model ?? '');
        return new Response(JSON.stringify({ ok: true, model: body.model }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await proxy.ensureStarted();

    const sendReq = async (scope: string, protocol: 'anthropic' | 'openai-chat') => {
      const url = `${proxy!.endpointFor(SHARED_PROVIDER.id, protocol, scope)}/v1/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': proxy!.token,
        },
        body: JSON.stringify({ model: 'default', messages: [] }),
      });
      expect(res.status).toBe(200);
    };

    await sendReq(buildProviderProxyScope('claude', 'sess-1'), 'anthropic');
    await sendReq(buildProviderProxyScope('claude', 'sess-2'), 'anthropic');
    await sendReq(buildProviderProxyScope('codex'), 'openai-chat');

    expect(upstreamModels).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('scopes temp config paths and proxy URLs per tool/session in ProviderRuntime', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'halo-iso-'));
    try {
      const claude1 = prepareClaudeProviderRuntime({
        provider: SHARED_PROVIDER,
        proxyOrigin: 'http://127.0.0.1:9999',
        proxyToken: 'tok',
        baseEnv: {},
        selectedModel: 'model-a',
        proxyScope: buildProviderProxyScope('claude', 's1'),
      });
      const claude2 = prepareClaudeProviderRuntime({
        provider: SHARED_PROVIDER,
        proxyOrigin: 'http://127.0.0.1:9999',
        proxyToken: 'tok',
        baseEnv: {},
        selectedModel: 'model-b',
        proxyScope: buildProviderProxyScope('claude', 's2'),
      });
      expect(claude1?.env.ANTHROPIC_BASE_URL).toContain('/s/claude%3A%3As1/p/shared-gw/anthropic');
      expect(claude2?.env.ANTHROPIC_BASE_URL).toContain('/s/claude%3A%3As2/p/shared-gw/anthropic');

      const file1 = await writeClaudeProviderSettingsFile(tmp, SHARED_PROVIDER.id, claude1!.settingsJson, 'claude::s1');
      const file2 = await writeClaudeProviderSettingsFile(tmp, SHARED_PROVIDER.id, claude2!.settingsJson, 'claude::s2');
      expect(file1).not.toBe(file2);

      const codex = prepareCodexProviderRuntime({
        provider: SHARED_PROVIDER,
        proxyOrigin: 'http://127.0.0.1:9999',
        proxyToken: 'tok',
        baseEnv: {},
        proxyScope: buildProviderProxyScope('codex'),
      });
      expect(codex?.args.join(' ')).toContain('/s/codex/p/shared-gw/openai-responses');

      const dsh = await prepareDshProviderRuntime(SHARED_PROVIDER, 'http://127.0.0.1:9999', 'tok', tmp, 'dsh');
      const zcode = await prepareZcodeProviderRuntime({
        provider: SHARED_PROVIDER,
        proxyOrigin: 'http://127.0.0.1:9999',
        proxyToken: 'tok',
        storageDir: tmp,
        baseEnv: {},
        proxyScope: 'zcode',
      });
      expect(dsh?.launcherArgs[1]).toContain('dsh-provider-dsh-shared-gw');
      expect(zcode?.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toContain('zcode-provider-zcode-shared-gw');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Controllers: per-session model and channel isolation', () => {
  it('isolates model and channel per session in ClaudeController', async () => {
    const channelBySession = new Map<string, ProviderConfig | undefined>([
      ['sess-1', undefined],
      ['sess-2', SHARED_PROVIDER],
    ]);
    let savedSessionModels: Readonly<Record<string, ClaudePreferredModel>> = {};
    const disposedLinks: string[] = [];

    const controller = new ClaudeController({
      workspacePath: '/repo',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      renderDelayMs: 0,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => 'sess-1',
      saveActiveSessionId: () => undefined,
      loadSessions: () => [
        { id: 'sess-1', title: 'S1', updatedAt: 1 },
        { id: 'sess-2', title: 'S2', updatedAt: 2 },
      ],
      saveSessions: () => undefined,
      loadSessionModels: () => savedSessionModels,
      saveSessionModels: (models) => {
        savedSessionModels = models;
      },
      boundProvider: (sid) => (sid ? channelBySession.get(sid) : undefined),
    });

    controller.setSpawner(async (params) => ({
      running: true,
      sendUserMessage: () => undefined,
      sendControlRequest: async <T = unknown>() => ({}) as T,
      dispose: async () => {
        disposedLinks.push(params.sessionId ?? 'unknown');
      },
    }));

    // 会话 1（官方渠道）切到 opus / high
    await controller.handle({
      type: 'selectModel',
      payload: { provider: 'anthropic', model: 'opus', reasoningEffort: 'high' },
    });
    expect(controller.modelState().current).toEqual({
      provider: 'anthropic',
      model: 'opus',
      reasoningEffort: 'high',
    });

    // 切到会话 2（绑定第三方服务商 shared-gw）并切到 model-b
    await controller.handle({ type: 'switchSession', payload: { sessionId: 'sess-2' } });
    expect(controller.modelState().options.map((o) => o.model)).toEqual(['model-a', 'model-b', 'model-c']);
    await controller.handle({
      type: 'selectModel',
      payload: { provider: SHARED_PROVIDER.id, model: 'model-b' },
    });
    expect(controller.modelState().current?.model).toBe('model-b');

    // 切回会话 1：模型依然是 opus / high，渠道依然是官方 Anthropic
    await controller.handle({ type: 'switchSession', payload: { sessionId: 'sess-1' } });
    expect(controller.modelState().current).toEqual({
      provider: 'anthropic',
      model: 'opus',
      reasoningEffort: 'high',
    });

    // 两个会话各自落盘模型记录
    expect(savedSessionModels['sess-1']).toEqual({ provider: 'anthropic', model: 'opus', effort: 'high' });
    expect(savedSessionModels['sess-2']).toEqual({ provider: SHARED_PROVIDER.id, model: 'model-b' });

    // 验证单会话渠道变更仅影响目标会话
    await controller.onSessionChannelChanged('sess-1');
    expect(disposedLinks).not.toContain('sess-2');
    controller.dispose();
  });

  it('isolates model per thread in CodexController', async () => {
    let savedSessionModels: Readonly<Record<string, CodexPreferredModel>> = {};
    const controller = new CodexController({
      workspacePath: '/repo',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      renderDelayMs: 0,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => 'thread-1',
      saveActiveSessionId: () => undefined,
      loadSessions: () => [
        { id: 'thread-1', title: 'T1', updatedAt: 1 },
        { id: 'thread-2', title: 'T2', updatedAt: 2 },
      ],
      saveSessions: () => undefined,
      loadSessionModels: () => savedSessionModels,
      saveSessionModels: (models) => {
        savedSessionModels = models;
      },
    });

    // 注入最小模型目录
    controller.setLink({
      request: async <T = unknown>(method: string) => {
        if (method === 'model/list') {
          return {
            data: [
              { id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true },
              { id: 'gpt-5.3-codex', model: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' },
            ],
          } as T;
        }
        return {} as T;
      },
      notify: () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    await controller.handle({
      type: 'selectModel',
      payload: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
    });
    await controller.handle({ type: 'switchSession', payload: { sessionId: 'thread-2' } });
    await controller.handle({
      type: 'selectModel',
      payload: { provider: 'openai', model: 'gpt-5.3-codex', reasoningEffort: 'low' },
    });
    expect(controller.modelState().current).toEqual({
      provider: 'openai',
      model: 'gpt-5.3-codex',
      reasoningEffort: 'low',
    });

    await controller.handle({ type: 'switchSession', payload: { sessionId: 'thread-1' } });
    expect(controller.modelState().current).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    });
    expect(savedSessionModels['thread-1']?.model).toBe('gpt-5.4');
    expect(savedSessionModels['thread-2']?.model).toBe('gpt-5.3-codex');
    controller.dispose();
  });
});

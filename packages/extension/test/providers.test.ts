import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PRESETS,
  backendProtocolCapability,
  formatTokenLimit,
  isProviderReadyForBackend,
  parseEffortsInput,
  parseTokenLimit,
  type ProviderConfig,
} from '@harness-deck/shared';
import {
  ProviderProxy,
  fetchRemoteProviderModels,
  joinUpstreamUrl,
  rewriteModelInPayload,
} from '../src/providers/ProviderProxy.ts';
import { prepareAcpProviderRuntime, prepareClaudeProviderRuntime, prepareDshProviderRuntime } from '../src/providers/ProviderRuntime.ts';
import {
  bindProviderSetting,
  buildProvidersState,
  deleteProviderSetting,
  parseProvidersSetting,
  providerForBackend,
  providerModelOptions,
  upsertProviderSetting,
} from '../src/providers/ProviderStore.ts';

describe('第三方服务商预设与协议能力矩阵（shared/providers）', () => {
  it('内置火山方舟、智谱 GLM、百炼、Kimi、MiniMax、CLIProxyAPI 与自定义预设', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual([
      'volcengine-coding',
      'zhipu-coding',
      'bailian-coding',
      'kimi-coding',
      'minimax-coding',
      'cliproxyapi',
      'custom',
    ]);

    const ark = PROVIDER_PRESETS.find((p) => p.id === 'volcengine-coding')!;
    expect(ark.anthropicUrl).toBe('https://ark.cn-beijing.volces.com/api/coding');
    expect(ark.openaiChatUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
    expect(ark.models.map((m) => m.id)).toContain('ark-code-latest');

    const zhipu = PROVIDER_PRESETS.find((p) => p.id === 'zhipu-coding')!;
    expect(zhipu.anthropicUrl).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(zhipu.openaiChatUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(zhipu.defaultModel).toBe('glm-5');
    expect(zhipu.smallModel).toBe('glm-4.5-air');
  });

  it('解析上下文上限、思考档位，并区分协议支持与仅限自有账号的智能体', () => {
    expect(parseTokenLimit('200k')).toBe(200_000);
    expect(parseTokenLimit('1M')).toBe(1_000_000);
    expect(parseTokenLimit('128,000')).toBe(128_000);
    expect(parseTokenLimit('未知')).toBeUndefined();
    expect(formatTokenLimit(256_000)).toBe('256k');
    expect(formatTokenLimit(1_000_000)).toBe('1M');
    expect(parseEffortsInput('low, high，medium, LOW')).toEqual(['low', 'high', 'medium']);

    expect(backendProtocolCapability({ id: 'claude', kind: 'acp' })).toEqual({
      kind: 'supported',
      protocols: ['anthropic'],
    });
    expect(backendProtocolCapability({ id: 'cursor', kind: 'acp', name: 'Cursor' })).toEqual({
      kind: 'account-only',
    });
    expect(backendProtocolCapability({ id: 'gemini-cli', kind: 'acp', command: 'gemini' })).toEqual({
      kind: 'account-only',
    });

    const openaiOnly = { openaiChatUrl: 'https://example.com/v1' };
    expect(isProviderReadyForBackend(openaiOnly, { id: 'dsh', kind: 'dsh' })).toBe(true);
    expect(isProviderReadyForBackend(openaiOnly, { id: 'claude', kind: 'acp' })).toBe(false);
    expect(
      isProviderReadyForBackend(openaiOnly, { id: 'claude', kind: 'acp' }, { protocolGatewayEnabled: true }),
    ).toBe(true);
    expect(
      isProviderReadyForBackend(
        { ...openaiOnly, convertOpenaiToAnthropic: true },
        { id: 'claude', kind: 'acp' },
        { protocolGatewayEnabled: false },
      ),
    ).toBe(false);
    expect(isProviderReadyForBackend({ anthropicUrl: 'https://example.com/anthropic' }, { id: 'claude', kind: 'acp' })).toBe(true);
  });
});

describe('服务商配置存储与排他绑定（ProviderStore）', () => {
  it('新增、更新、删除与绑定服务商时保证同一智能体不会同时绑定多个服务商，且不暴露密钥原文', () => {
    const first = upsertProviderSetting([], {
      name: '火山方舟',
      presetId: 'volcengine-coding',
      anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding/',
      openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3/',
      models: [{ id: 'ark-code-latest', name: 'Ark Code', efforts: ['low', 'high'], vision: true }],
      boundBackendIds: ['dsh', 'claude'],
      boundAgentIds: ['builtin-reviewer'],
    });
    expect(first.provider.anthropicUrl).toBe('https://ark.cn-beijing.volces.com/api/coding');
    expect(first.provider.defaultModel).toBe('ark-code-latest');

    // 新增第二个服务商并抢占 claude 与 builtin-reviewer 绑定
    const second = upsertProviderSetting(first.providers, {
      name: '智谱 GLM',
      presetId: 'zhipu-coding',
      anthropicUrl: 'https://open.bigmodel.cn/api/anthropic',
      models: [
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
      ],
      defaultModel: 'glm-5',
      smallModel: 'glm-4.5-air',
      boundBackendIds: ['claude', 'zcode'],
      boundAgentIds: ['builtin-reviewer'],
    });

    expect(providerForBackend(second.providers, 'dsh')?.name).toBe('火山方舟');
    expect(providerForBackend(second.providers, 'claude')?.name).toBe('智谱 GLM');
    expect(providerForBackend(second.providers, 'zcode')?.name).toBe('智谱 GLM');
    expect(second.providers[0]?.boundAgentIds).toBeUndefined();
    expect(second.providers[1]?.boundAgentIds).toEqual(['builtin-reviewer']);

    const rebound = bindProviderSetting(second.providers, second.provider.id, ['zcode'], []);
    expect(providerForBackend(rebound, 'claude')).toBeUndefined();
    expect(providerForBackend(rebound, 'zcode')?.name).toBe('智谱 GLM');

    const state = buildProvidersState(rebound, new Set([second.provider.id]), {
      protocolGatewayEnabled: true,
      protocolGatewayOrigin: 'http://127.0.0.1:43123',
    });
    expect(state.items[0]?.hasApiKey).toBe(false);
    expect(state.items[1]?.hasApiKey).toBe(true);
    expect(state.protocolGatewayEnabled).toBe(true);
    expect(state.protocolGatewayOrigin).toBe('http://127.0.0.1:43123');
    expect(JSON.stringify(state)).not.toContain('sk-');

    const opts = providerModelOptions(first.provider);
    expect(opts).toEqual([
      {
        provider: first.provider.id,
        model: 'ark-code-latest',
        name: 'Ark Code',
        group: '火山方舟',
        efforts: [
          { id: 'low', name: 'low' },
          { id: 'high', name: 'high' },
        ],
        defaultEffort: 'low',
      },
    ]);

    const afterDelete = deleteProviderSetting(rebound, first.provider.id);
    expect(afterDelete).toHaveLength(1);
    expect(parseProvidersSetting(afterDelete)[0]?.name).toBe('智谱 GLM');
  });
});

describe('本机回环代理与密钥隔离（ProviderProxy）', () => {
  const sampleProvider: ProviderConfig = {
    id: 'zhipu',
    name: '智谱 GLM',
    anthropicUrl: 'https://open.bigmodel.cn/api/anthropic',
    openaiChatUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: [{ id: 'glm-5' }, { id: 'glm-4.5-air' }],
    defaultModel: 'glm-5',
    smallModel: 'glm-4.5-air',
    boundBackendIds: ['claude'],
  };

  it('消除重复 /v1 路径并把未识别的默认/小模型名映射为服务商配置的模型', () => {
    expect(joinUpstreamUrl('https://ark.cn-beijing.volces.com/api/coding/v3', '/v1/chat/completions')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    );
    expect(joinUpstreamUrl('https://open.bigmodel.cn/api/anthropic', '/v1/messages', '?beta=true')).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true',
    );

    const haikuBody = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] }));
    expect(JSON.parse(rewriteModelInPayload(haikuBody, sampleProvider).toString('utf8')).model).toBe('glm-4.5-air');

    const sonnetBody = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }));
    expect(JSON.parse(rewriteModelInPayload(sonnetBody, sampleProvider).toString('utf8')).model).toBe('glm-5');

    const knownBody = Buffer.from(JSON.stringify({ model: 'glm-4.5-air', messages: [] }));
    expect(JSON.parse(rewriteModelInPayload(knownBody, sampleProvider).toString('utf8')).model).toBe('glm-4.5-air');
  });

  it('拦截未授权请求，向第三方上游注入真实 API Key（永不透传本地代理令牌）并支持流式转发', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    const proxy = new ProviderProxy({
      getProvider: (id) => (id === 'zhipu' ? sampleProvider : undefined),
      getApiKey: async (id) => (id === 'zhipu' ? 'real-secret-zhipu-key' : undefined),
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = init?.body ? Buffer.from(init.body as Uint8Array).toString('utf8') : '';
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"message_start"}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    try {
      await proxy.ensureStarted();
      const base = proxy.endpointFor('zhipu', 'anthropic');

      // 错误令牌返回 401
      const unauthorized = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'wrong-token' },
      });
      expect(unauthorized.status).toBe(401);

      // 正确本地代理令牌转发并替换为真实密钥
      const ok = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': proxy.token,
        },
        body: JSON.stringify({ model: 'claude-3-5-haiku-latest', stream: true }),
      });
      expect(ok.status).toBe(200);
      const text = await ok.text();
      expect(text).toContain('message_start');
      expect(capturedUrl).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
      expect(capturedHeaders['x-api-key']).toBe('real-secret-zhipu-key');
      expect(capturedHeaders.authorization).toBe('Bearer real-secret-zhipu-key');
      expect(JSON.stringify(capturedHeaders)).not.toContain(proxy.token);
      expect(JSON.parse(capturedBody).model).toBe('glm-4.5-air');
    } finally {
      await proxy.dispose();
    }
  });

  it('支持从服务商 /models 接口拉取模型列表与上下文参数', async () => {
    const models = await fetchRemoteProviderModels({
      openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: 'rk-test',
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/coding/v3/models');
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer rk-test');
        return new Response(
          JSON.stringify({
            data: [
              { id: 'ark-code-latest', display_name: 'Ark Auto', context_length: 256_000, max_output_tokens: 32_000, vision: true },
              { id: 'deepseek-v3.2', context_window: 128_000 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    expect(models).toEqual([
      { id: 'ark-code-latest', name: 'Ark Auto', contextWindow: '256k', maxOutputTokens: '32k', vision: true },
      { id: 'deepseek-v3.2', contextWindow: '128k' },
    ]);
  });
});

describe('智能体运行时注入适配（ProviderRuntime）', () => {
  const provider: ProviderConfig = {
    id: 'volcengine',
    name: '火山方舟',
    anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: [
      { id: 'ark-code-latest', name: 'Ark Code', contextWindow: '256k', maxOutputTokens: '32k', efforts: ['low', 'high'], vision: true },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', contextWindow: '128k', maxOutputTokens: '16k' },
    ],
    defaultModel: 'ark-code-latest',
    smallModel: 'deepseek-v3.2',
    boundBackendIds: ['dsh', 'claude', 'oh-my-pi', 'codebuddy', 'opencode'],
  };

  it('为 dsh、Claude Code、Pi、CodeBuddy 和 OpenCode 生成只含本地代理地址与代理令牌的运行配置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hd-provider-rt-'));
    const proxyOrigin = 'http://127.0.0.1:43123';
    const proxyToken = 'sk-hd-proxy-ephemeral';

    try {
      // 1. dsh
      const dshPatch = await prepareDshProviderRuntime(provider, proxyOrigin, proxyToken, dir);
      expect(dshPatch?.env).toEqual({ HARNESS_DECK_PROXY_TOKEN: proxyToken });
      expect(dshPatch?.defaultModel).toEqual({ provider: 'volcengine', model: 'ark-code-latest' });
      const patchYaml = await readFile(dshPatch!.launcherArgs[1]!, 'utf8');
      expect(patchYaml).toContain('http://127.0.0.1:43123/p/volcengine/openai-chat');
      expect(patchYaml).toContain('apiKeyEnv: HARNESS_DECK_PROXY_TOKEN');
      expect(patchYaml).toContain('contextWindow: 256000');

      // 2. Claude Code（清理宿主残留的 ANTHROPIC_* / CLAUDE_CODE_USE_* 变量）
      const claudePatch = await prepareAcpProviderRuntime({
        profile: { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', args: [] },
        provider,
        proxyOrigin,
        proxyToken,
        storageDir: dir,
        baseEnv: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'leaked', CLAUDE_CODE_USE_BEDROCK: '1' },
      });
      expect(claudePatch?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(claudePatch?.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(claudePatch?.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:43123/p/volcengine/anthropic');
      expect(claudePatch?.env.ANTHROPIC_API_KEY).toBe(proxyToken);
      expect(claudePatch?.env.ANTHROPIC_MODEL).toBe('ark-code-latest');
      expect(claudePatch?.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-v3.2');

      // 3. Pi (oh-my-pi)
      const ompPatch = await prepareAcpProviderRuntime({
        profile: { id: 'oh-my-pi', name: 'Pi', command: 'omp', args: ['acp'] },
        provider,
        proxyOrigin,
        proxyToken,
        storageDir: dir,
        baseEnv: { PATH: '/usr/bin' },
      });
      expect(ompPatch?.args).toEqual(['acp', '--model', 'volcengine/ark-code-latest']);
      const ompYaml = await readFile(join(ompPatch!.env.PI_CODING_AGENT_DIR!, 'models.yml'), 'utf8');
      expect(ompYaml).toContain(proxyToken);
      expect(ompYaml).toContain('http://127.0.0.1:43123/p/volcengine/anthropic');

      // 4. CodeBuddy
      const cbPatch = await prepareAcpProviderRuntime({
        profile: { id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy', args: ['--acp'] },
        provider,
        proxyOrigin,
        proxyToken,
        storageDir: dir,
        baseEnv: {},
      });
      expect(cbPatch?.args).toEqual(['--acp', '--model', 'ark-code-latest']);
      expect(cbPatch?.env.CODEBUDDY_BASE_URL).toBe('http://127.0.0.1:43123/p/volcengine/openai-chat');
      expect(cbPatch?.env.CODEBUDDY_API_KEY).toBe(proxyToken);

      // 5. OpenCode
      const ocPatch = await prepareAcpProviderRuntime({
        profile: { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] },
        provider,
        proxyOrigin,
        proxyToken,
        storageDir: dir,
        baseEnv: {},
      });
      const ocJson = JSON.parse(ocPatch!.env.OPENCODE_CONFIG_CONTENT!) as {
        model: string;
        small_model: string;
        provider: Record<string, { options: { baseURL: string; apiKey: string } }>;
      };
      expect(ocJson.model).toBe('volcengine/ark-code-latest');
      expect(ocJson.small_model).toBe('volcengine/deepseek-v3.2');
      expect(ocJson.provider.volcengine?.options).toEqual({
        baseURL: 'http://127.0.0.1:43123/p/volcengine/openai-chat',
        apiKey: proxyToken,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('本地协议转换网关（OpenAI 兼容 -> Claude Anthropic）', () => {
  const openaiOnlyProvider: ProviderConfig = {
    id: 'openai-only',
    name: 'OpenAI Compatible',
    openaiChatUrl: 'https://example.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: '128k', maxOutputTokens: '8k' },
      { id: 'deepseek-mini', name: 'DeepSeek Mini', contextWindow: '64k', maxOutputTokens: '4k' },
    ],
    defaultModel: 'deepseek-chat',
    smallModel: 'deepseek-mini',
    boundBackendIds: ['claude'],
  };

  it('默认关闭时不放行仅含 OpenAI 地址的 Claude Code 服务商，开启后注入本机 Anthropic 代理地址', () => {
    expect(
      prepareClaudeProviderRuntime({
        provider: openaiOnlyProvider,
        proxyOrigin: 'http://127.0.0.1:43123',
        proxyToken: 'tok-local',
        baseEnv: {},
        protocolGatewayEnabled: false,
      }),
    ).toBeUndefined();

    const enabledEnv = prepareClaudeProviderRuntime({
      provider: openaiOnlyProvider,
      proxyOrigin: 'http://127.0.0.1:43123',
      proxyToken: 'tok-local',
      baseEnv: {},
      protocolGatewayEnabled: true,
    });
    expect(enabledEnv?.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:43123/p/openai-only/anthropic');
    expect(enabledEnv?.env.ANTHROPIC_API_KEY).toBe('tok-local');
    expect(enabledEnv?.env.ANTHROPIC_MODEL).toBe('deepseek-chat');
    expect(enabledEnv?.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-mini');
  });

  it('网关关闭时拒绝无 Anthropic 地址的 /anthropic 请求；开启后支持非流式消息与工具调用双向转换以及 count_tokens', async () => {
    let gatewayEnabled = false;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const proxy = new ProviderProxy({
      getProvider: (id) => (id === 'openai-only' ? openaiOnlyProvider : undefined),
      getApiKey: async () => 'real-openai-key',
      isProtocolGatewayEnabled: () => gatewayEnabled,
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-123',
            model: 'deepseek-chat',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  reasoning_content: '先读一下文件。',
                  content: '我将读取该文件。',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'Read', arguments: '{"file_path":"src/index.ts"}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 42, completion_tokens: 18 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      await proxy.ensureStarted();
      const base = proxy.endpointFor('openai-only', 'anthropic');

      // 1. 默认关闭时返回 400
      const disabledRes = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(disabledRes.status).toBe(400);

      // 2. 开启后转换非流式请求与响应
      gatewayEnabled = true;
      const countRes = await fetch(`${base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ system: 'You are helpful.', messages: [{ role: 'user', content: 'Hello world' }] }),
      });
      expect(countRes.status).toBe(200);
      const countJson = (await countRes.json()) as { input_tokens: number };
      expect(countJson.input_tokens).toBeGreaterThan(0);

      const okRes = await fetch(`${base}/v1/messages?beta=true`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': proxy.token,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 64_000,
          system: [{ type: 'text', text: 'Be concise.' }],
          tools: [
            {
              name: 'Read',
              description: 'Read a file',
              input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
            },
          ],
          tool_choice: { type: 'auto' },
          messages: [
            { role: 'user', content: '查看入口文件' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_0', name: 'Read', input: { file_path: 'README.md' } }],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'hello' }],
            },
          ],
        }),
      });
      expect(okRes.status).toBe(200);
      expect(capturedUrl).toBe('https://example.com/v1/chat/completions?beta=true');
      expect(capturedHeaders.authorization).toBe('Bearer real-openai-key');
      expect(capturedHeaders['x-api-key']).toBeUndefined();
      expect(capturedHeaders['anthropic-version']).toBeUndefined();
      expect(capturedBody.model).toBe('deepseek-chat');
      expect(capturedBody.max_tokens).toBe(8_000);
      expect(capturedBody.tool_choice).toBe('auto');
      expect(capturedBody.messages).toEqual([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: '查看入口文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'Read', arguments: '{"file_path":"README.md"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'hello' },
      ]);

      const anthropicResp = (await okRes.json()) as {
        id: string;
        type: string;
        role: string;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
        content: { type: string; thinking?: string; text?: string; id?: string; name?: string; input?: unknown }[];
      };
      expect(anthropicResp.type).toBe('message');
      expect(anthropicResp.role).toBe('assistant');
      expect(anthropicResp.stop_reason).toBe('tool_use');
      expect(anthropicResp.usage).toEqual({ input_tokens: 42, output_tokens: 18 });
      expect(anthropicResp.content).toEqual([
        { type: 'thinking', thinking: '先读一下文件。', signature: 'hd-gateway' },
        { type: 'text', text: '我将读取该文件。' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'src/index.ts' } },
      ]);
    } finally {
      await proxy.dispose();
    }
  });

  it('开启后把 OpenAI 流式 SSE（含 thinking、text 与 tool_calls 增量）实时转换为 Anthropic SSE 事件流', async () => {
    const proxy = new ProviderProxy({
      getProvider: (id) => (id === 'openai-only' ? openaiOnlyProvider : undefined),
      getApiKey: async () => 'real-openai-key',
      isProtocolGatewayEnabled: () => true,
      fetchImpl: async () => {
        const encoder = new TextEncoder();
        const chunks = [
          'data: {"id":"chatcmpl-s1","model":"deepseek-chat","choices":[{"index":0,"delta":{"reasoning_content":"思考中"}}]}\n\n',
          'data: {"id":"chatcmpl-s1","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"答案如下："}}]}\n\n',
          'data: {"id":"chatcmpl-s1","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_s1","type":"function","function":{"name":"Bash","arguments":"{\\"cmd\\":"}}]}}]}\n\n',
          'data: {"id":"chatcmpl-s1","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":7}}\n\n',
          'data: [DONE]\n\n',
        ];
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    try {
      await proxy.ensureStarted();
      const base = proxy.endpointFor('openai-only', 'anthropic');
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          stream: true,
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'run ls' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const sseText = await res.text();
      expect(sseText).toContain('event: message_start');
      expect(sseText).toContain('"type":"thinking_delta","thinking":"思考中"');
      expect(sseText).toContain('"type":"signature_delta"');
      expect(sseText).toContain('"type":"text_delta","text":"答案如下："');
      expect(sseText).toContain('"type":"tool_use","id":"call_s1","name":"Bash"');
      expect(sseText).toContain('"type":"input_json_delta","partial_json":"{\\"cmd\\":"');
      expect(sseText).toContain('"type":"input_json_delta","partial_json":"\\"ls\\"}"');
      expect(sseText).toContain('"stop_reason":"tool_use"');
      expect(sseText).toContain('event: message_stop');
    } finally {
      await proxy.dispose();
    }
  });
});

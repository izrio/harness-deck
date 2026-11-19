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
import {
  prepareAcpProviderRuntime,
  prepareClaudeProviderRuntime,
  prepareDshProviderRuntime,
  writeClaudeProviderSettingsFile,
} from '../src/providers/ProviderRuntime.ts';
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
    expect(joinUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/openai', '/v1/chat/completions')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(
      joinUpstreamUrl('https://my-res.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-06-01', '/chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01');
    expect(joinUpstreamUrl('https://example.com/v1/responses', '/v1/responses')).toBe('https://example.com/v1/responses');
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
    expect(enabledEnv?.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
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
              input_schema: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: {
                  file_path: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                },
                required: ['file_path'],
              },
            },
            {
              name: 'EmptyArgsTool',
              input_schema: { type: 'object' },
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
      expect(capturedUrl).toBe('https://example.com/v1/chat/completions');
      expect(capturedHeaders.authorization).toBe('Bearer real-openai-key');
      expect(capturedHeaders['x-api-key']).toBeUndefined();
      expect(capturedHeaders['anthropic-version']).toBeUndefined();
      expect(capturedBody.model).toBe('deepseek-chat');
      expect(capturedBody.max_tokens).toBe(8_000);
      expect(capturedBody.tool_choice).toBe('auto');
      const sentTools = capturedBody.tools as { function: { name: string; parameters: Record<string, unknown> } }[];
      expect(sentTools[0]?.function.parameters.$schema).toBeUndefined();
      expect((sentTools[0]?.function.parameters.properties as Record<string, Record<string, unknown>>).url?.format).toBeUndefined();
      expect(sentTools[1]?.function.parameters).toEqual({ type: 'object', properties: {} });
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

  it('切换到新增的 OpenAI 模型时正确注入 NO_PROXY、映射选中模型并在双协议服务商下走协议转换', async () => {
    const mixedProvider: ProviderConfig = {
      id: 'mixed',
      name: 'Mixed Provider',
      anthropicUrl: 'https://anthropic.example.com',
      openaiChatUrl: 'https://openai.example.com/v1',
      models: [
        { id: 'glm-5', name: 'GLM-5' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      ],
      defaultModel: 'glm-5',
      smallModel: 'glm-5',
      boundBackendIds: ['claude'],
    };

    const runtime = prepareClaudeProviderRuntime({
      provider: mixedProvider,
      proxyOrigin: 'http://127.0.0.1:43123',
      proxyToken: 'tok-local',
      baseEnv: { HTTP_PROXY: 'http://127.0.0.1:7890' },
      protocolGatewayEnabled: true,
      selectedModel: 'gpt-4o',
    });
    expect(runtime?.env.ANTHROPIC_MODEL).toBe('gpt-4o');
    expect(runtime?.env.NO_PROXY).toContain('127.0.0.1');
    expect(runtime?.env.NO_PROXY).toContain('localhost');
    expect(runtime?.env.no_proxy).toContain('127.0.0.1');

    let selectedModel = 'gpt-4o';
    const capturedModels: string[] = [];
    const capturedUrls: string[] = [];
    const proxy = new ProviderProxy({
      getProvider: (id) => (id === 'mixed' ? mixedProvider : undefined),
      getApiKey: async () => 'real-key',
      getSelectedModel: () => selectedModel,
      isProtocolGatewayEnabled: () => true,
      fetchImpl: async (input, init) => {
        capturedUrls.push(String(input));
        const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as { model: string };
        capturedModels.push(body.model);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-m1',
            model: body.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      await proxy.ensureStarted();
      const base = proxy.endpointFor('mixed', 'anthropic');

      // 即使客户端发来旧默认模型 glm-5，也应映射到当前选中的 gpt-4o，并路由到 OpenAI Chat 接口
      const res1 = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'glm-5', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res1.status).toBe(200);
      expect(capturedUrls[0]).toBe('https://openai.example.com/v1/chat/completions');
      expect(capturedModels[0]).toBe('gpt-4o');

      // 选中名字里含 mini 的模型 gpt-4o-mini 时，不应被误判为小模型任务而覆盖
      selectedModel = 'gpt-4o-mini';
      const res2 = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res2.status).toBe(200);
      expect(capturedModels[1]).toBe('gpt-4o-mini');

      // 验证网关结构化日志已记录模型映射且可清空
      const logs = proxy.getLogs();
      expect(logs.length).toBe(2);
      expect(logs[1]).toMatchObject({
        providerId: 'mixed',
        converted: true,
        requestModel: 'glm-5',
        mappedModel: 'gpt-4o',
        status: 200,
        level: 'info',
      });
      proxy.clearLogs();
      expect(proxy.getLogs()).toHaveLength(0);
    } finally {
      await proxy.dispose();
    }
  });

  it('上游返回 max_tokens / stream_options 400 错误时自动降级重试，并兼容流式请求返回非流式 JSON 与记录错误日志', async () => {
    const providerNoCap: ProviderConfig = {
      id: 'openai-nocap',
      name: 'OpenAI No Cap',
      openaiChatUrl: 'https://api.openai-compat.example/v1',
      models: [{ id: 'gpt-4o' }],
      defaultModel: 'gpt-4o',
      boundBackendIds: ['claude'],
    };

    let attempt = 0;
    const sentBodies: Record<string, unknown>[] = [];
    const proxy = new ProviderProxy({
      getProvider: (id) => (id === 'openai-nocap' ? providerNoCap : undefined),
      getApiKey: async () => 'sk-real-secret-1234567890abcdef',
      isProtocolGatewayEnabled: () => true,
      fetchImpl: async (_input, init) => {
        attempt++;
        const parsed = JSON.parse(Buffer.from(init?.body as Uint8Array).toString('utf8')) as Record<string, unknown>;
        sentBodies.push(parsed);
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              error: { message: 'Invalid max_tokens: must be in range of [1, 8192]; stream_options unsupported' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        if (attempt === 2) {
          // 即使 stream=true，部分上游仍返回非流式 JSON，网关应自动包装为 Anthropic SSE
          return new Response(
            JSON.stringify({
              id: 'chatcmpl-wrap',
              model: 'gpt-4o',
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '兼容包装成功' } }],
              usage: { prompt_tokens: 12, completion_tokens: 4 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // 第三次模拟上游在 HTTP 200 包体内返回 error 字段
        return new Response(
          JSON.stringify({ error: { message: 'Upstream quota exceeded' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    try {
      await proxy.ensureStarted();
      const base = proxy.endpointFor('openai-nocap', 'anthropic');

      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          stream: true,
          max_tokens: 32_000,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const sseText = await res.text();
      expect(sseText).toContain('event: message_start');
      expect(sseText).toContain('"text":"兼容包装成功"');
      expect(sseText).toContain('event: message_stop');

      expect(sentBodies[0]?.max_tokens).toBe(16_384);
      expect(sentBodies[0]?.stream_options).toEqual({ include_usage: true });
      expect(sentBodies[1]?.max_tokens).toBe(8_192);
      expect(sentBodies[1]?.stream_options).toBeUndefined();

      // 验证上游返回 200 { error } 时不会静默输出空字符串，而是报错并记录 error 日志
      const errRes = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({
          model: 'gpt-4o',
          stream: false,
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      expect(errRes.status).toBe(502);
      const errBody = (await errRes.json()) as { error: { message: string } };
      expect(errBody.error.message).toContain('Upstream quota exceeded');

      const logs = proxy.getLogs();
      expect(logs.some((l) => l.level === 'warn' && l.message.includes('retrying'))).toBe(true);
      expect(logs.some((l) => l.level === 'error' && l.message.includes('Upstream quota exceeded'))).toBe(true);
      expect(JSON.stringify(logs)).not.toContain('sk-real-secret');
    } finally {
      await proxy.dispose();
    }
  });

  it('支持 OpenAI Responses API（含直连与 Chat 404/400 自动回退）、交错并行 tool_calls、延迟写头报错与注释前缀 SSE', async () => {
    const responsesOnlyProvider: ProviderConfig = {
      id: 'codex-resp',
      name: 'Codex Responses',
      openaiResponsesUrl: 'https://resp.example.com/v1',
      models: [{ id: 'gpt-5.3-codex' }],
      defaultModel: 'gpt-5.3-codex',
      boundBackendIds: ['claude'],
    };

    const chatWithFallbackProvider: ProviderConfig = {
      id: 'chat-fallback',
      name: 'Chat With Fallback',
      openaiChatUrl: 'https://api.example.com/v1',
      openaiResponsesUrl: 'https://api.example.com/v1',
      models: [{ id: 'custom-model' }],
      defaultModel: 'custom-model',
      boundBackendIds: ['claude'],
    };

    let scenario: 'responses-sse' | 'fallback-responses' | 'interleaved-tools' | 'empty-sse' | 'comment-sse' =
      'responses-sse';
    const seenUrls: string[] = [];

    const proxy = new ProviderProxy({
      getProvider: (id) =>
        id === 'codex-resp'
          ? responsesOnlyProvider
          : id === 'chat-fallback'
            ? chatWithFallbackProvider
            : id === 'openai-only'
              ? openaiOnlyProvider
              : undefined,
      getApiKey: async () => 'real-key',
      isProtocolGatewayEnabled: () => true,
      fetchImpl: async (input) => {
        const url = String(input);
        seenUrls.push(url);
        const encoder = new TextEncoder();

        if (scenario === 'responses-sse') {
          const events = [
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.3-codex"}}\n\n',
            'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"先思考"}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好世界"}\n\n',
            'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","call_id":"call_r1","type":"function_call","name":"Read"}}\n\n',
            'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":15,"output_tokens":9}}}\n\n',
          ];
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const ev of events) controller.enqueue(encoder.encode(ev));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }

        if (scenario === 'fallback-responses') {
          if (url.endsWith('/chat/completions')) {
            return new Response(
              JSON.stringify({ error: { message: 'This model is only supported in v1/responses and not in v1/chat/completions.' } }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              id: 'resp_fb',
              object: 'response',
              model: 'custom-model',
              output: [{ type: 'message', content: [{ type: 'output_text', text: '回退 Responses 成功' }] }],
              usage: { input_tokens: 8, output_tokens: 6 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (scenario === 'interleaved-tools') {
          const chunks = [
            // 工具 0 先发 id、后发 name，同时与工具 1 交错传输参数
            'data: {"id":"chatcmpl-t","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":""}}]}}]}\n\n',
            'data: {"id":"chatcmpl-t","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"Read","arguments":"{\\"a\\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"Glob","arguments":"{\\"b\\":"}}]}}]}\n\n',
            'data: {"id":"chatcmpl-t","model":"deepseek-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}},{"index":1,"function":{"arguments":"2}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const c of chunks) controller.enqueue(encoder.encode(c));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'Text/Event-Stream' } },
          );
        }

        if (scenario === 'empty-sse') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }

        // comment-sse（模拟 OpenRouter 首行注释 + 非标准 content-type）
        return new Response(
          ': OPENROUTER PROCESSING\n\ndata: {"id":"or-1","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"来自注释前缀流"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/plain' } },
        );
      },
    });

    try {
      await proxy.ensureStarted();

      // 1. 仅配置 openaiResponsesUrl 时直接走 /v1/responses 并实时转 Anthropic SSE
      scenario = 'responses-sse';
      const r1 = await fetch(`${proxy.endpointFor('codex-resp', 'anthropic')}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'gpt-5.3-codex', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r1.status).toBe(200);
      const t1 = await r1.text();
      expect(seenUrls.at(-1)).toBe('https://resp.example.com/v1/responses');
      expect(t1).toContain('"type":"thinking_delta","thinking":"先思考"');
      expect(t1).toContain('"type":"text_delta","text":"你好世界"');
      expect(t1).toContain('"type":"tool_use","id":"call_r1","name":"Read"');
      expect(t1).toContain('"stop_reason":"tool_use"');

      // 2. /chat/completions 返回仅支持 v1/responses 时自动回退到 /v1/responses
      scenario = 'fallback-responses';
      const r2 = await fetch(`${proxy.endpointFor('chat-fallback', 'anthropic')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'custom-model', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r2.status).toBe(200);
      const t2 = await r2.text();
      expect(t2).toContain('回退 Responses 成功');
      expect(seenUrls.slice(-2)).toEqual([
        'https://api.example.com/v1/chat/completions',
        'https://api.example.com/v1/responses',
      ]);

      // 3. 交错并行 tool_calls 与延迟 name 不丢参数
      scenario = 'interleaved-tools';
      const r3 = await fetch(`${proxy.endpointFor('openai-only', 'anthropic')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'deepseek-chat', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r3.status).toBe(200);
      const t3 = await r3.text();
      expect(t3).toContain('"type":"tool_use","id":"call_a","name":"Read"');
      expect(t3).toContain('"type":"tool_use","id":"call_b","name":"Glob"');
      expect(t3).toContain('"partial_json":"{\\"a\\":"');
      expect(t3).toContain('"partial_json":"1}"');
      expect(t3).toContain('"partial_json":"{\\"b\\":2}"');

      // 4. 上游返回空 SSE 流时返回 HTTP 502 错误 JSON 而非空 200 SSE
      scenario = 'empty-sse';
      const r4 = await fetch(`${proxy.endpointFor('openai-only', 'anthropic')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'deepseek-chat', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r4.status).toBe(502);
      const e4 = (await r4.json()) as { type: string; error: { message: string } };
      expect(e4.type).toBe('error');
      expect(e4.error.message).toContain('empty output');

      // 5. 首行带 `: comment` 且 content-type 为 text/plain 的 SSE 正确转换
      scenario = 'comment-sse';
      const r5 = await fetch(`${proxy.endpointFor('openai-only', 'anthropic')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'deepseek-chat', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r5.status).toBe(200);
      const t5 = await r5.text();
      expect(t5).toContain('来自注释前缀流');
    } finally {
      await proxy.dispose();
    }
  });

  it('生成 --settings 覆盖配置防止 ~/.claude/settings.json 劫持代理，不误将含 Flash 的已配置模型改写为小模型，并实时记录进行中日志', async () => {
    const acoProvider: ProviderConfig = {
      id: 'aco',
      name: 'aco',
      openaiChatUrl: 'http://aco.teg.cn/v1',
      convertOpenaiToAnthropic: true,
      models: [
        { id: 'DeepSeek-V4.1-Flash', contextWindow: '230000', maxOutputTokens: '32000' },
        { id: 'DeepSeek-V4-Flash-0731', contextWindow: '230000', maxOutputTokens: '32000' },
        { id: 'Qwen3.6-35B-A', contextWindow: '230000', maxOutputTokens: '32000' },
      ],
      defaultModel: 'DeepSeek-V4.1-Flash',
      smallModel: 'DeepSeek-V4-Flash-0731',
      boundBackendIds: ['claude', 'codebuddy'],
    };

    // 1. 大小写不敏感清理冲突环境变量，并生成 --settings 覆盖 JSON（中和 ~/.claude/settings.json 的旧 env）
    const adapted = prepareClaudeProviderRuntime({
      provider: acoProvider,
      proxyOrigin: 'http://127.0.0.1:56630',
      proxyToken: 'sk-hd-proxy-test',
      baseEnv: {
        PATH: '/usr/bin',
        anthropic_base_url: 'https://old.example.com',
        ANTHROPIC_AUTH_TOKEN: 'old-auth',
        CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth',
        No_Proxy: 'internal.corp',
      },
      protocolGatewayEnabled: true,
    });
    expect(adapted).toBeDefined();
    expect(adapted!.converted).toBe(true);
    expect(adapted!.env.anthropic_base_url).toBeUndefined();
    expect(adapted!.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(adapted!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(adapted!.env.No_Proxy).toBeUndefined();
    expect(adapted!.env.NO_PROXY).toContain('internal.corp');
    expect(adapted!.env.NO_PROXY).toContain('127.0.0.1');
    expect(adapted!.env.NO_PROXY).toContain('localhost');
    expect(adapted!.settingsEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:56630/p/aco/anthropic');
    expect(adapted!.settingsEnv.ANTHROPIC_API_KEY).toBe('sk-hd-proxy-test');
    expect(adapted!.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(adapted!.settingsEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('');

    const dir = await mkdtemp(join(tmpdir(), 'hd-claude-settings-'));
    try {
      const settingsPath = await writeClaudeProviderSettingsFile(dir, acoProvider.id, adapted!.settingsJson);
      const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as { env: Record<string, string> };
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:56630/p/aco/anthropic');
      expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // 2. 已配置主模型名称含 Flash 时，即使 selectedModel 切到其他模型，也不应被误判为小模型改写成 smallModel
    const flashBody = Buffer.from(JSON.stringify({ model: 'DeepSeek-V4.1-Flash', messages: [] }));
    expect(JSON.parse(rewriteModelInPayload(flashBody, acoProvider, 'Qwen3.6-35B-A').toString('utf8')).model).toBe(
      'Qwen3.6-35B-A',
    );
    expect(JSON.parse(rewriteModelInPayload(flashBody, acoProvider, 'DeepSeek-V4.1-Flash').toString('utf8')).model).toBe(
      'DeepSeek-V4.1-Flash',
    );
    // 未配置的 haiku 别名仍正确映射到 smallModel
    const haikuBody = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }));
    expect(JSON.parse(rewriteModelInPayload(haikuBody, acoProvider, 'Qwen3.6-35B-A').toString('utf8')).model).toBe(
      'DeepSeek-V4-Flash-0731',
    );

    // 3. 网关在上游请求进行中即实时写入日志条目，完成后原地更新不产生重复行
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    let inFlightLogsCount = 0;
    let inFlightMessage = '';
    const proxy = new ProviderProxy({
      getProvider: (id) => (id === 'aco' ? acoProvider : undefined),
      getApiKey: async () => 'real-aco-key',
      isProtocolGatewayEnabled: () => true,
      fetchImpl: async () => {
        const snapshot = proxy.getLogs();
        inFlightLogsCount = snapshot.length;
        inFlightMessage = snapshot[0]?.message ?? '';
        await upstreamGate;
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-live',
            model: 'DeepSeek-V4.1-Flash',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    try {
      await proxy.ensureStarted();
      const pendingReq = fetch(`${proxy.endpointFor('aco', 'anthropic')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': proxy.token },
        body: JSON.stringify({ model: 'DeepSeek-V4.1-Flash', stream: false, max_tokens: 128, messages: [{ role: 'user', content: 'ping' }] }),
      });
      // 等待上游回调触发后再放行
      await new Promise((r) => setTimeout(r, 30));
      releaseUpstream();
      const res = await pendingReq;
      expect(res.status).toBe(200);
      expect(inFlightLogsCount).toBe(1);
      expect(inFlightMessage).toContain('forwarding');
      // 完成后原地更新，总条数仍为 1
      const finalLogs = proxy.getLogs();
      expect(finalLogs).toHaveLength(1);
      expect(finalLogs[0]).toMatchObject({
        providerId: 'aco',
        converted: true,
        status: 200,
        level: 'info',
      });
    } finally {
      await proxy.dispose();
    }
  });
});

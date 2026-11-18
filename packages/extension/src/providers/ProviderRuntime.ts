/**
 * 将绑定的第三方服务商（ProviderConfig）与本机回环代理（ProviderProxy）适配到各底层智能体的启动环境与配置。
 *
 * 核心安全约束：传给智能体环境变量与临时配置文件的永远是本机回环代理地址与一次性本地令牌（`proxyToken`），
 * 用户的真实 API Key 绝不进入任何配置文件、进程环境变量、命令行参数或日志。
 */
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isProviderReadyForBackend,
  parseTokenLimit,
  type ProviderConfig,
  type ProviderModelItem,
  type ProviderProtocol,
} from '@harness-deck/shared';

export interface DshProviderLaunchPatch {
  readonly launcherArgs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly defaultModel?: { readonly provider: string; readonly model: string };
}

export interface AcpProviderLaunchPatch {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
}

function effectiveModels(provider: ProviderConfig): readonly ProviderModelItem[] {
  if (provider.models.length > 0) return provider.models;
  const fallback = provider.defaultModel?.trim() || 'default';
  return [{ id: fallback, name: fallback }];
}

function proxyUrl(proxyOrigin: string, providerId: string, protocol: ProviderProtocol): string {
  return `${proxyOrigin.replace(/\/+$/u, '')}/p/${encodeURIComponent(providerId)}/${protocol}`;
}

function mergeLoopbackNoProxy(raw: string | undefined): string {
  const parts = (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost']) {
    if (!parts.some((p) => p.toLowerCase() === host)) {
      parts.push(host);
    }
  }
  return parts.join(',');
}

function withLoopbackNoProxy(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const merged = mergeLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
  return {
    ...env,
    NO_PROXY: merged,
    no_proxy: merged,
  };
}

/** 生成 dsh 的 Cordis `--patch` YAML 内容（挂载到 `@deepseek-ai/dsh-llm-pi-ai`）。 */
export function buildDshPatchYaml(
  provider: ProviderConfig,
  proxyOrigin: string,
): { readonly yaml: string; readonly defaultModel?: { readonly provider: string; readonly model: string } } | undefined {
  let protocol: ProviderProtocol | undefined;
  let dshApi: 'openai-completions' | 'anthropic-messages' | 'openai-responses' | undefined;

  if (provider.openaiChatUrl?.trim()) {
    protocol = 'openai-chat';
    dshApi = 'openai-completions';
  } else if (provider.anthropicUrl?.trim()) {
    protocol = 'anthropic';
    dshApi = 'anthropic-messages';
  } else if (provider.openaiResponsesUrl?.trim()) {
    protocol = 'openai-responses';
    dshApi = 'openai-responses';
  }

  if (!protocol || !dshApi) return undefined;

  const models = effectiveModels(provider);
  const chosenDefault =
    (provider.defaultModel && models.some((m) => m.id === provider.defaultModel) ? provider.defaultModel : undefined) ??
    models[0]?.id;

  const lines: string[] = [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    `      ${JSON.stringify(provider.id)}:`,
    `        displayName: ${JSON.stringify(provider.name)}`,
    '        apiKeyEnv: HARNESS_DECK_PROXY_TOKEN',
    `        api: ${JSON.stringify(dshApi)}`,
    `        baseURL: ${JSON.stringify(proxyUrl(proxyOrigin, provider.id, protocol))}`,
    '        models:',
  ];

  for (const m of models) {
    const ctx = parseTokenLimit(m.contextWindow) ?? 128_000;
    const maxOut = parseTokenLimit(m.maxOutputTokens) ?? 16_384;
    lines.push(`          - id: ${JSON.stringify(m.id)}`);
    lines.push(`            name: ${JSON.stringify(m.name || m.id)}`);
    lines.push(`            contextWindow: ${ctx}`);
    lines.push(`            maxTokens: ${maxOut}`);
  }

  if (chosenDefault) {
    lines.push('- id: agent-default-model');
    lines.push('  config:');
    lines.push(`    provider: ${JSON.stringify(provider.id)}`);
    lines.push(`    model: ${JSON.stringify(chosenDefault)}`);
  }

  return {
    yaml: `${lines.join('\n')}\n`,
    ...(chosenDefault ? { defaultModel: { provider: provider.id, model: chosenDefault } } : {}),
  };
}

/** 为 dsh 底层准备 `--patch` 临时文件与本地代理令牌环境变量。 */
export async function prepareDshProviderRuntime(
  provider: ProviderConfig,
  proxyOrigin: string,
  proxyToken: string,
  storageDir: string,
): Promise<DshProviderLaunchPatch | undefined> {
  const built = buildDshPatchYaml(provider, proxyOrigin);
  if (!built) return undefined;
  await mkdir(storageDir, { recursive: true });
  const patchPath = join(storageDir, `dsh-provider-${provider.id}.patch.yml`);
  await writeFile(patchPath, built.yaml, 'utf8');
  return {
    launcherArgs: ['--patch', patchPath],
    env: { HARNESS_DECK_PROXY_TOKEN: proxyToken },
    ...(built.defaultModel ? { defaultModel: built.defaultModel } : {}),
  };
}

/** 生成原生 Pi (`pi --mode rpc`) 的 `models.json` 内容。 */
export function buildPiModelsJson(
  provider: ProviderConfig,
  proxyOrigin: string,
  proxyToken: string,
  existingProviders?: Readonly<Record<string, unknown>>,
): string | undefined {
  let protocol: ProviderProtocol | undefined;
  let piApi: 'anthropic-messages' | 'openai-completions' | 'openai-responses' | undefined;

  if (provider.anthropicUrl?.trim()) {
    protocol = 'anthropic';
    piApi = 'anthropic-messages';
  } else if (provider.openaiChatUrl?.trim()) {
    protocol = 'openai-chat';
    piApi = 'openai-completions';
  } else if (provider.openaiResponsesUrl?.trim()) {
    protocol = 'openai-responses';
    piApi = 'openai-responses';
  }
  if (!protocol || !piApi) return undefined;

  const models = effectiveModels(provider);
  const providerEntry = {
    baseUrl: proxyUrl(proxyOrigin, provider.id, protocol),
    api: piApi,
    apiKey: proxyToken,
    models: models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: parseTokenLimit(m.contextWindow) ?? 128_000,
      maxTokens: parseTokenLimit(m.maxOutputTokens) ?? 16_384,
      ...(m.efforts && m.efforts.length > 0 ? { reasoning: true } : {}),
      ...(m.vision ? { input: ['text', 'image'] } : {}),
    })),
  };

  return `${JSON.stringify(
    {
      providers: {
        ...(existingProviders ?? {}),
        [provider.id]: providerEntry,
      },
    },
    null,
    2,
  )}\n`;
}

/** 为原生 Claude Code (`claude -p`) 准备绑定服务商后的环境变量（剥离宿主冲突变量并注入本地代理地址与令牌）。 */
export function prepareClaudeProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly baseEnv: Record<string, string | undefined>;
  readonly protocolGatewayEnabled?: boolean;
  readonly selectedModel?: string;
}): { readonly env: Record<string, string | undefined> } | undefined {
  const { provider, proxyOrigin, proxyToken, baseEnv, protocolGatewayEnabled, selectedModel } = params;
  if (
    !isProviderReadyForBackend(
      provider,
      { id: 'claude', kind: 'claude', name: 'Claude Code' },
      { ...(protocolGatewayEnabled !== undefined ? { protocolGatewayEnabled } : {}) },
    )
  ) {
    return undefined;
  }
  const models = effectiveModels(provider);
  const validSelected =
    selectedModel && (provider.models.length === 0 || provider.models.some((m) => m.id === selectedModel))
      ? selectedModel
      : undefined;
  const defaultModel =
    validSelected ??
    (provider.defaultModel && models.some((m) => m.id === provider.defaultModel) ? provider.defaultModel : undefined) ??
    models[0]?.id;
  const smallModel =
    (provider.smallModel && models.some((m) => m.id === provider.smallModel) ? provider.smallModel : undefined) ??
    defaultModel;

  const cleanedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/u.test(k)) continue;
    cleanedEnv[k] = v;
  }
  cleanedEnv.ANTHROPIC_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'anthropic');
  cleanedEnv.ANTHROPIC_API_KEY = proxyToken;
  cleanedEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (defaultModel) {
    cleanedEnv.ANTHROPIC_MODEL = defaultModel;
    cleanedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = defaultModel;
    cleanedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultModel;
  }
  if (smallModel) {
    cleanedEnv.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
    cleanedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
  }
  return { env: withLoopbackNoProxy(cleanedEnv) };
}

/** 为原生 Pi (`pi --mode rpc`) 准备隔离的 `PI_CODING_AGENT_DIR` 与 `models.json` 配置。 */
export async function preparePiProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly storageDir: string;
  readonly baseEnv: Record<string, string | undefined>;
}): Promise<AcpProviderLaunchPatch | undefined> {
  const { provider, proxyOrigin, proxyToken, storageDir, baseEnv } = params;
  if (!isProviderReadyForBackend(provider, { id: 'pi', kind: 'pi', name: 'Pi' })) {
    return undefined;
  }
  const userPiDir = baseEnv.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  let existingProviders: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(join(userPiDir, 'models.json'), 'utf8');
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (parsed?.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
      existingProviders = parsed.providers as Record<string, unknown>;
    }
  } catch {
    // 用户尚未创建 ~/.pi/agent/models.json
  }

  const modelsJson = buildPiModelsJson(provider, proxyOrigin, proxyToken, existingProviders);
  if (!modelsJson) return undefined;

  const piDir = join(storageDir, `pi-agent-${provider.id}`);
  await mkdir(piDir, { recursive: true });
  await Promise.all([
    ensureSymlinkIfExists(join(userPiDir, 'sessions'), join(piDir, 'sessions'), true),
    ensureSymlinkIfExists(join(userPiDir, 'skills'), join(piDir, 'skills'), true),
    ensureSymlinkIfExists(join(userPiDir, 'settings.json'), join(piDir, 'settings.json'), false),
    ensureSymlinkIfExists(join(userPiDir, 'auth.json'), join(piDir, 'auth.json'), false),
  ]);
  await writeFile(join(piDir, 'models.json'), modelsJson, 'utf8');

  const models = effectiveModels(provider);
  const defaultModel =
    (provider.defaultModel && models.some((m) => m.id === provider.defaultModel) ? provider.defaultModel : undefined) ??
    models[0]?.id;
  const args = defaultModel ? ['--provider', provider.id, '--model', defaultModel] : [];
  return {
    args,
    env: {
      ...baseEnv,
      PI_CODING_AGENT_DIR: piDir,
    },
  };
}

/** 生成 oh-my-pi (`omp acp`) 的 `models.yml` 内容。 */
export function buildOmpModelsYaml(
  provider: ProviderConfig,
  proxyOrigin: string,
  proxyToken: string,
): string | undefined {
  let protocol: ProviderProtocol | undefined;
  let ompApi: 'anthropic-messages' | 'openai-completions' | 'openai-responses' | undefined;

  if (provider.anthropicUrl?.trim()) {
    protocol = 'anthropic';
    ompApi = 'anthropic-messages';
  } else if (provider.openaiChatUrl?.trim()) {
    protocol = 'openai-chat';
    ompApi = 'openai-completions';
  } else if (provider.openaiResponsesUrl?.trim()) {
    protocol = 'openai-responses';
    ompApi = 'openai-responses';
  }
  if (!protocol || !ompApi) return undefined;

  const models = effectiveModels(provider);
  const lines: string[] = [
    'providers:',
    `  ${JSON.stringify(provider.id)}:`,
    `    baseUrl: ${JSON.stringify(proxyUrl(proxyOrigin, provider.id, protocol))}`,
    `    api: ${JSON.stringify(ompApi)}`,
    `    apiKey: ${JSON.stringify(proxyToken)}`,
    '    models:',
  ];

  for (const m of models) {
    const ctx = parseTokenLimit(m.contextWindow) ?? 128_000;
    const maxOut = parseTokenLimit(m.maxOutputTokens) ?? 16_384;
    lines.push(`      - id: ${JSON.stringify(m.id)}`);
    lines.push(`        name: ${JSON.stringify(m.name || m.id)}`);
    lines.push(`        contextWindow: ${ctx}`);
    lines.push(`        maxTokens: ${maxOut}`);
    if (m.efforts && m.efforts.length > 0) {
      lines.push('        reasoning: true');
    }
    if (m.vision) {
      lines.push('        input: [text, image]');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function ensureSymlinkIfExists(src: string, dest: string, isDir: boolean): Promise<void> {
  try {
    await stat(src);
  } catch {
    return;
  }
  try {
    await stat(dest);
    return;
  } catch {
    // dest does not exist yet
  }
  try {
    await symlink(src, dest, isDir ? 'junction' : 'file');
  } catch {
    // 忽略无符号链接权限等平台差异
  }
}

/** 为 ACP 智能体准备绑定服务商后的启动参数与环境变量。 */
export async function prepareAcpProviderRuntime(params: {
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
  };
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly storageDir: string;
  readonly baseEnv: Record<string, string | undefined>;
  readonly protocolGatewayEnabled?: boolean;
}): Promise<AcpProviderLaunchPatch | undefined> {
  const { profile, provider, proxyOrigin, proxyToken, storageDir, baseEnv, protocolGatewayEnabled } = params;
  if (
    !isProviderReadyForBackend(
      provider,
      { id: profile.id, kind: 'acp', name: profile.name, executable: profile.command },
      { ...(protocolGatewayEnabled !== undefined ? { protocolGatewayEnabled } : {}) },
    )
  ) {
    return undefined;
  }

  const models = effectiveModels(provider);
  const defaultModel =
    (provider.defaultModel && models.some((m) => m.id === provider.defaultModel) ? provider.defaultModel : undefined) ??
    models[0]?.id;
  const smallModel =
    (provider.smallModel && models.some((m) => m.id === provider.smallModel) ? provider.smallModel : undefined) ??
    defaultModel;

  const idLower = profile.id.toLowerCase();
  const cmdHint = `${idLower} ${profile.command}`.toLowerCase();

  // 1. Claude Code (claude-agent-acp)
  if (idLower === 'claude' || /\bclaude\b/iu.test(cmdHint)) {
    const cleanedEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(baseEnv)) {
      if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/u.test(k)) continue;
      cleanedEnv[k] = v;
    }
    cleanedEnv.ANTHROPIC_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'anthropic');
    cleanedEnv.ANTHROPIC_API_KEY = proxyToken;
    cleanedEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (defaultModel) {
      cleanedEnv.ANTHROPIC_MODEL = defaultModel;
      cleanedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = defaultModel;
      cleanedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultModel;
    }
    if (smallModel) {
      cleanedEnv.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
      cleanedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
    }
    return { args: [...profile.args], env: withLoopbackNoProxy(cleanedEnv) };
  }

  // 2. Pi (oh-my-pi / omp acp)
  if (idLower === 'oh-my-pi' || /\bomp\b/iu.test(cmdHint)) {
    const yaml = buildOmpModelsYaml(provider, proxyOrigin, proxyToken);
    if (!yaml) return undefined;
    const ompDir = join(storageDir, `omp-agent-${provider.id}`);
    await mkdir(ompDir, { recursive: true });
    const userOmpDir = join(homedir(), '.omp', 'agent');
    await Promise.all([
      ensureSymlinkIfExists(join(userOmpDir, 'sessions'), join(ompDir, 'sessions'), true),
      ensureSymlinkIfExists(join(userOmpDir, 'skills'), join(ompDir, 'skills'), true),
      ensureSymlinkIfExists(join(userOmpDir, 'settings.json'), join(ompDir, 'settings.json'), false),
      ensureSymlinkIfExists(join(userOmpDir, 'auth.json'), join(ompDir, 'auth.json'), false),
    ]);
    await writeFile(join(ompDir, 'models.yml'), yaml, 'utf8');
    const nextArgs =
      defaultModel && !profile.args.includes('--model')
        ? [...profile.args, '--model', `${provider.id}/${defaultModel}`]
        : [...profile.args];
    return {
      args: nextArgs,
      env: withLoopbackNoProxy({
        ...baseEnv,
        PI_CODING_AGENT_DIR: ompDir,
      }),
    };
  }

  // 3. CodeBuddy (codebuddy --acp)
  if (idLower === 'codebuddy' || /\bcodebuddy\b/iu.test(cmdHint)) {
    const nextArgs =
      defaultModel && !profile.args.includes('--model')
        ? [...profile.args, '--model', defaultModel]
        : [...profile.args];
    return {
      args: nextArgs,
      env: withLoopbackNoProxy({
        ...baseEnv,
        CODEBUDDY_BASE_URL: proxyUrl(proxyOrigin, provider.id, 'openai-chat'),
        CODEBUDDY_API_KEY: proxyToken,
      }),
    };
  }

  // 4. OpenCode (opencode acp)
  if (idLower === 'opencode' || /\bopencode\b/iu.test(cmdHint)) {
    let protocol: ProviderProtocol | undefined;
    let npmAdapter = '@ai-sdk/openai-compatible';
    if (provider.openaiChatUrl?.trim()) {
      protocol = 'openai-chat';
      npmAdapter = '@ai-sdk/openai-compatible';
    } else if (provider.anthropicUrl?.trim()) {
      protocol = 'anthropic';
      npmAdapter = '@ai-sdk/anthropic';
    } else if (provider.openaiResponsesUrl?.trim()) {
      protocol = 'openai-responses';
      npmAdapter = '@ai-sdk/openai';
    }
    if (!protocol) return undefined;

    const base = proxyUrl(proxyOrigin, provider.id, protocol);
    const opencodeModels: Record<string, unknown> = {};
    for (const m of models) {
      const ctx = parseTokenLimit(m.contextWindow);
      const out = parseTokenLimit(m.maxOutputTokens);
      opencodeModels[m.id] = {
        name: m.name || m.id,
        ...((ctx || out)
          ? {
              limit: {
                ...(ctx ? { context: ctx } : {}),
                ...(out ? { output: out } : {}),
              },
            }
          : {}),
      };
    }
    const inlineConfig = {
      provider: {
        [provider.id]: {
          npm: npmAdapter,
          name: provider.name,
          options: {
            baseURL: protocol === 'anthropic' ? `${base}/v1` : base,
            apiKey: proxyToken,
          },
          models: opencodeModels,
        },
      },
      ...(defaultModel ? { model: `${provider.id}/${defaultModel}` } : {}),
      ...(smallModel ? { small_model: `${provider.id}/${smallModel}` } : {}),
    };
    return {
      args: [...profile.args],
      env: withLoopbackNoProxy({
        ...baseEnv,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
      }),
    };
  }

  // 5. 通用外部 ACP 智能体（如 Codex 等）
  const nextEnv: Record<string, string | undefined> = { ...baseEnv };
  const prefersResponses = /\bcodex\b/iu.test(cmdHint) && Boolean(provider.openaiResponsesUrl?.trim());
  if (prefersResponses) {
    nextEnv.OPENAI_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'openai-responses');
    nextEnv.OPENAI_API_KEY = proxyToken;
  } else if (provider.openaiChatUrl?.trim()) {
    nextEnv.OPENAI_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'openai-chat');
    nextEnv.OPENAI_API_KEY = proxyToken;
  } else if (provider.openaiResponsesUrl?.trim()) {
    nextEnv.OPENAI_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'openai-responses');
    nextEnv.OPENAI_API_KEY = proxyToken;
  }

  if (provider.anthropicUrl?.trim()) {
    nextEnv.ANTHROPIC_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'anthropic');
    nextEnv.ANTHROPIC_API_KEY = proxyToken;
    if (defaultModel) nextEnv.ANTHROPIC_MODEL ??= defaultModel;
    if (smallModel) nextEnv.ANTHROPIC_SMALL_FAST_MODEL ??= smallModel;
  }

  return {
    args: [...profile.args],
    env: withLoopbackNoProxy(nextEnv),
  };
}

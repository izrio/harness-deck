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
import { shouldConvertOpenaiToAnthropic } from './OpenaiToAnthropicConverter.ts';

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

function proxyUrl(
  proxyOrigin: string,
  providerId: string,
  protocol: ProviderProtocol,
  proxyScope?: string,
): string {
  const base = proxyOrigin.replace(/\/+$/u, '');
  const cleanScope = proxyScope?.trim();
  if (cleanScope) {
    return `${base}/s/${encodeURIComponent(cleanScope)}/p/${encodeURIComponent(providerId)}/${protocol}`;
  }
  return `${base}/p/${encodeURIComponent(providerId)}/${protocol}`;
}

function safeFileSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 80);
  return safe || 'default';
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
  const next: Record<string, string | undefined> = {};
  const existingValues: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === 'no_proxy') {
      if (v) existingValues.push(v);
      continue;
    }
    next[k] = v;
  }
  const merged = mergeLoopbackNoProxy(existingValues.join(','));
  next.NO_PROXY = merged;
  next.no_proxy = merged;
  return next;
}

const CLAUDE_CONFLICT_ENV_RE = /^(?:ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/iu;

/** 生成 dsh 的 Cordis `--patch` YAML 内容（挂载到 `@deepseek-ai/dsh-llm-pi-ai`）。 */
export function buildDshPatchYaml(
  provider: ProviderConfig,
  proxyOrigin: string,
  proxyScope?: string,
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
    `        baseURL: ${JSON.stringify(proxyUrl(proxyOrigin, provider.id, protocol, proxyScope))}`,
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
  proxyScope?: string,
): Promise<DshProviderLaunchPatch | undefined> {
  const built = buildDshPatchYaml(provider, proxyOrigin, proxyScope);
  if (!built) return undefined;
  await mkdir(storageDir, { recursive: true });
  const suffix = proxyScope?.trim()
    ? `${safeFileSegment(proxyScope)}-${safeFileSegment(provider.id)}`
    : safeFileSegment(provider.id);
  const patchPath = join(storageDir, `dsh-provider-${suffix}.patch.yml`);
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
  proxyScope?: string,
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
    baseUrl: proxyUrl(proxyOrigin, provider.id, protocol, proxyScope),
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

export interface ClaudeProviderRuntimePatch {
  readonly env: Record<string, string | undefined>;
  /** 通过 `--settings <file>` 注入的最高优先级 `env` 覆盖项，防止 `~/.claude/settings.json` 中的旧网关配置反过来覆盖本地代理。 */
  readonly settingsEnv: Readonly<Record<string, string>>;
  readonly settingsJson: string;
  readonly converted: boolean;
}

/** 为原生 Claude Code (`claude -p`) 准备绑定服务商后的环境变量与 `--settings` 覆盖配置（剥离宿主冲突变量并注入本地代理地址与令牌）。 */
export function prepareClaudeProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly baseEnv: Record<string, string | undefined>;
  readonly protocolGatewayEnabled?: boolean;
  readonly selectedModel?: string;
  readonly proxyScope?: string;
}): ClaudeProviderRuntimePatch | undefined {
  const { provider, proxyOrigin, proxyToken, baseEnv, protocolGatewayEnabled, selectedModel, proxyScope } = params;
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
    if (CLAUDE_CONFLICT_ENV_RE.test(k)) continue;
    cleanedEnv[k] = v;
  }

  const converted = shouldConvertOpenaiToAnthropic(
    provider,
    protocolGatewayEnabled === true,
    defaultModel,
    selectedModel,
  );
  const injected: Record<string, string> = {
    ANTHROPIC_BASE_URL: proxyUrl(proxyOrigin, provider.id, 'anthropic', proxyScope),
    ANTHROPIC_API_KEY: proxyToken,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (converted) {
    injected.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  }
  if (defaultModel) {
    injected.ANTHROPIC_MODEL = defaultModel;
    injected.ANTHROPIC_DEFAULT_SONNET_MODEL = defaultModel;
    injected.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultModel;
  }
  if (smallModel) {
    injected.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
    injected.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
  }

  const finalEnv = withLoopbackNoProxy({ ...cleanedEnv, ...injected });
  // 通过 --settings 显式覆盖 ~/.claude/settings.json（及项目 .claude/settings*.json）里残留的 env，
  // 避免用户此前在终端配置的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 劫持本地回环代理。
  const settingsEnv: Record<string, string> = {
    ...injected,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    CLAUDE_CODE_USE_FOUNDRY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ...(finalEnv.NO_PROXY ? { NO_PROXY: finalEnv.NO_PROXY, no_proxy: finalEnv.NO_PROXY } : {}),
  };
  const settingsJson = `${JSON.stringify({ env: settingsEnv }, null, 2)}\n`;
  return { env: finalEnv, settingsEnv, settingsJson, converted };
}

/** 将 Claude Code 的 `--settings` 临时覆盖配置写入运行目录（仅含本机回环地址与一次性本地代理令牌，不含真实 API Key）。 */
export async function writeClaudeProviderSettingsFile(
  storageDir: string,
  providerId: string,
  settingsJson: string,
  scopeSegment?: string,
): Promise<string> {
  await mkdir(storageDir, { recursive: true });
  const safeId = safeFileSegment(providerId);
  const safeScope = scopeSegment?.trim() ? `${safeFileSegment(scopeSegment)}-` : '';
  const filePath = join(storageDir, `claude-provider-${safeScope}${safeId}.settings.json`);
  await writeFile(filePath, settingsJson, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

/** 为原生 Pi (`pi --mode rpc`) 准备隔离的 `PI_CODING_AGENT_DIR` 与 `models.json` 配置。 */
export async function preparePiProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly storageDir: string;
  readonly baseEnv: Record<string, string | undefined>;
  readonly proxyScope?: string;
}): Promise<AcpProviderLaunchPatch | undefined> {
  const { provider, proxyOrigin, proxyToken, storageDir, baseEnv, proxyScope } = params;
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

  const modelsJson = buildPiModelsJson(provider, proxyOrigin, proxyToken, existingProviders, proxyScope);
  if (!modelsJson) return undefined;

  const dirSuffix = proxyScope?.trim()
    ? `${safeFileSegment(proxyScope)}-${safeFileSegment(provider.id)}`
    : safeFileSegment(provider.id);
  const piDir = join(storageDir, `pi-agent-${dirSuffix}`);
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
  proxyScope?: string,
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
    `    baseUrl: ${JSON.stringify(proxyUrl(proxyOrigin, provider.id, protocol, proxyScope))}`,
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
  readonly proxyScope?: string;
}): Promise<AcpProviderLaunchPatch | undefined> {
  const { profile, provider, proxyOrigin, proxyToken, storageDir, baseEnv, protocolGatewayEnabled, proxyScope } = params;
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
      if (CLAUDE_CONFLICT_ENV_RE.test(k)) continue;
      cleanedEnv[k] = v;
    }
    cleanedEnv.ANTHROPIC_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'anthropic', proxyScope);
    cleanedEnv.ANTHROPIC_API_KEY = proxyToken;
    cleanedEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (shouldConvertOpenaiToAnthropic(provider, protocolGatewayEnabled === true, defaultModel)) {
      cleanedEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
    }
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
    const yaml = buildOmpModelsYaml(provider, proxyOrigin, proxyToken, proxyScope);
    if (!yaml) return undefined;
    const dirSuffix = proxyScope?.trim()
      ? `${safeFileSegment(proxyScope)}-${safeFileSegment(provider.id)}`
      : safeFileSegment(provider.id);
    const ompDir = join(storageDir, `omp-agent-${dirSuffix}`);
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
        CODEBUDDY_BASE_URL: proxyUrl(proxyOrigin, provider.id, 'openai-chat', proxyScope),
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

    const base = proxyUrl(proxyOrigin, provider.id, protocol, proxyScope);
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
    nextEnv.OPENAI_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'openai-responses', proxyScope);
    nextEnv.OPENAI_API_KEY = proxyToken;
  } else if (provider.openaiChatUrl?.trim()) {
    nextEnv.OPENAI_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'openai-chat', proxyScope);
    nextEnv.OPENAI_API_KEY = proxyToken;
  } else if (provider.openaiResponsesUrl?.trim()) {
    nextEnv.OPENAI_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'openai-responses', proxyScope);
    nextEnv.OPENAI_API_KEY = proxyToken;
  }

  if (provider.anthropicUrl?.trim()) {
    nextEnv.ANTHROPIC_BASE_URL = proxyUrl(proxyOrigin, provider.id, 'anthropic', proxyScope);
    nextEnv.ANTHROPIC_API_KEY = proxyToken;
    if (defaultModel) nextEnv.ANTHROPIC_MODEL ??= defaultModel;
    if (smallModel) nextEnv.ANTHROPIC_SMALL_FAST_MODEL ??= smallModel;
  }

  return {
    args: [...profile.args],
    env: withLoopbackNoProxy(nextEnv),
  };
}

/**
 * 为原生 Codex（`codex app-server`）准备第三方服务商 `-c` 覆盖参数与代理令牌。
 * 优先使用 OpenAI Responses 接口，其次回退到 OpenAI Chat Completions 接口。
 */
export function prepareCodexProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly proxyScope?: string;
}): AcpProviderLaunchPatch | undefined {
  const { provider, proxyOrigin, proxyToken, baseEnv, proxyScope } = params;
  if (!isProviderReadyForBackend(provider, { id: 'codex', kind: 'codex' })) return undefined;

  let protocol: 'openai-responses' | 'openai-chat' | undefined;
  let wireApi: 'responses' | 'chat' | undefined;
  if (provider.openaiResponsesUrl?.trim()) {
    protocol = 'openai-responses';
    wireApi = 'responses';
  } else if (provider.openaiChatUrl?.trim()) {
    protocol = 'openai-chat';
    wireApi = 'chat';
  }
  if (!protocol || !wireApi) return undefined;

  const safeProviderKey = `hd_${provider.id.replace(/[^a-zA-Z0-9_-]+/gu, '_')}`;
  const baseUrl = proxyUrl(proxyOrigin, provider.id, protocol, proxyScope);
  const envKey = 'HARNESS_DECK_CODEX_API_KEY';
  const defaultModel = provider.defaultModel?.trim() || provider.models[0]?.id;

  const args: string[] = [
    '-c',
    `model_provider=${JSON.stringify(safeProviderKey)}`,
    '-c',
    `model_providers.${safeProviderKey}.name=${JSON.stringify(provider.name)}`,
    '-c',
    `model_providers.${safeProviderKey}.base_url=${JSON.stringify(baseUrl)}`,
    '-c',
    `model_providers.${safeProviderKey}.wire_api=${JSON.stringify(wireApi)}`,
    '-c',
    `model_providers.${safeProviderKey}.env_key=${JSON.stringify(envKey)}`,
  ];
  if (defaultModel) {
    args.push('-c', `model=${JSON.stringify(defaultModel)}`);
  }

  return {
    args,
    env: withLoopbackNoProxy({
      ...baseEnv,
      [envKey]: proxyToken,
    }),
  };
}

/** 生成原生 ZCode (`zcode app-server --stdio`) 的 `provider_config.json`（schemaVersion: 1）。 */
export function buildZcodeProviderConfigJson(
  provider: ProviderConfig,
  proxyOrigin: string,
  proxyToken: string,
  proxyScope?: string,
): string | undefined {
  let protocol: ProviderProtocol | undefined;
  let zcodeApiType: 'openai-chat-completions' | 'anthropic-messages' | 'openai-responses' | undefined;
  let maxTokensMap = '{"max_tokens": maxOutputTokens}';

  if (provider.openaiChatUrl?.trim()) {
    protocol = 'openai-chat';
    zcodeApiType = 'openai-chat-completions';
    maxTokensMap = '{"max_tokens": maxOutputTokens}';
  } else if (provider.anthropicUrl?.trim()) {
    protocol = 'anthropic';
    zcodeApiType = 'anthropic-messages';
    maxTokensMap = '{"max_tokens": maxOutputTokens}';
  } else if (provider.openaiResponsesUrl?.trim()) {
    protocol = 'openai-responses';
    zcodeApiType = 'openai-responses';
    maxTokensMap = '{"max_output_tokens": maxOutputTokens}';
  }
  if (!protocol || !zcodeApiType) return undefined;

  const models = effectiveModels(provider);
  const modelIds = models.map((m) => m.id);
  const defaultModel =
    (provider.defaultModel && modelIds.includes(provider.defaultModel) ? provider.defaultModel : undefined) ??
    modelIds[0];

  const payload = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: provider.id,
            templateId: null,
            providerName: provider.name || provider.id,
            enabled: true,
            config: {
              group: 'standard-personal',
              logo: null,
              access: {
                type: 'api-key',
                apiKey: proxyToken,
                apiKeyManagementUrl: null,
              },
              api: {
                type: zcodeApiType,
                baseUrl: proxyUrl(proxyOrigin, provider.id, protocol, proxyScope),
                headers: {},
              },
              personalModelIds: modelIds,
              modelOrder: modelIds,
              visibility: 'visible',
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: models.map((m) => {
          const ctx = parseTokenLimit(m.contextWindow) ?? 128_000;
          const maxOut = parseTokenLimit(m.maxOutputTokens) ?? 16_384;
          const efforts = [...new Set((m.efforts ?? []).map((e) => e.trim()).filter(Boolean))];
          return {
            providerId: provider.id,
            modelId: m.id,
            config: {
              enabled: true,
              properties: {
                contextWindow: ctx,
                inputFormat: {
                  supportsText: true,
                  supportsImage: m.vision === true,
                },
                outputFormat: {
                  supportsText: true,
                },
                supportsToolCall: true,
              },
              optionSpecs: {
                maxOutputTokens: {
                  max: maxOut,
                  map: maxTokensMap,
                },
                ...(efforts.length > 0
                  ? {
                      reasoningLevel: {
                        values: efforts,
                        map: 'reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}',
                      },
                    }
                  : {}),
              },
            },
          };
        }),
        manualProviderModelRules: [],
      },
      providerOrder: [provider.id],
      ...(defaultModel
        ? {
            defaultModelSelection: {
              providerId: provider.id,
              modelId: defaultModel,
            },
          }
        : {}),
    },
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** 为原生 ZCode (`zcode app-server --stdio`) 写入隔离的 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（仅含本机回环代理地址与一次性令牌）。 */
export async function prepareZcodeProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly storageDir: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly proxyScope?: string;
}): Promise<AcpProviderLaunchPatch | undefined> {
  const { provider, proxyOrigin, proxyToken, storageDir, baseEnv, proxyScope } = params;
  if (!isProviderReadyForBackend(provider, { id: 'zcode', kind: 'zcode', name: 'ZCode' })) {
    return undefined;
  }
  const configJson = buildZcodeProviderConfigJson(provider, proxyOrigin, proxyToken, proxyScope);
  if (!configJson) return undefined;

  await mkdir(storageDir, { recursive: true });
  const safeId = safeFileSegment(provider.id);
  const safeScope = proxyScope?.trim() ? `${safeFileSegment(proxyScope)}-` : '';
  const configPath = join(storageDir, `zcode-provider-${safeScope}${safeId}.json`);
  await writeFile(configPath, configJson, { encoding: 'utf8', mode: 0o600 });

  return {
    args: [],
    env: withLoopbackNoProxy({
      ...baseEnv,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: configPath,
    }),
  };
}

/**
 * 为原生 CodeBuddy（`codebuddy -p`）准备第三方服务商代理环境变量（OpenAI Chat Completions）。
 */
export function prepareCodebuddyProviderRuntime(params: {
  readonly provider: ProviderConfig;
  readonly proxyOrigin: string;
  readonly proxyToken: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly proxyScope?: string;
}): AcpProviderLaunchPatch | undefined {
  const { provider, proxyOrigin, proxyToken, baseEnv, proxyScope } = params;
  if (!isProviderReadyForBackend(provider, { id: 'codebuddy', kind: 'codebuddy' })) return undefined;
  return {
    args: [],
    env: withLoopbackNoProxy({
      ...baseEnv,
      CODEBUDDY_BASE_URL: proxyUrl(proxyOrigin, provider.id, 'openai-chat', proxyScope),
      CODEBUDDY_API_KEY: proxyToken,
    }),
  };
}

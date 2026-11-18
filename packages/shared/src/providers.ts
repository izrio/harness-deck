/**
 * 第三方模型服务商（Coding Plan 编程套餐与自定义网关）预设、协议能力矩阵与参数解析。
 * 纯数据与纯函数，供 Extension Host 与 Webview 共用。
 */
import type { ProviderModelItem, ProviderProtocol } from './viewModel.ts';

export interface ProviderPreset {
  readonly id: string;
  readonly badge: string;
  readonly nameZh: string;
  readonly nameEn: string;
  readonly descZh: string;
  readonly descEn: string;
  readonly verified: boolean;
  readonly anthropicUrl?: string;
  readonly openaiChatUrl?: string;
  readonly openaiResponsesUrl?: string;
  readonly models: readonly ProviderModelItem[];
  readonly defaultModel?: string;
  readonly smallModel?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'volcengine-coding',
    badge: '火',
    nameZh: '火山方舟',
    nameEn: 'Volcengine Ark',
    descZh: '火山引擎 Coding Plan（Doubao-Seed-Code / DeepSeek / GLM / Kimi）',
    descEn: 'Volcengine Ark Coding Plan (Doubao-Seed-Code, DeepSeek, GLM, Kimi)',
    verified: false,
    anthropicUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    openaiChatUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    openaiResponsesUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: [
      {
        id: 'ark-code-latest',
        name: 'Ark Code Latest (Auto)',
        contextWindow: '256k',
        maxOutputTokens: '32k',
        efforts: ['low', 'medium', 'high'],
        vision: true,
      },
      {
        id: 'doubao-seed-2.0-code',
        name: 'Doubao-Seed-2.0-Code',
        contextWindow: '256k',
        maxOutputTokens: '32k',
        efforts: ['low', 'medium', 'high'],
        vision: true,
      },
      {
        id: 'deepseek-v3.2',
        name: 'DeepSeek-V3.2',
        contextWindow: '128k',
        maxOutputTokens: '32k',
        efforts: ['low', 'high'],
        vision: false,
      },
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        contextWindow: '200k',
        maxOutputTokens: '64k',
        efforts: ['low', 'high'],
        vision: true,
      },
      {
        id: 'kimi-k2.5',
        name: 'Kimi-K2.5',
        contextWindow: '256k',
        maxOutputTokens: '32k',
        efforts: ['low', 'high'],
        vision: true,
      },
    ],
    defaultModel: 'ark-code-latest',
    smallModel: 'ark-code-latest',
  },
  {
    id: 'zhipu-coding',
    badge: '智',
    nameZh: '智谱 GLM',
    nameEn: 'Zhipu GLM',
    descZh: '智谱 BigModel 编程套餐（GLM-5 / GLM-4.7 / GLM-4.5-Air）',
    descEn: 'Zhipu BigModel Coding Plan (GLM-5, GLM-4.7, GLM-4.5-Air)',
    verified: false,
    anthropicUrl: 'https://open.bigmodel.cn/api/anthropic',
    openaiChatUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    openaiResponsesUrl: 'https://open.bigmodel.cn/api/v1',
    models: [
      {
        id: 'glm-5',
        name: 'GLM-5',
        contextWindow: '200k',
        maxOutputTokens: '128k',
        efforts: ['low', 'medium', 'high'],
        vision: true,
      },
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        contextWindow: '200k',
        maxOutputTokens: '128k',
        efforts: ['low', 'high'],
        vision: true,
      },
      {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        contextWindow: '128k',
        maxOutputTokens: '64k',
        efforts: [],
        vision: false,
      },
    ],
    defaultModel: 'glm-5',
    smallModel: 'glm-4.5-air',
  },
  {
    id: 'bailian-coding',
    badge: '百',
    nameZh: '阿里云百炼',
    nameEn: 'Alibaba Bailian',
    descZh: '百炼 Coding Plan 编程套餐（Qwen3-Coder / Qwen3-Max）',
    descEn: 'Alibaba Cloud Bailian Coding Plan (Qwen3-Coder, Qwen3-Max)',
    verified: false,
    anthropicUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    openaiChatUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    models: [
      {
        id: 'qwen3-coder-plus',
        name: 'Qwen3-Coder-Plus',
        contextWindow: '1M',
        maxOutputTokens: '64k',
        efforts: ['low', 'medium', 'high'],
        vision: false,
      },
      {
        id: 'qwen3-max',
        name: 'Qwen3-Max',
        contextWindow: '256k',
        maxOutputTokens: '32k',
        efforts: ['low', 'high'],
        vision: true,
      },
      {
        id: 'qwen-turbo-latest',
        name: 'Qwen-Turbo',
        contextWindow: '1M',
        maxOutputTokens: '16k',
        efforts: [],
        vision: false,
      },
    ],
    defaultModel: 'qwen3-coder-plus',
    smallModel: 'qwen-turbo-latest',
  },
  {
    id: 'kimi-coding',
    badge: 'K',
    nameZh: 'Kimi 编程套餐',
    nameEn: 'Kimi Coding Plan',
    descZh: '月之暗面 Kimi Code 会员编程接口（K3.1 Pro）',
    descEn: 'Moonshot Kimi Code subscription endpoint (K3.1 Pro)',
    verified: false,
    anthropicUrl: 'https://api.kimi.com/coding',
    openaiChatUrl: 'https://api.kimi.com/coding/v1',
    openaiResponsesUrl: 'https://api.kimi.com/coding/v1',
    models: [
      {
        id: 'k3.1-pro',
        name: 'Kimi K3.1 Pro',
        contextWindow: '1M',
        maxOutputTokens: '64k',
        efforts: ['low', 'medium', 'high'],
        vision: true,
      },
      {
        id: 'k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: '1M',
        maxOutputTokens: '64k',
        efforts: ['low', 'high'],
        vision: true,
      },
    ],
    defaultModel: 'k3.1-pro',
    smallModel: 'k3.1-pro-highspeed',
  },
  {
    id: 'minimax-coding',
    badge: 'M',
    nameZh: 'MiniMax',
    nameEn: 'MiniMax Coding',
    descZh: 'MiniMax M 系列编程套餐接口',
    descEn: 'MiniMax M-series Coding Plan endpoint',
    verified: false,
    anthropicUrl: 'https://api.minimaxi.com/anthropic',
    openaiChatUrl: 'https://api.minimaxi.com/v1',
    models: [
      {
        id: 'MiniMax-M2.5',
        name: 'MiniMax-M2.5',
        contextWindow: '200k',
        maxOutputTokens: '64k',
        efforts: ['low', 'high'],
        vision: false,
      },
      {
        id: 'MiniMax-M2.5-highspeed',
        name: 'MiniMax-M2.5-Highspeed',
        contextWindow: '200k',
        maxOutputTokens: '64k',
        efforts: [],
        vision: false,
      },
    ],
    defaultModel: 'MiniMax-M2.5',
    smallModel: 'MiniMax-M2.5-highspeed',
  },
  {
    id: 'cliproxyapi',
    badge: 'C',
    nameZh: 'CLIProxyAPI',
    nameEn: 'CLIProxyAPI',
    descZh: '本机的 CLIProxyAPI，默认端口 8317',
    descEn: 'Local CLIProxyAPI gateway, default port 8317',
    verified: false,
    anthropicUrl: 'http://127.0.0.1:8317',
    openaiChatUrl: 'http://127.0.0.1:8317/v1',
    openaiResponsesUrl: 'http://127.0.0.1:8317/v1',
    models: [],
  },
  {
    id: 'custom',
    badge: '+',
    nameZh: '自定义',
    nameEn: 'Custom',
    descZh: '自己填地址、Key 和模型',
    descEn: 'Enter your own URLs, API key and models',
    verified: true,
    models: [],
  },
];

/**
 * 解析类似 `200k`、`1M`、`128000` 的 token 数上限，不合法或留空时返回 undefined。
 */
export function parseTokenLimit(raw: string | number | undefined): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/,/gu, '');
  if (!trimmed) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/iu.exec(trimmed);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
  return Math.round(base * multiplier);
}

/** 将整数 token 数格式化为易读字符串（如 `128000` -> `128k`、`1000000` -> `1M`）。 */
export function formatTokenLimit(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}k`;
  }
  return String(Math.round(tokens));
}

/** 解析逗号分隔的思考档位输入（支持中英文逗号）。 */
export function parseEffortsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，]+/u)) {
    const clean = part.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export type BackendProtocolCapability =
  | { readonly kind: 'supported'; readonly protocols: readonly ProviderProtocol[] }
  | { readonly kind: 'account-only' };

/**
 * 判断某个底层智能体支持哪些第三方服务商协议。
 */
export function backendProtocolCapability(backend: {
  readonly id: string;
  readonly kind?: string;
  readonly name?: string;
  readonly command?: string;
  readonly executable?: string;
}): BackendProtocolCapability {
  const id = backend.id.toLowerCase();
  if (backend.kind === 'dsh' || id === 'dsh') {
    return { kind: 'supported', protocols: ['openai-chat', 'openai-responses', 'anthropic'] };
  }
  if (backend.kind === 'zcode' || id === 'zcode') {
    return { kind: 'supported', protocols: ['anthropic', 'openai-chat', 'openai-responses'] };
  }
  if (backend.kind === 'claude' || id === 'claude') {
    return { kind: 'supported', protocols: ['anthropic'] };
  }
  if (backend.kind === 'pi' || id === 'pi' || id === 'oh-my-pi') {
    return { kind: 'supported', protocols: ['openai-chat', 'openai-responses', 'anthropic'] };
  }
  if (id === 'opencode') {
    return { kind: 'supported', protocols: ['openai-chat', 'openai-responses', 'anthropic'] };
  }
  if (id === 'codebuddy') {
    return { kind: 'supported', protocols: ['openai-chat'] };
  }

  const hint = `${id} ${backend.name ?? ''} ${backend.executable ?? ''} ${backend.command ?? ''}`.toLowerCase();
  if (/\b(cursor|antigravity|gemini|kimi[-_\s]?code|kimi[-_\s]?cli)\b/iu.test(hint)) {
    return { kind: 'account-only' };
  }
  if (/\bcodex\b/iu.test(hint)) {
    return { kind: 'supported', protocols: ['openai-responses', 'openai-chat'] };
  }
  if (/\bclaude\b/iu.test(hint)) {
    return { kind: 'supported', protocols: ['anthropic'] };
  }
  return { kind: 'supported', protocols: ['openai-chat', 'openai-responses', 'anthropic'] };
}

export interface ProtocolReadinessOptions {
  readonly protocolGatewayEnabled?: boolean;
}

/** 该服务商是否可通过本地协议转换网关将 OpenAI Chat Completions 接口转换为 Anthropic 协议。 */
export function canProviderConvertOpenaiToAnthropic(
  provider: {
    readonly anthropicUrl?: string;
    readonly openaiChatUrl?: string;
    readonly convertOpenaiToAnthropic?: boolean;
  },
  options?: ProtocolReadinessOptions,
): boolean {
  if (options?.protocolGatewayEnabled === false) return false;
  const gatewayOn = options?.protocolGatewayEnabled === true || provider.convertOpenaiToAnthropic === true;
  return gatewayOn && Boolean(provider.openaiChatUrl?.trim());
}

/** 服务商是否已配置某个协议的连接地址（开启本地协议转换网关时，OpenAI Chat 接口也可满足 Anthropic 协议）。 */
export function providerHasProtocol(
  provider: {
    readonly anthropicUrl?: string;
    readonly openaiChatUrl?: string;
    readonly openaiResponsesUrl?: string;
    readonly convertOpenaiToAnthropic?: boolean;
  },
  protocol: ProviderProtocol,
  options?: ProtocolReadinessOptions,
): boolean {
  switch (protocol) {
    case 'anthropic':
      return Boolean(provider.anthropicUrl?.trim()) || canProviderConvertOpenaiToAnthropic(provider, options);
    case 'openai-chat':
      return Boolean(provider.openaiChatUrl?.trim());
    case 'openai-responses':
      return Boolean(provider.openaiResponsesUrl?.trim());
  }
}

/** 服务商已填写的连接地址是否满足指定底层智能体的协议要求。 */
export function isProviderReadyForBackend(
  provider: {
    readonly anthropicUrl?: string;
    readonly openaiChatUrl?: string;
    readonly openaiResponsesUrl?: string;
    readonly convertOpenaiToAnthropic?: boolean;
  },
  backend: {
    readonly id: string;
    readonly kind?: string;
    readonly name?: string;
    readonly command?: string;
    readonly executable?: string;
  },
  options?: ProtocolReadinessOptions,
): boolean {
  const cap = backendProtocolCapability(backend);
  if (cap.kind !== 'supported') return false;
  return cap.protocols.some((p) => providerHasProtocol(provider, p, options));
}

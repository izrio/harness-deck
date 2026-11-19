/**
 * OpenAI Chat Completions / Responses ↔ Claude (Anthropic Messages) 本地协议转换器：
 *
 * 当用户在设置中开启「本地协议转换网关（默认关闭）」且服务商配置了 OpenAI 兼容地址时，
 * 代理层将 Claude Code 发出的 Anthropic `/v1/messages`（及 `/v1/messages/count_tokens`）请求
 * 转换为 OpenAI `/v1/chat/completions` 或 `/v1/responses` 请求发往上游，再将非流式 JSON 或流式 SSE 响应
 * 实时转换回 Anthropic Messages 协议格式。
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { parseTokenLimit, type ProviderConfig } from '@harness-deck/shared';

export type OpenAiUpstreamMode = 'chat' | 'responses';

export interface ConvertedOpenAiRequest {
  readonly mode: OpenAiUpstreamMode;
  readonly body: Buffer;
  readonly requestModel: string;
  readonly model: string;
  readonly stream: boolean;
}

export interface StreamPipeSummary {
  readonly chunkCount: number;
  readonly hasOutput: boolean;
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly streamError?: string;
  readonly headersSent: boolean;
}

function stripOpenAiModelPrefix(model: string | undefined): string {
  return (model?.trim() ?? '').replace(/^openai\//iu, '');
}

export function isTypicalOpenAiModelId(model: string | undefined): boolean {
  const clean = stripOpenAiModelPrefix(model);
  if (!clean) return false;
  return /^(gpt-|chatgpt-|o[134](?:-|$)|codex-)/iu.test(clean);
}

export function isReasoningOpenAiModelId(model: string | undefined): boolean {
  const clean = stripOpenAiModelPrefix(model);
  if (!clean) return false;
  return /^(o[134](?:-|$)|gpt-5)/iu.test(clean);
}

export function isResponsesOnlyModelId(model: string | undefined): boolean {
  const clean = stripOpenAiModelPrefix(model);
  if (!clean) return false;
  return /(?:^codex-|-codex(?:$|-)|^(?:gpt-5(?:\.\d+)?-pro|o[134]-pro)(?:$|-))/iu.test(clean);
}

export function selectOpenAiUpstreamMode(
  provider: ProviderConfig,
  targetModel?: string,
): { readonly mode: OpenAiUpstreamMode; readonly baseUrl: string } | undefined {
  const chatUrl = provider.openaiChatUrl?.trim();
  const responsesUrl = provider.openaiResponsesUrl?.trim();
  if (!chatUrl && !responsesUrl) return undefined;
  if (!chatUrl && responsesUrl) {
    return { mode: 'responses', baseUrl: responsesUrl };
  }
  if (chatUrl && /\/responses(?:\?.*)?$/iu.test(chatUrl)) {
    return { mode: 'responses', baseUrl: chatUrl };
  }
  if (responsesUrl && isResponsesOnlyModelId(targetModel)) {
    return { mode: 'responses', baseUrl: responsesUrl };
  }
  return { mode: 'chat', baseUrl: chatUrl! };
}

/**
 * 判断指定服务商的 Anthropic 请求是否应由本地网关转换为 OpenAI 协议。
 * 全局网关未开启时始终返回 false。
 */
export function shouldConvertOpenaiToAnthropic(
  provider: ProviderConfig,
  protocolGatewayEnabled: boolean,
  reqModel?: string,
  selectedModel?: string,
): boolean {
  if (!protocolGatewayEnabled) return false;
  if (!provider.openaiChatUrl?.trim() && !provider.openaiResponsesUrl?.trim()) return false;
  if (!provider.anthropicUrl?.trim() || provider.convertOpenaiToAnthropic === true) return true;
  return isTypicalOpenAiModelId(reqModel) || isTypicalOpenAiModelId(selectedModel);
}

/**
 * 根据服务商配置与当前选定模型，把代理/智能体发来的模型别名映射为服务商侧真实模型 id。
 * 若无需替换则返回 undefined。
 */
export function resolveMappedProviderModel(
  reqModel: string,
  provider: ProviderConfig,
  selectedModel?: string,
): string | undefined {
  if (!reqModel) return undefined;
  const validSelected =
    selectedModel && (provider.models.length === 0 || provider.models.some((m) => m.id === selectedModel))
      ? selectedModel
      : undefined;
  if (validSelected && reqModel === validSelected) return undefined;

  const isKnownModel = provider.models.some((m) => m.id === reqModel);
  const hasSeparateSmall = Boolean(provider.smallModel && provider.smallModel !== provider.defaultModel);
  const isSmallTask =
    Boolean(hasSeparateSmall && reqModel === provider.smallModel) ||
    (!isKnownModel && /haiku|small|fast|flash|mini|turbo|air/iu.test(reqModel));

  if (validSelected) {
    if (isSmallTask) {
      const smallTarget = hasSeparateSmall ? provider.smallModel : validSelected;
      if (smallTarget && smallTarget !== reqModel) return smallTarget;
      return undefined;
    }
    return validSelected;
  }

  if (provider.models.some((m) => m.id === reqModel)) return undefined;
  if (provider.models.length === 0 && !provider.defaultModel) return undefined;

  const primaryTarget = provider.defaultModel ?? provider.models[0]?.id;
  const fallbackModel = isSmallTask ? (provider.smallModel ?? primaryTarget) : primaryTarget;
  if (!fallbackModel || fallbackModel === reqModel) return undefined;
  return fallbackModel;
}

/**
 * 本地估算 Anthropic `/v1/messages/count_tokens` 请求的输入 token 数，
 * 避免上游仅支持 OpenAI 协议时返回 404 导致 Claude Code 报错。
 */
export function estimateAnthropicTokens(rawBody: Buffer): { readonly input_tokens: number } {
  if (rawBody.length === 0) return { input_tokens: 1 };
  let charCount = rawBody.length;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const relevant = {
        ...(parsed.system !== undefined ? { system: parsed.system } : {}),
        ...(parsed.messages !== undefined ? { messages: parsed.messages } : {}),
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
      };
      charCount = JSON.stringify(relevant).length;
    }
  } catch {
    // 非法 JSON 时退回按原始字节长度估算
  }
  return { input_tokens: Math.max(1, Math.ceil(charCount / 3.5)) };
}

function extractTextFromBlocks(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const block of raw) {
    if (typeof block === 'string') {
      if (block) parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const obj = block as Record<string, unknown>;
    if ((obj.type === 'text' || obj.type === 'output_text' || obj.type === 'input_text') && typeof obj.text === 'string' && obj.text) {
      parts.push(obj.text);
    }
  }
  return parts.join('\n');
}

function extractReasoningText(obj: Record<string, unknown>): string {
  if (typeof obj.reasoning_content === 'string' && obj.reasoning_content) return obj.reasoning_content;
  if (typeof obj.reasoning === 'string' && obj.reasoning) return obj.reasoning;
  if (typeof obj.reasoning_text === 'string' && obj.reasoning_text) return obj.reasoning_text;
  if (typeof obj.thinking === 'string' && obj.thinking) return obj.thinking;
  if (Array.isArray(obj.reasoning_details)) {
    const parts: string[] = [];
    for (const item of obj.reasoning_details) {
      if (!item || typeof item !== 'object') continue;
      const detail = item as Record<string, unknown>;
      if (typeof detail.text === 'string' && detail.text) parts.push(detail.text);
      else if (typeof detail.summary === 'string' && detail.summary) parts.push(detail.summary);
    }
    return parts.join('');
  }
  return '';
}

function extractToolResultText(content: unknown, isError: boolean): string {
  if (typeof content === 'string') {
    return content || (isError ? 'Error' : '');
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (obj.type === 'text' && typeof obj.text === 'string') {
          parts.push(obj.text);
        } else if (obj.type === 'image') {
          parts.push('[Image]');
        } else {
          parts.push(JSON.stringify(obj));
        }
      }
    }
    const joined = parts.join('\n');
    return joined || (isError ? 'Error' : '');
  }
  if (content !== undefined && content !== null) {
    return JSON.stringify(content);
  }
  return isError ? 'Error' : '';
}

/**
 * 清理 Anthropic JSON Schema 中部分 OpenAI 兼容网关拒绝的扩展字段（如 `$schema`、`cache_control`、`format: "uri"`），
 * 并补齐无 `properties` 的 `type: "object"` 定义。
 */
export function sanitizeJsonSchemaForOpenAi(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const cleanNode = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(cleanNode);
    }
    if (!node || typeof node !== 'object') return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === '$schema' || k === 'cache_control') continue;
      if (k === 'format' && v === 'uri') continue;
      if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
        const cleanProps: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          cleanProps[pk] = cleanNode(pv);
        }
        out.properties = cleanProps;
        continue;
      }
      if ((k === '$defs' || k === 'definitions') && v && typeof v === 'object' && !Array.isArray(v)) {
        const cleanDefs: Record<string, unknown> = {};
        for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) {
          cleanDefs[dk] = cleanNode(dv);
        }
        out[k] = cleanDefs;
        continue;
      }
      out[k] = cleanNode(v);
    }
    if (out.type === 'object' && out.properties === undefined) {
      out.properties = {};
    }
    return out;
  };
  return cleanNode(schema) as Record<string, unknown>;
}

function convertAnthropicUserBlocks(
  blocks: readonly unknown[],
  outMessages: Record<string, unknown>[],
): void {
  const userParts: Record<string, unknown>[] = [];
  let hasImage = false;
  const textParts: string[] = [];

  for (const item of blocks) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'tool_result') {
      const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const content = extractToolResultText(block.content, block.is_error === true);
      outMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content,
      });
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      userParts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'document' && block.source && typeof block.source === 'object') {
      const src = block.source as Record<string, unknown>;
      if (src.type === 'text' && typeof src.data === 'string' && src.data) {
        textParts.push(src.data);
        userParts.push({ type: 'text', text: src.data });
      }
      continue;
    }
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const src = block.source as Record<string, unknown>;
      if (src.type === 'base64' && typeof src.data === 'string') {
        const mediaType = typeof src.media_type === 'string' && src.media_type ? src.media_type : 'image/png';
        hasImage = true;
        userParts.push({
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${src.data}` },
        });
      } else if (src.type === 'url' && typeof src.url === 'string') {
        hasImage = true;
        userParts.push({
          type: 'image_url',
          image_url: { url: src.url },
        });
      }
    }
  }

  if (hasImage && userParts.length > 0) {
    outMessages.push({ role: 'user', content: userParts });
  } else if (textParts.length > 0) {
    const joined = textParts.join('\n');
    if (joined.length > 0) {
      outMessages.push({ role: 'user', content: joined });
    }
  }
}

function convertAnthropicAssistantBlocks(
  blocks: readonly unknown[],
  outMessages: Record<string, unknown>[],
): void {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const item of blocks) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' && block.id ? block.id : `call_${toolCalls.length + 1}`;
      const name = typeof block.name === 'string' ? block.name : '';
      const args = block.input !== undefined ? JSON.stringify(block.input) : '{}';
      toolCalls.push({
        id,
        type: 'function',
        function: { name, arguments: args },
      });
    }
  }

  const text = textParts.join('\n');
  const thinking = thinkingParts.join('\n');
  const msg: Record<string, unknown> = {
    role: 'assistant',
    content: text || (toolCalls.length > 0 ? null : ''),
  };
  if (thinking) {
    msg.reasoning_content = thinking;
  }
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }
  outMessages.push(msg);
}

function clampMaxTokens(reqMax: unknown, provider: ProviderConfig, model: string): number | undefined {
  if (typeof reqMax !== 'number' || !Number.isFinite(reqMax) || reqMax <= 0) return undefined;
  const modelCfg = provider.models.find((m) => m.id === model);
  const maxCap = parseTokenLimit(modelCfg?.maxOutputTokens);
  const requestedMax = Math.round(reqMax);
  const effectiveCap = maxCap ?? 16_384;
  return requestedMax > effectiveCap ? effectiveCap : requestedMax;
}

/**
 * 将 Anthropic `/v1/messages` 请求体转换为 OpenAI `/v1/chat/completions` 请求体。
 */
export function convertAnthropicToOpenAiRequest(
  rawBody: Buffer,
  provider: ProviderConfig,
  selectedModel?: string,
): ConvertedOpenAiRequest {
  const parsedRaw = JSON.parse(rawBody.toString('utf8')) as unknown;
  if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
    throw new Error('Invalid Anthropic messages request JSON');
  }
  const req = parsedRaw as Record<string, unknown>;

  const reqModel = typeof req.model === 'string' ? req.model.trim() : '';
  const mappedModel = resolveMappedProviderModel(reqModel, provider, selectedModel);
  const model = mappedModel ?? reqModel;

  const messages: Record<string, unknown>[] = [];
  const systemText = extractTextFromBlocks(req.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  for (const item of Array.isArray(req.messages) ? req.messages : []) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      if (msg.content.length > 0 || role === 'assistant') {
        messages.push({ role, content: msg.content });
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    if (role === 'user') {
      convertAnthropicUserBlocks(msg.content, messages);
    } else {
      convertAnthropicAssistantBlocks(msg.content, messages);
    }
  }

  const out: Record<string, unknown> = {
    model,
    messages,
  };

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    const tools: Record<string, unknown>[] = [];
    for (const item of req.tools) {
      if (!item || typeof item !== 'object') continue;
      const tool = item as Record<string, unknown>;
      const name = typeof tool.name === 'string' ? tool.name.trim() : '';
      if (!name) continue;
      // 过滤 Anthropic 服务端内置工具（无 input_schema，如 web_search_20250305）
      if (!tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema)) {
        continue;
      }
      const description = typeof tool.description === 'string' && tool.description ? tool.description : undefined;
      tools.push({
        type: 'function',
        function: {
          name,
          ...(description ? { description } : {}),
          parameters: sanitizeJsonSchemaForOpenAi(tool.input_schema),
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (out.tools && req.tool_choice && typeof req.tool_choice === 'object' && !Array.isArray(req.tool_choice)) {
    const tc = req.tool_choice as Record<string, unknown>;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string' && tc.name) {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  const isReasoning = isReasoningOpenAiModelId(model);
  const clampedMax = clampMaxTokens(req.max_tokens, provider, model);
  if (clampedMax !== undefined) {
    if (isReasoning) {
      out.max_completion_tokens = clampedMax;
    } else {
      out.max_tokens = clampedMax;
    }
  }

  if (!isReasoning) {
    if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
      out.temperature = req.temperature;
    }
    if (typeof req.top_p === 'number' && Number.isFinite(req.top_p)) {
      out.top_p = req.top_p;
    }
  }
  if (Array.isArray(req.stop_sequences)) {
    const stops = req.stop_sequences.filter((s): s is string => typeof s === 'string');
    if (stops.length > 0) out.stop = stops;
  }

  const stream = req.stream === true;
  if (stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  return {
    mode: 'chat',
    body: Buffer.from(JSON.stringify(out), 'utf8'),
    requestModel: reqModel,
    model,
    stream,
  };
}

/**
 * 将 Anthropic `/v1/messages` 请求体转换为 OpenAI `/v1/responses` 请求体。
 */
export function convertAnthropicToOpenAiResponsesRequest(
  rawBody: Buffer,
  provider: ProviderConfig,
  selectedModel?: string,
): ConvertedOpenAiRequest {
  const parsedRaw = JSON.parse(rawBody.toString('utf8')) as unknown;
  if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
    throw new Error('Invalid Anthropic messages request JSON');
  }
  const req = parsedRaw as Record<string, unknown>;

  const reqModel = typeof req.model === 'string' ? req.model.trim() : '';
  const mappedModel = resolveMappedProviderModel(reqModel, provider, selectedModel);
  const model = mappedModel ?? reqModel;

  const input: Record<string, unknown>[] = [];
  for (const item of Array.isArray(req.messages) ? req.messages : []) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) {
        input.push({
          role,
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: msg.content }],
        });
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    if (role === 'user') {
      const userContent: Record<string, unknown>[] = [];
      for (const rawBlock of msg.content) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === 'tool_result') {
          const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          input.push({
            type: 'function_call_output',
            call_id: callId,
            output: extractToolResultText(block.content, block.is_error === true),
          });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          userContent.push({ type: 'input_text', text: block.text });
        } else if (block.type === 'document' && block.source && typeof block.source === 'object') {
          const src = block.source as Record<string, unknown>;
          if (src.type === 'text' && typeof src.data === 'string' && src.data) {
            userContent.push({ type: 'input_text', text: src.data });
          }
        } else if (block.type === 'image' && block.source && typeof block.source === 'object') {
          const src = block.source as Record<string, unknown>;
          if (src.type === 'base64' && typeof src.data === 'string') {
            const mediaType = typeof src.media_type === 'string' && src.media_type ? src.media_type : 'image/png';
            userContent.push({ type: 'input_image', image_url: `data:${mediaType};base64,${src.data}` });
          } else if (src.type === 'url' && typeof src.url === 'string') {
            userContent.push({ type: 'input_image', image_url: src.url });
          }
        }
      }
      if (userContent.length > 0) {
        input.push({ role: 'user', content: userContent });
      }
    } else {
      const assistantTexts: Record<string, unknown>[] = [];
      for (const rawBlock of msg.content) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          assistantTexts.push({ type: 'output_text', text: block.text });
        } else if (block.type === 'tool_use') {
          if (assistantTexts.length > 0) {
            input.push({ role: 'assistant', content: [...assistantTexts] });
            assistantTexts.length = 0;
          }
          const callId = typeof block.id === 'string' && block.id ? block.id : `call_${randomUUID().slice(0, 12)}`;
          const name = typeof block.name === 'string' ? block.name : '';
          const args = block.input !== undefined ? JSON.stringify(block.input) : '{}';
          input.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: args,
          });
        }
      }
      if (assistantTexts.length > 0) {
        input.push({ role: 'assistant', content: assistantTexts });
      }
    }
  }

  const out: Record<string, unknown> = {
    model,
    input,
    store: false,
  };

  const systemText = extractTextFromBlocks(req.system);
  if (systemText) {
    out.instructions = systemText;
  }

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    const tools: Record<string, unknown>[] = [];
    for (const item of req.tools) {
      if (!item || typeof item !== 'object') continue;
      const tool = item as Record<string, unknown>;
      const name = typeof tool.name === 'string' ? tool.name.trim() : '';
      if (!name) continue;
      if (!tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema)) {
        continue;
      }
      const description = typeof tool.description === 'string' && tool.description ? tool.description : undefined;
      tools.push({
        type: 'function',
        name,
        ...(description ? { description } : {}),
        parameters: sanitizeJsonSchemaForOpenAi(tool.input_schema),
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (out.tools && req.tool_choice && typeof req.tool_choice === 'object' && !Array.isArray(req.tool_choice)) {
    const tc = req.tool_choice as Record<string, unknown>;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string' && tc.name) {
      out.tool_choice = { type: 'function', name: tc.name };
    }
  }

  const clampedMax = clampMaxTokens(req.max_tokens, provider, model);
  if (clampedMax !== undefined) {
    out.max_output_tokens = clampedMax;
  }

  if (!isReasoningOpenAiModelId(model)) {
    if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
      out.temperature = req.temperature;
    }
    if (typeof req.top_p === 'number' && Number.isFinite(req.top_p)) {
      out.top_p = req.top_p;
    }
  }

  const stream = req.stream === true;
  if (stream) {
    out.stream = true;
  }

  return {
    mode: 'responses',
    body: Buffer.from(JSON.stringify(out), 'utf8'),
    requestModel: reqModel,
    model,
    stream,
  };
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return {};
    }
  }
  return {};
}

function mapFinishReason(finishReason: string, hasToolCalls: boolean): 'tool_use' | 'max_tokens' | 'end_turn' {
  if (finishReason === 'tool_calls' || finishReason === 'function_call' || hasToolCalls) {
    return 'tool_use';
  }
  if (finishReason === 'length' || finishReason === 'max_output_tokens') {
    return 'max_tokens';
  }
  return 'end_turn';
}

export function extractOpenAiErrorMessage(rawError: unknown): string | undefined {
  if (!rawError) return undefined;
  if (typeof rawError === 'string') return rawError.trim() || undefined;
  if (typeof rawError === 'object' && !Array.isArray(rawError)) {
    const obj = rawError as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
    if (obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)) {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === 'string' && inner.message.trim()) return inner.message.trim();
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return undefined;
    }
  }
  return String(rawError);
}

/**
 * 将 OpenAI `/v1/responses` 非流式 JSON 响应转换为 Anthropic Message JSON 响应。
 */
export function convertOpenAiResponsesToAnthropicResponse(
  resp: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  const respError = extractOpenAiErrorMessage(resp.error);
  if (respError || resp.status === 'failed') {
    throw new Error(respError ?? 'Upstream OpenAI Responses request failed');
  }

  const id =
    typeof resp.id === 'string' && resp.id
      ? resp.id
      : `msg_${randomUUID().replace(/-/gu, '')}`;
  const model =
    typeof resp.model === 'string' && resp.model
      ? resp.model
      : fallbackModel;

  const contentBlocks: Record<string, unknown>[] = [];
  let hasToolCalls = false;
  const outputs = Array.isArray(resp.output) ? resp.output : [];

  for (const rawItem of outputs) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === 'reasoning') {
      const parts: string[] = [];
      for (const list of [item.summary, item.content]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).text === 'string') {
            const text = (entry as Record<string, unknown>).text as string;
            if (text) parts.push(text);
          }
        }
      }
      const thinking = parts.join('\n');
      if (thinking) {
        contentBlocks.push({ type: 'thinking', thinking, signature: 'hd-gateway' });
      }
    } else if (item.type === 'message') {
      const text = extractTextFromBlocks(item.content);
      if (text) {
        contentBlocks.push({ type: 'text', text });
      }
    } else if (item.type === 'function_call') {
      hasToolCalls = true;
      const callId =
        (typeof item.call_id === 'string' && item.call_id) ||
        (typeof item.id === 'string' && item.id) ||
        `toolu_${randomUUID().slice(0, 12)}`;
      const name = typeof item.name === 'string' ? item.name : '';
      contentBlocks.push({
        type: 'tool_use',
        id: callId,
        name,
        input: parseToolArguments(item.arguments),
      });
    }
  }

  if (contentBlocks.length === 0 && typeof resp.output_text === 'string' && resp.output_text) {
    contentBlocks.push({ type: 'text', text: resp.output_text });
  }
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  const incomplete =
    resp.incomplete_details && typeof resp.incomplete_details === 'object'
      ? (resp.incomplete_details as Record<string, unknown>)
      : undefined;
  const finishReason =
    typeof incomplete?.reason === 'string' && incomplete.reason
      ? incomplete.reason
      : hasToolCalls
        ? 'tool_calls'
        : 'stop';

  const usage =
    resp.usage && typeof resp.usage === 'object'
      ? (resp.usage as Record<string, unknown>)
      : {};

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: mapFinishReason(finishReason, hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    },
  };
}

/**
 * 将 OpenAI `/v1/chat/completions`（或 `/v1/responses`）非流式 JSON 响应转换为 Anthropic Message JSON 响应。
 */
export function convertOpenAiToAnthropicResponse(
  openAiResp: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  if (openAiResp.object === 'response' || Array.isArray(openAiResp.output)) {
    return convertOpenAiResponsesToAnthropicResponse(openAiResp, fallbackModel);
  }

  const choices = Array.isArray(openAiResp.choices) ? openAiResp.choices : [];
  const respError = extractOpenAiErrorMessage(openAiResp.error);
  if (respError && choices.length === 0) {
    throw new Error(respError);
  }

  const id =
    typeof openAiResp.id === 'string' && openAiResp.id
      ? openAiResp.id
      : `msg_${randomUUID().replace(/-/gu, '')}`;
  const model =
    typeof openAiResp.model === 'string' && openAiResp.model
      ? openAiResp.model
      : fallbackModel;

  const choice0 =
    choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
  const message =
    choice0?.message && typeof choice0.message === 'object'
      ? (choice0.message as Record<string, unknown>)
      : {};

  const contentBlocks: Record<string, unknown>[] = [];
  const reasoning = extractReasoningText(message);
  if (reasoning) {
    contentBlocks.push({
      type: 'thinking',
      thinking: reasoning,
      signature: 'hd-gateway',
    });
  }

  if (typeof message.content === 'string' && message.content.length > 0) {
    contentBlocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    const text = extractTextFromBlocks(message.content);
    if (text) contentBlocks.push({ type: 'text', text });
  } else if (typeof choice0?.text === 'string' && choice0.text.length > 0) {
    contentBlocks.push({ type: 'text', text: choice0.text });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const rawTc of toolCalls) {
    if (!rawTc || typeof rawTc !== 'object') continue;
    const tc = rawTc as Record<string, unknown>;
    const fn = tc.function && typeof tc.function === 'object' ? (tc.function as Record<string, unknown>) : {};
    const tcId = typeof tc.id === 'string' && tc.id ? tc.id : `toolu_${randomUUID().slice(0, 12)}`;
    const tcName = typeof fn.name === 'string' ? fn.name : '';
    contentBlocks.push({
      type: 'tool_use',
      id: tcId,
      name: tcName,
      input: parseToolArguments(fn.arguments),
    });
  }

  if (toolCalls.length === 0 && message.function_call && typeof message.function_call === 'object') {
    const fc = message.function_call as Record<string, unknown>;
    const fcName = typeof fc.name === 'string' ? fc.name : '';
    if (fcName) {
      contentBlocks.push({
        type: 'tool_use',
        id: `toolu_${randomUUID().slice(0, 12)}`,
        name: fcName,
        input: parseToolArguments(fc.arguments),
      });
    }
  }

  if (contentBlocks.length === 0) {
    if (respError) throw new Error(respError);
    contentBlocks.push({ type: 'text', text: '' });
  }

  const hasToolCalls = contentBlocks.some((b) => b.type === 'tool_use');
  const finishReason = typeof choice0?.finish_reason === 'string' ? choice0.finish_reason : '';
  const usage =
    openAiResp.usage && typeof openAiResp.usage === 'object'
      ? (openAiResp.usage as Record<string, unknown>)
      : {};

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: mapFinishReason(finishReason, hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    },
  };
}

type ActiveBlock =
  | { readonly kind: 'thinking'; readonly blockIndex: number }
  | { readonly kind: 'text'; readonly blockIndex: number }
  | { readonly kind: 'tool_use'; readonly blockIndex: number; readonly toolKey: string };

interface ToolStreamState {
  blockIndex?: number;
  id: string;
  name: string;
  bufferedArgs: string[];
  emittedStart: boolean;
  emittedAnyArgs: boolean;
  closed: boolean;
}

const SSE_RESPONSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

export function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(200, SSE_RESPONSE_HEADERS);
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 将已转换好的非流式 Anthropic Message JSON 响应以 Anthropic SSE 事件流写入响应，
 * 用于兼容在 `stream: true` 时仍直接返回 JSON 的 OpenAI 上游服务商。
 */
export function writeAnthropicResponseAsSse(res: ServerResponse, anthropicResp: Record<string, unknown>): void {
  const id = typeof anthropicResp.id === 'string' ? anthropicResp.id : `msg_${randomUUID().replace(/-/gu, '')}`;
  const model = typeof anthropicResp.model === 'string' ? anthropicResp.model : '';
  const stopReason = typeof anthropicResp.stop_reason === 'string' ? anthropicResp.stop_reason : 'end_turn';
  const usage =
    anthropicResp.usage && typeof anthropicResp.usage === 'object'
      ? (anthropicResp.usage as Record<string, unknown>)
      : {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  const blocks = Array.isArray(anthropicResp.content) ? anthropicResp.content : [];
  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks[i];
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      const signature = typeof block.signature === 'string' ? block.signature : 'hd-gateway';
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'thinking', thinking: '' },
      });
      if (thinking) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'thinking_delta', thinking },
        });
      }
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'signature_delta', signature },
      });
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    } else if (block.type === 'tool_use') {
      const tcId = typeof block.id === 'string' ? block.id : `toolu_${i}`;
      const tcName = typeof block.name === 'string' ? block.name : '';
      const partialJson = JSON.stringify(block.input ?? {});
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: tcId, name: tcName, input: {} },
      });
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      });
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    } else if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      });
      if (text) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text },
        });
      }
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    }
  }

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  writeSseEvent(res, 'message_stop', { type: 'message_stop' });
}

/**
 * 判断纯文本响应体是否实际为 SSE 事件流（兼容首行含 `: comment`、`event:`、`id:`、`retry:` 的服务商，如 OpenRouter）。
 */
export function looksLikeSsePayload(rawText: string): boolean {
  const trimmed = rawText.trimStart();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return true;
  return /^(?:(?::|event:|id:|retry:)[^\n]*\r?\n)+\s*data:/u.test(trimmed);
}

/**
 * 将上游 OpenAI Chat Completions 或 Responses API SSE 字节流实时转换为 Anthropic Messages SSE 事件流写入响应。
 *
 * 采用延迟写头策略：仅在真正收到可输出内容（或明确的 finish_reason）时才提交 HTTP 200 SSE 响应头；
 * 若上游在首个有效输出前报错或返回空流，则保留 `res.headersSent === false`，便于代理层以标准 HTTP 502 JSON 错误返回给 Claude Code。
 */
export async function pipeOpenAiStreamToAnthropicSse(
  upstreamBody: ReadableStream<Uint8Array>,
  res: ServerResponse,
  fallbackModel: string,
): Promise<StreamPipeSummary> {
  let messageStarted = false;
  let messageId = `msg_${randomUUID().replace(/-/gu, '')}`;
  let messageModel = fallbackModel;
  let nextBlockIndex = 0;
  let activeBlock: ActiveBlock | undefined;
  let anyBlockOpened = false;
  let hasRealOutput = false;
  let sawToolCall = false;
  let finishReason = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let chunkCount = 0;
  let streamError: string | undefined;

  const toolStates = new Map<string, ToolStreamState>();
  const toolOrder: string[] = [];
  const responseItemKeyById = new Map<string, string>();
  let lastToolKey: string | undefined;

  const updateMeta = (chunkId?: unknown, chunkModel?: unknown): void => {
    if (!messageStarted) {
      if (typeof chunkId === 'string' && chunkId) messageId = chunkId;
      if (typeof chunkModel === 'string' && chunkModel) messageModel = chunkModel;
    }
  };

  const ensureMessageStart = (chunkId?: unknown, chunkModel?: unknown): void => {
    updateMeta(chunkId, chunkModel);
    if (messageStarted) return;
    messageStarted = true;
    writeSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: messageModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    });
  };

  const closeActiveBlock = (): void => {
    if (!activeBlock) return;
    if (activeBlock.kind === 'thinking') {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: activeBlock.blockIndex,
        delta: { type: 'signature_delta', signature: 'hd-gateway' },
      });
    } else if (activeBlock.kind === 'tool_use') {
      const state = toolStates.get(activeBlock.toolKey);
      if (state) {
        if (!state.emittedAnyArgs) {
          writeSseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: activeBlock.blockIndex,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          });
          state.emittedAnyArgs = true;
        }
        state.closed = true;
      }
    }
    writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: activeBlock.blockIndex,
    });
    activeBlock = undefined;
  };

  const openThinkingBlock = (): number => {
    ensureMessageStart();
    if (activeBlock?.kind === 'thinking') return activeBlock.blockIndex;
    closeActiveBlock();
    const blockIndex = nextBlockIndex++;
    anyBlockOpened = true;
    activeBlock = { kind: 'thinking', blockIndex };
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'thinking', thinking: '' },
    });
    return blockIndex;
  };

  const openTextBlock = (): number => {
    ensureMessageStart();
    if (activeBlock?.kind === 'text') return activeBlock.blockIndex;
    closeActiveBlock();
    const blockIndex = nextBlockIndex++;
    anyBlockOpened = true;
    activeBlock = { kind: 'text', blockIndex };
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    return blockIndex;
  };

  const emitThinkingDelta = (text: string): void => {
    if (!text) return;
    hasRealOutput = true;
    const idx = openThinkingBlock();
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'thinking_delta', thinking: text },
    });
  };

  const emitTextDelta = (text: string): void => {
    if (!text) return;
    hasRealOutput = true;
    const idx = openTextBlock();
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'text_delta', text },
    });
  };

  const activateToolState = (key: string, state: ToolStreamState): void => {
    if (state.emittedStart || state.closed) return;
    ensureMessageStart();
    closeActiveBlock();
    const blockIndex = nextBlockIndex++;
    state.blockIndex = blockIndex;
    state.emittedStart = true;
    anyBlockOpened = true;
    hasRealOutput = true;
    sawToolCall = true;
    activeBlock = { kind: 'tool_use', blockIndex, toolKey: key };
    writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
    });
    if (state.bufferedArgs.length > 0) {
      const joined = state.bufferedArgs.join('');
      state.bufferedArgs.length = 0;
      if (joined.length > 0) {
        state.emittedAnyArgs = true;
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: joined },
        });
      }
    }
  };

  const recordToolDelta = (params: {
    readonly key: string;
    readonly id?: string;
    readonly name?: string;
    readonly argsChunk?: string;
  }): void => {
    const { key, id, name, argsChunk } = params;
    let state = toolStates.get(key);
    const isNewOnSameKey = Boolean(state && id && state.id !== id);
    if (!state || isNewOnSameKey) {
      const effectiveKey = isNewOnSameKey ? `${key}:${id}` : key;
      state = {
        id: id ?? `toolu_${toolOrder.length}_${randomUUID().slice(0, 6)}`,
        name: name ?? '',
        bufferedArgs: [],
        emittedStart: false,
        emittedAnyArgs: false,
        closed: false,
      };
      toolStates.set(effectiveKey, state);
      toolOrder.push(effectiveKey);
      lastToolKey = effectiveKey;
      sawToolCall = true;
      hasRealOutput = true;
      if (argsChunk) state.bufferedArgs.push(argsChunk);
      // 仅当当前没有其他未关闭的工具块且已拿到工具名时立即实时流式输出，否则暂存待活跃块关闭后顺序冲刷
      const anotherToolActive = activeBlock?.kind === 'tool_use' && activeBlock.toolKey !== effectiveKey;
      if (!anotherToolActive && state.name) {
        activateToolState(effectiveKey, state);
      }
      return;
    }

    lastToolKey = key;
    sawToolCall = true;
    hasRealOutput = true;
    if (id && !state.emittedStart) state.id = id;
    if (name && !state.name) state.name = name;

    if (state.emittedStart && !state.closed && activeBlock?.kind === 'tool_use' && activeBlock.toolKey === key) {
      if (argsChunk) {
        state.emittedAnyArgs = true;
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.blockIndex!,
          delta: { type: 'input_json_delta', partial_json: argsChunk },
        });
      }
    } else if (!state.closed) {
      if (argsChunk) state.bufferedArgs.push(argsChunk);
      const anotherToolActive = activeBlock?.kind === 'tool_use' && activeBlock.toolKey !== key;
      if (!anotherToolActive && !state.emittedStart && state.name) {
        activateToolState(key, state);
      }
    }
  };

  const flushPendingToolCalls = (): void => {
    closeActiveBlock();
    for (const key of toolOrder) {
      const state = toolStates.get(key);
      if (!state || state.closed) continue;
      if (!state.emittedStart) {
        activateToolState(key, state);
      }
      closeActiveBlock();
    }
  };

  const processResponsesEvent = (chunk: Record<string, unknown>): boolean => {
    const evType = typeof chunk.type === 'string' ? chunk.type : '';
    if (!evType.startsWith('response.') && evType !== 'error') return false;

    if (evType === 'error') {
      const errMsg = extractOpenAiErrorMessage(chunk.error ?? chunk);
      if (errMsg) streamError = errMsg;
      return true;
    }

    const respObj =
      chunk.response && typeof chunk.response === 'object' ? (chunk.response as Record<string, unknown>) : undefined;
    if (respObj) {
      updateMeta(respObj.id, respObj.model);
      if (respObj.usage && typeof respObj.usage === 'object') {
        const u = respObj.usage as Record<string, unknown>;
        if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
        if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
      }
    }

    if (evType === 'response.failed') {
      const errMsg = extractOpenAiErrorMessage(respObj?.error ?? chunk.error ?? 'Upstream Responses stream failed');
      if (errMsg) streamError = errMsg;
      return true;
    }

    if (evType === 'response.completed' || evType === 'response.incomplete') {
      const incomplete =
        respObj?.incomplete_details && typeof respObj.incomplete_details === 'object'
          ? (respObj.incomplete_details as Record<string, unknown>)
          : undefined;
      if (typeof incomplete?.reason === 'string' && incomplete.reason) {
        finishReason = incomplete.reason;
      } else if (!finishReason) {
        finishReason = sawToolCall ? 'tool_calls' : 'stop';
      }
      return true;
    }

    if (
      evType === 'response.reasoning_summary_text.delta' ||
      evType === 'response.reasoning_text.delta' ||
      evType === 'response.reasoning.delta'
    ) {
      if (typeof chunk.delta === 'string' && chunk.delta) {
        emitThinkingDelta(chunk.delta);
      }
      return true;
    }

    if (evType === 'response.output_text.delta') {
      if (typeof chunk.delta === 'string' && chunk.delta) {
        emitTextDelta(chunk.delta);
      }
      return true;
    }

    if (evType === 'response.output_item.added') {
      const item = chunk.item && typeof chunk.item === 'object' ? (chunk.item as Record<string, unknown>) : undefined;
      if (item?.type === 'function_call') {
        const itemId = typeof item.id === 'string' && item.id ? item.id : undefined;
        const callId = (typeof item.call_id === 'string' && item.call_id) || itemId;
        const key = `resp:${callId ?? itemId ?? toolOrder.length}`;
        if (itemId) responseItemKeyById.set(itemId, key);
        if (callId) responseItemKeyById.set(callId, key);
        const name = typeof item.name === 'string' && item.name ? item.name : undefined;
        const args = typeof item.arguments === 'string' && item.arguments ? item.arguments : undefined;
        recordToolDelta({
          key,
          ...(callId ? { id: callId } : {}),
          ...(name ? { name } : {}),
          ...(args ? { argsChunk: args } : {}),
        });
      }
      return true;
    }

    if (evType === 'response.function_call_arguments.delta') {
      const itemId = typeof chunk.item_id === 'string' ? chunk.item_id : '';
      const key = responseItemKeyById.get(itemId) ?? lastToolKey ?? `resp:${itemId || toolOrder.length}`;
      const args = typeof chunk.delta === 'string' ? chunk.delta : '';
      if (args) {
        recordToolDelta({ key, argsChunk: args });
      }
      return true;
    }

    if (evType === 'response.function_call_arguments.done') {
      const itemId = typeof chunk.item_id === 'string' ? chunk.item_id : '';
      const key = responseItemKeyById.get(itemId) ?? lastToolKey;
      const state = key ? toolStates.get(key) : undefined;
      if (key && state && !state.emittedAnyArgs && state.bufferedArgs.length === 0) {
        const fullArgs = typeof chunk.arguments === 'string' ? chunk.arguments : '';
        if (fullArgs) recordToolDelta({ key, argsChunk: fullArgs });
      }
      if (key && activeBlock?.kind === 'tool_use' && activeBlock.toolKey === key) {
        closeActiveBlock();
      }
      return true;
    }

    if (evType === 'response.output_item.done') {
      const item = chunk.item && typeof chunk.item === 'object' ? (chunk.item as Record<string, unknown>) : undefined;
      if (item?.type === 'function_call') {
        const itemId = typeof item.id === 'string' && item.id ? item.id : undefined;
        const callId = (typeof item.call_id === 'string' && item.call_id) || itemId;
        const key = (itemId && responseItemKeyById.get(itemId)) || (callId && responseItemKeyById.get(callId)) || `resp:${callId ?? toolOrder.length}`;
        const existing = toolStates.get(key);
        if (!existing) {
          const name = typeof item.name === 'string' && item.name ? item.name : undefined;
          const args = typeof item.arguments === 'string' && item.arguments ? item.arguments : undefined;
          recordToolDelta({
            key,
            ...(callId ? { id: callId } : {}),
            ...(name ? { name } : {}),
            ...(args ? { argsChunk: args } : {}),
          });
        } else if (!existing.emittedAnyArgs && existing.bufferedArgs.length === 0 && typeof item.arguments === 'string' && item.arguments) {
          recordToolDelta({ key, argsChunk: item.arguments });
        }
        if (activeBlock?.kind === 'tool_use' && activeBlock.toolKey === key) {
          closeActiveBlock();
        }
      } else if (item?.type === 'message' && !hasRealOutput) {
        const text = extractTextFromBlocks(item.content);
        if (text) emitTextDelta(text);
      }
      return true;
    }

    return true;
  };

  const processDataPayload = (payloadText: string): void => {
    const trimmed = payloadText.trim();
    if (!trimmed || trimmed === '[DONE]') return;
    let chunk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      chunk = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    chunkCount++;
    if (processResponsesEvent(chunk)) return;

    if (chunk.error) {
      const errMsg = extractOpenAiErrorMessage(chunk.error);
      if (errMsg) streamError = errMsg;
    }

    if (chunk.usage && typeof chunk.usage === 'object') {
      const usage = chunk.usage as Record<string, unknown>;
      if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
      if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice0 =
      choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
    if (chunk.error && !choice0) return;

    updateMeta(chunk.id, chunk.model);
    if (!choice0) return;

    if (typeof choice0.finish_reason === 'string' && choice0.finish_reason) {
      finishReason = choice0.finish_reason;
    }

    const delta =
      choice0.delta && typeof choice0.delta === 'object'
        ? (choice0.delta as Record<string, unknown>)
        : choice0.message && typeof choice0.message === 'object'
          ? (choice0.message as Record<string, unknown>)
          : undefined;
    if (!delta) {
      if (typeof choice0.text === 'string' && choice0.text.length > 0) {
        emitTextDelta(choice0.text);
      }
      return;
    }

    const reasoning = extractReasoningText(delta);
    if (reasoning) {
      emitThinkingDelta(reasoning);
    }

    const deltaText =
      typeof delta.content === 'string'
        ? delta.content
        : Array.isArray(delta.content)
          ? extractTextFromBlocks(delta.content)
          : '';
    if (deltaText.length > 0) {
      emitTextDelta(deltaText);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (let arrIdx = 0; arrIdx < delta.tool_calls.length; arrIdx++) {
        const rawTc = delta.tool_calls[arrIdx];
        if (!rawTc || typeof rawTc !== 'object') continue;
        const tc = rawTc as Record<string, unknown>;
        const fn = tc.function && typeof tc.function === 'object' ? (tc.function as Record<string, unknown>) : {};
        const incomingId = typeof tc.id === 'string' && tc.id ? tc.id : undefined;
        const incomingName = typeof fn.name === 'string' && fn.name ? fn.name : undefined;
        const argsChunk =
          typeof fn.arguments === 'string'
            ? fn.arguments
            : fn.arguments && typeof fn.arguments === 'object'
              ? JSON.stringify(fn.arguments)
              : '';
        const key =
          typeof tc.index === 'number'
            ? `tc:${tc.index}`
            : incomingId
              ? `tc:${arrIdx}`
              : (lastToolKey ?? `tc:${arrIdx}`);
        recordToolDelta({
          key,
          ...(incomingId ? { id: incomingId } : {}),
          ...(incomingName ? { name: incomingName } : {}),
          ...(argsChunk ? { argsChunk } : {}),
        });
      }
    } else if (delta.function_call && typeof delta.function_call === 'object') {
      const fc = delta.function_call as Record<string, unknown>;
      const incomingName = typeof fc.name === 'string' && fc.name ? fc.name : undefined;
      const argsChunk =
        typeof fc.arguments === 'string'
          ? fc.arguments
          : fc.arguments && typeof fc.arguments === 'object'
            ? JSON.stringify(fc.arguments)
            : '';
      recordToolDelta({
        key: 'fc:0',
        ...(incomingName ? { name: incomingName } : {}),
        ...(argsChunk ? { argsChunk } : {}),
      });
    }
  };

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const rawNonSseLines: string[] = [];

  const flushEventLines = (): void => {
    if (dataLines.length === 0) return;
    const joined = dataLines.join('\n');
    dataLines = [];
    processDataPayload(joined);
  };

  const pushDataLine = (lineContent: string): void => {
    if (dataLines.length > 0) {
      const prev = dataLines.join('\n').trim();
      if (prev === '[DONE]') {
        flushEventLines();
      } else {
        try {
          JSON.parse(prev);
          flushEventLines();
        } catch {
          // 多行 JSON 尚未完整，继续拼接下一条 data 行
        }
      }
    }
    dataLines.push(lineContent);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).replace(/\r$/u, '');
        buffer = buffer.slice(nlIdx + 1);
        if (line === '') {
          flushEventLines();
          continue;
        }
        if (line.startsWith('data:')) {
          pushDataLine(line.slice(5).trimStart());
        } else if (!line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('id:') && !line.startsWith('retry:')) {
          rawNonSseLines.push(line);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const rawLine of buffer.split(/\r?\n/u)) {
        const line = rawLine.replace(/\r$/u, '');
        if (line === '') {
          flushEventLines();
        } else if (line.startsWith('data:')) {
          pushDataLine(line.slice(5).trimStart());
        } else if (!line.startsWith(':') && !line.startsWith('event:') && !line.startsWith('id:') && !line.startsWith('retry:')) {
          rawNonSseLines.push(line);
        }
      }
    }
    flushEventLines();
    if (chunkCount === 0 && rawNonSseLines.length > 0) {
      processDataPayload(rawNonSseLines.join('\n'));
    }
  } finally {
    reader.releaseLock();
  }

  const summary = (): StreamPipeSummary => ({
    chunkCount,
    hasOutput: hasRealOutput,
    finishReason,
    inputTokens,
    outputTokens,
    ...(streamError ? { streamError } : {}),
    headersSent: res.headersSent,
  });

  if (res.destroyed || res.writableEnded) return summary();

  // 若在提交 HTTP 200 SSE 响应头前就出错或未收到任何有效输出与结束原因，
  // 留给上层代理以标准 HTTP 502 JSON 错误返回，避免向 Claude Code 发送空 SSE 导致 [ede_diagnostic]
  if (streamError && !res.headersSent) {
    return summary();
  }
  if (!hasRealOutput && !finishReason && !res.headersSent) {
    return summary();
  }

  if (streamError && res.headersSent) {
    flushPendingToolCalls();
    writeSseEvent(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: streamError },
    });
    if (messageStarted) {
      writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    }
    return summary();
  }

  ensureMessageStart();
  flushPendingToolCalls();
  if (!anyBlockOpened) {
    openTextBlock();
    closeActiveBlock();
  }

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapFinishReason(finishReason, sawToolCall),
      stop_sequence: null,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  });
  writeSseEvent(res, 'message_stop', { type: 'message_stop' });
  return summary();
}

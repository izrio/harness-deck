/**
 * OpenAI Chat Completions ↔ Claude (Anthropic Messages) 本地协议转换器：
 *
 * 当用户在设置中开启「本地协议转换网关（默认关闭）」且服务商配置了 OpenAI Chat Completions 地址时，
 * 代理层将 Claude Code 发出的 Anthropic `/v1/messages`（及 `/v1/messages/count_tokens`）请求
 * 转换为 OpenAI `/v1/chat/completions` 请求发往上游客服端，再将非流式 JSON 或流式 SSE 响应
 * 实时转换回 Anthropic Messages 协议格式。
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { parseTokenLimit, type ProviderConfig } from '@harness-deck/shared';

export interface ConvertedOpenAiRequest {
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
}

export function isTypicalOpenAiModelId(model: string | undefined): boolean {
  const clean = model?.trim();
  if (!clean) return false;
  return /^(gpt-|chatgpt-|o[134](?:-|$)|codex-)/iu.test(clean);
}

/**
 * 判断指定服务商的 Anthropic 请求是否应由本地网关转换为 OpenAI Chat Completions 协议。
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

  const hasSeparateSmall = Boolean(provider.smallModel && provider.smallModel !== provider.defaultModel);
  const isSmallTask =
    /haiku|small|fast|flash|mini|turbo|air/iu.test(reqModel) ||
    Boolean(hasSeparateSmall && reqModel === provider.smallModel);

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
    if (obj.type === 'text' && typeof obj.text === 'string' && obj.text) {
      parts.push(obj.text);
    }
  }
  return parts.join('\n');
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
          parameters: tool.input_schema,
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (req.tool_choice && typeof req.tool_choice === 'object' && !Array.isArray(req.tool_choice)) {
    const tc = req.tool_choice as Record<string, unknown>;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string' && tc.name) {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  if (typeof req.max_tokens === 'number' && Number.isFinite(req.max_tokens) && req.max_tokens > 0) {
    const modelCfg = provider.models.find((m) => m.id === model);
    const maxCap = parseTokenLimit(modelCfg?.maxOutputTokens);
    const requestedMax = Math.round(req.max_tokens);
    const effectiveCap = maxCap ?? 16_384;
    const clampedMax = requestedMax > effectiveCap ? effectiveCap : requestedMax;
    if (/^(o[134](?:-|$)|gpt-5)/iu.test(model)) {
      out.max_completion_tokens = clampedMax;
    } else {
      out.max_tokens = clampedMax;
    }
  }

  if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
    out.temperature = req.temperature;
  }
  if (typeof req.top_p === 'number' && Number.isFinite(req.top_p)) {
    out.top_p = req.top_p;
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
  if (finishReason === 'length') {
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
 * 将 OpenAI `/v1/chat/completions` 非流式 JSON 响应转换为 Anthropic Message JSON 响应。
 */
export function convertOpenAiToAnthropicResponse(
  openAiResp: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
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
  const reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : '';
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

  if (contentBlocks.length === 0) {
    if (respError) throw new Error(respError);
    contentBlocks.push({ type: 'text', text: '' });
  }

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
    stop_reason: mapFinishReason(finishReason, toolCalls.length > 0),
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
  readonly blockIndex: number;
  readonly id: string;
  readonly name: string;
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.destroyed || res.writableEnded) return;
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
 * 将上游 OpenAI Chat Completions SSE 字节流实时转换为 Anthropic Messages SSE 事件流写入响应。
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
  const toolStates = new Map<number, ToolStreamState>();
  const toolBlocksWithArgs = new Set<number>();

  const ensureMessageStart = (chunkId?: unknown, chunkModel?: unknown): void => {
    if (messageStarted) return;
    messageStarted = true;
    if (typeof chunkId === 'string' && chunkId) messageId = chunkId;
    if (typeof chunkModel === 'string' && chunkModel) messageModel = chunkModel;
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
    } else if (activeBlock.kind === 'tool_use' && !toolBlocksWithArgs.has(activeBlock.blockIndex)) {
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: activeBlock.blockIndex,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      });
    }
    writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: activeBlock.blockIndex,
    });
    activeBlock = undefined;
  };

  const openThinkingBlock = (): number => {
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
    if (chunk.error) {
      const errMsg = extractOpenAiErrorMessage(chunk.error);
      if (errMsg) streamError = errMsg;
    }

    if (chunk.usage && typeof chunk.usage === 'object') {
      const usage = chunk.usage as Record<string, unknown>;
      if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice0 =
      choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
    if (chunk.error && !choice0) return;

    ensureMessageStart(chunk.id, chunk.model);
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
        hasRealOutput = true;
        const idx = openTextBlock();
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: choice0.text },
        });
      }
      return;
    }

    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
    if (reasoning) {
      hasRealOutput = true;
      const idx = openThinkingBlock();
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }

    const deltaText =
      typeof delta.content === 'string'
        ? delta.content
        : Array.isArray(delta.content)
          ? extractTextFromBlocks(delta.content)
          : '';
    if (deltaText.length > 0) {
      hasRealOutput = true;
      const idx = openTextBlock();
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'text_delta', text: deltaText },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const rawTc of delta.tool_calls) {
        if (!rawTc || typeof rawTc !== 'object') continue;
        const tc = rawTc as Record<string, unknown>;
        const tcIdx = typeof tc.index === 'number' ? tc.index : 0;
        const fn = tc.function && typeof tc.function === 'object' ? (tc.function as Record<string, unknown>) : {};
        const incomingId = typeof tc.id === 'string' && tc.id ? tc.id : undefined;
        const incomingName = typeof fn.name === 'string' && fn.name ? fn.name : undefined;

        let toolState = toolStates.get(tcIdx);
        const isNewCallOnSameIndex = Boolean(toolState && incomingId && toolState.id !== incomingId);
        if (!toolState || isNewCallOnSameIndex) {
          closeActiveBlock();
          const blockIndex = nextBlockIndex++;
          anyBlockOpened = true;
          hasRealOutput = true;
          sawToolCall = true;
          const id = incomingId ?? `toolu_${blockIndex}_${randomUUID().slice(0, 6)}`;
          const name = incomingName ?? '';
          toolState = { blockIndex, id, name };
          toolStates.set(tcIdx, toolState);
          activeBlock = { kind: 'tool_use', blockIndex, toolKey: `${tcIdx}:${id}` };
          writeSseEvent(res, 'content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
          });
        } else if (activeBlock?.kind !== 'tool_use' || activeBlock.blockIndex !== toolState.blockIndex) {
          // 防止非活跃块在未重新开始时收到 delta
          continue;
        }

        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          toolBlocksWithArgs.add(toolState.blockIndex);
          writeSseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: toolState.blockIndex,
            delta: { type: 'input_json_delta', partial_json: fn.arguments },
          });
        }
      }
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
  });

  if (res.destroyed || res.writableEnded) return summary();

  if (streamError && !anyBlockOpened) {
    closeActiveBlock();
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
  if (!anyBlockOpened) {
    openTextBlock();
  }
  closeActiveBlock();

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

/**
 * 本机回环服务商代理（ProviderProxy）：
 *
 * - 监听 `127.0.0.1:0`，持有一个仅驻留内存的随机本地令牌（`sk-hd-proxy-...`）；
 * - 底层智能体（dsh、Claude Code、Pi、CodeBuddy 等）只拿到 `http://127.0.0.1:<port>/p/<providerId>/<protocol>` 与本地令牌；
 * - 真实 API Key 只保存在 VS Code 的 SecretStorage 里，由本代理在转发给上游服务商时注入请求头，
 *   绝不写入智能体的配置文件、命令行参数或日志。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  formatTokenLimit,
  type ProviderConfig,
  type ProviderGatewayLogEntry,
  type ProviderModelItem,
  type ProviderProtocol,
} from '@harness-deck/shared';
import { redactSecrets } from '../util/redact.ts';
import {
  convertAnthropicToOpenAiRequest,
  convertAnthropicToOpenAiResponsesRequest,
  convertOpenAiToAnthropicResponse,
  estimateAnthropicTokens,
  extractOpenAiErrorMessage,
  looksLikeSsePayload,
  pipeOpenAiStreamToAnthropicSse,
  resolveMappedProviderModel,
  selectOpenAiUpstreamMode,
  shouldConvertOpenaiToAnthropic,
  writeAnthropicResponseAsSse,
  writeSseEvent,
  type OpenAiUpstreamMode,
} from './OpenaiToAnthropicConverter.ts';
import { createProxyAwareFetch } from './proxyFetch.ts';

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
  'x-api-key',
]);

const MAX_GATEWAY_LOGS = 100;
const MAX_PARAM_RETRIES = 3;

export interface ProviderProxyOptions {
  readonly getProvider: (id: string) => ProviderConfig | undefined;
  readonly getApiKey: (id: string) => Promise<string | undefined>;
  /** 当前会话/工具为指定服务商选中的模型（按可选 `scope` 隔离不同工具与不同会话，避免模型串用）。 */
  readonly getSelectedModel?: (providerId: string, scope?: string) => string | undefined;
  /** 是否启用本地协议转换网关（将 OpenAI 兼容接口转换为 Claude Anthropic 协议，默认 false）。 */
  readonly isProtocolGatewayEnabled?: () => boolean;
  /** 可选 IDE HTTP 代理配置（供纯 Node.js Sidecar 环境访问上游外网接口）。 */
  readonly getHttpProxy?: () => string | undefined;
  readonly log?: (line: string) => void;
  /** 网关请求日志更新时触发。 */
  readonly onLogChange?: () => void;
  readonly fetchImpl?: FetchImpl;
}

/**
 * 拼接服务商配置的 Base URL 与智能体发来的子路径，自动消除重复斜杠、保留原有查询参数，
 * 并去重 `/v1`、`/v1beta/openai`、`/chat/completions` 或 `/responses` 等完整端点路径。
 */
export function joinUpstreamUrl(baseUrl: string, subPath: string, search = ''): string {
  const trimmedBase = baseUrl.trim();
  const qIdx = trimmedBase.indexOf('?');
  const baseNoQuery = (qIdx >= 0 ? trimmedBase.slice(0, qIdx) : trimmedBase).replace(/\/+$/u, '');
  const baseQuery = qIdx >= 0 ? trimmedBase.slice(qIdx + 1) : '';
  const extraQuery = search.startsWith('?') ? search.slice(1) : search;

  let cleanBase = baseNoQuery;
  let cleanSub = subPath.startsWith('/') ? subPath : `/${subPath}`;
  if (/\/chat\/completions$/iu.test(cleanBase) && /^\/(?:v1\/)?chat\/completions$/iu.test(cleanSub)) {
    cleanSub = '/';
  } else if (/\/responses$/iu.test(cleanBase) && /^\/(?:v1\/)?responses$/iu.test(cleanSub)) {
    cleanSub = '/';
  } else if (/\/chat\/completions$/iu.test(cleanBase) && /^\/(?:v1\/)?responses$/iu.test(cleanSub)) {
    cleanBase = cleanBase.replace(/\/chat\/completions$/iu, '');
    cleanSub = '/responses';
  } else if (/\/responses$/iu.test(cleanBase) && /^\/(?:v1\/)?chat\/completions$/iu.test(cleanSub)) {
    cleanBase = cleanBase.replace(/\/responses$/iu, '');
    cleanSub = '/chat/completions';
  } else if (/(?:\/v\d+(?:(?:alpha|beta)\d*)?|\/openai)$/iu.test(cleanBase) && /^\/v1(\/|$)/iu.test(cleanSub)) {
    // 若 Base URL 已以 /v1、/v3、/v4、/v1beta 或 /openai 结尾，而客户端又拼了 /v1/...，去重 /v1
    cleanSub = cleanSub.slice(3) || '/';
  }

  const joined = cleanSub === '/' ? cleanBase : `${cleanBase}${cleanSub}`;
  const mergedParams = new URLSearchParams(baseQuery);
  if (extraQuery) {
    for (const [k, v] of new URLSearchParams(extraQuery).entries()) {
      mergedParams.set(k, v);
    }
  }
  const finalQuery = mergedParams.toString();
  return finalQuery ? `${joined}?${finalQuery}` : joined;
}

/** 剥离仅适用于 Anthropic 接口的查询参数（例如 Claude Code 固定附加的 `?beta=true`），避免 OpenAI 网关拒收。 */
function stripAnthropicSearchParams(search: string): string {
  if (!search) return '';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete('beta');
  const next = params.toString();
  return next ? `?${next}` : '';
}

/**
 * 当智能体发来的请求体 `model` 不在服务商的模型列表里（例如 Claude Code 发 `claude-haiku-...` 生成标题、或发 `default`）时，
 * 按规则替换为服务商的 `smallModel` 或当前选中的模型 / `defaultModel`。
 */
export function rewriteModelInPayload(
  rawBody: Buffer,
  provider: ProviderConfig,
  selectedModel?: string,
): Buffer {
  return rewriteModelDetailsInPayload(rawBody, provider, selectedModel).body;
}

function rewriteModelDetailsInPayload(
  rawBody: Buffer,
  provider: ProviderConfig,
  selectedModel?: string,
): { readonly body: Buffer; readonly requestModel?: string; readonly mappedModel?: string } {
  if (rawBody.length === 0) return { body: rawBody };
  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (!val || typeof val !== 'object' || Array.isArray(val)) return { body: rawBody };
    parsed = val as Record<string, unknown>;
  } catch {
    return { body: rawBody };
  }

  const reqModel = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (provider.models.length === 0) {
    return {
      body: rawBody,
      ...(reqModel ? { requestModel: reqModel, mappedModel: reqModel } : {}),
    };
  }
  const fallbackModel = resolveMappedProviderModel(reqModel, provider, selectedModel);
  if (!fallbackModel) {
    return {
      body: rawBody,
      ...(reqModel ? { requestModel: reqModel, mappedModel: reqModel } : {}),
    };
  }
  parsed.model = fallbackModel;
  return {
    body: Buffer.from(JSON.stringify(parsed), 'utf8'),
    ...(reqModel ? { requestModel: reqModel } : {}),
    mappedModel: fallbackModel,
  };
}

function extractModelFromBody(rawBody: Buffer): string | undefined {
  if (rawBody.length === 0) return undefined;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isClientAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && safeTokenEquals(expectedToken, xApiKey.trim())) {
    return true;
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(auth.trim());
    if (match?.[1] && safeTokenEquals(expectedToken, match[1].trim())) {
      return true;
    }
  }
  return false;
}

function safeTokenEquals(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseRoute(pathname: string): {
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly subPath: string;
  readonly scope?: string;
} | undefined {
  const scopedMatch = /^\/s\/([^/]+)\/p\/([^/]+)\/(anthropic|openai-chat|openai-responses)(\/.*)?$/u.exec(pathname);
  if (scopedMatch) {
    return {
      scope: decodeURIComponent(scopedMatch[1]!),
      providerId: decodeURIComponent(scopedMatch[2]!),
      protocol: scopedMatch[3] as ProviderProtocol,
      subPath: scopedMatch[4] ?? '/',
    };
  }
  const match = /^\/p\/([^/]+)\/(anthropic|openai-chat|openai-responses)(\/.*)?$/u.exec(pathname);
  if (!match) return undefined;
  return {
    providerId: decodeURIComponent(match[1]!),
    protocol: match[2] as ProviderProtocol,
    subPath: match[3] ?? '/',
  };
}

function baseUrlForProtocol(provider: ProviderConfig, protocol: ProviderProtocol): string | undefined {
  switch (protocol) {
    case 'anthropic':
      return provider.anthropicUrl;
    case 'openai-chat':
      return provider.openaiChatUrl ?? provider.openaiResponsesUrl ?? provider.anthropicUrl;
    case 'openai-responses':
      return provider.openaiResponsesUrl ?? provider.openaiChatUrl ?? provider.anthropicUrl;
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks);
}

function buildForwardHeaders(rawHeaders: IncomingMessage['headers']): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    // 跳过压缩编码头，让 fetch 自动解码并以干净字节流回传客户端
    if (lower === 'accept-encoding') continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function buildOpenAiForwardHeaders(rawHeaders: IncomingMessage['headers'], stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'accept-encoding' ||
      lower === 'content-encoding' ||
      lower === 'accept' ||
      lower.startsWith('anthropic-') ||
      lower.startsWith('x-stainless-') ||
      lower.startsWith('x-claude-') ||
      lower === 'x-app' ||
      lower === 'user-agent' ||
      value === undefined
    ) {
      continue;
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['content-type'] = 'application/json';
  headers['accept'] = stream ? 'text/event-stream, application/json' : 'application/json';
  return headers;
}

function shouldFallbackToResponsesApi(status: number, errText: string, mode: OpenAiUpstreamMode): boolean {
  if (mode !== 'chat') return false;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /\/v1\/responses|\/responses\b|not a chat model|only supported in.*responses|does not support chat completions|use the responses api/iu.test(
    errText,
  );
}

function buildRetryOpenAiPayload(
  payloadBuf: Buffer,
  status: number,
  errText: string,
  mode: OpenAiUpstreamMode,
): { readonly body: Buffer; readonly reason: string } | undefined {
  if (status !== 400 && status !== 422) return undefined;
  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(payloadBuf.toString('utf8')) as unknown;
    if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
    parsed = val as Record<string, unknown>;
  } catch {
    return undefined;
  }

  let changed = false;
  const reasons: string[] = [];

  if (mode === 'chat') {
    if (
      /max_completion_tokens/iu.test(errText) &&
      'max_tokens' in parsed &&
      !/unsupported|unknown|unrecognized|not allowed|extra/iu.test(
        errText.replace(/max_tokens/giu, ''),
      )
    ) {
      parsed.max_completion_tokens = parsed.max_tokens;
      delete parsed.max_tokens;
      changed = true;
      reasons.push('max_tokens -> max_completion_tokens');
    } else if (/max_completion_tokens/iu.test(errText) && 'max_completion_tokens' in parsed) {
      parsed.max_tokens = parsed.max_completion_tokens;
      delete parsed.max_completion_tokens;
      changed = true;
      reasons.push('max_completion_tokens -> max_tokens');
    }
  }

  if (
    !changed &&
    /max_tokens|max_output_tokens|max_completion_tokens|context_length|range of \[1,\s*\d+\]|less than or equal to \d+/iu.test(
      errText,
    )
  ) {
    const curKey =
      typeof parsed.max_output_tokens === 'number'
        ? 'max_output_tokens'
        : typeof parsed.max_tokens === 'number'
          ? 'max_tokens'
          : typeof parsed.max_completion_tokens === 'number'
            ? 'max_completion_tokens'
            : undefined;
    if (curKey) {
      const curLimit = parsed[curKey] as number;
      const capMatch =
        /(?:<=|less than or equal to|max(?:imum)?(?: allowed)?(?: is|:)?|range of \[1,\s*|up to )\s*(\d{3,6})/iu.exec(
          errText,
        ) ?? /\[1,\s*(\d{3,6})\]/iu.exec(errText);
      const parsedCap = capMatch?.[1] ? Number(capMatch[1]) : undefined;
      let nextLimit: number | undefined;
      if (parsedCap && Number.isFinite(parsedCap) && parsedCap > 0 && parsedCap < curLimit) {
        nextLimit = parsedCap;
      } else if (curLimit > 8_192) {
        nextLimit = 8_192;
      } else if (curLimit > 4_096) {
        nextLimit = 4_096;
      }
      if (nextLimit !== undefined && nextLimit < curLimit) {
        parsed[curKey] = nextLimit;
        changed = true;
        reasons.push(`${curKey} -> ${nextLimit}`);
      }
    }
  }

  if (/stream_options/iu.test(errText) && 'stream_options' in parsed) {
    delete parsed.stream_options;
    changed = true;
    reasons.push('strip stream_options');
  }

  const isUnknownFieldErr = /extra inputs are not permitted|unrecognized|unknown (?:field|parameter|property)|additional properties/iu.test(
    errText,
  );

  if ((/reasoning_content/iu.test(errText) || isUnknownFieldErr) && Array.isArray(parsed.messages)) {
    let stripped = false;
    for (const msg of parsed.messages) {
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && 'reasoning_content' in msg) {
        delete (msg as Record<string, unknown>).reasoning_content;
        stripped = true;
      }
    }
    if (stripped) {
      changed = true;
      reasons.push('strip reasoning_content');
    }
  }

  if (/temperature/iu.test(errText) && 'temperature' in parsed) {
    delete parsed.temperature;
    changed = true;
    reasons.push('strip temperature');
  }

  if (/top_p/iu.test(errText) && 'top_p' in parsed) {
    delete parsed.top_p;
    changed = true;
    reasons.push('strip top_p');
  }

  if (/\bstop\b/iu.test(errText) && 'stop' in parsed) {
    delete parsed.stop;
    changed = true;
    reasons.push('strip stop');
  }

  if (/tool_choice/iu.test(errText) && 'tool_choice' in parsed) {
    delete parsed.tool_choice;
    changed = true;
    reasons.push('strip tool_choice');
  }

  if (mode === 'responses' && /\bstore\b/iu.test(errText) && 'store' in parsed) {
    delete parsed.store;
    changed = true;
    reasons.push('strip store');
  }

  // 部分 OpenAI 兼容网关不支持 stream_options 但只返回笼统的参数错误，兜底剥离一次重试
  if (!changed && 'stream_options' in parsed && (isUnknownFieldErr || /invalid|unsupported|parameter|参数/iu.test(errText))) {
    delete parsed.stream_options;
    changed = true;
    reasons.push('strip stream_options');
  }

  if (!changed) return undefined;
  return {
    body: Buffer.from(JSON.stringify(parsed), 'utf8'),
    reason: reasons.join(', '),
  };
}

function parseUpstreamErrorText(errText: string, status: number): string {
  let message = errText || `Upstream HTTP ${status}`;
  if (errText) {
    try {
      const errJson = JSON.parse(errText) as { error?: unknown; message?: unknown };
      const extracted = extractOpenAiErrorMessage(errJson.error ?? errJson);
      if (extracted) {
        message = extracted;
      } else if (typeof errJson.message === 'string' && errJson.message) {
        message = errJson.message;
      }
    } catch {
      // 保留原始文本错误
    }
  }
  return message;
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export class ProviderProxy {
  readonly token = `sk-hd-proxy-${randomBytes(24).toString('hex')}`;
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private boundOrigin: string | undefined;
  private readonly openResponses = new Set<ServerResponse>();
  private readonly fetchImpl: FetchImpl;
  private logs: ProviderGatewayLogEntry[] = [];

  constructor(private readonly options: ProviderProxyOptions) {
    this.fetchImpl = options.fetchImpl ?? createProxyAwareFetch(options.getHttpProxy);
  }

  get origin(): string | undefined {
    return this.boundOrigin;
  }

  getLogs(): readonly ProviderGatewayLogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    if (this.logs.length === 0) return;
    this.logs = [];
    this.options.onLogChange?.();
  }

  private appendGatewayLog(
    entry: Omit<ProviderGatewayLogEntry, 'id' | 'timestamp'>,
    opts?: { readonly replaceId?: string; readonly writeOutput?: boolean },
  ): string {
    const existingIdx = opts?.replaceId ? this.logs.findIndex((item) => item.id === opts.replaceId) : -1;
    const id = opts?.replaceId ?? randomUUID();
    const timestamp = existingIdx >= 0 ? this.logs[existingIdx]!.timestamp : Date.now();
    const full: ProviderGatewayLogEntry = {
      id,
      timestamp,
      ...entry,
      ...(entry.targetUrl ? { targetUrl: redactSecrets(entry.targetUrl) } : {}),
      message: redactSecrets(entry.message),
      ...(entry.detail ? { detail: redactSecrets(entry.detail) } : {}),
    };
    if (existingIdx >= 0) {
      this.logs = this.logs.map((item, idx) => (idx === existingIdx ? full : item));
    } else {
      this.logs = [full, ...this.logs].slice(0, MAX_GATEWAY_LOGS);
    }
    if (opts?.writeOutput !== false) {
      const tag = full.converted ? 'OpenAI转换' : full.protocol;
      const modelInfo =
        full.mappedModel && full.requestModel && full.mappedModel !== full.requestModel
          ? ` [${full.requestModel} -> ${full.mappedModel}]`
          : full.mappedModel || full.requestModel
            ? ` [${full.mappedModel ?? full.requestModel}]`
            : '';
      const statusInfo = full.status !== undefined ? ` HTTP ${full.status}` : '';
      const durInfo = full.durationMs !== undefined ? ` (${full.durationMs}ms)` : '';
      this.options.log?.(
        `[网关][${full.level.toUpperCase()}][${full.providerName ?? full.providerId}][${tag}] ${full.method} ${full.path}${modelInfo}${statusInfo}${durInfo} - ${full.message}${full.detail ? ` | ${full.detail}` : ''}`,
      );
    }
    this.options.onLogChange?.();
    return id;
  }

  endpointFor(providerId: string, protocol: ProviderProtocol, scope?: string): string {
    if (!this.boundOrigin) throw new Error('ProviderProxy has not started yet');
    const cleanScope = scope?.trim();
    if (cleanScope) {
      return `${this.boundOrigin}/s/${encodeURIComponent(cleanScope)}/p/${encodeURIComponent(providerId)}/${protocol}`;
    }
    return `${this.boundOrigin}/p/${encodeURIComponent(providerId)}/${protocol}`;
  }

  async ensureStarted(): Promise<string> {
    if (this.boundOrigin) return this.boundOrigin;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<string> {
    const srv = createServer((req, res) => {
      this.openResponses.add(res);
      res.once('close', () => this.openResponses.delete(res));
      void this.handleRequest(req, res).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.options.log?.(`服务商代理转发异常：${msg}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: msg, type: 'proxy_error' } }));
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = srv.address() as AddressInfo | string | null;
    if (!addr || typeof addr === 'string') {
      srv.close();
      throw new Error('Failed to bind local provider proxy');
    }
    this.server = srv;
    this.boundOrigin = `http://127.0.0.1:${addr.port}`;
    this.options.log?.(`服务商本机代理已就绪：${this.boundOrigin}`);
    return this.boundOrigin;
  }

  async dispose(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    this.boundOrigin = undefined;
    for (const res of this.openResponses) {
      res.destroy();
    }
    this.openResponses.clear();
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = parseRoute(parsedUrl.pathname);

    if (!isClientAuthorized(req, this.token)) {
      if (route) {
        const provider = this.options.getProvider(route.providerId);
        this.appendGatewayLog({
          level: 'warn',
          providerId: route.providerId,
          ...(provider?.name ? { providerName: provider.name } : {}),
          protocol: route.protocol,
          converted: false,
          method: req.method ?? 'POST',
          path: route.subPath,
          status: 401,
          message: 'Unauthorized local proxy token',
        });
      }
      writeJson(res, 401, {
        type: 'error',
        error: { message: 'Unauthorized local proxy token', type: 'authentication_error' },
      });
      return;
    }

    if (!route) {
      writeJson(res, 404, {
        type: 'error',
        error: { message: 'Unknown provider proxy route', type: 'not_found_error' },
      });
      return;
    }

    const provider = this.options.getProvider(route.providerId);
    if (!provider) {
      writeJson(res, 404, {
        type: 'error',
        error: { message: `Provider "${route.providerId}" not found`, type: 'not_found_error' },
      });
      return;
    }

    const method = req.method ?? 'POST';
    // 拦截 Claude Code 等客户端发往 ANTHROPIC_BASE_URL 的非对话遥测接口，避免阻塞或误发给第三方网关
    if (route.protocol === 'anthropic' && /^\/api\/event_logging\b/u.test(route.subPath)) {
      await readRequestBody(req).catch(() => undefined);
      writeJson(res, 200, {});
      return;
    }

    let bodyBuf: Buffer = await readRequestBody(req);
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    const reqModelHint =
      method === 'POST' && contentType.includes('json') ? extractModelFromBody(bodyBuf) : undefined;
    const selectedModel = this.options.getSelectedModel?.(provider.id, route.scope);

    if (
      route.protocol === 'anthropic' &&
      shouldConvertOpenaiToAnthropic(
        provider,
        this.options.isProtocolGatewayEnabled?.() ?? false,
        reqModelHint,
        selectedModel,
      )
    ) {
      await this.handleAnthropicViaOpenAi(req, res, provider, route.subPath, parsedUrl.search, bodyBuf, route.scope);
      return;
    }

    const startedAt = Date.now();
    const upstreamBase = baseUrlForProtocol(provider, route.protocol);
    if (!upstreamBase) {
      const msg =
        route.protocol === 'anthropic' && (provider.openaiChatUrl?.trim() || provider.openaiResponsesUrl?.trim())
          ? `Provider "${provider.name}" has no Anthropic URL configured (enable Local Protocol Gateway to convert OpenAI endpoint)`
          : `Provider "${provider.name}" has no endpoint URL configured`;
      this.appendGatewayLog({
        level: 'error',
        providerId: provider.id,
        providerName: provider.name,
        protocol: route.protocol,
        converted: false,
        method,
        path: route.subPath,
        ...(reqModelHint ? { requestModel: reqModelHint } : {}),
        status: 400,
        durationMs: Date.now() - startedAt,
        message: msg,
      });
      writeJson(res, 400, {
        error: { message: msg, type: 'invalid_request_error' },
      });
      return;
    }

    const targetUrl = joinUpstreamUrl(upstreamBase, route.subPath, parsedUrl.search);
    const targetParsed = new URL(targetUrl);
    const realApiKey = (await this.options.getApiKey(provider.id))?.trim();

    let requestModel = reqModelHint;
    let mappedModel = reqModelHint;
    if (method === 'POST' && contentType.includes('json') && bodyBuf.length > 0) {
      const rewritten = rewriteModelDetailsInPayload(bodyBuf, provider, selectedModel);
      bodyBuf = rewritten.body;
      requestModel = rewritten.requestModel ?? requestModel;
      mappedModel = rewritten.mappedModel ?? mappedModel;
    }

    const headers = buildForwardHeaders(req.headers);

    if (realApiKey) {
      if (route.protocol === 'anthropic') {
        headers['x-api-key'] = realApiKey;
        if (targetParsed.hostname !== 'api.anthropic.com') {
          headers['authorization'] = `Bearer ${realApiKey}`;
        }
      } else {
        headers['authorization'] = `Bearer ${realApiKey}`;
      }
    }

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onClose);

    const pendingLogId = this.appendGatewayLog(
      {
        level: 'info',
        providerId: provider.id,
        providerName: provider.name,
        protocol: route.protocol,
        converted: false,
        method,
        path: route.subPath,
        targetUrl,
        ...(requestModel ? { requestModel } : {}),
        ...(mappedModel ? { mappedModel } : {}),
        message: 'Forwarding request to upstream...',
      },
      { writeOutput: false },
    );

    try {
      const hasBody = method !== 'GET' && method !== 'HEAD' && bodyBuf.length > 0;
      const upstreamRes = await this.fetchImpl(targetUrl, {
        method,
        headers,
        ...(hasBody ? { body: new Uint8Array(bodyBuf) } : {}),
        signal: abort.signal,
      });

      const outHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-encoding') return;
        outHeaders[key] = val;
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        this.appendGatewayLog(
          {
            level: 'error',
            providerId: provider.id,
            providerName: provider.name,
            protocol: route.protocol,
            converted: false,
            method,
            path: route.subPath,
            targetUrl,
            ...(requestModel ? { requestModel } : {}),
            ...(mappedModel ? { mappedModel } : {}),
            status: upstreamRes.status,
            durationMs: Date.now() - startedAt,
            message: parseUpstreamErrorText(errText, upstreamRes.status),
            ...(errText ? { detail: errText.slice(0, 500) } : {}),
          },
          { replaceId: pendingLogId },
        );
        res.writeHead(upstreamRes.status, outHeaders);
        res.end(errText);
        return;
      }

      res.writeHead(upstreamRes.status, outHeaders);
      if (!upstreamRes.body) {
        res.end();
        this.appendGatewayLog(
          {
            level: 'info',
            providerId: provider.id,
            providerName: provider.name,
            protocol: route.protocol,
            converted: false,
            method,
            path: route.subPath,
            targetUrl,
            ...(requestModel ? { requestModel } : {}),
            ...(mappedModel ? { mappedModel } : {}),
            status: upstreamRes.status,
            durationMs: Date.now() - startedAt,
            message: 'Direct proxy response completed',
          },
          { replaceId: pendingLogId },
        );
        return;
      }

      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || res.destroyed) break;
          if (value && value.byteLength > 0) {
            res.write(Buffer.from(value));
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!res.destroyed) res.end();
      this.appendGatewayLog(
        {
          level: 'info',
          providerId: provider.id,
          providerName: provider.name,
          protocol: route.protocol,
          converted: false,
          method,
          path: route.subPath,
          targetUrl,
          ...(requestModel ? { requestModel } : {}),
          ...(mappedModel ? { mappedModel } : {}),
          status: upstreamRes.status,
          durationMs: Date.now() - startedAt,
          message: 'Direct proxy response completed',
        },
        { replaceId: pendingLogId },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.appendGatewayLog(
        {
          level: abort.signal.aborted ? 'warn' : 'error',
          providerId: provider.id,
          providerName: provider.name,
          protocol: route.protocol,
          converted: false,
          method,
          path: route.subPath,
          targetUrl,
          ...(requestModel ? { requestModel } : {}),
          ...(mappedModel ? { mappedModel } : {}),
          status: 502,
          durationMs: Date.now() - startedAt,
          message: abort.signal.aborted ? 'Client closed connection' : errMsg,
        },
        { replaceId: pendingLogId },
      );
      throw err;
    } finally {
      res.removeListener('close', onClose);
    }
  }

  private async handleAnthropicViaOpenAi(
    req: IncomingMessage,
    res: ServerResponse,
    provider: ProviderConfig,
    subPath: string,
    search: string,
    bodyBuf: Buffer,
    scope?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? 'POST';

    if (/\/(?:messages\/)?count_tokens$/u.test(subPath)) {
      const estimate = estimateAnthropicTokens(bodyBuf);
      const reqModel = extractModelFromBody(bodyBuf);
      this.appendGatewayLog({
        level: 'info',
        providerId: provider.id,
        providerName: provider.name,
        protocol: 'anthropic',
        converted: true,
        method,
        path: subPath,
        ...(reqModel ? { requestModel: reqModel } : {}),
        status: 200,
        durationMs: Date.now() - startedAt,
        message: `Local count_tokens estimate (${estimate.input_tokens} tokens)`,
      });
      writeJson(res, 200, estimate);
      return;
    }

    if (method === 'GET' && /^\/(?:v1\/)?models$/u.test(subPath)) {
      writeJson(res, 200, {
        data: provider.models.map((m) => ({
          id: m.id,
          display_name: m.name || m.id,
          type: 'model',
        })),
      });
      return;
    }

    const singleModelMatch = method === 'GET' ? /^\/(?:v1\/)?models\/([^/]+)$/u.exec(subPath) : null;
    if (singleModelMatch) {
      const wantedId = decodeURIComponent(singleModelMatch[1]!);
      const found = provider.models.find((m) => m.id === wantedId);
      writeJson(res, 200, {
        id: found?.id ?? wantedId,
        display_name: found?.name || found?.id || wantedId,
        type: 'model',
      });
      return;
    }

    if (method !== 'POST') {
      writeJson(res, 404, {
        type: 'error',
        error: { message: `Unsupported Anthropic gateway endpoint: ${method} ${subPath}`, type: 'not_found_error' },
      });
      return;
    }

    const selectedModel = this.options.getSelectedModel?.(provider.id, scope);
    const reqModelHint = extractModelFromBody(bodyBuf);
    const previewModel =
      (reqModelHint ? resolveMappedProviderModel(reqModelHint, provider, selectedModel) : undefined) ??
      reqModelHint ??
      selectedModel ??
      provider.defaultModel;

    const initialUpstream = selectOpenAiUpstreamMode(provider, previewModel);
    if (!initialUpstream) {
      const msg = `Provider "${provider.name}" has no OpenAI URL configured`;
      this.appendGatewayLog({
        level: 'error',
        providerId: provider.id,
        providerName: provider.name,
        protocol: 'anthropic',
        converted: true,
        method,
        path: subPath,
        status: 400,
        durationMs: Date.now() - startedAt,
        message: msg,
      });
      writeJson(res, 400, {
        type: 'error',
        error: { message: msg, type: 'invalid_request_error' },
      });
      return;
    }

    let currentMode: OpenAiUpstreamMode = initialUpstream.mode;
    let currentBaseUrl = initialUpstream.baseUrl;
    let converted: ReturnType<typeof convertAnthropicToOpenAiRequest>;
    try {
      converted =
        currentMode === 'responses'
          ? convertAnthropicToOpenAiResponsesRequest(bodyBuf, provider, selectedModel)
          : convertAnthropicToOpenAiRequest(bodyBuf, provider, selectedModel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendGatewayLog({
        level: 'error',
        providerId: provider.id,
        providerName: provider.name,
        protocol: 'anthropic',
        converted: true,
        method,
        path: subPath,
        status: 400,
        durationMs: Date.now() - startedAt,
        message: `Request conversion failed: ${msg}`,
      });
      writeJson(res, 400, {
        type: 'error',
        error: { message: msg, type: 'invalid_request_error' },
      });
      return;
    }

    const cleanSearch = stripAnthropicSearchParams(search);
    const buildTargetUrl = (base: string, mode: OpenAiUpstreamMode): string =>
      joinUpstreamUrl(base, mode === 'responses' ? '/v1/responses' : '/v1/chat/completions', cleanSearch);

    let targetUrl = buildTargetUrl(currentBaseUrl, currentMode);
    const realApiKey = (await this.options.getApiKey(provider.id))?.trim();
    const headers = buildOpenAiForwardHeaders(req.headers, converted.stream);
    if (realApiKey) {
      headers['authorization'] = `Bearer ${realApiKey}`;
    } else {
      this.appendGatewayLog({
        level: 'warn',
        providerId: provider.id,
        providerName: provider.name,
        protocol: 'anthropic',
        converted: true,
        method,
        path: subPath,
        targetUrl,
        ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
        mappedModel: converted.model,
        message: 'No API Key saved for this provider; forwarding without Authorization header',
      });
    }

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onClose);

    const pendingLogId = this.appendGatewayLog(
      {
        level: 'info',
        providerId: provider.id,
        providerName: provider.name,
        protocol: 'anthropic',
        converted: true,
        method,
        path: subPath,
        targetUrl,
        ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
        mappedModel: converted.model,
        message: 'Converting and forwarding request to upstream...',
      },
      { writeOutput: false },
    );

    const finalizeStreamSummary = (
      summary: Awaited<ReturnType<typeof pipeOpenAiStreamToAnthropicSse>>,
      retryDetail: string | undefined,
      sourceLabel: string,
    ): void => {
      if (!res.headersSent) {
        const errMessage = summary.streamError
          ? `Upstream stream error: ${summary.streamError}`
          : 'Upstream SSE stream completed with empty output';
        this.appendGatewayLog(
          {
            level: 'error',
            providerId: provider.id,
            providerName: provider.name,
            protocol: 'anthropic',
            converted: true,
            method,
            path: subPath,
            targetUrl,
            ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
            mappedModel: converted.model,
            status: 502,
            durationMs: Date.now() - startedAt,
            message: errMessage,
            detail: [
              `mode=${currentMode}`,
              `chunks=${summary.chunkCount}`,
              `finish=${summary.finishReason || 'none'}`,
              ...(retryDetail ? [`retry=${retryDetail}`] : []),
            ].join(', '),
          },
          { replaceId: pendingLogId },
        );
        writeJson(res, 502, {
          type: 'error',
          error: { type: 'api_error', message: errMessage },
        });
        return;
      }

      if (!res.destroyed && !res.writableEnded) res.end();
      const streamDetail = [
        `mode=${currentMode}`,
        `chunks=${summary.chunkCount}`,
        `finish=${summary.finishReason || 'stop'}`,
        `in=${summary.inputTokens}`,
        `out=${summary.outputTokens}`,
        ...(retryDetail ? [`retry=${retryDetail}`] : []),
      ].join(', ');
      this.appendGatewayLog(
        {
          level: summary.streamError ? 'error' : summary.hasOutput ? 'info' : 'warn',
          providerId: provider.id,
          providerName: provider.name,
          protocol: 'anthropic',
          converted: true,
          method,
          path: subPath,
          targetUrl,
          ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
          mappedModel: converted.model,
          status: 200,
          durationMs: Date.now() - startedAt,
          message: summary.streamError
            ? `Upstream stream error: ${summary.streamError}`
            : summary.hasOutput
              ? sourceLabel
              : 'Upstream SSE stream completed with empty output',
          detail: streamDetail,
        },
        { replaceId: pendingLogId },
      );
    };

    try {
      let currentPayload = converted.body;
      const retryReasons: string[] = [];
      let upstreamRes = await this.fetchImpl(targetUrl, {
        method: 'POST',
        headers,
        body: new Uint8Array(currentPayload),
        signal: abort.signal,
      });

      let lastErrText: string | undefined;
      for (let attempt = 0; attempt < MAX_PARAM_RETRIES && !upstreamRes.ok; attempt++) {
        if (upstreamRes.status !== 400 && upstreamRes.status !== 404 && upstreamRes.status !== 422) {
          break;
        }
        const errText = await upstreamRes.text().catch(() => '');
        lastErrText = errText;

        if (shouldFallbackToResponsesApi(upstreamRes.status, errText, currentMode)) {
          const fallbackBase = provider.openaiResponsesUrl?.trim() || provider.openaiChatUrl?.trim();
          if (fallbackBase) {
            currentMode = 'responses';
            currentBaseUrl = fallbackBase;
            targetUrl = buildTargetUrl(currentBaseUrl, currentMode);
            converted = convertAnthropicToOpenAiResponsesRequest(bodyBuf, provider, selectedModel);
            currentPayload = converted.body;
            retryReasons.push('fallback -> /v1/responses');
            this.appendGatewayLog({
              level: 'warn',
              providerId: provider.id,
              providerName: provider.name,
              protocol: 'anthropic',
              converted: true,
              method,
              path: subPath,
              targetUrl,
              ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
              mappedModel: converted.model,
              status: upstreamRes.status,
              durationMs: Date.now() - startedAt,
              message: 'Upstream requires Responses API; retrying via /v1/responses',
              ...(errText ? { detail: errText.slice(0, 400) } : {}),
            });
            lastErrText = undefined;
            upstreamRes = await this.fetchImpl(targetUrl, {
              method: 'POST',
              headers,
              body: new Uint8Array(currentPayload),
              signal: abort.signal,
            });
            continue;
          }
        }

        const retryPlan = buildRetryOpenAiPayload(currentPayload, upstreamRes.status, errText, currentMode);
        if (!retryPlan) break;

        retryReasons.push(retryPlan.reason);
        this.appendGatewayLog({
          level: 'warn',
          providerId: provider.id,
          providerName: provider.name,
          protocol: 'anthropic',
          converted: true,
          method,
          path: subPath,
          targetUrl,
          ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
          mappedModel: converted.model,
          status: upstreamRes.status,
          durationMs: Date.now() - startedAt,
          message: `Upstream rejected parameters; retrying (${retryPlan.reason})`,
          ...(errText ? { detail: errText.slice(0, 400) } : {}),
        });
        currentPayload = retryPlan.body;
        lastErrText = undefined;
        upstreamRes = await this.fetchImpl(targetUrl, {
          method: 'POST',
          headers,
          body: new Uint8Array(currentPayload),
          signal: abort.signal,
        });
      }

      const retryDetail = retryReasons.length > 0 ? retryReasons.join('; ') : undefined;

      if (!upstreamRes.ok) {
        const errText = lastErrText ?? (await upstreamRes.text().catch(() => ''));
        const message = parseUpstreamErrorText(errText, upstreamRes.status);
        this.appendGatewayLog(
          {
            level: 'error',
            providerId: provider.id,
            providerName: provider.name,
            protocol: 'anthropic',
            converted: true,
            method,
            path: subPath,
            targetUrl,
            ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
            mappedModel: converted.model,
            status: upstreamRes.status,
            durationMs: Date.now() - startedAt,
            message,
            ...(errText ? { detail: errText.slice(0, 500) } : {}),
          },
          { replaceId: pendingLogId },
        );
        writeJson(res, upstreamRes.status, {
          type: 'error',
          error: { type: 'api_error', message },
        });
        return;
      }

      const respContentType = (upstreamRes.headers.get('content-type') ?? '').toLowerCase();
      if (converted.stream && upstreamRes.body && respContentType.includes('text/event-stream')) {
        const summary = await pipeOpenAiStreamToAnthropicSse(upstreamRes.body, res, converted.model);
        finalizeStreamSummary(
          summary,
          retryDetail,
          currentMode === 'responses'
            ? 'Streamed response converted (OpenAI Responses SSE -> Anthropic SSE)'
            : 'Streamed response converted (OpenAI SSE -> Anthropic SSE)',
        );
        return;
      }

      const rawRespText = await upstreamRes.text();
      if (converted.stream && looksLikeSsePayload(rawRespText)) {
        const encoded = new TextEncoder().encode(rawRespText);
        const fallbackStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        });
        const summary = await pipeOpenAiStreamToAnthropicSse(fallbackStream, res, converted.model);
        finalizeStreamSummary(
          summary,
          retryDetail,
          'Streamed response converted (OpenAI SSE payload -> Anthropic SSE)',
        );
        return;
      }

      let openAiJson: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawRespText) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Upstream OpenAI response is not a JSON object');
        }
        openAiJson = parsed as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendGatewayLog(
          {
            level: 'error',
            providerId: provider.id,
            providerName: provider.name,
            protocol: 'anthropic',
            converted: true,
            method,
            path: subPath,
            targetUrl,
            ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
            mappedModel: converted.model,
            status: 502,
            durationMs: Date.now() - startedAt,
            message: msg,
            ...(rawRespText ? { detail: rawRespText.slice(0, 400) } : {}),
          },
          { replaceId: pendingLogId },
        );
        writeJson(res, 502, {
          type: 'error',
          error: { message: msg, type: 'api_error' },
        });
        return;
      }

      let anthropicResp: Record<string, unknown>;
      try {
        anthropicResp = convertOpenAiToAnthropicResponse(openAiJson, converted.model);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendGatewayLog(
          {
            level: 'error',
            providerId: provider.id,
            providerName: provider.name,
            protocol: 'anthropic',
            converted: true,
            method,
            path: subPath,
            targetUrl,
            ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
            mappedModel: converted.model,
            status: 502,
            durationMs: Date.now() - startedAt,
            message: `Upstream error in response: ${msg}`,
            ...(rawRespText ? { detail: rawRespText.slice(0, 400) } : {}),
          },
          { replaceId: pendingLogId },
        );
        writeJson(res, 502, {
          type: 'error',
          error: { message: msg, type: 'api_error' },
        });
        return;
      }

      if (converted.stream) {
        writeAnthropicResponseAsSse(res, anthropicResp);
        if (!res.destroyed && !res.writableEnded) res.end();
        this.appendGatewayLog(
          {
            level: 'info',
            providerId: provider.id,
            providerName: provider.name,
            protocol: 'anthropic',
            converted: true,
            method,
            path: subPath,
            targetUrl,
            ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
            mappedModel: converted.model,
            status: 200,
            durationMs: Date.now() - startedAt,
            message: 'Non-stream upstream JSON wrapped as Anthropic SSE',
            ...(retryDetail ? { detail: `retry=${retryDetail}` } : {}),
          },
          { replaceId: pendingLogId },
        );
        return;
      }

      writeJson(res, 200, anthropicResp);
      this.appendGatewayLog(
        {
          level: 'info',
          providerId: provider.id,
          providerName: provider.name,
          protocol: 'anthropic',
          converted: true,
          method,
          path: subPath,
          targetUrl,
          ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
          mappedModel: converted.model,
          status: 200,
          durationMs: Date.now() - startedAt,
          message:
            currentMode === 'responses'
              ? 'Non-stream response converted (OpenAI Responses -> Anthropic)'
              : 'Non-stream response converted (OpenAI -> Anthropic)',
          ...(retryDetail ? { detail: `retry=${retryDetail}` } : {}),
        },
        { replaceId: pendingLogId },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendGatewayLog(
        {
          level: abort.signal.aborted ? 'warn' : 'error',
          providerId: provider.id,
          providerName: provider.name,
          protocol: 'anthropic',
          converted: true,
          method,
          path: subPath,
          targetUrl,
          ...(converted.requestModel ? { requestModel: converted.requestModel } : {}),
          mappedModel: converted.model,
          status: 502,
          durationMs: Date.now() - startedAt,
          message: abort.signal.aborted ? 'Client closed connection' : msg,
        },
        { replaceId: pendingLogId },
      );
      if (!res.headersSent) {
        writeJson(res, 502, {
          type: 'error',
          error: { message: msg, type: 'api_error' },
        });
      } else if (!res.destroyed && !res.writableEnded) {
        writeSseEvent(res, 'error', {
          type: 'error',
          error: { type: 'api_error', message: msg },
        });
        res.end();
      }
    } finally {
      res.removeListener('close', onClose);
    }
  }
}

export interface FetchModelsParams {
  readonly apiKey?: string;
  readonly anthropicUrl?: string;
  readonly openaiChatUrl?: string;
  readonly openaiResponsesUrl?: string;
  readonly fetchImpl?: FetchImpl;
  readonly timeoutMs?: number;
}

/**
 * 从服务商的 `/models`（或 `/v1/models`）端点实时拉取模型列表。
 */
export async function fetchRemoteProviderModels(params: FetchModelsParams): Promise<ProviderModelItem[]> {
  const fetchFn = params.fetchImpl ?? ((input, init) => fetch(input, init));
  const candidates: { base: string; isAnthropic: boolean }[] = [];
  if (params.openaiChatUrl?.trim()) candidates.push({ base: params.openaiChatUrl.trim(), isAnthropic: false });
  if (params.openaiResponsesUrl?.trim()) candidates.push({ base: params.openaiResponsesUrl.trim(), isAnthropic: false });
  if (params.anthropicUrl?.trim()) candidates.push({ base: params.anthropicUrl.trim(), isAnthropic: true });

  if (candidates.length === 0) {
    throw new Error('Missing endpoint URL');
  }

  const key = params.apiKey?.trim();
  const urlsToTry: { url: string; headers: Record<string, string> }[] = [];
  const seenUrls = new Set<string>();

  for (const { base, isAnthropic } of candidates) {
    const clean = base.replace(/\/+$/u, '');
    const paths = /\/v\d+$/iu.test(clean) ? [`${clean}/models`] : [`${clean}/v1/models`, `${clean}/models`];
    for (const url of paths) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const parsed = new URL(url);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (isAnthropic) {
        headers['anthropic-version'] = '2023-06-01';
      }
      if (key) {
        if (isAnthropic) {
          headers['x-api-key'] = key;
          if (parsed.hostname !== 'api.anthropic.com') {
            headers['authorization'] = `Bearer ${key}`;
          }
        } else {
          headers['authorization'] = `Bearer ${key}`;
        }
      }
      urlsToTry.push({ url, headers });
    }
  }

  let lastError = 'HTTP request failed';
  for (const attempt of urlsToTry) {
    try {
      const res = await fetchFn(attempt.url, {
        method: 'GET',
        headers: attempt.headers,
        signal: AbortSignal.timeout(params.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status} (${attempt.url})`;
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const json = (await res.json()) as unknown;
      const parsedModels = extractModelsFromJson(json);
      if (parsedModels.length > 0) return parsedModels;
      lastError = 'No models returned by endpoint';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastError);
}

function extractModelsFromJson(raw: unknown): ProviderModelItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { data?: unknown; models?: unknown };
  const arr = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ProviderModelItem[] = [];

  for (const item of arr) {
    if (typeof item === 'string' && item.trim()) {
      const id = item.trim();
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const rawId = typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : '';
    const id = rawId.trim().replace(/^models\//u, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName =
      typeof m.display_name === 'string' && m.display_name.trim()
        ? m.display_name.trim()
        : typeof m.name === 'string' && m.name.trim() && m.name.trim() !== id
          ? m.name.trim()
          : undefined;

    const rawCtx =
      typeof m.context_length === 'number'
        ? m.context_length
        : typeof m.context_window === 'number'
          ? m.context_window
          : typeof m.input_token_limit === 'number'
            ? m.input_token_limit
            : undefined;
    const rawMaxOut =
      typeof m.max_output_tokens === 'number'
        ? m.max_output_tokens
        : typeof m.max_completion_tokens === 'number'
          ? m.max_completion_tokens
          : typeof m.output_token_limit === 'number'
            ? m.output_token_limit
            : undefined;

    const ctxStr = formatTokenLimit(rawCtx);
    const maxOutStr = formatTokenLimit(rawMaxOut);
    const modalities = Array.isArray(m.input_modalities)
      ? m.input_modalities
      : Array.isArray((m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities)
        ? ((m.architecture as { input_modalities: unknown[] }).input_modalities)
        : [];
    const vision =
      m.vision === true ||
      m.supports_vision === true ||
      modalities.some((mod) => typeof mod === 'string' && /image|vision/iu.test(mod));

    out.push({
      id,
      ...(displayName ? { name: displayName } : {}),
      ...(ctxStr ? { contextWindow: ctxStr } : {}),
      ...(maxOutStr ? { maxOutputTokens: maxOutStr } : {}),
      ...(vision ? { vision: true } : {}),
    });
  }
  return out;
}

/**
 * 本机回环服务商代理（ProviderProxy）：
 *
 * - 监听 `127.0.0.1:0`，持有一个仅驻留内存的随机本地令牌（`sk-hd-proxy-...`）；
 * - 底层智能体（dsh、Claude Code、Pi、CodeBuddy 等）只拿到 `http://127.0.0.1:<port>/p/<providerId>/<protocol>` 与本地令牌；
 * - 真实 API Key 只保存在 VS Code 的 SecretStorage 里，由本代理在转发给上游服务商时注入请求头，
 *   绝不写入智能体的配置文件、命令行参数或日志。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatTokenLimit, type ProviderConfig, type ProviderModelItem, type ProviderProtocol } from '@harness-deck/shared';
import {
  convertAnthropicToOpenAiRequest,
  convertOpenAiToAnthropicResponse,
  estimateAnthropicTokens,
  pipeOpenAiStreamToAnthropicSse,
  resolveMappedProviderModel,
  shouldConvertOpenaiToAnthropic,
} from './OpenaiToAnthropicConverter.ts';

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

const ANTHROPIC_STRIPPED_HEADERS = new Set([
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
]);

export interface ProviderProxyOptions {
  readonly getProvider: (id: string) => ProviderConfig | undefined;
  readonly getApiKey: (id: string) => Promise<string | undefined>;
  /** 当前会话为指定服务商选中的模型（用于把 Claude Code 等发出的 "default" / "sonnet" 映射到真实模型）。 */
  readonly getSelectedModel?: (providerId: string) => string | undefined;
  /** 是否启用本地协议转换网关（将 OpenAI 兼容接口转换为 Claude Anthropic 协议，默认 false）。 */
  readonly isProtocolGatewayEnabled?: () => boolean;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: FetchImpl;
}

/**
 * 拼接服务商配置的 Base URL 与智能体发来的子路径，自动消除重复斜杠及重复的 `/v1` 或完整端点路径。
 */
export function joinUpstreamUrl(baseUrl: string, subPath: string, search = ''): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/u, '');
  let cleanSub = subPath.startsWith('/') ? subPath : `/${subPath}`;
  // 若 Base URL 已包含完整端点路径（如 /chat/completions），避免再次拼接 /v1/chat/completions 或 /chat/completions
  if (/\/chat\/completions$/iu.test(cleanBase) && /^\/(?:v1\/)?chat\/completions$/iu.test(cleanSub)) {
    cleanSub = '/';
  } else if (/\/v\d+$/iu.test(cleanBase) && /^\/v1(\/|$)/iu.test(cleanSub)) {
    // 若 Base URL 已以 /v1、/v2、/v3、/v4 结尾，而客户端又拼了 /v1/...（例如 /v1/messages 或 /v1/chat/completions），去重 /v1
    cleanSub = cleanSub.slice(3) || '/';
  }
  const joined = cleanSub === '/' ? cleanBase : `${cleanBase}${cleanSub}`;
  return `${joined}${search}`;
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
  if (rawBody.length === 0 || provider.models.length === 0) return rawBody;
  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (!val || typeof val !== 'object' || Array.isArray(val)) return rawBody;
    parsed = val as Record<string, unknown>;
  } catch {
    return rawBody;
  }

  const reqModel = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  const fallbackModel = resolveMappedProviderModel(reqModel, provider, selectedModel);
  if (!fallbackModel) return rawBody;
  parsed.model = fallbackModel;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

function extractClientToken(req: IncomingMessage): string | undefined {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
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
} | undefined {
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

function buildForwardHeaders(
  rawHeaders: IncomingMessage['headers'],
  extraExcluded?: ReadonlySet<string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    // 跳过压缩编码头，让 fetch 自动解码并以干净字节流回传客户端
    if (lower === 'accept-encoding') continue;
    if (extraExcluded?.has(lower)) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
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

  constructor(private readonly options: ProviderProxyOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get origin(): string | undefined {
    return this.boundOrigin;
  }

  endpointFor(providerId: string, protocol: ProviderProtocol): string {
    if (!this.boundOrigin) throw new Error('ProviderProxy has not started yet');
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
    const incomingToken = extractClientToken(req);
    if (!safeTokenEquals(this.token, incomingToken)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized local proxy token', type: 'authentication_error' } }));
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = parseRoute(parsedUrl.pathname);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'Unknown provider proxy route', type: 'not_found_error' } }));
      return;
    }

    const provider = this.options.getProvider(route.providerId);
    if (!provider) {
      writeJson(res, 404, { error: { message: `Provider "${route.providerId}" not found`, type: 'not_found_error' } });
      return;
    }

    if (
      route.protocol === 'anthropic' &&
      shouldConvertOpenaiToAnthropic(provider, this.options.isProtocolGatewayEnabled?.() ?? false)
    ) {
      await this.handleAnthropicViaOpenAi(req, res, provider, route.subPath, parsedUrl.search);
      return;
    }

    const upstreamBase = baseUrlForProtocol(provider, route.protocol);
    if (!upstreamBase) {
      writeJson(res, 400, {
        error: { message: `Provider "${provider.name}" has no endpoint URL configured`, type: 'invalid_request_error' },
      });
      return;
    }

    const targetUrl = joinUpstreamUrl(upstreamBase, route.subPath, parsedUrl.search);
    const targetParsed = new URL(targetUrl);
    const realApiKey = (await this.options.getApiKey(provider.id))?.trim();

    let bodyBuf: Buffer = await readRequestBody(req);
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    if (req.method === 'POST' && contentType.includes('json') && bodyBuf.length > 0) {
      bodyBuf = rewriteModelInPayload(
        bodyBuf,
        provider,
        this.options.getSelectedModel?.(provider.id),
      );
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

    try {
      const method = req.method ?? 'POST';
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

      res.writeHead(upstreamRes.status, outHeaders);
      if (!upstreamRes.body) {
        res.end();
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
  ): Promise<void> {
    const bodyBuf = await readRequestBody(req);
    if (/\/(?:messages\/)?count_tokens$/u.test(subPath)) {
      writeJson(res, 200, estimateAnthropicTokens(bodyBuf));
      return;
    }

    const openaiBase = provider.openaiChatUrl?.trim();
    if (!openaiBase) {
      writeJson(res, 400, {
        type: 'error',
        error: { message: `Provider "${provider.name}" has no OpenAI Chat URL configured`, type: 'invalid_request_error' },
      });
      return;
    }

    let converted: ReturnType<typeof convertAnthropicToOpenAiRequest>;
    try {
      converted = convertAnthropicToOpenAiRequest(
        bodyBuf,
        provider,
        this.options.getSelectedModel?.(provider.id),
      );
    } catch (err) {
      writeJson(res, 400, {
        type: 'error',
        error: { message: err instanceof Error ? err.message : String(err), type: 'invalid_request_error' },
      });
      return;
    }

    const targetUrl = joinUpstreamUrl(openaiBase, '/v1/chat/completions', search);
    const realApiKey = (await this.options.getApiKey(provider.id))?.trim();
    const headers = buildForwardHeaders(req.headers, ANTHROPIC_STRIPPED_HEADERS);
    headers['content-type'] = 'application/json';
    if (realApiKey) {
      headers['authorization'] = `Bearer ${realApiKey}`;
    }

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onClose);

    try {
      const upstreamRes = await this.fetchImpl(targetUrl, {
        method: 'POST',
        headers,
        body: new Uint8Array(converted.body),
        signal: abort.signal,
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        let message = errText || `Upstream HTTP ${upstreamRes.status}`;
        if (errText) {
          try {
            const errJson = JSON.parse(errText) as { error?: { message?: unknown }; message?: unknown };
            if (typeof errJson.error?.message === 'string' && errJson.error.message) {
              message = errJson.error.message;
            } else if (typeof errJson.message === 'string' && errJson.message) {
              message = errJson.message;
            }
          } catch {
            // 保留原始文本错误
          }
        }
        writeJson(res, upstreamRes.status, {
          type: 'error',
          error: { type: 'api_error', message },
        });
        return;
      }

      const respContentType = upstreamRes.headers.get('content-type') ?? '';
      if (converted.stream && upstreamRes.body && respContentType.includes('text/event-stream')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        await pipeOpenAiStreamToAnthropicSse(upstreamRes.body, res, converted.model);
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }

      const rawRespText = await upstreamRes.text();
      let openAiJson: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawRespText) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Upstream OpenAI response is not a JSON object');
        }
        openAiJson = parsed as Record<string, unknown>;
      } catch (err) {
        writeJson(res, 502, {
          type: 'error',
          error: { message: err instanceof Error ? err.message : String(err), type: 'api_error' },
        });
        return;
      }

      const anthropicResp = convertOpenAiToAnthropicResponse(openAiJson, converted.model);
      writeJson(res, 200, anthropicResp);
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

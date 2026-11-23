/**
 * token 用量明细：把各底层五花八门的 usage 字段归一成 {@link TokenBreakdown}，并按会话累计。
 *
 * 约定：`input` 只算未命中缓存的输入，缓存读取 / 写入单独计数。
 * - Anthropic / Claude Code：`input_tokens` 本身不含缓存，`cache_read_input_tokens` / `cache_creation_input_tokens` 另计；
 * - Pi、dsh（`inputTokens` / `uncachedInputTokens` + `cacheReadTokens` / `cacheWriteTokens`）同上；
 * - OpenAI：`prompt_tokens` 含缓存，命中数在 `prompt_tokens_details.cached_tokens`，需要减掉；
 * - DeepSeek 官方接口：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；
 * - AI SDK：`inputTokenDetails.noCacheTokens` / `cacheReadTokens` / `cacheWriteTokens`。
 */
import type { ContextDetail, RequestPerformance, TokenBreakdown } from '@harness-deck/shared';

type Rec = Record<string, unknown>;

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
const rec = (value: unknown): Rec | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined);

function pick(o: Rec | undefined, ...keys: string[]): number | undefined {
  if (!o) return undefined;
  for (const key of keys) {
    const value = num(o[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** 归一一个 usage 对象；认不出任何 token 字段时返回 undefined。 */
export function normalizeUsage(raw: unknown): TokenBreakdown | undefined {
  const o = rec(raw);
  if (!o) return undefined;
  const inDetails = rec(o.prompt_tokens_details) ?? rec(o.input_tokens_details) ?? rec(o.inputTokenDetails) ?? rec(o.inputTokensDetails);
  const outDetails = rec(o.completion_tokens_details) ?? rec(o.output_tokens_details) ?? rec(o.outputTokenDetails) ?? rec(o.outputTokensDetails);

  const rawInput = pick(o, 'uncachedInputTokens', 'input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens');
  const output = pick(o, 'output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens');
  const topRead = pick(
    o,
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cacheRead',
    'cacheReadTokens',
    'cache_read_tokens',
    'cachedReadTokens',
    'cached_read_tokens',
    'cachedInputTokens',
    'cached_input_tokens',
  );
  const topWrite = pick(
    o,
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cacheWrite',
    'cacheWriteTokens',
    'cache_write_tokens',
    'cachedWriteTokens',
    'cached_write_tokens',
    'cacheCreationTokens',
  );
  const hit = pick(o, 'prompt_cache_hit_tokens', 'promptCacheHitTokens');
  const miss = pick(o, 'prompt_cache_miss_tokens', 'promptCacheMissTokens');
  const detailRead = pick(inDetails, 'cached_tokens', 'cachedTokens', 'cacheReadTokens', 'cache_read_tokens');
  const detailWrite = pick(inDetails, 'cacheWriteTokens', 'cache_write_tokens', 'cache_creation_tokens', 'cacheCreationTokens');
  const noCache = pick(inDetails, 'noCacheTokens', 'no_cache_tokens');
  const reasoning =
    pick(o, 'reasoning_tokens', 'reasoningTokens', 'reasoningOutputTokens', 'reasoning_output_tokens', 'thoughtTokens', 'thought_tokens') ??
    pick(outDetails, 'reasoning_tokens', 'reasoningTokens');

  let input = rawInput ?? 0;
  let cacheRead = topRead ?? 0;
  const cacheWrite = topWrite ?? detailWrite ?? 0;
  if (topRead === undefined && hit !== undefined) {
    cacheRead = hit;
    input = miss ?? Math.max(0, input - hit);
  } else if (topRead === undefined && detailRead !== undefined) {
    // 明细里的缓存数包含在总输入里
    cacheRead = detailRead;
    input = noCache ?? Math.max(0, input - detailRead - (topWrite === undefined ? (detailWrite ?? 0) : 0));
  } else if (noCache !== undefined) {
    input = noCache;
  }

  if (rawInput === undefined && output === undefined && cacheRead === 0 && cacheWrite === 0) return undefined;
  return { input, output: output ?? 0, cacheRead, cacheWrite, ...(reasoning ? { reasoning } : {}) };
}

/** 一次请求占用的上下文：输入（含缓存）加输出。 */
export function totalOf(b: TokenBreakdown): number {
  return b.input + b.cacheRead + b.cacheWrite + b.output;
}

export function addUsage(a: TokenBreakdown | undefined, b: TokenBreakdown): TokenBreakdown {
  if (!a) return b;
  const reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(reasoning ? { reasoning } : {}),
  };
}

/** 从 usage 或结果对象里取费用（美元）。 */
export function costOf(raw: unknown): number | undefined {
  const direct = num(raw);
  if (direct !== undefined) return direct;
  const o = rec(raw);
  if (!o) return undefined;
  const cost = rec(o.cost);
  return pick(o, 'total_cost_usd', 'totalCostUsd', 'costUsd', 'cost_usd') ?? pick(cost, 'total', 'amount') ?? num(o.cost);
}

const MAX_REASONABLE_TURN_MS = 24 * 60 * 60 * 1_000;

/**
 * 追踪单轮请求的响应性能：首字耗时（TTFT）与生成速度（tokens/s）。
 * 兼容「先 finish 再上报 usage」与「先上报 usage 再 finish」两种底层事件顺序。
 */
export class TurnTimingTracker {
  private startedAt?: number;
  private firstTokenAt?: number;
  private lastFinished?: { readonly ttftMs?: number; readonly genMs: number; readonly totalMs: number };
  private lastPerf?: RequestPerformance;

  start(now = Date.now()): void {
    this.startedAt = now;
    this.firstTokenAt = undefined;
  }

  markFirstToken(now = Date.now()): void {
    if (this.startedAt !== undefined && this.firstTokenAt === undefined) {
      this.firstTokenAt = now;
    }
  }

  finish(outputTokens?: number, now = Date.now()): void {
    if (this.startedAt === undefined) return;
    const totalMs = Math.max(0, Math.round(now - this.startedAt));
    if (totalMs > MAX_REASONABLE_TURN_MS) {
      this.startedAt = undefined;
      this.firstTokenAt = undefined;
      return;
    }
    const ttftMs =
      this.firstTokenAt !== undefined ? Math.max(0, Math.round(this.firstTokenAt - this.startedAt)) : undefined;
    const genMs =
      this.firstTokenAt !== undefined && now > this.firstTokenAt ? Math.round(now - this.firstTokenAt) : totalMs;
    this.lastFinished = { ...(ttftMs !== undefined ? { ttftMs } : {}), genMs, totalMs };
    this.updatePerf(outputTokens);
    this.startedAt = undefined;
    this.firstTokenAt = undefined;
  }

  /** 若 usage 在 endTurn 之后才到达，补算本轮输出速度。 */
  attachOutputTokens(outputTokens: number | undefined): void {
    if (!outputTokens || outputTokens <= 0 || !this.lastFinished) return;
    this.updatePerf(outputTokens);
  }

  private updatePerf(outputTokens?: number): void {
    const fin = this.lastFinished;
    if (!fin) return;
    const computedTps =
      outputTokens !== undefined && outputTokens > 0 && fin.genMs >= 50
        ? Number(((outputTokens / fin.genMs) * 1_000).toFixed(1))
        : undefined;
    const tokensPerSec = computedTps !== undefined && computedTps > 0 ? computedTps : undefined;
    if (fin.ttftMs !== undefined || tokensPerSec !== undefined) {
      this.lastPerf = {
        ...(fin.ttftMs !== undefined ? { ttftMs: fin.ttftMs } : {}),
        ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
        ...(fin.totalMs > 0 ? { durationMs: fin.totalMs } : {}),
      };
    }
  }

  reset(): void {
    this.startedAt = undefined;
    this.firstTokenAt = undefined;
    this.lastFinished = undefined;
    this.lastPerf = undefined;
  }

  performance(): RequestPerformance | undefined {
    return this.lastPerf;
  }
}

/** 一个会话的用量记录：最近一次请求、会话累计、请求次数、费用与响应性能。 */
export class UsageTracker {
  private last?: TokenBreakdown;
  private session?: TokenBreakdown;
  private requests = 0;
  private cost?: { amount: number; currency: string };
  private readonly timing = new TurnTimingTracker();
  private turnOutputTokens = 0;

  startRequest(now = Date.now()): void {
    this.turnOutputTokens = 0;
    this.timing.start(now);
  }

  markFirstToken(now = Date.now()): void {
    this.timing.markFirstToken(now);
  }

  finishRequest(outputTokens?: number, now = Date.now()): void {
    const effectiveOutput = outputTokens ?? (this.turnOutputTokens > 0 ? this.turnOutputTokens : undefined);
    this.timing.finish(effectiveOutput, now);
  }

  /** 最近一次请求的用量（不累计）。 */
  setLast(b: TokenBreakdown | undefined): void {
    if (!b) return;
    this.last = b;
    if (b.output > 0) {
      this.turnOutputTokens = b.output;
      this.timing.attachOutputTokens(b.output);
    }
  }

  /** 一次请求结束：记为最近一次并累加到会话。 */
  addRequest(b: TokenBreakdown | undefined): void {
    if (!b) return;
    this.last = b;
    this.session = addUsage(this.session, b);
    this.requests += 1;
    if (b.output > 0) {
      this.turnOutputTokens += b.output;
      this.timing.attachOutputTokens(b.output);
    }
  }

  /** 只累加到会话（例如 Claude Code 每轮结束的 `result.usage`）。 */
  addSession(b: TokenBreakdown | undefined, requests = 0): void {
    if (!b) return;
    this.session = addUsage(this.session, b);
    this.requests += requests;
  }

  /** 底层直接给出的会话累计（例如 dsh 的 `tokenUsage` 投影）。 */
  setSession(b: TokenBreakdown | undefined): void {
    if (b) this.session = b;
  }

  addCost(amount: number | undefined, currency = 'USD'): void {
    if (amount === undefined) return;
    this.cost = { amount: (this.cost?.currency === currency ? this.cost.amount : 0) + amount, currency };
  }

  setCost(amount: number | undefined, currency = 'USD'): void {
    if (amount !== undefined) this.cost = { amount, currency };
  }

  reset(): void {
    this.last = undefined;
    this.session = undefined;
    this.requests = 0;
    this.cost = undefined;
    this.turnOutputTokens = 0;
    this.timing.reset();
  }

  detail(): ContextDetail | undefined {
    const perf = this.timing.performance();
    if (!this.last && !this.session && !this.cost && !perf) return undefined;
    return {
      ...(this.last ? { lastRequest: this.last } : {}),
      ...(this.session ? { session: this.session } : {}),
      ...(this.requests ? { requests: this.requests } : {}),
      ...(this.cost ? { cost: { ...this.cost } } : {}),
      ...(perf ? { performance: perf } : {}),
    };
  }
}

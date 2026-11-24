/**
 * CodeBuddy 原生（`codebuddy -p --output-format stream-json`）会话投影层：
 * - 实时流式事件：`system`（`init` / `usage_update`）、`stream_event`、`assistant`、`user`（`tool_result`）、`result`、`error`；
 * - 本地 `~/.codebuddy/projects/<project>/<id>.jsonl` 历史会话回放（`message`、`function_call`、`function_call_result`）。
 */
import { joinLabel, type ContextDetail, type ImageView, type Item, type LineStats, type SessionHeader } from '@harness-deck/shared';
import { inputFilePath, type AcpDiff, type FileChange } from '../acp/projection.ts';
import { t } from '../i18n.ts';
import { splitContext } from '../vm/context.ts';
import { countLines, lineStats, sumStats } from '../vm/diffs.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { activityLabel, parseArguments, summarizeExplore, toolVariant } from '../vm/toolRows.ts';
import { addUsage, normalizeUsage, totalOf, TurnTimingTracker } from '../vm/usage.ts';

const OUTPUT_LIMIT = 4_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export type CodebuddyDiff = AcpDiff;
export type CodebuddyFileChange = FileChange;

export interface CodebuddyToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'running' | 'ok' | 'error';
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly diffs: readonly CodebuddyDiff[];
}

type Todo = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' };
type Activity = Extract<Item, { kind: 'activity' }>;
type Explore = Extract<Item, { kind: 'explore' }>;

export class CodebuddySessionProjection {
  private items: Item[] = [];
  private readonly toolIndex = new Map<string, { index: number; entry?: number }>();
  private readonly tools = new Map<string, CodebuddyToolState>();
  private counter = 0;
  private changesCache: { readonly version: number; readonly value: readonly CodebuddyFileChange[] } | undefined;
  private streamedText = false;
  private streamedThinking = false;
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private readonly messageUsage = new Map<string, Record<string, unknown>>();
  private currentMessageId?: string;
  private lastMessageId?: string;
  private turnSeq = 0;
  private turnRecordedUsage = false;
  private lastResultCost?: number;
  private sessionCost?: number;
  private readonly timing = new TurnTimingTracker();

  version = 0;
  sessionId?: string;
  title?: string;
  model?: string;
  mode?: string;
  slashCommands: readonly string[] = [];
  todos?: readonly Todo[];
  goal?: SessionHeader['goal'];
  usage?: { readonly used: number; readonly size: number };
  runningSince?: number;

  constructor(private readonly workspacePath: string) {}

  get running(): boolean {
    return this.runningSince !== undefined;
  }

  snapshotItems(): readonly Item[] {
    return this.items;
  }

  toolCall(callId: string): CodebuddyToolState | undefined {
    return this.tools.get(callId);
  }

  diffsOf(callId: string): readonly CodebuddyDiff[] {
    return this.tools.get(callId)?.diffs ?? [];
  }

  fileChanges(): readonly CodebuddyFileChange[] {
    if (this.changesCache?.version === this.version) return this.changesCache.value;
    const value = this.computeFileChanges();
    this.changesCache = { version: this.version, value };
    return value;
  }

  private computeFileChanges(): CodebuddyFileChange[] {
    const files = new Map<
      string,
      { diffs: CodebuddyDiff[]; calls: string[]; created: boolean; additions: number; deletions: number }
    >();
    for (const call of this.tools.values()) {
      if (call.status !== 'ok' || toolVariant(call.toolName) !== 'edit') continue;
      const fallbackPath = inputFilePath(call.input);
      const entries: { path: string; diff?: CodebuddyDiff; stats: LineStats }[] = call.diffs.length
        ? call.diffs.map((d) => ({ path: d.path, diff: d, stats: lineStats(d.oldText ?? '', d.newText) }))
        : fallbackPath && typeof call.input.content === 'string'
          ? [{ path: fallbackPath, stats: { additions: countLines(call.input.content), deletions: 0 } }]
          : [];
      for (const entry of entries) {
        let file = files.get(entry.path);
        if (!file) {
          file = { diffs: [], calls: [], created: entry.diff?.oldText === null, additions: 0, deletions: 0 };
          files.set(entry.path, file);
        }
        if (entry.diff) file.diffs.push(entry.diff);
        if (!file.calls.includes(call.toolCallId)) file.calls.push(call.toolCallId);
        file.additions += entry.stats.additions;
        file.deletions += entry.stats.deletions;
      }
    }
    return [...files].map(([path, f]) => ({ path, ...f }));
  }

  reset(): void {
    this.items = [];
    this.toolIndex.clear();
    this.tools.clear();
    this.runningSince = undefined;
    this.todos = undefined;
    this.goal = undefined;
    this.streamedText = false;
    this.streamedThinking = false;
    this.messageUsage.clear();
    this.currentMessageId = undefined;
    this.lastMessageId = undefined;
    this.turnSeq = 0;
    this.turnRecordedUsage = false;
    this.timing.reset();
    this.changed();
  }

  /** 悬浮在上下文圆环上展示的用量明细。 */
  contextDetail(): ContextDetail | undefined {
    let session;
    for (const raw of this.messageUsage.values()) {
      const b = normalizeUsage(raw);
      if (b) session = addUsage(session, b);
    }
    const last = this.lastMessageId ? normalizeUsage(this.messageUsage.get(this.lastMessageId)) : undefined;
    const perf = this.timing.performance();
    if (!session && this.sessionCost === undefined && !perf) return undefined;
    return {
      ...(last ? { lastRequest: last } : {}),
      ...(session ? { session, requests: this.messageUsage.size } : {}),
      ...(this.sessionCost !== undefined ? { cost: { amount: this.sessionCost, currency: 'USD' } } : {}),
      ...(perf ? { performance: perf } : {}),
    };
  }

  private recordMessageUsage(id: string | undefined, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const key = id ?? this.currentMessageId ?? `anon:${this.messageUsage.size}`;
    const prev = this.messageUsage.get(key) ?? {};
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number') merged[k] = Math.max(typeof prev[k] === 'number' ? (prev[k] as number) : 0, v);
      else if (v && typeof v === 'object') merged[k] = v;
    }
    this.messageUsage.set(key, merged);
    this.lastMessageId = key;
    this.turnRecordedUsage = true;
    const b = normalizeUsage(merged);
    if (b && b.output > 0) this.timing.attachOutputTokens(b.output);
  }

  addUserMessage(text: string, images: readonly ImageView[] = []): void {
    this.settleText();
    const { text: body, attachments } = splitContext(text);
    this.items.push({
      kind: 'user',
      id: `u:${++this.counter}`,
      text: body,
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
    });
    this.changed();
  }

  startTurn(now: number): void {
    if (this.runningSince === undefined) this.runningSince = now;
    this.streamedText = false;
    this.streamedThinking = false;
    this.turnSeq += 1;
    this.turnRecordedUsage = false;
    this.timing.start(now);
    this.changed();
  }

  endTurn(now: number, outcome: 'completed' | 'cancelled' | 'failed', errorText?: string): void {
    const startedAt = this.runningSince;
    this.runningSince = undefined;
    const last =
      this.turnRecordedUsage && this.lastMessageId ? normalizeUsage(this.messageUsage.get(this.lastMessageId)) : undefined;
    this.timing.finish(last?.output, now);
    this.streamedText = false;
    this.streamedThinking = false;
    this.items = this.items.map((item) =>
      item.kind === 'assistant' && item.streaming
        ? { ...item, streaming: false, ...(outcome === 'cancelled' ? { interrupted: true } : {}) }
        : item,
    );
    for (const call of this.tools.values()) {
      if (call.status === 'running') {
        this.upsertTool({ ...call, status: outcome === 'completed' ? 'ok' : 'error' });
      }
    }
    const id = `n:${++this.counter}`;
    if (outcome === 'failed' && errorText) {
      this.items.push({ kind: 'notice', id, level: 'error', text: t('notice.error', errorText) });
    } else if (outcome === 'cancelled') {
      this.items.push({ kind: 'notice', id, level: 'info', text: t('notice.stopped') });
    }
    if (startedAt !== undefined && now - startedAt >= 1_000) {
      this.items.push({
        kind: 'turnDone',
        id: `d:${this.counter}`,
        durationMs: now - startedAt,
        completed: outcome === 'completed',
      });
    }
    this.changed();
  }

  /** 回放 `~/.codebuddy/projects/<project>/<id>.jsonl` 历史会话记录。 */
  applyHistoryRecords(records: readonly Record<string, unknown>[]): void {
    this.reset();
    for (const rec of records) {
      if (rec.isSidechain === true) continue;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
        this.title = rec.customTitle.trim();
        continue;
      }
      if (rec.type === 'summary' && !this.title && typeof rec.summary === 'string' && rec.summary.trim()) {
        this.title = rec.summary.trim();
        continue;
      }
      if (rec.type === 'message') {
        this.applyHistoryMessage(rec);
        continue;
      }
      if (rec.type === 'function_call') {
        this.applyHistoryFunctionCall(rec);
        continue;
      }
      if (rec.type === 'function_call_result') {
        this.applyHistoryFunctionCallResult(rec);
        continue;
      }
      this.applyEvent(rec, Date.now(), true);
    }
    for (const call of this.tools.values()) {
      if (call.status === 'running') {
        this.upsertTool({ ...call, status: 'ok' });
      }
    }
    this.settleText();
    this.runningSince = undefined;
    this.changed();
  }

  private applyHistoryMessage(rec: Record<string, unknown>): void {
    const providerData =
      rec.providerData && typeof rec.providerData === 'object'
        ? (rec.providerData as Record<string, unknown>)
        : undefined;
    if (providerData?.isMeta === true || providerData?.skipRun === true) return;
    if (typeof rec.sessionId === 'string' && rec.sessionId) this.sessionId = rec.sessionId;
    const role = typeof rec.role === 'string' ? rec.role : '';
    if (role === 'user') {
      const parsed = extractReplayUserInput(rec.content);
      if (parsed.text || parsed.images.length > 0) {
        this.addUserMessage(parsed.text, parsed.images);
      }
      return;
    }
    if (role === 'assistant') {
      if (typeof providerData?.model === 'string' && providerData.model) this.model = providerData.model;
      const msgObj = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : undefined;
      const usage = msgObj?.usage ?? providerData?.usage;
      const msgId = typeof providerData?.messageId === 'string' ? providerData.messageId : typeof rec.id === 'string' ? rec.id : undefined;
      if (usage) {
        this.applyUsageObject(usage);
        this.recordMessageUsage(msgId, usage);
      }
      const content = Array.isArray(rec.content) ? (rec.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        const bType = typeof block?.type === 'string' ? block.type : '';
        if (bType === 'thinking' || bType === 'reasoning') {
          const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
          if (text) this.appendAssistant(text, 'reasoning', false);
        } else if (bType === 'output_text' || bType === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (text) this.appendAssistant(text, 'markdown', false);
        }
      }
      this.settleText();
      this.changed();
    }
  }

  private applyHistoryFunctionCall(rec: Record<string, unknown>): void {
    const callId = typeof rec.callId === 'string' ? rec.callId : typeof rec.id === 'string' ? rec.id : '';
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    if (!callId) return;
    const providerData =
      rec.providerData && typeof rec.providerData === 'object'
        ? (rec.providerData as Record<string, unknown>)
        : undefined;
    if (typeof providerData?.model === 'string' && providerData.model) this.model = providerData.model;
    const msgObj = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : undefined;
    const usage = msgObj?.usage ?? providerData?.usage;
    const msgId = typeof providerData?.messageId === 'string' ? providerData.messageId : undefined;
    if (usage) {
      this.applyUsageObject(usage);
      this.recordMessageUsage(msgId, usage);
    }
    const input = parseArguments(rec.arguments);
    const call: CodebuddyToolState = {
      toolCallId: callId,
      toolName: name,
      status: 'running',
      input,
      diffs: extractCodebuddyDiffs(name, input),
    };
    const todos = extractTodosFromTool(call);
    if (todos) this.todos = todos;
    const goal = extractGoalFromTool(call);
    if (goal) this.goal = goal;
    this.upsertTool(call);
    this.changed();
  }

  private applyHistoryFunctionCallResult(rec: Record<string, unknown>): void {
    const callId = typeof rec.callId === 'string' ? rec.callId : '';
    if (!callId) return;
    const prev = this.tools.get(callId);
    if (!prev) return;
    const providerData =
      rec.providerData && typeof rec.providerData === 'object'
        ? (rec.providerData as Record<string, unknown>)
        : undefined;
    const toolResult =
      providerData?.toolResult && typeof providerData.toolResult === 'object'
        ? (providerData.toolResult as Record<string, unknown>)
        : undefined;
    const rawResponse =
      toolResult?.rawResponse && typeof toolResult.rawResponse === 'object'
        ? (toolResult.rawResponse as Record<string, unknown>)
        : undefined;

    const todos = extractTodoArray(rawResponse?.todos);
    if (todos) this.todos = todos;

    const status = typeof rec.status === 'string' ? rec.status : 'completed';
    const isError = status !== 'completed' && status !== 'ok';
    const rawOutput =
      rec.output && typeof rec.output === 'object' && typeof (rec.output as { text?: unknown }).text === 'string'
        ? (rec.output as { text: string }).text
        : typeof rec.output === 'string'
          ? rec.output
          : undefined;
    const output = formatToolOutput(prev.toolName, rawOutput, rawResponse, toolResult?.renderer, isError);
    this.upsertTool({
      ...prev,
      status: isError ? 'error' : 'ok',
      ...(output ? { output } : {}),
    });
    this.changed();
  }

  /** 应用一条 `codebuddy -p --output-format stream-json` 实时 NDJSON 事件帧。 */
  applyEvent(raw: Record<string, unknown>, now = Date.now(), isReplay = false): void {
    if (typeof raw.session_id === 'string' && raw.session_id) {
      this.sessionId = raw.session_id;
    } else if (typeof raw.sessionId === 'string' && raw.sessionId) {
      this.sessionId = raw.sessionId;
    }

    const type = typeof raw.type === 'string' ? raw.type : '';
    const parentToolId =
      typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id ? raw.parent_tool_use_id : undefined;

    switch (type) {
      case 'system': {
        if (raw.subtype === 'init') {
          if (typeof raw.model === 'string' && raw.model) this.model = raw.model;
          if (typeof raw.permissionMode === 'string' && raw.permissionMode && !this.mode) {
            this.mode = raw.permissionMode;
          }
          if (Array.isArray(raw.slash_commands)) {
            this.slashCommands = raw.slash_commands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
          }
          this.changed();
        } else if (raw.subtype === 'usage_update') {
          const meta = raw._meta && typeof raw._meta === 'object' ? (raw._meta as Record<string, unknown>) : undefined;
          const turnUsage =
            meta?.['codebuddy.ai/turnUsage'] && typeof meta['codebuddy.ai/turnUsage'] === 'object'
              ? (meta['codebuddy.ai/turnUsage'] as Record<string, unknown>)
              : undefined;
          const win = typeof turnUsage?.contextWindow === 'number' && turnUsage.contextWindow > 0 ? turnUsage.contextWindow : undefined;
          if (win) this.contextWindow = win;
          const usagePayload = turnUsage?.usage ?? raw.usage;
          if (usagePayload) {
            this.applyUsageObject(usagePayload);
            const usageKey =
              typeof turnUsage?.messageId === 'string' && turnUsage.messageId
                ? turnUsage.messageId
                : typeof turnUsage?.turnId === 'string' && turnUsage.turnId
                  ? `turn:${turnUsage.turnId}`
                  : (this.currentMessageId ?? `turn:${this.turnSeq}`);
            this.recordMessageUsage(usageKey, usagePayload);
            this.changed();
          }
        }
        return;
      }

      case 'stream_event': {
        if (parentToolId) return;
        const event = raw.event && typeof raw.event === 'object' ? (raw.event as Record<string, unknown>) : undefined;
        if (!event) return;
        if (this.runningSince === undefined && !isReplay) {
          this.runningSince = now;
          this.timing.start(now);
        }
        const evType = typeof event.type === 'string' ? event.type : '';
        if (evType === 'message_start') {
          this.streamedText = false;
          this.streamedThinking = false;
          const msg = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : undefined;
          this.currentMessageId = typeof msg?.id === 'string' && msg.id ? msg.id : undefined;
          if (msg?.usage) {
            this.applyUsageObject(msg.usage);
            this.recordMessageUsage(this.currentMessageId, msg.usage);
          }
        } else if (evType === 'content_block_start') {
          const cb =
            event.content_block && typeof event.content_block === 'object'
              ? (event.content_block as Record<string, unknown>)
              : undefined;
          if (cb?.type === 'tool_use' && typeof cb.id === 'string' && typeof cb.name === 'string') {
            this.settleText();
            const input = parseArguments(cb.input);
            this.upsertTool({
              toolCallId: cb.id,
              toolName: cb.name,
              status: 'running',
              input,
              diffs: extractCodebuddyDiffs(cb.name, input),
            });
          }
        } else if (evType === 'content_block_delta') {
          const delta = event.delta && typeof event.delta === 'object' ? (event.delta as Record<string, unknown>) : undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            this.appendAssistant(delta.text, 'markdown', true, now);
            this.streamedText = true;
          } else if (
            (delta?.type === 'thinking_delta' || delta?.type === 'reasoning_delta') &&
            typeof (delta.thinking ?? delta.text) === 'string'
          ) {
            const chunk = (typeof delta.thinking === 'string' ? delta.thinking : (delta.text as string)) ?? '';
            if (chunk) {
              this.appendAssistant(chunk, 'reasoning', true, now);
              this.streamedThinking = true;
            }
          }
        } else if (evType === 'message_delta') {
          if (event.usage) {
            this.applyUsageObject(event.usage);
            this.recordMessageUsage(this.currentMessageId, event.usage);
          }
        } else if (evType === 'error') {
          const errText = extractCodebuddyErrorText(event.error ?? event) ?? t('notice.errorUnknown');
          if (!isReplay) {
            this.endTurn(now, 'failed', errText);
          }
          return;
        }
        this.changed();
        return;
      }

      case 'assistant': {
        if (parentToolId) return;
        const msg = raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : raw;
        if (msg.usage) {
          this.applyUsageObject(msg.usage);
          this.recordMessageUsage(typeof msg.id === 'string' && msg.id ? msg.id : undefined, msg.usage);
        }
        if (typeof msg.model === 'string' && msg.model) this.model = msg.model;

        const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
        // 中断后 CodeBuddy 可能滞后补发 "Interrupted by user" 文本帧，若当前轮已停止则忽略
        if (
          !isReplay &&
          !this.running &&
          content.length === 1 &&
          content[0]?.type === 'text' &&
          content[0]?.text === 'Interrupted by user'
        ) {
          return;
        }
        for (const block of content) {
          const bType = typeof block?.type === 'string' ? block.type : '';
          if (bType === 'thinking' || bType === 'reasoning') {
            const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
            if (text && !this.streamedThinking) {
              this.appendAssistant(text, 'reasoning', !isReplay && this.running, now);
            }
          } else if (bType === 'text' || bType === 'output_text') {
            const text = typeof block.text === 'string' ? block.text : '';
            if (text && !this.streamedText) {
              this.appendAssistant(text, 'markdown', !isReplay && this.running, now);
            }
          } else if (bType === 'tool_use') {
            const id = typeof block.id === 'string' ? block.id : '';
            const name = typeof block.name === 'string' ? block.name : 'tool';
            if (!id) continue;
            this.settleText();
            const input = parseArguments(block.input);
            const existing = this.tools.get(id);
            const call: CodebuddyToolState = {
              toolCallId: id,
              toolName: name,
              status: existing?.status === 'ok' || existing?.status === 'error' ? existing.status : 'running',
              input,
              ...(existing?.output !== undefined ? { output: existing.output } : {}),
              diffs: extractCodebuddyDiffs(name, input),
            };
            const todos = extractTodosFromTool(call);
            if (todos) this.todos = todos;
            const goal = extractGoalFromTool(call);
            if (goal) this.goal = goal;
            this.upsertTool(call);
          }
        }
        this.streamedText = false;
        this.streamedThinking = false;
        this.settleText();
        this.changed();
        return;
      }

      case 'user': {
        const msg = raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : raw;
        const content = msg.content;
        if (Array.isArray(content)) {
          const blocks = content as Record<string, unknown>[];
          const toolResults = blocks.filter((b) => b?.type === 'tool_result');
          if (toolResults.length > 0) {
            if (parentToolId) return;
            for (const tr of toolResults) {
              const callId = typeof tr.tool_use_id === 'string' ? tr.tool_use_id : '';
              if (!callId) continue;
              const prev = this.tools.get(callId);
              if (!prev) continue;
              const isError = tr.is_error === true;
              const trMeta = tr._meta && typeof tr._meta === 'object' ? (tr._meta as Record<string, unknown>) : undefined;
              const rawResponse =
                trMeta?.rawResponse && typeof trMeta.rawResponse === 'object'
                  ? (trMeta.rawResponse as Record<string, unknown>)
                  : undefined;

              const todos = extractTodoArray(rawResponse?.todos);
              if (todos) this.todos = todos;

              const rawText = extractRawToolResultText(tr.content);
              const output = formatToolOutput(prev.toolName, rawText, rawResponse, undefined, isError);
              this.upsertTool({
                ...prev,
                status: isError ? 'error' : 'ok',
                ...(output ? { output } : {}),
              });
            }
            this.changed();
            return;
          }
        }

        if (isReplay && raw.isMeta !== true && !parentToolId) {
          const parsed = extractReplayUserInput(content);
          if (parsed.text || parsed.images.length > 0) {
            this.addUserMessage(parsed.text, parsed.images);
          }
        }
        return;
      }

      case 'error': {
        const errText = extractCodebuddyErrorText(raw.error ?? raw) ?? t('notice.errorUnknown');
        if (!isReplay) {
          if (this.running) {
            this.endTurn(now, 'failed', errText);
          } else {
            this.items.push({ kind: 'notice', id: `n:${++this.counter}`, level: 'error', text: t('notice.error', errText) });
            this.changed();
          }
        }
        return;
      }

      case 'result': {
        this.applyModelUsageWindow(raw.modelUsage);
        if (raw.usage) {
          this.applyUsageObject(raw.usage);
          if (!this.turnRecordedUsage) {
            this.recordMessageUsage(`turn:${this.turnSeq}`, raw.usage);
          }
        } else if (!this.turnRecordedUsage && raw.modelUsage && typeof raw.modelUsage === 'object' && !Array.isArray(raw.modelUsage)) {
          for (const [modelKey, entry] of Object.entries(raw.modelUsage as Record<string, unknown>)) {
            if (normalizeUsage(entry)) {
              this.applyUsageObject(entry);
              this.recordMessageUsage(`turn:${this.turnSeq}:${modelKey}`, entry);
            }
          }
        }
        if (!isReplay && typeof raw.total_cost_usd === 'number' && Number.isFinite(raw.total_cost_usd) && raw.total_cost_usd >= 0) {
          const cost = raw.total_cost_usd;
          const prev = this.lastResultCost;
          this.sessionCost = (this.sessionCost ?? 0) + (prev !== undefined && cost >= prev ? cost - prev : cost);
          this.lastResultCost = cost;
        }
        const rawErrorText = extractCodebuddyErrorText(raw.error);
        const isError =
          raw.is_error === true ||
          Boolean(rawErrorText) ||
          (typeof raw.subtype === 'string' && raw.subtype.startsWith('error'));
        if (isError) {
          const errors = Array.isArray(raw.errors)
            ? raw.errors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
            : [];
          const errText =
            (typeof raw.result === 'string' && raw.result.trim() ? raw.result.trim() : '') ||
            rawErrorText ||
            errors.join('\n') ||
            t('notice.errorUnknown');
          if (!isReplay) {
            this.endTurn(now, 'failed', errText);
          }
          return;
        }
        if (
          typeof raw.result === 'string' &&
          raw.result.trim() &&
          !this.items.some((i) => i.kind === 'assistant' && i.markdown.trim().length > 0)
        ) {
          this.appendAssistant(raw.result.trim(), 'markdown', false);
        }
        if (!isReplay && this.running) this.endTurn(now, 'completed');
        return;
      }

      default:
        return;
    }
  }

  private applyModelUsageWindow(modelUsage: unknown): void {
    if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return;
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') {
        const win = (entry as { contextWindow?: unknown }).contextWindow;
        if (typeof win === 'number' && win > 0) {
          this.contextWindow = win;
          if (this.usage) {
            this.usage = { used: this.usage.used, size: win };
          }
          break;
        }
      }
    }
  }

  private applyUsageObject(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const u = raw as Record<string, unknown>;
    const normalized = normalizeUsage(u);
    const used = normalized
      ? totalOf(normalized)
      : typeof u.total_tokens === 'number' && u.total_tokens > 0
        ? u.total_tokens
        : typeof u.totalTokens === 'number' && u.totalTokens > 0
          ? u.totalTokens
          : 0;
    if (used > 0) {
      this.usage = { used, size: this.contextWindow };
    }
  }

  private appendAssistant(text: string, field: 'markdown' | 'reasoning', streaming = this.running, now = Date.now()): void {
    if (!text) return;
    if (streaming) this.timing.markFirstToken(now);
    const last = this.items.length - 1;
    const lastItem = this.items[last];
    let at = lastItem?.kind === 'assistant' ? last : undefined;
    if (at === undefined) {
      at = this.items.length;
      this.items.push({ kind: 'assistant', id: `a:${++this.counter}`, markdown: '', streaming });
    }
    const prev = this.items[at] as Extract<Item, { kind: 'assistant' }>;
    this.items[at] =
      field === 'markdown'
        ? { ...prev, markdown: prev.markdown + text, streaming }
        : { ...prev, reasoning: (prev.reasoning ?? '') + text, streaming };
  }

  private settleText(): void {
    if (!this.items.some((item) => item.kind === 'assistant' && item.streaming)) return;
    this.items = this.items.map((item) => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item));
  }

  private upsertTool(call: CodebuddyToolState): void {
    const previous = this.tools.get(call.toolCallId);
    const merged: CodebuddyToolState = previous
      ? {
          toolCallId: call.toolCallId,
          toolName: call.toolName || previous.toolName,
          status: call.status,
          input: Object.keys(call.input).length > 0 ? { ...previous.input, ...call.input } : previous.input,
          ...(call.output !== undefined ? { output: call.output } : previous.output !== undefined ? { output: previous.output } : {}),
          diffs: call.diffs.length > 0 ? call.diffs : previous.diffs,
        }
      : call;
    this.tools.set(merged.toolCallId, merged);

    const canon = canonicalTool(merged.toolName);
    if (
      canon === 'todo_write' ||
      canon === 'create_goal' ||
      canon === 'update_goal' ||
      canon === 'ask_user_question' ||
      canon === 'exit_plan_mode'
    ) {
      return;
    }

    const existingAt = this.toolIndex.get(merged.toolCallId);
    const variant = toolVariant(merged.toolName);

    if (!existingAt) {
      this.settleText();
      if (variant === 'explore') {
        this.addExplore(merged);
      } else {
        this.toolIndex.set(merged.toolCallId, { index: this.items.length });
        this.items.push(this.activityOf(merged));
      }
      return;
    }

    const item = this.items[existingAt.index];
    if (item?.kind === 'explore' && existingAt.entry !== undefined) {
      const entries = item.entries.map((e, i) => (i === existingAt.entry ? this.exploreEntry(merged) : e));
      this.items[existingAt.index] = summarizeExplore({ ...item, entries });
    } else if (item?.kind === 'activity') {
      this.items[existingAt.index] = this.activityOf(merged);
    }
  }

  private addExplore(call: CodebuddyToolState): void {
    const entry = this.exploreEntry(call);
    const last = this.items.length - 1;
    if (this.items[last]?.kind === 'explore') {
      const group = this.items[last] as Explore;
      this.toolIndex.set(call.toolCallId, { index: last, entry: group.entries.length });
      this.items[last] = summarizeExplore({ ...group, entries: [...group.entries, entry] });
    } else {
      this.toolIndex.set(call.toolCallId, { index: this.items.length, entry: 0 });
      this.items.push(
        summarizeExplore({ kind: 'explore', id: `x:${call.toolCallId}`, summary: '', status: 'running', entries: [entry] }),
      );
    }
  }

  private exploreEntry(call: CodebuddyToolState): Explore['entries'][number] {
    const isRead = canonicalTool(call.toolName) === 'read';
    const path = isRead ? inputFilePath(call.input) : undefined;
    return {
      id: call.toolCallId,
      label: activityLabel(call.toolName, call.input, this.workspacePath),
      status: call.status,
      ...(path ? { path: displayPath(path, this.workspacePath) } : {}),
    };
  }

  private activityOf(call: CodebuddyToolState): Activity {
    const variant = toolVariant(call.toolName);
    const base = { kind: 'activity' as const, id: `t:${call.toolCallId}`, tool: call.toolName, status: call.status };
    const output = call.output ? truncateOutput(call.output) : undefined;

    if (variant === 'subagent') {
      const prompt =
        typeof call.input.prompt === 'string'
          ? call.input.prompt
          : typeof call.input.description === 'string'
            ? call.input.description
            : undefined;
      return {
        ...base,
        variant: 'subagent',
        label: activityLabel(call.toolName, call.input, this.workspacePath),
        subagent: {
          state: call.status === 'ok' ? 'done' : call.status === 'error' ? 'failed' : 'running',
          ...(prompt ? { prompt } : {}),
          ...(output ? { result: output } : {}),
        },
      };
    }

    if (variant === 'command') {
      const cmd = typeof call.input.command === 'string' ? (call.input.command.split('\n', 1)[0] ?? '') : '';
      return { ...base, variant: 'command', label: joinLabel(call.toolName, cmd), ...(output ? { output } : {}) };
    }

    if (variant === 'edit') {
      const path = call.diffs[0]?.path ?? inputFilePath(call.input);
      const label = path ? displayPath(path, this.workspacePath) : call.toolName;
      let stats: LineStats | undefined;
      let created = false;
      if (call.diffs.length > 0) {
        stats = sumStats(call.diffs.map((d) => lineStats(d.oldText ?? '', d.newText)));
        created = call.diffs.every((d) => d.oldText === null);
      } else if (call.status === 'ok' && typeof call.input.content === 'string') {
        stats = { additions: countLines(call.input.content), deletions: 0 };
      }
      return {
        ...base,
        variant: 'edit',
        label,
        ...(stats && call.status === 'ok' ? { stats } : {}),
        ...(created && call.status === 'ok' ? { created } : {}),
        ...(call.diffs.length > 0 && call.status === 'ok' ? { diff: { kind: 'tool' as const, callId: call.toolCallId } } : {}),
        ...(call.status === 'error' && output ? { output } : {}),
      };
    }

    return {
      ...base,
      variant: 'generic',
      label: activityLabel(call.toolName, call.input, this.workspacePath),
      ...(output ? { output } : {}),
    };
  }

  private changed(): void {
    this.version++;
  }
}

export function extractCodebuddyDiffs(toolName: string, input: Record<string, unknown>): CodebuddyDiff[] {
  const targetPath = inputFilePath(input);
  if (!targetPath || toolVariant(toolName) !== 'edit') return [];

  const oldStr =
    typeof input.old_string === 'string'
      ? input.old_string
      : typeof input.oldString === 'string'
        ? input.oldString
        : undefined;
  const newStr =
    typeof input.new_string === 'string'
      ? input.new_string
      : typeof input.newString === 'string'
        ? input.newString
        : undefined;
  if (newStr !== undefined) {
    return [{ path: targetPath, oldText: oldStr ?? null, newText: newStr }];
  }
  if (Array.isArray(input.edits)) {
    const multi = (input.edits as Record<string, unknown>[]).flatMap((edit): CodebuddyDiff[] => {
      const o =
        typeof edit?.old_string === 'string'
          ? edit.old_string
          : typeof edit?.oldString === 'string'
            ? edit.oldString
            : null;
      const n =
        typeof edit?.new_string === 'string'
          ? edit.new_string
          : typeof edit?.newString === 'string'
            ? edit.newString
            : undefined;
      return n !== undefined ? [{ path: targetPath, oldText: o, newText: n }] : [];
    });
    if (multi.length > 0) return multi;
  }
  if (canonicalTool(toolName) === 'write' && typeof input.content === 'string') {
    return [{ path: targetPath, oldText: null, newText: input.content }];
  }
  return [];
}

/** 清洗 CodeBuddy 命令输出格式 `Stdout: ...\n\nStderr: ...\nExit Code: N\nSignal: ...`。 */
export function cleanCodebuddyCommandOutput(raw: string): string | undefined {
  const match = /^Stdout:\s*([\s\S]*?)\n\nStderr:\s*([\s\S]*?)\nExit Code:\s*(-?\d+)(?:\nSignal:\s*([^\n]*))?$/u.exec(raw.trim());
  if (!match) return raw.trim() || undefined;
  const stdout = match[1]?.trim() === '(empty)' ? '' : (match[1] ?? '').trim();
  const stderr = match[2]?.trim() === '(empty)' ? '' : (match[2] ?? '').trim();
  const exitCode = Number(match[3]);
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (Number.isFinite(exitCode) && exitCode !== 0) parts.push(`exit ${exitCode}`);
  return parts.join('\n') || undefined;
}

function formatToolOutput(
  toolName: string,
  rawText: string | undefined,
  rawResponse: Record<string, unknown> | undefined,
  renderer: unknown,
  isError: boolean,
): string | undefined {
  if (toolVariant(toolName) === 'command') {
    if (rawText) {
      const cleaned = cleanCodebuddyCommandOutput(rawText);
      if (cleaned) return cleaned;
    }
    if (renderer && typeof renderer === 'object' && typeof (renderer as { value?: unknown }).value === 'string') {
      const val = (renderer as { value: string }).value.trim();
      const exitCode = typeof rawResponse?.exitCode === 'number' ? rawResponse.exitCode : 0;
      if (val) return exitCode !== 0 ? `${val}\nexit ${exitCode}` : val;
    }
    return undefined;
  }
  if (toolVariant(toolName) === 'edit' && !isError) {
    // 写入成功文案不作为额外输出行展示
    return undefined;
  }
  return rawText?.trim() || undefined;
}

function extractRawToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = (content as Record<string, unknown>[])
      .map((b) => (typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    return text || undefined;
  }
  return undefined;
}

function extractReplayUserInput(content: unknown): { readonly text: string; readonly images: readonly ImageView[] } {
  let rawText = '';
  const images: ImageView[] = [];
  if (typeof content === 'string') {
    rawText = content;
  } else if (Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      if ((part?.type === 'input_text' || part?.type === 'text') && typeof part.text === 'string') {
        rawText += (rawText ? '\n' : '') + part.text;
      } else if (part?.type === 'image' || part?.type === 'input_image') {
        const src = part.source && typeof part.source === 'object' ? (part.source as Record<string, unknown>) : undefined;
        const mediaType = typeof src?.media_type === 'string' ? src.media_type : 'image/png';
        images.push({ mediaType });
      }
    }
  }
  const cleaned = rawText
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gu, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gu, '')
    .trim();
  return { text: cleaned, images };
}

function extractTodoArray(raw: unknown): Todo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>[]).map((e) => ({
    content:
      typeof e?.content === 'string'
        ? e.content
        : typeof e?.subject === 'string'
          ? e.subject
          : typeof e?.title === 'string'
            ? e.title
            : '',
    status:
      e?.status === 'completed' || e?.status === 'done'
        ? 'completed'
        : e?.status === 'in_progress' || e?.status === 'running'
          ? 'in_progress'
          : 'pending',
  }));
}

function extractTodosFromTool(call: CodebuddyToolState): Todo[] | undefined {
  if (canonicalTool(call.toolName) !== 'todo_write') return undefined;
  return extractTodoArray(call.input.todos);
}

function extractGoalFromTool(call: CodebuddyToolState): SessionHeader['goal'] | undefined {
  const canon = canonicalTool(call.toolName);
  if (canon !== 'create_goal' && canon !== 'update_goal') return undefined;
  const obj = call.input;
  const objective = typeof obj.objective === 'string' ? obj.objective.trim() : '';
  if (!objective) return undefined;
  const rawPhase = typeof obj.phase === 'string' ? obj.phase : 'active';
  const phase: NonNullable<SessionHeader['goal']>['phase'] =
    rawPhase === 'paused' || rawPhase === 'blocked' || rawPhase === 'complete' ? rawPhase : 'active';
  return {
    objective,
    phase,
    round: typeof obj.round === 'number' ? obj.round : 1,
    maxRounds: typeof obj.maxRounds === 'number' ? obj.maxRounds : 10,
    ...(typeof obj.blockedReason === 'string' && obj.blockedReason ? { blockedReason: obj.blockedReason } : {}),
  };
}

function extractCodebuddyErrorText(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
    if (obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)) {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === 'string' && inner.message.trim()) return inner.message.trim();
    }
  }
  return undefined;
}

function truncateOutput(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > OUTPUT_LIMIT ? `${trimmed.slice(0, OUTPUT_LIMIT)}\n${t('output.truncated')}` : trimmed;
}

/**
 * Pi Coding Agent（`pi --mode rpc`）会话投影层：
 * 将实时 `AgentSessionEvent`（`agent_start`、`message_update`、`message_end`、`tool_execution_*`、`agent_end`）
 * 以及 `get_messages` / 磁盘 `.jsonl` 历史消息列表统一投影为 Harness Deck 视图模型。
 */
import { joinLabel, type ImageView, type Item, type LineStats, type SessionHeader } from '@harness-deck/shared';
import { inputFilePath, type AcpDiff, type FileChange } from '../acp/projection.ts';
import { t } from '../i18n.ts';
import { splitContext } from '../vm/context.ts';
import { countLines, lineStats, sumStats } from '../vm/diffs.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { activityLabel, parseArguments, summarizeExplore, toolVariant } from '../vm/toolRows.ts';
import { costOf, normalizeUsage, UsageTracker } from '../vm/usage.ts';

const OUTPUT_LIMIT = 4_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export type PiDiff = AcpDiff;
export type PiFileChange = FileChange;

export interface PiToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'running' | 'ok' | 'error';
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly diffs: readonly PiDiff[];
}

type Todo = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' };
type Activity = Extract<Item, { kind: 'activity' }>;
type Explore = Extract<Item, { kind: 'explore' }>;

export class PiSessionProjection {
  private items: Item[] = [];
  private readonly toolIndex = new Map<string, { index: number; entry?: number }>();
  private readonly tools = new Map<string, PiToolState>();
  private counter = 0;
  private changesCache: { readonly version: number; readonly value: readonly PiFileChange[] } | undefined;
  private streamedText = false;
  private streamedThinking = false;
  private pendingTurnError?: string;
  private contextWindow = DEFAULT_CONTEXT_WINDOW;

  version = 0;
  title?: string;
  todos?: readonly Todo[];
  goal?: SessionHeader['goal'];
  usage?: { readonly used: number; readonly size: number };
  /** 每条助手消息的用量和费用（悬浮明细）。 */
  readonly usageTracker = new UsageTracker();
  runningSince?: number;

  constructor(private readonly workspacePath: string) {}

  get running(): boolean {
    return this.runningSince !== undefined;
  }

  setContextWindow(windowTokens: number | undefined): void {
    if (windowTokens && windowTokens > 0) {
      this.contextWindow = windowTokens;
      if (this.usage) {
        this.usage = { used: this.usage.used, size: windowTokens };
      }
    }
  }

  snapshotItems(): readonly Item[] {
    return this.items;
  }

  toolCall(callId: string): PiToolState | undefined {
    return this.tools.get(callId);
  }

  diffsOf(callId: string): readonly PiDiff[] {
    return this.tools.get(callId)?.diffs ?? [];
  }

  fileChanges(): readonly PiFileChange[] {
    if (this.changesCache?.version === this.version) return this.changesCache.value;
    const value = this.computeFileChanges();
    this.changesCache = { version: this.version, value };
    return value;
  }

  private computeFileChanges(): PiFileChange[] {
    const files = new Map<
      string,
      { diffs: PiDiff[]; calls: string[]; created: boolean; additions: number; deletions: number }
    >();
    for (const call of this.tools.values()) {
      if (call.status !== 'ok' || toolVariant(call.toolName) !== 'edit') continue;
      const fallbackPath = inputFilePath(call.input);
      const entries: { path: string; diff?: PiDiff; stats: LineStats }[] = call.diffs.length
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
    this.usageTracker.reset();
    this.streamedText = false;
    this.streamedThinking = false;
    this.pendingTurnError = undefined;
    this.changed();
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
    this.pendingTurnError = undefined;
    this.changed();
  }

  endTurn(now: number, outcome: 'completed' | 'cancelled' | 'failed', errorText?: string): void {
    const startedAt = this.runningSince;
    this.runningSince = undefined;
    this.streamedText = false;
    this.streamedThinking = false;
    this.pendingTurnError = undefined;
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

  /** 应用 `pi --mode rpc` 实时事件帧。 */
  applyEvent(raw: Record<string, unknown>, now = Date.now()): void {
    const type = typeof raw.type === 'string' ? raw.type : '';
    switch (type) {
      case 'agent_start':
      case 'turn_start': {
        if (this.runningSince === undefined) this.runningSince = now;
        this.streamedText = false;
        this.streamedThinking = false;
        break;
      }

      case 'message_start': {
        const msg = raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : undefined;
        if (msg?.role === 'assistant') {
          this.streamedText = false;
          this.streamedThinking = false;
        }
        break;
      }

      case 'message_update': {
        if (this.runningSince === undefined) this.runningSince = now;
        const ev =
          raw.assistantMessageEvent && typeof raw.assistantMessageEvent === 'object'
            ? (raw.assistantMessageEvent as Record<string, unknown>)
            : undefined;
        if (!ev) return;
        const evType = typeof ev.type === 'string' ? ev.type : '';
        if (evType === 'text_delta' && typeof ev.delta === 'string' && ev.delta) {
          this.appendAssistant(ev.delta, 'markdown', true);
          this.streamedText = true;
        } else if (evType === 'thinking_delta' && typeof ev.delta === 'string' && ev.delta) {
          this.appendAssistant(ev.delta, 'reasoning', true);
          this.streamedThinking = true;
        }
        break;
      }

      case 'message_end': {
        const msg = raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : undefined;
        if (!msg) return;
        if (msg.role === 'assistant') {
          this.applyPiUsage(msg.usage);
          if (msg.stopReason === 'error' || (typeof msg.errorMessage === 'string' && msg.errorMessage.trim())) {
            this.pendingTurnError =
              typeof msg.errorMessage === 'string' && msg.errorMessage.trim()
                ? msg.errorMessage.trim()
                : t('notice.errorUnknown');
          }
          const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
          for (const block of content) {
            const bType = typeof block?.type === 'string' ? block.type : '';
            if (bType === 'thinking' && !this.streamedThinking) {
              const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
              if (text) this.appendAssistant(text, 'reasoning', false);
            } else if (bType === 'text' && !this.streamedText) {
              const text = typeof block.text === 'string' ? block.text : '';
              if (text) this.appendAssistant(text, 'markdown', false);
            } else if (bType === 'toolCall') {
              const id = typeof block.id === 'string' ? block.id : '';
              const name = typeof block.name === 'string' ? block.name : 'tool';
              if (!id) continue;
              const args = parseArguments(block.arguments ?? block.input);
              const prev = this.tools.get(id);
              const call: PiToolState = {
                toolCallId: id,
                toolName: name,
                status: prev?.status ?? 'running',
                input: args,
                ...(prev?.output !== undefined ? { output: prev.output } : {}),
                diffs: extractPiDiffs(name, args),
              };
              const todos = extractTodosFromTool(call);
              if (todos) this.todos = todos;
              this.upsertTool(call);
            }
          }
          this.streamedText = false;
          this.streamedThinking = false;
          this.settleText();
        }
        break;
      }

      case 'tool_execution_start': {
        const callId = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
        const toolName = typeof raw.toolName === 'string' ? raw.toolName : 'tool';
        if (!callId) return;
        this.settleText();
        const input = parseArguments(raw.args ?? raw.input);
        const call: PiToolState = {
          toolCallId: callId,
          toolName,
          status: 'running',
          input,
          diffs: extractPiDiffs(toolName, input),
        };
        const todos = extractTodosFromTool(call);
        if (todos) this.todos = todos;
        this.upsertTool(call);
        break;
      }

      case 'tool_execution_update': {
        const callId = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
        if (!callId) return;
        const prev = this.tools.get(callId);
        const toolName = typeof raw.toolName === 'string' ? raw.toolName : (prev?.toolName ?? 'tool');
        const input = parseArguments(raw.args ?? prev?.input);
        const output = extractPiToolResultText(raw.partialResult);
        this.upsertTool({
          toolCallId: callId,
          toolName,
          status: 'running',
          input,
          ...(output ? { output } : prev?.output ? { output: prev.output } : {}),
          diffs: prev?.diffs.length ? prev.diffs : extractPiDiffs(toolName, input),
        });
        break;
      }

      case 'tool_execution_end': {
        const callId = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
        if (!callId) return;
        const prev = this.tools.get(callId);
        const toolName = typeof raw.toolName === 'string' ? raw.toolName : (prev?.toolName ?? 'tool');
        const input = prev?.input ?? parseArguments(raw.args);
        const isError = raw.isError === true;
        const output = extractPiToolResultText(raw.result);
        const diffs = prev?.diffs.length ? prev.diffs : extractPiDiffs(toolName, input);
        const call: PiToolState = {
          toolCallId: callId,
          toolName,
          status: isError ? 'error' : 'ok',
          input,
          ...(output ? { output } : prev?.output ? { output: prev.output } : {}),
          diffs,
        };
        const todos = extractTodosFromTool(call);
        if (todos) this.todos = todos;
        this.upsertTool(call);
        break;
      }

      case 'agent_end': {
        const aborted = raw.aborted === true;
        if (aborted) {
          this.endTurn(now, 'cancelled');
        } else if (this.pendingTurnError) {
          this.endTurn(now, 'failed', this.pendingTurnError);
        } else {
          this.endTurn(now, 'completed');
        }
        return;
      }

      case 'extension_error': {
        const errMsg = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : undefined;
        if (errMsg) {
          this.items.push({ kind: 'notice', id: `n:${++this.counter}`, level: 'warning', text: errMsg });
        }
        break;
      }

      default:
        return;
    }
    this.changed();
  }

  /** 应用 `get_messages`（或磁盘 `.jsonl`）返回的会话消息列表快照。 */
  applyMessagesSnapshot(rawMessages: unknown): void {
    const list = extractMessageList(rawMessages);
    this.reset();
    if (!list) return;

    for (const msg of list) {
      const role = typeof msg.role === 'string' ? msg.role : '';
      if (role === 'user') {
        const parsed = extractPiReplayUser(msg.content);
        if (parsed.text || parsed.images.length > 0) {
          this.addUserMessage(parsed.text, parsed.images);
        }
        continue;
      }

      if (role === 'assistant') {
        this.applyPiUsage(msg.usage);
        const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
        for (const block of content) {
          const bType = typeof block?.type === 'string' ? block.type : '';
          if (bType === 'thinking') {
            const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
            if (text) this.appendAssistant(text, 'reasoning', false);
          } else if (bType === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            if (text) this.appendAssistant(text, 'markdown', false);
          } else if (bType === 'toolCall') {
            const id = typeof block.id === 'string' ? block.id : '';
            const name = typeof block.name === 'string' ? block.name : 'tool';
            if (!id) continue;
            this.settleText();
            const args = parseArguments(block.arguments ?? block.input);
            const call: PiToolState = {
              toolCallId: id,
              toolName: name,
              status: 'ok',
              input: args,
              diffs: extractPiDiffs(name, args),
            };
            const todos = extractTodosFromTool(call);
            if (todos) this.todos = todos;
            this.upsertTool(call);
          }
        }
        this.settleText();
        continue;
      }

      if (role === 'toolResult') {
        const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
        if (!callId) continue;
        const prev = this.tools.get(callId);
        const toolName = typeof msg.toolName === 'string' ? msg.toolName : (prev?.toolName ?? 'tool');
        const isError = msg.isError === true;
        const output = extractPiToolResultText(msg);
        this.upsertTool({
          toolCallId: callId,
          toolName,
          status: isError ? 'error' : 'ok',
          input: prev?.input ?? {},
          ...(output ? { output } : {}),
          diffs: prev?.diffs ?? [],
        });
      }
    }
    this.settleText();
    this.changed();
  }

  private applyPiUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const u = raw as Record<string, unknown>;
    this.usageTracker.addRequest(normalizeUsage(u));
    this.usageTracker.addCost(costOf(u));
    const total =
      typeof u.totalTokens === 'number' && u.totalTokens > 0
        ? u.totalTokens
        : (typeof u.input === 'number' ? u.input : 0) +
          (typeof u.cacheRead === 'number' ? u.cacheRead : 0) +
          (typeof u.cacheWrite === 'number' ? u.cacheWrite : 0) +
          (typeof u.output === 'number' ? u.output : 0);
    if (total > 0) {
      this.usage = { used: total, size: this.contextWindow };
    }
  }

  private appendAssistant(text: string, field: 'markdown' | 'reasoning', streaming = this.running): void {
    if (!text) return;
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

  private upsertTool(call: PiToolState): void {
    const previous = this.tools.get(call.toolCallId);
    const merged: PiToolState = previous
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
    if (canon === 'todo_write' || canon === 'create_goal' || canon === 'update_goal') return;

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

  private addExplore(call: PiToolState): void {
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

  private exploreEntry(call: PiToolState): Explore['entries'][number] {
    const isRead = canonicalTool(call.toolName) === 'read';
    const path = isRead ? inputFilePath(call.input) : undefined;
    return {
      id: call.toolCallId,
      label: activityLabel(call.toolName, call.input, this.workspacePath),
      status: call.status,
      ...(path ? { path: displayPath(path, this.workspacePath) } : {}),
    };
  }

  private activityOf(call: PiToolState): Activity {
    const variant = toolVariant(call.toolName);
    const base = { kind: 'activity' as const, id: `t:${call.toolCallId}`, tool: call.toolName, status: call.status };
    const output = call.output ? truncateOutput(call.output) : undefined;

    if (variant === 'subagent') {
      const prompt =
        typeof call.input.prompt === 'string'
          ? call.input.prompt
          : typeof call.input.task === 'string'
            ? call.input.task
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

export function extractPiDiffs(toolName: string, input: Record<string, unknown>): PiDiff[] {
  const targetPath = inputFilePath(input);
  if (!targetPath || toolVariant(toolName) !== 'edit') return [];

  const oldStr =
    typeof input.oldText === 'string'
      ? input.oldText
      : typeof input.old_string === 'string'
        ? input.old_string
        : typeof input.oldString === 'string'
          ? input.oldString
          : undefined;
  const newStr =
    typeof input.newText === 'string'
      ? input.newText
      : typeof input.new_string === 'string'
        ? input.new_string
        : typeof input.newString === 'string'
          ? input.newString
          : undefined;
  if (newStr !== undefined) {
    return [{ path: targetPath, oldText: oldStr ?? null, newText: newStr }];
  }
  if (Array.isArray(input.edits)) {
    const multi = (input.edits as Record<string, unknown>[]).flatMap((edit): PiDiff[] => {
      const o =
        typeof edit?.oldText === 'string'
          ? edit.oldText
          : typeof edit?.old_string === 'string'
            ? edit.old_string
            : null;
      const n =
        typeof edit?.newText === 'string'
          ? edit.newText
          : typeof edit?.new_string === 'string'
            ? edit.new_string
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

function extractPiToolResultText(rawResult: unknown): string | undefined {
  if (!rawResult || typeof rawResult !== 'object') {
    return typeof rawResult === 'string' && rawResult.trim() ? rawResult.trim() : undefined;
  }
  const obj = rawResult as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const text = (obj.content as Record<string, unknown>[])
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (typeof obj.content === 'string' && obj.content.trim()) return obj.content.trim();
  if (typeof obj.output === 'string' && obj.output.trim()) return obj.output.trim();
  return undefined;
}

function extractMessageList(raw: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages as Record<string, unknown>[];
  }
  return undefined;
}

function extractPiReplayUser(content: unknown): { readonly text: string; readonly images: readonly ImageView[] } {
  let rawText = '';
  const images: ImageView[] = [];
  if (typeof content === 'string') {
    rawText = content;
  } else if (Array.isArray(content)) {
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        rawText += (rawText ? '\n' : '') + part.text;
      } else if (part?.type === 'image') {
        const mediaType = typeof part.mimeType === 'string' ? part.mimeType : 'image/png';
        images.push({ mediaType });
      }
    }
  }
  const cleaned = rawText.replace(/<available_skills>[\s\S]*?<\/available_skills>/gu, '').trim();
  return { text: cleaned, images };
}

function extractTodosFromTool(call: PiToolState): Todo[] | undefined {
  if (canonicalTool(call.toolName) !== 'todo_write') return undefined;
  const raw = call.input.todos;
  if (!Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>[]).map((e) => ({
    content: typeof e?.content === 'string' ? e.content : typeof e?.title === 'string' ? e.title : '',
    status:
      e?.status === 'completed' || e?.status === 'done'
        ? 'completed'
        : e?.status === 'in_progress' || e?.status === 'running'
          ? 'in_progress'
          : 'pending',
  }));
}

function truncateOutput(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > OUTPUT_LIMIT ? `${trimmed.slice(0, OUTPUT_LIMIT)}\n${t('output.truncated')}` : trimmed;
}

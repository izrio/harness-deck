/**
 * Claude Code（`claude -p --output-format stream-json`）会话投影层：
 * 同时支持实时流式事件（`system`、`stream_event`、`assistant`、`user`、`result`）
 * 与本地 `~/.claude/projects/<project>/<id>.jsonl` 历史会话回放。
 */
import { joinLabel, type ImageView, type Item, type LineStats, type SessionHeader } from '@harness-deck/shared';
import { inputFilePath, type AcpDiff, type FileChange } from '../acp/projection.ts';
import { t } from '../i18n.ts';
import { splitContext } from '../vm/context.ts';
import { countLines, lineStats, sumStats } from '../vm/diffs.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { activityLabel, parseArguments, summarizeExplore, toolVariant } from '../vm/toolRows.ts';

const OUTPUT_LIMIT = 4_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export type ClaudeDiff = AcpDiff;
export type ClaudeFileChange = FileChange;

export interface ClaudeToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'running' | 'ok' | 'error';
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly diffs: readonly ClaudeDiff[];
}

type Todo = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' };
type Activity = Extract<Item, { kind: 'activity' }>;
type Explore = Extract<Item, { kind: 'explore' }>;

export class ClaudeSessionProjection {
  private items: Item[] = [];
  private readonly toolIndex = new Map<string, { index: number; entry?: number }>();
  private readonly tools = new Map<string, ClaudeToolState>();
  private counter = 0;
  private changesCache: { readonly version: number; readonly value: readonly ClaudeFileChange[] } | undefined;
  private streamedText = false;
  private streamedThinking = false;
  private contextWindow = DEFAULT_CONTEXT_WINDOW;

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

  toolCall(callId: string): ClaudeToolState | undefined {
    return this.tools.get(callId);
  }

  diffsOf(callId: string): readonly ClaudeDiff[] {
    return this.tools.get(callId)?.diffs ?? [];
  }

  fileChanges(): readonly ClaudeFileChange[] {
    if (this.changesCache?.version === this.version) return this.changesCache.value;
    const value = this.computeFileChanges();
    this.changesCache = { version: this.version, value };
    return value;
  }

  private computeFileChanges(): ClaudeFileChange[] {
    const files = new Map<
      string,
      { diffs: ClaudeDiff[]; calls: string[]; created: boolean; additions: number; deletions: number }
    >();
    for (const call of this.tools.values()) {
      if (call.status !== 'ok' || toolVariant(call.toolName) !== 'edit') continue;
      const fallbackPath = inputFilePath(call.input);
      const entries: { path: string; diff?: ClaudeDiff; stats: LineStats }[] = call.diffs.length
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
    this.changed();
  }

  endTurn(now: number, outcome: 'completed' | 'cancelled' | 'failed', errorText?: string): void {
    const startedAt = this.runningSince;
    this.runningSince = undefined;
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

  /** 回放 `.jsonl` 历史会话记录列表。 */
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

  /** 应用一条 `claude -p` NDJSON 事件帧。 */
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
          if (typeof raw.permissionMode === 'string' && raw.permissionMode) this.mode = raw.permissionMode;
          if (Array.isArray(raw.slash_commands)) {
            this.slashCommands = raw.slash_commands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
          }
          this.changed();
        }
        return;
      }

      case 'stream_event': {
        if (parentToolId) return;
        const event = raw.event && typeof raw.event === 'object' ? (raw.event as Record<string, unknown>) : undefined;
        if (!event) return;
        if (this.runningSince === undefined && !isReplay) this.runningSince = now;
        const evType = typeof event.type === 'string' ? event.type : '';
        if (evType === 'message_start') {
          this.streamedText = false;
          this.streamedThinking = false;
          const msg = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : undefined;
          if (msg?.usage) this.applyUsageObject(msg.usage);
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
              diffs: extractClaudeDiffs(cb.name, input),
            });
          }
        } else if (evType === 'content_block_delta') {
          const delta = event.delta && typeof event.delta === 'object' ? (event.delta as Record<string, unknown>) : undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            this.appendAssistant(delta.text, 'markdown', true);
            this.streamedText = true;
          } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
            this.appendAssistant(delta.thinking, 'reasoning', true);
            this.streamedThinking = true;
          }
        } else if (evType === 'message_delta') {
          if (event.usage) this.applyUsageObject(event.usage);
        } else if (evType === 'error') {
          const errText = extractClaudeErrorText(event.error ?? event) ?? t('notice.errorUnknown');
          if (!isReplay) this.endTurn(now, 'failed', errText);
          return;
        }
        this.changed();
        return;
      }

      case 'assistant': {
        if (parentToolId) return;
        const msg = raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : raw;
        if (msg.usage) this.applyUsageObject(msg.usage);
        if (typeof msg.model === 'string' && msg.model) this.model = msg.model;

        const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
        for (const block of content) {
          const bType = typeof block?.type === 'string' ? block.type : '';
          if (bType === 'thinking') {
            const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
            if (text && !this.streamedThinking) {
              this.appendAssistant(text, 'reasoning', !isReplay && this.running);
            }
          } else if (bType === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            if (text && !this.streamedText) {
              this.appendAssistant(text, 'markdown', !isReplay && this.running);
            }
          } else if (bType === 'tool_use') {
            const id = typeof block.id === 'string' ? block.id : '';
            const name = typeof block.name === 'string' ? block.name : 'tool';
            if (!id) continue;
            this.settleText();
            const input = parseArguments(block.input);
            const existing = this.tools.get(id);
            const call: ClaudeToolState = {
              toolCallId: id,
              toolName: name,
              status: existing?.status === 'ok' || existing?.status === 'error' ? existing.status : 'running',
              input,
              ...(existing?.output !== undefined ? { output: existing.output } : {}),
              diffs: extractClaudeDiffs(name, input),
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
              const output = extractToolResultText(tr.content, raw.tool_use_result);
              const refinedDiffs = refineDiffsFromToolResult(prev, raw.tool_use_result);
              this.upsertTool({
                ...prev,
                status: isError ? 'error' : 'ok',
                ...(output ? { output } : {}),
                diffs: refinedDiffs,
              });
            }
            this.changed();
            return;
          }
        }

        // 历史会话回放时将非 meta 的用户输入还原为对话消息
        if (isReplay && raw.isMeta !== true && !parentToolId) {
          const parsed = extractReplayUserInput(content);
          if (parsed.text || parsed.images.length > 0) {
            this.addUserMessage(parsed.text, parsed.images);
          }
        }
        return;
      }

      case 'error': {
        const errText = extractClaudeErrorText(raw.error ?? raw) ?? t('notice.errorUnknown');
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
        if (raw.usage) this.applyUsageObject(raw.usage);
        const rawErrorText = extractClaudeErrorText(raw.error);
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
          if (!isReplay) this.endTurn(now, 'failed', errText);
          return;
        }
        if (
          typeof raw.result === 'string' &&
          raw.result.trim() &&
          !this.items.some((i) => i.kind === 'assistant' && i.markdown.trim().length > 0)
        ) {
          this.appendAssistant(raw.result.trim(), 'markdown', false);
        }
        if (!isReplay) this.endTurn(now, 'completed');
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
    const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
    const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
    const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    const used = input + cacheCreate + cacheRead + output;
    if (used > 0) {
      this.usage = { used, size: this.contextWindow };
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

  private upsertTool(call: ClaudeToolState): void {
    const previous = this.tools.get(call.toolCallId);
    const merged: ClaudeToolState = previous
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

  private addExplore(call: ClaudeToolState): void {
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

  private exploreEntry(call: ClaudeToolState): Explore['entries'][number] {
    const isRead = canonicalTool(call.toolName) === 'read';
    const path = isRead ? inputFilePath(call.input) : undefined;
    return {
      id: call.toolCallId,
      label: activityLabel(call.toolName, call.input, this.workspacePath),
      status: call.status,
      ...(path ? { path: displayPath(path, this.workspacePath) } : {}),
    };
  }

  private activityOf(call: ClaudeToolState): Activity {
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

export function extractClaudeDiffs(toolName: string, input: Record<string, unknown>): ClaudeDiff[] {
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
    const multi = (input.edits as Record<string, unknown>[]).flatMap((edit): ClaudeDiff[] => {
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

function refineDiffsFromToolResult(prev: ClaudeToolState, meta: unknown): readonly ClaudeDiff[] {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return prev.diffs;
  const m = meta as Record<string, unknown>;
  const targetPath = typeof m.filePath === 'string' ? m.filePath : inputFilePath(prev.input);
  if (!targetPath) return prev.diffs;
  if (canonicalTool(prev.toolName) === 'write' && typeof prev.input.content === 'string') {
    if (m.type === 'update' && typeof m.originalFile === 'string') {
      return [{ path: targetPath, oldText: m.originalFile, newText: prev.input.content }];
    }
  }
  return prev.diffs;
}

function extractToolResultText(content: unknown, meta: unknown): string | undefined {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    if (typeof m.stdout === 'string' || typeof m.stderr === 'string') {
      const out = typeof m.stdout === 'string' ? m.stdout : '';
      const err = typeof m.stderr === 'string' ? m.stderr : '';
      return [out, err].filter(Boolean).join('\n').trim() || undefined;
    }
  }
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
      if (part?.type === 'text' && typeof part.text === 'string') {
        rawText += (rawText ? '\n' : '') + part.text;
      } else if (part?.type === 'image') {
        const src = part.source && typeof part.source === 'object' ? (part.source as Record<string, unknown>) : undefined;
        const mediaType = typeof src?.media_type === 'string' ? src.media_type : 'image/png';
        images.push({ mediaType });
      }
    }
  }
  const cleaned = rawText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, '')
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

function extractTodosFromTool(call: ClaudeToolState): Todo[] | undefined {
  if (canonicalTool(call.toolName) !== 'todo_write') return undefined;
  return extractTodoArray(call.input.todos);
}

function extractGoalFromTool(call: ClaudeToolState): SessionHeader['goal'] | undefined {
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

function extractClaudeErrorText(raw: unknown): string | undefined {
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

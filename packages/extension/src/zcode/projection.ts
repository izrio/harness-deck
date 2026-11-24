/**
 * ZCode 会话投影层：
 * 将 `zcode app-server --stdio` 推送的 `session/event` 流式事件（`turn.started`、`model.streaming`、
 * `tool.updated`、`turn.completed`、`turn.failed`、`session.titleUpdated`、`session.updated` 等）
 * 以及历史快照（`session/read`、`session/messages`）统一投影为 Halo 视图模型。
 */
import { joinLabel, type Item, type LineStats, type SessionHeader } from '@harness-deck/shared';
import { t } from '../i18n.ts';
import { splitContext } from '../vm/context.ts';
import { countLines, lineStats, sumStats } from '../vm/diffs.ts';
import { displayPath } from '../vm/paths.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { activityLabel, parseArguments, summarizeExplore, toolVariant } from '../vm/toolRows.ts';
import { costOf, normalizeUsage, UsageTracker } from '../vm/usage.ts';
import { inputFilePath, type AcpDiff, type FileChange } from '../acp/projection.ts';

const OUTPUT_LIMIT = 4_000;

export type ZcodeDiff = AcpDiff;
export type ZcodeFileChange = FileChange;

export interface ZcodeToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'running' | 'ok' | 'error';
  readonly input: Record<string, unknown>;
  readonly output?: unknown;
  readonly diffs: readonly ZcodeDiff[];
}

type Todo = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' };
type Activity = Extract<Item, { kind: 'activity' }>;
type Explore = Extract<Item, { kind: 'explore' }>;

export class ZcodeSessionProjection {
  private items: Item[] = [];
  private readonly toolIndex = new Map<string, { index: number; entry?: number }>();
  private readonly tools = new Map<string, ZcodeToolState>();
  private counter = 0;
  private changesCache: { readonly version: number; readonly value: readonly ZcodeFileChange[] } | undefined;

  version = 0;
  title?: string;
  mode?: string;
  todos?: readonly Todo[];
  goal?: SessionHeader['goal'];
  usage?: { readonly used: number; readonly size: number };
  readonly usageTracker = new UsageTracker();
  runningSince?: number;

  constructor(private readonly workspacePath: string) {}

  get running(): boolean {
    return this.runningSince !== undefined;
  }

  snapshotItems(): readonly Item[] {
    return this.items;
  }

  toolCall(callId: string): ZcodeToolState | undefined {
    return this.tools.get(callId);
  }

  diffsOf(callId: string): readonly ZcodeDiff[] {
    return this.tools.get(callId)?.diffs ?? [];
  }

  fileChanges(): readonly ZcodeFileChange[] {
    if (this.changesCache?.version === this.version) return this.changesCache.value;
    const value = this.computeFileChanges();
    this.changesCache = { version: this.version, value };
    return value;
  }

  private computeFileChanges(): ZcodeFileChange[] {
    const files = new Map<string, { diffs: ZcodeDiff[]; calls: string[]; created: boolean; additions: number; deletions: number }>();
    for (const call of this.tools.values()) {
      if (call.status !== 'ok' || toolVariant(call.toolName) !== 'edit') continue;
      const fallbackPath = inputFilePath(call.input);
      const entries: { path: string; diff?: ZcodeDiff; stats: LineStats }[] = call.diffs.length
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
    this.usage = undefined;
    this.usageTracker.reset();
    this.changed();
  }

  addUserMessage(text: string, images: Extract<Item, { kind: 'user' }>['images'] = []): void {
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
    this.usageTracker.startRequest(now);
    this.changed();
  }

  endTurn(now: number, outcome: 'completed' | 'cancelled' | 'failed', errorText?: string): void {
    const startedAt = this.runningSince;
    this.runningSince = undefined;
    this.usageTracker.finishRequest(undefined, now);
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

  /** 应用一条实时 `session/event` 载荷。 */
  applyEvent(raw: Record<string, unknown>, now = Date.now()): void {
    const event = (raw.event && typeof raw.event === 'object' ? (raw.event as Record<string, unknown>) : raw);
    const type = typeof event.type === 'string' ? event.type : '';
    const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : event;

    switch (type) {
      case 'turn.started':
      case 'turn/start': {
        const started = typeof payload.executionStartedAt === 'number' ? payload.executionStartedAt : now;
        this.runningSince = started;
        break;
      }
      case 'model.streaming':
      case 'assistant.streaming': {
        if (this.runningSince === undefined) this.runningSince = now;
        if (typeof payload.delta === 'string') {
          const kind = typeof payload.kind === 'string' ? payload.kind : '';
          if (kind === 'reasoning_delta') {
            this.appendAssistant(payload.delta, 'reasoning');
          } else if (kind === 'text_delta' || !kind) {
            this.appendAssistant(payload.delta, 'markdown');
          }
          break;
        }
        const delta = payload.delta && typeof payload.delta === 'object' ? (payload.delta as Record<string, unknown>) : payload;
        const reasoning =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : typeof delta.reasoningDelta === 'string'
                ? delta.reasoningDelta
                : '';
        const text =
          typeof delta.content === 'string'
            ? delta.content
            : typeof delta.text === 'string'
              ? delta.text
              : typeof delta.textDelta === 'string'
                ? delta.textDelta
                : '';
        if (reasoning) this.appendAssistant(reasoning, 'reasoning');
        if (text) this.appendAssistant(text, 'markdown');
        break;
      }
      case 'tool.updated':
      case 'tool.started':
      case 'tool.completed':
      case 'tool/call':
      case 'tool/result': {
        const call = normalizeToolEvent(payload, this.tools);
        if (!call) return;
        const todos = extractTodosFromTool(call);
        if (todos) this.todos = todos;
        const goal = extractGoalFromTool(call);
        if (goal) this.goal = goal;
        this.upsertTool(call);
        break;
      }
      case 'plan.updated':
      case 'todo.updated':
      case 'todos.updated': {
        const list = extractTodoArray(payload.todos ?? payload.entries ?? payload.items);
        if (list) this.todos = list;
        break;
      }
      case 'goal.updated': {
        const goal = parseGoalObject(payload.goal ?? payload);
        if (goal) this.goal = goal;
        break;
      }
      case 'session.titleUpdated':
      case 'session/title': {
        if (typeof payload.title === 'string' && payload.title.trim()) {
          this.title = payload.title.trim();
        }
        break;
      }
      case 'session.updated':
      case 'usage.updated': {
        this.applyMetadata(payload);
        break;
      }
      case 'turn.completed':
      case 'turn/end': {
        this.applyMetadata(payload);
        const aborted =
          payload.aborted === true ||
          payload.stopReason === 'cancelled' ||
          payload.reason === 'aborted' ||
          payload.resultType === 'cancelled';
        this.endTurn(now, aborted ? 'cancelled' : 'completed');
        return;
      }
      case 'turn.failed': {
        const errObj = payload.error && typeof payload.error === 'object' ? (payload.error as { message?: unknown }) : undefined;
        const message =
          typeof errObj?.message === 'string'
            ? errObj.message
            : typeof payload.error === 'string'
              ? payload.error
              : typeof payload.message === 'string'
                ? payload.message
                : t('notice.errorUnknown');
        this.endTurn(now, 'failed', message);
        return;
      }
      default:
        return;
    }
    this.changed();
  }

  /** 应用 `session/read` 与 `session/messages` 返回的完整会话快照（用于打开历史会话）。 */
  applySnapshot(readState?: Record<string, unknown> | null, messagesResult?: unknown): void {
    if (readState) {
      this.applyMetadata(readState);
      const proj =
        readState.projection && typeof readState.projection === 'object'
          ? (readState.projection as Record<string, unknown>)
          : undefined;
      const sess =
        readState.session && typeof readState.session === 'object'
          ? (readState.session as Record<string, unknown>)
          : undefined;
      const status =
        typeof readState.status === 'string'
          ? readState.status
          : typeof proj?.status === 'string'
            ? proj.status
            : typeof sess?.status === 'string'
              ? sess.status
              : '';
      if (status === 'running' || status === 'active_turn' || status === 'in_progress') {
        this.runningSince ??= Date.now();
      } else {
        this.runningSince = undefined;
      }
    }

    const rawMessages = extractMessagesArray(messagesResult ?? readState?.messages);
    if (!rawMessages) {
      this.changed();
      return;
    }

    this.items = [];
    this.toolIndex.clear();
    this.tools.clear();

    for (const msg of rawMessages) {
      const role = typeof msg.role === 'string' ? msg.role : '';
      if (role === 'user') {
        const text = extractMessageText(msg);
        if (text) this.addUserMessage(text);
        continue;
      }
      if (role === 'assistant') {
        const parts = Array.isArray(msg.parts)
          ? (msg.parts as Record<string, unknown>[])
          : Array.isArray(msg.content)
            ? (msg.content as Record<string, unknown>[])
            : undefined;
        if (parts) {
          for (const part of parts) {
            const pType = typeof part.type === 'string' ? part.type : '';
            if (pType === 'reasoning' || pType === 'thinking') {
              const rText = typeof part.text === 'string' ? part.text : typeof part.reasoning === 'string' ? part.reasoning : '';
              if (rText) this.appendAssistant(rText, 'reasoning', false);
            } else if (pType === 'text') {
              const mText = typeof part.text === 'string' ? part.text : '';
              if (mText) this.appendAssistant(mText, 'markdown', false);
            } else if (pType === 'tool' || pType === 'toolCall' || pType === 'tool_call' || pType === 'tool-invocation') {
              const call = normalizeToolEvent(part, this.tools, 'ok');
              if (call) {
                const todos = extractTodosFromTool(call);
                if (todos) this.todos = todos;
                this.upsertTool(call);
              }
            } else if (pType === 'todo' || pType === 'plan') {
              const todos = extractTodoArray(part.todos ?? part.entries ?? part.items);
              if (todos) this.todos = todos;
            }
          }
        } else {
          if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
            this.appendAssistant(msg.reasoning_content, 'reasoning', false);
          }
          const text = extractMessageText(msg);
          if (text) this.appendAssistant(text, 'markdown', false);
        }
        this.settleText();
      }
    }
    this.changed();
  }

  applyMetadata(meta: Record<string, unknown>): void {
    const sess = meta.session && typeof meta.session === 'object' ? (meta.session as Record<string, unknown>) : undefined;
    const proj = meta.projection && typeof meta.projection === 'object' ? (meta.projection as Record<string, unknown>) : undefined;
    const rawTitle = typeof meta.title === 'string' ? meta.title : typeof sess?.title === 'string' ? sess.title : undefined;
    if (rawTitle?.trim()) {
      this.title = rawTitle.trim();
    }
    const settings = meta.settings && typeof meta.settings === 'object' ? (meta.settings as Record<string, unknown>) : undefined;
    const modeObj = settings?.mode && typeof settings.mode === 'object' ? (settings.mode as { current?: unknown }) : undefined;
    const nextMode =
      typeof meta.mode === 'string'
        ? meta.mode
        : typeof meta.permissionMode === 'string'
          ? meta.permissionMode
          : typeof proj?.mode === 'string'
            ? proj.mode
            : typeof sess?.mode === 'string'
              ? sess.mode
              : typeof modeObj?.current === 'string'
                ? modeObj.current
                : undefined;
    if (nextMode) this.mode = nextMode;

    const usageObj =
      meta.usage && typeof meta.usage === 'object'
        ? (meta.usage as Record<string, unknown>)
        : proj && typeof proj.contextWindow === 'number'
          ? proj
          : meta;
    const used =
      typeof usageObj.contextUsed === 'number'
        ? usageObj.contextUsed
        : typeof usageObj.used === 'number'
          ? usageObj.used
          : typeof usageObj.totalTokens === 'number'
            ? usageObj.totalTokens
            : undefined;
    const size =
      typeof usageObj.contextWindow === 'number'
        ? usageObj.contextWindow
        : typeof usageObj.size === 'number'
          ? usageObj.size
          : typeof usageObj.maxContextTokens === 'number'
            ? usageObj.maxContextTokens
            : undefined;
    if (used !== undefined && size !== undefined && size > 0) {
      this.usage = { used, size };
    }
    const breakdown = normalizeUsage(usageObj);
    if (breakdown) {
      this.usageTracker.setLast(breakdown);
    }
    const cost = costOf(usageObj);
    if (cost !== undefined) {
      this.usageTracker.setCost(cost);
    }

    const todos = extractTodoArray(meta.todos);
    if (todos) this.todos = todos;
    const goal = parseGoalObject(meta.goal);
    if (goal) this.goal = goal;
  }

  private appendAssistant(text: string, field: 'markdown' | 'reasoning', streaming = this.running): void {
    if (!text) return;
    if (streaming) this.usageTracker.markFirstToken();
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

  private upsertTool(call: ZcodeToolState): void {
    const previous = this.tools.get(call.toolCallId);
    const merged: ZcodeToolState = previous
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

  private addExplore(call: ZcodeToolState): void {
    const entry = this.exploreEntry(call);
    const last = this.items.length - 1;
    if (this.items[last]?.kind === 'explore') {
      const group = this.items[last] as Explore;
      this.toolIndex.set(call.toolCallId, { index: last, entry: group.entries.length });
      this.items[last] = summarizeExplore({ ...group, entries: [...group.entries, entry] });
    } else {
      this.toolIndex.set(call.toolCallId, { index: this.items.length, entry: 0 });
      this.items.push(summarizeExplore({ kind: 'explore', id: `x:${call.toolCallId}`, summary: '', status: 'running', entries: [entry] }));
    }
  }

  private exploreEntry(call: ZcodeToolState): Explore['entries'][number] {
    const isRead = canonicalTool(call.toolName) === 'read';
    const path = isRead ? inputFilePath(call.input) : undefined;
    return {
      id: call.toolCallId,
      label: activityLabel(call.toolName, call.input, this.workspacePath),
      status: call.status,
      ...(path ? { path: displayPath(path, this.workspacePath) } : {}),
    };
  }

  private activityOf(call: ZcodeToolState): Activity {
    const variant = toolVariant(call.toolName);
    const base = { kind: 'activity' as const, id: `t:${call.toolCallId}`, tool: call.toolName, status: call.status };
    const output = formatToolOutput(call.output);

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
      const cmd = typeof call.input.command === 'string' ? call.input.command.split('\n', 1)[0] ?? '' : '';
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

    return { ...base, variant: 'generic', label: activityLabel(call.toolName, call.input, this.workspacePath), ...(output ? { output } : {}) };
  }

  private changed(): void {
    this.version++;
  }
}

function normalizeToolEvent(
  raw: Record<string, unknown>,
  known: ReadonlyMap<string, ZcodeToolState>,
  defaultStatus: 'running' | 'ok' = 'running',
): ZcodeToolState | undefined {
  const toolCallId =
    typeof raw.toolCallId === 'string'
      ? raw.toolCallId
      : typeof raw.callId === 'string'
        ? raw.callId
        : typeof raw.id === 'string'
          ? raw.id
          : undefined;
  if (!toolCallId) return undefined;
  const prev = known.get(toolCallId);
  const toolName =
    typeof raw.toolName === 'string'
      ? raw.toolName
      : typeof raw.name === 'string'
        ? raw.name
        : typeof raw.tool === 'string'
          ? raw.tool
          : (prev?.toolName ?? 'tool');
  const rawStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : typeof raw.state === 'string' ? raw.state.toLowerCase() : '';
  const rawKind = typeof raw.kind === 'string' ? raw.kind.toLowerCase() : '';
  const status: 'running' | 'ok' | 'error' =
    raw.isError === true || rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'denied' || rawStatus === 'rejected' || rawKind === 'error'
      ? 'error'
      : rawStatus === 'success' || rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'ok' || rawKind === 'result'
        ? 'ok'
        : rawStatus === 'pending' || rawStatus === 'scheduled' || rawStatus === 'running' || rawStatus === 'in_progress' || rawKind === 'scheduled' || rawKind === 'started' || rawKind === 'progress'
          ? 'running'
          : defaultStatus;
  const input = parseArguments(raw.input ?? raw.arguments ?? raw.args ?? raw.rawInput);
  const output = raw.output ?? raw.result ?? raw.rawOutput ?? (rawKind === 'error' ? raw.error : undefined);
  const diffs = extractDiffs(raw, input, output, toolName);
  return {
    toolCallId,
    toolName,
    status,
    input,
    ...(output !== undefined ? { output } : {}),
    diffs,
  };
}

function extractDiffs(
  raw: Record<string, unknown>,
  input: Record<string, unknown>,
  output: unknown,
  toolName: string,
): ZcodeDiff[] {
  const outObj = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : undefined;
  const metaObj = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? (raw.meta as Record<string, unknown>) : undefined;
  const candidates = [raw.diffs, outObj?.diffs, metaObj?.diffs];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    const parsed = list.flatMap((d): ZcodeDiff[] => {
      if (!d || typeof d !== 'object') return [];
      const rec = d as Record<string, unknown>;
      const path = typeof rec.path === 'string' ? rec.path : inputFilePath(input);
      const newText = typeof rec.newText === 'string' ? rec.newText : typeof rec.after === 'string' ? rec.after : undefined;
      if (!path || newText === undefined) return [];
      const oldText =
        typeof rec.oldText === 'string'
          ? rec.oldText
          : typeof rec.before === 'string'
            ? rec.before
            : null;
      return [{ path, oldText, newText }];
    });
    if (parsed.length > 0) return parsed;
  }

  const targetPath = inputFilePath(input);
  if (!targetPath || toolVariant(toolName) !== 'edit') return [];

  const oldStr = typeof input.old_string === 'string' ? input.old_string : typeof input.oldString === 'string' ? input.oldString : undefined;
  const newStr = typeof input.new_string === 'string' ? input.new_string : typeof input.newString === 'string' ? input.newString : undefined;
  if (newStr !== undefined) {
    return [{ path: targetPath, oldText: oldStr ?? null, newText: newStr }];
  }
  if (Array.isArray(input.edits)) {
    const multi = (input.edits as Record<string, unknown>[]).flatMap((edit): ZcodeDiff[] => {
      const o = typeof edit?.old_string === 'string' ? edit.old_string : typeof edit?.oldString === 'string' ? edit.oldString : null;
      const n = typeof edit?.new_string === 'string' ? edit.new_string : typeof edit?.newString === 'string' ? edit.newString : undefined;
      return n !== undefined ? [{ path: targetPath, oldText: o, newText: n }] : [];
    });
    if (multi.length > 0) return multi;
  }
  if (canonicalTool(toolName) === 'write' && typeof input.content === 'string') {
    const existed = outObj?.created === false || metaObj?.operation === 'update';
    if (!existed) {
      return [{ path: targetPath, oldText: null, newText: input.content }];
    }
  }
  return [];
}

function extractTodoArray(raw: unknown): Todo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>[]).map((e) => ({
    content: typeof e?.content === 'string' ? e.content : typeof e?.subject === 'string' ? e.subject : typeof e?.title === 'string' ? e.title : '',
    status: e?.status === 'completed' || e?.status === 'done' ? 'completed' : e?.status === 'in_progress' || e?.status === 'running' ? 'in_progress' : 'pending',
  }));
}

function extractTodosFromTool(call: ZcodeToolState): Todo[] | undefined {
  if (canonicalTool(call.toolName) !== 'todo_write') return undefined;
  const outObj = call.output && typeof call.output === 'object' ? (call.output as Record<string, unknown>) : undefined;
  return extractTodoArray(outObj?.todos ?? call.input.todos);
}

function parseGoalObject(raw: unknown): SessionHeader['goal'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
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

function extractGoalFromTool(call: ZcodeToolState): SessionHeader['goal'] | undefined {
  const canon = canonicalTool(call.toolName);
  if (canon !== 'create_goal' && canon !== 'update_goal') return undefined;
  return parseGoalObject(call.output ?? call.input);
}

function extractMessagesArray(raw: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages as Record<string, unknown>[];
    if (Array.isArray(obj.items)) return obj.items as Record<string, unknown>[];
  }
  return undefined;
}

function extractMessageText(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') return msg.content;
  if (typeof msg.text === 'string') return msg.text;
  const parts = Array.isArray(msg.parts) ? msg.parts : Array.isArray(msg.content) ? msg.content : undefined;
  if (!parts) return '';
  return (parts as Record<string, unknown>[])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function formatToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  let text = '';
  if (typeof output === 'string') {
    text = output;
  } else if (typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    if (typeof rec.stdout === 'string' || typeof rec.stderr === 'string') {
      const out = typeof rec.stdout === 'string' ? rec.stdout : '';
      const err = typeof rec.stderr === 'string' ? rec.stderr : '';
      const code = typeof rec.exitCode === 'number' && rec.exitCode !== 0 ? `\nexit ${rec.exitCode}` : '';
      text = [out, err].filter(Boolean).join('\n') + code;
    } else if (typeof rec.output === 'string') {
      text = rec.output;
    } else if (typeof rec.text === 'string') {
      text = rec.text;
    } else if (typeof rec.content === 'string') {
      text = rec.content;
    } else if (Array.isArray(rec.content)) {
      text = (rec.content as Record<string, unknown>[]).map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
    }
  }
  text = text.trim();
  if (!text) return undefined;
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n${t('output.truncated')}` : text;
}

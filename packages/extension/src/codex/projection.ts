/**
 * Codex 会话投影层：
 * 将 `codex app-server` 推送的 v2 通知流（`turn/started`、`item/started`、`item/agentMessage/delta`、
 * `item/reasoning/*`、`item/commandExecution/outputDelta`、`item/fileChange/*`、`item/completed`、
 * `turn/plan/updated`、`thread/tokenUsage/updated`、`turn/completed`、`error` 等）
 * 以及历史快照（`thread/read` / `thread/resume` 返回的 `Thread`）统一投影为 Harness Deck 视图模型。
 */
import { joinLabel, type ContextDetail, type Item, type LineStats, type TokenBreakdown } from '@harness-deck/shared';
import type { AcpDiff, FileChange } from '../acp/projection.ts';
import { t } from '../i18n.ts';
import { splitContext } from '../vm/context.ts';
import { sumStats } from '../vm/diffs.ts';
import { displayPath } from '../vm/paths.ts';
import { summarizeExplore } from '../vm/toolRows.ts';
import { TurnTimingTracker } from '../vm/usage.ts';

const OUTPUT_LIMIT = 4_000;

export type CodexDiff = AcpDiff;
export type CodexFileChange = FileChange;

export interface CodexFileChangeEntry {
  readonly path: string;
  readonly created: boolean;
  readonly deleted: boolean;
  readonly diff: string;
  readonly stats: LineStats;
  readonly hunks: readonly CodexDiff[];
}

export interface CodexToolState {
  readonly itemId: string;
  readonly kind: 'command' | 'fileChange' | 'mcp' | 'dynamic' | 'collab' | 'webSearch' | 'imageView';
  readonly toolName: string;
  readonly status: 'running' | 'ok' | 'error';
  readonly label: string;
  readonly explore: boolean;
  readonly path?: string;
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
  readonly changes: readonly CodexFileChangeEntry[];
  readonly subagentPrompt?: string;
  readonly subagentResult?: string;
}

type Todo = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' };
type Activity = Extract<Item, { kind: 'activity' }>;
type Explore = Extract<Item, { kind: 'explore' }>;

/**
 * 解析 Codex `FileUpdateChange.diff`（unified diff），返回增删行数及用于编辑器还原整文件对比的 Diff 片段。
 */
export function parseUnifiedDiff(
  diffText: string,
  path: string,
  created: boolean,
): { readonly stats: LineStats; readonly hunks: readonly CodexDiff[] } {
  if (!diffText) return { stats: { additions: 0, deletions: 0 }, hunks: [] };
  const lines = diffText.split(/\r?\n/u);
  let additions = 0;
  let deletions = 0;
  const hunks: CodexDiff[] = [];
  let inHunk = false;
  let oldLines: string[] = [];
  let newLines: string[] = [];

  const flushHunk = (): void => {
    if (!inHunk) return;
    if (oldLines.length > 0 || newLines.length > 0) {
      hunks.push({
        path,
        oldText: created ? null : oldLines.join('\n'),
        newText: newLines.join('\n'),
      });
    }
    oldLines = [];
    newLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flushHunk();
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
        continue;
      }
      // 无 @@ 头的简易 diff 兜底
      if (line.startsWith('+') || line.startsWith('-')) {
        inHunk = true;
      } else {
        continue;
      }
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      additions++;
      newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      deletions++;
      oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line === '\\ No newline at end of file') {
      continue;
    }
  }
  flushHunk();

  return { stats: { additions, deletions }, hunks };
}

export class CodexSessionProjection {
  private items: Item[] = [];
  private readonly itemIndex = new Map<string, { index: number; entry?: number }>();
  private readonly tools = new Map<string, CodexToolState>();
  private readonly streamedItems = new Set<string>();
  private readonly itemToViewIndex = new Map<string, number>();
  private counter = 0;
  private changesCache: { readonly version: number; readonly value: readonly CodexFileChange[] } | undefined;
  private lastUsageBreakdown?: TokenBreakdown;
  private totalUsageBreakdown?: TokenBreakdown;
  private lastReportedTotalTokens = 0;
  private usageUpdates = 0;
  private readonly timing = new TurnTimingTracker();
  private turnOutputTokens = 0;

  version = 0;
  title?: string;
  todos?: readonly Todo[];
  usage?: { readonly used: number; readonly size: number };
  runningSince?: number;
  activeTurnId?: string;

  constructor(private readonly workspacePath: string) {}

  get running(): boolean {
    return this.runningSince !== undefined;
  }

  snapshotItems(): readonly Item[] {
    return this.items;
  }

  toolCall(itemId: string): CodexToolState | undefined {
    return this.tools.get(itemId);
  }

  diffsOf(itemId: string): readonly CodexDiff[] {
    const tool = this.tools.get(itemId);
    if (!tool) return [];
    return tool.changes.flatMap((c) => c.hunks);
  }

  fileChanges(): readonly CodexFileChange[] {
    if (this.changesCache?.version === this.version) return this.changesCache.value;
    const value = this.computeFileChanges();
    this.changesCache = { version: this.version, value };
    return value;
  }

  private computeFileChanges(): CodexFileChange[] {
    const files = new Map<
      string,
      { diffs: CodexDiff[]; calls: string[]; created: boolean; additions: number; deletions: number }
    >();
    for (const call of this.tools.values()) {
      if (call.kind !== 'fileChange' || call.status !== 'ok') continue;
      for (const entry of call.changes) {
        let file = files.get(entry.path);
        if (!file) {
          file = { diffs: [], calls: [], created: entry.created, additions: 0, deletions: 0 };
          files.set(entry.path, file);
        }
        file.diffs.push(...entry.hunks);
        if (!file.calls.includes(call.itemId)) file.calls.push(call.itemId);
        file.additions += entry.stats.additions;
        file.deletions += entry.stats.deletions;
      }
    }
    return [...files].map(([path, f]) => ({ path, ...f }));
  }

  reset(): void {
    this.items = [];
    this.itemIndex.clear();
    this.tools.clear();
    this.streamedItems.clear();
    this.itemToViewIndex.clear();
    this.runningSince = undefined;
    this.activeTurnId = undefined;
    this.todos = undefined;
    this.usage = undefined;
    this.lastUsageBreakdown = undefined;
    this.totalUsageBreakdown = undefined;
    this.lastReportedTotalTokens = 0;
    this.usageUpdates = 0;
    this.timing.reset();
    this.turnOutputTokens = 0;
    this.changed();
  }

  /** 悬浮在上下文标识上展示的用量明细（最近一次请求与本会话累计）。 */
  contextDetail(): ContextDetail | undefined {
    const perf = this.timing.performance();
    if (!this.lastUsageBreakdown && !this.totalUsageBreakdown && !perf) return undefined;
    return {
      ...(this.lastUsageBreakdown ? { lastRequest: this.lastUsageBreakdown } : {}),
      ...(this.totalUsageBreakdown ? { session: this.totalUsageBreakdown } : {}),
      ...(this.usageUpdates > 0 ? { requests: this.usageUpdates } : {}),
      ...(perf ? { performance: perf } : {}),
    };
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

  startTurn(now: number, turnId?: string): void {
    if (this.runningSince === undefined) this.runningSince = now;
    if (turnId) this.activeTurnId = turnId;
    this.turnOutputTokens = 0;
    this.timing.start(now);
    this.changed();
  }

  endTurn(now: number, outcome: 'completed' | 'cancelled' | 'failed', errorText?: string): void {
    const startedAt = this.runningSince;
    this.runningSince = undefined;
    this.activeTurnId = undefined;
    this.timing.finish(this.turnOutputTokens > 0 ? this.turnOutputTokens : undefined, now);
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

  /** 应用一条 Codex app-server 通知。返回值指示是否结束了本轮回复。 */
  applyNotification(method: string, rawParams: unknown, now = Date.now()): { readonly turnEnded?: boolean } {
    const params = rawParams && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {};

    switch (method) {
      case 'turn/started': {
        const turn = params.turn as Record<string, unknown> | undefined;
        const turnId = typeof turn?.id === 'string' ? turn.id : undefined;
        const startedMs =
          typeof turn?.startedAt === 'number'
            ? turn.startedAt > 1e12
              ? turn.startedAt
              : turn.startedAt * 1000
            : now;
        if (this.runningSince === undefined) {
          this.runningSince = startedMs;
          this.turnOutputTokens = 0;
          this.timing.start(startedMs);
        }
        if (turnId) this.activeTurnId = turnId;
        this.changed();
        return {};
      }
      case 'turn/completed': {
        const turn = params.turn as Record<string, unknown> | undefined;
        const status = typeof turn?.status === 'string' ? turn.status : 'completed';
        if (status === 'interrupted') {
          this.endTurn(now, 'cancelled');
        } else if (status === 'failed') {
          const errObj = turn?.error as { message?: unknown } | undefined;
          const msg = typeof errObj?.message === 'string' && errObj.message ? errObj.message : t('notice.errorUnknown');
          this.endTurn(now, 'failed', msg);
        } else {
          this.endTurn(now, 'completed');
        }
        return { turnEnded: true };
      }
      case 'error': {
        if (params.willRetry === true) return {};
        const errObj = params.error as { message?: unknown } | undefined;
        const msg = typeof errObj?.message === 'string' ? errObj.message : '';
        if (msg) {
          this.items.push({ kind: 'notice', id: `n:${++this.counter}`, level: 'error', text: t('notice.error', msg) });
          this.changed();
        }
        return {};
      }
      case 'item/started': {
        const item = params.item as Record<string, unknown> | undefined;
        if (item) this.applyThreadItem(item, false, now);
        return {};
      }
      case 'item/completed': {
        const item = params.item as Record<string, unknown> | undefined;
        if (item) this.applyThreadItem(item, true, now);
        return {};
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        if (delta) {
          if (this.runningSince === undefined) {
            this.runningSince = now;
            this.turnOutputTokens = 0;
            this.timing.start(now);
          }
          if (itemId) this.streamedItems.add(itemId);
          this.appendAssistant(delta, 'markdown', itemId, this.running, now);
          this.changed();
        }
        return {};
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        if (delta) {
          if (this.runningSince === undefined) {
            this.runningSince = now;
            this.turnOutputTokens = 0;
            this.timing.start(now);
          }
          if (itemId) this.streamedItems.add(itemId);
          this.appendAssistant(delta, 'reasoning', itemId, this.running, now);
          this.changed();
        }
        return {};
      }
      case 'item/reasoning/summaryPartAdded': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        const idx = itemId ? this.itemToViewIndex.get(itemId) : this.items.length - 1;
        const prev = idx !== undefined ? this.items[idx] : undefined;
        if (prev?.kind === 'assistant' && prev.reasoning && !prev.reasoning.endsWith('\n\n')) {
          this.items[idx!] = { ...prev, reasoning: `${prev.reasoning}\n\n` };
          this.changed();
        }
        return {};
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!itemId || !delta) return {};
        const prev = this.tools.get(itemId);
        if (prev) {
          const nextOutput = trimOutput((prev.output ?? '') + delta);
          this.upsertTool({ ...prev, output: nextOutput });
          this.changed();
        }
        return {};
      }
      case 'item/fileChange/outputDelta': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (!itemId || !delta) return {};
        const prev = this.tools.get(itemId);
        if (prev) {
          const nextOutput = trimOutput((prev.output ?? '') + delta);
          this.upsertTool({ ...prev, output: nextOutput });
          this.changed();
        }
        return {};
      }
      case 'item/fileChange/patchUpdated': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const rawChanges = Array.isArray(params.changes) ? (params.changes as Record<string, unknown>[]) : [];
        if (!itemId || rawChanges.length === 0) return {};
        const changes = parseFileChanges(rawChanges);
        const prev = this.tools.get(itemId);
        if (prev) {
          this.upsertTool({
            ...prev,
            changes,
            label: labelForFileChanges(changes, this.workspacePath),
          });
          this.changed();
        }
        return {};
      }
      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? (params.plan as Record<string, unknown>[]) : [];
        this.todos = plan
          .map((entry): Todo => ({
            content: typeof entry.step === 'string' ? entry.step : '',
            status:
              entry.status === 'completed'
                ? 'completed'
                : entry.status === 'inProgress' || entry.status === 'in_progress'
                  ? 'in_progress'
                  : 'pending',
          }))
          .filter((todo) => todo.content.length > 0);
        this.changed();
        return {};
      }
      case 'thread/tokenUsage/updated': {
        const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
        const last = tokenUsage?.last as Record<string, unknown> | undefined;
        const total = tokenUsage?.total as Record<string, unknown> | undefined;
        const windowSize = typeof tokenUsage?.modelContextWindow === 'number' ? tokenUsage.modelContextWindow : undefined;
        const lastBreakdown = parseCodexTokenBreakdown(last);
        const totalBreakdown = parseCodexTokenBreakdown(total);
        let updated = false;
        if (lastBreakdown) {
          this.lastUsageBreakdown = lastBreakdown;
          if (lastBreakdown.output > 0) {
            this.turnOutputTokens = lastBreakdown.output;
            this.timing.attachOutputTokens(lastBreakdown.output);
          }
          updated = true;
        }
        if (totalBreakdown) {
          this.totalUsageBreakdown = totalBreakdown;
          const nextTotal =
            typeof total?.totalTokens === 'number'
              ? total.totalTokens
              : totalBreakdown.input + totalBreakdown.cacheRead + totalBreakdown.output;
          if (nextTotal > this.lastReportedTotalTokens) {
            this.lastReportedTotalTokens = nextTotal;
            this.usageUpdates += 1;
          }
          updated = true;
        }
        const used =
          typeof last?.totalTokens === 'number' && last.totalTokens > 0
            ? last.totalTokens
            : typeof total?.totalTokens === 'number'
              ? total.totalTokens
              : lastBreakdown
                ? lastBreakdown.input + lastBreakdown.cacheRead + lastBreakdown.output
                : undefined;
        if (used !== undefined && windowSize !== undefined && windowSize > 0) {
          this.usage = { used, size: windowSize };
          updated = true;
        }
        if (updated) this.changed();
        return {};
      }
      case 'thread/name/updated': {
        const name = typeof params.threadName === 'string' ? params.threadName.trim() : '';
        if (name) {
          this.title = name;
          this.changed();
        }
        return {};
      }
      default:
        return {};
    }
  }

  /** 应用 `thread/read(includeTurns: true)` 或 `thread/resume` 返回的完整线程历史快照。 */
  applyThreadSnapshot(thread: Record<string, unknown> | null | undefined): void {
    if (!thread) return;
    if (typeof thread.name === 'string' && thread.name.trim()) {
      this.title = thread.name.trim();
    } else if (typeof thread.preview === 'string' && thread.preview.trim() && !this.title) {
      this.title = thread.preview.trim();
    }

    const turns = Array.isArray(thread.turns) ? (thread.turns as Record<string, unknown>[]) : [];
    this.items = [];
    this.itemIndex.clear();
    this.tools.clear();
    this.streamedItems.clear();
    this.itemToViewIndex.clear();
    this.runningSince = undefined;
    this.activeTurnId = undefined;
    this.todos = undefined;

    for (const turn of turns) {
      const turnStatus = typeof turn.status === 'string' ? turn.status : 'completed';
      const rawItems = Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : [];
      for (const item of rawItems) {
        this.applyThreadItem(item, turnStatus !== 'inProgress', Date.now(), true);
      }
      if (turnStatus === 'inProgress') {
        const started =
          typeof turn.startedAt === 'number'
            ? turn.startedAt > 1e12
              ? turn.startedAt
              : turn.startedAt * 1000
            : Date.now();
        this.runningSince = started;
        if (typeof turn.id === 'string') this.activeTurnId = turn.id;
      } else {
        this.settleText();
        if (turnStatus === 'failed') {
          const err = turn.error as { message?: unknown } | undefined;
          if (typeof err?.message === 'string' && err.message) {
            this.items.push({
              kind: 'notice',
              id: `n:${++this.counter}`,
              level: 'error',
              text: t('notice.error', err.message),
            });
          }
        } else if (turnStatus === 'interrupted') {
          this.items.push({ kind: 'notice', id: `n:${++this.counter}`, level: 'info', text: t('notice.stopped') });
        }
      }
    }
    this.changed();
  }

  private applyThreadItem(
    item: Record<string, unknown>,
    completed: boolean,
    now: number,
    isReplay = false,
  ): void {
    const type = typeof item.type === 'string' ? item.type : '';
    const itemId = typeof item.id === 'string' && item.id ? item.id : `item:${++this.counter}`;

    switch (type) {
      case 'userMessage': {
        // 实时发送时由 Controller 本地添加，仅历史回放时投影
        if (!isReplay) return;
        const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
        const textParts: string[] = [];
        for (const part of content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            textParts.push(part.text);
          }
        }
        const combined = textParts.join('\n').trim();
        if (combined) this.addUserMessage(combined);
        return;
      }
      case 'agentMessage':
      case 'plan': {
        const text = typeof item.text === 'string' ? item.text : '';
        if (completed) {
          if (text && !this.streamedItems.has(itemId)) {
            this.appendAssistant(text, 'markdown', itemId, false);
          }
          const idx = this.itemToViewIndex.get(itemId);
          if (idx !== undefined && this.items[idx]?.kind === 'assistant') {
            this.items[idx] = { ...(this.items[idx] as Extract<Item, { kind: 'assistant' }>), streaming: false };
          }
          this.changed();
        } else if (!isReplay && text && !this.streamedItems.has(itemId)) {
          if (this.runningSince === undefined) this.runningSince = now;
          this.appendAssistant(text, 'markdown', itemId);
          this.changed();
        }
        return;
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary)
          ? (item.summary as unknown[]).filter((s): s is string => typeof s === 'string').join('\n\n')
          : '';
        const content = Array.isArray(item.content)
          ? (item.content as unknown[]).filter((s): s is string => typeof s === 'string').join('\n')
          : '';
        const full = summary || content;
        if (completed && full && !this.streamedItems.has(itemId)) {
          this.appendAssistant(full, 'reasoning', itemId, !isReplay && this.running);
          this.changed();
        }
        return;
      }
      case 'commandExecution': {
        const command = typeof item.command === 'string' ? item.command : '';
        const rawStatus = typeof item.status === 'string' ? item.status : completed ? 'completed' : 'inProgress';
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
        const status: 'running' | 'ok' | 'error' =
          rawStatus === 'failed' || rawStatus === 'declined' || (rawStatus === 'completed' && exitCode !== undefined && exitCode !== 0)
            ? 'error'
            : rawStatus === 'completed' || completed
              ? 'ok'
              : 'running';
        const actions = Array.isArray(item.commandActions) ? (item.commandActions as Record<string, unknown>[]) : [];
        const exploreInfo = describeExploreCommand(actions, this.workspacePath);
        const aggregated = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined;
        const prev = this.tools.get(itemId);
        const rawOut = aggregated !== undefined ? aggregated : prev?.output;
        const output = formatCommandOutput(rawOut, exitCode);
        this.upsertTool({
          itemId,
          kind: 'command',
          toolName: exploreInfo ? exploreInfo.toolName : 'Shell',
          status,
          label: exploreInfo ? exploreInfo.label : joinLabel('Shell', command.split('\n', 1)[0] ?? command),
          explore: exploreInfo !== undefined,
          ...(exploreInfo?.path ? { path: exploreInfo.path } : {}),
          command,
          ...(output ? { output } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          changes: [],
        });
        this.changed();
        return;
      }
      case 'fileChange': {
        const rawChanges = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
        const changes = parseFileChanges(rawChanges);
        const rawStatus = typeof item.status === 'string' ? item.status : completed ? 'completed' : 'inProgress';
        const status: 'running' | 'ok' | 'error' =
          rawStatus === 'failed' || rawStatus === 'declined'
            ? 'error'
            : rawStatus === 'completed' || completed
              ? 'ok'
              : 'running';
        const prev = this.tools.get(itemId);
        const mergedChanges = changes.length > 0 ? changes : (prev?.changes ?? []);
        this.upsertTool({
          itemId,
          kind: 'fileChange',
          toolName: 'Edit',
          status,
          label: labelForFileChanges(mergedChanges, this.workspacePath),
          explore: false,
          ...(prev?.output ? { output: prev.output } : {}),
          changes: mergedChanges,
        });
        this.changed();
        return;
      }
      case 'mcpToolCall': {
        const server = typeof item.server === 'string' ? item.server : 'mcp';
        const tool = typeof item.tool === 'string' ? item.tool : 'call';
        const rawStatus = typeof item.status === 'string' ? item.status : completed ? 'completed' : 'inProgress';
        const status: 'running' | 'ok' | 'error' =
          rawStatus === 'failed' || item.error
            ? 'error'
            : rawStatus === 'completed' || completed
              ? 'ok'
              : 'running';
        const output = formatMcpOutput(item.result, item.error);
        this.upsertTool({
          itemId,
          kind: 'mcp',
          toolName: `${server}:${tool}`,
          status,
          label: joinLabel(`${server}:${tool}`, summarizeArgs(item.arguments)),
          explore: false,
          ...(output ? { output } : {}),
          changes: [],
        });
        this.changed();
        return;
      }
      case 'dynamicToolCall': {
        const tool = typeof item.tool === 'string' ? item.tool : 'tool';
        const ns = typeof item.namespace === 'string' && item.namespace ? `${item.namespace}:` : '';
        const rawStatus = typeof item.status === 'string' ? item.status : completed ? 'completed' : 'inProgress';
        const status: 'running' | 'ok' | 'error' =
          rawStatus === 'failed' || item.success === false
            ? 'error'
            : rawStatus === 'completed' || completed
              ? 'ok'
              : 'running';
        const output = formatDynamicToolOutput(item.contentItems);
        this.upsertTool({
          itemId,
          kind: 'dynamic',
          toolName: `${ns}${tool}`,
          status,
          label: joinLabel(`${ns}${tool}`, summarizeArgs(item.arguments)),
          explore: false,
          ...(output ? { output } : {}),
          changes: [],
        });
        this.changed();
        return;
      }
      case 'collabAgentToolCall': {
        const tool = typeof item.tool === 'string' ? item.tool : 'subagent';
        const prompt = typeof item.prompt === 'string' ? item.prompt : undefined;
        const rawStatus = typeof item.status === 'string' ? item.status : completed ? 'completed' : 'inProgress';
        const status: 'running' | 'ok' | 'error' =
          rawStatus === 'failed'
            ? 'error'
            : rawStatus === 'completed' || completed
              ? 'ok'
              : 'running';
        const resultText = summarizeCollabStates(item.agentsStates);
        this.upsertTool({
          itemId,
          kind: 'collab',
          toolName: tool,
          status,
          label: prompt ? joinLabel(tool, prompt.split('\n', 1)[0] ?? prompt) : tool,
          explore: false,
          ...(prompt ? { subagentPrompt: prompt } : {}),
          ...(resultText ? { subagentResult: resultText } : {}),
          changes: [],
        });
        this.changed();
        return;
      }
      case 'webSearch': {
        const query = typeof item.query === 'string' ? item.query : '';
        this.upsertTool({
          itemId,
          kind: 'webSearch',
          toolName: 'WebSearch',
          status: completed ? 'ok' : 'running',
          label: joinLabel('WebSearch', query),
          explore: true,
          changes: [],
        });
        this.changed();
        return;
      }
      case 'imageView': {
        const path = typeof item.path === 'string' ? item.path : '';
        const disp = path ? displayPath(path, this.workspacePath) : '';
        this.upsertTool({
          itemId,
          kind: 'imageView',
          toolName: 'Read',
          status: completed ? 'ok' : 'running',
          label: joinLabel('Read', disp),
          explore: true,
          ...(disp ? { path: disp } : {}),
          changes: [],
        });
        this.changed();
        return;
      }
      default:
        return;
    }
  }

  private appendAssistant(
    text: string,
    field: 'markdown' | 'reasoning',
    itemId?: string,
    streaming = this.running,
    now = Date.now(),
  ): void {
    if (!text) return;
    if (streaming) this.timing.markFirstToken(now);
    let at = itemId ? this.itemToViewIndex.get(itemId) : undefined;
    if (at === undefined) {
      const last = this.items.length - 1;
      if (this.items[last]?.kind === 'assistant') {
        at = last;
      } else {
        at = this.items.length;
        this.items.push({ kind: 'assistant', id: `a:${++this.counter}`, markdown: '', streaming });
      }
      if (itemId) this.itemToViewIndex.set(itemId, at);
    }
    const prev = this.items[at] as Extract<Item, { kind: 'assistant' }>;
    this.items[at] =
      field === 'markdown'
        ? { ...prev, markdown: prev.markdown + text, streaming }
        : { ...prev, reasoning: (prev.reasoning ?? '') + text, streaming };
  }

  private settleText(): void {
    if (!this.items.some((item) => item.kind === 'assistant' && item.streaming)) return;
    this.items = this.items.map((item) =>
      item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item,
    );
  }

  private upsertTool(call: CodexToolState): void {
    this.tools.set(call.itemId, call);
    const existingAt = this.itemIndex.get(call.itemId);

    if (!existingAt) {
      this.settleText();
      if (call.explore) {
        this.addExplore(call);
      } else {
        this.itemIndex.set(call.itemId, { index: this.items.length });
        this.items.push(this.activityOf(call));
      }
      return;
    }

    const item = this.items[existingAt.index];
    if (item?.kind === 'explore' && existingAt.entry !== undefined) {
      const entries = item.entries.map((e, i) => (i === existingAt.entry ? this.exploreEntry(call) : e));
      this.items[existingAt.index] = summarizeExplore({ ...item, entries });
    } else if (item?.kind === 'activity') {
      this.items[existingAt.index] = this.activityOf(call);
    }
  }

  private addExplore(call: CodexToolState): void {
    const entry = this.exploreEntry(call);
    const last = this.items.length - 1;
    if (this.items[last]?.kind === 'explore') {
      const group = this.items[last] as Explore;
      this.itemIndex.set(call.itemId, { index: last, entry: group.entries.length });
      this.items[last] = summarizeExplore({ ...group, entries: [...group.entries, entry] });
    } else {
      this.itemIndex.set(call.itemId, { index: this.items.length, entry: 0 });
      this.items.push(
        summarizeExplore({ kind: 'explore', id: `x:${call.itemId}`, summary: '', status: 'running', entries: [entry] }),
      );
    }
  }

  private exploreEntry(call: CodexToolState): Explore['entries'][number] {
    return {
      id: call.itemId,
      label: call.label,
      status: call.status,
      ...(call.path ? { path: call.path } : {}),
    };
  }

  private activityOf(call: CodexToolState): Activity {
    const base = { kind: 'activity' as const, id: `t:${call.itemId}`, tool: call.toolName, status: call.status };

    if (call.kind === 'collab') {
      return {
        ...base,
        variant: 'subagent',
        label: call.label,
        subagent: {
          state: call.status === 'ok' ? 'done' : call.status === 'error' ? 'failed' : 'running',
          ...(call.subagentPrompt ? { prompt: call.subagentPrompt } : {}),
          ...(call.subagentResult ? { result: call.subagentResult } : {}),
        },
      };
    }

    if (call.kind === 'command') {
      return {
        ...base,
        variant: 'command',
        label: call.label,
        ...(call.output ? { output: call.output } : {}),
      };
    }

    if (call.kind === 'fileChange') {
      const stats = call.changes.length > 0 ? sumStats(call.changes.map((c) => c.stats)) : undefined;
      const created = call.changes.length > 0 && call.changes.every((c) => c.created);
      const hasDiffs = call.changes.some((c) => c.hunks.length > 0);
      return {
        ...base,
        variant: 'edit',
        label: call.label,
        ...(stats && call.status === 'ok' ? { stats } : {}),
        ...(created && call.status === 'ok' ? { created } : {}),
        ...(hasDiffs && call.status === 'ok' ? { diff: { kind: 'tool' as const, callId: call.itemId } } : {}),
        ...(call.status === 'error' && call.output ? { output: call.output } : {}),
      };
    }

    return {
      ...base,
      variant: 'generic',
      label: call.label,
      ...(call.output ? { output: call.output } : {}),
    };
  }

  private changed(): void {
    this.version++;
  }
}

function describeExploreCommand(
  actions: readonly Record<string, unknown>[],
  workspacePath: string,
): { readonly toolName: string; readonly label: string; readonly path?: string } | undefined {
  if (actions.length === 0) return undefined;
  const first = actions[0]!;
  const allExplore = actions.every((a) => a.type === 'read' || a.type === 'listFiles' || a.type === 'search');
  if (!allExplore) return undefined;
  if (first.type === 'read') {
    const rawPath = typeof first.path === 'string' ? first.path : typeof first.name === 'string' ? first.name : '';
    const disp = rawPath ? displayPath(rawPath, workspacePath) : '';
    return { toolName: 'Read', label: joinLabel('Read', disp), ...(disp ? { path: disp } : {}) };
  }
  if (first.type === 'listFiles') {
    const rawPath = typeof first.path === 'string' ? first.path : '';
    const disp = rawPath ? displayPath(rawPath, workspacePath) : '.';
    return { toolName: 'List', label: joinLabel('List', disp) };
  }
  if (first.type === 'search') {
    const query = typeof first.query === 'string' ? first.query : '';
    const rawPath = typeof first.path === 'string' ? first.path : '';
    const detail = [query, rawPath ? displayPath(rawPath, workspacePath) : ''].filter(Boolean).join(' ');
    return { toolName: 'Search', label: joinLabel('Search', detail) };
  }
  return undefined;
}

function parseFileChanges(rawChanges: readonly Record<string, unknown>[]): CodexFileChangeEntry[] {
  return rawChanges.flatMap((entry): CodexFileChangeEntry[] => {
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (!path) return [];
    const kindObj = entry.kind && typeof entry.kind === 'object' ? (entry.kind as { type?: unknown }) : undefined;
    const created = kindObj?.type === 'add';
    const deleted = kindObj?.type === 'delete';
    const diff = typeof entry.diff === 'string' ? entry.diff : '';
    const parsed = parseUnifiedDiff(diff, path, created);
    return [{ path, created, deleted, diff, stats: parsed.stats, hunks: parsed.hunks }];
  });
}

function labelForFileChanges(changes: readonly CodexFileChangeEntry[], workspacePath: string): string {
  if (changes.length === 0) return 'Edit';
  const first = displayPath(changes[0]!.path, workspacePath);
  if (changes.length === 1) return first;
  return `${first} (+${changes.length - 1})`;
}

function trimOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= OUTPUT_LIMIT) return trimmed;
  return `${trimmed.slice(0, OUTPUT_LIMIT)}\n${t('output.truncated')}`;
}

function formatCommandOutput(raw: string | undefined, exitCode: number | undefined): string | undefined {
  const base = raw?.trim() ?? '';
  const suffix = exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : '';
  const combined = [base, suffix].filter(Boolean).join('\n').trim();
  if (!combined) return undefined;
  return trimOutput(combined);
}

function formatMcpOutput(result: unknown, error: unknown): string | undefined {
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return trimOutput((error as { message: string }).message);
  }
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = (content as Record<string, unknown>[])
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return trimOutput(text);
  }
  return undefined;
}

function formatDynamicToolOutput(contentItems: unknown): string | undefined {
  if (!Array.isArray(contentItems)) return undefined;
  const text = (contentItems as Record<string, unknown>[])
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return text ? trimOutput(text) : undefined;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 2);
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)?.slice(0, 40) ?? ''}`)
    .join(' ');
}

function summarizeCollabStates(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const lines: string[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const rec = value as { status?: unknown; message?: unknown };
    const status = typeof rec.status === 'string' ? rec.status : '';
    const msg = typeof rec.message === 'string' ? rec.message.trim() : '';
    lines.push([id, status, msg].filter(Boolean).join(': '));
  }
  return lines.length > 0 ? trimOutput(lines.join('\n')) : undefined;
}

/** 解析 Codex `TokenUsageBreakdown`：OpenAI Responses 的 `inputTokens` 包含 `cachedInputTokens`，需拆出未命中缓存部分。 */
function parseCodexTokenBreakdown(raw: Record<string, unknown> | undefined): TokenBreakdown | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const rawInput = num(raw.inputTokens) ?? num(raw.input_tokens);
  const cached = num(raw.cachedInputTokens) ?? num(raw.cached_input_tokens) ?? 0;
  const output = num(raw.outputTokens) ?? num(raw.output_tokens);
  const reasoning = num(raw.reasoningOutputTokens) ?? num(raw.reasoning_output_tokens);
  if (rawInput === undefined && output === undefined && cached === 0) return undefined;
  const input = rawInput !== undefined ? Math.max(0, rawInput - cached) : 0;
  return {
    input,
    output: output ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    ...(reasoning && reasoning > 0 ? { reasoning } : {}),
  };
}

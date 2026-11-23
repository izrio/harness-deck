/**
 * 对话流（Beautiful UI 流式布局 + 虚拟滚动 + 顶部自动无限加载 + 悬浮回底胶囊按钮）：
 * - 虚拟滚动：只挂载可视区域及上下 overscan 范围内的消息节点，支持超长会话流畅上下滚动；
 * - 无限滚动：向上滚动接近顶部（或内容不足一屏）时自动加载更早历史，无需手动点击按钮，并精确锚定当前阅读位置；
 * - 贴底跟随：用户停在底部时跟随新内容，往上翻时不打扰并在有新消息时提示回底。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { backendCapabilities, deriveTurns } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { useVirtualThread } from '../hooks/useVirtualThread.ts';
import { buildThreadRows, rowIsRunning, rowToolCount, type ThreadRow } from '../threadRows.ts';
import { LoaderGrid, Shimmer, ThinkingTrace } from './beautifului/index.ts';
import { InteractionCard } from './Interactions.tsx';
import { ItemView } from './Items.tsx';
import { RunStatus } from './RunStatus.tsx';
import { ArrowDownIcon, SpinnerIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

function Announcer({ running, waiting }: { running: boolean; waiting: boolean }) {
  const t = useT();
  const previous = useRef({ running, waiting });
  const [message, setMessage] = useState('');
  useEffect(() => {
    const before = previous.current;
    previous.current = { running, waiting };
    if (waiting && !before.waiting) setMessage(t('a11y.needsYou'));
    else if (running && !before.running) setMessage(t('a11y.replyStarted'));
    else if (!running && before.running) setMessage(t('a11y.replyDone'));
  }, [running, waiting, t]);
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="announcer">
      {message}
    </div>
  );
}

function VirtualRow({
  id,
  index,
  registerRow,
  children,
}: {
  readonly id: string;
  readonly index: number;
  readonly registerRow: (id: string, el: HTMLDivElement | null) => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    registerRow(id, el);
    return () => registerRow(id, null);
  }, [id, registerRow]);

  return (
    <div
      ref={ref}
      className="thread__row flex min-w-0 flex-col"
      data-virtual-index={index}
      data-virtual-id={id}
    >
      {children}
    </div>
  );
}

export function Thread() {
  const items = useView((s) => s.items);
  const interactions = useView((s) => s.interactions);
  const session = useView((s) => s.session);
  const sessionKey = useView((s) => s.sessionKey);
  const appearance = useView((s) => s.appearance);
  const activeBackend = useView((s) => s.backends.items.find((b) => b.id === s.backends.active));
  const t = useT();

  const appearanceKey = [
    appearance.fontFamily ?? '',
    appearance.fontSize ?? '',
    appearance.lineHeight ?? '',
    appearance.paragraphSpacing ?? '',
    appearance.contentWidth ?? '',
  ].join('|');

  // 连续的工具操作收成一条思考轨迹行；单条操作仍是独立一行
  const rows = useMemo(() => buildThreadRows(items), [items]);
  // 回合模型：优先消费宿主快照与增量推送中的 session.turns，旧快照时兜底推导。
  const turns = useMemo(() => session.turns ?? deriveTurns(items, session.running), [session.turns, items, session.running]);
  // 回合编号：把每个回合的 seq 挂在对应的 turnDone 上。
  const turnSeqById = useMemo(() => {
    const map = new Map<string, number>();
    let turnIndex = 0;
    for (const item of items) {
      if (item.kind === 'user' && item.pending !== 'queued' && !item.queue) turnIndex += 1;
      else if (item.kind === 'turnDone' && turnIndex > 0) {
        const seq = turns[turnIndex - 1]?.seq ?? turnIndex;
        map.set(item.id, seq);
      }
    }
    return map;
  }, [items, turns]);
  // 只有最后一轮、该轮实际改过文件、且底层支持按工具片段恢复文件时才显示回滚入口（对话不回退）。
  const lastTurnDoneId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.kind === 'turnDone') return items[i]!.id;
    }
    return undefined;
  }, [items]);
  const lastTurnHasChanges = (turns.at(-1)?.authoredPaths.length ?? 0) > 0;
  const canRollbackFiles = activeBackend ? (activeBackend.capabilities ?? backendCapabilities(activeBackend)).rollback === 'files' : false;
  // 本轮条目（最后一条非排队用户消息之后）：运行期间这些轨迹行保持展开，整轮操作结束后再统一收起
  const currentTurnItemIds = useMemo(() => {
    let turnStart = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === 'user' && item.pending !== 'queued') {
        turnStart = index;
        break;
      }
    }
    return new Set(items.slice(turnStart + 1).map((item) => item.id));
  }, [items]);
  const isRowAutoOpen = useCallback(
    (row: ThreadRow) => rowIsRunning(row) || (session.running && currentTurnItemIds.has(row.items[0]!.id)),
    [session.running, currentTurnItemIds],
  );
  // 按 sessionKey 隔离手动展开状态，切换会话时在首次 render 即刻清空，避免不同会话的轨迹行 id 冲突或闪烁
  const [openOverrides, setOpenOverrides] = useState<{
    readonly sessionKey: string;
    readonly map: ReadonlyMap<string, boolean>;
  }>(() => ({ sessionKey, map: new Map() }));

  const expandedRowIds = useMemo(() => {
    const activeOverrides = openOverrides.sessionKey === sessionKey ? openOverrides.map : undefined;
    const expanded = new Set<string>();
    for (const row of rows) {
      if (row.grouped && (activeOverrides?.get(row.id) ?? isRowAutoOpen(row))) expanded.add(row.id);
    }
    return expanded;
  }, [rows, openOverrides, sessionKey, isRowAutoOpen]);

  const toggleRow = useCallback(
    (row: ThreadRow) => {
      setOpenOverrides((prev) => {
        const base = prev.sessionKey === sessionKey ? prev.map : new Map<string, boolean>();
        const next = new Map(base);
        next.set(row.id, !(base.get(row.id) ?? isRowAutoOpen(row)));
        return { sessionKey, map: next };
      });
    },
    [sessionKey, isRowAutoOpen],
  );

  const onLoadOlder = useCallback(() => {
    postToHost({ type: 'loadOlder', payload: {} });
  }, []);

  const {
    scrollerRef,
    listRef,
    footerRef,
    range,
    paddingTop,
    paddingBottom,
    farFromBottom,
    unseen,
    showLoadingOlder,
    registerRow,
    toBottom,
  } = useVirtualThread({
    rows,
    expandedRowIds,
    sessionKey,
    hasOlder: session.hasOlder,
    loadingOlder: session.loadingOlder,
    interactionsCount: interactions.length,
    appearanceKey,
    onLoadOlder,
  });

  const visibleSlice: ReactNode[] = [];
  if (range.endIndex >= range.startIndex) {
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const row = rows[index];
      if (!row) continue;
      const prevRow = index > 0 ? rows[index - 1] : undefined;
      const nextRow = rows[index + 1];
      const current = row.grouped ? undefined : row.items[0];
      const prev = prevRow && !prevRow.grouped ? prevRow.items[0] : undefined;
      const running = row.grouped ? isRowAutoOpen(row) : false;
      const mergeTurnDone =
        nextRow?.items[0]?.kind === 'turnDone' && current?.kind === 'assistant' && !current.streaming && Boolean(current.markdown);
      const turnDoneCopyText =
        current?.kind === 'turnDone' && prev?.kind === 'assistant' && !prev.streaming && prev.markdown
          ? prev.markdown
          : undefined;
      visibleSlice.push(
        <VirtualRow key={row.id} id={row.id} index={index} registerRow={registerRow}>
          {row.grouped ? (
            <ThinkingTrace
              active={running}
              open={expandedRowIds.has(row.id)}
              label={running ? t('trace.running', rowToolCount(row)) : t('trace.count', rowToolCount(row))}
              onToggle={() => toggleRow(row)}
            >
              {row.items.map((item) => (
                <ItemView key={item.id} item={item} />
              ))}
            </ThinkingTrace>
          ) : (
            <ItemView
              item={row.items[0]!}
              hideAssistantActions={mergeTurnDone}
              {...(turnDoneCopyText !== undefined ? { turnDoneCopyText } : {})}
              {...(turnSeqById.get(row.items[0]!.id) !== undefined ? { turnSeq: turnSeqById.get(row.items[0]!.id) } : {})}
              {...(canRollbackFiles && lastTurnHasChanges && !session.running && row.items[0]!.id === lastTurnDoneId
                ? { canRollback: true }
                : {})}
            />
          )}
        </VirtualRow>,
      );
    }
  }

  return (
    <div className="thread-wrap relative flex min-h-0 flex-1 flex-col">
      <div
        className="thread topbar-scroll-fade"
        ref={scrollerRef}
        role="region"
        aria-label={t('thread.label')}
        aria-busy={session.running}
        tabIndex={-1}
      >
        {session.sync === 'disconnected' ? (
          <div className="thread__sync surface-glass flex items-center justify-center gap-2 self-center rounded-full border border-line px-3 py-1.5 text-[12px] shadow-card" role="status">
            <LoaderGrid />
            <Shimmer>{t('thread.reconnecting')}</Shimmer>
          </div>
        ) : null}
        {session.hasOlder ? (
          <div
            className="thread__older flex min-h-7 items-center justify-center gap-2 text-[12px] text-ink-3"
            role={showLoadingOlder ? 'status' : undefined}
            aria-live={showLoadingOlder ? 'polite' : undefined}
            aria-hidden={showLoadingOlder ? undefined : true}
            data-testid={showLoadingOlder ? 'thread-loading-older' : 'thread-older-sentinel'}
          >
            {showLoadingOlder ? (
              <>
                <SpinnerIcon className="size-3.5" />
                <Shimmer>{t('thread.loading')}</Shimmer>
              </>
            ) : null}
          </div>
        ) : null}
        {items.length > 0 ? (
          <div
            ref={listRef}
            className="thread__virtual flex min-w-0 flex-col gap-[14px]"
            data-testid="thread-virtual-list"
            style={{ paddingTop, paddingBottom }}
          >
            {visibleSlice}
          </div>
        ) : null}
        <div ref={footerRef} className="thread__footer flex min-w-0 flex-col gap-[14px] empty:hidden">
          {interactions.map((interaction) => (
            <InteractionCard key={interaction.id} interaction={interaction} />
          ))}
          <RunStatus />
        </div>
      </div>
      <Announcer running={session.running} waiting={interactions.length > 0} />
      {farFromBottom ? (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={cn(
            'to-bottom surface-glass absolute right-3.5 bottom-3 z-10 rounded-full border-line-strong/80 text-ink shadow-raised',
            unseen && 'to-bottom--unseen',
          )}
          style={{ animation: 'to-bottom-in 160ms cubic-bezier(0.23,1,0.32,1) both' }}
          title={t('thread.toBottom')}
          aria-label={t('thread.toBottom')}
          data-testid="to-bottom"
          onClick={toBottom}
        >
          <ArrowDownIcon className="size-4" />
          {unseen ? <span className="to-bottom__dot absolute top-0.5 right-0.5 size-2 rounded-full border-2 border-surface bg-brand" aria-label={t('thread.newContent')} /> : null}
        </Button>
      ) : null}
    </div>
  );
}

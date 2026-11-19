/**
 * 对话流（Beautiful UI 流式布局 + 虚拟滚动 + 顶部自动无限加载 + 悬浮回底胶囊按钮）：
 * - 虚拟滚动：只挂载可视区域及上下 overscan 范围内的消息节点，支持超长会话流畅上下滚动；
 * - 无限滚动：向上滚动接近顶部（或内容不足一屏）时自动加载更早历史，无需手动点击按钮，并精确锚定当前阅读位置；
 * - 贴底跟随：用户停在底部时跟随新内容，往上翻时不打扰并在有新消息时提示回底。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { useVirtualThread } from '../hooks/useVirtualThread.ts';
import { LoaderGrid, Shimmer } from './beautifului/index.ts';
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
  const t = useT();

  const appearanceKey = [
    appearance.fontFamily ?? '',
    appearance.fontSize ?? '',
    appearance.lineHeight ?? '',
    appearance.paragraphSpacing ?? '',
    appearance.contentWidth ?? '',
  ].join('|');

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
    items,
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
      const item = items[index];
      if (!item) continue;
      const prev = index > 0 ? items[index - 1] : undefined;
      const next = items[index + 1];
      const mergeTurnDone = next?.kind === 'turnDone' && item.kind === 'assistant' && !item.streaming && Boolean(item.markdown);
      const turnDoneCopyText =
        item.kind === 'turnDone' && prev?.kind === 'assistant' && !prev.streaming && prev.markdown
          ? prev.markdown
          : undefined;
      visibleSlice.push(
        <VirtualRow key={item.id} id={item.id} index={index} registerRow={registerRow}>
          <ItemView
            item={item}
            hideAssistantActions={mergeTurnDone}
            {...(turnDoneCopyText !== undefined ? { turnDoneCopyText } : {})}
          />
        </VirtualRow>,
      );
    }
  }

  return (
    <div className="thread-wrap relative flex min-h-0 flex-1 flex-col">
      <div
        className="thread"
        ref={scrollerRef}
        role="region"
        aria-label={t('thread.label')}
        aria-busy={session.running}
        tabIndex={-1}
      >
        {session.sync === 'disconnected' ? (
          <div className="thread__sync flex items-center justify-center gap-2 self-center rounded-full bg-surface px-3 py-1.5 text-[12px] shadow-card" role="status">
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
            'to-bottom absolute right-3.5 bottom-3 z-10 rounded-full bg-surface shadow-raised text-ink',
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

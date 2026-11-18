/**
 * 对话流（Beautiful UI 流式布局 + 悬浮回底胶囊按钮）：
 * 贴底滚动（用户停在底部时跟随新内容，往上翻时不打扰）、加载更早的历史、运行状态。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from './ui/Button.tsx';
import { LoaderGrid } from './ui/LoaderGrid.tsx';
import { Shimmer } from './ui/Shimmer.tsx';
import { InteractionCard } from './Interactions.tsx';
import { ItemView } from './Items.tsx';
import { RunStatus } from './RunStatus.tsx';
import { ArrowDownIcon, ArrowUpIcon, SpinnerIcon } from './icons.tsx';
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

const STICK_THRESHOLD = 48;
const BUTTON_THRESHOLD = 240;

export function Thread() {
  const items = useView((s) => s.items);
  const interactions = useView((s) => s.interactions);
  const session = useView((s) => s.session);
  const sessionKey = useView((s) => s.sessionKey);
  const scroller = useRef<HTMLDivElement>(null);
  const t = useT();
  const stick = useRef(true);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(false);

  useLayoutEffect(() => {
    stick.current = true;
    setFarFromBottom(false);
    setUnseen(false);
  }, [sessionKey]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const lastId = items.at(-1)?.id;
  const seen = useRef({ lastId, interactions: interactions.length });
  useEffect(() => {
    const before = seen.current;
    seen.current = { lastId, interactions: interactions.length };
    if (!stick.current && (lastId !== before.lastId || interactions.length > before.interactions)) setUnseen(true);
  }, [lastId, interactions.length]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = distance < STICK_THRESHOLD;
      setFarFromBottom(distance > BUTTON_THRESHOLD);
      if (stick.current) setUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="thread-wrap relative flex min-h-0 flex-1 flex-col">
      <div className="thread" ref={scroller} role="region" aria-label={t('thread.label')} aria-busy={session.running} tabIndex={-1}>
        {session.sync === 'disconnected' ? (
          <div className="thread__sync flex items-center justify-center gap-2 self-center rounded-full bg-surface px-3 py-1.5 text-[12px] shadow-card" role="status">
            <LoaderGrid />
            <Shimmer>{t('thread.reconnecting')}</Shimmer>
          </div>
        ) : null}
        {session.hasOlder ? (
          <div className="thread__older flex justify-center">
            <Button
              variant="secondary"
              size="xs"
              className="link-button text-ink-2"
              disabled={session.loadingOlder}
              onClick={() => postToHost({ type: 'loadOlder', payload: {} })}
            >
              {session.loadingOlder ? <SpinnerIcon className="size-3.5" /> : <ArrowUpIcon className="size-3.5" />}
              {session.loadingOlder ? t('thread.loading') : t('thread.older')}
            </Button>
          </div>
        ) : null}
        {items.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
        {interactions.map((interaction) => (
          <InteractionCard key={interaction.id} interaction={interaction} />
        ))}
        <RunStatus />
      </div>
      <Announcer running={session.running} waiting={interactions.length > 0} />
      {farFromBottom ? (
        <Button
          variant="secondary"
          size="icon"
          className={cn(
            'to-bottom absolute right-3.5 bottom-3 z-10 size-8 rounded-full shadow-raised text-ink',
            unseen && 'to-bottom--unseen',
          )}
          style={{ animation: 'to-bottom-in 160ms cubic-bezier(0.23,1,0.32,1) both' }}
          title={t('thread.toBottom')}
          aria-label={t('thread.toBottom')}
          data-testid="to-bottom"
          onClick={toBottom}
        >
          <ArrowDownIcon className="size-4" />
          {unseen ? <span className="to-bottom__dot absolute top-0.5 right-0.5 size-2 rounded-full border-2 border-surface bg-accent" aria-label={t('thread.newContent')} /> : null}
        </Button>
      ) : null}
    </div>
  );
}

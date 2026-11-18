/**
 * 运行状态（Beautiful UI LoadingState 像素波纹 + Shimmer + 等宽计时器）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { Item } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { cn } from '../lib/utils.ts';
import { LoaderGrid, Shimmer } from './beautifului/index.ts';
import { CheckIcon } from './icons.tsx';
import { useT, type Translate } from '../i18n.ts';

/** 「12 秒」「1 分 23 秒」「1 小时 2 分」。 */
export function formatDuration(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('duration.seconds', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('duration.minutes', minutes, seconds % 60);
  return t('duration.hours', Math.floor(minutes / 60), minutes % 60);
}

/** 正在做的事：看最后一个条目。 */
function activityOf(items: readonly Item[], waiting: boolean, t: Translate): string {
  if (waiting) return t('run.waiting');
  const last = [...items].reverse().find((item) => !(item.kind === 'user' && item.pending === 'queued'));
  if (last?.kind === 'assistant' && last.streaming) return last.markdown ? t('run.replying') : t('run.thinking');
  if (last?.kind === 'activity' && last.status === 'running') {
    if (last.variant === 'command') return t('run.command');
    if (last.variant === 'edit') return t('run.editing', last.label);
    return t('run.tool', last.label.split('  ', 1)[0] ?? last.tool);
  }
  if (last?.kind === 'explore' && last.status === 'running') return t('run.exploring');
  return t('run.thinking');
}

export function RunStatus() {
  const running = useView((s) => s.session.running);
  const since = useView((s) => s.session.runningSince);
  const sessionKey = useView((s) => s.sessionKey);
  const items = useView((s) => s.items);
  const waiting = useView((s) => s.interactions.length > 0);
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [seenAt, setSeenAt] = useState<number | undefined>();

  useEffect(() => {
    if (!running) {
      setSeenAt(undefined);
      return;
    }
    setSeenAt((value) => value ?? Date.now());
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, sessionKey]);

  if (!running) return null;
  const start = since ?? seenAt ?? now;
  const label = activityOf(items, waiting, t);
  return (
    <div
      className={cn(
        'run-status flex w-fit max-w-full items-center gap-2.5 self-start rounded-full px-3 py-1.5 text-[12.5px]',
        waiting
          ? 'run-status--waiting bg-orange-tint text-orange shadow-[0_0_0_1px_color-mix(in_srgb,var(--orange)_34%,transparent)]'
          : 'bg-surface text-ink shadow-card',
      )}
      role="status"
      aria-label={t('thread.busy')}
      data-testid="run-status"
      style={{ animation: 'fade-up 220ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <span className="run-status__icon inline-flex shrink-0">
        {waiting ? <span className="dot dot--attention inline-block size-2 rounded-full bg-orange" /> : <LoaderGrid />}
      </span>
      <span className="run-status__label min-w-0 truncate font-medium">
        {waiting ? label : <Shimmer>{label}</Shimmer>}
      </span>
      <span className="run-status__time shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">
        {formatDuration(now - start, t)}
      </span>
    </div>
  );
}

/** 一轮结束时的用时（可合并上一条助手消息的操作栏到同一行）。 */
export function TurnDone({ item, actions }: { item: Extract<Item, { kind: 'turnDone' }>; actions?: ReactNode }) {
  const t = useT();
  return (
    <div className={cn('turn-done flex items-center gap-2 text-[12px] text-ink-3', actions ? '-mt-2' : '-mt-1')} data-testid="turn-done">
      {actions}
      <span className="flex items-center gap-1.5">
        {item.completed ? (
          <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-green-tint text-green">
            <CheckIcon className="size-2.5" strokeWidth={2.5} />
          </span>
        ) : null}
        <span>{item.completed ? t('run.done', formatDuration(item.durationMs, t)) : t('run.took', formatDuration(item.durationMs, t))}</span>
      </span>
    </div>
  );
}

/**
 * 运行状态（Beautiful UI Loading State Orbit 模式 + 等宽计时器）。
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Item } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useView } from '../store.ts';
import { cn } from '../lib/utils.ts';
import { LoadingState } from './beautifului/index.ts';
import { CheckIcon, CopyIcon, GitForkIcon, UndoIcon } from './icons.tsx';
import { useT, type Translate } from '../i18n.ts';
import { postToHost } from '../vscode.ts';

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
  const elapsed = formatDuration(now - start, t);
  if (waiting) {
    return (
      <div
        className="run-status run-status--waiting flex w-fit max-w-full items-center gap-2.5 self-start py-0.5 text-[13px] text-orange"
        role="status"
        aria-label={t('thread.busy')}
        data-testid="run-status"
        style={{ animation: 'fade-up 220ms cubic-bezier(0.23,1,0.32,1) both' }}
      >
        <span className="run-status__icon inline-flex size-4 shrink-0 items-center justify-center">
          <span className="dot dot--attention inline-block size-2 rounded-full bg-orange" />
        </span>
        <span className="run-status__label min-w-0 truncate font-medium">{label}</span>
        <span className="run-status__time shrink-0 font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>
      </div>
    );
  }
  return (
    <LoadingState
      variant="Orbit"
      label={label}
      elapsed={elapsed}
      className="run-status self-start py-0.5"
      role="status"
      aria-label={t('thread.busy')}
      data-testid="run-status"
      style={{ animation: 'fade-up 220ms cubic-bezier(0.23,1,0.32,1) both' }}
    />
  );
}

export function IconAction({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="msg-action flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 对齐 Beautiful UI StreamingText 底部操作图标行。 */
export function AssistantActions({ text, inline = false }: { text: string; inline?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <div className={cn('flex items-center gap-0.5', !inline && 'mt-1.5')}>
      <IconAction
        label={copied ? t('assistant.copied') : t('assistant.copy')}
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
              clearTimeout(timerRef.current);
              timerRef.current = setTimeout(() => setCopied(false), 1_200);
            })
            .catch(() => undefined)
        }
      >
        {copied ? <CheckIcon className="size-3.5 text-green" /> : <CopyIcon className="size-3.5" />}
      </IconAction>
    </div>
  );
}

/** 一轮结束时的用时（可合并上一条助手消息的操作栏到同一行，并挂接跨底层检查点回滚与会话分叉）。 */
export const TurnDone = memo(function TurnDone({
  item,
  copyText,
  turnSeq,
  canRollback = false,
  hasCheckpoint = false,
  canFork = false,
}: {
  item: Extract<Item, { kind: 'turnDone' }>;
  copyText?: string;
  turnSeq?: number;
  canRollback?: boolean;
  hasCheckpoint?: boolean;
  canFork?: boolean;
}) {
  const t = useT();
  const clientSurface = useView((s) => s.clientSurface);
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [checkpointConfirmOpen, setCheckpointConfirmOpen] = useState(false);
  const hasActions = copyText !== undefined;
  return (
    <div className={cn('turn-done flex flex-wrap items-center gap-2 text-[12px] text-ink-3', hasActions ? '-mt-2' : '-mt-1')} data-testid="turn-done">
      {hasActions ? <AssistantActions text={copyText} inline /> : null}
      {turnSeq !== undefined ? <span className="text-ink-3">{t('run.turn', turnSeq)}</span> : null}
      <span className="flex items-center gap-1.5">
        {item.completed ? (
          <span className="inline-flex size-3.5 items-center justify-center text-green">
            <CheckIcon className="size-3.5" strokeWidth={2.5} />
          </span>
        ) : null}
        <span>{item.completed ? t('run.done', formatDuration(item.durationMs, t)) : t('run.took', formatDuration(item.durationMs, t))}</span>
      </span>
      {canRollback && !remoteReadOnly ? (
        <button
          type="button"
          className="rounded px-1 text-[11.5px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          onClick={() => {
            if (clientSurface === 'mobile-web') {
              setRollbackConfirmOpen(true);
            } else {
              postToHost({ type: 'rollbackLastTurn', payload: {} });
            }
          }}
        >
          {t('run.rollback')}
        </button>
      ) : null}
      {hasCheckpoint && turnSeq !== undefined && !remoteReadOnly ? (
        <button
          type="button"
          data-testid={`turn-checkpoint-rollback-${turnSeq}`}
          title={t('turn.rollbackCheckpointTitle', turnSeq)}
          className="inline-flex items-center gap-1 rounded px-1 text-[11.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          onClick={() => setCheckpointConfirmOpen(true)}
        >
          <UndoIcon className="size-3" />
          <span>{t('turn.rollbackCheckpoint')}</span>
        </button>
      ) : null}
      {canFork && turnSeq !== undefined && !remoteReadOnly ? (
        <button
          type="button"
          data-testid={`turn-fork-${turnSeq}`}
          title={t('turn.forkTitle', turnSeq)}
          className="inline-flex items-center gap-1 rounded px-1 text-[11.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          onClick={() => postToHost({ type: 'forkSessionAtTurn', payload: { turnSeq } })}
        >
          <GitForkIcon className="size-3" />
          <span>{t('turn.fork')}</span>
        </button>
      ) : null}
      <Dialog open={rollbackConfirmOpen} onOpenChange={setRollbackConfirmOpen}>
        <DialogContent data-testid="mobile-rollback-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.rollbackTitle')}</DialogTitle>
            <DialogDescription>{t('mobile.confirm.rollbackDetail')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setRollbackConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="mobile-rollback-confirm"
              onClick={() => {
                setRollbackConfirmOpen(false);
                postToHost({ type: 'rollbackLastTurn', payload: { confirmed: true } });
              }}
            >
              {t('mobile.confirm.rollbackAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={checkpointConfirmOpen} onOpenChange={setCheckpointConfirmOpen}>
        <DialogContent data-testid="checkpoint-rollback-dialog">
          <DialogHeader>
            <DialogTitle>{t('turn.rollbackCheckpointConfirm', turnSeq ?? 1)}</DialogTitle>
            <DialogDescription>{t('turn.rollbackCheckpointDesc', turnSeq ?? 1)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setCheckpointConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="checkpoint-rollback-confirm"
              onClick={() => {
                setCheckpointConfirmOpen(false);
                if (turnSeq !== undefined) {
                  postToHost({ type: 'rollbackToTurn', payload: { turnSeq, confirmed: true } });
                }
              }}
            >
              {t('turn.rollbackCheckpoint')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

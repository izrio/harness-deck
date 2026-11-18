/**
 * 子代理（对齐 Beautiful UI TaskRows Capsules：状态圆环/徽章、状态胶囊、平滑网格展开）。
 */
import { useEffect, useState } from 'react';
import type { Item } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { Shimmer, ValuePill } from './beautifului/index.ts';
import { Markdown } from './Markdown.tsx';
import { formatDuration } from './RunStatus.tsx';
import { AgentIcon, CheckIcon, ErrorIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

type Activity = Extract<Item, { kind: 'activity' }>;

function TaskRing() {
  const size = 22;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg aria-hidden width={size} height={size} className="absolute inset-0" style={{ animation: 'spin 1.1s linear infinite' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.28} ${c * 0.72}`}
        />
      </svg>
      <AgentIcon className="relative size-2.5 text-ink-2" />
    </span>
  );
}

export function SubagentRow({ item }: { item: Activity }) {
  const t = useT();
  const sub = item.subagent!;
  const parentId = useView((s) => s.session.id);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const running = sub.state === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = sub.startedAt !== undefined ? (sub.endedAt ?? (running ? now : undefined)) : undefined;
  const duration = elapsed !== undefined && sub.startedAt !== undefined ? formatDuration(elapsed - sub.startedAt, t) : undefined;
  const status = running ? t('subagent.running') : sub.state === 'failed' ? t('subagent.failed') : t('subagent.done');

  return (
    <div
      className={cn(
        'subagent self-stretch overflow-hidden bg-surface shadow-card transition-[border-radius,background-color] duration-300 hover:bg-inset',
        `subagent--${sub.state}`,
      )}
      style={{ borderRadius: open ? 14 : 22, animation: 'fade-up 320ms cubic-bezier(0.23,1,0.32,1) both' }}
      data-testid="subagent"
    >
      <button
        type="button"
        className="subagent__row flex h-11 w-full items-center gap-2.5 px-2.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={sub.prompt ?? item.label}
      >
        <span className="subagent__icon flex size-6 shrink-0 items-center justify-center">
          {running ? (
            <TaskRing />
          ) : sub.state === 'failed' ? (
            <span className="flex size-5.5 items-center justify-center rounded-full bg-red text-white">
              <ErrorIcon className="size-3" strokeWidth={2.5} />
            </span>
          ) : (
            <span className="flex size-5.5 items-center justify-center rounded-full bg-green text-white">
              <CheckIcon className="size-3" strokeWidth={2.8} />
            </span>
          )}
        </span>
        <span className="subagent__kind shrink-0 text-[12px] text-ink-3">{t('subagent.label')}</span>
        <span className="subagent__label min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{item.label}</span>
        {duration ? <span className="subagent__time shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">{duration}</span> : null}
        <span className="subagent__status shrink-0">
          {running ? (
            <ValuePill tone="accent">
              <Shimmer>{status}</Shimmer>
            </ValuePill>
          ) : (
            <ValuePill tone={sub.state === 'failed' ? 'red' : 'green'}>{status}</ValuePill>
          )}
        </span>
        <span aria-hidden className="-ml-1 flex size-6 shrink-0 items-center justify-center text-ink-3">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-transform duration-300"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="overflow-hidden">
          {open ? (
            <div className="subagent__body mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
              <span aria-hidden className="mx-auto h-full w-px bg-line" />
              <div className="flex min-w-0 flex-col gap-2.5">
                {sub.prompt ? (
                  <section className="subagent__section">
                    <div className="subagent__heading mb-1 text-[11.5px] font-medium text-ink-3">{t('subagent.task')}</div>
                    <div className="subagent__prompt max-h-36 overflow-auto rounded-control bg-field px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
                      {sub.prompt}
                    </div>
                  </section>
                ) : null}
                <section className="subagent__section">
                  <div className="subagent__heading mb-1 text-[11.5px] font-medium text-ink-3">{t('subagent.result')}</div>
                  {sub.result ? (
                    <div className="subagent__result max-h-80 overflow-auto rounded-control bg-inset/60 p-2.5 shadow-hairline">
                      <Markdown text={sub.result} />
                    </div>
                  ) : (
                    <div className="subagent__pending text-[12px] text-ink-3">{running ? t('subagent.waiting') : t('subagent.noResult')}</div>
                  )}
                </section>
                {sub.childId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="subagent__open self-start"
                    onClick={() => postToHost({ type: 'switchSession', payload: { sessionId: sub.childId!, label: item.label, ...(parentId ? { parentId } : {}) } })}
                  >
                    {t('subagent.openChat')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

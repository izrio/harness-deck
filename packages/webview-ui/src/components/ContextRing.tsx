/**
 * 上下文用量的环形进度：随用量变色（70% 以上提醒，90% 以上警告），悬停显示用了多少 token。
 * 底层给出用量明细（输入、缓存读写、输出、累计与费用）时，悬停或点击圆环弹出 Popover 展示。
 */
import { useEffect, useRef, useState } from 'react';
import type { ContextDetail, TokenBreakdown } from '@harness-deck/shared';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '../lib/utils.ts';
import { useT } from '../i18n.ts';

const SIZE = 16;
const STROKE = 2.2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 悬浮多久后弹出明细，避免扫过工具条时误弹。 */
const OPEN_DELAY = 250;
/** 移开后多久收起，留出从圆环移到浮层内容的时间。 */
const CLOSE_DELAY = 250;

/** 12345 → 12.3k，1048576 → 1.0M */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 美元带 $，其他币种带代码；小额多留几位小数。 */
function formatCost(amount: number, currency: string): string {
  const body = amount >= 1 ? amount.toFixed(2) : amount.toFixed(4);
  return currency === 'USD' ? `$${body}` : `${body} ${currency}`;
}

/** 圆环本体（svg + 过半才显示的百分比）。 */
function RingVisual({ usage, percent }: { usage: number; percent: number }) {
  // 有用量时至少画出一小段，避免 1% 以下看起来是空的
  const filled = Math.max(usage, usage > 0 ? 0.02 : 0) * CIRCUMFERENCE;
  return (
    <>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
        <circle className="context-ring__track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} fill="none" />
        <circle
          className="context-ring__value"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      {/* 用得不多时只显示圆环（数字在悬停提示里），过半才显示百分比，少打扰 */}
      {percent >= 50 ? <span className="context-ring__label">{percent}%</span> : null}
    </>
  );
}

/** 一组用量的四段横向占比条：输入 / 缓存读取 / 缓存写入 / 输出。 */
function BreakdownBar({ b }: { b: TokenBreakdown }) {
  const t = useT();
  const segments = [
    { key: 'input', label: t('context.detail.input'), value: b.input, className: 'bg-brand' },
    { key: 'cacheRead', label: t('context.detail.cacheRead'), value: b.cacheRead, className: 'bg-brand/45' },
    { key: 'cacheWrite', label: t('context.detail.cacheWrite'), value: b.cacheWrite, className: 'bg-ink-3' },
    { key: 'output', label: t('context.detail.output'), value: b.output, className: 'bg-ink' },
  ].filter((s) => s.value > 0);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return null;
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-field shadow-hairline"
      role="img"
      aria-label={t('context.detail.barLabel', formatTokens(total))}
    >
      {segments.map((s) => (
        <span key={s.key} aria-hidden className={cn('h-full', s.className)} style={{ width: `${(s.value / total) * 100}%` }} />
      ))}
    </div>
  );
}

/** 一组用量的逐项数字（与占比条同色的小圆点 + 数值 + 合计）。 */
function BreakdownRows({ b }: { b: TokenBreakdown }) {
  const t = useT();
  const rows = [
    { key: 'input', label: t('context.detail.input'), value: b.input, dot: 'bg-brand' },
    { key: 'cacheRead', label: t('context.detail.cacheRead'), value: b.cacheRead, dot: 'bg-brand/45' },
    { key: 'cacheWrite', label: t('context.detail.cacheWrite'), value: b.cacheWrite, dot: 'bg-ink-3' },
    { key: 'output', label: t('context.detail.output'), value: b.output, dot: 'bg-ink' },
  ].filter((r) => r.value > 0);
  const total = b.input + b.cacheRead + b.cacheWrite + b.output;
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r) => (
        <div key={r.key} className="flex min-w-0 items-center gap-2 text-[11.5px] leading-4">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', r.dot)} />
          <span className="min-w-0 flex-1 text-ink-2">{r.label}</span>
          <span className="font-mono tabular-nums text-ink">{formatTokens(r.value)}</span>
        </div>
      ))}
      {b.reasoning && b.reasoning > 0 ? (
        <div className="pl-4 text-[11px] leading-4 text-ink-3">{t('context.detail.reasoning', formatTokens(b.reasoning))}</div>
      ) : null}
      <div className="mt-0.5 flex items-center justify-between border-t border-line pt-1.5 text-[11.5px] leading-4">
        <span className="text-ink-3">{t('context.detail.total')}</span>
        <span className="font-mono font-medium tabular-nums text-ink">{formatTokens(total)}</span>
      </div>
    </div>
  );
}

/** 明细里的一节：小标题（最近一次请求 / 本会话累计）+ 占比条 + 逐项数字。 */
function DetailSection({ title, hint, b }: { title: string; hint?: string; b: TokenBreakdown }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] font-medium leading-4 text-ink-3">
        <span>{title}</span>
        {hint ? <span className="tabular-nums">{hint}</span> : null}
      </div>
      <BreakdownBar b={b} />
      <BreakdownRows b={b} />
    </section>
  );
}

export function ContextRing({
  usage,
  tokens,
  detail,
}: {
  usage: number;
  tokens?: { used: number; window: number };
  detail?: ContextDetail;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const percent = Math.round(usage * 100);
  const level = usage >= 0.9 ? 'high' : usage >= 0.7 ? 'medium' : 'low';
  const title = tokens ? t('context.ring', percent, formatTokens(tokens.used), formatTokens(tokens.window)) : t('composer.context', percent);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  if (!detail) {
    return (
      <span className={`context-ring context-ring--${level}`} title={title} role="img" aria-label={title} data-testid="context-ring">
        <RingVisual usage={usage} percent={percent} />
      </span>
    );
  }

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const enter = () => {
    clearTimeout(closeTimer.current);
    if (!open) openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const leave = () => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };
  const toggle = (next: boolean) => {
    clearTimers();
    setOpen(next);
  };

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`context-ring context-ring--${level} cursor-default rounded-[6px] px-0.5 transition-colors duration-100 hover:bg-hover`}
          aria-label={title}
          data-testid="context-ring"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={() => clearTimeout(openTimer.current)}
        >
          <RingVisual usage={usage} percent={percent} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        aria-label={t('context.detail.title')}
        className="w-60 rounded-card p-0 shadow-raised"
        data-testid="context-detail-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
        onPointerLeave={leave}
      >
        <div className="flex flex-col gap-2.5 px-3 py-2.5" data-testid="context-detail">
          <header>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold leading-4 text-ink">{t('context.detail.title')}</span>
              <span
                className={cn('font-mono text-[12.5px] font-semibold tabular-nums', level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-ink')}
              >
                {percent}%
              </span>
            </div>
            {tokens ? (
              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-ink-3">
                {formatTokens(tokens.used)} / {formatTokens(tokens.window)} tokens
              </div>
            ) : null}
          </header>
          {detail.lastRequest ? <DetailSection title={t('context.detail.last')} b={detail.lastRequest} /> : null}
          {detail.session ? (
            <DetailSection
              title={t('context.detail.session')}
              {...(detail.requests ? { hint: t('context.detail.requests', detail.requests) } : {})}
              b={detail.session}
            />
          ) : null}
          {detail.cost ? (
            <div className="flex items-center justify-between border-t border-line pt-2 text-[11.5px] leading-4">
              <span className="text-ink-3">{t('context.detail.cost')}</span>
              <span className="font-mono tabular-nums text-ink" data-testid="context-detail-cost">
                {formatCost(detail.cost.amount, detail.cost.currency)}
              </span>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

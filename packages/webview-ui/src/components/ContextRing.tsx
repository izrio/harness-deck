/**
 * 上下文用量标识：与订阅用量（UsageBadge）保持同一设计语言（图标 + 百分比），
 * 随占用比例变色（70% 以上提醒，90% 以上警告），悬停或点击弹出 Popover 展示 token 明细与费用。
 */
import { useEffect, useRef, useState } from 'react';
import type { ContextDetail, RequestPerformance, TokenBreakdown } from '@harness-deck/shared';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '../lib/utils.ts';
import { useT } from '../i18n.ts';
import { ChartPieIcon } from './icons.tsx';

/** 悬浮多久后弹出明细，避免扫过工具条时误弹。 */
const OPEN_DELAY = 250;
/** 移开后多久收起，留出从标识移到浮层内容的时间。 */
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

/** 缓存命中比例：cacheRead / (input + cacheRead + cacheWrite) * 100。 */
export function cacheHitRate(b: TokenBreakdown): number | undefined {
  const totalInput = b.input + b.cacheRead + b.cacheWrite;
  if (totalInput <= 0 || b.cacheRead <= 0) return undefined;
  return (b.cacheRead / totalInput) * 100;
}

/** 格式化缓存比例：99.95% 及以上取整为 100%，其余保留 1 位小数。 */
export function formatCacheRate(pct: number): string {
  if (pct >= 99.95) return '100%';
  return `${pct.toFixed(1)}%`;
}

/** 格式化耗时（首字耗时等）：<1s 用 ms，<60s 用 1 位小数秒，其余用分秒。 */
export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSecs = Math.round(ms / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/** 格式化生成速度（tokens/s）。 */
export function formatSpeed(tokensPerSec: number): string {
  return `${tokensPerSec.toFixed(1)} tok/s`;
}

/** 图标 + 百分比，样式与 UsageBadge 对齐。 */
function ContextBadgeVisual({ percent }: { readonly percent: number }) {
  return (
    <>
      <ChartPieIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{percent}%</span>
    </>
  );
}

function breakdownTotal(b: TokenBreakdown): number {
  return b.input + b.cacheRead + b.cacheWrite + b.output;
}

function sameBreakdown(a: TokenBreakdown | undefined, b: TokenBreakdown | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    (a.reasoning ?? 0) === (b.reasoning ?? 0)
  );
}

/** 一组用量的四段横向占比条：输入 / 缓存读取 / 缓存写入 / 输出。 */
function BreakdownBar({ b }: { readonly b: TokenBreakdown }) {
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

/** 一组用量的逐项数字（与占比条同色的小圆点 + 数值；缓存比例与推理数内联在对应行旁）。 */
function BreakdownRows({ b }: { readonly b: TokenBreakdown }) {
  const t = useT();
  const rate = cacheHitRate(b);
  const rows = [
    { key: 'input', label: t('context.detail.input'), value: b.input, dot: 'bg-brand' },
    {
      key: 'cacheRead',
      label: t('context.detail.cacheRead'),
      value: b.cacheRead,
      dot: 'bg-brand/45',
      ...(rate !== undefined ? { hint: formatCacheRate(rate), hintTestId: 'context-detail-cache-rate' } : {}),
    },
    { key: 'cacheWrite', label: t('context.detail.cacheWrite'), value: b.cacheWrite, dot: 'bg-ink-3' },
    {
      key: 'output',
      label: t('context.detail.output'),
      value: b.output,
      dot: 'bg-ink',
      ...(b.reasoning && b.reasoning > 0 ? { hint: t('context.detail.reasoning', formatTokens(b.reasoning)) } : {}),
    },
  ].filter((r) => r.value > 0);
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r) => (
        <div key={r.key} className="flex min-w-0 items-baseline justify-between gap-2 text-[11.5px] leading-4">
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', r.dot)} />
            <span className="truncate text-ink-2">{r.label}</span>
            {r.hint ? (
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3" data-testid={r.hintTestId}>
                ({r.hint})
              </span>
            ) : null}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-ink">{formatTokens(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** 紧凑两列汇总：当「最近一次请求」已展开完整明细时，用轻量网格展示「本会话累计」。 */
function CompactBreakdownGrid({ b }: { readonly b: TokenBreakdown }) {
  const t = useT();
  const rate = cacheHitRate(b);
  const items: { key: string; label: string; text: string; testId?: string }[] = [
    ...(b.input > 0 ? [{ key: 'input', label: t('context.detail.input'), text: formatTokens(b.input) }] : []),
    ...(b.cacheRead > 0 ? [{ key: 'cacheRead', label: t('context.detail.cacheRead'), text: formatTokens(b.cacheRead) }] : []),
    ...(b.cacheWrite > 0 ? [{ key: 'cacheWrite', label: t('context.detail.cacheWrite'), text: formatTokens(b.cacheWrite) }] : []),
    ...(b.output > 0 ? [{ key: 'output', label: t('context.detail.output'), text: formatTokens(b.output) }] : []),
    ...(rate !== undefined
      ? [{ key: 'cacheRate', label: t('context.detail.cacheRate'), text: formatCacheRate(rate), testId: 'context-detail-session-cache-rate' }]
      : []),
  ];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
      {items.map((item) => (
        <div key={item.key} className="flex items-baseline justify-between gap-1 text-[11px] leading-4">
          <span className="truncate text-ink-3">{item.label}</span>
          <span className="shrink-0 font-mono tabular-nums text-ink-2" data-testid={item.testId}>
            {item.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 最近一次请求的响应性能条：首字耗时（TTFT）与生成速度（tok/s）。 */
function PerformanceStrip({ perf }: { readonly perf: RequestPerformance }) {
  const t = useT();
  const hasTtft = perf.ttftMs !== undefined;
  const hasSpeed = perf.tokensPerSec !== undefined;
  if (!hasTtft && !hasSpeed) return null;
  return (
    <div
      className={cn(
        'border-t border-line pt-2 text-[11px] leading-4',
        hasTtft && hasSpeed ? 'grid grid-cols-2 gap-x-3' : 'flex items-center justify-between',
      )}
      data-testid="context-detail-performance"
    >
      {hasTtft ? (
        <div className="flex w-full items-baseline justify-between gap-1">
          <span className="truncate text-ink-3">{t('context.detail.ttft')}</span>
          <span className="shrink-0 font-mono tabular-nums text-ink" data-testid="context-detail-ttft">
            {formatDurationMs(perf.ttftMs!)}
          </span>
        </div>
      ) : null}
      {hasSpeed ? (
        <div className="flex w-full items-baseline justify-between gap-1">
          <span className="truncate text-ink-3">{t('context.detail.speed')}</span>
          <span className="shrink-0 font-mono tabular-nums text-ink" data-testid="context-detail-speed">
            {formatSpeed(perf.tokensPerSec!)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** 明细里的一节：小标题 + 合计右对齐 + 占比条/明细行（或紧凑网格）。 */
function DetailSection({
  title,
  hint,
  b,
  compact = false,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly b: TokenBreakdown;
  readonly compact?: boolean;
}) {
  const total = breakdownTotal(b);
  return (
    <section className="flex flex-col gap-1.5 border-t border-line pt-2">
      <div className="flex items-baseline justify-between gap-2 text-[11.5px] leading-4">
        <span className="min-w-0 truncate font-medium text-ink">
          {title}
          {hint ? <span className="ml-1.5 font-normal text-ink-3">{hint}</span> : null}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-ink-2">{formatTokens(total)}</span>
      </div>
      {compact ? (
        <CompactBreakdownGrid b={b} />
      ) : (
        <>
          <BreakdownBar b={b} />
          <BreakdownRows b={b} />
        </>
      )}
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

  const badgeClass = cn(
    'context-ring inline-flex h-7 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium tabular-nums transition-colors duration-150',
    level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-ink-2',
  );

  if (!detail && !tokens) {
    return (
      <span className={badgeClass} title={title} role="img" aria-label={title} data-testid="context-ring">
        <ContextBadgeVisual percent={percent} />
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

  const barColor = level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-brand';
  const clampedPercent = Math.min(100, Math.max(0, percent));
  // 首轮请求时「最近一次请求」与「本会话累计」完全相同，只展示一节避免重复刷屏。
  const deduplicated = sameBreakdown(detail?.lastRequest, detail?.session);
  const showLast = Boolean(detail?.lastRequest) && !deduplicated;
  const sessionSection = detail?.session;

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(badgeClass, 'hover:bg-hover')}
          aria-label={title}
          title={title}
          data-testid="context-ring"
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={() => clearTimeout(openTimer.current)}
        >
          <ContextBadgeVisual percent={percent} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        aria-label={t('context.detail.title')}
        className="max-h-[calc(var(--radix-popover-content-available-height)-8px)] w-72 overflow-y-auto rounded-card p-0 shadow-raised"
        data-testid="context-detail-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
        onPointerLeave={leave}
      >
        <div className="flex flex-col gap-2 px-3 py-2.5" data-testid="context-detail">
          <header className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold leading-4 text-ink">{t('context.detail.title')}</span>
              <span
                className={cn('font-mono text-[12px] font-semibold tabular-nums', level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-ink')}
              >
                {percent}%
              </span>
            </div>
            <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-field shadow-hairline', barColor)}>
              <div className="h-full rounded-full bg-current opacity-80" style={{ width: `${clampedPercent}%` }} />
            </div>
            {tokens ? (
              <div className="font-mono text-[11px] leading-4 tabular-nums text-ink-3">
                {formatTokens(tokens.used)} / {formatTokens(tokens.window)} tokens
              </div>
            ) : null}
          </header>
          {showLast && detail?.lastRequest ? <DetailSection title={t('context.detail.last')} b={detail.lastRequest} /> : null}
          {sessionSection ? (
            <DetailSection
              title={t('context.detail.session')}
              {...(detail?.requests ? { hint: t('context.detail.requests', detail.requests) } : {})}
              b={sessionSection}
              compact={showLast}
            />
          ) : null}
          {detail?.performance ? <PerformanceStrip perf={detail.performance} /> : null}
          {detail?.cost ? (
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

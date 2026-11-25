/**
 * 上下文环旁的官方订阅用量标识：只有宿主查到官方订阅额度时才渲染。
 * 支持两种展示模式：
 * - 百分比双圆环模式（`percent`，如 Claude / Antigravity 的 5 小时 + 每周窗口）
 * - 积分余额模式（`credits`，如 CodeBuddy 的积分余额胶囊 + 5 格能量条 + 积分钱包浮层）
 * 挂载时探测一次；每轮对话结束强制刷新；悬浮时复用 5 分钟缓存并展开 Popover。
 */
import { useEffect, useRef, useState } from 'react';
import { backendCapabilities, type QuotaDisplayMode, type QuotaView, type QuotaWindowView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '../lib/utils.ts';
import { getState, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { useT } from '../i18n.ts';
import { CoinsIcon } from './icons.tsx';

/** 与宿主的额度缓存同频，缓存有效期内悬浮不再重复请求。 */
const QUOTA_CACHE_MS = 300_000;
const OPEN_DELAY = 250;
const CLOSE_DELAY = 250;
/** 底层刚连上或切换账号初期遇到临时 unavailable 时，延迟补查一次以覆盖 CLI 后台续期落盘窗口。 */
const TRANSIENT_RETRY_MS = 3_000;
/** 切回窗口/面板可见时自动补查的最小间隔，避免高频切换焦点制造重复请求。 */
const FOCUS_RETRY_COOLDOWN_MS = 15_000;
/** 额度数字平滑插值动画时长（ms）。 */
const NUMBER_TWEEN_MS = 420;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function roundWithDecimals(value: number, decimals: number): number {
  if (decimals <= 0) return Math.round(value);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * 额度/积分平滑数字动画：
 * - 首次挂载直接渲染目标值（无 0→N 闪烁）；
 * - 后续数值变动时用 easeOutCubic 平滑插值滚动到新数值，并叠加轻微垂直微动效。
 */
function useAnimatedNumber(
  target: number,
  options?: { readonly min?: number; readonly max?: number; readonly decimals?: number },
): { readonly display: number; readonly tickKey: number; readonly direction: 'up' | 'down' | 'none' } {
  const min = options?.min ?? 0;
  const max = options?.max ?? 100;
  const decimals = options?.decimals ?? 0;
  const clamped = Math.min(max, Math.max(min, Number.isFinite(target) ? target : min));
  const rounded = roundWithDecimals(clamped, decimals);
  const [display, setDisplay] = useState(rounded);
  const [tickMeta, setTickMeta] = useState<{ readonly key: number; readonly dir: 'up' | 'down' | 'none' }>({
    key: 0,
    dir: 'none',
  });
  const currentRef = useRef(rounded);

  useEffect(() => {
    const from = currentRef.current;
    if (from === rounded) return;
    const dir: 'up' | 'down' = rounded < from ? 'down' : 'up';
    setTickMeta((prev) => ({ key: prev.key + 1, dir }));

    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      currentRef.current = rounded;
      setDisplay(rounded);
      return;
    }

    const start = performance.now();
    let rafId = 0;
    const step = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / NUMBER_TWEEN_MS));
      const eased = 1 - (1 - progress) ** 3;
      const next = progress >= 1 ? rounded : roundWithDecimals(from + (rounded - from) * eased, decimals);
      if (next !== currentRef.current) {
        currentRef.current = next;
        setDisplay(next);
      }
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      }
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [rounded, decimals]);

  return { display, tickKey: tickMeta.key, direction: tickMeta.dir };
}

function AnimatedNumber({
  value,
  min = 0,
  max = 100,
  decimals = 0,
  format = (n) => `${n}%`,
  className,
}: {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly decimals?: number;
  readonly format?: (n: number) => string;
  readonly className?: string;
}) {
  const { display, tickKey, direction } = useAnimatedNumber(value, { min, max, decimals });
  const targetRounded = roundWithDecimals(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)), decimals);
  return (
    <span
      key={tickKey > 0 ? tickKey : undefined}
      data-animated-number
      data-target={targetRounded}
      className={cn('inline-block tabular-nums', className)}
      style={
        direction !== 'none'
          ? {
              animation: `${direction === 'down' ? 'quota-tick-down' : 'quota-tick-up'} 280ms var(--ease-out-strong) both`,
            }
          : undefined
      }
    >
      {format(display)}
    </span>
  );
}

/** 格式化积分数：浮层内展示完整千分位数字；底栏紧凑胶囊遇到 ≥100,000 时缩写为 k / M。 */
function formatCreditNumber(value: number, compact = false): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  if (compact && safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M`;
  }
  if (compact && safe >= 100_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/u, '')}k`;
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Number.isInteger(safe) ? 0 : 1,
  }).format(safe);
}

/** 判定当前额度采用百分比模式还是积分模式。 */
function resolveQuotaMode(quota: QuotaView): QuotaDisplayMode {
  if (quota.mode) return quota.mode;
  if (quota.windows.some((w) => w.remainingAmount !== undefined || w.totalAmount !== undefined)) {
    return 'credits';
  }
  return 'percent';
}

/** 积分模式下提取主积分账户（优先无标签总周期窗口）与附加资源包列表。 */
function resolveCreditSummary(windows: readonly QuotaWindowView[]): {
  readonly primary: QuotaWindowView;
  readonly packs: readonly QuotaWindowView[];
} {
  const primary = windows.find((w) => !w.label.trim()) ?? windows[0]!;
  return {
    primary,
    packs: windows.filter((w) => w !== primary),
  };
}

type WindowSection =
  | { readonly type: 'single'; readonly key: string; readonly window: QuotaWindowView }
  | {
      readonly type: 'pool';
      readonly key: string;
      readonly label: string;
      readonly windows: readonly QuotaWindowView[];
    };

/** Antigravity 的池标识（`gemini` / `3p`）翻译成展示名，其它标签（独立模型池名 / 模型名 / 包名）原样使用。 */
function poolName(label: string, t: ReturnType<typeof useT>): string {
  if (label === 'gemini') return t('usage.pool.gemini');
  if (label === '3p') return t('usage.pool.3p');
  return label;
}

function windowTitle(w: QuotaWindowView, t: ReturnType<typeof useT>): string {
  const pool = poolName(w.label, t);
  if (w.kind === 'cycle') return pool ? t('usage.cyclePool', pool) : t('usage.cycle');
  if (w.kind === 'session') return pool ? t('usage.sessionPool', pool) : t('usage.session');
  if (w.kind === 'weekly') return pool ? t('usage.weeklyPool', pool) : t('usage.weekly');
  return t('usage.weeklyModel', pool || t('usage.modelFallback'));
}

function resetLabel(resetsAt: number | undefined, t: ReturnType<typeof useT>): string | undefined {
  if (!resetsAt) return undefined;
  const diff = resetsAt - Date.now();
  if (diff <= 0) return t('usage.resetSoon');
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return t('usage.resetMinutes', minutes);
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return t('usage.resetHours', hours);
  return t('usage.resetDays', Math.round(diff / 86_400_000));
}

/** 把带池名的 5h/weekly 窗口按池聚合，保留首次出现顺序；无池名或周期/单模型窗口保持独立条目。 */
function buildSections(windows: readonly QuotaWindowView[]): readonly WindowSection[] {
  const order: Array<{ readonly type: 'single'; readonly key: string; readonly window: QuotaWindowView } | { readonly type: 'pool'; readonly label: string }> = [];
  const pools = new Map<string, QuotaWindowView[]>();
  for (const w of windows) {
    if ((w.kind === 'session' || w.kind === 'weekly') && w.label) {
      let group = pools.get(w.label);
      if (!group) {
        group = [];
        pools.set(w.label, group);
        order.push({ type: 'pool', label: w.label });
      }
      group.push(w);
    } else {
      order.push({ type: 'single', key: `${w.kind}:${w.label}`, window: w });
    }
  }
  return order.map((entry) => {
    if (entry.type === 'single') return entry;
    return {
      type: 'pool',
      key: `pool:${entry.label}`,
      label: entry.label,
      windows: pools.get(entry.label)!,
    };
  });
}

/** 双同心圆环几何参数（viewBox 20×20，外环每周、内环 5h）。 */
const RING_CENTER = 10;
const OUTER_RADIUS = 8.25;
const INNER_RADIUS = 4.65;
const RING_STROKE = 2.1;
const OUTER_CIRCUMFERENCE = 2 * Math.PI * OUTER_RADIUS;
const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_RADIUS;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function ringToneClass(remaining: number, normalClass: string): string {
  if (remaining <= 10) return 'text-red';
  if (remaining <= 30) return 'text-orange';
  return normalClass;
}

/**
 * 双圆环订阅用量可视化：外层展示周用量（或无周/5h 时回退周期用量），内层展示 5 小时用量。
 */
function DualUsageRing({
  outerPercent,
  innerPercent,
}: {
  readonly outerPercent?: number;
  readonly innerPercent?: number;
}) {
  const outer = outerPercent !== undefined ? clampPercent(outerPercent) : undefined;
  const inner = innerPercent !== undefined ? clampPercent(innerPercent) : undefined;

  return (
    <svg
      viewBox="0 0 20 20"
      className="size-[18px] shrink-0"
      aria-hidden="true"
      data-testid="usage-dual-ring"
    >
      {/* 外环轨道（周用量） */}
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={OUTER_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        className="text-ink-3/25"
      />
      {outer !== undefined ? (
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={OUTER_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeDasharray={OUTER_CIRCUMFERENCE}
          strokeDashoffset={OUTER_CIRCUMFERENCE * (1 - outer / 100)}
          strokeLinecap="round"
          strokeOpacity={outer > 0 ? 1 : 0}
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
          data-testid="usage-ring-outer"
          data-percent={Math.round(outer)}
          className={cn(
            'transition-[stroke-dashoffset,color] duration-500 ease-[var(--ease-out-strong)]',
            ringToneClass(outer, 'text-accent-ink'),
          )}
        />
      ) : null}

      {/* 内环轨道（5h 用量） */}
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={INNER_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        className="text-ink-3/25"
      />
      {inner !== undefined ? (
        <circle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={INNER_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeDasharray={INNER_CIRCUMFERENCE}
          strokeDashoffset={INNER_CIRCUMFERENCE * (1 - inner / 100)}
          strokeLinecap="round"
          strokeOpacity={inner > 0 ? 1 : 0}
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
          data-testid="usage-ring-inner"
          data-percent={Math.round(inner)}
          className={cn(
            'transition-[stroke-dashoffset,color] duration-500 ease-[var(--ease-out-strong)]',
            ringToneClass(inner, 'text-green'),
          )}
        />
      ) : null}
    </svg>
  );
}

/** 提取主窗口的最低剩余百分比，默认排除 Antigravity 3p 池以免掩盖主模型池剩余额度。 */
function minPrimaryRemaining(windows: readonly QuotaWindowView[]): number | undefined {
  if (windows.length === 0) return undefined;
  const non3p = windows.filter((w) => w.label.trim().toLowerCase() !== '3p');
  const pool = non3p.length > 0 ? non3p : windows;
  return pool.reduce((min, w) => Math.min(min, clampPercent(w.remainingPercent)), 100);
}

/** 宿主查不到额度时隐藏；查到后以外层周用量 + 内层 5h 用量双圆环渲染。 */
function resolveRingMetrics(windows: readonly QuotaWindowView[]): {
  readonly weeklyRemaining?: number;
  readonly sessionRemaining?: number;
  readonly fallbackRemaining?: number;
} {
  const sessionRemaining = minPrimaryRemaining(windows.filter((w) => w.kind === 'session'));
  const weeklyAll = windows.filter((w) => w.kind === 'weekly');
  const weeklyRemaining =
    minPrimaryRemaining(weeklyAll) ?? minPrimaryRemaining(windows.filter((w) => w.kind === 'weeklyModel'));
  const fallbackRemaining = minPrimaryRemaining(windows);
  return {
    ...(weeklyRemaining !== undefined ? { weeklyRemaining } : {}),
    ...(sessionRemaining !== undefined ? { sessionRemaining } : {}),
    ...(fallbackRemaining !== undefined ? { fallbackRemaining } : {}),
  };
}

function WindowBar({
  title,
  window: w,
  t,
}: {
  readonly title: string;
  readonly window: QuotaWindowView;
  readonly t: ReturnType<typeof useT>;
}) {
  const remaining = Math.min(100, Math.max(0, w.remainingPercent));
  const severity = w.severity ?? (remaining <= 10 ? 'critical' : remaining <= 30 ? 'warning' : 'normal');
  const barColor = severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-green';
  const reset = resetLabel(w.resetsAt, t);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2 text-[11.5px] leading-4">
        <span className="min-w-0 truncate text-ink-2">{title}</span>
        <AnimatedNumber
          value={remaining}
          format={(n) => t('usage.remaining', n)}
          className={cn(
            'shrink-0 font-mono transition-colors duration-300',
            severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-ink',
          )}
        />
      </div>
      <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-field shadow-hairline transition-colors duration-300', barColor)}>
        <div
          className="h-full rounded-full bg-current opacity-80 transition-[width] duration-500 ease-[var(--ease-out-strong)]"
          data-testid="usage-bar-fill"
          style={{ width: `${remaining}%` }}
        />
      </div>
      {reset ? <div className="text-[10.5px] leading-3.5 text-ink-3">{t('usage.resets', reset)}</div> : null}
    </div>
  );
}

/** 积分模式底栏 5 格能量条：每格按 20% 步进平滑填充高度与语义色，视觉上与百分比双圆环明显区分。 */
function CreditEnergyGauge({
  percent,
  level,
  className,
}: {
  readonly percent: number;
  readonly level: 'low' | 'medium' | 'high';
  readonly className?: string;
}) {
  const clamped = clampPercent(percent);
  const fillClass = level === 'high' ? 'bg-red' : level === 'medium' ? 'bg-orange' : 'bg-green';

  return (
    <span
      aria-hidden="true"
      data-testid="usage-credit-gauge"
      data-percent={Math.round(clamped)}
      className={cn('inline-flex items-end gap-[2px]', className)}
    >
      {[0, 1, 2, 3, 4].map((index) => {
        const cellFill = Math.round(Math.min(1, Math.max(0, (clamped - index * 20) / 20)) * 100);
        return (
          <span
            key={index}
            className="flex h-[10px] w-[3px] items-end overflow-hidden rounded-full bg-ink-3/20"
          >
            <span
              className={cn(
                'w-full rounded-full transition-[height,background-color] duration-500 ease-[var(--ease-out-strong)]',
                fillClass,
              )}
              style={{ height: `${cellFill}%` }}
            />
          </span>
        );
      })}
    </span>
  );
}

/** 积分模式浮层主卡：突出剩余积分数、总量对比、已用消耗与 5 段刻度进度条。 */
function CreditsHeroCard({
  window: w,
  t,
}: {
  readonly window: QuotaWindowView;
  readonly t: ReturnType<typeof useT>;
}) {
  const remaining = clampPercent(w.remainingPercent);
  const severity = w.severity ?? (remaining <= 10 ? 'critical' : remaining <= 30 ? 'warning' : 'normal');
  const unit = w.unit?.trim() || t('usage.credits.unit');
  const title = w.label.trim() ? poolName(w.label.trim(), t) : t('usage.credits.available');
  const reset = resetLabel(w.resetsAt, t);
  const barColor = severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-green';
  const pillClass =
    severity === 'critical'
      ? 'bg-red-tint text-red'
      : severity === 'warning'
        ? 'bg-orange-tint text-orange'
        : 'bg-green-tint text-green';
  const iconTone = severity === 'critical' ? 'text-red' : 'text-orange';
  const hasDecimals = w.remainingAmount !== undefined && !Number.isInteger(w.remainingAmount);

  return (
    <div
      data-testid="usage-credits-hero"
      className="flex flex-col gap-2 rounded-lg bg-field/65 px-2.5 py-2.5 ring-1 ring-inset ring-line/80"
    >
      <div className="flex items-center justify-between gap-2 text-[11px] leading-4">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-ink-2">
          <CoinsIcon className={cn('size-3.5 shrink-0', iconTone)} />
          <span className="truncate">{title}</span>
        </span>
        <AnimatedNumber
          value={remaining}
          className={cn('shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10.5px] leading-none font-medium', pillClass)}
        />
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1">
          {w.remainingAmount !== undefined ? (
            <>
              <AnimatedNumber
                value={w.remainingAmount}
                min={0}
                max={Number.POSITIVE_INFINITY}
                decimals={hasDecimals ? 1 : 0}
                format={(n) => formatCreditNumber(n)}
                className="font-mono text-[20px] font-semibold leading-6 tracking-tight text-ink"
              />
              <span className="truncate font-mono text-[11px] text-ink-3">
                {w.totalAmount !== undefined
                  ? `/ ${formatCreditNumber(w.totalAmount)} ${unit}`
                  : unit}
              </span>
            </>
          ) : (
            <AnimatedNumber
              value={remaining}
              className="font-mono text-[20px] font-semibold leading-6 tracking-tight text-ink"
            />
          )}
        </div>
        {w.usedAmount !== undefined ? (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-3 tabular-nums">
            {t('usage.credits.used', formatCreditNumber(w.usedAmount))}
          </span>
        ) : null}
      </div>

      <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-canvas/85 shadow-hairline transition-colors duration-300', barColor)}>
        <div
          className="h-full rounded-full bg-current opacity-85 transition-[width] duration-500 ease-[var(--ease-out-strong)]"
          data-testid="usage-bar-fill"
          style={{ width: `${remaining}%` }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-5">
          {[0, 1, 2, 3].map((idx) => (
            <span key={idx} className="border-r border-canvas/60" />
          ))}
        </div>
      </div>

      {reset ? <div className="text-[10.5px] leading-3.5 text-ink-3">{t('usage.resets', reset)}</div> : null}
    </div>
  );
}

/** 积分模式附加资源包行（如 CodeBuddy 的 Pro / Starter / Bonus 包）。 */
function CreditPackRow({
  window: w,
  t,
}: {
  readonly window: QuotaWindowView;
  readonly t: ReturnType<typeof useT>;
}) {
  const remaining = clampPercent(w.remainingPercent);
  const severity = w.severity ?? (remaining <= 10 ? 'critical' : remaining <= 30 ? 'warning' : 'normal');
  const barColor = severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-green';
  const unit = w.unit?.trim() || t('usage.credits.unit');
  const title = w.label.trim() ? poolName(w.label.trim(), t) : windowTitle(w, t);
  const reset = resetLabel(w.resetsAt, t);
  const hasDecimals = w.remainingAmount !== undefined && !Number.isInteger(w.remainingAmount);

  return (
    <div className="flex flex-col gap-0.5" data-testid={`usage-credit-pack-${w.label || w.kind}`}>
      <div className="flex items-baseline justify-between gap-2 text-[11.5px] leading-4">
        <span className="min-w-0 truncate text-ink-2">{title}</span>
        {w.remainingAmount !== undefined ? (
          <span
            className={cn(
              'inline-flex shrink-0 items-baseline gap-0.5 font-mono transition-colors duration-300',
              severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-ink',
            )}
          >
            <AnimatedNumber
              value={w.remainingAmount}
              min={0}
              max={Number.POSITIVE_INFINITY}
              decimals={hasDecimals ? 1 : 0}
              format={(n) => formatCreditNumber(n)}
            />
            <span className="text-[10.5px] text-ink-3">
              {w.totalAmount !== undefined ? `/ ${formatCreditNumber(w.totalAmount)} ${unit}` : unit}
            </span>
          </span>
        ) : (
          <AnimatedNumber
            value={remaining}
            format={(n) => t('usage.remaining', n)}
            className={cn(
              'shrink-0 font-mono transition-colors duration-300',
              severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-ink',
            )}
          />
        )}
      </div>
      <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-field shadow-hairline transition-colors duration-300', barColor)}>
        <div
          className="h-full rounded-full bg-current opacity-80 transition-[width] duration-500 ease-[var(--ease-out-strong)]"
          data-testid="usage-bar-fill"
          style={{ width: `${remaining}%` }}
        />
      </div>
      {reset ? <div className="text-[10.5px] leading-3.5 text-ink-3">{t('usage.resets', reset)}</div> : null}
    </div>
  );
}

/** 全局递增请求号：防止组件卸载重挂（如从设置页切完账号返回对话）时复用 requestId=1 撞上 store 里的旧结果。 */
let nextQuotaRequestId = 0;

function quotaScopeOf(state: ReturnType<typeof getState>): string {
  const active = state.backends.active ?? '';
  const activeBackend = state.backends.items.find((b) => b.id === active);
  const channel = active ? (state.accounts.channels[active] ?? activeBackend?.activeChannel) : undefined;
  if (channel?.mode === 'provider') {
    return `${active}|provider:${channel.providerId}`;
  }
  const accountId = channel?.accountId ?? (active ? `system:${active}` : '');
  return `${active}|official:${accountId}`;
}

function accountStatusOf(state: ReturnType<typeof getState>): string {
  const active = state.backends.active ?? '';
  if (!active) return '';
  const activeBackend = state.backends.items.find((b) => b.id === active);
  const channel = state.accounts.channels[active] ?? activeBackend?.activeChannel;
  if (channel?.mode === 'provider') return '';
  const accountId = channel?.accountId ?? `system:${active}`;
  return state.accounts.items.find((a) => a.id === accountId)?.status ?? '';
}

function supportsQuotaOf(state: ReturnType<typeof getState>): boolean {
  if (state.preferences.fetchQuota === false) return false;
  const active = state.backends.active;
  if (!active) return false;
  const activeBackend = state.backends.items.find((b) => b.id === active);
  if (!activeBackend) return false;
  const caps = activeBackend.capabilities ?? backendCapabilities(activeBackend);
  if (!caps.quota) return false;
  const channel = state.accounts.channels[active] ?? activeBackend.activeChannel;
  if (caps.quota !== 'antigravity' && channel?.mode === 'provider') return false;
  return true;
}

function activeAccountQuotaOf(state: ReturnType<typeof getState>): QuotaView | undefined {
  if (!supportsQuotaOf(state)) return undefined;
  const active = state.backends.active;
  if (!active) return undefined;
  const activeBackend = state.backends.items.find((b) => b.id === active);
  const channel = state.accounts.channels[active] ?? activeBackend?.activeChannel;
  if (channel?.mode === 'provider') return undefined;
  const accountId = channel?.accountId ?? `system:${active}`;
  const quota = state.accounts.items.find((a) => a.id === accountId)?.quota;
  return quota && quota.windows.length > 0 ? quota : undefined;
}

export function UsageBadge() {
  const t = useT();
  const active = useView((s) => s.backends.active);
  const quotaScope = useView(quotaScopeOf);
  const accountStatus = useView(accountStatusOf);
  const supportsQuota = useView(supportsQuotaOf);
  const activeAccountQuota = useView(activeAccountQuotaOf);
  const connected = useView((s) => s.connection === 'connected');
  const hasModels = useView((s) => s.models.options.length > 0);
  const running = useView((s) => s.session.running);
  const fetchResults = useView((s) => s.quotaFetchResults);
  const [quota, setQuota] = useState<QuotaView | undefined>(() => activeAccountQuotaOf(getState()));
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const quotaRef = useRef<QuotaView | undefined>(quota);
  const requestIdRef = useRef(0);
  const requestKeepOnErrorRef = useRef(false);
  const handledIdRef = useRef(0);
  const fetchedForScope = useRef<string | undefined>(undefined);
  const probeSent = useRef(false);
  const lastScope = useRef<string>(quotaScopeOf(getState()));
  const prevAccountStatusRef = useRef<string>(accountStatusOf(getState()));
  const scopeChangedAtRef = useRef(0);
  const needsReconnectRefreshRef = useRef(false);
  const inFlightRef = useRef(false);
  const prevSupportsQuotaRef = useRef(supportsQuota);
  const prevConnectedRef = useRef(connected);
  const prevHasModelsRef = useRef(hasModels);
  const prevRunningRef = useRef(running);
  const unavailableAtRef = useRef(0);
  const lastProbeAtRef = useRef(0);
  const retriedForScopeRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const requestQuota = (force = false, keepOnError = false) => {
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    const requestId = ++nextQuotaRequestId;
    requestIdRef.current = requestId;
    requestKeepOnErrorRef.current = keepOnError;
    fetchedForScope.current = quotaScopeOf(getState());
    lastProbeAtRef.current = Date.now();
    inFlightRef.current = true;
    postToHost({ type: 'fetchQuota', payload: force ? { requestId, force: true } : { requestId } });
  };

  useEffect(() => {
    if (!probeSent.current) {
      probeSent.current = true;
      if (supportsQuotaOf(getState())) {
        requestQuota();
      }
    }
    const maybeRefreshOnFocus = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const state = getState();
      if (!supportsQuotaOf(state) || state.connection !== 'connected') return;
      const now = Date.now();
      if (now - lastProbeAtRef.current < FOCUS_RETRY_COOLDOWN_MS) return;
      if (!quotaRef.current || now - quotaRef.current.queriedAt >= QUOTA_CACHE_MS) {
        setUnavailable(false);
        requestQuota();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeRefreshOnFocus();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', maybeRefreshOnFocus);
    }
    return () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      clearTimeout(retryTimerRef.current);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', maybeRefreshOnFocus);
      }
    };
  }, []);

  useEffect(() => {
    const prevScope = lastScope.current;
    const scopeChanged = prevScope !== quotaScope;
    const prevSupportsQuota = prevSupportsQuotaRef.current;
    const supportsQuotaChanged = prevSupportsQuota !== supportsQuota;
    const prevStatus = prevAccountStatusRef.current;
    const statusChanged = prevStatus !== accountStatus;
    const becameConnected = !prevConnectedRef.current && connected;
    const loadedModels = !prevHasModelsRef.current && hasModels;
    const finishedTurn = prevRunningRef.current && !running;
    prevSupportsQuotaRef.current = supportsQuota;
    prevConnectedRef.current = connected;
    prevHasModelsRef.current = hasModels;
    prevRunningRef.current = running;
    prevAccountStatusRef.current = accountStatus;

    // 切换底层、切换官方账号/服务商渠道后先清空旧额度，强制跳过宿主缓存重新探测。
    if (scopeChanged) {
      const wasEmptyScope = prevScope === '' || prevScope === '|official:';
      lastScope.current = quotaScope;
      scopeChangedAtRef.current = Date.now();
      needsReconnectRefreshRef.current = !wasEmptyScope;
      retriedForScopeRef.current = false;
      unavailableAtRef.current = 0;
      inFlightRef.current = false;
      quotaRef.current = undefined;
      setQuota(undefined);
      setUnavailable(false);
      if (supportsQuota) {
        requestQuota(!wasEmptyScope, false);
      } else {
        requestIdRef.current = 0;
      }
      return;
    }

    // 设置项「获取订阅用量」切换：关闭时立刻隐藏并中止后续探测；重新打开时立即探测一次。
    if (supportsQuotaChanged) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
      if (!supportsQuota) {
        inFlightRef.current = false;
        requestIdRef.current = 0;
        quotaRef.current = undefined;
        setQuota(undefined);
        setUnavailable(false);
        return;
      }
      retriedForScopeRef.current = false;
      unavailableAtRef.current = 0;
      setUnavailable(false);
      requestQuota(false, false);
      return;
    }

    // 同一底层同一账号仅状态变化：仅在明确退出/过期或从无效状态完成登录时联动，
    // 绝不因冷启动首次查到额度后的 unknown -> authenticated 广播清空当前额度或打断在途请求。
    if (statusChanged) {
      if (accountStatus === 'unauthenticated' || accountStatus === 'expired') {
        inFlightRef.current = false;
        quotaRef.current = undefined;
        setQuota(undefined);
        setUnavailable(true);
        return;
      }
      if (
        supportsQuota &&
        accountStatus === 'authenticated' &&
        (prevStatus === 'unauthenticated' || prevStatus === 'expired' || prevStatus === 'logging-in')
      ) {
        setUnavailable(false);
        if (!quotaRef.current && !inFlightRef.current) {
          requestQuota(true, false);
        }
        return;
      }
    }

    // 每轮对话结束后强制刷新一次最新额度（跳过宿主 5 分钟缓存），让余额进度条和数字实时更新。
    if (supportsQuota && finishedTurn) {
      setUnavailable(false);
      requestQuota(true, true);
      return;
    }

    // 切换账号或重启底层初期，旧 access_token 可能尚未被新进程刷新，首次探测会返回 unavailable；
    // 待底层重新连上或拉回模型列表后强制补查一次，确保展示新账号续期后的实时额度；
    // 冷启动首次探测仍在途时（inFlightRef.current === true）不作废在途请求。
    if (supportsQuota && (becameConnected || loadedModels)) {
      if (needsReconnectRefreshRef.current) {
        needsReconnectRefreshRef.current = false;
        setUnavailable(false);
        requestQuota(true, Boolean(quotaRef.current));
      } else if (!quotaRef.current && !inFlightRef.current) {
        setUnavailable(false);
        requestQuota(true, false);
      }
    }
  }, [quotaScope, accountStatus, active, connected, hasModels, running, supportsQuota]);

  // 若宿主已通过账号巡检 / 登录完成 / 其他视图刷新并广播了当前激活账号的额度，直接同步展示。
  useEffect(() => {
    if (!supportsQuota || !activeAccountQuota) return;
    if (activeAccountQuota.queriedAt <= scopeChangedAtRef.current) return;
    const current = quotaRef.current;
    const shouldAdopt = current
      ? activeAccountQuota.queriedAt > current.queriedAt
      : !unavailable || activeAccountQuota.queriedAt > unavailableAtRef.current;
    if (!shouldAdopt) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    inFlightRef.current = false;
    quotaRef.current = activeAccountQuota;
    fetchedForScope.current = quotaScope;
    setQuota(activeAccountQuota);
    setUnavailable(false);
  }, [activeAccountQuota, quotaScope, supportsQuota, unavailable]);

  useEffect(() => {
    const matched = fetchResults[requestIdRef.current];
    if (!matched || matched.requestId <= handledIdRef.current) return;
    handledIdRef.current = matched.requestId;
    inFlightRef.current = false;
    if (matched.quota && matched.quota.windows.length > 0) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
      quotaRef.current = matched.quota;
      setQuota(matched.quota);
      setUnavailable(false);
    } else {
      // 回合结束后的静默刷新若遇临时失败，保留上一次有效额度避免闪烁消失；切换账号触发的刷新绝不保留旧账号额度
      if (requestKeepOnErrorRef.current && quotaRef.current) {
        return;
      }
      quotaRef.current = undefined;
      unavailableAtRef.current = Date.now();
      setQuota(undefined);
      setUnavailable(true);
      if (supportsQuota && connected && !retriedForScopeRef.current) {
        retriedForScopeRef.current = true;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = undefined;
          if (!quotaRef.current && supportsQuotaOf(getState()) && getState().connection === 'connected') {
            setUnavailable(false);
            requestQuota(true, false);
          }
        }, TRANSIENT_RETRY_MS);
      }
    }
  }, [fetchResults, supportsQuota, connected]);

  // 宿主查不到额度、用户关闭用量获取、或查询期间用户切到了别的底层/账号：标识彻底消失。
  if (!supportsQuota || !quota || unavailable || (fetchedForScope.current !== undefined && fetchedForScope.current !== quotaScope)) return null;

  const quotaMode = resolveQuotaMode(quota);
  const isCreditsMode = quotaMode === 'credits';

  // 百分比模式：外环展示周用量（无周/5h 窗口时回退计费周期），内环展示 5 小时用量；数字优先展示 5 小时剩余百分比。
  const { weeklyRemaining, sessionRemaining, fallbackRemaining } = resolveRingMetrics(quota.windows);
  const outerPercent = weeklyRemaining ?? (sessionRemaining === undefined ? fallbackRemaining : undefined);
  const innerPercent = sessionRemaining;
  const percentPrimary = sessionRemaining ?? weeklyRemaining ?? fallbackRemaining ?? 0;

  // 积分模式：主账户余额 + 附加资源包明细
  const creditSummary = isCreditsMode ? resolveCreditSummary(quota.windows) : undefined;
  const creditPrimary = creditSummary?.primary;
  const creditRemainingPercent = creditPrimary ? clampPercent(creditPrimary.remainingPercent) : percentPrimary;
  const creditUnit = creditPrimary?.unit?.trim() || t('usage.credits.unit');

  const worstRemaining = isCreditsMode
    ? creditRemainingPercent
    : Math.min(outerPercent ?? 100, innerPercent ?? 100, percentPrimary);
  const level: 'low' | 'medium' | 'high' = worstRemaining <= 10 ? 'high' : worstRemaining <= 30 ? 'medium' : 'low';
  const hasBothRings = !isCreditsMode && weeklyRemaining !== undefined && sessionRemaining !== undefined;
  const badgeAriaLabel = isCreditsMode
    ? creditPrimary?.remainingAmount !== undefined
      ? creditPrimary.totalAmount !== undefined
        ? t(
            'usage.credits.badgeLabelRatio',
            formatCreditNumber(creditPrimary.remainingAmount),
            formatCreditNumber(creditPrimary.totalAmount),
            Math.round(creditRemainingPercent),
          )
        : t(
            'usage.credits.badgeLabel',
            formatCreditNumber(creditPrimary.remainingAmount),
            Math.round(creditRemainingPercent),
          )
      : t('usage.credits.badgeLabelPercent', Math.round(creditRemainingPercent))
    : hasBothRings
      ? t('usage.badgeLabelDual', Math.round(weeklyRemaining), Math.round(sessionRemaining))
      : t('usage.badgeLabel', Math.round(percentPrimary));
  const sections = isCreditsMode ? [] : buildSections(quota.windows);
  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const enter = () => {
    clearTimeout(closeTimer.current);
    // 缓存没过期时直接用宿主侧缓存；悬浮只读，不制造额外请求。
    if (supportsQuotaOf(getState()) && Date.now() - quota.queriedAt >= QUOTA_CACHE_MS) requestQuota();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const leave = () => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { clearTimers(); setOpen(next); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={badgeAriaLabel}
          title={badgeAriaLabel}
          data-quota-mode={quotaMode}
          className={cn(
            'usage-badge gap-1.5 font-medium tabular-nums',
            isCreditsMode
              ? cn(
                  'rounded-full px-2 ring-1 ring-inset transition-colors',
                  level === 'high'
                    ? 'bg-red-tint/45 text-red ring-red/30 hover:bg-red-tint/70'
                    : level === 'medium'
                      ? 'bg-orange-tint/45 text-orange ring-orange/30 hover:bg-orange-tint/70'
                      : 'bg-field/75 text-ink-2 ring-line-strong/50 hover:bg-hover hover:text-ink',
                )
              : cn(
                  'hover:bg-hover',
                  level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-ink-2 hover:text-ink',
                ),
          )}
          data-testid="usage-badge"
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          {isCreditsMode ? (
            <>
              <CoinsIcon
                className={cn('size-3.5 shrink-0', level === 'high' ? 'text-red' : 'text-orange')}
              />
              {creditPrimary?.remainingAmount !== undefined ? (
                <AnimatedNumber
                  value={creditPrimary.remainingAmount}
                  min={0}
                  max={Number.POSITIVE_INFINITY}
                  decimals={Number.isInteger(creditPrimary.remainingAmount) ? 0 : 1}
                  format={(n) => `${formatCreditNumber(n, true)} ${creditUnit}`}
                />
              ) : (
                <AnimatedNumber value={creditRemainingPercent} />
              )}
              <CreditEnergyGauge percent={creditRemainingPercent} level={level} className="max-md:hidden" />
            </>
          ) : (
            <>
              <DualUsageRing
                {...(outerPercent !== undefined ? { outerPercent } : {})}
                {...(innerPercent !== undefined ? { innerPercent } : {})}
              />
              <AnimatedNumber value={percentPrimary} />
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        aria-label={isCreditsMode ? t('usage.credits.title') : t('usage.title')}
        className="w-72 overflow-hidden rounded-card p-0 shadow-raised"
        data-testid="usage-popover"
        data-quota-mode={quotaMode}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
        onPointerLeave={leave}
      >
        <ScrollArea className="max-h-[calc(var(--radix-popover-content-available-height)-8px)]">
          <div className="flex flex-col gap-2 px-3 py-2.5">
          {isCreditsMode && creditPrimary ? (
            <>
              <div className="text-[12px] font-semibold leading-4 text-ink">{t('usage.credits.title')}</div>
              <CreditsHeroCard window={creditPrimary} t={t} />
              {creditSummary && creditSummary.packs.length > 0 ? (
                <section className="flex flex-col gap-1.5 border-t border-line pt-2">
                  <div className="text-[11px] font-medium leading-3.5 text-ink-3">{t('usage.credits.packs')}</div>
                  {creditSummary.packs.map((pack, index) => (
                    <CreditPackRow key={`${pack.kind}:${pack.label}:${index}`} window={pack} t={t} />
                  ))}
                </section>
              ) : null}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <div className="text-[12px] font-semibold leading-4 text-ink">{t('usage.title')}</div>
                {hasBothRings ? (
                  <div className="flex items-center gap-3 text-[10.5px] leading-3.5 text-ink-3" data-testid="usage-ring-legend">
                    <span className="inline-flex items-center gap-1">
                      <span aria-hidden className="size-1.5 rounded-full bg-accent-ink" />
                      <span>{t('usage.ringLegendOuter')}</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span aria-hidden className="size-1.5 rounded-full bg-green" />
                      <span>{t('usage.ringLegendInner')}</span>
                    </span>
                  </div>
                ) : null}
              </div>
              {sections.map((section, index) => {
                if (section.type === 'single') {
                  return (
                    <section key={section.key}>
                      <WindowBar title={windowTitle(section.window, t)} window={section.window} t={t} />
                    </section>
                  );
                }
                return (
                  <section
                    key={section.key}
                    className={cn('flex flex-col gap-1', index > 0 && 'border-t border-line pt-1.5')}
                  >
                    <div className="text-[11.5px] font-medium leading-4 text-ink">{poolName(section.label, t)}</div>
                    {section.windows.map((w) => (
                      <WindowBar
                        key={`${w.kind}:${w.label}`}
                        title={w.kind === 'session' ? t('usage.session') : t('usage.weekly')}
                        window={w}
                        t={t}
                      />
                    ))}
                  </section>
                );
              })}
            </>
          )}
          {quota.extraUsage ? (
            <div className="flex items-center justify-between border-t border-line pt-2 text-[11.5px] leading-4">
              <span className="text-ink-3">{t('usage.extra')}</span>
              <AnimatedNumber
                value={quota.extraUsage.remainingPercent}
                format={(n) => t('usage.remaining', n)}
                className="font-mono text-ink"
              />
            </div>
          ) : null}
          <div className="text-[11px] leading-4 text-ink-3">
            {t('usage.updated', new Date(quota.queriedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
          </div>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

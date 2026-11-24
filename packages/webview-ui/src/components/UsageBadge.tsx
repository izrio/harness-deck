/**
 * 上下文环旁的官方订阅用量标识：只有宿主查到官方订阅额度时才渲染。
 * 挂载时探测一次；悬浮时复用 5 分钟缓存刷新并展开 Popover，按模型池/窗口展示剩余额度与重置时间。
 */
import { useEffect, useRef, useState } from 'react';
import { backendCapabilities, type QuotaView, type QuotaWindowView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '../lib/utils.ts';
import { getState, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { useT } from '../i18n.ts';

/** 与宿主的额度缓存同频，缓存有效期内悬浮不再重复请求。 */
const QUOTA_CACHE_MS = 300_000;
const OPEN_DELAY = 250;
const CLOSE_DELAY = 250;

type WindowSection =
  | { readonly type: 'single'; readonly key: string; readonly window: QuotaWindowView }
  | {
      readonly type: 'pool';
      readonly key: string;
      readonly label: string;
      readonly models?: readonly string[];
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
  const pools = new Map<string, { models?: readonly string[]; windows: QuotaWindowView[] }>();
  for (const w of windows) {
    if ((w.kind === 'session' || w.kind === 'weekly') && w.label) {
      let group = pools.get(w.label);
      if (!group) {
        group = { ...(w.models?.length ? { models: w.models } : {}), windows: [] };
        pools.set(w.label, group);
        order.push({ type: 'pool', label: w.label });
      } else if (!group.models && w.models?.length) {
        group.models = w.models;
      }
      group.windows.push(w);
    } else {
      order.push({ type: 'single', key: `${w.kind}:${w.label}`, window: w });
    }
  }
  return order.map((entry) => {
    if (entry.type === 'single') return entry;
    const group = pools.get(entry.label)!;
    return {
      type: 'pool',
      key: `pool:${entry.label}`,
      label: entry.label,
      ...(group.models ? { models: group.models } : {}),
      windows: group.windows,
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
            'transition-[stroke-dashoffset] duration-300 ease-out',
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
            'transition-[stroke-dashoffset] duration-300 ease-out',
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
        <span
          className={cn(
            'shrink-0 font-mono tabular-nums',
            severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-ink',
          )}
        >
          {t('usage.remaining', Math.round(remaining))}
        </span>
      </div>
      <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-field shadow-hairline', barColor)}>
        <div
          className="h-full rounded-full bg-current opacity-80"
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
  const accountStatus = accountId ? (state.accounts.items.find((a) => a.id === accountId)?.status ?? '') : '';
  return `${active}|official:${accountId}|${accountStatus}`;
}

function supportsQuotaOf(state: ReturnType<typeof getState>): boolean {
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

export function UsageBadge() {
  const t = useT();
  const active = useView((s) => s.backends.active);
  const quotaScope = useView(quotaScopeOf);
  const supportsQuota = useView(supportsQuotaOf);
  const connected = useView((s) => s.connection === 'connected');
  const hasModels = useView((s) => s.models.options.length > 0);
  const running = useView((s) => s.session.running);
  const result = useView((s) => s.quotaFetchResult);
  const [quota, setQuota] = useState<QuotaView | undefined>();
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const quotaRef = useRef<QuotaView | undefined>(undefined);
  const requestIdRef = useRef(0);
  const handledIdRef = useRef(0);
  const fetchedForScope = useRef<string | undefined>(undefined);
  const probeSent = useRef(false);
  const lastScope = useRef<string>(quotaScopeOf(getState()));
  const prevConnectedRef = useRef(connected);
  const prevHasModelsRef = useRef(hasModels);
  const prevRunningRef = useRef(running);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const requestQuota = () => {
    const requestId = ++nextQuotaRequestId;
    requestIdRef.current = requestId;
    fetchedForScope.current = quotaScopeOf(getState());
    postToHost({ type: 'fetchQuota', payload: { requestId } });
  };

  useEffect(() => {
    if (!probeSent.current) {
      probeSent.current = true;
      requestQuota();
    }
    return () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    const scopeChanged = lastScope.current !== quotaScope;
    const becameConnected = !prevConnectedRef.current && connected;
    const loadedModels = !prevHasModelsRef.current && hasModels;
    const finishedTurn = prevRunningRef.current && !running;
    prevConnectedRef.current = connected;
    prevHasModelsRef.current = hasModels;
    prevRunningRef.current = running;

    // 切换底层、切换官方账号/服务商渠道或登录态变化后先隐藏旧额度，再立即为新作用域重新探测。
    if (scopeChanged) {
      lastScope.current = quotaScope;
      quotaRef.current = undefined;
      setQuota(undefined);
      setUnavailable(false);
      requestQuota();
      return;
    }

    // 切换账号或重启底层初期，旧 access_token 可能尚未被新进程刷新，首次探测会返回 unavailable；
    // 待底层重新连上、拉回模型列表或完成一轮对话（CLI 自动续期落盘）后自动补查一次。
    if (supportsQuota && !quotaRef.current && (becameConnected || loadedModels || finishedTurn)) {
      setUnavailable(false);
      requestQuota();
    }
  }, [quotaScope, active, connected, hasModels, running, supportsQuota]);

  useEffect(() => {
    if (!result || result.requestId !== requestIdRef.current || result.requestId <= handledIdRef.current) return;
    handledIdRef.current = result.requestId;
    if (result.quota && result.quota.windows.length > 0) {
      quotaRef.current = result.quota;
      setQuota(result.quota);
      setUnavailable(false);
    } else {
      quotaRef.current = undefined;
      setQuota(undefined);
      setUnavailable(true);
    }
  }, [result]);

  // 宿主查不到额度、或查询期间用户切到了别的底层/账号：标识彻底消失。
  if (!quota || unavailable || (fetchedForScope.current !== undefined && fetchedForScope.current !== quotaScope)) return null;

  // 外环展示周用量（无周/5h 窗口时回退计费周期），内环展示 5 小时用量；数字优先展示 5 小时剩余百分比。
  const { weeklyRemaining, sessionRemaining, fallbackRemaining } = resolveRingMetrics(quota.windows);
  const outerPercent = weeklyRemaining ?? (sessionRemaining === undefined ? fallbackRemaining : undefined);
  const innerPercent = sessionRemaining;
  const primaryRemaining = sessionRemaining ?? weeklyRemaining ?? fallbackRemaining ?? 0;
  const worstRemaining = Math.min(
    outerPercent ?? 100,
    innerPercent ?? 100,
    primaryRemaining,
  );
  const level = worstRemaining <= 10 ? 'high' : worstRemaining <= 30 ? 'medium' : 'low';
  const hasBothRings = weeklyRemaining !== undefined && sessionRemaining !== undefined;
  const badgeAriaLabel = hasBothRings
    ? t('usage.badgeLabelDual', Math.round(weeklyRemaining), Math.round(sessionRemaining))
    : t('usage.badgeLabel', Math.round(primaryRemaining));
  const sections = buildSections(quota.windows);
  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const enter = () => {
    clearTimeout(closeTimer.current);
    // 缓存没过期时直接用宿主侧缓存；悬浮只读，不制造额外请求。
    if (Date.now() - quota.queriedAt >= QUOTA_CACHE_MS) requestQuota();
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
          className={cn(
            'usage-badge gap-1.5 font-medium tabular-nums hover:bg-hover',
            level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-ink-2 hover:text-ink',
          )}
          data-testid="usage-badge"
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          <DualUsageRing
            {...(outerPercent !== undefined ? { outerPercent } : {})}
            {...(innerPercent !== undefined ? { innerPercent } : {})}
          />
          <span>{Math.round(primaryRemaining)}%</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        aria-label={t('usage.title')}
        className="max-h-[calc(var(--radix-popover-content-available-height)-8px)] w-72 overflow-y-auto rounded-card p-0 shadow-raised"
        data-testid="usage-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
        onPointerLeave={leave}
      >
        <div className="flex flex-col gap-2 px-3 py-2.5">
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
                <div className="flex flex-col gap-0.5">
                  <div className="text-[11.5px] font-medium leading-4 text-ink">{poolName(section.label, t)}</div>
                  {section.models?.length ? (
                    <div className="text-[10.5px] leading-3.5 text-ink-3">{section.models.join(' · ')}</div>
                  ) : null}
                </div>
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
          {quota.extraUsage ? (
            <div className="flex items-center justify-between border-t border-line pt-2 text-[11.5px] leading-4">
              <span className="text-ink-3">{t('usage.extra')}</span>
              <span className="font-mono tabular-nums text-ink">
                {t('usage.remaining', Math.round(quota.extraUsage.remainingPercent))}
              </span>
            </div>
          ) : null}
          <div className="text-[11px] leading-4 text-ink-3">
            {t('usage.updated', new Date(quota.queriedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

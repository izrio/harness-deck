/**
 * 上下文环旁的官方订阅用量标识：只有宿主查到官方订阅额度时才渲染。
 * 挂载时探测一次；悬浮时复用 5 分钟缓存刷新并展开 Popover，按模型池/窗口展示剩余额度与重置时间。
 */
import { useEffect, useRef, useState } from 'react';
import type { QuotaView, QuotaWindowView } from '@harness-deck/shared';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '../lib/utils.ts';
import { getState, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { useT } from '../i18n.ts';
import { GaugeIcon } from './icons.tsx';

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

export function UsageBadge() {
  const t = useT();
  const active = useView((s) => s.backends.active);
  const result = useView((s) => s.quotaFetchResult);
  const [quota, setQuota] = useState<QuotaView | undefined>();
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const requestIdRef = useRef(0);
  const handledIdRef = useRef(0);
  const fetchedForBackend = useRef<string | undefined>(undefined);
  const probeSent = useRef(false);
  const lastActive = useRef<string | undefined>(getState().backends.active);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const requestQuota = () => {
    const requestId = ++requestIdRef.current;
    fetchedForBackend.current = getState().backends.active;
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
    // 切换底层后先隐藏旧额度，再为新底层重新探测（例如从 dsh 切回 Claude）。
    if (lastActive.current !== active) {
      lastActive.current = active;
      setQuota(undefined);
      setUnavailable(false);
      requestQuota();
    }
  }, [active]);

  useEffect(() => {
    if (!result || result.requestId !== requestIdRef.current || result.requestId <= handledIdRef.current) return;
    handledIdRef.current = result.requestId;
    if (result.quota && result.quota.windows.length > 0) {
      setQuota(result.quota);
      setUnavailable(false);
    } else {
      setQuota(undefined);
      setUnavailable(true);
    }
  }, [result]);

  // 宿主查不到额度、或查询期间用户切到了别的底层：标识彻底消失。
  if (!quota || unavailable || (fetchedForBackend.current !== undefined && fetchedForBackend.current !== active)) return null;

  const lowestRemaining = quota.windows.reduce((min, w) => Math.min(min, w.remainingPercent), 100);
  const level = lowestRemaining <= 10 ? 'high' : lowestRemaining <= 30 ? 'medium' : 'low';
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
        <button
          type="button"
          aria-label={t('usage.badgeLabel', Math.round(lowestRemaining))}
          title={t('usage.title')}
          className={cn(
            'usage-badge inline-flex h-7 items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium tabular-nums transition-colors duration-150 hover:bg-hover',
            level === 'high' ? 'text-red' : level === 'medium' ? 'text-orange' : 'text-ink-2',
          )}
          data-testid="usage-badge"
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{Math.round(lowestRemaining)}%</span>
        </button>
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
          <div className="text-[12px] font-semibold leading-4 text-ink">{t('usage.title')}</div>
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

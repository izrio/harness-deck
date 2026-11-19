/**
 * 上下文环旁的官方订阅用量标识：只有宿主查到 Claude 官方 OAuth 额度时才渲染。
 * 挂载时探测一次；悬浮时复用 5 分钟缓存刷新并展开 Popover，展示已用 / 剩余 / 重置时间。
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

/** Antigravity 的池标识（`gemini` / `3p`）翻译成展示名，其它标签（模型名 / 包名）原样使用。 */
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

  const tightest = quota.windows.reduce((max, w) => Math.max(max, w.usedPercent), 0);
  const level = tightest >= 90 ? 'high' : tightest >= 70 ? 'medium' : 'low';
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
          aria-label={t('usage.badgeLabel', Math.round(tightest))}
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
          <span>{Math.round(tightest)}%</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        aria-label={t('usage.title')}
        className="w-60 rounded-card p-0 shadow-raised"
        data-testid="usage-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
        onPointerLeave={leave}
      >
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <div className="text-[12px] font-semibold leading-4 text-ink">{t('usage.title')}</div>
          {quota.windows.map((w) => {
            const severity = w.severity ?? (w.usedPercent >= 90 ? 'critical' : w.usedPercent >= 70 ? 'warning' : 'normal');
            const barColor = severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-ink-3';
            const reset = resetLabel(w.resetsAt, t);
            return (
              <section key={`${w.kind}:${w.label}`} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-[11.5px] leading-4">
                  <span className="min-w-0 truncate text-ink-2">{windowTitle(w, t)}</span>
                  <span
                    className={cn(
                      'shrink-0 font-mono tabular-nums',
                      severity === 'critical' ? 'text-red' : severity === 'warning' ? 'text-orange' : 'text-ink',
                    )}
                  >
                    {t('usage.used', Math.round(w.usedPercent))} · {t('usage.remaining', Math.round(w.remainingPercent))}
                  </span>
                </div>
                <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-field shadow-hairline', barColor)}>
                  <div className="h-full rounded-full bg-current opacity-70" style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />
                </div>
                {reset ? <div className="text-[11px] leading-4 text-ink-3">{t('usage.resets', reset)}</div> : null}
              </section>
            );
          })}
          {quota.extraUsage ? (
            <div className="flex items-center justify-between border-t border-line pt-2 text-[11.5px] leading-4">
              <span className="text-ink-3">{t('usage.extra')}</span>
              <span className="font-mono tabular-nums text-ink">
                {t('usage.used', Math.round(quota.extraUsage.usedPercent))} · {t('usage.remaining', Math.round(quota.extraUsage.remainingPercent))}
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

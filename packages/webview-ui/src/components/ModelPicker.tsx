/**
 * 模型选择（上方列表选模型 + 下方滑块调思考等级）。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ModelOption } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu } from './beautifului/index.ts';
import { CheckIcon, ChevronDownIcon, SparkleIcon, SpinnerIcon } from './icons.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT } from '../i18n.ts';

const keyOf = (o: { provider: string; model: string }) => `${o.provider}/${o.model}`;

export function ModelPicker({ disabled }: { disabled: boolean }) {
  const models = useView((s) => s.models);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const t = useT();
  const current = models.current;
  const option = models.options.find((o) => o.provider === current?.provider && o.model === current?.model);
  const effort = option?.efforts.find((e) => e.id === current?.reasoningEffort);
  const connected = useView((s) => s.connection === 'connected');
  const loading = (!connected || models.options.length === 0) && !models.needsApiKey;
  const label = option
    ? `${option.name}${effort && option.efforts.length > 1 ? ` · ${effort.name}` : ''}`
    : loading
      ? t('model.loading')
      : (current?.model ?? t('model.default'));

  const select = useCallback(
    (o: ModelOption, reasoningEffort?: string, shouldClose = false) => {
      if (shouldClose) close();
      postToHost({
        type: 'selectModel',
        payload: { provider: o.provider, model: o.model, ...(reasoningEffort ? { reasoningEffort } : {}) },
      });
    },
    [close],
  );

  const isCurrent = (o: ModelOption) => o.provider === current?.provider && o.model === current?.model;
  const groups = [...new Set(models.options.map((o) => o.group))];
  const showEfforts = Boolean(option && option.efforts.length > 1);

  return (
    <div className="model-picker relative min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="toolbar-button inline-flex h-7 max-w-full items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-55"
            disabled={disabled || models.options.length === 0}
            title={t('model.switch')}
            data-testid="model-picker"
          >
            {loading && !option ? <SpinnerIcon className="size-3.5 shrink-0 text-ink-3" /> : <SparkleIcon className="size-3.5 shrink-0 text-ink-3" />}
            <span className="toolbar-button__text min-w-0 truncate">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          aria-label={t('model.select')}
          className="model-menu flex max-h-96 w-auto min-w-[260px] max-w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-card p-0 shadow-raised"
        >
          <div role="menu" className="model-menu__level max-h-60 overflow-y-auto p-1" data-testid="model-list">
            <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {groups.map((group) => (
                <div key={group} className="model-menu__group">
                  {groups.length > 1 ? <div className="menu-heading px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-ink-3">{group}</div> : null}
                  {models.options
                    .filter((o) => o.group === group)
                    .map((o) => {
                      const active = isCurrent(o);
                      const currentEffort = active ? o.efforts.find((e) => e.id === current?.reasoningEffort) : undefined;
                      const nextEffort =
                        (current?.reasoningEffort && o.efforts.some((e) => e.id === current.reasoningEffort)
                          ? current.reasoningEffort
                          : undefined) ??
                        o.defaultEffort ??
                        o.efforts[0]?.id;
                      return (
                        <ModelItem
                          key={keyOf(o)}
                          active={active}
                          {...(o.description ? { title: o.description } : {})}
                          {...(active && o.efforts.length > 1 && currentEffort ? { hint: currentEffort.name } : {})}
                          onSelect={() => select(o, nextEffort, o.efforts.length <= 1)}
                        >
                          {o.name}
                        </ModelItem>
                      );
                    })}
                </div>
              ))}
            </GlideMenu>
          </div>

          {showEfforts && option ? (
            <EffortSlider
              option={option}
              currentEffortId={current?.reasoningEffort ?? option.defaultEffort ?? option.efforts[0]!.id}
              onSelectEffort={(effortId) => select(option, effortId, false)}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function EffortSlider({
  option,
  currentEffortId,
  onSelectEffort,
}: {
  option: ModelOption;
  currentEffortId: string;
  onSelectEffort: (effortId: string) => void;
}) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | undefined>();
  const efforts = option.efforts;
  const resolvedIndex = Math.max(
    0,
    efforts.findIndex((e) => e.id === currentEffortId),
  );
  const displayIndex = dragIndex ?? resolvedIndex;
  const displayEffort = efforts[displayIndex] ?? efforts[0]!;
  const maxIdx = Math.max(1, efforts.length - 1);
  const ratio = displayIndex / maxIdx;
  const fillWidth =
    displayIndex <= 0 ? '0%' : displayIndex >= maxIdx ? '100%' : `calc(14px + (100% - 28px) * ${ratio})`;

  useEffect(() => {
    setDragIndex(undefined);
  }, [option.provider, option.model, currentEffortId]);

  const indexForClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 28) return resolvedIndex;
    const norm = Math.min(1, Math.max(0, (clientX - rect.left - 14) / (rect.width - 28)));
    return Math.round(norm * maxIdx);
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;
    const startedOnButton = event.target instanceof Element && Boolean(event.target.closest('button'));
    const startX = event.clientX;
    let moved = false;
    let latest = startedOnButton ? resolvedIndex : indexForClientX(event.clientX);
    if (!startedOnButton) setDragIndex(latest);

    if (typeof track.setPointerCapture === 'function') {
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        // 忽略测试环境或不支持指针捕获时的异常
      }
    }

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) >= 3) moved = true;
      if (!moved && startedOnButton) return;
      latest = indexForClientX(moveEvent.clientX);
      setDragIndex(latest);
    };

    const onEnd = () => {
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onEnd);
      track.removeEventListener('pointercancel', onEnd);
      setDragIndex(undefined);
      if (moved || !startedOnButton) {
        const picked = efforts[latest];
        if (picked && picked.id !== currentEffortId) {
          onSelectEffort(picked.id);
        }
      }
    };

    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onEnd);
    track.addEventListener('pointercancel', onEnd);
  };

  return (
    <div
      role="group"
      aria-label={t('model.effort')}
      className="model-menu__efforts border-t border-line bg-inset/45 px-3 pt-2.5 pb-3"
      data-testid="effort-menu"
    >
      <div className="flex flex-col items-center text-center leading-tight">
        <span className="text-[13px] font-semibold text-accent-ink" data-testid="effort-active-label">
          {displayEffort.name}
        </span>
        <span className="mt-0.5 text-[11px] text-ink-3">{t('model.effort')}</span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        className="relative mt-2.5 h-7 w-full cursor-pointer overflow-hidden rounded-full bg-field shadow-inset-field select-none touch-none"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150 ease-out"
          style={{ width: fillWidth }}
        />
        {efforts.map((e, i) => {
          const active = i === displayIndex;
          const filled = i < displayIndex;
          const left = `calc(14px + (100% - 28px) * ${i / maxIdx})`;
          return (
            <button
              key={e.id}
              type="button"
              tabIndex={-1}
              aria-label={e.name}
              onClick={() => onSelectEffort(e.id)}
              style={{ left }}
              className="absolute top-1/2 z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
            >
              {active ? (
                <span className="size-5 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-150" />
              ) : (
                <span className={cn('size-1.5 rounded-full transition-colors duration-150', filled ? 'bg-white/70' : 'bg-ink-3/50')} />
              )}
            </button>
          );
        })}
      </div>

      <div role="menu" className="mt-2 grid gap-1" style={{ gridTemplateColumns: `repeat(${efforts.length}, minmax(0, 1fr))` }}>
        {efforts.map((e) => {
          const active = e.id === displayEffort.id;
          return (
            <button
              key={e.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              onClick={() => onSelectEffort(e.id)}
              title={e.id === option.defaultEffort ? `${e.name} (${t('model.defaultEffort')})` : e.name}
              className={cn(
                'model-effort-option flex h-6 min-w-0 items-center justify-center rounded-[6px] px-1 text-[11px] transition-colors duration-100',
                active
                  ? 'menu-item--active bg-accent-tint font-medium text-accent-ink'
                  : 'text-ink-3 hover:bg-hover hover:text-ink',
              )}
            >
              <span className="menu-item__label truncate">{e.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelItem({
  active,
  hint,
  title,
  onSelect,
  children,
}: {
  active: boolean;
  hint?: string;
  title?: string;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      data-menu-row
      role="menuitemradio"
      aria-checked={active}
      className={cn(
        'menu-item model-item relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[12.5px] transition-colors duration-100',
        active ? 'menu-item--active bg-field font-medium text-ink group-hover/glide-menu:bg-transparent' : 'text-ink-2 hover:text-ink',
      )}
      onClick={onSelect}
      title={title ?? children}
    >
      <span className="model-item__check inline-flex w-3.5 shrink-0 text-ink">{active ? <CheckIcon className="size-3.5" strokeWidth={2.2} /> : null}</span>
      <span className="menu-item__label min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className={cn('menu-item__hint shrink-0 font-mono text-[11px]', active ? 'text-ink-2' : 'text-ink-3')}>{hint}</span> : null}
    </button>
  );
}

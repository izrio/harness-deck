/**
 * 模型选择（上方列表选模型 + 下方滑块调思考等级）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { backendCapabilities, isProviderReadyForBackend, type ModelOption } from '@harness-deck/shared';
import { openSettingsPage, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu } from './beautifului/index.ts';
import { CheckIcon, ChevronDownIcon, KeyIcon, RouteIcon, SettingsIcon, SpinnerIcon, UsersIcon } from './icons.tsx';
import { ModelVendorLogo } from './ModelVendorLogo.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useT } from '../i18n.ts';

const keyOf = (o: { provider: string; model: string }) => `${o.provider}/${o.model}`;

export interface ModelPickerSelection {
  readonly provider?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface ModelPickerProps {
  readonly disabled: boolean;
  /** 受控模式：用于新建任务等独立场景，选中后回传而非直接修改当前会话模型。 */
  readonly value?: ModelPickerSelection | undefined;
  readonly options?: readonly ModelOption[];
  readonly onSelect?: (selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }) => void;
  readonly hideChannelSwitcher?: boolean;
  readonly loading?: boolean;
  readonly placeholder?: string;
  readonly testId?: string;
}

export function ModelPicker({
  disabled,
  value,
  options: controlledOptions,
  onSelect: onControlledSelect,
  hideChannelSwitcher = false,
  loading: controlledLoading = false,
  placeholder,
  testId = 'model-picker',
}: ModelPickerProps) {
  const storeModels = useView((s) => s.models);
  const backends = useView((s) => s.backends);
  const providers = useView((s) => s.providers);
  const accounts = useView((s) => s.accounts);
  const [open, setOpen] = useState(false);
  const [channelExpanded, setChannelExpanded] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    setChannelExpanded(false);
  }, []);
  const t = useT();
  const isControlled = onControlledSelect !== undefined;
  const options = controlledOptions ?? storeModels.options;
  const current = isControlled ? value : storeModels.current;
  const option = options.find((o) =>
    current
      ? (current.provider ? o.provider === current.provider : true) && o.model === current.model
      : false,
  );
  const effort = option?.efforts.find((e) => e.id === current?.reasoningEffort);
  const connected = useView((s) => s.connection === 'connected');
  const loading = isControlled
    ? controlledLoading && options.length === 0
    : (!connected || options.length === 0) && !storeModels.needsApiKey;
  const label = option
    ? `${option.name}${effort && option.efforts.length > 1 ? ` · ${effort.name}` : ''}`
    : loading
      ? t('model.loading')
      : (current?.model ?? placeholder ?? t('model.default'));

  const activeBackend = useMemo(
    () => backends.items.find((b) => b.id === backends.active),
    [backends.items, backends.active],
  );
  const activeChannel = activeBackend ? (accounts.channels[activeBackend.id] ?? activeBackend.activeChannel) : undefined;
  const backendAccounts = useMemo(
    () => (activeBackend ? accounts.items.filter((a) => a.backendId === activeBackend.id) : []),
    [accounts.items, activeBackend],
  );
  const compatibleProviders = useMemo(() => {
    if (!activeBackend) return [];
    const caps = activeBackend.capabilities ?? backendCapabilities(activeBackend);
    if (caps.protocols.kind !== 'supported') return [];
    return providers.items.filter((p) =>
      isProviderReadyForBackend(p, activeBackend, { protocolGatewayEnabled: providers.protocolGatewayEnabled === true }),
    );
  }, [activeBackend, providers.items, providers.protocolGatewayEnabled]);

  const channelSummary = useMemo(() => {
    if (!activeBackend) return undefined;
    if (activeChannel?.mode === 'provider') {
      const p = providers.items.find((item) => item.id === activeChannel.providerId);
      return p ? t('model.channel.provider', p.name) : undefined;
    }
    const targetAccId = activeChannel?.accountId ?? `system:${activeBackend.id}`;
    const acc = backendAccounts.find((a) => a.id === targetAccId);
    return acc ? t('model.channel.official', acc.label) : undefined;
  }, [activeBackend, activeChannel, providers.items, backendAccounts, t]);

  const showChannelSwitcher =
    !hideChannelSwitcher &&
    !isControlled &&
    Boolean(activeBackend && (backendAccounts.length > 0 || compatibleProviders.length > 0));

  const select = useCallback(
    (o: ModelOption, reasoningEffort?: string, shouldClose = false) => {
      if (shouldClose) close();
      if (onControlledSelect) {
        onControlledSelect({
          provider: o.provider,
          model: o.model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        });
        return;
      }
      postToHost({
        type: 'selectModel',
        payload: { provider: o.provider, model: o.model, ...(reasoningEffort ? { reasoningEffort } : {}) },
      });
    },
    [close, onControlledSelect],
  );

  const isCurrent = (o: ModelOption) =>
    Boolean(current && (current.provider ? o.provider === current.provider : true) && o.model === current.model);
  const groups = [...new Set(options.map((o) => o.group))];
  const showEfforts = Boolean(option && option.efforts.length > 1);

  return (
    <div className="model-picker relative min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="toolbar-button inline-flex h-7 max-w-full items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-55"
            disabled={disabled || options.length === 0}
            title={t('model.switch')}
            data-testid={testId}
          >
            {loading && !option ? (
              <SpinnerIcon className="size-3.5 shrink-0 text-ink-3" />
            ) : (
              <ModelVendorLogo
                provider={option?.provider ?? current?.provider}
                model={option?.model ?? current?.model}
                name={option?.name}
                group={option?.group}
                className="size-3.5 shrink-0"
              />
            )}
            <span className="toolbar-button__text min-w-0 truncate">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          aria-label={t('model.select')}
          className="model-menu flex max-h-96 w-auto min-w-[260px] max-w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl p-0 shadow-overlay"
        >
          {showChannelSwitcher && activeBackend ? (
            <div className="border-b border-line px-2 py-1.5" data-testid="model-channel-switcher">
              <button
                type="button"
                data-testid="model-channel-toggle"
                onClick={() => setChannelExpanded((v) => !v)}
                className="flex w-full items-center justify-between gap-2 rounded-[6px] px-1.5 py-1 text-left text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              >
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  {!channelSummary ? (
                    <RouteIcon className="size-3.5 shrink-0 text-ink-3" />
                  ) : activeChannel?.mode === 'provider' ? (
                    <KeyIcon className="size-3 shrink-0 text-ink-3" />
                  ) : (
                    <UsersIcon className="size-3 shrink-0 text-ink-3" />
                  )}
                  <span className="truncate">{channelSummary ?? t('model.channel.label')}</span>
                </span>
                <ChevronDownIcon
                  className={cn('size-3 shrink-0 text-ink-3 transition-transform duration-150', channelExpanded && 'rotate-180')}
                />
              </button>

              {channelExpanded ? (
                <div className="mt-1 flex flex-col gap-0.5 border-t border-line/70 pt-1" data-testid="model-channel-options">
                  {backendAccounts.length > 0 ? (
                    <>
                      <div className="px-1.5 pt-0.5 text-[10.5px] font-medium text-ink-3">
                        {t('model.channel.officialGroup')}
                      </div>
                      {backendAccounts.map((acc) => {
                        const isCur =
                          (activeChannel?.mode ?? 'official') === 'official' &&
                          (activeChannel?.mode === 'official' ? (activeChannel.accountId ?? `system:${activeBackend.id}`) : `system:${activeBackend.id}`) === acc.id;
                        return (
                          <div
                            key={acc.id}
                            className="group/channel flex w-full items-center gap-0.5 rounded-[6px] transition-colors hover:bg-hover"
                          >
                            <button
                              type="button"
                              data-testid={`quick-channel-official-${acc.id}`}
                              onClick={() => {
                                postToHost({
                                  type: 'setBackendChannel',
                                  payload: { backendId: activeBackend.id, mode: 'official', accountId: acc.id },
                                });
                                close();
                              }}
                              className={cn(
                                'flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[12px]',
                                isCur ? 'font-medium text-ink' : 'text-ink-2',
                              )}
                            >
                              <span
                                data-testid={`quick-channel-official-dot-${acc.id}`}
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  isCur ? 'bg-green' : 'bg-ink-3/45',
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">{acc.label}</span>
                            </button>
                            <div className="flex shrink-0 items-center pr-0.5 opacity-0 transition-opacity duration-100 group-focus-within/channel:opacity-100 group-hover/channel:opacity-100">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                data-testid={`quick-channel-official-manage-${acc.id}`}
                                aria-label={t('model.channel.manageAccounts')}
                                title={t('model.channel.manageAccounts')}
                                className="text-ink-3 hover:bg-hover-2 hover:text-ink"
                                onClick={() => {
                                  close();
                                  openSettingsPage('accounts');
                                }}
                              >
                                <SettingsIcon className="size-3" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  ) : null}

                  {compatibleProviders.length > 0 ? (
                    <>
                      <div className="px-1.5 pt-1 text-[10.5px] font-medium text-ink-3">
                        {t('model.channel.providerGroup')}
                      </div>
                      {compatibleProviders.map((p) => {
                        const isCur = activeChannel?.mode === 'provider' && activeChannel.providerId === p.id;
                        return (
                          <div
                            key={p.id}
                            className="group/channel flex w-full items-center gap-0.5 rounded-[6px] transition-colors hover:bg-hover"
                          >
                            <button
                              type="button"
                              data-testid={`quick-channel-provider-${p.id}`}
                              onClick={() => {
                                postToHost({
                                  type: 'setBackendChannel',
                                  payload: { backendId: activeBackend.id, mode: 'provider', providerId: p.id },
                                });
                                close();
                              }}
                              className={cn(
                                'flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[12px]',
                                isCur ? 'font-medium text-ink' : 'text-ink-2',
                              )}
                            >
                              <span
                                data-testid={`quick-channel-provider-dot-${p.id}`}
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  isCur ? 'bg-green' : 'bg-ink-3/45',
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            </button>
                            <div className="flex shrink-0 items-center pr-0.5 opacity-0 transition-opacity duration-100 group-focus-within/channel:opacity-100 group-hover/channel:opacity-100">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                data-testid={`quick-channel-provider-manage-${p.id}`}
                                aria-label={t('model.channel.manageProviders')}
                                title={t('model.channel.manageProviders')}
                                className="text-ink-3 hover:bg-hover-2 hover:text-ink"
                                onClick={() => {
                                  close();
                                  openSettingsPage('providers');
                                }}
                              >
                                <SettingsIcon className="size-3" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div role="menu" className="model-menu__level max-h-60 overflow-y-auto p-1" data-testid="model-list">
            <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {groups.map((group) => (
                <div key={group} className="model-menu__group">
                  {groups.length > 1 ? <div className="menu-heading px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-ink-3">{group}</div> : null}
                  {options
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
                          icon={<ModelVendorLogo provider={o.provider} model={o.model} name={o.name} group={o.group} className="size-3.5 shrink-0" />}
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
    displayIndex <= 0 ? '0%' : displayIndex >= maxIdx ? '100%' : `calc(7px + (100% - 14px) * ${ratio})`;

  useEffect(() => {
    setDragIndex(undefined);
  }, [option.provider, option.model, currentEffortId]);

  const indexForClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 14) return resolvedIndex;
    const norm = Math.min(1, Math.max(0, (clientX - rect.left - 7) / (rect.width - 14)));
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
      className="model-menu__efforts border-t border-line px-3 pt-2 pb-2.5"
      data-testid="effort-menu"
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-ink-3">{t('model.effort')}</span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        className="relative mt-2 flex h-5 w-full cursor-pointer items-center select-none touch-none"
      >
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-field shadow-inset-field">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-accent-ink/80 transition-[width] duration-150 ease-out"
            style={{ width: fillWidth }}
          />
        </div>
        {efforts.map((e, i) => {
          const active = i === displayIndex;
          const filled = i < displayIndex;
          const left = `calc(7px + (100% - 14px) * ${i / maxIdx})`;
          return (
            <button
              key={e.id}
              type="button"
              tabIndex={-1}
              aria-label={e.name}
              onClick={() => onSelectEffort(e.id)}
              style={{ left }}
              className="absolute top-1/2 z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
            >
              {active ? (
                <span className="size-3.5 rounded-full bg-brand-foreground shadow-xs ring-1 ring-line-strong transition-transform duration-150" />
              ) : (
                <span className={cn('size-1 rounded-full transition-colors duration-150', filled ? 'bg-brand-foreground/85' : 'bg-ink-3/45')} />
              )}
            </button>
          );
        })}
      </div>

      <div role="menu" className="mt-1.5 grid gap-1" style={{ gridTemplateColumns: `repeat(${efforts.length}, minmax(0, 1fr))` }}>
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
                  ? 'menu-item--active bg-field font-medium text-ink'
                  : 'text-ink-3 hover:bg-hover hover:text-ink',
              )}
            >
              <span className="menu-item__label truncate" data-testid={active ? 'effort-active-label' : undefined}>
                {e.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelItem({
  active,
  icon,
  hint,
  title,
  onSelect,
  children,
}: {
  active: boolean;
  icon?: ReactNode;
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
      {icon ? <span className="model-item__vendor inline-flex shrink-0 items-center">{icon}</span> : null}
      <span className="menu-item__label min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className={cn('menu-item__hint shrink-0 font-mono text-[11px]', active ? 'text-ink-2' : 'text-ink-3')}>{hint}</span> : null}
    </button>
  );
}

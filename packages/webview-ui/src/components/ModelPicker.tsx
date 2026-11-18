/**
 * 模型选择（Beautiful UI GlideMenu 级联浮层）：按提供方分组，多推理强度模型支持二级选择。
 */
import { useCallback, useState } from 'react';
import type { ModelOption } from '@harness-deck/shared';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu } from './ui/GlideMenu.tsx';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SparkleIcon, SpinnerIcon } from './icons.tsx';
import { Popover } from './Popover.tsx';
import { useT } from '../i18n.ts';

const keyOf = (o: { provider: string; model: string }) => `${o.provider}/${o.model}`;

export function ModelPicker({ disabled }: { disabled: boolean }) {
  const models = useView((s) => s.models);
  const [open, setOpen] = useState(false);
  const [drill, setDrill] = useState<string | undefined>();
  const close = useCallback(() => {
    setOpen(false);
    setDrill(undefined);
  }, []);
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

  const select = (o: ModelOption, reasoningEffort?: string) => {
    close();
    postToHost({
      type: 'selectModel',
      payload: { provider: o.provider, model: o.model, ...(reasoningEffort ? { reasoningEffort } : {}) },
    });
  };

  const isCurrent = (o: ModelOption) => o.provider === current?.provider && o.model === current?.model;
  const drilled = drill ? models.options.find((o) => keyOf(o) === drill) : undefined;
  const groups = [...new Set(models.options.map((o) => o.group))];

  return (
    <div className="model-picker relative min-w-0">
      <button
        type="button"
        className="toolbar-button inline-flex h-7 max-w-full items-center gap-1 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-55"
        disabled={disabled || models.options.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title={t('model.switch')}
        data-testid="model-picker"
      >
        {loading && !option ? <SpinnerIcon className="size-3.5 shrink-0 text-ink-3" /> : <SparkleIcon className="size-3.5 shrink-0 text-ink-3" />}
        <span className="toolbar-button__text min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
      </button>
      <Popover open={open} onClose={close} className="model-menu top-auto bottom-[calc(100%+6px)] left-0 max-h-80 min-w-[230px] overflow-y-auto" label={t('model.select')}>
        {drilled ? (
          <div role="menu" key="efforts" className="model-menu__level" data-testid="effort-menu">
            <button
              type="button"
              className="model-menu__back mb-1 flex w-full items-center gap-1.5 rounded-t-[6px] border-b border-line px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
              autoFocus
              onClick={() => setDrill(undefined)}
              aria-label={t('model.back')}
            >
              <ChevronRightIcon className="model-menu__back-icon size-3.5 shrink-0 rotate-180 text-ink-3" />
              <span className="model-menu__back-name min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{drilled.name}</span>
              <span className="model-menu__back-hint shrink-0 text-[11px] text-ink-3">{t('model.effort')}</span>
            </button>
            <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {drilled.efforts.map((e) => {
                const active = isCurrent(drilled) && e.id === current?.reasoningEffort;
                return (
                  <ModelItem key={e.id} active={active} onSelect={() => select(drilled, e.id)} {...(e.id === drilled.defaultEffort ? { hint: t('model.defaultEffort') } : {})}>
                    {e.name}
                  </ModelItem>
                );
              })}
            </GlideMenu>
          </div>
        ) : (
          <div role="menu" key="models" className="model-menu__level">
            <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {groups.map((group) => (
                <div key={group} className="model-menu__group">
                  {groups.length > 1 ? <div className="menu-heading px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-ink-3">{group}</div> : null}
                  {models.options
                    .filter((o) => o.group === group)
                    .map((o) => {
                      const cascade = o.efforts.length > 1;
                      const active = isCurrent(o);
                      const currentEffort = active ? o.efforts.find((e) => e.id === current?.reasoningEffort) : undefined;
                      return (
                        <ModelItem
                          key={keyOf(o)}
                          active={active}
                          cascade={cascade}
                          {...(o.description ? { title: o.description } : {})}
                          {...(cascade && currentEffort ? { hint: currentEffort.name } : {})}
                          onSelect={() => (cascade ? setDrill(keyOf(o)) : select(o, o.efforts[0]?.id))}
                        >
                          {o.name}
                        </ModelItem>
                      );
                    })}
                </div>
              ))}
            </GlideMenu>
          </div>
        )}
      </Popover>
    </div>
  );
}

function ModelItem({
  active,
  cascade,
  hint,
  title,
  onSelect,
  children,
}: {
  active: boolean;
  cascade?: boolean;
  hint?: string;
  title?: string;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      data-menu-row
      role={cascade ? 'menuitem' : 'menuitemradio'}
      aria-checked={cascade ? undefined : active}
      aria-haspopup={cascade ? 'menu' : undefined}
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
      {cascade ? <ChevronRightIcon className="model-item__arrow size-3.5 shrink-0 text-ink-3" /> : null}
    </button>
  );
}

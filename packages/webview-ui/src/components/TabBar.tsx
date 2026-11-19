/**
 * 会话标签栏（对齐 Beautiful UI ChatComposer 顶部标签切换条：`bg-field` 选中块 + `opacity-50` 未选中项）。
 */
import { useEffect, useRef } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { BackendLogo } from './BackendLogo.tsx';
import { CloseIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

export function TabBar() {
  const tabs = useView((s) => s.tabs);
  const backends = useView((s) => s.backends);
  const strip = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.tab--active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.active, tabs.items.length]);

  if (tabs.items.length < 2) return null;
  const close = (key: string) => postToHost({ type: 'closeTab', payload: { key } });
  return (
    <div
      className="tabs flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-2 py-1"
      role="tablist"
      aria-label={t('tabs.label')}
      ref={strip}
      data-testid="tabs"
    >
      {tabs.items.map((tab) => {
        const active = tab.key === tabs.active;
        const backendId = tab.backendId ?? backends.active;
        const backendName = tab.backendName ?? backends.items.find((item) => item.id === backendId)?.name ?? backendId;
        const backend = backendId ? { id: backendId, name: backendName || backendId } : undefined;
        return (
          <div
            key={tab.key}
            className={cn(
              'tab group/tab relative flex min-w-[72px] max-w-[184px] flex-none items-center gap-1.5 rounded-[6px] py-[3px] pr-1 pl-2 text-[12.5px] select-none transition-[background-color,opacity] duration-100',
              active
                ? 'tab--active cursor-default bg-field font-medium text-ink opacity-100'
                : 'cursor-pointer text-ink opacity-55 hover:bg-hover hover:opacity-85',
            )}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-backend-id={backendId}
            title={backend?.name ? `${backend.name} · ${tab.title}` : tab.title}
            onClick={() => !active && postToHost({ type: 'activateTab', payload: { key: tab.key } })}
            onAuxClick={(event) => {
              if (event.button === 1) close(tab.key);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const index = tabs.items.findIndex((item) => item.key === tab.key);
                const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : tabs.items.length - 1)) % tabs.items.length;
                const next = tabs.items[nextIndex];
                if (next) {
                  postToHost({ type: 'activateTab', payload: { key: next.key } });
                  strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus();
                }
              } else if (event.key === 'Delete') close(tab.key);
            }}
          >
            {tab.needsAttention ? (
              <span className="dot dot--attention inline-block size-1.5 shrink-0 rounded-full bg-orange" aria-label={t('tabs.attention')} />
            ) : tab.running ? (
              <span className="dot dot--running inline-block size-1.5 shrink-0 rounded-full bg-brand" style={{ animation: 'pulse 1.4s ease-in-out infinite' }} aria-label={t('header.running')} />
            ) : null}
            {backend ? <BackendLogo backend={backend} size="sm" /> : null}
            <span className="tab__title min-w-0 flex-1 truncate">{tab.title}</span>
            <button
              type="button"
              className={cn(
                'tab__close inline-flex size-4.5 shrink-0 items-center justify-center rounded-[4px] text-ink-3 transition-[opacity,background-color,color] duration-100 hover:bg-hover-2 hover:text-ink',
                active ? 'opacity-80 hover:opacity-100' : 'opacity-0 group-hover/tab:opacity-100 group-focus-visible/tab:opacity-100',
              )}
              tabIndex={-1}
              aria-label={t('tabs.close', tab.title)}
              title={t('tabs.closeTitle')}
              onClick={(event) => {
                event.stopPropagation();
                close(tab.key);
              }}
            >
              <CloseIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

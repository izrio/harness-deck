/**
 * 会话标签栏（对齐 Beautiful UI ChatComposer 顶部标签切换条：`bg-field` 选中块 + `opacity-50` 未选中项）。
 * 支持拖动排序与右键菜单（关闭当前 / 其他 / 左侧 / 右侧 / 全部）。
 */
import { useEffect, useRef, useState } from 'react';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { BackendLogo } from './BackendLogo.tsx';
import { CloseIcon } from './icons.tsx';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu.tsx';
import { useT } from '../i18n.ts';

type CloseScope = 'others' | 'left' | 'right' | 'all';

/** 光标在标签中心线左侧表示插到它前面，右侧表示插到它后面。 */
function dropIndexAt(clientX: number, strip: HTMLElement | null): number {
  const elements = strip?.querySelectorAll<HTMLElement>('[role="tab"]');
  if (!elements) return 0;
  for (let i = 0; i < elements.length; i++) {
    const rect = elements[i]!.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return elements.length;
}

export function TabBar() {
  const tabs = useView((s) => s.tabs);
  const backends = useView((s) => s.backends);
  const strip = useRef<HTMLDivElement>(null);
  /** 正在拖动的标签 key 与当前落点（0..items.length）。 */
  const [drag, setDrag] = useState<{ key: string; at: number } | null>(null);
  const t = useT();

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.tab--active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.active, tabs.items.length]);

  if (tabs.items.length < 2) return null;
  const close = (key: string) => postToHost({ type: 'closeTab', payload: { key } });
  const closeMany = (key: string, scope: CloseScope) => postToHost({ type: 'closeTabs', payload: { key, scope } });

  const endDrag = () => setDrag(null);

  return (
    <div
      className="tabs flex shrink-0 touch-pan-x items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-2 py-1"
      role="tablist"
      aria-label={t('tabs.label')}
      ref={strip}
      data-testid="tabs"
      onDragOver={(event) => {
        if (!drag) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setDrag({ ...drag, at: dropIndexAt(event.clientX, strip.current) });
      }}
      onDrop={(event) => {
        event.preventDefault();
        const key = drag?.key ?? '';
        const from = tabs.items.findIndex((item) => item.key === key);
        const at = drag?.at;
        endDrag();
        if (from < 0 || at === undefined || at < 0) return;
        // 落点是在原位置之后时，移除自身后目标下标要减一
        const toIndex = from < at ? at - 1 : at;
        if (toIndex !== from && toIndex < tabs.items.length) postToHost({ type: 'moveTab', payload: { key, toIndex } });
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (drag) setDrag({ ...drag, at: -1 });
      }}
    >
      {tabs.items.map((tab, index) => {
        const active = tab.key === tabs.active;
        const backendId = tab.backendId ?? backends.active;
        const backendName = tab.backendName ?? backends.items.find((item) => item.id === backendId)?.name ?? backendId;
        const backend = backendId ? { id: backendId, name: backendName || backendId } : undefined;
        const dragging = drag?.key === tab.key;
        const showDropBefore = drag !== null && !dragging && drag.at === index;
        const showDropAfter = drag !== null && !dragging && drag.at === index + 1 && index === tabs.items.length - 1;
        return (
          <ContextMenu key={tab.key}>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  'tab group/tab relative flex min-w-[72px] max-w-[184px] flex-none items-center gap-1.5 rounded-[6px] py-[3px] pr-1 pl-2 text-[12.5px] select-none transition-[background-color,opacity] duration-100 max-md:min-h-11',
                  active
                    ? 'tab--active cursor-default bg-field font-medium text-ink opacity-100'
                    : 'cursor-pointer text-ink opacity-55 hover:bg-hover hover:opacity-85',
                  dragging && 'opacity-40',
                )}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable
                data-backend-id={backendId}
                title={backend?.name ? `${backend.name} · ${tab.title}` : tab.title}
                onClick={() => !active && postToHost({ type: 'activateTab', payload: { key: tab.key } })}
                onAuxClick={(event) => {
                  if (event.button === 1) close(tab.key);
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', tab.key);
                  setDrag({ key: tab.key, at: index });
                }}
                onDragEnd={endDrag}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : tabs.items.length - 1)) % tabs.items.length;
                    const next = tabs.items[nextIndex];
                    if (next) {
                      postToHost({ type: 'activateTab', payload: { key: next.key } });
                      strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus();
                    }
                  } else if (event.key === 'Delete') close(tab.key);
                }}
              >
                {showDropBefore ? (
                  <span className="pointer-events-none absolute inset-y-1 -left-[3px] w-0.5 rounded-full bg-brand" aria-hidden="true" />
                ) : null}
                {showDropAfter ? (
                  <span className="pointer-events-none absolute inset-y-1 -right-[3px] w-0.5 rounded-full bg-brand" aria-hidden="true" />
                ) : null}
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
                  draggable={false}
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
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-44">
              <ContextMenuItem onSelect={() => close(tab.key)}>{t('tabs.closeMenu')}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={index === 0} onSelect={() => closeMany(tab.key, 'left')}>
                {t('tabs.closeLeft')}
              </ContextMenuItem>
              <ContextMenuItem disabled={index === tabs.items.length - 1} onSelect={() => closeMany(tab.key, 'right')}>
                {t('tabs.closeRight')}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => closeMany(tab.key, 'others')}>{t('tabs.closeOthers')}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => closeMany(tab.key, 'all')}>{t('tabs.closeAll')}</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}

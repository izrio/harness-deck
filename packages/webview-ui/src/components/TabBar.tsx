/**
 * 会话标签栏（对齐 Beautiful UI ChatComposer 顶部标签切换条：`bg-field` 选中块 + `opacity-50` 未选中项）。
 * 支持横向滚轮/触控板滑动、溢出左右滚动按钮与边缘渐变、拖动排序与右键菜单（关闭当前 / 其他 / 左侧 / 右侧 / 全部）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { setActiveModule, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { BackendLogo } from './BackendLogo.tsx';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, GitBranchIcon, PlusIcon } from './icons.tsx';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu.tsx';
import { useT } from '../i18n.ts';

type CloseScope = 'others' | 'left' | 'right' | 'all';

const DRAG_EDGE_PX = 28;
const DRAG_SCROLL_STEP_PX = 14;

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
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);
  const remoteReadOnly = clientSurface === 'mobile-web' && clientScope === 'read-only';
  const strip = useRef<HTMLDivElement>(null);
  /** 正在拖动的标签 key 与当前落点（0..items.length）。 */
  const [drag, setDrag] = useState<{ key: string; at: number } | null>(null);
  const [scrollState, setScrollState] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const t = useT();

  const updateScrollState = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const hasOverflow = el.scrollWidth - el.clientWidth > 1;
    const left = hasOverflow && el.scrollLeft > 1;
    const right = hasOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setScrollState((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  const scrollByDirection = useCallback(
    (direction: -1 | 1) => {
      const el = strip.current;
      if (!el) return;
      const step = Math.max(120, Math.round(el.clientWidth * 0.65));
      const delta = direction * step;
      if (typeof el.scrollBy === 'function') {
        el.scrollBy({ left: delta, behavior: 'smooth' });
      } else {
        el.scrollLeft += delta;
      }
      updateScrollState();
    },
    [updateScrollState],
  );

  // 监听原生非被动 wheel 事件：桌面鼠标垂直滚轮自动转为横向滚动，触控板双指横向滑动保持原生平滑体验
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && event.deltaY !== 0) {
        event.preventDefault();
        const factor = event.deltaMode === 1 ? 28 : event.deltaMode === 2 ? Math.max(120, el.clientWidth * 0.8) : 1;
        el.scrollLeft += event.deltaY * factor;
        updateScrollState();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateScrollState);
      observer.observe(el);
    }
    updateScrollState();
    return () => {
      el.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [tabs.items.length, updateScrollState]);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.tab--active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateScrollState();
  }, [tabs.active, tabs.items, updateScrollState]);

  if (tabs.items.length === 0) return null;
  const close = (key: string) => postToHost({ type: 'closeTab', payload: { key } });
  const closeMany = (key: string, scope: CloseScope) => postToHost({ type: 'closeTabs', payload: { key, scope } });

  const endDrag = () => setDrag(null);
  const showScrollControls = scrollState.left || scrollState.right;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-canvas px-2 py-1 max-md:px-1.5 max-md:py-0.5">
      {showScrollControls ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="tabbar-scroll-left-btn"
          disabled={!scrollState.left}
          aria-label={t('tabs.scrollLeft')}
          title={t('tabs.scrollLeft')}
          className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
          onClick={() => scrollByDirection(-1)}
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
      ) : null}
      <div className="relative flex min-w-0 flex-1 items-center overflow-hidden">
        {scrollState.left ? (
          <span
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-canvas to-transparent"
            aria-hidden="true"
          />
        ) : null}
        <div
          className="tabs flex min-w-0 flex-1 touch-pan-x overscroll-x-contain items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label={t('tabs.label')}
          ref={strip}
          data-testid="tabs"
          onScroll={updateScrollState}
          onDragOver={(event) => {
            if (!drag) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const el = strip.current;
            if (el && el.scrollWidth > el.clientWidth + 1) {
              const rect = el.getBoundingClientRect();
              if (event.clientX - rect.left < DRAG_EDGE_PX) {
                el.scrollLeft -= DRAG_SCROLL_STEP_PX;
                updateScrollState();
              } else if (rect.right - event.clientX < DRAG_EDGE_PX) {
                el.scrollLeft += DRAG_SCROLL_STEP_PX;
                updateScrollState();
              }
            }
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
                      'tab group/tab relative flex h-7 min-w-[72px] max-w-[184px] flex-none items-center gap-1.5 rounded-[7px] pr-1.5 pl-2.5 text-[12.5px] leading-4 select-none transition-[background-color,color,opacity] duration-100 max-md:min-h-7 max-md:min-w-[56px] max-md:max-w-[140px] max-md:gap-1 max-md:pr-1 max-md:pl-2 max-md:text-[12px]',
                      active
                        ? 'tab--active cursor-default bg-surface font-medium text-ink shadow-hairline dark:bg-field'
                        : 'cursor-pointer text-ink-2 hover:bg-hover hover:text-ink',
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
                    <span className="tab__title min-w-0 flex-1 truncate leading-4">{tab.title}</span>
                    {tab.worktreeBranch ? (
                      <span
                        className="hidden shrink-0 items-center gap-0.5 rounded bg-accent-tint px-1.5 py-0.5 font-mono text-[10px] leading-none text-accent-ink sm:inline-flex"
                        title={tab.worktreePath ?? tab.worktreeBranch}
                        data-testid="tab-worktree-badge"
                      >
                        <GitBranchIcon className="size-2.5 shrink-0" />
                        <span className="max-w-16 truncate">{tab.worktreeBranch}</span>
                      </span>
                    ) : null}
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
        {scrollState.right ? (
          <span
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 bg-gradient-to-l from-canvas to-transparent"
            aria-hidden="true"
          />
        ) : null}
      </div>
      {showScrollControls ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="tabbar-scroll-right-btn"
          disabled={!scrollState.right}
          aria-label={t('tabs.scrollRight')}
          title={t('tabs.scrollRight')}
          className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
          onClick={() => scrollByDirection(1)}
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="tabbar-new-session-btn"
        disabled={remoteReadOnly}
        aria-label={t('header.new')}
        title={t('header.newTab')}
        className="shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
        onClick={() => {
          setActiveModule('sessions');
          postToHost({ type: 'newSession', payload: {} });
        }}
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}

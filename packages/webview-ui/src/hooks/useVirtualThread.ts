/**
 * 对话流虚拟滚动与顶部无限加载 Hook：
 * - 仅挂载可视视口 + 上下 overscan 内的消息节点，使用 paddingTop/paddingBottom 撑起总高度；
 * - 实时用 ResizeObserver + layout 同步测量动态条目高度（流式输出、代码高亮、图片、展开抽屉）；
 * - 向上滚动接近顶部（或内容不足一屏）时自动触发 loadOlder，无须点击按钮，并精确锚定视口位置；
 * - 贴底状态下跟随新消息与高度增长；上翻阅读时保持视口稳定并提示未读新内容。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ThreadRow } from '../threadRows.ts';
import {
  BUTTON_THRESHOLD,
  DEFAULT_VIEWPORT_HEIGHT,
  LOAD_OLDER_THRESHOLD,
  MIN_OVERSCAN_COUNT,
  OVERSCAN_PX,
  STICK_THRESHOLD,
  THREAD_GAP,
  computeVirtualLayout,
  computeVisibleRange,
  detectPrependAnchor,
  type VirtualLayout,
  type VisibleRange,
} from './virtualThreadMath.ts';

const MAX_CACHED_SESSIONS = 10;
const HEIGHT_EPSILON = 0.5;
const LOAD_OLDER_ERROR_GRACE_MS = 1_500;
const LOAD_OLDER_ERROR_COOLDOWN_MS = 2_000;
const LOAD_OLDER_SAFETY_TIMEOUT_MS = 5_000;
const SMOOTH_SCROLL_SETTLE_MS = 650;

interface CommittedSnapshot {
  readonly sessionKey: string;
  readonly rows: readonly ThreadRow[];
  readonly layout: VirtualLayout;
  readonly listOffsetTop: number;
}

export interface UseVirtualThreadOptions {
  readonly rows: readonly ThreadRow[];
  readonly expandedRowIds: ReadonlySet<string>;
  readonly sessionKey: string;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly interactionsCount: number;
  readonly appearanceKey: string;
  readonly onLoadOlder: () => void;
}

export interface UseVirtualThreadResult {
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>;
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly footerRef: React.RefObject<HTMLDivElement | null>;
  readonly range: VisibleRange;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly totalHeight: number;
  readonly farFromBottom: boolean;
  readonly unseen: boolean;
  readonly showLoadingOlder: boolean;
  readonly registerRow: (id: string, el: HTMLDivElement | null) => void;
  readonly toBottom: () => void;
}

function getOrCreateHeightMap(cache: Map<string, Map<string, number>>, sessionKey: string): Map<string, number> {
  const existing = cache.get(sessionKey);
  if (existing) {
    // 刷新 LRU 顺序
    cache.delete(sessionKey);
    cache.set(sessionKey, existing);
    return existing;
  }
  const created = new Map<string, number>();
  cache.set(sessionKey, created);
  if (cache.size > MAX_CACHED_SESSIONS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return created;
}

export function useVirtualThread({
  rows,
  expandedRowIds,
  sessionKey,
  hasOlder,
  loadingOlder,
  interactionsCount,
  appearanceKey,
  onLoadOlder,
}: UseVirtualThreadOptions): UseVirtualThreadResult {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  const heightCacheRef = useRef(new Map<string, Map<string, number>>());
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  const itemObserverRef = useRef<ResizeObserver | null>(null);

  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [listOffsetTop, setListOffsetTop] = useState(0);
  const [anchorScrollTop, setAnchorScrollTop] = useState(0);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [localLoadingOlder, setLocalLoadingOlder] = useState(false);

  const stickRef = useRef(true);
  const scrollingToBottomRef = useRef(false);
  const smoothScrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewportHeightRef = useRef(DEFAULT_VIEWPORT_HEIGHT);
  const lastClientWidthRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const listOffsetTopRef = useRef(0);

  const loadOlderPendingRef = useRef(false);
  const requestedOldestIdRef = useRef<string | undefined>(undefined);
  const loadOlderCooldownUntilRef = useRef(0);
  const loadOlderTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevLoadingOlderRef = useRef(loadingOlder);

  const prevCommitRef = useRef<CommittedSnapshot | undefined>(undefined);
  const prevAppearanceKeyRef = useRef(appearanceKey);
  const prevRowShapeRef = useRef<{ sessionKey: string; shapes: Map<string, string> }>({
    sessionKey,
    shapes: new Map(),
  });

  // 最新 props/状态镜像给事件回调与 ResizeObserver 使用
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const loadingOlderRef = useRef(loadingOlder);
  loadingOlderRef.current = loadingOlder;
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;

  const heightMap = getOrCreateHeightMap(heightCacheRef.current, sessionKey);
  const layout = useMemo(
    () => computeVirtualLayout(rows, heightMap, THREAD_GAP, expandedRowIds),
    [rows, heightMap, measureVersion, expandedRowIds],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // 在 render 阶段同步感知会话切换与向前追加，避免先卸载旧窗口再重新挂载导致闪烁或丢失局部状态
  const prevCommit = prevCommitRef.current;
  const isSessionSwitch = prevCommit !== undefined && prevCommit.sessionKey !== sessionKey;
  const effectiveStick = isSessionSwitch ? true : stickToBottom;

  let pendingPrependDelta = 0;
  if (!isSessionSwitch && prevCommit && prevCommit.rows !== rows) {
    const anchor = detectPrependAnchor(prevCommit.rows, rows);
    if (anchor) {
      pendingPrependDelta = Math.max(0, layout.offsets[anchor.nextIndex]! - prevCommit.layout.offsets[anchor.prevIndex]!);
    }
  }

  const effectiveScrollOffset = effectiveStick
    ? Math.max(0, layout.totalHeight - viewportHeight)
    : Math.max(0, anchorScrollTop + pendingPrependDelta - listOffsetTop);

  const range = computeVisibleRange(layout, effectiveScrollOffset, viewportHeight, OVERSCAN_PX, MIN_OVERSCAN_COUNT);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const paddingTop = range.endIndex >= range.startIndex ? layout.offsets[range.startIndex]! : 0;
  const paddingBottom =
    range.endIndex >= range.startIndex
      ? Math.max(0, layout.totalHeight - (layout.offsets[range.endIndex]! + layout.sizes[range.endIndex]!))
      : 0;

  const clearLoadOlderTimer = useCallback(() => {
    if (loadOlderTimerRef.current !== undefined) {
      clearTimeout(loadOlderTimerRef.current);
      loadOlderTimerRef.current = undefined;
    }
  }, []);

  const resetLoadOlderState = useCallback(() => {
    clearLoadOlderTimer();
    loadOlderPendingRef.current = false;
    requestedOldestIdRef.current = undefined;
    loadOlderCooldownUntilRef.current = 0;
    setLocalLoadingOlder(false);
  }, [clearLoadOlderTimer]);

  const clearSmoothScroll = useCallback(() => {
    scrollingToBottomRef.current = false;
    if (smoothScrollTimerRef.current !== undefined) {
      clearTimeout(smoothScrollTimerRef.current);
      smoothScrollTimerRef.current = undefined;
    }
  }, []);

  const triggerLoadOlder = useCallback(() => {
    if (!hasOlderRef.current || loadingOlderRef.current) return;
    if (loadOlderPendingRef.current) return;
    if (Date.now() < loadOlderCooldownUntilRef.current) return;

    loadOlderPendingRef.current = true;
    requestedOldestIdRef.current = rowsRef.current[0]?.id;
    setLocalLoadingOlder(true);
    clearLoadOlderTimer();
    // 兜底：若 Host 未响应或未翻回 loadingOlder，超时后解除锁定
    loadOlderTimerRef.current = setTimeout(() => {
      loadOlderTimerRef.current = undefined;
      if (loadOlderPendingRef.current && !loadingOlderRef.current) {
        loadOlderPendingRef.current = false;
        loadOlderCooldownUntilRef.current = Date.now() + LOAD_OLDER_ERROR_COOLDOWN_MS;
        setLocalLoadingOlder(false);
      }
    }, LOAD_OLDER_SAFETY_TIMEOUT_MS);
    onLoadOlderRef.current();
  }, [clearLoadOlderTimer]);

  const maybeLoadOlder = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !hasOlderRef.current || loadingOlderRef.current) return;
    if (loadOlderPendingRef.current) return;
    if (scrollingToBottomRef.current) return;
    // 隐藏态（display: none）下 clientHeight === 0，不触发后台拉取
    if (el.clientHeight <= 0) return;

    const shouldLoad = stickRef.current
      ? el.scrollHeight <= el.clientHeight + LOAD_OLDER_THRESHOLD
      : el.scrollTop <= LOAD_OLDER_THRESHOLD;

    if (shouldLoad) {
      triggerLoadOlder();
    }
  }, [triggerLoadOlder]);

  /** 测量已挂载条目的真实高度，更新缓存并在必要时做向上滚锚定补偿或贴底跟随。 */
  const measureRows = useCallback((targetIds?: readonly string[]) => {
    const scroller = scrollerRef.current;
    if (!scroller || scroller.clientHeight <= 0) return;

    const currentRows = rowsRef.current;
    const currentLayout = layoutRef.current;
    const currentRange = rangeRef.current;
    if (currentRows.length === 0 || currentRange.endIndex < currentRange.startIndex) return;

    const currentHeightMap = getOrCreateHeightMap(heightCacheRef.current, sessionKeyRef.current);
    const idToIndex = new Map<string, number>();
    for (let i = currentRange.startIndex; i <= currentRange.endIndex; i++) {
      const row = currentRows[i];
      if (row) idToIndex.set(row.id, i);
    }

    const listEl = listRef.current;
    const currentListOffset = listEl ? listEl.offsetTop : listOffsetTopRef.current;
    const scrollOffset = Math.max(0, scroller.scrollTop - currentListOffset);

    const idsToCheck = targetIds ?? Array.from(rowElementsRef.current.keys());
    let changed = false;
    let scrollAdjustment = 0;

    for (const id of idsToCheck) {
      const index = idToIndex.get(id);
      if (index === undefined) continue;
      const el = rowElementsRef.current.get(id);
      if (!el) continue;
      const rectHeight = el.getBoundingClientRect().height;
      if (rectHeight <= 0) continue;

      const wasMeasured = currentHeightMap.has(id);
      const oldHeight = currentLayout.sizes[index]!;
      const delta = rectHeight - oldHeight;
      if (wasMeasured && Math.abs(delta) < HEIGHT_EPSILON) continue;

      currentHeightMap.set(id, rectHeight);
      changed = true;

      if (!stickRef.current && !scrollingToBottomRef.current) {
        const itemTop = currentLayout.offsets[index]!;
        const isStrictlyAbove = itemTop + oldHeight <= scrollOffset + 1;
        const isUnmeasuredAbove = !wasMeasured && itemTop < scrollOffset;
        if (isStrictlyAbove || isUnmeasuredAbove) {
          scrollAdjustment += delta;
        }
      }
    }

    if (!changed) return;

    if (stickRef.current) {
      if (scrollingToBottomRef.current) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
    } else if (Math.abs(scrollAdjustment) >= HEIGHT_EPSILON) {
      const nextScrollTop = Math.max(0, scroller.scrollTop + scrollAdjustment);
      scroller.scrollTop = nextScrollTop;
      setAnchorScrollTop(nextScrollTop);
    }

    setMeasureVersion((v) => v + 1);
  }, []);

  // 会话切换时重置贴底、未读与顶部加载状态
  useLayoutEffect(() => {
    clearSmoothScroll();
    resetLoadOlderState();
    stickRef.current = true;
    setStickToBottom(true);
    setFarFromBottom(false);
    setUnseen(false);
    setAnchorScrollTop(0);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [sessionKey, clearSmoothScroll, resetLoadOlderState]);

  // 排版外观变化（字号、行高、段落间距、内容宽度）时清空高度缓存以重新测量
  useLayoutEffect(() => {
    if (prevAppearanceKeyRef.current === appearanceKey) return;
    prevAppearanceKeyRef.current = appearanceKey;
    heightCacheRef.current.clear();
    setMeasureVersion((v) => v + 1);
    const el = scrollerRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [appearanceKey]);

  // 每次渲染后在绘制前：处理向前追加的滚动锚定、顶部横幅高度变化、同步测量与贴底保持
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const listEl = listRef.current;
    const nextListOffsetTop = listEl ? listEl.offsetTop : 0;
    const committed = prevCommitRef.current;
    const sameSession = committed !== undefined && committed.sessionKey === sessionKey;

    if (scroller) {
      if (scroller.clientHeight > 0 && Math.abs(scroller.clientHeight - viewportHeightRef.current) >= 1) {
        viewportHeightRef.current = scroller.clientHeight;
        setViewportHeight(scroller.clientHeight);
      }

      if (sameSession && pendingPrependDelta > 0) {
        if (stickRef.current) {
          scroller.scrollTop = scroller.scrollHeight;
        } else {
          const nextScrollTop = Math.max(0, scroller.scrollTop + pendingPrependDelta);
          scroller.scrollTop = nextScrollTop;
          setAnchorScrollTop(nextScrollTop);
        }
        // 已成功向前追加：立即解除 loadOlder 挂起锁
        if (loadOlderPendingRef.current) {
          resetLoadOlderState();
        }
      } else if (sameSession && !stickRef.current && !scrollingToBottomRef.current && committed.listOffsetTop > 0) {
        const headerDelta = nextListOffsetTop - committed.listOffsetTop;
        if (Math.abs(headerDelta) >= HEIGHT_EPSILON && scroller.scrollTop > 0) {
          const nextScrollTop = Math.max(0, scroller.scrollTop + headerDelta);
          scroller.scrollTop = nextScrollTop;
          setAnchorScrollTop(nextScrollTop);
        }
      } else if (stickRef.current && !scrollingToBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }

    if (Math.abs(nextListOffsetTop - listOffsetTopRef.current) >= 1) {
      listOffsetTopRef.current = nextListOffsetTop;
      setListOffsetTop(nextListOffsetTop);
    }

    prevCommitRef.current = {
      sessionKey,
      rows,
      layout,
      listOffsetTop: nextListOffsetTop,
    };

    // 若未挂载行的分组/展开形态发生变化，清除其过期高度缓存，避免滚回时按旧形态高度产生跳动
    const prevShapes = prevRowShapeRef.current;
    const nextShapes = new Map<string, string>();
    const sameShapeSession = prevShapes.sessionKey === sessionKey;
    let shapeInvalidated = false;
    for (const row of rows) {
      const shape = row.grouped ? (expandedRowIds.has(row.id) ? 'g1' : 'g0') : 's';
      nextShapes.set(row.id, shape);
      if (sameShapeSession) {
        const prevShape = prevShapes.shapes.get(row.id);
        if (prevShape !== undefined && prevShape !== shape && !rowElementsRef.current.has(row.id)) {
          if (heightMap.delete(row.id)) shapeInvalidated = true;
        }
      }
    }
    prevRowShapeRef.current = { sessionKey, shapes: nextShapes };
    if (shapeInvalidated) setMeasureVersion((v) => v + 1);

    // 同步测量本轮新挂载的条目，避免向上滚入未测量条目时出现单帧跳动
    measureRows();
  });

  // 监听 hasOlder / loadingOlder / 首行 变化，管理无限加载状态机与首屏不满时的自动补齐
  useEffect(() => {
    const prevLoading = prevLoadingOlderRef.current;
    prevLoadingOlderRef.current = loadingOlder;

    if (!hasOlder) {
      resetLoadOlderState();
      return;
    }

    const currentFirstId = rows[0]?.id;
    if (loadOlderPendingRef.current && requestedOldestIdRef.current !== undefined && currentFirstId !== requestedOldestIdRef.current) {
      resetLoadOlderState();
    } else if (prevLoading && !loadingOlder && loadOlderPendingRef.current) {
      // Host 先推送 session(loadingOlder: false)，随后推送 items；给短暂宽限期，若未追加则判定为失败并冷却
      clearLoadOlderTimer();
      loadOlderTimerRef.current = setTimeout(() => {
        loadOlderTimerRef.current = undefined;
        if (loadOlderPendingRef.current && !loadingOlderRef.current) {
          loadOlderPendingRef.current = false;
          loadOlderCooldownUntilRef.current = Date.now() + LOAD_OLDER_ERROR_COOLDOWN_MS;
          setLocalLoadingOlder(false);
        }
      }, LOAD_OLDER_ERROR_GRACE_MS);
    }

    maybeLoadOlder();
  }, [hasOlder, loadingOlder, rows, sessionKey, viewportHeight, measureVersion, maybeLoadOlder, resetLoadOlderState, clearLoadOlderTimer]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      clearLoadOlderTimer();
      clearSmoothScroll();
    };
  }, [clearLoadOlderTimer, clearSmoothScroll]);

  // 未读新内容提示（仅在尾部新增消息或交互卡片、且用户未贴底时亮起）
  const lastId = rows.at(-1)?.items.at(-1)?.id;
  const seenRef = useRef({ sessionKey, lastId, interactions: interactionsCount });
  useEffect(() => {
    const before = seenRef.current;
    seenRef.current = { sessionKey, lastId, interactions: interactionsCount };
    if (before.sessionKey !== sessionKey) return;
    if (!stickRef.current && (lastId !== before.lastId || interactionsCount > before.interactions)) {
      setUnseen(true);
    }
  }, [sessionKey, lastId, interactionsCount]);

  // 共享 ResizeObserver：观察所有已挂载条目的动态高度变化
  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const ids: string[] = [];
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.virtualId;
        if (id) ids.push(id);
      }
      if (ids.length > 0) measureRows(ids);
    });
    itemObserverRef.current = observer;
    for (const el of rowElementsRef.current.values()) {
      observer.observe(el);
    }
    return () => {
      observer.disconnect();
      itemObserverRef.current = null;
    };
  }, [measureRows]);

  // 观察滚动容器与底部区域（交互卡 / RunStatus）尺寸变化
  useEffect(() => {
    const scroller = scrollerRef.current;
    const footer = footerRef.current;
    if (!scroller || typeof ResizeObserver !== 'function') return;

    lastClientWidthRef.current = scroller.clientWidth;
    lastClientHeightRef.current = scroller.clientHeight;
    if (scroller.clientHeight > 0) {
      viewportHeightRef.current = scroller.clientHeight;
      setViewportHeight(scroller.clientHeight);
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === scroller) {
          const nextHeight = scroller.clientHeight;
          const nextWidth = scroller.clientWidth;
          const prevHeight = lastClientHeightRef.current;
          const prevWidth = lastClientWidthRef.current;
          lastClientHeightRef.current = nextHeight;
          lastClientWidthRef.current = nextWidth;

          if (nextHeight <= 0) continue;

          if (Math.abs(nextHeight - viewportHeightRef.current) >= 1) {
            viewportHeightRef.current = nextHeight;
            setViewportHeight(nextHeight);
          }

          if (prevWidth > 0 && nextWidth > 0 && Math.abs(nextWidth - prevWidth) >= 2) {
            getOrCreateHeightMap(heightCacheRef.current, sessionKeyRef.current).clear();
            setMeasureVersion((v) => v + 1);
          }

          if ((prevHeight === 0 || stickRef.current) && stickRef.current && !scrollingToBottomRef.current) {
            scroller.scrollTop = scroller.scrollHeight;
          }

          maybeLoadOlder();
        } else if (entry.target === footer) {
          if (stickRef.current && !scrollingToBottomRef.current) {
            scroller.scrollTop = scroller.scrollHeight;
          }
        }
      }
    });

    observer.observe(scroller);
    if (footer) observer.observe(footer);
    return () => observer.disconnect();
  }, [maybeLoadOlder]);

  // 滚动事件监听：更新虚拟窗口（仅在区间或贴底态变化时触发重渲染）、回底按钮与顶部无限加载
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const cancelSmoothScroll = () => {
      if (scrollingToBottomRef.current) {
        clearSmoothScroll();
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) cancelSmoothScroll();
    };

    const onScrollEnd = () => {
      if (!scrollingToBottomRef.current) return;
      clearSmoothScroll();
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
      setStickToBottom(true);
      setFarFromBottom(false);
      setUnseen(false);
    };

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;

      if (scrollingToBottomRef.current) {
        if (distance < STICK_THRESHOLD) {
          clearSmoothScroll();
          stickRef.current = true;
          setStickToBottom(true);
          setFarFromBottom(false);
          setUnseen(false);
        }
        return;
      }

      const nextStick = distance < STICK_THRESHOLD;
      const prevStick = stickRef.current;
      stickRef.current = nextStick;

      setFarFromBottom(distance > BUTTON_THRESHOLD);
      if (nextStick) setUnseen(false);

      if (nextStick !== prevStick) {
        setStickToBottom(nextStick);
      }

      if (!nextStick) {
        const nextOffset = Math.max(0, el.scrollTop - listOffsetTopRef.current);
        const nextRange = computeVisibleRange(
          layoutRef.current,
          nextOffset,
          el.clientHeight > 0 ? el.clientHeight : viewportHeightRef.current,
          OVERSCAN_PX,
          MIN_OVERSCAN_COUNT,
        );
        const currentRange = rangeRef.current;
        if (
          prevStick ||
          nextRange.startIndex !== currentRange.startIndex ||
          nextRange.endIndex !== currentRange.endIndex
        ) {
          setAnchorScrollTop(el.scrollTop);
        }
      }

      maybeLoadOlder();
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', cancelSmoothScroll, { passive: true });
    el.addEventListener('pointerdown', cancelSmoothScroll, { passive: true });
    el.addEventListener('scrollend', onScrollEnd, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', cancelSmoothScroll);
      el.removeEventListener('pointerdown', cancelSmoothScroll);
      el.removeEventListener('scrollend', onScrollEnd);
    };
  }, [clearSmoothScroll, maybeLoadOlder]);

  const registerRow = useCallback((id: string, el: HTMLDivElement | null) => {
    const prev = rowElementsRef.current.get(id);
    if (prev === el) return;
    if (prev) {
      itemObserverRef.current?.unobserve(prev);
      rowElementsRef.current.delete(id);
    }
    if (el) {
      rowElementsRef.current.set(id, el);
      itemObserverRef.current?.observe(el);
    }
  }, []);

  const toBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    clearSmoothScroll();
    stickRef.current = true;
    scrollingToBottomRef.current = true;
    setStickToBottom(true);
    setUnseen(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    smoothScrollTimerRef.current = setTimeout(() => {
      smoothScrollTimerRef.current = undefined;
      if (!scrollingToBottomRef.current) return;
      scrollingToBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
      setFarFromBottom(false);
    }, SMOOTH_SCROLL_SETTLE_MS);
  }, [clearSmoothScroll]);

  return {
    scrollerRef,
    listRef,
    footerRef,
    range,
    paddingTop,
    paddingBottom,
    totalHeight: layout.totalHeight,
    farFromBottom,
    unseen,
    showLoadingOlder: hasOlder && (loadingOlder || localLoadingOlder),
    registerRow,
    toBottom,
  };
}

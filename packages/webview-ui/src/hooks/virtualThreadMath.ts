/**
 * 对话流虚拟滚动纯计算模块：高度估算、前缀和布局、二分查找可见窗口与向前追加锚点检测。
 */
import type { Item } from '@harness-deck/shared';

export const THREAD_GAP = 14;
export const DEFAULT_VIEWPORT_HEIGHT = 720;
export const OVERSCAN_PX = 600;
export const MIN_OVERSCAN_COUNT = 3;
export const STICK_THRESHOLD = 48;
export const BUTTON_THRESHOLD = 240;
export const LOAD_OLDER_THRESHOLD = 320;

export interface VirtualLayout {
  readonly offsets: Float64Array;
  readonly sizes: Float64Array;
  readonly totalHeight: number;
}

export interface VisibleRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface PrependAnchor {
  readonly anchorId: string;
  readonly prevIndex: number;
  readonly nextIndex: number;
}

/** 根据条目类型和内容长度给出初始高度估算，降低未测量条目滚入时的高度修正幅度。 */
export function estimateItemHeight(item: Item): number {
  switch (item.kind) {
    case 'turnDone':
      return 24;
    case 'activity':
      if (item.variant === 'subagent') return 92;
      return 20;
    case 'explore':
      return 20;
    case 'notice':
      return 44;
    case 'changes':
      return 64 + Math.min(item.files.length, 8) * 28;
    case 'user': {
      const lines = Math.max(1, item.text.split('\n').length + Math.floor(item.text.length / 60));
      const textHeight = Math.min(360, 28 + lines * 22);
      const imageHeight = item.images?.length ? 88 : 0;
      const attachHeight = item.attachments?.length ? 30 : 0;
      return textHeight + imageHeight + attachHeight;
    }
    case 'assistant': {
      const md = item.markdown;
      const reasoningHeight = item.reasoning ? 34 : 0;
      if (!md) return Math.max(36, reasoningHeight);
      const lines = md.split('\n').length + Math.floor(md.length / 72);
      const codeBlocks = Math.floor((md.match(/```/g)?.length ?? 0) / 2);
      return Math.min(720, reasoningHeight + 24 + lines * 22 + codeBlocks * 48);
    }
  }
}

/** 计算每个条目的高度与顶部偏移（前缀和）。 */
export function computeVirtualLayout(
  items: readonly Item[],
  measured: ReadonlyMap<string, number>,
  gap = THREAD_GAP,
): VirtualLayout {
  const count = items.length;
  const offsets = new Float64Array(count);
  const sizes = new Float64Array(count);
  if (count === 0) {
    return { offsets, sizes, totalHeight: 0 };
  }

  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const item = items[i]!;
    const cached = measured.get(item.id);
    const size = cached !== undefined && cached > 0 ? cached : estimateItemHeight(item);
    offsets[i] = cursor;
    sizes[i] = size;
    cursor += size + gap;
  }

  return {
    offsets,
    sizes,
    totalHeight: Math.max(0, cursor - gap),
  };
}

/** 二分查找给定滚动位置与视口高度对应的渲染区间（含上下 overscan）。 */
export function computeVisibleRange(
  layout: VirtualLayout,
  scrollOffset: number,
  viewportHeight: number,
  overscanPx = OVERSCAN_PX,
  minOverscanCount = MIN_OVERSCAN_COUNT,
): VisibleRange {
  const count = layout.offsets.length;
  if (count === 0) {
    return { startIndex: 0, endIndex: -1 };
  }

  const effectiveViewport = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT;
  const clampedScroll = Math.max(0, scrollOffset);
  const windowStart = Math.max(0, clampedScroll - overscanPx);
  const windowEnd = clampedScroll + effectiveViewport + overscanPx;

  // 寻找第一个底部 >= windowStart 的条目
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (layout.offsets[mid]! + layout.sizes[mid]! < windowStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const rawStart = lo;

  // 寻找最后一个顶部 <= windowEnd 的条目
  lo = rawStart;
  hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (layout.offsets[mid]! <= windowEnd) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const rawEnd = lo;

  const startIndex = Math.max(0, rawStart - minOverscanCount);
  const endIndex = Math.min(count - 1, Math.max(rawStart, rawEnd) + minOverscanCount);
  return { startIndex, endIndex };
}

/**
 * 检测同一会话中是否在前部插入了更早的历史条目，返回用于保持滚动位置的锚点。
 * 检查前若干条以兼容分页边界处少量条目合并的情况。
 */
export function detectPrependAnchor(
  prevItems: readonly Item[],
  nextItems: readonly Item[],
): PrependAnchor | undefined {
  if (prevItems.length === 0 || nextItems.length <= prevItems.length) return undefined;
  const probeLimit = Math.min(4, prevItems.length);
  for (let prevIndex = 0; prevIndex < probeLimit; prevIndex++) {
    const anchorId = prevItems[prevIndex]!.id;
    const nextIndex = nextItems.findIndex((item) => item.id === anchorId);
    if (nextIndex > prevIndex) {
      return { anchorId, prevIndex, nextIndex };
    }
  }
  return undefined;
}

/**
 * 对话流行模型：把连续的工具操作（活动行、只读探索、仅推理的 assistant）合并成一条
 * 「思考」轨迹行，其余条目仍然一条一行。行 id 取组内第一条条目的 id，流式追加时保持稳定。
 */
import type { Item } from '@harness-deck/shared';

export interface ThreadRow {
  readonly id: string;
  readonly items: readonly Item[];
  /** 是否为合并后的思考轨迹行。 */
  readonly grouped: boolean;
}

/** 可以收进思考轨迹的条目。 */
export function isTraceItem(item: Item): boolean {
  if (item.kind === 'activity') return item.variant !== 'subagent';
  if (item.kind === 'explore') return true;
  return item.kind === 'assistant' && item.markdown.length === 0 && Boolean(item.reasoning);
}

/** 轨迹行里的工具操作数量（不含推理）。 */
export function rowToolCount(row: ThreadRow): number {
  let count = 0;
  for (const item of row.items) {
    if (item.kind === 'activity' || item.kind === 'explore') count++;
  }
  return count;
}

/** 轨迹行是否还在运行，用于自动展开与流光标题。 */
export function rowIsRunning(row: ThreadRow): boolean {
  return row.items.some((item) => {
    if (item.kind === 'activity' || item.kind === 'explore') return item.status === 'running';
    if (item.kind === 'assistant') return item.streaming;
    return false;
  });
}

export function buildThreadRows(items: readonly Item[]): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let buffer: Item[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const toolCount = buffer.reduce(
      (sum, item) => sum + (item.kind === 'activity' || item.kind === 'explore' ? 1 : 0),
      0,
    );
    // 只有一条工具行时维持原样，避免单行也套一层卡片
    if (buffer.length >= 2 && toolCount > 0) {
      rows.push({ id: buffer[0]!.id, items: buffer, grouped: true });
    } else {
      for (const item of buffer) rows.push({ id: item.id, items: [item], grouped: false });
    }
    buffer = [];
  };

  for (const item of items) {
    if (isTraceItem(item)) {
      buffer.push(item);
      continue;
    }
    flush();
    rows.push({ id: item.id, items: [item], grouped: false });
  }
  flush();

  return rows;
}

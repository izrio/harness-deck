/**
 * 回合模型（HD-08）：从对话条目推导出每一轮的用户消息、状态、用时和改过的文件。
 *
 * 不依赖任何底层：dsh / ACP / 原生控制器的条目都适用。宿主和界面共用，
 * 后续的回滚（HD-07）、按回合 PR（HD-10）都从这里取回合边界。
 */
import type { Item, TurnView } from './viewModel.ts';

/**
 * @param items - 当前会话的对话条目（已按顺序）。
 * @param running - 会话是否正在回复；最后一轮没有 `turnDone` 时用它判断状态。
 */
export function deriveTurns(items: readonly Item[], running: boolean): TurnView[] {
  const turns: TurnView[] = [];
  let current: { id: string; seq: number; paths: Set<string>; status?: TurnView['status']; durationMs?: number } | undefined;

  const flush = (): void => {
    if (!current) return;
    turns.push({
      id: current.id,
      seq: current.seq,
      status: current.status ?? 'completed',
      ...(current.durationMs !== undefined ? { durationMs: current.durationMs } : {}),
      authoredPaths: [...current.paths],
    });
    current = undefined;
  };

  for (const item of items) {
    if (item.kind === 'user') {
      // 还在队列里的消息属于下一轮；等它真正开始再切回合。
      if (item.pending === 'queued' || item.queue) continue;
      flush();
      current = { id: item.id, seq: turns.length + 1, paths: new Set() };
      continue;
    }
    if (!current) continue;
    if (item.kind === 'activity' && item.variant === 'edit' && item.label) {
      current.paths.add(item.label);
    } else if (item.kind === 'changes') {
      for (const file of item.files) current.paths.add(file.path);
    } else if (item.kind === 'turnDone') {
      current.durationMs = item.durationMs;
      current.status = item.completed ? 'completed' : 'interrupted';
      flush();
    }
  }

  if (current) {
    current.status = running ? 'running' : 'completed';
    flush();
  }
  return turns;
}

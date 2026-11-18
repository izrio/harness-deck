/**
 * 任务模块四列看板状态存储（待执行 `todo` / 执行中 `in_progress` / 待验收 `review` / 已完成 `done`）。
 *
 * 支持在待执行列创建任务（绑定项目、harness、模型、可选智能体），调整执行顺序，以及按顺序自动连续执行。
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { TASK_COLUMNS, type KanbanTask, type TaskBoardState, type TaskColumn } from '@harness-deck/shared';

export const MAX_KANBAN_TASKS = 300;

export interface CreateTaskInput {
  readonly title?: string;
  readonly prompt: string;
  readonly projectPath: string;
  readonly backendId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly agentId?: string;
}

function isTaskColumn(value: unknown): value is TaskColumn {
  return typeof value === 'string' && (TASK_COLUMNS as readonly string[]).includes(value);
}

export function deriveTaskTitle(prompt: string, explicitTitle?: string): string {
  const cleanExplicit = explicitTitle?.replace(/\s+/gu, ' ').trim();
  if (cleanExplicit) return cleanExplicit.slice(0, 120);
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, '').trim())
    .find((line) => line.length > 0);
  const fallback = firstLine ?? prompt.replace(/\s+/gu, ' ').trim();
  return fallback.length > 72 ? `${fallback.slice(0, 72)}…` : fallback || 'Untitled Task';
}

/** 解析持久化的看板数据；宿主重启时把中断的 `in_progress` 任务退回 `todo` 队首以便继续执行。 */
export function parseTaskBoardState(raw: unknown): TaskBoardState {
  if (!raw || typeof raw !== 'object') {
    return { items: [], autoRun: true };
  }
  const obj = raw as { items?: unknown; autoRun?: unknown };
  const autoRun = typeof obj.autoRun === 'boolean' ? obj.autoRun : true;
  const items: KanbanTask[] = [];
  if (Array.isArray(obj.items)) {
    for (const entry of obj.items) {
      if (!entry || typeof entry !== 'object') continue;
      const t = entry as Partial<KanbanTask>;
      if (typeof t.id !== 'string' || typeof t.prompt !== 'string' || typeof t.projectPath !== 'string' || typeof t.backendId !== 'string') {
        continue;
      }
      const rawStatus = isTaskColumn(t.status) ? t.status : 'todo';
      // 宿主重启后原进程已不在跑，若之前停在 in_progress 则回到 todo 等待重新调度
      const status: TaskColumn = rawStatus === 'in_progress' ? 'todo' : rawStatus;
      items.push({
        id: t.id,
        title: typeof t.title === 'string' && t.title.trim() ? t.title : deriveTaskTitle(t.prompt),
        prompt: t.prompt,
        status,
        projectPath: t.projectPath,
        projectName: typeof t.projectName === 'string' && t.projectName ? t.projectName : basename(t.projectPath) || t.projectPath,
        backendId: t.backendId,
        ...(typeof t.provider === 'string' && t.provider ? { provider: t.provider } : {}),
        ...(typeof t.model === 'string' && t.model ? { model: t.model } : {}),
        ...(typeof t.reasoningEffort === 'string' && t.reasoningEffort ? { reasoningEffort: t.reasoningEffort } : {}),
        ...(typeof t.agentId === 'string' && t.agentId ? { agentId: t.agentId } : {}),
        ...(typeof t.sessionId === 'string' && t.sessionId ? { sessionId: t.sessionId } : {}),
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
        ...(typeof t.startedAt === 'number' ? { startedAt: t.startedAt } : {}),
        ...(typeof t.completedAt === 'number' ? { completedAt: t.completedAt } : {}),
        ...(typeof t.summary === 'string' && t.summary ? { summary: t.summary } : {}),
        ...(typeof t.error === 'string' && t.error ? { error: t.error } : {}),
        ...(t.unread ? { unread: true } : {}),
      });
    }
  }
  return { items: items.slice(0, MAX_KANBAN_TASKS), autoRun };
}

export function createKanbanTask(
  board: TaskBoardState,
  input: CreateTaskInput,
  nowMs: number,
): { readonly board: TaskBoardState; readonly task: KanbanTask } {
  const prompt = input.prompt.trim();
  const task: KanbanTask = {
    id: `task-${randomUUID().slice(0, 8)}`,
    title: deriveTaskTitle(prompt, input.title),
    prompt,
    status: 'todo',
    projectPath: input.projectPath,
    projectName: basename(input.projectPath) || input.projectPath,
    backendId: input.backendId,
    ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.reasoningEffort?.trim() ? { reasoningEffort: input.reasoningEffort.trim() } : {}),
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
    createdAt: nowMs,
  };
  // 新建的待执行任务排在待执行队列末尾，保证按顺序 FIFO 执行
  return {
    board: { ...board, items: [...board.items, task].slice(-MAX_KANBAN_TASKS) },
    task,
  };
}

export function updateKanbanTaskStatus(
  board: TaskBoardState,
  id: string,
  status: TaskColumn,
  nowMs: number,
  extra?: { readonly sessionId?: string; readonly summary?: string; readonly error?: string; readonly unread?: boolean },
): TaskBoardState {
  return {
    ...board,
    items: board.items.map((item) => {
      if (item.id !== id) return item;
      const { unread: _prevUnread, error: _prevError, ...rest } = item;
      const keepError = status === 'todo' && extra?.error ? { error: extra.error } : {};
      return {
        ...rest,
        status,
        ...(status === 'in_progress' ? { startedAt: nowMs } : {}),
        ...(status === 'review' || status === 'done' ? { completedAt: nowMs } : {}),
        ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
        ...(extra?.summary !== undefined ? (extra.summary ? { summary: extra.summary } : {}) : {}),
        ...keepError,
        ...(extra?.unread ? { unread: true } : {}),
      };
    }),
  };
}

/** 在同一状态列（主要为 `todo` 待执行队列）内上移或下移任务顺序。 */
export function reorderKanbanTask(
  board: TaskBoardState,
  id: string,
  direction: 'up' | 'down',
): TaskBoardState {
  const target = board.items.find((item) => item.id === id);
  if (!target) return board;
  const sameColIndices: number[] = [];
  board.items.forEach((item, index) => {
    if (item.status === target.status) sameColIndices.push(index);
  });
  const posInCol = sameColIndices.findIndex((idx) => board.items[idx]?.id === id);
  if (posInCol < 0) return board;
  const swapPosInCol = direction === 'up' ? posInCol - 1 : posInCol + 1;
  if (swapPosInCol < 0 || swapPosInCol >= sameColIndices.length) return board;
  const idxA = sameColIndices[posInCol]!;
  const idxB = sameColIndices[swapPosInCol]!;
  const next = [...board.items];
  const temp = next[idxA]!;
  next[idxA] = next[idxB]!;
  next[idxB] = temp;
  return { ...board, items: next };
}

export function deleteKanbanTask(board: TaskBoardState, id: string): TaskBoardState {
  return { ...board, items: board.items.filter((item) => item.id !== id) };
}

export function clearDoneKanbanTasks(board: TaskBoardState): TaskBoardState {
  return { ...board, items: board.items.filter((item) => item.status !== 'done') };
}

export function setKanbanAutoRun(board: TaskBoardState, autoRun: boolean): TaskBoardState {
  return { ...board, autoRun };
}

export function markKanbanTaskRead(board: TaskBoardState, id?: string): TaskBoardState {
  const changed = board.items.some((item) => (!id || item.id === id) && item.unread);
  if (!changed) return board;
  return {
    ...board,
    items: board.items.map((item) => {
      if (id && item.id !== id) return item;
      const { unread: _omit, ...rest } = item;
      return rest;
    }),
  };
}

/** 当前正在执行的任务（同一时刻最多 1 个）。 */
export function activeRunningTask(board: TaskBoardState): KanbanTask | undefined {
  return board.items.find((item) => item.status === 'in_progress');
}

/** 队列中下一个待执行的任务（按列表顺序 FIFO）。 */
export function nextQueuedTask(board: TaskBoardState): KanbanTask | undefined {
  return board.items.find((item) => item.status === 'todo');
}

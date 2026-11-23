import { type TaskColumn } from '@harness-deck/shared/limits';
import type { AgentProfile, BackendsState, KanbanTask, ProjectsState, ScheduleFrequency } from '@harness-deck/shared';
import { postToHost } from '../../../vscode.ts';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  GitBranchIcon,
  PlayIcon,
  ReplyIcon,
  SpinnerIcon,
  TerminalIcon,
  TrashIcon,
} from '../../icons.tsx';
import { BackendLogo } from '../../BackendLogo.tsx';
import { Button } from '@/components/ui/button';
import { useT, type MessageKey, type Translate } from '../../../i18n.ts';

function formatTaskSchedule(schedule: ScheduleFrequency, t: Translate): string {
  switch (schedule.kind) {
    case 'daily':
      return t('wb.tasks.scheduleDaily', schedule.time);
    case 'weekly': {
      const days = schedule.days.map((d) => t(`wb.schedules.day${d}` as MessageKey)).join('/');
      return t('wb.tasks.scheduleWeekly', days, schedule.time);
    }
    case 'interval':
      return t('wb.tasks.scheduleEvery', schedule.minutes);
    case 'once': {
      const d = new Date(schedule.runAt);
      const pad = (n: number) => String(n).padStart(2, '0');
      const formatted = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return t('wb.tasks.scheduleOnce', formatted);
    }
  }
}

export function TaskCard({
  task,
  idx,
  isLast,
  col,
  hasRunning,
  backends,
  agents,
  projects,
}: {
  task: KanbanTask;
  idx: number;
  isLast: boolean;
  col: TaskColumn;
  hasRunning: boolean;
  backends: BackendsState;
  agents: readonly AgentProfile[];
  projects: ProjectsState;
}) {
  const t = useT();
  const backendInfo = backends.items.find((b) => b.id === task.backendId);
  const backendName = backendInfo?.name ?? task.backendId;
  const assignedAgent = task.agentId ? agents.find((a) => a.id === task.agentId) : undefined;
  const effectiveProjectPath = task.worktreePath ?? task.projectPath;
  const hasVerify =
    (projects.configs[effectiveProjectPath]?.verifyCommands.length ??
      projects.configs[task.projectPath]?.verifyCommands.length ??
      0) > 0;
  const scheduleLabel = task.schedule ? formatTaskSchedule(task.schedule, t) : undefined;
  const worktreeLabel = task.useWorktree || task.worktreePath ? task.worktreeBranch || t('wb.tasks.worktreeBadge') : undefined;

  return (
    <article
      className="flex flex-col gap-2 px-3 py-2.5 transition-colors duration-100 hover:bg-hover/40"
      data-testid={`task-card-${task.id}`}
    >
      {/* 标题行：序标 + 运行时图标 + 标题 + 删除 */}
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {col === 'todo' ? (
            <span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">#{idx + 1}</span>
          ) : col === 'in_progress' ? (
            <SpinnerIcon className="size-3.5 shrink-0 text-accent-ink" />
          ) : null}

          <span
            className="inline-flex size-4 shrink-0 items-center justify-center"
            title={backendName}
            aria-label={backendName}
            data-testid={`task-backend-icon-${task.id}`}
          >
            <BackendLogo backend={{ id: task.backendId, name: backendName }} size="sm" />
          </span>

          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{task.title}</span>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('common.delete')}
          title={t('common.delete')}
          className="shrink-0 text-ink-3 hover:text-ink"
          onClick={() => postToHost({ type: 'deleteTask', payload: { id: task.id } })}
        >
          <TrashIcon className="size-3" />
        </Button>
      </div>

      {/* 内容描述与结果摘要 */}
      <p className="m-0 line-clamp-2 text-[12px] leading-relaxed text-ink-2">{task.prompt}</p>

      {task.summary && (col === 'review' || col === 'done') ? (
        <p className="m-0 line-clamp-2 border-l-2 border-line-strong pl-2 text-[11.5px] leading-relaxed text-ink-2">
          {task.summary}
        </p>
      ) : null}

      {task.error ? (
        <p className="m-0 rounded-md bg-orange/10 px-2 py-1 text-[11.5px] text-orange">{task.error}</p>
      ) : null}

      {/* 轻量元信息行（项目 / 模型 / 智能体 / 定时） */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-3">
        <span className="max-w-[120px] truncate">{task.projectName}</span>
        {task.model ? (
          <span className="max-w-[130px] truncate font-mono text-[10.5px]" title={task.model}>
            · {task.model}
          </span>
        ) : null}
        {assignedAgent ? <span className="max-w-[100px] truncate">· {assignedAgent.name}</span> : null}
        {worktreeLabel ? (
          <span
            className="inline-flex max-w-[140px] items-center gap-1 font-mono text-[10.5px] text-accent-ink"
            title={task.worktreePath ?? worktreeLabel}
            data-testid={`task-worktree-badge-${task.id}`}
          >
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{worktreeLabel}</span>
          </span>
        ) : null}
        {scheduleLabel ? (
          <span
            className="inline-flex items-center gap-1 text-accent-ink tabular-nums"
            data-testid={`task-schedule-badge-${task.id}`}
          >
            <ClockIcon className="size-3 shrink-0" />
            <span>{scheduleLabel}</span>
          </span>
        ) : null}
      </div>

      {/* 底部操作行（无多余内部分割线，与列内 divide-y 保持干净层次） */}
      <div className="flex flex-wrap items-center justify-between gap-1 pt-0.5">
        {col === 'todo' ? (
          <>
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={idx === 0}
                title={t('wb.tasks.moveUp')}
                aria-label={t('wb.tasks.moveUp')}
                onClick={() => postToHost({ type: 'reorderTask', payload: { id: task.id, direction: 'up' } })}
              >
                <ArrowUpIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={isLast}
                title={t('wb.tasks.moveDown')}
                aria-label={t('wb.tasks.moveDown')}
                onClick={() => postToHost({ type: 'reorderTask', payload: { id: task.id, direction: 'down' } })}
              >
                <ArrowDownIcon className="size-3" />
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={hasRunning}
              data-testid={`task-run-${task.id}`}
              onClick={() => postToHost({ type: 'runTaskNow', payload: { id: task.id } })}
            >
              <PlayIcon className="size-3" />
              <span>{t('wb.tasks.runNow')}</span>
            </Button>
          </>
        ) : null}

        {col === 'in_progress' ? (
          <div className="flex w-full items-center justify-between gap-1">
            {task.sessionId ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() =>
                  postToHost({
                    type: 'openProjectSession',
                    payload: {
                      projectPath: effectiveProjectPath,
                      sessionId: task.sessionId!,
                      backendId: task.backendId,
                    },
                  })
                }
              >
                <ChatIcon className="size-3" />
                <span>{t('wb.tasks.openSession')}</span>
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'review' } })}
            >
              {t('wb.tasks.col.review')}
            </Button>
          </div>
        ) : null}

        {col === 'review' ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-1">
            <div className="flex items-center gap-1">
              {task.sessionId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    postToHost({
                      type: 'openProjectSession',
                      payload: {
                        projectPath: task.projectPath,
                        sessionId: task.sessionId!,
                        backendId: task.backendId,
                      },
                    })
                  }
                >
                  <ChatIcon className="size-3" />
                  <span>{t('wb.tasks.openSession')}</span>
                </Button>
              ) : null}
              {hasVerify ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => postToHost({ type: 'runProjectVerify', payload: { path: effectiveProjectPath } })}
                >
                  <TerminalIcon className="size-3" />
                  <span>{t('wb.tasks.runVerify')}</span>
                </Button>
              ) : null}
              {task.worktreePath ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid={`task-worktree-cleanup-${task.id}`}
                  title={task.worktreePath}
                  onClick={() => postToHost({ type: 'removeWorktree', payload: { path: task.worktreePath! } })}
                >
                  <GitBranchIcon className="size-3" />
                  <span>{t('wb.tasks.worktreeCleanup')}</span>
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title={t('wb.tasks.sendBack')}
                aria-label={t('wb.tasks.sendBack')}
                onClick={() => postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'todo' } })}
              >
                <ReplyIcon className="size-3" />
              </Button>
              <Button
                type="button"
                size="xs"
                data-testid={`task-approve-${task.id}`}
                onClick={() => postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'done' } })}
              >
                <CheckIcon className="size-3" />
                <span>{t('wb.tasks.approveDone')}</span>
              </Button>
            </div>
          </div>
        ) : null}

        {col === 'done' ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-1">
            <div className="flex items-center gap-1">
              {task.sessionId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    postToHost({
                      type: 'openProjectSession',
                      payload: {
                        projectPath: effectiveProjectPath,
                        sessionId: task.sessionId!,
                        backendId: task.backendId,
                      },
                    })
                  }
                >
                  <ChatIcon className="size-3" />
                  <span>{t('wb.tasks.openSession')}</span>
                </Button>
              ) : null}
              {task.worktreePath ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid={`task-worktree-cleanup-${task.id}`}
                  title={task.worktreePath}
                  onClick={() => postToHost({ type: 'removeWorktree', payload: { path: task.worktreePath! } })}
                >
                  <GitBranchIcon className="size-3" />
                  <span>{t('wb.tasks.worktreeCleanup')}</span>
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title={t('wb.tasks.sendBack')}
              aria-label={t('wb.tasks.sendBack')}
              onClick={() => postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'todo' } })}
            >
              <ReplyIcon className="size-3" />
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

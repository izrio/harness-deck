import { type TaskColumn } from '@harness-deck/shared/limits';
import { postToHost } from '../../../vscode.ts';
import { ArrowDownIcon, ArrowUpIcon, ChatIcon, CheckIcon, PlayIcon, ReplyIcon, SpinnerIcon, TerminalIcon, TrashIcon } from '../../icons.tsx';
import { Button } from '@/components/ui/button';
import type { AgentProfile, BackendsState, KanbanTask, ProjectsState } from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';

export function TaskCard({ task, idx, isLast, col, hasRunning, backends, agents, projects }: { task: KanbanTask; idx: number; isLast: boolean; col: TaskColumn; hasRunning: boolean; backends: BackendsState; agents: readonly AgentProfile[]; projects: ProjectsState }) {
  const t = useT();
  const backendName = backends.items.find((b) => b.id === task.backendId)?.name ?? task.backendId;
  const assignedAgent = task.agentId ? agents.find((a) => a.id === task.agentId) : undefined;
  const hasVerify = (projects.configs[task.projectPath]?.verifyCommands.length ?? 0) > 0;
  return (
    <article
      className="flex flex-col gap-2 rounded-control border border-line bg-field/45 p-2.5 shadow-hairline"
      data-testid={`task-card-${task.id}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {col === 'todo' ? (
              <span className="shrink-0 font-mono text-[10.5px] text-ink-3">#{idx + 1}</span>
            ) : col === 'in_progress' ? (
              <SpinnerIcon className="size-3 shrink-0 text-accent-ink" />
            ) : null}
            <span className="truncate text-[12.5px] font-semibold text-ink">{task.title}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label={t('common.delete')}
          className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
          onClick={() => postToHost({ type: 'deleteTask', payload: { id: task.id } })}
        >
          <TrashIcon className="size-3" />
        </button>
      </div>

      <p className="m-0 line-clamp-2 text-[11.5px] leading-relaxed text-ink-2">{task.prompt}</p>

      {task.summary && (col === 'review' || col === 'done') ? (
        <div className="rounded bg-surface px-2 py-1 text-[11px] text-ink-2 shadow-hairline">
          <span className="line-clamp-2">{task.summary}</span>
        </div>
      ) : null}

      {task.error ? (
        <div className="rounded bg-orange/10 px-2 py-1 text-[11px] text-orange">{task.error}</div>
      ) : null}

      <div className="flex flex-wrap gap-1 text-[10.5px] text-ink-3">
        <span className="rounded-chip bg-surface px-1.5 py-0.5 shadow-hairline">{task.projectName}</span>
        <span className="rounded-chip bg-surface px-1.5 py-0.5 shadow-hairline">{backendName}</span>
        {task.model ? (
          <span className="rounded-chip bg-surface px-1.5 py-0.5 font-mono shadow-hairline">
            {task.model}
          </span>
        ) : null}
        {assignedAgent ? (
          <span className="rounded-chip bg-surface px-1.5 py-0.5 shadow-hairline">
            {assignedAgent.name}
          </span>
        ) : null}
      </div>

      {/* 状态流转与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-line pt-1.5">
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
                onClick={() =>
                  postToHost({ type: 'reorderTask', payload: { id: task.id, direction: 'up' } })
                }
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
                onClick={() =>
                  postToHost({ type: 'reorderTask', payload: { id: task.id, direction: 'down' } })
                }
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
            ) : <span />}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'review' } })
              }
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
                  onClick={() =>
                    postToHost({ type: 'runProjectVerify', payload: { path: task.projectPath } })
                  }
                >
                  <TerminalIcon className="size-3" />
                  <span>{t('wb.tasks.runVerify')}</span>
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
                onClick={() =>
                  postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'todo' } })
                }
              >
                <ReplyIcon className="size-3" />
              </Button>
              <Button
                type="button"
                size="xs"
                data-testid={`task-approve-${task.id}`}
                onClick={() =>
                  postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'done' } })
                }
              >
                <CheckIcon className="size-3" />
                <span>{t('wb.tasks.approveDone')}</span>
              </Button>
            </div>
          </div>
        ) : null}

        {col === 'done' ? (
          <div className="flex w-full items-center justify-between gap-1">
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
            ) : <span />}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() =>
                postToHost({ type: 'updateTaskStatus', payload: { id: task.id, status: 'todo' } })
              }
            >
              <ReplyIcon className="size-3" />
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

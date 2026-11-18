/**
 * 工作台 · 任务模块（TasksView）
 *
 * 四列看板：待执行（todo）、执行中（in_progress）、待验收（review）、已完成（done）。
 * 点击「新增任务」或「待执行」列头 + 按钮弹出 Modal 创建任务，选择项目、Harness、模型（及可选智能体），
 * 并开启「按顺序执行」自动依次调度队列。
 */
import { useEffect, useState } from 'react';
import { TASK_COLUMNS, type TaskColumn } from '@harness-deck/shared/limits';
import type { KanbanTask } from '@harness-deck/shared';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { getMergedModels, getProjectOptions } from '@/lib/workbenchOptions';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { TaskCard } from './tasks/TaskCard.tsx';
import { TaskCreateDialog } from './tasks/TaskCreateDialog.tsx';

export function TasksView() {
  const t = useT();
  const board = useView((s) => s.workbench.tasks);
  const agents = useView((s) => s.workbench.agents);
  const backends = useView((s) => s.backends);
  const providers = useView((s) => s.providers.items);
  const models = useView((s) => s.models);
  const projects = useView((s) => s.projects);

  const defaultProject = projects.currentPath ?? projects.recent[0]?.path ?? '';
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [projectPath, setProjectPath] = useState(defaultProject);
  const [backendId, setBackendId] = useState(backends.active || 'dsh');
  const [modelKey, setModelKey] = useState('');
  const [agentId, setAgentId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!projectPath && defaultProject) {
      setProjectPath(defaultProject);
    }
  }, [projectPath, defaultProject]);

  const openCreateModal = () => {
    setTitle('');
    setPrompt('');
    setProjectPath(defaultProject);
    setBackendId(backends.active || 'dsh');
    setModelKey('');
    setAgentId('');
    setCreateOpen(true);
  };

  const closeCreateModal = () => {
    setCreateOpen(false);
  };

  const projectOptions = getProjectOptions(projects);

  const mergedModels = getMergedModels(backendId, providers, models);

  const parseSelectedModel = () => {
    if (!modelKey) return {};
    const sep = modelKey.indexOf('::');
    if (sep >= 0) {
      const provider = modelKey.slice(0, sep);
      const model = modelKey.slice(sep + 2);
      return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
    }
    return { model: modelKey };
  };

  const handleCreateTask = (autoStart = false) => {
    const cleanPrompt = prompt.trim();
    const targetProject = projectPath || defaultProject || '/';
    if (!cleanPrompt) return;

    postToHost({
      type: 'createTask',
      payload: {
        ...(title.trim() ? { title: title.trim() } : {}),
        prompt: cleanPrompt,
        projectPath: targetProject,
        backendId: backendId || 'dsh',
        ...parseSelectedModel(),
        ...(agentId ? { agentId } : {}),
        ...(autoStart ? { autoStart: true } : {}),
      },
    });
    setPrompt('');
    setTitle('');
    setCreateOpen(false);
  };

  const todoTasks = board.items.filter((item) => item.status === 'todo');
  const hasDone = board.items.some((item) => item.status === 'done');
  const hasRunning = board.items.some((item) => item.status === 'in_progress');

  const tasksByColumn = (col: TaskColumn): readonly KanbanTask[] =>
    board.items.filter((item) => item.status === col);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3.5 py-3" data-testid="workbench-tasks">
      {/* 顶栏：标题 + 按顺序执行开关 + 队列控制 */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15px] font-semibold tracking-tight text-ink">{t('wb.tasks.title')}</h2>
          <p className="mt-0.5 mb-0 text-[12px] text-ink-3">{t('wb.tasks.subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1 text-[12px] text-ink shadow-hairline">
            <span>{t('wb.tasks.autoRun')}</span>
            <Switch
              size="sm"
              data-testid="tasks-auto-run-switch"
              aria-label={t('wb.tasks.autoRun')}
              checked={board.autoRun}
              onCheckedChange={(autoRun) => postToHost({ type: 'setTaskQueueAutoRun', payload: { autoRun } })}
            />
          </div>

          {todoTasks.length > 0 && !hasRunning ? (
            <Button
              type="button"
              size="xs"
              data-testid="tasks-start-queue-btn"
              onClick={() => postToHost({ type: 'runTaskNow', payload: { id: todoTasks[0]!.id } })}
            >
              <PlayIcon className="size-3" />
              <span>{t('wb.tasks.runNext')}</span>
            </Button>
          ) : null}

          {hasDone ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="tasks-clear-done-btn"
              onClick={() => postToHost({ type: 'clearDoneTasks', payload: {} })}
            >
              <TrashIcon className="size-3" />
              <span>{t('wb.tasks.clearDone')}</span>
            </Button>
          ) : null}

          <Button type="button" size="sm" data-testid="task-new-btn" onClick={openCreateModal}>
            <PlusIcon className="size-3.5" />
            <span>{t('wb.tasks.new')}</span>
          </Button>
        </div>
      </div>

      {/* 新增任务模态弹窗（标题位于表单第一项） */}
      <TaskCreateDialog agents={agents} backends={backends} prompt={prompt} setPrompt={setPrompt} title={title} setTitle={setTitle} projectPath={projectPath} setProjectPath={setProjectPath} backendId={backendId} setBackendId={setBackendId} modelKey={modelKey} setModelKey={setModelKey} agentId={agentId} setAgentId={setAgentId} createOpen={createOpen} closeCreateModal={closeCreateModal} projectOptions={projectOptions} mergedModels={mergedModels} handleCreateTask={handleCreateTask} />

      {/* 四列响应式看板：宽屏四列并排，窄侧边栏纵向堆叠可滚动 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto min-[900px]:grid-cols-4 min-[900px]:overflow-x-auto">
        {TASK_COLUMNS.map((col) => {
          const items = tasksByColumn(col);
          return (
            <section
              key={col}
              className="flex min-h-40 flex-col overflow-hidden rounded-card bg-surface shadow-card min-[900px]:min-h-0"
              data-testid={`kanban-col-${col}`}
            >
              <div className="primitive-card-bar flex shrink-0 items-center justify-between gap-2 border-b border-line bg-inset/50">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      col === 'todo'
                        ? 'bg-ink-3'
                        : col === 'in_progress'
                          ? 'bg-brand'
                          : col === 'review'
                            ? 'bg-orange'
                            : 'bg-green',
                    )}
                  />
                  <h3 className="m-0 text-[12.5px] font-semibold text-ink">
                    {t(`wb.tasks.col.${col}` as MessageKey)}
                  </h3>
                  <ValuePill tone={col === 'in_progress' && items.length > 0 ? 'accent' : 'neutral'}>
                    {items.length}
                  </ValuePill>
                </div>
                {col === 'todo' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-testid="kanban-todo-add-btn"
                    aria-label={t('wb.tasks.new')}
                    title={t('wb.tasks.new')}
                    onClick={openCreateModal}
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                {items.length === 0 ? (
                  <div className="py-4 text-center text-[12px] text-ink-3">{t('wb.tasks.emptyCol')}</div>
                ) : (
                  items.map((task, idx) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      idx={idx}
                      isLast={idx === items.length - 1}
                      col={col}
                      hasRunning={hasRunning}
                      backends={backends}
                      agents={agents}
                      projects={projects}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

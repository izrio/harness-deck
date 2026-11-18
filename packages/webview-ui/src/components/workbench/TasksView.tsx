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
  ArrowDownIcon,
  ArrowUpIcon,
  ChatIcon,
  CheckIcon,
  KanbanIcon,
  PlayIcon,
  PlusIcon,
  ReplyIcon,
  SpinnerIcon,
  TerminalIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

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

  const projectOptions = (() => {
    const map = new Map<string, string>();
    if (projects.currentPath) {
      const curName =
        projects.recent.find((r) => r.path === projects.currentPath)?.name ??
        projects.currentPath.split(/[\\/]/u).pop() ??
        projects.currentPath;
      map.set(projects.currentPath, curName);
    }
    for (const r of projects.recent) {
      if (!map.has(r.path)) map.set(r.path, r.name);
    }
    return [...map.entries()];
  })();

  const mergedModels = (() => {
    const seen = new Set<string>();
    const list: { key: string; label: string }[] = [];
    const orderedProviders = [
      ...providers.filter((p) => p.boundBackendIds.includes(backendId)),
      ...providers.filter((p) => !p.boundBackendIds.includes(backendId)),
    ];
    for (const p of orderedProviders) {
      for (const m of p.models) {
        const key = `${p.id}::${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ key, label: `${m.name || m.id} (${p.name})` });
      }
    }
    for (const m of models.options) {
      const key = `${m.provider}::${m.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ key, label: `${m.name} (${m.group})` });
    }
    return list;
  })();

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
      <Dialog open={createOpen} onOpenChange={(open) => !open && closeCreateModal()}>
        <DialogContent data-testid="kanban-task-creator" aria-modal="true" className="sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[14px]">
              <KanbanIcon className="size-4 text-accent-ink" />
              <span>{t('wb.tasks.new')}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">{t('wb.tasks.subtitle')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.fieldTitle')}</span>
              <Input
                data-testid="task-input-title"
                value={title}
                placeholder={t('wb.tasks.newTitlePlaceholder')}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.fieldPrompt')}</span>
              <Textarea
                data-testid="task-input-prompt"
                rows={4}
                value={prompt}
                placeholder={t('wb.tasks.newPlaceholder')}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleCreateTask(false);
                  }
                }}
              />
            </label>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 [&_[data-slot=native-select-wrapper]]:w-full">
              {projectOptions.length > 0 ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.selectProject')}</span>
                  <NativeSelect
                    size="sm"
                    data-testid="task-select-project"
                    aria-label={t('wb.tasks.selectProject')}
                    value={projectPath}
                    onChange={(e) => setProjectPath(e.target.value)}
                  >
                    {projectOptions.map(([path, label]) => (
                      <NativeSelectOption key={path} value={path}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.selectHarness')}</span>
                <NativeSelect
                  size="sm"
                  data-testid="task-select-harness"
                  aria-label={t('wb.tasks.selectHarness')}
                  value={backendId}
                  onChange={(e) => setBackendId(e.target.value)}
                >
                  {(backends.items.length > 0 ? backends.items : [{ id: 'dsh', name: 'DeepSeek' }]).map((b) => (
                    <NativeSelectOption key={b.id} value={b.id}>
                      {b.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.selectModel')}</span>
                <NativeSelect
                  size="sm"
                  data-testid="task-select-model"
                  aria-label={t('wb.tasks.selectModel')}
                  value={modelKey}
                  onChange={(e) => setModelKey(e.target.value)}
                >
                  <NativeSelectOption value="">{t('wb.tasks.modelAuto')}</NativeSelectOption>
                  {mergedModels.map((m) => (
                    <NativeSelectOption key={m.key} value={m.key}>
                      {m.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>

              {agents.length > 0 ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.selectAgent')}</span>
                  <NativeSelect
                    size="sm"
                    data-testid="task-select-agent"
                    aria-label={t('wb.tasks.selectAgent')}
                    value={agentId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setAgentId(nextId);
                      const chosen = agents.find((a) => a.id === nextId);
                      if (chosen) {
                        setBackendId(chosen.backendId);
                        if (chosen.model) setModelKey(`${chosen.provider ?? ''}::${chosen.model}`);
                      }
                    }}
                  >
                    <NativeSelectOption value="">{t('wb.tasks.agentNone')}</NativeSelectOption>
                    {agents.map((a) => (
                      <NativeSelectOption key={a.id} value={a.id}>
                        {a.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" data-testid="task-cancel-btn" onClick={closeCreateModal}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="task-create-run-btn"
              disabled={!prompt.trim()}
              onClick={() => handleCreateTask(true)}
            >
              <PlayIcon className="size-3" />
              <span>{t('wb.tasks.runNow')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="task-create-btn"
              disabled={!prompt.trim()}
              onClick={() => handleCreateTask(false)}
            >
              <PlusIcon className="size-3" />
              <span>{t('wb.tasks.add')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                          ? 'bg-accent'
                          : col === 'review'
                            ? 'bg-orange'
                            : 'bg-emerald-500',
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
                  items.map((task, idx) => {
                    const backendName = backends.items.find((b) => b.id === task.backendId)?.name ?? task.backendId;
                    const assignedAgent = task.agentId ? agents.find((a) => a.id === task.agentId) : undefined;
                    const hasVerify = (projects.configs[task.projectPath]?.verifyCommands.length ?? 0) > 0;

                    return (
                      <article
                        key={task.id}
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
                                  disabled={idx === items.length - 1}
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
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 工作台 · 任务模块（TasksView）
 *
 * 四列扁平看板：待执行（todo）、执行中（in_progress）、待验收（review）、已完成（done）。
 * 支持即时顺序队列与定时触发任务，通过顶部「新增任务」或左侧栏「+」打开创建弹窗。
 */
import { useEffect, useMemo, useState } from 'react';
import { TASK_COLUMNS, type TaskColumn } from '@harness-deck/shared/limits';
import type { KanbanTask, ModelOption, PermissionState, ScheduleFrequency } from '@harness-deck/shared';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { consumePendingCreateTask, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { PlayIcon, PlusIcon, TrashIcon } from '../icons.tsx';
import { getProjectOptions } from '@/lib/workbenchOptions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { ModelPickerSelection } from '../ModelPicker.tsx';
import { TaskCard } from './tasks/TaskCard.tsx';
import { TaskCreateDialog } from './tasks/TaskCreateDialog.tsx';

let nextBackendModelFetchId = 1;

function defaultOnceDateTime(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resolveDefaultPermission(perms?: PermissionState): string {
  if (!perms) return 'auto';
  return (
    perms.current ??
    (perms.options.includes('auto')
      ? 'auto'
      : perms.options.includes('workspace-write')
        ? 'workspace-write'
        : perms.options[0]) ??
    'auto'
  );
}

export function TasksView() {
  const t = useT();
  const board = useView((s) => s.workbench.tasks);
  const agents = useView((s) => s.workbench.agents);
  const backends = useView((s) => s.backends);
  const providers = useView((s) => s.providers.items);
  const models = useView((s) => s.models);
  const permissions = useView((s) => s.permissions);
  const backendModelsCache = useView((s) => s.backendModelsCache);
  const projects = useView((s) => s.projects);
  const pendingCreateTask = useView((s) => s.pendingCreateTask);

  const defaultProject = projects.currentPath ?? projects.recent[0]?.path ?? '';

  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [projectPath, setProjectPath] = useState(defaultProject);
  const [backendId, setBackendId] = useState(backends.active || 'dsh');
  const [selectedModel, setSelectedModel] = useState<ModelPickerSelection | undefined>(undefined);
  const [permissionPreset, setPermissionPreset] = useState<string>(() => resolveDefaultPermission(permissions));
  const [agentId, setAgentId] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [freqKind, setFreqKind] = useState<ScheduleFrequency['kind']>('once');
  const [timeHm, setTimeHm] = useState('09:00');
  const [weekDays, setWeekDays] = useState<number[]>([1, 3, 5]);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [onceDateTime, setOnceDateTime] = useState(defaultOnceDateTime);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingFetch, setPendingFetch] = useState<{ readonly requestId: number; readonly backendId: string } | undefined>();

  useEffect(() => {
    if (!projectPath && defaultProject) {
      setProjectPath(defaultProject);
    }
  }, [projectPath, defaultProject]);

  const requestBackendModels = (targetBackendId: string) => {
    const requestId = ++nextBackendModelFetchId;
    setPendingFetch({ requestId, backendId: targetBackendId });
    postToHost({ type: 'fetchBackendModels', payload: { requestId, backendId: targetBackendId } });
  };

  const resetCreateForm = () => {
    const initBackend = backends.active || 'dsh';
    setTitle('');
    setPrompt('');
    setProjectPath(defaultProject);
    setBackendId(initBackend);
    setSelectedModel(models.current ? { ...models.current } : undefined);
    setPermissionPreset(resolveDefaultPermission(permissions));
    setAgentId('');
    setUseWorktree(false);
    setWorktreeBranch('');
    setScheduleEnabled(false);
    setFreqKind('once');
    setTimeHm('09:00');
    setWeekDays([1, 3, 5]);
    setIntervalMinutes(60);
    setOnceDateTime(defaultOnceDateTime());
    setPendingFetch(undefined);
  };

  useEffect(() => {
    if (!pendingCreateTask) return;
    consumePendingCreateTask();
    resetCreateForm();
    setCreateOpen(true);
  }, [pendingCreateTask]);

  const openCreateModal = () => {
    resetCreateForm();
    setCreateOpen(true);
  };

  const closeCreateModal = () => {
    setCreateOpen(false);
    setPendingFetch(undefined);
  };

  const projectOptions = getProjectOptions(projects);

  const cachedForBackend = backendId === backends.active ? undefined : backendModelsCache[backendId];
  const modelsLoading = Boolean(
    pendingFetch &&
      pendingFetch.backendId === backendId &&
      (!cachedForBackend || cachedForBackend.requestId < pendingFetch.requestId),
  );

  const pickerModelOptions = useMemo<readonly ModelOption[]>(() => {
    const seen = new Set<string>();
    const list: ModelOption[] = [];
    // 优先展示绑定到当前选中运行时的第三方服务商模型
    for (const p of providers.filter((item) => item.boundBackendIds.includes(backendId))) {
      for (const m of p.models) {
        const key = `${p.id}::${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          provider: p.id,
          model: m.id,
          name: m.name || m.id,
          group: p.name,
          efforts: (m.efforts ?? []).map((id) => ({ id, name: id })),
        });
      }
    }
    // 再加入所选运行时自身的模型列表（非当前活跃运行时走按需拉取的缓存）
    const runtimeOptions = backendId === backends.active ? models.options : (cachedForBackend?.models.options ?? []);
    for (const m of runtimeOptions) {
      const key = `${m.provider}::${m.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(m);
    }
    return list;
  }, [backendId, backends.active, providers, models.options, cachedForBackend]);

  const runtimePermissions = backendId === backends.active ? permissions : (cachedForBackend?.permissions ?? permissions);

  // 切换运行时拉取到新模型与权限列表后，自动更新选中模型与权限
  useEffect(() => {
    if (!createOpen || !pendingFetch || pendingFetch.backendId !== backendId) return;
    if (!cachedForBackend || cachedForBackend.requestId < pendingFetch.requestId) return;
    setPendingFetch(undefined);
    const fetchedModels = cachedForBackend.models;
    setSelectedModel((prev) => {
      if (prev && pickerModelOptions.some((o) => (prev.provider ? o.provider === prev.provider : true) && o.model === prev.model)) {
        return prev;
      }
      if (fetchedModels.current) return { ...fetchedModels.current };
      const first = pickerModelOptions[0];
      return first ? { provider: first.provider, model: first.model, ...(first.defaultEffort ? { reasoningEffort: first.defaultEffort } : {}) } : undefined;
    });
    if (cachedForBackend.permissions && cachedForBackend.permissions.options.length > 0) {
      const nextPerms = cachedForBackend.permissions;
      setPermissionPreset((prev) => (nextPerms.options.includes(prev) ? prev : resolveDefaultPermission(nextPerms)));
    }
  }, [createOpen, pendingFetch, backendId, cachedForBackend, pickerModelOptions]);

  const handleSelectBackend = (nextBackendId: string, explicitModel?: ModelPickerSelection) => {
    setBackendId(nextBackendId);
    if (explicitModel) {
      setSelectedModel(explicitModel);
    } else if (nextBackendId === backends.active) {
      setSelectedModel(models.current ? { ...models.current } : undefined);
      setPermissionPreset(resolveDefaultPermission(permissions));
    } else {
      const cached = backendModelsCache[nextBackendId];
      setSelectedModel(cached?.models.current ? { ...cached.models.current } : undefined);
      if (cached?.permissions && cached.permissions.options.length > 0) {
        setPermissionPreset(resolveDefaultPermission(cached.permissions));
      }
    }
    if (nextBackendId !== backends.active) {
      requestBackendModels(nextBackendId);
    } else {
      setPendingFetch(undefined);
    }
  };

  const buildSchedule = () => {
    if (!scheduleEnabled) return undefined;
    switch (freqKind) {
      case 'daily':
        return { kind: 'daily' as const, time: timeHm || '09:00' };
      case 'weekly':
        return { kind: 'weekly' as const, days: weekDays.length > 0 ? [...weekDays] : [1], time: timeHm || '09:00' };
      case 'interval':
        return { kind: 'interval' as const, minutes: Math.max(1, Math.min(10_080, Math.round(intervalMinutes || 60))) };
      case 'once': {
        const parsed = Date.parse(onceDateTime);
        return { kind: 'once' as const, runAt: Number.isFinite(parsed) ? parsed : Date.now() + 60 * 60_000 };
      }
    }
  };

  const toggleWeekDay = (day: number) => {
    setWeekDays((prev) =>
      prev.includes(day) ? (prev.length > 1 ? prev.filter((d) => d !== day) : prev) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const handleCreateTask = (autoStart = false) => {
    const cleanPrompt = prompt.trim();
    const targetProject = projectPath || defaultProject || '/';
    if (!cleanPrompt) return;
    const schedule = buildSchedule();

    postToHost({
      type: 'createTask',
      payload: {
        ...(title.trim() ? { title: title.trim() } : {}),
        prompt: cleanPrompt,
        projectPath: targetProject,
        backendId: backendId || 'dsh',
        ...(selectedModel?.provider ? { provider: selectedModel.provider } : {}),
        ...(selectedModel?.model ? { model: selectedModel.model } : {}),
        ...(selectedModel?.reasoningEffort ? { reasoningEffort: selectedModel.reasoningEffort } : {}),
        ...(agentId ? { agentId } : {}),
        ...(permissionPreset ? { permissionPreset } : {}),
        ...(useWorktree ? { useWorktree: true, ...(worktreeBranch.trim() ? { worktreeBranch: worktreeBranch.trim() } : {}) } : {}),
        ...(schedule ? { schedule } : {}),
        ...(autoStart ? { autoStart: true } : {}),
      },
    });
    setPrompt('');
    setTitle('');
    setCreateOpen(false);
    setPendingFetch(undefined);
  };

  const todoTasks = board.items.filter((item) => item.status === 'todo');
  const hasDone = board.items.some((item) => item.status === 'done');
  const hasRunning = board.items.some((item) => item.status === 'in_progress');

  const tasksByColumn = (col: TaskColumn): readonly KanbanTask[] =>
    board.items.filter((item) => item.status === col);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3" data-testid="workbench-tasks">
      {/* 顶栏：标题 + 等高 sm 操作控件（仅「新增任务」为主色按钮） */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[15px] font-semibold tracking-tight text-ink">{t('wb.tasks.title')}</h2>
          <p className="mt-0.5 mb-0 text-[12px] text-ink-3">{t('wb.tasks.subtitle')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex h-8 items-center gap-2 rounded-control border border-line/85 bg-surface px-2.5 text-[12.5px] text-ink shadow-xs">
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
              variant="outline"
              size="sm"
              data-testid="tasks-start-queue-btn"
              onClick={() => postToHost({ type: 'runTaskNow', payload: { id: todoTasks[0]!.id } })}
            >
              <PlayIcon className="size-3.5" />
              <span>{t('wb.tasks.runNext')}</span>
            </Button>
          ) : null}

          {hasDone ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="tasks-clear-done-btn"
              onClick={() => postToHost({ type: 'clearDoneTasks', payload: {} })}
            >
              <TrashIcon className="size-3.5" />
              <span>{t('wb.tasks.clearDone')}</span>
            </Button>
          ) : null}

          <Button type="button" size="sm" data-testid="task-new-btn" onClick={openCreateModal}>
            <PlusIcon className="size-3.5" />
            <span>{t('wb.tasks.new')}</span>
          </Button>
        </div>
      </div>

      {/* 新增任务模态弹窗 */}
      <TaskCreateDialog
        agents={agents}
        backends={backends}
        prompt={prompt}
        setPrompt={setPrompt}
        title={title}
        setTitle={setTitle}
        projectPath={projectPath}
        setProjectPath={setProjectPath}
        backendId={backendId}
        onSelectBackend={handleSelectBackend}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        modelsLoading={modelsLoading}
        runtimePermissions={runtimePermissions}
        permissionPreset={permissionPreset}
        setPermissionPreset={setPermissionPreset}
        agentId={agentId}
        setAgentId={setAgentId}
        useWorktree={useWorktree}
        setUseWorktree={setUseWorktree}
        worktreeBranch={worktreeBranch}
        setWorktreeBranch={setWorktreeBranch}
        scheduleEnabled={scheduleEnabled}
        setScheduleEnabled={setScheduleEnabled}
        freqKind={freqKind}
        setFreqKind={setFreqKind}
        timeHm={timeHm}
        setTimeHm={setTimeHm}
        weekDays={weekDays}
        toggleWeekDay={toggleWeekDay}
        intervalMinutes={intervalMinutes}
        setIntervalMinutes={setIntervalMinutes}
        onceDateTime={onceDateTime}
        setOnceDateTime={setOnceDateTime}
        createOpen={createOpen}
        closeCreateModal={closeCreateModal}
        projectOptions={projectOptions}
        modelOptions={pickerModelOptions}
        handleCreateTask={handleCreateTask}
      />

      {/* 四列单层看板：每列是一个单层 Card，内部细线分隔任务行，无框套框 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto min-[900px]:grid-cols-4 min-[900px]:overflow-x-auto">
        {TASK_COLUMNS.map((col) => {
          const items = tasksByColumn(col);
          return (
            <Card
              key={col}
              className="flex min-h-0 flex-col gap-0 overflow-hidden py-0 shadow-xs"
              data-testid={`kanban-col-${col}`}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/70 bg-inset/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
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
                  <span className="text-[11.5px] font-medium text-ink-3 tabular-nums">{items.length}</span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {items.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[12px] text-ink-3">{t('wb.tasks.emptyCol')}</div>
                ) : (
                  <div className="divide-y divide-line/70">
                    {items.map((task, idx) => (
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
                    ))}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentProfile, BackendsState, ModelOption, PermissionState, ScheduleFrequency } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { activeAtToken, formatFileMention, type ActiveAtToken } from '../../../mentions.ts';
import { useView } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import { BackendLogo } from '../../BackendLogo.tsx';
import { GlideMenu } from '../../beautifului/index.ts';
import { Completion, type CompletionItem } from '../../Completion.tsx';
import { CheckIcon, ChecklistIcon, ChevronDownIcon, PaperclipIcon, PlayIcon, PlusIcon } from '../../icons.tsx';
import { ModelPicker, type ModelPickerSelection } from '../../ModelPicker.tsx';
import { PermissionPicker } from '../../PermissionPicker.tsx';

const SEARCH_DELAY_MS = 60;
const FALLBACK_PERMISSIONS = ['auto', 'workspace-write', 'read-only', 'danger-full-access'] as const;

let nextTaskSearchId = 500_000;

function fileTriggerAt(text: string, caret: number): { readonly token: ActiveAtToken; readonly start: number } | undefined {
  const before = text.slice(0, caret);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const token = activeAtToken(line);
  return token ? { token, start: caret - token.prefix.length } : undefined;
}

function formatPickedMention(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

export function TaskCreateDialog({
  agents,
  backends,
  prompt,
  setPrompt,
  title,
  setTitle,
  projectPath,
  setProjectPath,
  backendId,
  onSelectBackend,
  selectedModel,
  setSelectedModel,
  modelsLoading,
  runtimePermissions,
  permissionPreset,
  setPermissionPreset,
  agentId,
  setAgentId,
  useWorktree,
  setUseWorktree,
  worktreeBranch,
  setWorktreeBranch,
  scheduleEnabled,
  setScheduleEnabled,
  freqKind,
  setFreqKind,
  timeHm,
  setTimeHm,
  weekDays,
  toggleWeekDay,
  intervalMinutes,
  setIntervalMinutes,
  onceDateTime,
  setOnceDateTime,
  createOpen,
  closeCreateModal,
  projectOptions,
  modelOptions,
  handleCreateTask,
}: {
  agents: readonly AgentProfile[];
  backends: BackendsState;
  prompt: string;
  setPrompt: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  projectPath: string;
  setProjectPath: (v: string) => void;
  backendId: string;
  onSelectBackend: (nextBackendId: string, explicitModel?: ModelPickerSelection) => void;
  selectedModel: ModelPickerSelection | undefined;
  setSelectedModel: (v: ModelPickerSelection | undefined) => void;
  modelsLoading: boolean;
  runtimePermissions: PermissionState;
  permissionPreset: string;
  setPermissionPreset: (v: string) => void;
  agentId: string;
  setAgentId: (v: string) => void;
  useWorktree: boolean;
  setUseWorktree: (v: boolean) => void;
  worktreeBranch: string;
  setWorktreeBranch: (v: string) => void;
  scheduleEnabled: boolean;
  setScheduleEnabled: (v: boolean) => void;
  freqKind: ScheduleFrequency['kind'];
  setFreqKind: (v: ScheduleFrequency['kind']) => void;
  timeHm: string;
  setTimeHm: (v: string) => void;
  weekDays: readonly number[];
  toggleWeekDay: (day: number) => void;
  intervalMinutes: number;
  setIntervalMinutes: (v: number) => void;
  onceDateTime: string;
  setOnceDateTime: (v: string) => void;
  createOpen: boolean;
  closeCreateModal: () => void;
  projectOptions: readonly [string, string][];
  modelOptions: readonly ModelOption[];
  handleCreateTask: (autoStart?: boolean) => void;
}) {
  const t = useT();
  const connected = useView((s) => s.connection === 'connected');
  const candidates = useView((s) => s.fileCandidates);
  const pendingTaskFiles = useView((s) => s.pendingTaskFiles);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledFilesRef = useRef(pendingTaskFiles.n);
  const [caret, setCaret] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | undefined>();
  const [requestId, setRequestId] = useState(-1);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);

  const trigger = createOpen && dismissedFor !== prompt ? fileTriggerAt(prompt, caret) : undefined;
  const fileQuery = trigger?.token.query;

  useEffect(() => {
    if (!createOpen) {
      setRuntimeMenuOpen(false);
      return;
    }
    handledFilesRef.current = pendingTaskFiles.n;
  }, [createOpen]);

  useEffect(() => {
    if (!createOpen || pendingTaskFiles.n === handledFilesRef.current || pendingTaskFiles.paths.length === 0) return;
    handledFilesRef.current = pendingTaskFiles.n;
    const insertion = pendingTaskFiles.paths.map(formatPickedMention).join(' ');
    const el = textareaRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const needLeadingSpace = start > 0 && !/\s/u.test(prompt[start - 1] ?? '');
    const chunk = `${needLeadingSpace ? ' ' : ''}${insertion} `;
    const next = prompt.slice(0, start) + chunk + prompt.slice(end);
    const nextCaret = start + chunk.length;
    setPrompt(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }, [createOpen, pendingTaskFiles, prompt, setPrompt]);

  useEffect(() => {
    if (fileQuery === undefined || !connected) return;
    const id = ++nextTaskSearchId;
    setRequestId(id);
    const timer = setTimeout(() => {
      postToHost({ type: 'searchFiles', payload: { requestId: id, query: fileQuery } });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fileQuery, connected]);

  const completionItems: CompletionItem[] = useMemo(() => {
    if (!trigger || candidates.requestId < 0) return [];
    return candidates.items.map((c) => {
      const slash = c.path.lastIndexOf('/');
      return {
        key: `${c.kind}:${c.path}`,
        icon: c.kind,
        label: slash >= 0 ? c.path.slice(slash + 1) : c.path,
        ...(slash >= 0 ? { detail: c.path.slice(0, slash) } : {}),
      };
    });
  }, [trigger, candidates]);

  useEffect(() => setSelectedIdx(0), [completionItems.length, fileQuery]);

  const complete = trigger ? candidates.items.some((c) => c.kind === 'file' && c.path === trigger.token.query) : false;
  const menuOpen = trigger !== undefined && !complete && (completionItems.length > 0 || connected);

  const acceptCandidate = (index: number) => {
    if (!trigger) return;
    const candidate = candidates.items[index];
    if (!candidate) return;
    const mention = formatFileMention(candidate, trigger.token.quoted);
    if (!mention) return;
    const insertion = candidate.kind === 'file' ? `${mention} ` : mention;
    const next = prompt.slice(0, trigger.start) + insertion + prompt.slice(caret);
    const nextPos = trigger.start + insertion.length;
    setPrompt(next);
    setCaret(nextPos);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextPos, nextPos);
    });
  };

  const onPromptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (menuOpen && !composing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (completionItems.length > 0) {
          setSelectedIdx((selectedIdx + (e.key === 'ArrowDown' ? 1 : completionItems.length - 1)) % completionItems.length);
        }
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (completionItems.length > 0) {
          e.preventDefault();
          acceptCandidate(selectedIdx);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedFor(prompt);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleCreateTask(false);
    }
  };

  const syncCaret = () => setCaret(textareaRef.current?.selectionStart ?? 0);

  const runtimeItems = useMemo(
    () => (backends.items.length > 0 ? backends.items : [{ id: 'dsh', name: 'DeepSeek' }]),
    [backends.items],
  );
  const currentBackend = runtimeItems.find((b) => b.id === backendId) ?? { id: backendId || 'dsh', name: backendId || 'DeepSeek' };
  const supportsWorktree =
    'capabilities' in currentBackend && currentBackend.capabilities ? currentBackend.capabilities.worktree : true;

  const permissionOptions = useMemo(
    () => (runtimePermissions.options.length > 0 ? runtimePermissions.options : FALLBACK_PERMISSIONS),
    [runtimePermissions.options],
  );
  const permissionLabels = useMemo(
    () =>
      runtimePermissions.options.length > 0
        ? runtimePermissions.labels
        : {
            auto: { name: 'Auto', description: t('permission.hint.auto') },
          },
    [runtimePermissions.options.length, runtimePermissions.labels, t],
  );

  return (
    <Dialog open={createOpen} onOpenChange={(open) => !open && closeCreateModal()}>
      <DialogContent data-testid="kanban-task-creator" aria-modal="true" className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <ChecklistIcon className="size-4 text-accent-ink" data-testid="task-dialog-icon" />
            <span>{t('wb.tasks.new')}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">{t('wb.tasks.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 1. 任务标题（第一项） */}
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.fieldTitle')}</span>
            <Input
              size="sm"
              data-testid="task-input-title"
              value={title}
              placeholder={t('wb.tasks.newTitlePlaceholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          {/* 2. 任务内容：复用会话输入框样式与交互（文件、运行时、模型、Auto，不展示用量与上下文） */}
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-2">{t('wb.tasks.fieldPrompt')}</span>
            <div className="relative" data-testid="task-composer">
              {menuOpen && trigger ? (
                <Completion
                  items={completionItems}
                  selected={selectedIdx}
                  onSelect={acceptCandidate}
                  onHover={setSelectedIdx}
                  label={t('completion.files')}
                  empty={t('completion.noFiles')}
                  {...(requestId !== candidates.requestId ? { loading: t('completion.searching') } : {})}
                />
              ) : null}

              <div className="composer surface-glass relative flex flex-col rounded-2xl border border-black/8 p-1.5 shadow-[var(--shadow-composer)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/45 focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_30%,transparent),var(--shadow-composer)] dark:border-white/[0.07] dark:inset-shadow-[0_1px_rgb(255_255_255/3%)]">
                <textarea
                  ref={textareaRef}
                  data-testid="task-input-prompt"
                  rows={6}
                  value={prompt}
                  placeholder={t('wb.tasks.newPlaceholder')}
                  aria-label={t('wb.tasks.fieldPrompt')}
                  aria-autocomplete="list"
                  aria-expanded={menuOpen}
                  className="composer__input block max-h-72 min-h-36 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 pt-1.5 pb-1 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink-3"
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setCaret(e.target.selectionStart);
                  }}
                  onSelect={syncCaret}
                  onClick={syncCaret}
                  onKeyDown={onPromptKeyDown}
                />

                <div className="composer__toolbar flex min-w-0 items-center gap-1 pt-1 [&>*]:flex-none [&>.model-picker]:min-w-0 [&>.model-picker]:flex-[0_1_auto]">
                  <button
                    type="button"
                    data-testid="task-attach-btn"
                    aria-label={t('composer.attach')}
                    title={t('composer.attach')}
                    onClick={() => postToHost({ type: 'pickTaskFiles', payload: { projectPath } })}
                    className="inline-flex size-7 items-center justify-center rounded-[8px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                  >
                    <PaperclipIcon className="size-4" />
                  </button>

                  {/* 运行时选择器（置于模型选择器前面，带运行时图标；切换时刷新模型列表） */}
                  <div className="relative min-w-0">
                    <Popover open={runtimeMenuOpen} onOpenChange={setRuntimeMenuOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-testid="task-runtime-picker"
                          aria-label={t('wb.tasks.selectHarness')}
                          title={t('wb.tasks.selectHarness')}
                          className="toolbar-button inline-flex h-7 max-w-full items-center gap-1.5 rounded-[8px] px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
                        >
                          <BackendLogo backend={currentBackend} size="sm" />
                          <span className="toolbar-button__text min-w-0 truncate">{currentBackend.name}</span>
                          <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="top"
                        align="start"
                        sideOffset={6}
                        aria-label={t('wb.tasks.selectHarness')}
                        className="model-menu flex max-h-72 w-auto min-w-[200px] max-w-[min(280px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl p-1 shadow-overlay"
                      >
                        <div role="menu" className="max-h-60 overflow-y-auto" data-testid="task-runtime-list">
                          <GlideMenu className="flex flex-col gap-0.5" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
                            {runtimeItems.map((b) => {
                              const active = b.id === currentBackend.id;
                              return (
                                <button
                                  key={b.id}
                                  type="button"
                                  data-menu-row
                                  role="menuitemradio"
                                  aria-checked={active}
                                  data-testid={`task-runtime-option-${b.id}`}
                                  onClick={() => {
                                    setRuntimeMenuOpen(false);
                                    if (b.id !== backendId) {
                                      onSelectBackend(b.id);
                                    }
                                  }}
                                  className={cn(
                                    'menu-item relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[12.5px] transition-colors duration-100',
                                    active
                                      ? 'menu-item--active bg-field font-medium text-ink group-hover/glide-menu:bg-transparent'
                                      : 'text-ink-2 hover:text-ink',
                                  )}
                                >
                                  <span className="inline-flex w-3.5 shrink-0 text-ink">
                                    {active ? <CheckIcon className="size-3.5" strokeWidth={2.2} /> : null}
                                  </span>
                                  <BackendLogo backend={b} size="sm" />
                                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                                </button>
                              );
                            })}
                          </GlideMenu>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>

                  <ModelPicker
                    disabled={false}
                    value={selectedModel}
                    options={modelOptions}
                    onSelect={setSelectedModel}
                    hideChannelSwitcher
                    loading={modelsLoading}
                    placeholder={t('wb.tasks.modelAuto')}
                    testId="task-model-picker"
                  />

                  <span className="composer__spacer min-w-0 flex-1!" />

                  <PermissionPicker
                    disabled={false}
                    value={permissionPreset}
                    options={permissionOptions}
                    labels={permissionLabels}
                    onSelect={setPermissionPreset}
                    testId="task-permission-picker"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* 3. 项目 / 委派智能体 */}
          {projectOptions.length > 0 || agents.length > 0 ? (
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
                        const explicitModel = chosen.model
                          ? {
                              ...(chosen.provider ? { provider: chosen.provider } : {}),
                              model: chosen.model,
                              ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
                            }
                          : undefined;
                        onSelectBackend(chosen.backendId, explicitModel);
                        setPermissionPreset(chosen.tools.permissionPreset);
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
          ) : null}

          {/* 4. 可选独立 Worktree 隔离执行 */}
          {supportsWorktree ? (
            <div className="flex flex-col gap-2.5 rounded-lg border border-line/80 bg-inset/45 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-ink">{t('wb.tasks.worktreeToggle')}</span>
                <Switch
                  size="sm"
                  data-testid="task-worktree-toggle"
                  aria-label={t('wb.tasks.worktreeToggle')}
                  checked={useWorktree}
                  onCheckedChange={setUseWorktree}
                />
              </div>

              {useWorktree ? (
                <div className="border-t border-line/60 pt-2.5">
                  <Input
                    size="sm"
                    data-testid="task-worktree-branch"
                    value={worktreeBranch}
                    placeholder={t('wb.tasks.worktreeBranchPlaceholder')}
                    aria-label={t('wb.tasks.worktreeBranchPlaceholder')}
                    onChange={(e) => setWorktreeBranch(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 5. 可选定时设置（融合原「定时」模块能力） */}
          <div className="flex flex-col gap-2.5 rounded-lg border border-line/80 bg-inset/45 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink">{t('wb.tasks.scheduleToggle')}</span>
              <Switch
                size="sm"
                data-testid="task-schedule-toggle"
                aria-label={t('wb.tasks.scheduleToggle')}
                checked={scheduleEnabled}
                onCheckedChange={setScheduleEnabled}
              />
            </div>

            {scheduleEnabled ? (
              <div className="flex flex-col gap-2 border-t border-line/60 pt-2.5">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 [&_[data-slot=native-select-wrapper]]:w-full">
                  <NativeSelect
                    size="sm"
                    data-testid="task-schedule-freq"
                    aria-label={t('wb.schedules.fieldWhen')}
                    value={freqKind}
                    onChange={(e) => setFreqKind(e.target.value as ScheduleFrequency['kind'])}
                  >
                    <NativeSelectOption value="once">{t('wb.schedules.freqOnce')}</NativeSelectOption>
                    <NativeSelectOption value="daily">{t('wb.schedules.freqDaily')}</NativeSelectOption>
                    <NativeSelectOption value="weekly">{t('wb.schedules.freqWeekly')}</NativeSelectOption>
                    <NativeSelectOption value="interval">{t('wb.schedules.freqInterval')}</NativeSelectOption>
                  </NativeSelect>

                  {freqKind === 'daily' || freqKind === 'weekly' ? (
                    <Input
                      size="sm"
                      type="time"
                      data-testid="task-schedule-time"
                      value={timeHm}
                      aria-label={t('wb.schedules.atTime')}
                      onChange={(e) => setTimeHm(e.target.value)}
                    />
                  ) : freqKind === 'interval' ? (
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      max={10080}
                      data-testid="task-schedule-interval"
                      value={String(intervalMinutes)}
                      aria-label={t('wb.schedules.everyMinutes')}
                      onChange={(e) => setIntervalMinutes(Number(e.target.value) || 60)}
                    />
                  ) : (
                    <Input
                      size="sm"
                      type="datetime-local"
                      data-testid="task-schedule-once"
                      value={onceDateTime}
                      aria-label={t('wb.schedules.onceAt')}
                      onChange={(e) => setOnceDateTime(e.target.value)}
                    />
                  )}
                </div>

                {freqKind === 'weekly' ? (
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <Button
                        key={d}
                        type="button"
                        variant={weekDays.includes(d) ? 'default' : 'outline'}
                        size="xs"
                        data-testid={`task-schedule-day-${d}`}
                        aria-pressed={weekDays.includes(d)}
                        onClick={() => toggleWeekDay(d)}
                      >
                        {t(`wb.schedules.day${d}` as MessageKey)}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
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
  );
}

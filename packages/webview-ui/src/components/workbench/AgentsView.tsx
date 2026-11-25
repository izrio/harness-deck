/**
 * 工作台 · 智能体模块（AgentsView）
 *
 * 保存专长（specialty）、指令（instructions）、模型与底层配置、工具开关与权限预设；
 * 支持一键「开始会话」或直接「委派任务」至任务看板按序执行。
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile, AgentToolConfig, ModelOption } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  AgentIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  TrashIcon,
} from '../icons.tsx';
import { BackendLogo } from '../BackendLogo.tsx';
import { focusActiveMenuRow, GlideMenu, ValuePill } from '../beautifului/index.ts';
import { ModelPicker, type ModelPickerSelection } from '../ModelPicker.tsx';
import { PermissionPicker } from '../PermissionPicker.tsx';
import { getProjectOptions } from '@/lib/workbenchOptions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

let nextAgentModelFetchId = 200_000;

const AGENT_PERMISSION_OPTIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const;

const DEFAULT_TOOLS: AgentToolConfig = {
  permissionPreset: 'workspace-write',
  readSearch: true,
  editWrite: true,
  bashCommand: true,
  webFetch: false,
  mcpTools: true,
};

export function AgentsView() {
  const t = useT();
  const agents = useView((s) => s.workbench.agents);
  const backends = useView((s) => s.backends);
  const providers = useView((s) => s.providers.items);
  const models = useView((s) => s.models);
  const backendModelsCache = useView((s) => s.backendModelsCache);
  const projects = useView((s) => s.projects);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [delegatingId, setDelegatingId] = useState<string | undefined>();
  const [delegatePrompt, setDelegatePrompt] = useState('');
  const [delegateProject, setDelegateProject] = useState(projects.currentPath ?? projects.recent[0]?.path ?? '');

  // 编辑表单字段
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [instructions, setInstructions] = useState('');
  const [backendId, setBackendId] = useState(backends.active || 'dsh');
  const [selectedModel, setSelectedModel] = useState<ModelPickerSelection | undefined>(undefined);
  const [tools, setTools] = useState<AgentToolConfig>(DEFAULT_TOOLS);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [pendingFetch, setPendingFetch] = useState<{ readonly requestId: number; readonly backendId: string } | undefined>();

  const projectOptions = getProjectOptions(projects);

  const runtimeItems = useMemo(
    () => (backends.items.length > 0 ? backends.items : [{ id: 'dsh', name: 'DeepSeek' }]),
    [backends.items],
  );
  const currentBackend = runtimeItems.find((b) => b.id === backendId) ?? { id: backendId || 'dsh', name: backendId || 'DeepSeek' };

  const cachedForBackend = backendId === backends.active ? undefined : backendModelsCache[backendId];
  const modelsLoading = Boolean(
    pendingFetch &&
      pendingFetch.backendId === backendId &&
      (!cachedForBackend || cachedForBackend.requestId < pendingFetch.requestId),
  );

  const pickerModelOptions = useMemo<readonly ModelOption[]>(() => {
    const seen = new Set<string>();
    const list: ModelOption[] = [];
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
    const runtimeOptions = backendId === backends.active ? models.options : (cachedForBackend?.models.options ?? []);
    for (const m of runtimeOptions) {
      const key = `${m.provider}::${m.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(m);
    }
    return list;
  }, [backendId, backends.active, providers, models.options, cachedForBackend]);

  const requestBackendModels = (targetBackendId: string) => {
    const requestId = ++nextAgentModelFetchId;
    setPendingFetch({ requestId, backendId: targetBackendId });
    postToHost({ type: 'fetchBackendModels', payload: { requestId, backendId: targetBackendId } });
  };

  useEffect(() => {
    if (!formOpen || !pendingFetch || pendingFetch.backendId !== backendId) return;
    if (!cachedForBackend || cachedForBackend.requestId < pendingFetch.requestId) return;
    setPendingFetch(undefined);
  }, [formOpen, pendingFetch, backendId, cachedForBackend]);

  const handleSelectBackend = (nextBackendId: string) => {
    setBackendId(nextBackendId);
    setSelectedModel(undefined);
    if (nextBackendId !== backends.active) {
      requestBackendModels(nextBackendId);
    } else {
      setPendingFetch(undefined);
    }
  };

  const openCreate = () => {
    setEditingId(undefined);
    setName('');
    setSpecialty('');
    setInstructions('');
    setBackendId(backends.active || 'dsh');
    setSelectedModel(undefined);
    setTools(DEFAULT_TOOLS);
    setRuntimeMenuOpen(false);
    setPendingFetch(undefined);
    setFormOpen(true);
  };

  const openEdit = (agent: AgentProfile) => {
    setEditingId(agent.id);
    setName(agent.name);
    setSpecialty(agent.specialty);
    setInstructions(agent.instructions);
    setBackendId(agent.backendId);
    setSelectedModel(
      agent.model
        ? {
            ...(agent.provider ? { provider: agent.provider } : {}),
            model: agent.model,
            ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          }
        : undefined,
    );
    setTools(agent.tools);
    setRuntimeMenuOpen(false);
    if (agent.backendId !== backends.active) {
      requestBackendModels(agent.backendId);
    } else {
      setPendingFetch(undefined);
    }
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(undefined);
    setRuntimeMenuOpen(false);
    setPendingFetch(undefined);
  };

  const handleSave = () => {
    if (!name.trim() || !specialty.trim()) return;
    postToHost({
      type: 'upsertAgent',
      payload: {
        ...(editingId ? { id: editingId } : {}),
        name: name.trim(),
        specialty: specialty.trim(),
        instructions: instructions.trim(),
        backendId: backendId || 'dsh',
        ...(selectedModel?.provider ? { provider: selectedModel.provider } : {}),
        ...(selectedModel?.model ? { model: selectedModel.model } : {}),
        ...(selectedModel?.reasoningEffort ? { reasoningEffort: selectedModel.reasoningEffort } : {}),
        tools,
      },
    });
    setFormOpen(false);
    setEditingId(undefined);
    setRuntimeMenuOpen(false);
    setPendingFetch(undefined);
  };

  const submitDelegate = (agentId: string) => {
    if (!delegatePrompt.trim()) return;
    postToHost({
      type: 'delegateToAgent',
      payload: {
        agentId,
        prompt: delegatePrompt.trim(),
        ...(delegateProject ? { projectPath: delegateProject } : {}),
        runImmediately: true,
      },
    });
    setDelegatePrompt('');
    setDelegatingId(undefined);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-3" data-testid="workbench-agents">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2 px-0.5">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[15px] font-semibold tracking-tight text-ink">{t('wb.agents.title')}</h2>
            <p className="mt-0.5 mb-0 text-[12px] text-ink-3">{t('wb.agents.subtitle')}</p>
          </div>
          <Button type="button" size="sm" data-testid="agent-new-btn" onClick={openCreate}>
            <PlusIcon className="size-3.5" />
            <span>{t('wb.agents.new')}</span>
          </Button>
        </div>

        {/* 新建 / 编辑智能体模态弹窗 */}
        <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
          <DialogContent data-testid="agent-form" aria-modal="true" className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[14px]">
                <AgentIcon className="size-4 text-accent-ink" />
                <span>{editingId ? t('wb.agents.edit') : t('wb.agents.new')}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">{t('wb.agents.subtitle')}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldName')}</span>
                  <Input
                    size="sm"
                    data-testid="agent-input-name"
                    value={name}
                    placeholder={t('wb.agents.fieldNamePlaceholder')}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldSpecialty')}</span>
                  <Input
                    size="sm"
                    data-testid="agent-input-specialty"
                    value={specialty}
                    placeholder={t('wb.agents.fieldSpecialtyPlaceholder')}
                    onChange={(e) => setSpecialty(e.target.value)}
                  />
                </label>
              </div>

              {/* 系统指令：复用会话输入框卡片，内置运行时、模型与默认权限选择器 */}
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldInstructions')}</span>
                <div
                  data-testid="agent-composer"
                  className="composer surface-glass relative flex flex-col rounded-2xl border border-black/8 p-1.5 shadow-[var(--shadow-composer)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/45 focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_30%,transparent),var(--shadow-composer)] dark:border-white/[0.07] dark:inset-shadow-[0_1px_rgb(255_255_255/3%)]"
                >
                  <textarea
                    data-testid="agent-input-instructions"
                    rows={5}
                    value={instructions}
                    placeholder={t('wb.agents.fieldInstructionsPlaceholder')}
                    aria-label={t('wb.agents.fieldInstructions')}
                    className="composer__input block max-h-64 min-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 pt-1.5 pb-1 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink-3"
                    onChange={(e) => setInstructions(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        handleSave();
                      }
                    }}
                  />

                  <div className="composer__toolbar flex min-w-0 items-center gap-1 pt-1 [&>*]:flex-none [&>.model-picker]:min-w-0 [&>.model-picker]:flex-[0_1_auto]">
                    <div className="relative min-w-0">
                      <Popover open={runtimeMenuOpen} onOpenChange={setRuntimeMenuOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid="agent-runtime-picker"
                            aria-label={t('wb.agents.fieldBackend')}
                            title={t('wb.agents.fieldBackend')}
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
                          aria-label={t('wb.agents.fieldBackend')}
                          onOpenAutoFocus={focusActiveMenuRow}
                          className="model-menu flex max-h-72 w-auto min-w-[200px] max-w-[min(280px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl p-1 shadow-overlay"
                        >
                          <ScrollArea className="max-h-60">
                            <div role="menu" data-testid="agent-runtime-list">
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
                                      data-testid={`agent-runtime-option-${b.id}`}
                                      onClick={() => {
                                        setRuntimeMenuOpen(false);
                                        if (b.id !== backendId) {
                                          handleSelectBackend(b.id);
                                        }
                                      }}
                                      className={cn(
                                        'menu-item relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[12.5px] transition-colors duration-100',
                                        active
                                          ? 'menu-item--active bg-field font-medium text-ink group-data-[gliding=true]/glide-menu:bg-transparent'
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
                          </ScrollArea>
                        </PopoverContent>
                      </Popover>
                    </div>

                    <ModelPicker
                      disabled={false}
                      value={selectedModel}
                      options={pickerModelOptions}
                      onSelect={setSelectedModel}
                      hideChannelSwitcher
                      loading={modelsLoading}
                      placeholder={t('wb.agents.modelDefault')}
                      testId="agent-model-picker"
                    />

                    <span className="composer__spacer min-w-0 flex-1!" />

                    <PermissionPicker
                      disabled={false}
                      value={tools.permissionPreset}
                      options={AGENT_PERMISSION_OPTIONS}
                      onSelect={(value) =>
                        setTools({
                          ...tools,
                          permissionPreset: value as AgentToolConfig['permissionPreset'],
                        })
                      }
                      testId="agent-permission-picker"
                    />
                  </div>
                </div>
              </div>

              {/* 工具配置 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldTools')}</span>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['readSearch', t('wb.agents.toolRead')],
                      ['editWrite', t('wb.agents.toolEdit')],
                      ['bashCommand', t('wb.agents.toolBash')],
                      ['webFetch', t('wb.agents.toolWeb')],
                      ['mcpTools', t('wb.agents.toolMcp')],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      key={key}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-line bg-field px-2.5 py-1 text-[12px] text-ink"
                    >
                      <Checkbox
                        checked={tools[key]}
                        onCheckedChange={(checked) => setTools({ ...tools, [key]: Boolean(checked) })}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" size="sm" data-testid="agent-cancel-btn" onClick={closeForm}>
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="agent-submit-btn"
                disabled={!name.trim() || !specialty.trim()}
                onClick={handleSave}
              >
                {t('common.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 智能体卡片网格 */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" data-testid="agents-list">
          {agents.map((agent) => {
            const backendName = backends.items.find((b) => b.id === agent.backendId)?.name ?? agent.backendId;
            const boundProvider =
              providers.find((p) => (p.boundAgentIds ?? []).includes(agent.id)) ??
              (agent.provider ? providers.find((p) => p.id === agent.provider) : undefined) ??
              providers.find((p) => p.boundBackendIds.includes(agent.backendId));
            const isDelegating = delegatingId === agent.id;
            const permText =
              agent.tools.permissionPreset === 'read-only'
                ? t('wb.schedules.permRead')
                : agent.tools.permissionPreset === 'danger-full-access'
                  ? t('wb.schedules.permFull')
                  : t('wb.schedules.permWorkspace');

            return (
              <section
                key={agent.id}
                className="flex flex-col justify-between rounded-card bg-surface shadow-card"
                data-testid={`agent-card-${agent.id}`}
              >
                <div className="primitive-card-pad flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <AgentIcon className="size-4 shrink-0 text-accent-ink" />
                        <span className="text-[13.5px] font-semibold text-ink">{agent.name}</span>
                        {agent.builtin ? <ValuePill>{t('wb.agents.builtin')}</ValuePill> : null}
                      </div>
                      <div className="mt-1 text-[12px] font-medium text-ink-2">{agent.specialty}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-testid={`agent-edit-${agent.id}`}
                        aria-label={t('common.edit')}
                        onClick={() => openEdit(agent)}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('common.delete')}
                        onClick={() => postToHost({ type: 'deleteAgent', payload: { id: agent.id } })}
                      >
                        <TrashIcon className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  {agent.instructions ? (
                    <p className="m-0 line-clamp-2 text-[11.5px] leading-relaxed text-ink-3">{agent.instructions}</p>
                  ) : null}

                  <div className="flex flex-wrap gap-1 pt-0.5 text-[11px] text-ink-3">
                    <span className="rounded-chip bg-field px-2 py-0.5 shadow-hairline">{backendName}</span>
                    {boundProvider ? (
                      <span className="rounded-chip bg-field px-2 py-0.5 shadow-hairline">{boundProvider.name}</span>
                    ) : null}
                    {agent.model ? (
                      <span className="rounded-chip bg-field px-2 py-0.5 font-mono shadow-hairline">{agent.model}</span>
                    ) : null}
                    <span className="rounded-chip bg-field px-2 py-0.5 shadow-hairline">{permText}</span>
                  </div>

                  <div className="flex items-center gap-2 border-t border-line pt-2.5">
                    <Button
                      type="button"
                      size="xs"
                      data-testid={`agent-start-${agent.id}`}
                      onClick={() =>
                        postToHost({
                          type: 'startAgentSession',
                          payload: {
                            agentId: agent.id,
                            ...(projects.currentPath ? { projectPath: projects.currentPath } : {}),
                          },
                        })
                      }
                    >
                      <ChatIcon className="size-3" />
                      <span>{t('wb.agents.startSession')}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-testid={`agent-delegate-toggle-${agent.id}`}
                      onClick={() => {
                        setDelegatingId(isDelegating ? undefined : agent.id);
                        setDelegateProject(projects.currentPath ?? projects.recent[0]?.path ?? '');
                      }}
                    >
                      <SendIcon className="size-3" />
                      <span>{t('wb.agents.delegate')}</span>
                    </Button>
                  </div>

                  {isDelegating ? (
                    <div className="mt-1 flex flex-col gap-2 rounded-control border border-line bg-inset/50 p-2.5" data-testid={`agent-delegate-box-${agent.id}`}>
                      <Textarea
                        data-testid={`agent-delegate-input-${agent.id}`}
                        rows={2}
                        value={delegatePrompt}
                        placeholder={t('wb.agents.delegatePromptPlaceholder')}
                        onChange={(e) => setDelegatePrompt(e.target.value)}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {projectOptions.length > 0 ? (
                          <div className="min-w-36 flex-1">
                            <Select value={delegateProject || undefined} onValueChange={setDelegateProject}>
                              <SelectTrigger size="sm" className="w-full" aria-label={t('wb.tasks.selectProject')}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {projectOptions.map(([path, label]) => (
                                  <SelectItem key={path} value={path}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : <span />}
                        <Button
                          type="button"
                          size="sm"
                          data-testid={`agent-delegate-submit-${agent.id}`}
                          disabled={!delegatePrompt.trim()}
                          onClick={() => submitDelegate(agent.id)}
                        >
                          {t('wb.agents.delegateConfirm')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

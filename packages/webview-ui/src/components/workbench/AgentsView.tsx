/**
 * 工作台 · 智能体模块（AgentsView）
 *
 * 保存专长（specialty）、指令（instructions）、模型与底层配置、工具开关与权限预设；
 * 支持一键「开始会话」或直接「委派任务」至任务看板按序执行。
 */
import { useState } from 'react';
import type { AgentProfile, AgentToolConfig } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  AgentIcon,
  ChatIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { getMergedModels, getProjectOptions } from '@/lib/workbenchOptions';
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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

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
  const [modelKey, setModelKey] = useState('');
  const [tools, setTools] = useState<AgentToolConfig>(DEFAULT_TOOLS);

  const projectOptions = getProjectOptions(projects);

  const mergedModels = getMergedModels(backendId, providers, models);

  const openCreate = () => {
    setEditingId(undefined);
    setName('');
    setSpecialty('');
    setInstructions('');
    setBackendId(backends.active || 'dsh');
    setModelKey('');
    setTools(DEFAULT_TOOLS);
    setFormOpen(true);
  };

  const openEdit = (agent: AgentProfile) => {
    setEditingId(agent.id);
    setName(agent.name);
    setSpecialty(agent.specialty);
    setInstructions(agent.instructions);
    setBackendId(agent.backendId);
    setModelKey(agent.model ? `${agent.provider ?? ''}::${agent.model}` : '');
    setTools(agent.tools);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(undefined);
  };

  const handleSave = () => {
    if (!name.trim() || !specialty.trim()) return;
    let provider: string | undefined;
    let model: string | undefined;
    if (modelKey) {
      const sep = modelKey.indexOf('::');
      if (sep >= 0) {
        provider = modelKey.slice(0, sep) || undefined;
        model = modelKey.slice(sep + 2) || undefined;
      } else {
        model = modelKey;
      }
    }
    postToHost({
      type: 'upsertAgent',
      payload: {
        ...(editingId ? { id: editingId } : {}),
        name: name.trim(),
        specialty: specialty.trim(),
        instructions: instructions.trim(),
        backendId: backendId || 'dsh',
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        tools,
      },
    });
    setFormOpen(false);
    setEditingId(undefined);
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

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldInstructions')}</span>
                <Textarea
                  data-testid="agent-input-instructions"
                  rows={3}
                  value={instructions}
                  placeholder={t('wb.agents.fieldInstructionsPlaceholder')}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 [&_[data-slot=native-select-wrapper]]:w-full">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldBackend')}</span>
                  <NativeSelect
                    size="sm"
                    data-testid="agent-select-backend"
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
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldModel')}</span>
                  <NativeSelect
                    size="sm"
                    data-testid="agent-select-model"
                    value={modelKey}
                    onChange={(e) => setModelKey(e.target.value)}
                  >
                    <NativeSelectOption value="">{t('wb.agents.modelDefault')}</NativeSelectOption>
                    {mergedModels.map((m) => (
                      <NativeSelectOption key={m.key} value={m.key}>
                        {m.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('wb.agents.fieldPermission')}</span>
                  <NativeSelect
                    size="sm"
                    data-testid="agent-select-permission"
                    value={tools.permissionPreset}
                    onChange={(e) =>
                      setTools({
                        ...tools,
                        permissionPreset: e.target.value as AgentToolConfig['permissionPreset'],
                      })
                    }
                  >
                    <NativeSelectOption value="read-only">{t('wb.schedules.permRead')}</NativeSelectOption>
                    <NativeSelectOption value="workspace-write">{t('wb.schedules.permWorkspace')}</NativeSelectOption>
                    <NativeSelectOption value="danger-full-access">{t('wb.schedules.permFull')}</NativeSelectOption>
                  </NativeSelect>
                </label>
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
                          <div className="min-w-36 flex-1 [&_[data-slot=native-select-wrapper]]:w-full">
                            <NativeSelect
                              size="sm"
                              value={delegateProject}
                              onChange={(e) => setDelegateProject(e.target.value)}
                            >
                              {projectOptions.map(([path, label]) => (
                                <NativeSelectOption key={path} value={path}>
                                  {label}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
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

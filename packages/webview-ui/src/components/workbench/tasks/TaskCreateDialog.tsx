import { KanbanIcon, PlayIcon, PlusIcon } from '../../icons.tsx';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { AgentProfile, BackendsState } from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';

export function TaskCreateDialog({ agents, backends, prompt, setPrompt, title, setTitle, projectPath, setProjectPath, backendId, setBackendId, modelKey, setModelKey, agentId, setAgentId, createOpen, closeCreateModal, projectOptions, mergedModels, handleCreateTask }: { agents: readonly AgentProfile[]; backends: BackendsState; prompt: string; setPrompt: (v: string) => void; title: string; setTitle: (v: string) => void; projectPath: string; setProjectPath: (v: string) => void; backendId: string; setBackendId: (v: string) => void; modelKey: string; setModelKey: (v: string) => void; agentId: string; setAgentId: (v: string) => void; createOpen: boolean; closeCreateModal: () => void; projectOptions: readonly [string, string][]; mergedModels: readonly { readonly key: string; readonly label: string }[]; handleCreateTask: (autoStart?: boolean) => void }) {
  const t = useT();
  return (
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
  );
}

import { PROVIDER_PRESETS, isProviderReadyForBackend, type AgentProfile, type BackendView, type ProviderPreset, type ProviderView } from '@harness-deck/shared';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '../../../lib/utils.ts';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons.tsx';
import { ProviderModelTable } from './ProviderModelTable.tsx';
import { ProviderVendorIcon } from './ProviderVendorIcon.tsx';
import type { Dispatch, SetStateAction } from 'react';
import type { EditableModelRow, ProviderEditorState } from './providerEditor.ts';
import { useT } from '../../../i18n.ts';

const MODEL_UNSET_VALUE = '__unset__';

export function ProviderEditorForm({ locale, protocolGatewayEnabled, backends, workbenchAgents, editor, setEditor, detailsOpen, setDetailsOpen, batchOpen, setBatchOpen, batchText, setBatchText, formError, pendingFetchId, fetchError, boundOwnerByBackend, boundOwnerByWbAgent, closeEditor, selectPreset, updateModelRow, addModelRow, removeModelRow, applyBatchPaste, triggerFetchModels, toggleBackendBind, toggleWbAgentBind, saveProvider, validModelOptions, compatibilitySummary, hasAnyUrl }: { locale: 'zh' | 'en'; protocolGatewayEnabled: boolean; backends: readonly BackendView[]; workbenchAgents: readonly AgentProfile[]; editor: ProviderEditorState; setEditor: Dispatch<SetStateAction<ProviderEditorState | undefined>>; detailsOpen: boolean; setDetailsOpen: Dispatch<SetStateAction<boolean>>; batchOpen: boolean; setBatchOpen: Dispatch<SetStateAction<boolean>>; batchText: string; setBatchText: (text: string) => void; formError: string | undefined; pendingFetchId: number | undefined; fetchError: string | undefined; boundOwnerByBackend: ReadonlyMap<string, ProviderView>; boundOwnerByWbAgent: ReadonlyMap<string, ProviderView>; closeEditor: () => void; selectPreset: (preset: ProviderPreset) => void; updateModelRow: (rowKey: number, patch: Partial<EditableModelRow>) => void; addModelRow: () => void; removeModelRow: (rowKey: number) => void; applyBatchPaste: () => void; triggerFetchModels: () => void; toggleBackendBind: (backendId: string, checked: boolean) => void; toggleWbAgentBind: (agentId: string, checked: boolean) => void; saveProvider: () => void; validModelOptions: readonly { readonly id: string; readonly label: string }[]; compatibilitySummary: { readonly missingHints: readonly string[]; readonly accountOnlyNames: readonly string[] }; hasAnyUrl: boolean }) {
  const t = useT();
  const titleText = editor.editingId
    ? t('settings.providers.editTitle', editor.name || editor.editingId)
    : t('settings.providers.addTitle');

  return (
    <Dialog open onOpenChange={(open) => !open && closeEditor()}>
      <DialogContent
        data-testid="provider-editor"
        className="flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 border-b border-line/60 px-5 py-4">
          <DialogTitle className="flex items-center gap-2.5 text-[15px]">
            <ProviderVendorIcon
              presetId={editor.presetId}
              name={editor.name}
              defaultModel={editor.defaultModel}
              size="sm"
            />
            <span>{titleText}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">{titleText}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
          {/* 预设卡片网格（展示各厂商图标） */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="provider-presets">
            {PROVIDER_PRESETS.map((preset) => {
              const selected = editor.presetId === preset.id;
              const title = locale === 'zh' ? preset.nameZh : preset.nameEn;
              const desc = locale === 'zh' ? preset.descZh : preset.descEn;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`provider-preset-${preset.id}`}
                  onClick={() => selectPreset(preset)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all duration-150',
                    selected
                      ? 'bg-field/85 ring-2 ring-brand dark:bg-surface'
                      : 'bg-field/45 hover:bg-field/80 dark:bg-surface/55 dark:hover:bg-surface/85',
                  )}
                >
                  <ProviderVendorIcon presetId={preset.id} name={title} size="sm" className="mt-0.5" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-semibold text-ink">{title}</span>
                      {!preset.verified ? (
                        <span className="ml-auto shrink-0 text-[10.5px] text-ink-3">
                          {t('settings.providers.presetUnverifiedBadge')}
                        </span>
                      ) : null}
                    </div>
                    <span className="line-clamp-1 text-[11.5px] text-ink-3">{desc}</span>
                  </div>
                </button>
              );
            })}
          </div>

        {/* 名称 & API Key */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">{t('settings.providers.name')}</span>
            <Input
              size="sm"
              data-testid="provider-form-name"
              value={editor.name}
              placeholder={t('settings.providers.namePlaceholder')}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-ink-2">{t('settings.providers.apiKey')}</span>
              {editor.hasSavedApiKey ? (
                editor.clearApiKey ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-[11.5px]"
                    data-testid="provider-restore-apikey"
                    onClick={() => setEditor({ ...editor, clearApiKey: false })}
                  >
                    {t('settings.providers.apiKeyRestore')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-[11.5px] text-destructive"
                    data-testid="provider-clear-apikey"
                    onClick={() => setEditor({ ...editor, clearApiKey: true, apiKey: '' })}
                  >
                    {t('settings.providers.apiKeyClear')}
                  </Button>
                )
              ) : null}
            </div>
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              data-testid="provider-form-apikey"
              value={editor.apiKey}
              placeholder={
                editor.clearApiKey
                  ? t('settings.providers.apiKeyWillClear')
                  : editor.hasSavedApiKey
                    ? t('settings.providers.apiKeySavedPlaceholder')
                    : t('settings.providers.apiKeyPlaceholder')
              }
              onChange={(e) => setEditor({ ...editor, apiKey: e.target.value, clearApiKey: false })}
            />
          </div>
        </div>

        {/* 折叠区：配置模型与连接地址 */}
        <div className="flex flex-col gap-3.5">
          <button
            type="button"
            data-testid="provider-config-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex w-fit items-center gap-1.5 text-[12.5px] font-semibold text-ink hover:text-accent-ink"
          >
            {detailsOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            <span>{t('settings.providers.sectionToggle')}</span>
          </button>

          {detailsOpen ? (
            <div className="flex flex-col gap-4" data-testid="provider-config-section">
              {/* 协议地址 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-medium text-ink-2">{t('settings.providers.urlAnthropic')}</span>
                  <Input
                    size="sm"
                    data-testid="provider-url-anthropic"
                    className="font-mono text-[12px]"
                    placeholder="https://api.anthropic.com"
                    value={editor.anthropicUrl}
                    onChange={(e) => setEditor({ ...editor, anthropicUrl: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-medium text-ink-2">{t('settings.providers.urlOpenaiChat')}</span>
                  <Input
                    size="sm"
                    data-testid="provider-url-openai-chat"
                    className="font-mono text-[12px]"
                    placeholder="https://api.openai.com/v1"
                    value={editor.openaiChatUrl}
                    onChange={(e) => setEditor({ ...editor, openaiChatUrl: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-medium text-ink-2">
                    {t('settings.providers.urlOpenaiResponses')}
                  </span>
                  <Input
                    size="sm"
                    data-testid="provider-url-openai-responses"
                    className="font-mono text-[12px]"
                    placeholder="https://api.openai.com/v1"
                    value={editor.openaiResponsesUrl}
                    onChange={(e) => setEditor({ ...editor, openaiResponsesUrl: e.target.value })}
                  />
                </label>
              </div>

              {editor.openaiChatUrl.trim() || editor.openaiResponsesUrl.trim() ? (
                <div className="rounded-xl bg-canvas/70 px-3 py-2.5 dark:bg-page/45">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] font-medium text-ink">
                    <Checkbox
                      data-testid="provider-convert-openai"
                      checked={editor.convertOpenaiToAnthropic}
                      onCheckedChange={(val) => setEditor({ ...editor, convertOpenaiToAnthropic: val === true })}
                    />
                    <span>{t('settings.providers.convertOpenaiLabel')}</span>
                  </label>
                </div>
              ) : null}

              <ProviderModelTable editor={editor} batchOpen={batchOpen} setBatchOpen={setBatchOpen} batchText={batchText} setBatchText={setBatchText} pendingFetchId={pendingFetchId} fetchError={fetchError} updateModelRow={updateModelRow} addModelRow={addModelRow} removeModelRow={removeModelRow} applyBatchPaste={applyBatchPaste} triggerFetchModels={triggerFetchModels} hasAnyUrl={hasAnyUrl} />

              {/* 默认模型 & 小模型 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-ink-2">
                    {t('settings.providers.defaultModel')}
                  </span>
                  <Select
                    value={editor.defaultModel || MODEL_UNSET_VALUE}
                    onValueChange={(value) =>
                      setEditor({ ...editor, defaultModel: value === MODEL_UNSET_VALUE ? '' : value })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full"
                      data-testid="provider-default-model"
                      aria-label={t('settings.providers.defaultModel')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MODEL_UNSET_VALUE}>{t('settings.providers.modelUnset')}</SelectItem>
                      {validModelOptions.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-ink-2">
                    {t('settings.providers.smallModel')}
                  </span>
                  <Select
                    value={editor.smallModel || MODEL_UNSET_VALUE}
                    onValueChange={(value) =>
                      setEditor({ ...editor, smallModel: value === MODEL_UNSET_VALUE ? '' : value })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full"
                      data-testid="provider-small-model"
                      aria-label={t('settings.providers.smallModel')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MODEL_UNSET_VALUE}>{t('settings.providers.modelUnset')}</SelectItem>
                      {validModelOptions.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* 给哪些 Agent 用 */}
        <div className="flex flex-col gap-2.5">
          <span className="text-[12px] font-semibold text-ink">{t('settings.providers.bindTitle')}</span>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="provider-bind-backends">
            {backends.map((backend) => {
              const urls = {
                anthropicUrl: editor.anthropicUrl,
                openaiChatUrl: editor.openaiChatUrl,
                openaiResponsesUrl: editor.openaiResponsesUrl,
                convertOpenaiToAnthropic: editor.convertOpenaiToAnthropic,
              };
              const ready = isProviderReadyForBackend(urls, backend, {
                protocolGatewayEnabled: protocolGatewayEnabled || editor.convertOpenaiToAnthropic,
              });
              const checked = ready && editor.boundBackendIds.includes(backend.id);
              const currentOwner = boundOwnerByBackend.get(backend.id);
              const ownedByOther = currentOwner && currentOwner.id !== editor.editingId;
              return (
                <label
                  key={backend.id}
                  className={cn(
                    'inline-flex items-center gap-1.5 text-[12.5px]',
                    ready ? 'cursor-pointer text-ink' : 'cursor-not-allowed text-ink-3 opacity-55',
                  )}
                >
                  <Checkbox
                    data-testid={`provider-bind-backend-${backend.id}`}
                    disabled={!ready}
                    checked={checked}
                    onCheckedChange={(val) => toggleBackendBind(backend.id, val === true)}
                  />
                  <span>{backend.name}</span>
                  {ownedByOther ? (
                    <span className="text-[11px] text-ink-3">
                      ({t('settings.providers.boundElsewhere', currentOwner.name)})
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>

          {(compatibilitySummary.missingHints.length > 0 || compatibilitySummary.accountOnlyNames.length > 0) ? (
            <p
              className="m-0 text-[11.5px] leading-relaxed text-ink-3"
              data-testid="provider-compatibility-hint"
            >
              {compatibilitySummary.missingHints.length > 0
                ? t('settings.providers.bindMissingUrls', compatibilitySummary.missingHints.join('、'))
                : ''}
              {compatibilitySummary.missingHints.length > 0 && compatibilitySummary.accountOnlyNames.length > 0
                ? ' '
                : ''}
              {compatibilitySummary.accountOnlyNames.length > 0
                ? t('settings.providers.bindAccountOnly', compatibilitySummary.accountOnlyNames.join('、'))
                : ''}
            </p>
          ) : null}

          {workbenchAgents.length > 0 ? (
            <div className="mt-1 flex flex-col gap-2 rounded-xl bg-canvas/70 p-3 dark:bg-page/45">
              <span className="text-[11.5px] font-medium text-ink-2">
                {t('settings.providers.bindWorkbenchAgents')}
              </span>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" data-testid="provider-bind-wb-agents">
                {workbenchAgents.map((agent) => {
                  const checked = editor.boundAgentIds.includes(agent.id);
                  const owner = boundOwnerByWbAgent.get(agent.id);
                  const ownedByOther = owner && owner.id !== editor.editingId;
                  return (
                    <label key={agent.id} className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-ink">
                      <Checkbox
                        data-testid={`provider-bind-wb-agent-${agent.id}`}
                        checked={checked}
                        onCheckedChange={(val) => toggleWbAgentBind(agent.id, val === true)}
                      />
                      <span>{agent.name}</span>
                      {ownedByOther ? (
                        <span className="text-[11px] text-ink-3">
                          ({t('settings.providers.boundElsewhere', owner.name)})
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {formError ? (
          <div className="text-[12px] text-destructive" role="alert" data-testid="provider-form-error">
            {formError}
          </div>
        ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-line/60 px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="provider-cancel-btn"
            onClick={closeEditor}
          >
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" data-testid="provider-save-btn" onClick={saveProvider}>
            {t('settings.providers.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

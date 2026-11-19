import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CloseIcon, RefreshIcon, SpinnerIcon } from '../../icons.tsx';
import type { EditableModelRow, ProviderEditorState } from './providerEditor.ts';
import type { Dispatch, SetStateAction } from 'react';
import { useT } from '../../../i18n.ts';

export function ProviderModelTable({ editor, batchOpen, setBatchOpen, batchText, setBatchText, pendingFetchId, fetchError, updateModelRow, addModelRow, removeModelRow, applyBatchPaste, triggerFetchModels, hasAnyUrl }: { editor: ProviderEditorState; batchOpen: boolean; setBatchOpen: Dispatch<SetStateAction<boolean>>; batchText: string; setBatchText: (text: string) => void; pendingFetchId: number | undefined; fetchError: string | undefined; updateModelRow: (rowKey: number, patch: Partial<EditableModelRow>) => void; addModelRow: () => void; removeModelRow: (rowKey: number) => void; applyBatchPaste: () => void; triggerFetchModels: () => void; hasAnyUrl: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-ink">{t('settings.providers.modelsTitle')}</span>
        <Button
          type="button"
          variant="link"
          size="default"
          className="h-auto p-0 text-[12px]"
          disabled={!hasAnyUrl || pendingFetchId !== undefined}
          data-testid="provider-fetch-models"
          onClick={triggerFetchModels}
        >
          {pendingFetchId !== undefined ? (
            <>
              <SpinnerIcon className="size-3" />
              <span>{t('settings.providers.fetchingModels')}</span>
            </>
          ) : (
            <>
              <RefreshIcon className="size-3" />
              <span>{t('settings.providers.fetchModels')}</span>
            </>
          )}
        </Button>
      </div>
      <p className="m-0 text-[11.5px] text-ink-3">{t('settings.providers.modelsPreHint')}</p>

      {fetchError ? (
        <div className="text-[11.5px] text-destructive" role="alert" data-testid="provider-fetch-error">
          {fetchError}
        </div>
      ) : null}

      {/* 表头（桌面宽屏展示） */}
      <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1fr)_4rem_2.25rem] items-center gap-1.5 text-[11.5px] text-ink-3 sm:grid">
        <span>{t('settings.providers.colModelId')}</span>
        <span>{t('settings.providers.colDisplayName')}</span>
        <span>{t('settings.providers.colContext')}</span>
        <span>{t('settings.providers.colMaxOutput')}</span>
        <span>{t('settings.providers.colEfforts')}</span>
        <span className="text-center">{t('settings.providers.colVision')}</span>
        <span />
      </div>

      <div className="flex flex-col gap-1.5">
        {editor.models.map((row, index) => (
          <div
            key={row.rowKey}
            data-testid={`provider-model-row-${index}`}
            className="grid grid-cols-1 items-center gap-1.5 rounded-control bg-field/40 p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1fr)_4rem_2.25rem] sm:bg-transparent sm:p-0"
          >
            <Input
              size="default"
              data-testid={`provider-model-id-${index}`}
              aria-label={t('settings.providers.colModelId')}
              className="font-mono text-[12px]"
              placeholder="model-id"
              value={row.id}
              onChange={(e) => updateModelRow(row.rowKey, { id: e.target.value })}
            />
            <Input
              size="default"
              data-testid={`provider-model-name-${index}`}
              aria-label={t('settings.providers.colDisplayName')}
              className="text-[12px]"
              placeholder={t('settings.providers.colDisplayName')}
              value={row.name}
              onChange={(e) => updateModelRow(row.rowKey, { name: e.target.value })}
            />
            <Input
              size="default"
              data-testid={`provider-model-ctx-${index}`}
              aria-label={t('settings.providers.colContext')}
              className="font-mono text-[12px]"
              placeholder={t('settings.providers.unknownPlaceholder')}
              value={row.contextWindow}
              onChange={(e) => updateModelRow(row.rowKey, { contextWindow: e.target.value })}
            />
            <Input
              size="default"
              data-testid={`provider-model-maxout-${index}`}
              aria-label={t('settings.providers.colMaxOutput')}
              className="font-mono text-[12px]"
              placeholder={t('settings.providers.unknownPlaceholder')}
              value={row.maxOutputTokens}
              onChange={(e) => updateModelRow(row.rowKey, { maxOutputTokens: e.target.value })}
            />
            <Input
              size="default"
              data-testid={`provider-model-efforts-${index}`}
              aria-label={t('settings.providers.colEfforts')}
              className="font-mono text-[12px]"
              placeholder="low, high"
              value={row.effortsText}
              onChange={(e) => updateModelRow(row.rowKey, { effortsText: e.target.value })}
            />
            <div className="flex items-center justify-between sm:justify-center">
              <span className="text-[11.5px] text-ink-3 sm:hidden">
                {t('settings.providers.colVision')}
              </span>
              <Checkbox
                data-testid={`provider-model-vision-${index}`}
                aria-label={t('settings.providers.colVision')}
                checked={row.vision}
                onCheckedChange={(checked) => updateModelRow(row.rowKey, { vision: checked === true })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('settings.providers.removeModel')}
              data-testid={`provider-model-remove-${index}`}
              onClick={() => removeModelRow(row.rowKey)}
            >
              <CloseIcon className="size-3.5 text-ink-3" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button
          type="button"
          variant="outline"
          size="default"
          data-testid="provider-add-model"
          onClick={addModelRow}
        >
          {t('settings.providers.addModel')}
        </Button>
        <Button
          type="button"
          variant="link"
          size="default"
          className="h-auto p-0 text-[12px]"
          data-testid="provider-batch-toggle"
          onClick={() => setBatchOpen((v) => !v)}
        >
          {t('settings.providers.batchPaste')}
        </Button>
      </div>

      {batchOpen ? (
        <div
          className="flex flex-col gap-2 rounded-card border border-line bg-field/60 p-2.5"
          data-testid="provider-batch-box"
        >
          <Textarea
            rows={3}
            className="font-mono text-[12px]"
            data-testid="provider-batch-input"
            value={batchText}
            placeholder={t('settings.providers.batchPastePlaceholder')}
            onChange={(e) => setBatchText(e.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="default"
              onClick={() => {
                setBatchOpen(false);
                setBatchText('');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="default"
              data-testid="provider-batch-confirm"
              onClick={applyBatchPaste}
            >
              {t('settings.providers.batchPasteConfirm')}
            </Button>
          </div>
        </div>
      ) : null}

      <p className="m-0 text-[11.5px] leading-relaxed text-ink-3">
        {t('settings.providers.modelsHelp')}
      </p>
    </div>

  );
}

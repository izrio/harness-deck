import { type MessageKey } from '../../../i18n.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { ScheduleFrequency } from '@harness-deck/shared';
import type { Dispatch, SetStateAction } from 'react';
import { useT } from '../../../i18n.ts';

export function ScheduleForm({ backends, setFormOpen, editingId, name, setName, prompt, setPrompt, freqKind, setFreqKind, timeHm, setTimeHm, weekDays, intervalMinutes, setIntervalMinutes, onceDateTime, setOnceDateTime, backendId, setBackendId, projectPath, setProjectPath, projectOptions, handleSubmit, toggleWeekDay }: { backends: { readonly items: readonly { readonly id: string; readonly name: string }[] }; setFormOpen: Dispatch<SetStateAction<boolean>>; editingId: string | undefined; name: string; setName: (v: string) => void; prompt: string; setPrompt: (v: string) => void; freqKind: ScheduleFrequency['kind']; setFreqKind: (v: ScheduleFrequency['kind']) => void; timeHm: string; setTimeHm: (v: string) => void; weekDays: readonly number[]; intervalMinutes: number; setIntervalMinutes: (v: number) => void; onceDateTime: string; setOnceDateTime: (v: string) => void; backendId: string; setBackendId: (v: string) => void; projectPath: string; setProjectPath: (v: string) => void; projectOptions: readonly [string, string][]; handleSubmit: () => void; toggleWeekDay: (day: number) => void }) {
  const t = useT();
  return (
    <section className="flex flex-col overflow-hidden rounded-card border border-brand/40 bg-surface shadow-raised" data-testid="schedule-form">
      <div className="primitive-card-bar flex items-center justify-between border-b border-line bg-inset/50">
        <h3 className="m-0 text-[13px] font-semibold text-ink">
          {editingId ? t('wb.schedules.edit') : t('wb.schedules.new')}
        </h3>
      </div>
      <div className="primitive-card-pad flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">{t('wb.schedules.fieldName')}</span>
          <Input
            size="sm"
            data-testid="schedule-input-name"
            value={name}
            placeholder={t('wb.schedules.fieldNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-2">{t('wb.schedules.fieldPrompt')}</span>
          <Textarea
            data-testid="schedule-input-prompt"
            rows={3}
            value={prompt}
            placeholder={t('wb.schedules.fieldPromptPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        {/* 什么时候 */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-ink-2">{t('wb.schedules.fieldWhen')}</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 [&_[data-slot=native-select-wrapper]]:w-full">
            <NativeSelect
              size="sm"
              data-testid="schedule-select-freq"
              value={freqKind}
              onChange={(e) => setFreqKind(e.target.value as ScheduleFrequency['kind'])}
            >
              <NativeSelectOption value="daily">{t('wb.schedules.freqDaily')}</NativeSelectOption>
              <NativeSelectOption value="weekly">{t('wb.schedules.freqWeekly')}</NativeSelectOption>
              <NativeSelectOption value="interval">{t('wb.schedules.freqInterval')}</NativeSelectOption>
              <NativeSelectOption value="once">{t('wb.schedules.freqOnce')}</NativeSelectOption>
            </NativeSelect>

            {freqKind === 'daily' || freqKind === 'weekly' ? (
              <Input
                size="sm"
                type="time"
                data-testid="schedule-input-time"
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
                data-testid="schedule-input-interval"
                value={String(intervalMinutes)}
                aria-label={t('wb.schedules.everyMinutes')}
                onChange={(e) => setIntervalMinutes(Number(e.target.value) || 60)}
              />
            ) : (
              <Input
                size="sm"
                type="datetime-local"
                data-testid="schedule-input-once"
                value={onceDateTime}
                aria-label={t('wb.schedules.onceAt')}
                onChange={(e) => setOnceDateTime(e.target.value)}
              />
            )}
          </div>

          {freqKind === 'weekly' ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant={weekDays.includes(d) ? 'default' : 'outline'}
                  size="xs"
                  aria-pressed={weekDays.includes(d)}
                  onClick={() => toggleWeekDay(d)}
                >
                  {t(`wb.schedules.day${d}` as MessageKey)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {/* 使用什么 harness 执行 + 项目 */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 [&_[data-slot=native-select-wrapper]]:w-full">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-2">{t('wb.schedules.fieldHarness')}</span>
            <NativeSelect
              size="sm"
              data-testid="schedule-select-harness"
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

          {projectOptions.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ink-2">{t('wb.schedules.fieldProject')}</span>
              <NativeSelect
                size="sm"
                data-testid="schedule-select-project"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
              >
                {projectOptions.map(([path, label]) => (
                  <NativeSelectOption key={path} value={path}>
                    {label} ({path})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-2.5">
          <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="schedule-submit-btn"
            disabled={!name.trim() || !prompt.trim()}
            onClick={handleSubmit}
          >
            {t('wb.schedules.createSubmit')}
          </Button>
        </div>
      </div>
    </section>
  );
}

import type { ScheduleFrequency } from '@harness-deck/shared';
import { type MessageKey, type Translate } from '../../../i18n.ts';

export interface ScheduleTemplate {
  readonly id: string;
  readonly nameKey: MessageKey;
  readonly descKey: MessageKey;
  readonly promptKey: MessageKey;
  readonly defaultFrequency: ScheduleFrequency;
}

export const TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: 'morning-checkup',
    nameKey: 'wb.schedules.tpl.morningName',
    descKey: 'wb.schedules.tpl.morningDesc',
    promptKey: 'wb.schedules.tpl.morningPrompt',
    defaultFrequency: { kind: 'daily', time: '09:00' },
  },
  {
    id: 'weekly-deps',
    nameKey: 'wb.schedules.tpl.depsName',
    descKey: 'wb.schedules.tpl.depsDesc',
    promptKey: 'wb.schedules.tpl.depsPrompt',
    defaultFrequency: { kind: 'weekly', days: [1], time: '09:30' },
  },
  {
    id: 'test-guard',
    nameKey: 'wb.schedules.tpl.testGuardName',
    descKey: 'wb.schedules.tpl.testGuardDesc',
    promptKey: 'wb.schedules.tpl.testGuardPrompt',
    defaultFrequency: { kind: 'interval', minutes: 120 },
  },
  {
    id: 'todo-scan',
    nameKey: 'wb.schedules.tpl.todoScanName',
    descKey: 'wb.schedules.tpl.todoScanDesc',
    promptKey: 'wb.schedules.tpl.todoScanPrompt',
    defaultFrequency: { kind: 'weekly', days: [5], time: '17:00' },
  },
];

export function formatFrequencySummary(freq: ScheduleFrequency, t: Translate): string {
  switch (freq.kind) {
    case 'daily':
      return `${t('wb.schedules.freqDaily')} ${freq.time}`;
    case 'weekly': {
      const dayLabels = freq.days
        .map((d) => t(`wb.schedules.day${d}` as MessageKey))
        .join(' / ');
      return `${t('wb.schedules.freqWeekly')} (${dayLabels}) ${freq.time}`;
    }
    case 'interval':
      return `${t('wb.schedules.freqInterval')} · ${freq.minutes}m`;
    case 'once':
      return `${t('wb.schedules.freqOnce')} · ${new Date(freq.runAt).toLocaleString()}`;
  }
}

export function toLocalDateTimeInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

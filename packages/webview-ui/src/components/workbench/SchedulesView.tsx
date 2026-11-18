/**
 * 工作台 · 定时模块（SchedulesView）
 *
 * - 到点新开一个隔离会话，以默认「全部放行」（可在设置页修改）无人值守做完；
 * - 执行结果保存在每条规则自己的历史记录里（支持展开查看完整 Markdown 输出），绝不进入左侧会话列表；
 * - 包含「我的」与「模板」两大分栏；支持新建/编辑定时任务（任务名称、任务内容、什么时候、使用什么 harness 执行、项目）。
 */
import { useEffect, useState } from 'react';
import type { ScheduleFrequency, ScheduleRule, WebviewToHost } from '@harness-deck/shared';
import { useT, type MessageKey, type Translate } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { openSettingsPage, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { Markdown } from '../Markdown.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface ScheduleTemplate {
  readonly id: string;
  readonly nameKey: MessageKey;
  readonly descKey: MessageKey;
  readonly promptKey: MessageKey;
  readonly defaultFrequency: ScheduleFrequency;
}

const TEMPLATES: readonly ScheduleTemplate[] = [
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

function formatFrequencySummary(freq: ScheduleFrequency, t: Translate): string {
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

function toLocalDateTimeInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchedulesView() {
  const t = useT();
  const schedules = useView((s) => s.workbench.schedules);
  const inspectRuleId = useView((s) => s.inspectScheduleRuleId);
  const backends = useView((s) => s.backends);
  const projects = useView((s) => s.projects);
  const schedulePermission = useView((s) => s.preferences.schedulePermission ?? 'danger-full-access');

  const [subTab, setSubTab] = useState<'mine' | 'templates'>('mine');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [expandedRuleId, setExpandedRuleId] = useState<string | undefined>(inspectRuleId);
  const [expandedRunId, setExpandedRunId] = useState<string | undefined>();

  // 表单字段
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [freqKind, setFreqKind] = useState<ScheduleFrequency['kind']>('daily');
  const [timeHm, setTimeHm] = useState('09:00');
  const [weekDays, setWeekDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [onceDateTime, setOnceDateTime] = useState(() => toLocalDateTimeInput(Date.now() + 3600_000));
  const [backendId, setBackendId] = useState(backends.active || 'dsh');
  const [projectPath, setProjectPath] = useState(projects.currentPath ?? projects.recent[0]?.path ?? '');

  useEffect(() => {
    if (inspectRuleId) {
      setSubTab('mine');
      setExpandedRuleId(inspectRuleId);
    }
  }, [inspectRuleId]);

  useEffect(() => {
    if (!projectPath && (projects.currentPath || projects.recent[0]?.path)) {
      setProjectPath(projects.currentPath ?? projects.recent[0]?.path ?? '');
    }
  }, [projectPath, projects.currentPath, projects.recent]);

  const projectOptions = (() => {
    const map = new Map<string, string>();
    if (projects.currentPath) {
      const curName = projects.recent.find((r) => r.path === projects.currentPath)?.name ?? projects.currentPath.split(/[\\/]/u).pop() ?? projects.currentPath;
      map.set(projects.currentPath, curName);
    }
    for (const r of projects.recent) {
      if (!map.has(r.path)) map.set(r.path, r.name);
    }
    return [...map.entries()];
  })();

  const permLabel =
    schedulePermission === 'workspace-write'
      ? t('wb.schedules.permWorkspace')
      : schedulePermission === 'read-only'
        ? t('wb.schedules.permRead')
        : t('wb.schedules.permFull');

  const openCreateForm = (prefill?: { name: string; prompt: string; frequency: ScheduleFrequency }) => {
    setEditingId(undefined);
    setName(prefill?.name ?? '');
    setPrompt(prefill?.prompt ?? '');
    const freq = prefill?.frequency ?? { kind: 'daily', time: '09:00' };
    setFreqKind(freq.kind);
    if (freq.kind === 'daily') setTimeHm(freq.time);
    else if (freq.kind === 'weekly') {
      setWeekDays([...freq.days]);
      setTimeHm(freq.time);
    } else if (freq.kind === 'interval') {
      setIntervalMinutes(freq.minutes);
    } else {
      setOnceDateTime(toLocalDateTimeInput(freq.runAt));
    }
    setBackendId(backends.active || 'dsh');
    setProjectPath(projects.currentPath ?? projects.recent[0]?.path ?? '');
    setSubTab('mine');
    setFormOpen(true);
  };

  const openEditForm = (rule: ScheduleRule) => {
    setEditingId(rule.id);
    setName(rule.name);
    setPrompt(rule.prompt);
    setFreqKind(rule.frequency.kind);
    if (rule.frequency.kind === 'daily') setTimeHm(rule.frequency.time);
    else if (rule.frequency.kind === 'weekly') {
      setWeekDays([...rule.frequency.days]);
      setTimeHm(rule.frequency.time);
    } else if (rule.frequency.kind === 'interval') {
      setIntervalMinutes(rule.frequency.minutes);
    } else {
      setOnceDateTime(toLocalDateTimeInput(rule.frequency.runAt));
    }
    setBackendId(rule.backendId);
    setProjectPath(rule.projectPath);
    setSubTab('mine');
    setFormOpen(true);
  };

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim()) return;
    let frequency: Extract<WebviewToHost, { type: 'upsertSchedule' }>['payload']['frequency'];
    if (freqKind === 'daily') {
      frequency = { kind: 'daily', time: timeHm || '09:00' };
    } else if (freqKind === 'weekly') {
      frequency = { kind: 'weekly', days: weekDays.length > 0 ? [...weekDays] : [1], time: timeHm || '09:00' };
    } else if (freqKind === 'interval') {
      frequency = { kind: 'interval', minutes: Math.max(1, Math.min(10_080, Math.round(intervalMinutes || 60))) };
    } else {
      const parsed = Date.parse(onceDateTime);
      frequency = { kind: 'once', runAt: Number.isFinite(parsed) ? parsed : Date.now() + 3600_000 };
    }

    postToHost({
      type: 'upsertSchedule',
      payload: {
        ...(editingId ? { id: editingId } : {}),
        name: name.trim(),
        prompt: prompt.trim(),
        frequency,
        backendId: backendId || 'dsh',
        ...(projectPath ? { projectPath } : {}),
        enabled: true,
      },
    });
    setFormOpen(false);
    setEditingId(undefined);
  };

  const toggleWeekDay = (day: number) => {
    setWeekDays((prev) => (prev.includes(day) ? (prev.length > 1 ? prev.filter((d) => d !== day) : prev) : [...prev, day].sort((a, b) => a - b)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-3" data-testid="workbench-schedules">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-3">
        {/* 顶栏说明与权限徽章 */}
        <div className="flex flex-wrap items-start justify-between gap-2 px-0.5">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[15px] font-semibold tracking-tight text-ink">{t('wb.schedules.title')}</h2>
            <p className="mt-0.5 mb-0 text-[12px] text-ink-3">{t('wb.schedules.subtitle')}</p>
          </div>
          <Button type="button" size="sm" data-testid="schedule-new-btn" onClick={() => openCreateForm()}>
            <PlusIcon className="size-3.5" />
            <span>{t('wb.schedules.new')}</span>
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface px-3 py-2 text-[12px] shadow-hairline">
          <div className="flex items-center gap-2 text-ink-2">
            <ShieldIcon className="size-3.5 shrink-0 text-accent-ink" />
            <span>{t('wb.schedules.permissionBadge', permLabel)}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="schedule-open-settings"
            onClick={() => openSettingsPage('other')}
          >
            <SettingsIcon className="size-3" />
            <span>{t('wb.schedules.changeInSettings')}</span>
          </Button>
        </div>

        {/* 二级切换：我的 / 模板（shadcn/ui Tabs） */}
        <Tabs value={subTab} onValueChange={(v) => setSubTab(v as 'mine' | 'templates')}>
          <TabsList>
            <TabsTrigger
              value="mine"
              data-testid="schedules-subtab-mine"
              onClick={() => setSubTab('mine')}
            >
              {t('wb.schedules.tabMine')} ({schedules.length})
            </TabsTrigger>
            <TabsTrigger
              value="templates"
              data-testid="schedules-subtab-templates"
              onClick={() => setSubTab('templates')}
            >
              {t('wb.schedules.tabTemplates')} ({TEMPLATES.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 新建 / 编辑表单 */}
        {formOpen ? (
          <section className="flex flex-col overflow-hidden rounded-card border border-accent/40 bg-surface shadow-raised" data-testid="schedule-form">
            <div className="primitive-card-bar flex items-center justify-between border-b border-line bg-inset/50">
              <h3 className="m-0 text-[13px] font-semibold text-ink">
                {editingId ? t('wb.schedules.edit') : t('wb.schedules.new')}
              </h3>
            </div>
            <div className="primitive-card-pad flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('wb.schedules.fieldName')}</span>
                <Input
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
                      type="time"
                      data-testid="schedule-input-time"
                      value={timeHm}
                      aria-label={t('wb.schedules.atTime')}
                      onChange={(e) => setTimeHm(e.target.value)}
                    />
                  ) : freqKind === 'interval' ? (
                    <Input
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
        ) : null}

        {/* 分栏一：我的定时规则 */}
        {subTab === 'mine' ? (
          <div className="flex flex-col gap-2.5" data-testid="schedules-list-mine">
            {schedules.length === 0 ? (
              <div className="rounded-card bg-surface px-4 py-8 text-center text-[12.5px] text-ink-3 shadow-card">
                {t('wb.schedules.empty')}
              </div>
            ) : (
              schedules.map((rule) => {
                const backendName = backends.items.find((b) => b.id === rule.backendId)?.name ?? rule.backendId;
                const projectName = rule.projectPath.split(/[\\/]/u).pop() || rule.projectPath;
                const historyOpen = expandedRuleId === rule.id;
                const unreadCount = rule.runs.filter((r) => r.unread).length;

                return (
                  <section
                    key={rule.id}
                    className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
                    data-testid={`schedule-card-${rule.id}`}
                  >
                    <div className="primitive-card-pad flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ClockIcon className="size-3.5 shrink-0 text-accent-ink" />
                            <span className="text-[13.5px] font-semibold text-ink">{rule.name}</span>
                            <ValuePill>{backendName}</ValuePill>
                            <span className="rounded-chip bg-field px-2 py-0.5 text-[11px] text-ink-3 shadow-hairline">
                              {projectName}
                            </span>
                            {rule.lastStatus === 'running' ? (
                              <ValuePill tone="accent">{t('wb.schedules.statusRunning')}</ValuePill>
                            ) : null}
                          </div>
                          <p className="mt-1 mb-0 line-clamp-2 text-[12px] text-ink-2">{rule.prompt}</p>
                        </div>

                        <Switch
                          aria-label={rule.name}
                          className="shrink-0"
                          checked={rule.enabled}
                          onCheckedChange={(enabled) =>
                            postToHost({ type: 'toggleSchedule', payload: { id: rule.id, enabled } })
                          }
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[11.5px] text-ink-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{formatFrequencySummary(rule.frequency, t)}</span>
                          <span>·</span>
                          <span>
                            {rule.enabled && rule.nextRunAt
                              ? t('wb.schedules.nextRun', new Date(rule.nextRunAt).toLocaleString())
                              : t('wb.schedules.paused')}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            data-testid={`schedule-history-toggle-${rule.id}`}
                            onClick={() => setExpandedRuleId(historyOpen ? undefined : rule.id)}
                          >
                            {historyOpen ? (
                              <ChevronDownIcon className="size-3" />
                            ) : (
                              <ChevronRightIcon className="size-3" />
                            )}
                            <span>{t('wb.schedules.history', rule.runs.length)}</span>
                            {unreadCount > 0 ? (
                              <span className="ml-0.5 size-2 rounded-full bg-accent" />
                            ) : null}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            data-testid={`schedule-run-now-${rule.id}`}
                            disabled={rule.lastStatus === 'running'}
                            onClick={() => {
                              setExpandedRuleId(rule.id);
                              postToHost({ type: 'runScheduleNow', payload: { id: rule.id } });
                            }}
                          >
                            {rule.lastStatus === 'running' ? (
                              <SpinnerIcon className="size-3" />
                            ) : (
                              <PlayIcon className="size-3" />
                            )}
                            <span>{t('wb.schedules.runNow')}</span>
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t('common.edit')}
                            onClick={() => openEditForm(rule)}
                          >
                            <PencilIcon className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t('common.delete')}
                            onClick={() => postToHost({ type: 'deleteSchedule', payload: { id: rule.id } })}
                          >
                            <TrashIcon className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* 规则内部执行历史（不进左侧会话列表，直接在此查阅结果） */}
                    {historyOpen ? (
                      <div
                        className="border-t border-line bg-inset/40 px-3 py-2.5"
                        data-testid={`schedule-history-${rule.id}`}
                      >
                        {rule.runs.length === 0 ? (
                          <div className="py-2 text-[12px] text-ink-3">{t('wb.schedules.historyEmpty')}</div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {rule.runs.map((run) => {
                              const isRunOpen = expandedRunId === run.id || rule.runs[0]?.id === run.id;
                              return (
                                <div
                                  key={run.id}
                                  className="overflow-hidden rounded-control border border-line bg-surface"
                                  data-testid={`schedule-run-${run.id}`}
                                >
                                  <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-hover"
                                    onClick={() => {
                                      setExpandedRunId(expandedRunId === run.id ? '__none__' : run.id);
                                      if (run.unread) {
                                        postToHost({
                                          type: 'markScheduleRunRead',
                                          payload: { ruleId: rule.id, runId: run.id },
                                        });
                                      }
                                    }}
                                  >
                                    <span className="flex items-center gap-2">
                                      <span
                                        className={cn(
                                          'size-2 rounded-full',
                                          run.status === 'running'
                                            ? 'bg-accent'
                                            : run.status === 'failed'
                                              ? 'bg-orange'
                                              : 'bg-emerald-500',
                                        )}
                                      />
                                      <span className="font-mono text-[11.5px] text-ink">
                                        {new Date(run.startedAt).toLocaleString()}
                                      </span>
                                      <span className="text-ink-3">
                                        {run.status === 'running'
                                          ? t('wb.schedules.statusRunning')
                                          : run.status === 'failed'
                                            ? t('wb.schedules.statusFailed')
                                            : t('wb.schedules.statusSucceeded')}
                                      </span>
                                      {run.unread ? <span className="size-1.5 rounded-full bg-accent" /> : null}
                                    </span>
                                    {isRunOpen ? (
                                      <ChevronDownIcon className="size-3 text-ink-3" />
                                    ) : (
                                      <ChevronRightIcon className="size-3 text-ink-3" />
                                    )}
                                  </button>
                                  {isRunOpen && (run.output || run.error) ? (
                                    <div className="border-t border-line px-3 py-2.5 text-[12.5px]">
                                      {run.error ? (
                                        <div className="mb-2 rounded-control bg-orange/10 px-2.5 py-1.5 text-[12px] text-orange">
                                          {run.error}
                                        </div>
                                      ) : null}
                                      {run.output ? <Markdown text={run.output} /> : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </section>
                );
              })
            )}
          </div>
        ) : (
          /* 分栏二：精选定时模板 */
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" data-testid="schedules-list-templates">
            {TEMPLATES.map((tpl) => (
              <div
                key={tpl.id}
                className="flex flex-col justify-between gap-3 rounded-card bg-surface p-3.5 shadow-card"
                data-testid={`schedule-template-${tpl.id}`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="m-0 text-[13.5px] font-semibold text-ink">{t(tpl.nameKey)}</h4>
                    <ValuePill>{formatFrequencySummary(tpl.defaultFrequency, t)}</ValuePill>
                  </div>
                  <p className="mt-1.5 mb-0 text-[12px] leading-relaxed text-ink-2">{t(tpl.descKey)}</p>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    data-testid={`use-template-${tpl.id}`}
                    onClick={() =>
                      openCreateForm({
                        name: t(tpl.nameKey),
                        prompt: t(tpl.promptKey),
                        frequency: tpl.defaultFrequency,
                      })
                    }
                  >
                    <PlusIcon className="size-3" />
                    <span>{t('wb.schedules.useTemplate')}</span>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

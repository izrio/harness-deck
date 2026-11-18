/**
 * 工作台 · 定时模块（SchedulesView）
 *
 * - 到点新开一个隔离会话，以默认「全部放行」（可在设置页修改）无人值守做完；
 * - 执行结果保存在每条规则自己的历史记录里（支持展开查看完整 Markdown 输出），绝不进入左侧会话列表；
 * - 包含「我的」与「模板」两大分栏；支持新建/编辑定时任务（任务名称、任务内容、什么时候、使用什么 harness 执行、项目）。
 */
import { useEffect, useState } from 'react';
import type { ScheduleFrequency, ScheduleRule, WebviewToHost } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { openSettingsPage, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { PlusIcon, SettingsIcon, ShieldIcon } from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { getProjectOptions } from '@/lib/workbenchOptions';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TEMPLATES, formatFrequencySummary, toLocalDateTimeInput } from './schedules/scheduleTemplates.ts';
import { ScheduleRuleCard } from './schedules/ScheduleRuleCard.tsx';
import { ScheduleForm } from './schedules/ScheduleForm.tsx';

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
  const [expandedRunsByRule, setExpandedRunsByRule] = useState<Record<string, string | null>>({});

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

  const projectOptions = getProjectOptions(projects);

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
          <ScheduleForm backends={backends} setFormOpen={setFormOpen} editingId={editingId} name={name} setName={setName} prompt={prompt} setPrompt={setPrompt} freqKind={freqKind} setFreqKind={setFreqKind} timeHm={timeHm} setTimeHm={setTimeHm} weekDays={weekDays} intervalMinutes={intervalMinutes} setIntervalMinutes={setIntervalMinutes} onceDateTime={onceDateTime} setOnceDateTime={setOnceDateTime} backendId={backendId} setBackendId={setBackendId} projectPath={projectPath} setProjectPath={setProjectPath} projectOptions={projectOptions} handleSubmit={handleSubmit} toggleWeekDay={toggleWeekDay} />
        ) : null}

        {/* 分栏一：我的定时规则 */}
        {subTab === 'mine' ? (
          <div className="flex flex-col gap-2.5" data-testid="schedules-list-mine">
            {schedules.length === 0 ? (
              <div className="rounded-card bg-surface px-4 py-8 text-center text-[12.5px] text-ink-3 shadow-card">
                {t('wb.schedules.empty')}
              </div>
            ) : (
              schedules.map((rule) => (
                <ScheduleRuleCard
                  key={rule.id}
                  rule={rule}
                  backendItems={backends.items}
                  historyOpen={expandedRuleId === rule.id}
                  setExpandedRuleId={setExpandedRuleId}
                  expandedRunsByRule={expandedRunsByRule}
                  setExpandedRunsByRule={setExpandedRunsByRule}
                  openEditForm={openEditForm}
                />
              ))
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

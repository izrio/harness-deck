import { cn } from '../../../lib/utils.ts';
import { postToHost } from '../../../vscode.ts';
import { ChevronDownIcon, ChevronRightIcon, ClockIcon, PencilIcon, PlayIcon, SpinnerIcon, TrashIcon } from '../../icons.tsx';
import { Markdown } from '../../Markdown.tsx';
import { ValuePill } from '../../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { formatFrequencySummary } from './scheduleTemplates.ts';
import type { BackendView, ScheduleRule } from '@harness-deck/shared';
import type { Dispatch, SetStateAction } from 'react';
import { useT } from '../../../i18n.ts';

export function ScheduleRuleCard({ rule, backendItems, historyOpen, setExpandedRuleId, expandedRunsByRule, setExpandedRunsByRule, openEditForm }: { rule: ScheduleRule; backendItems: readonly BackendView[]; historyOpen: boolean; setExpandedRuleId: Dispatch<SetStateAction<string | undefined>>; expandedRunsByRule: Readonly<Record<string, string | null>>; setExpandedRunsByRule: Dispatch<SetStateAction<Record<string, string | null>>>; openEditForm: (rule: ScheduleRule) => void }) {
  const t = useT();
  const backendName = backendItems.find((b) => b.id === rule.backendId)?.name ?? rule.backendId;
  const projectName = rule.projectPath.split(/[\\/]/u).pop() || rule.projectPath;
  const unreadCount = rule.runs.filter((r) => r.unread).length;
  return (
    <section
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
                  <span className="ml-0.5 size-2 rounded-full bg-brand" />
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
                  setExpandedRunsByRule((prev) => {
                    if (!(rule.id in prev)) return prev;
                    const next = { ...prev };
                    delete next[rule.id];
                    return next;
                  });
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
                  const activeRunId =
                    expandedRunsByRule[rule.id] === undefined
                      ? rule.runs[0]?.id
                      : expandedRunsByRule[rule.id];
                  const isRunOpen = activeRunId === run.id;
                  return (
                    <div
                      key={run.id}
                      className="overflow-hidden rounded-control border border-line bg-surface"
                      data-testid={`schedule-run-${run.id}`}
                    >
                      <button
                        type="button"
                        aria-expanded={isRunOpen}
                        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-hover"
                        onClick={() => {
                          setExpandedRunsByRule((prev) => ({
                            ...prev,
                            [rule.id]: isRunOpen ? null : run.id,
                          }));
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
                                ? 'bg-brand'
                                : run.status === 'failed'
                                  ? 'bg-orange'
                                  : 'bg-green',
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
                          {run.unread ? <span className="size-1.5 rounded-full bg-brand" /> : null}
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
}

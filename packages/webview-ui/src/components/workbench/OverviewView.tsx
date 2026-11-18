/**
 * 工作台 · 总览模块（OverviewView）
 *
 * 集中展示进行中的工作，围绕五大区块：
 * 1. 等我（waiting）：审批/提问/计划确认 + 待验收看板任务
 * 2. 待办（todos）：当前会话待办清单 + 待执行看板任务
 * 3. 在跑（running）：正在运行的会话、看板任务、定时作业
 * 4. 接下来（upcoming）：即将触发的定时规则 + 顺序排队的看板任务
 * 5. 未读（unread）：尚未查看的完成回复、定时历史结果与待验收结果
 */
import { useT, type Translate } from '../../i18n.ts';
import { setActiveModule, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  BellIcon,
  CheckIcon,
  ChecklistIcon,
  ClockIcon,
  QuestionIcon,
  SpinnerIcon,
} from '../icons.tsx';
import { Button } from '../ui/Button.tsx';
import { ValuePill } from '../ui/ValuePill.tsx';

function formatShortTime(ts: number, t: Translate): string {
  const diffMin = Math.round((ts - Date.now()) / 60_000);
  if (diffMin > 0) {
    if (diffMin < 60) return `${diffMin}m`;
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const pastMin = Math.round((Date.now() - ts) / 60_000);
  if (pastMin < 1) return t('time.now');
  if (pastMin < 60) return t('time.minutes', pastMin);
  const hours = Math.round(pastMin / 60);
  if (hours < 24) return t('time.hours', hours);
  return new Date(ts).toLocaleDateString();
}

export function OverviewView() {
  const t = useT();
  const overview = useView((s) => s.workbench.overview);

  const openSession = (projectPath?: string, sessionId?: string, backendId?: string) => {
    if (sessionId && projectPath) {
      postToHost({
        type: 'openProjectSession',
        payload: { projectPath, sessionId, ...(backendId ? { backendId } : {}) },
      });
    } else {
      setActiveModule('sessions');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-3" data-testid="workbench-overview">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
          <div>
            <h2 className="m-0 text-[15px] font-semibold tracking-tight text-ink">{t('wb.overview.title')}</h2>
            <p className="mt-0.5 mb-0 text-[12px] text-ink-3">{t('wb.overview.subtitle')}</p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => postToHost({ type: 'openWorkbenchPanel', payload: {} })}
            title={t('wb.openPanel')}
          >
            <span>{t('wb.openPanel')}</span>
          </Button>
        </div>

        {/* 1. 等我（高优置顶全宽卡片） */}
        <section
          className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
          data-testid="overview-block-waiting"
        >
          <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
            <div className="flex items-center gap-2">
              <QuestionIcon className="size-3.5 shrink-0 text-orange" />
              <h3 className="m-0 text-[13px] font-semibold text-ink">{t('wb.overview.waiting')}</h3>
              <ValuePill tone={overview.waiting.length > 0 ? 'accent' : 'neutral'}>{overview.waiting.length}</ValuePill>
            </div>
            <span className="text-[11.5px] text-ink-3">{t('wb.overview.waitingHint')}</span>
          </div>
          <div className="primitive-card-pad flex flex-col gap-2">
            {overview.waiting.length === 0 ? (
              <div className="py-2 text-[12px] text-ink-3">{t('wb.overview.waitingEmpty')}</div>
            ) : (
              overview.waiting.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2.5 rounded-control border border-line bg-field/60 px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="size-2 shrink-0 rounded-full bg-orange" />
                      <span className="truncate text-[12.5px] font-medium text-ink">{item.title}</span>
                      {item.projectName ? (
                        <span className="shrink-0 rounded-chip bg-surface px-1.5 py-0.5 text-[10.5px] text-ink-3 shadow-hairline">
                          {item.projectName}
                        </span>
                      ) : null}
                    </div>
                    {item.subtitle ? <div className="mt-0.5 truncate text-[11.5px] text-ink-2">{item.subtitle}</div> : null}
                  </div>
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={() => {
                      if (item.kind === 'task-review') {
                        setActiveModule('tasks');
                      } else {
                        openSession(item.projectPath, item.sessionId, item.backendId);
                      }
                    }}
                  >
                    {item.kind === 'task-review' ? t('wb.overview.reviewNow') : t('wb.overview.handleNow')}
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 中部响应式双列网格：2. 在跑 + 3. 待办 + 4. 接下来 + 5. 未读 */}
        <div className="grid grid-cols-1 gap-3 @[680px]:grid-cols-2 sm:grid-cols-2">
          {/* 2. 在跑 */}
          <section
            className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
            data-testid="overview-block-running"
          >
            <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
              <div className="flex items-center gap-2">
                <SpinnerIcon className="size-3.5 shrink-0 text-accent-ink" />
                <h3 className="m-0 text-[13px] font-semibold text-ink">{t('wb.overview.running')}</h3>
                <ValuePill tone={overview.running.length > 0 ? 'accent' : 'neutral'}>{overview.running.length}</ValuePill>
              </div>
            </div>
            <div className="primitive-card-pad flex flex-col gap-2">
              {overview.running.length === 0 ? (
                <div className="py-2 text-[12px] text-ink-3">{t('wb.overview.runningEmpty')}</div>
              ) : (
                overview.running.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-control border border-line bg-field/50 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="size-2 shrink-0 rounded-full bg-accent"
                          style={{ animation: 'pulse 1.4s ease-in-out infinite' }}
                        />
                        <span className="truncate text-[12.5px] font-medium text-ink">{item.title}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-ink-3">
                        {[item.projectName, item.backendName].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        if (item.kind === 'schedule') {
                          setActiveModule('schedules', item.ruleId);
                        } else if (item.sessionId) {
                          openSession(item.projectPath, item.sessionId, item.backendId);
                        } else {
                          setActiveModule('tasks');
                        }
                      }}
                    >
                      {item.kind === 'schedule' ? t('wb.overview.viewHistory') : t('wb.overview.openSession')}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 3. 待办 */}
          <section
            className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
            data-testid="overview-block-todos"
          >
            <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
              <div className="flex items-center gap-2">
                <ChecklistIcon className="size-3.5 shrink-0 text-accent-ink" />
                <h3 className="m-0 text-[13px] font-semibold text-ink">{t('wb.overview.todos')}</h3>
                <ValuePill>{overview.todos.length}</ValuePill>
              </div>
              <Button variant="quiet" size="xs" onClick={() => setActiveModule('tasks')}>
                {t('wb.overview.openTasks')}
              </Button>
            </div>
            <div className="primitive-card-pad flex flex-col gap-1.5">
              {overview.todos.length === 0 ? (
                <div className="py-2 text-[12px] text-ink-3">{t('wb.overview.todosEmpty')}</div>
              ) : (
                overview.todos.slice(0, 8).map((todo) => (
                  <button
                    key={todo.id}
                    type="button"
                    className="flex items-start gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
                    onClick={() => {
                      if (todo.kind === 'kanban-todo') {
                        setActiveModule('tasks');
                      } else {
                        openSession(todo.projectPath, todo.sessionId, todo.backendId);
                      }
                    }}
                  >
                    <span
                      className={`mt-1 size-2 shrink-0 rounded-full ${todo.status === 'in_progress' ? 'bg-accent' : 'border border-ink-3'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-ink">{todo.content}</span>
                      {todo.contextLabel ? (
                        <span className="block truncate text-[11px] text-ink-3">{todo.contextLabel}</span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* 4. 接下来 */}
          <section
            className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
            data-testid="overview-block-upcoming"
          >
            <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
              <div className="flex items-center gap-2">
                <ClockIcon className="size-3.5 shrink-0 text-accent-ink" />
                <h3 className="m-0 text-[13px] font-semibold text-ink">{t('wb.overview.upcoming')}</h3>
                <ValuePill>{overview.upcoming.length}</ValuePill>
              </div>
            </div>
            <div className="primitive-card-pad flex flex-col gap-1.5">
              {overview.upcoming.length === 0 ? (
                <div className="py-2 text-[12px] text-ink-3">{t('wb.overview.upcomingEmpty')}</div>
              ) : (
                overview.upcoming.slice(0, 8).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
                    onClick={() =>
                      item.kind === 'schedule' ? setActiveModule('schedules', item.ruleId) : setActiveModule('tasks')
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{item.title}</span>
                      <span className="block truncate text-[11px] text-ink-3">
                        {[item.projectName, item.backendName].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-chip bg-field px-2 py-0.5 font-mono text-[11px] text-ink-2 shadow-hairline">
                      {item.kind === 'schedule' && item.nextRunAt
                        ? formatShortTime(item.nextRunAt, t)
                        : t('wb.overview.queuePos', item.queuePosition ?? 1)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* 5. 未读 */}
          <section
            className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
            data-testid="overview-block-unread"
          >
            <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
              <div className="flex items-center gap-2">
                <BellIcon className="size-3.5 shrink-0 text-accent-ink" />
                <h3 className="m-0 text-[13px] font-semibold text-ink">{t('wb.overview.unread')}</h3>
                <ValuePill tone={overview.unread.length > 0 ? 'accent' : 'neutral'}>{overview.unread.length}</ValuePill>
              </div>
              {overview.unread.length > 0 ? (
                <Button
                  variant="quiet"
                  size="xs"
                  data-testid="overview-mark-all-read"
                  onClick={() => postToHost({ type: 'markUnreadRead', payload: { all: true } })}
                >
                  <CheckIcon className="size-3" />
                  <span>{t('wb.overview.markAllRead')}</span>
                </Button>
              ) : null}
            </div>
            <div className="primitive-card-pad flex flex-col gap-2">
              {overview.unread.length === 0 ? (
                <div className="py-2 text-[12px] text-ink-3">{t('wb.overview.unreadEmpty')}</div>
              ) : (
                overview.unread.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-control border border-line bg-field/50 px-2.5 py-2"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        postToHost({ type: 'markUnreadRead', payload: { id: item.id } });
                        if (item.kind === 'schedule-run') {
                          setActiveModule('schedules', item.ruleId);
                        } else if (item.kind === 'task-review') {
                          setActiveModule('tasks');
                        } else {
                          openSession(item.projectPath, item.sessionId, item.backendId);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-full bg-accent" />
                        <span className="truncate text-[12.5px] font-medium text-ink">{item.title}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[11.5px] text-ink-2">{item.summary}</div>
                    </button>
                    <Button
                      variant="quiet"
                      size="xs"
                      title={t('wb.overview.markRead')}
                      aria-label={t('wb.overview.markRead')}
                      onClick={() => postToHost({ type: 'markUnreadRead', payload: { id: item.id } })}
                    >
                      <CheckIcon className="size-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

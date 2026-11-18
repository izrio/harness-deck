/**
 * 输入框上方的状态栏（Beautiful UI TaskRows 风格）：
 * 待办、本会话改动、未保存文件合在一张紧凑卡片里，顶部/底部细进度条。
 */
import { useState } from 'react';
import { useView } from '../store.ts';
import { loadState, postToHost, saveState } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { GlideMenu, Shimmer, TaskRows, ValuePill } from './beautifului/index.ts';
import { ChangedFileButton, Stats } from './Items.tsx';
import { ChecklistIcon, ChevronRightIcon, CloseIcon, DiffIcon, SaveIcon, TargetIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

type Panel = 'todos' | 'changes';

export function StatusDock() {
  const todos = useView((s) => s.session.todos);
  const goal = useView((s) => s.session.goal);
  const running = useView((s) => s.session.running);
  const changes = useView((s) => s.session.changes);
  const sessionKey = useView((s) => s.sessionKey);
  const dirtyFiles = useView((s) => s.workspace.dirtyFiles);
  const [open, setOpen] = useState<Panel | undefined>(() => loadState().dockOpen ?? (loadState().changesOpen ? 'changes' : undefined));
  const [dismissed, setDismissed] = useState(() => loadState().changesDismissed);
  const t = useT();

  const signature = changes?.files.length ? `${sessionKey}|${changes.files.length}|${changes.additions}|${changes.deletions}` : undefined;
  const shownChanges = changes && signature && dismissed !== signature ? changes : undefined;
  const hasTodos = Boolean(todos?.length);
  if (!hasTodos && !goal && !shownChanges && dirtyFiles === 0) return null;

  const toggle = (panel: Panel) => {
    const next = open === panel ? undefined : panel;
    setOpen(next);
    saveState({ dockOpen: next });
  };
  const dismissChanges = () => {
    setDismissed(signature);
    saveState({ changesDismissed: signature });
  };
  const done = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const current = todos?.find((todo) => todo.status === 'in_progress') ?? todos?.find((todo) => todo.status === 'pending');
  const panel = open === 'todos' && hasTodos ? 'todos' : open === 'changes' && shownChanges ? 'changes' : undefined;

  return (
    <section
      className="dock mb-2 overflow-hidden rounded-card bg-surface text-[12px] shadow-card"
      aria-label={t('dock.label')}
      data-testid="dock"
    >
      {goal ? (
        <div
          className={cn(
            'status-strip__goal primitive-card-bar flex w-full min-w-0 items-center gap-2 border-b border-line bg-inset/60 text-left text-ink-2',
            `status-strip__goal--${goal.phase}`,
          )}
          title={goal.blockedReason ?? goal.objective}
        >
          <TargetIcon className="size-3.5 shrink-0 text-ink-3" />
          <span className="status-strip__label shrink-0 font-medium text-ink">{t('goal.label')}</span>
          <span className="status-strip__text min-w-0 flex-1 truncate">{goal.objective}</span>
          <ValuePill tone={goal.phase === 'blocked' ? 'red' : 'neutral'} className="status-strip__meta ml-auto shrink-0">
            {goal.maxRounds ? t('goal.round', goal.round, goal.maxRounds) : ''}
            {t(`goal.${goal.phase}`)}
          </ValuePill>
        </div>
      ) : null}

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: panel === 'todos' && todos ? '1fr' : '0fr',
          opacity: panel === 'todos' && todos ? 1 : 0,
          transitionTimingFunction: 'var(--ease-out-strong)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          {panel === 'todos' && todos ? (
            <TaskRows
              id="dock-panel"
              items={todos}
              active={running}
              labels={{
                completed: t('todo.completed'),
                inProgress: t('todo.inProgress'),
                pending: t('todo.pending'),
              }}
              className="dock__panel max-h-[min(40vh,260px)] overflow-y-auto border-b border-line p-1.5"
            />
          ) : null}
        </div>
      </div>

      {panel === 'changes' && shownChanges ? (
        <div className="dock__panel max-h-[min(40vh,260px)] overflow-y-auto border-b border-line p-1" id="dock-panel">
          <GlideMenu highlightClassName="inset-x-0 rounded-[6px] bg-hover">
            <ul className="session-changes__list m-0 list-none p-0" aria-label={t('sessionChanges.label')}>
              {shownChanges.files.map((file) => (
                <li key={file.path}>
                  <ChangedFileButton
                    file={file}
                    className="session-changes__file relative z-10 flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left transition-colors duration-100"
                  />
                </li>
              ))}
            </ul>
          </GlideMenu>
        </div>
      ) : null}

      {hasTodos || shownChanges || dirtyFiles > 0 ? (
        <div className="dock__bar flex flex-wrap items-center gap-1 p-1">
          {todos?.length ? (
            <button
              type="button"
              className="dock__seg dock__seg--todos todo-card__header inline-flex h-7 min-w-0 flex-[1_1_14em] items-center gap-1.5 rounded-[7px] px-2 text-left text-ink transition-colors duration-100 hover:bg-hover"
              aria-expanded={panel === 'todos'}
              {...(panel === 'todos' ? { 'aria-controls': 'dock-panel' } : {})}
              onClick={() => toggle('todos')}
              data-testid="status-strip"
            >
              <ChevronRightIcon className={cn('chevron size-3.5 shrink-0 text-ink-3 transition-transform duration-200', panel === 'todos' && 'chevron--open rotate-90')} />
              <ChecklistIcon className="todo-card__icon size-3.5 shrink-0 text-ink-2" />
              <span className="status-strip__label shrink-0 font-medium text-ink">{t('todo.title')}</span>
              {panel !== 'todos' && current ? (
                <span className="dock__seg-text min-w-0 flex-1 truncate text-ink-2">
                  {current.status === 'in_progress' && running ? (
                    <Shimmer className="max-w-full truncate align-bottom">{current.content}</Shimmer>
                  ) : (
                    current.content
                  )}
                </span>
              ) : (
                <span className="dock__spacer flex-1" />
              )}
              <ValuePill tone={done === todos.length ? 'green' : 'neutral'} className="todo-card__count text-[11px] tabular-nums">
                {done}/{todos.length}
              </ValuePill>
            </button>
          ) : null}

          {shownChanges ? (
            <span className="dock__group inline-flex shrink-0 items-center gap-0.5" data-testid="session-changes">
              <button
                type="button"
                className="dock__seg session-changes__toggle inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-left text-ink transition-colors duration-100 hover:bg-hover"
                aria-expanded={panel === 'changes'}
                {...(panel === 'changes' ? { 'aria-controls': 'dock-panel' } : {})}
                onClick={() => toggle('changes')}
                title={panel === 'changes' ? t('sessionChanges.collapse') : t('sessionChanges.expand')}
              >
                <ChevronRightIcon className={cn('chevron size-3.5 shrink-0 text-ink-3 transition-transform duration-200', panel === 'changes' && 'chevron--open rotate-90')} />
                <DiffIcon className="size-3.5 shrink-0 text-ink-3" />
                <span className="dock__seg-label whitespace-nowrap font-medium">{t('dock.changes', shownChanges.files.length)}</span>
                <Stats stats={shownChanges} />
              </button>
              <button
                type="button"
                className="inline-flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
                onClick={dismissChanges}
                aria-label={t('sessionChanges.hide')}
                title={t('sessionChanges.hide')}
              >
                <CloseIcon className="size-3" />
              </button>
            </span>
          ) : null}

          {dirtyFiles > 0 ? (
            <span className="dock__group dock__group--dirty ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] bg-orange-tint px-2 text-orange" title={t('dock.dirtyTitle', dirtyFiles)} data-testid="dirty-strip">
              <SaveIcon className="dirty-strip__icon size-3.5 shrink-0" />
              <span className="dock__seg-label whitespace-nowrap">{t('dock.dirty', dirtyFiles)}</span>
              <span className="sr-only">{t('dock.dirtyTitle', dirtyFiles)}</span>
              <button type="button" className="link-button font-medium text-ink hover:underline" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
                {t('dirty.saveAll')}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      {todos?.length ? (
        <div
          className="todo-progress h-[2px] overflow-hidden bg-line"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={todos.length}
          aria-valuenow={done}
          aria-label={t('todo.label', done, todos.length)}
        >
          <span
            className={cn('todo-progress__bar block h-full transition-[width] duration-300', done === todos.length ? 'bg-green' : 'bg-ink')}
            style={{ width: `${(done / todos.length) * 100}%` }}
          />
        </div>
      ) : null}
    </section>
  );
}

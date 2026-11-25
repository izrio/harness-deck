/**
 * 输入框上方的状态栏（Beautiful UI TaskRows 风格）：
 * 待办、本会话改动、未保存文件合在一张紧凑卡片里，待办/改动列表作为浮层向上展开。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  const dockRef = useRef<HTMLElement>(null);
  const t = useT();

  const signature = changes?.files.length ? `${sessionKey}|${changes.files.length}|${changes.additions}|${changes.deletions}` : undefined;
  const shownChanges = changes && signature && dismissed !== signature ? changes : undefined;
  const hasTodos = Boolean(todos?.length);
  const panel = open === 'todos' && hasTodos ? 'todos' : open === 'changes' && shownChanges ? 'changes' : undefined;

  const close = useCallback(() => {
    setOpen(undefined);
    saveState({ dockOpen: undefined });
  }, []);

  useEffect(() => {
    if (!panel) return;
    const onPointerDown = (event: PointerEvent) => {
      if (dockRef.current && !dockRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panel, close]);

  if (!hasTodos && !goal && !shownChanges && dirtyFiles === 0) return null;

  const toggle = (target: Panel) => {
    const next = open === target ? undefined : target;
    setOpen(next);
    saveState({ dockOpen: next });
  };
  const dismissChanges = () => {
    setDismissed(signature);
    saveState({ changesDismissed: signature });
  };
  const done = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const current = todos?.find((todo) => todo.status === 'in_progress') ?? todos?.find((todo) => todo.status === 'pending');

  return (
    <section
      ref={dockRef}
      className="dock relative mb-1.5 w-full text-[12px]"
      aria-label={t('dock.label')}
      data-testid="dock"
    >
      {panel === 'todos' && todos ? (
        <div
          id="dock-panel"
          className="dock__panel dropdown-glass absolute inset-x-0 bottom-[calc(100%+6px)] z-15 overflow-hidden rounded-xl border p-0 text-ink"
          style={{ animation: 'pop-in 170ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom center' }}
        >
          <ScrollArea className="max-h-[min(40vh,260px)]">
            <div className="p-1.5">
              <TaskRows
                items={todos}
                active={running}
                labels={{
                  completed: t('todo.completed'),
                  inProgress: t('todo.inProgress'),
                  pending: t('todo.pending'),
                }}
              />
            </div>
          </ScrollArea>
        </div>
      ) : null}

      {panel === 'changes' && shownChanges ? (
        <div
          id="dock-panel"
          className="dock__panel dropdown-glass absolute inset-x-0 bottom-[calc(100%+6px)] z-15 overflow-hidden rounded-xl border p-0 text-ink"
          style={{ animation: 'pop-in 170ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom center' }}
        >
          <ScrollArea className="max-h-[min(40vh,260px)]">
            <div className="p-1">
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
          </ScrollArea>
        </div>
      ) : null}

      <div className="dock__card surface-glass overflow-hidden rounded-xl border border-black/8 shadow-[var(--shadow-composer)] dark:border-white/[0.06]">
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

        {hasTodos || shownChanges || dirtyFiles > 0 ? (
          <div className="dock__bar flex flex-col items-stretch divide-y divide-line">
            {todos?.length ? (
              <div className="p-1">
                <button
                  type="button"
                  className="dock__seg dock__seg--todos todo-card__header flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[7px] px-2 text-left text-ink transition-colors duration-100 hover:bg-hover"
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
              </div>
            ) : null}

            {shownChanges ? (
              <div className="p-1">
                <span
                  className="dock__group flex h-7 w-full min-w-0 items-center gap-0.5 rounded-[7px] pr-0.5 transition-colors duration-100 hover:bg-hover"
                  data-testid="session-changes"
                >
                  <button
                    type="button"
                    className="dock__seg session-changes__toggle flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-ink"
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
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:text-ink"
                    onClick={dismissChanges}
                    aria-label={t('sessionChanges.hide')}
                    title={t('sessionChanges.hide')}
                  >
                    <CloseIcon className="size-3" />
                  </button>
                </span>
              </div>
            ) : null}

            {dirtyFiles > 0 ? (
              <div className="flex justify-end p-1">
                <span className="dock__group dock__group--dirty inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] bg-orange-tint px-2 text-orange" title={t('dock.dirtyTitle', dirtyFiles)} data-testid="dirty-strip">
                  <SaveIcon className="dirty-strip__icon size-3.5 shrink-0" />
                  <span className="dock__seg-label whitespace-nowrap">{t('dock.dirty', dirtyFiles)}</span>
                  <span className="sr-only">{t('dock.dirtyTitle', dirtyFiles)}</span>
                  <button type="button" className="link-button font-medium text-ink hover:underline" onClick={() => postToHost({ type: 'saveAll', payload: {} })}>
                    {t('dirty.saveAll')}
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

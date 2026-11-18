import { cn } from '../../lib/utils.ts';
import { CheckIcon } from '../icons.tsx';
import { Shimmer } from './Shimmer.tsx';
import { ValuePill } from './ValuePill.tsx';

export type TaskRowStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskRowItem {
  readonly id?: string | number;
  readonly content: string;
  readonly status: TaskRowStatus;
}

export interface TaskRowsLabels {
  readonly completed?: string;
  readonly inProgress?: string;
  readonly pending?: string;
}

function TaskStatusRing({ active }: { active: boolean }) {
  const size = 16;
  const stroke = 1.75;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  if (!active) {
    return (
      <span
        className="inline-flex size-4 items-center justify-center rounded-full bg-surface shadow-[inset_0_0_0_1.5px_var(--accent)]"
        aria-hidden
      >
        <span className="size-1.5 rounded-full bg-brand" />
      </span>
    );
  }

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <svg width={size} height={size} className="absolute inset-0" style={{ animation: 'spin 1.1s linear infinite' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.3} ${c * 0.7}`}
        />
      </svg>
      <span className="size-1.5 rounded-full bg-brand" />
    </span>
  );
}

/** Beautiful UI TaskRows：展示多步骤任务行及其运行/完成/待处理状态。 */
export function TaskRows({
  items,
  active = false,
  labels,
  id,
  className = '',
  rowClassName = '',
}: {
  items: readonly TaskRowItem[];
  active?: boolean;
  labels?: TaskRowsLabels;
  id?: string;
  className?: string;
  rowClassName?: string;
}) {
  const statusLabelOf = (status: TaskRowStatus): string => {
    if (status === 'completed') return labels?.completed ?? 'Completed';
    if (status === 'in_progress') return labels?.inProgress ?? 'In progress';
    return labels?.pending ?? 'Pending';
  };

  return (
    <ol id={id} className={cn('todo-list m-0 flex list-none flex-col gap-1 p-0', className)}>
      {items.map((item, index) => {
        const statusLabel = statusLabelOf(item.status);
        const inProgress = item.status === 'in_progress';
        const completed = item.status === 'completed';

        return (
          <li
            key={item.id ?? index}
            className={cn(
              'todo relative flex items-start gap-2 rounded-control px-2 py-1.5 leading-snug transition-colors duration-150',
              inProgress ? 'bg-field/85 shadow-hairline' : 'hover:bg-hover/55',
              `todo--${item.status}`,
              rowClassName,
            )}
          >
            <span
              className={cn(
                'todo__mark mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full',
                completed
                  ? 'bg-green text-brand-foreground'
                  : inProgress
                    ? 'text-accent-ink'
                    : 'bg-surface/60 text-ink-3 shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
              )}
              aria-label={statusLabel}
            >
              {completed ? (
                <CheckIcon className="size-2.5" strokeWidth={2.8} />
              ) : inProgress ? (
                <TaskStatusRing active={active} />
              ) : null}
            </span>
            <span
              className={cn(
                'todo__text min-w-0 flex-1 [overflow-wrap:anywhere]',
                completed ? 'text-ink-3 line-through' : inProgress ? 'font-medium text-ink' : 'text-ink-2',
              )}
            >
              {item.content}
            </span>
            {inProgress ? (
              <ValuePill tone="accent" className="todo__badge shrink-0 text-[10.5px]">
                {active ? <Shimmer>{statusLabel}</Shimmer> : statusLabel}
              </ValuePill>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

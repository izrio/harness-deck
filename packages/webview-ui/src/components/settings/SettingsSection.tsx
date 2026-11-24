/**
 * 设置页分区：去线留白，用间距与柔和背景色块替代边框与分割线。
 * 标题在分区容器外，右侧可承载轻量操作按钮。
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

export function SettingsSection({
  title,
  actions,
  id,
  testId,
  surface = 'tonal',
  className,
  children,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly id?: string;
  readonly testId?: string;
  readonly surface?: 'tonal' | 'plain';
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3" id={id} data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-1">
        <h3 className="m-0 truncate text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {surface === 'plain' ? (
        <div className={cn('flex flex-col gap-3', className)}>{children}</div>
      ) : (
        <section
          className={cn(
            'flex flex-col overflow-hidden rounded-2xl bg-field/55 dark:bg-surface/65',
            className,
          )}
        >
          {children}
        </section>
      )}
    </div>
  );
}

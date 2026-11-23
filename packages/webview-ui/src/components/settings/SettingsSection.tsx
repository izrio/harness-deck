/**
 * 设置页分区：标题是卡片外的一行纯文字（可带图标与右侧操作），卡片只承载内容。
 * 统一各设置模块的留白、标题字号与卡片外观。
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

export function SettingsSection({
  title,
  actions,
  id,
  testId,
  className,
  children,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly id?: string;
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" id={id} data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
        <h3 className="m-0 truncate text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      <section className={cn('flex flex-col overflow-hidden rounded-xl border border-line/75 bg-surface/80 shadow-xs dark:bg-surface/75', className)}>
        {children}
      </section>
    </div>
  );
}

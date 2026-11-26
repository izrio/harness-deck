/**
 * 设置页分区（macOS 设置风格：无外框柔和浅底圆角卡片 + 卡片内极细横线分层与宽松行距）。
 * 标题在卡片外轻落，卡片内部行间用极细横线分隔，保持清晰层次与呼吸感。
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
    <div className="flex flex-col gap-2.5" id={id} data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-1">
        <h3 className="m-0 truncate text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {surface === 'plain' ? (
        <div className={cn('flex flex-col', className)}>{children}</div>
      ) : (
        <section
          className={cn(
            'overflow-hidden rounded-2xl bg-field/55 dark:bg-surface/65',
            className,
          )}
        >
          {children}
        </section>
      )}
    </div>
  );
}

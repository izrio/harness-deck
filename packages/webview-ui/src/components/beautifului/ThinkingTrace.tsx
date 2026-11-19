/**
 * Beautiful UI Thinking：可折叠的思考与操作轨迹入口。
 *
 * 折叠时是一行紧凑触发器：静态星芒图标 + 「执行中 · N 项操作 / 已执行 N 项操作」+ 展开箭头；
 * 展开后在左侧引导线里按原样排列各条工具活动行，不再额外铺一层卡片背景。
 * 加载动效与总耗时统一由底部 RunStatus 承担，避免同一画面出现多个 loading 与冲突计时。
 */
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';
import { ChevronDownIcon, SparkleIcon } from '../icons.tsx';
import { CollapsibleDrawer } from './CollapsibleDrawer.tsx';

export function ThinkingTrace({
  label,
  active = false,
  open,
  onToggle,
  children,
  className,
}: {
  readonly label: string;
  /** 运行中：高亮星芒与标题提示当前处于活动轨迹，不重复渲染加载动效或独立计时。 */
  readonly active?: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const bodyId = useId();

  return (
    <div
      className={cn('thinking flex min-w-0 flex-col', active && 'thinking--active', className)}
      data-testid="thinking-trace"
      data-active={active ? 'true' : undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        data-testid="thinking-toggle"
        onClick={onToggle}
        className={cn(
          'thinking__toggle flex w-fit max-w-full min-w-0 items-center gap-2 py-1 text-[13px] font-medium transition-colors duration-100 hover:text-ink',
          active ? 'text-ink' : 'text-ink-2',
        )}
      >
        <SparkleIcon
          width={15}
          height={15}
          fill="currentColor"
          stroke="none"
          className={cn('thinking__spark shrink-0', active ? 'text-accent-ink' : 'text-ink-3')}
        />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          width={13}
          height={13}
          strokeWidth={2}
          className="shrink-0 text-ink-3 transition-transform duration-300"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
        />
      </button>
      <CollapsibleDrawer open={open}>
        {open ? (
          <div
            id={bodyId}
            role="group"
            aria-label={label}
            className="thinking__body mt-1.5 ml-2 flex min-w-0 flex-col gap-0.5 border-l border-line pt-0.5 pb-1 pl-2.5"
          >
            {children}
          </div>
        ) : null}
      </CollapsibleDrawer>
    </div>
  );
}

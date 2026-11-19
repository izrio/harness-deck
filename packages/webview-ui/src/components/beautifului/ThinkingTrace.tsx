/**
 * Beautiful UI Thinking：可折叠的思考轨迹入口。
 *
 * 折叠时是一行紧凑触发器：像素网格加载指示器 + 「思考中 / 已执行 N 项操作」+ 已用时间；
 * 展开后在左侧引导线里按原样排列各条工具活动行，不再额外铺一层卡片背景。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';
import { ChevronDownIcon, SparkleIcon } from '../icons.tsx';
import { CollapsibleDrawer } from './CollapsibleDrawer.tsx';
import { LoaderGrid } from './LoaderGrid.tsx';
import { Shimmer } from './Shimmer.tsx';

export function ThinkingTrace({
  label,
  active = false,
  open,
  onToggle,
  formatDuration,
  children,
  className,
}: {
  readonly label: string;
  /** 运行中：像素网格加载态 + 流光标题，并开始计时。 */
  readonly active?: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** 把毫秒格式化成当前语言的时长文案；不传则不显示计时。 */
  readonly formatDuration?: (ms: number) => string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const bodyId = useId();
  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!active) {
      if (startedAtRef.current !== null) setElapsedMs(Date.now() - startedAtRef.current);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const startedAt = startedAtRef.current;
    setElapsedMs(Date.now() - startedAt);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  const duration = formatDuration && elapsedMs >= 1_000 ? formatDuration(elapsedMs) : undefined;

  return (
    <div className={cn('thinking flex min-w-0 flex-col', className)} data-testid="thinking-trace">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        data-testid="thinking-toggle"
        onClick={onToggle}
        className="thinking__toggle flex w-fit max-w-full min-w-0 items-center gap-2 py-1 text-[13px] font-medium text-ink-2 transition-colors duration-100 hover:text-ink"
      >
        {active ? (
          <LoaderGrid className="thinking__loader ml-0.5" />
        ) : (
          <SparkleIcon width={15} height={15} fill="currentColor" stroke="none" className="thinking__spark shrink-0 text-ink-3" />
        )}
        {active ? <Shimmer className="min-w-0 truncate">{label}</Shimmer> : <span className="min-w-0 truncate">{label}</span>}
        {duration ? <span className="shrink-0 text-ink-3 tabular-nums">{duration}</span> : null}
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

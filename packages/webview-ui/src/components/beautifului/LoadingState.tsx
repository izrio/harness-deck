/**
 * Beautiful UI Loading State — 3×3 像素网格加载器 + 流光文案 + 等宽计时器。
 *
 * Variants:
 * - Drive: 方块网格，人字形波前向右推进（650ms）
 * - Dots:  圆点网格，人字形波前向右推进（650ms）
 * - Orbit: 方块网格，亮点沿外圈 8 格顺时针公转（950ms），中心格保持微亮
 */
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/utils.ts';
import { LoaderGrid, type LoaderGridVariant } from './LoaderGrid.tsx';

export type LoadingStateVariant = LoaderGridVariant;

export interface LoadingStateProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  readonly label: string;
  readonly variant?: LoadingStateVariant;
  readonly elapsed?: string;
}

export function LoadingState({
  label,
  variant = 'Drive',
  elapsed,
  className,
  ...props
}: LoadingStateProps) {
  return (
    <div
      data-loading-state={variant}
      className={cn('flex w-fit max-w-full items-center gap-2.5', className)}
      {...props}
    >
      <LoaderGrid variant={variant} />
      <span
        className="min-w-0 truncate bg-clip-text text-[13px] leading-5 font-medium text-transparent"
        style={{
          backgroundImage: 'linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer-text 1.4s linear infinite',
        }}
      >
        {label}
      </span>
      {elapsed ? (
        <span className="shrink-0 text-[12px] leading-5 text-ink-3 tabular-nums">
          {elapsed}
        </span>
      ) : null}
    </div>
  );
}

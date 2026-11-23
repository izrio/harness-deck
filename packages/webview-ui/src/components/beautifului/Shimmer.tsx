import { useRef, type ReactNode } from 'react';
import { useOffscreenPause } from '../../hooks/useOffscreenPause.ts';
import { cn } from '../../lib/utils.ts';

/** Beautiful UI Shimmer：流光文字，提示智能体正在思考或处理。 */
export function Shimmer({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const offscreen = useOffscreenPause(ref);
  return (
    <span
      ref={ref}
      data-offscreen={offscreen ? 'true' : undefined}
      className={cn('inline-block bg-clip-text text-transparent', className)}
      style={{
        backgroundImage: 'linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer-text 1.6s linear infinite',
      }}
    >
      {children}
    </span>
  );
}

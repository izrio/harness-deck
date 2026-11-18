import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

export type PillTone = 'neutral' | 'green' | 'orange' | 'red' | 'accent';

const TONES: Record<PillTone, { cls: string; ring: string }> = {
  neutral: { cls: 'bg-field text-ink-2', ring: 'var(--shadow-hairline)' },
  green: { cls: 'bg-green-tint text-green', ring: '0 0 0 1px color-mix(in srgb, var(--green) 28%, transparent)' },
  orange: { cls: 'bg-orange-tint text-orange', ring: '0 0 0 1px color-mix(in srgb, var(--orange) 28%, transparent)' },
  red: { cls: 'bg-red-tint text-red', ring: '0 0 0 1px color-mix(in srgb, var(--red) 28%, transparent)' },
  accent: { cls: 'bg-accent-tint text-accent-ink', ring: '0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)' },
};

/** Beautiful UI ValuePill：语义状态胶囊标签。 */
export function ValuePill({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: PillTone;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-tight', t.cls, className)}
      style={{ boxShadow: t.ring }}
    >
      {children}
    </span>
  );
}

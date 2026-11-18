import { useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

type GlideMenuProps = {
  children: ReactNode;
  className?: string;
  highlightClassName?: string;
  rowSelector?: string;
};

/** Beautiful UI GlideMenu：单个悬停高亮层在菜单行之间平滑滑动。 */
export function GlideMenu({
  children,
  className = '',
  highlightClassName = 'inset-x-0 rounded-[8px] bg-hover',
  rowSelector = '[data-menu-row]',
}: GlideMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);

  const moveTo = (target: EventTarget | null) => {
    const container = ref.current;
    if (!(target instanceof Element) || !container) return;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !container.contains(row)) return;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    setBox({ top: rowRect.top - containerRect.top, height: rowRect.height });
    setVisible(true);
  };

  return (
    <div
      ref={ref}
      onMouseOver={(event) => moveTo(event.target)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={(event) => moveTo(event.target)}
      onBlurCapture={(event) => {
        if (!ref.current?.contains(event.relatedTarget as Node | null)) setVisible(false);
      }}
      className={cn('group/glide-menu relative', className)}
    >
      <span
        aria-hidden
        className={cn('pointer-events-none absolute', highlightClassName)}
        style={{
          top: box?.top ?? 0,
          height: box?.height ?? 0,
          opacity: box && visible ? 1 : 0,
          transition: 'top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease',
        }}
      />
      {children}
    </div>
  );
}

/** Beautiful UI GlideMenu 菜单项（配合 GlideMenu 滑动高亮）。 */
export function MenuItem({
  onSelect,
  children,
  active,
  hint,
  icon,
  truncateHint,
  className,
  'data-testid': testId,
}: {
  onSelect: () => void;
  children: ReactNode;
  active?: boolean;
  hint?: ReactNode;
  icon?: ReactNode;
  truncateHint?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-testid={testId}
      className={cn(
        'menu-item relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[13px] transition-colors duration-100',
        active ? 'menu-item--active bg-field font-medium text-ink group-hover/glide-menu:bg-transparent' : 'text-ink',
        className,
      )}
      onClick={onSelect}
    >
      {icon ? <span className={cn('inline-flex shrink-0', active ? 'text-accent-ink' : 'text-ink-3')}>{icon}</span> : null}
      <span className={cn('menu-item__label', truncateHint && hint ? 'shrink-0 font-medium' : 'min-w-0 flex-1 truncate')}>{children}</span>
      {hint ? (
        <span
          className={cn(
            'menu-item__hint text-[11.5px] tabular-nums',
            truncateHint ? 'min-w-0 flex-1 truncate text-right' : 'shrink-0',
            active ? 'text-accent-ink' : 'text-ink-3',
          )}
        >
          {hint}
        </span>
      ) : null}
    </button>
  );
}

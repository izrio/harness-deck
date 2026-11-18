/**
 * Beautiful UI 浮层菜单：SearchList / GlideMenu 容器样式（surface + shadow-raised + pop-in）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/utils.ts';

const FOCUSABLE = 'input:not([disabled]), button:not([disabled])';

export function Popover({
  open,
  onClose,
  className,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const container = ref.current;
      if (!container) return;
      const target = event.target as Node | null;
      // 忽略触发按钮所在同级相对定位容器上的点击，交由按钮自己的 onClick 切换开关
      if (target && (container.contains(target) || container.parentElement?.contains(target))) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        onClose();
        return;
      }
      const container = ref.current;
      if (!container || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && (event.key === 'Home' || event.key === 'End')) return;
      const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next =
        event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
      event.preventDefault();
      items[next]?.focus();
    };
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      const current = document.activeElement;
      if (opener?.isConnected && (!current || current === document.body || ref.current?.contains(current))) opener.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{ animation: 'pop-in 180ms var(--ease-out-strong) both' }}
      className={cn(
        'popover absolute top-[calc(100%+6px)] z-20 min-w-[216px] max-w-[min(360px,calc(100vw-16px))] overflow-hidden rounded-card bg-surface p-1 text-ink shadow-raised',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Beautiful UI 菜单项（配合 GlideMenu 滑动高亮）。 */
export function MenuItem({
  onSelect,
  children,
  active,
  hint,
  icon,
}: {
  onSelect: () => void;
  children: ReactNode;
  active?: boolean;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      className={cn(
        'menu-item relative z-10 flex h-8 w-full items-center gap-2 rounded-chip px-2 text-left text-[13px] transition-colors duration-100',
        active ? 'menu-item--active bg-field font-medium text-ink group-hover/glide-menu:bg-transparent' : 'text-ink',
      )}
      onClick={onSelect}
    >
      {icon ? <span className={cn('inline-flex shrink-0', active ? 'text-accent-ink' : 'text-ink-3')}>{icon}</span> : null}
      <span className="menu-item__label min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className={cn('menu-item__hint shrink-0 text-[11.5px] tabular-nums', active ? 'text-accent-ink' : 'text-ink-3')}>{hint}</span> : null}
    </button>
  );
}

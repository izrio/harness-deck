import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';
import { ChevronDownIcon } from '../icons.tsx';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-control border border-line bg-field px-2.5 text-[12.5px] text-ink outline-none transition-colors duration-100 placeholder:text-ink-3 focus:border-accent disabled:cursor-default disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-control border border-line bg-field px-2.5 py-2 text-[12.5px] text-ink outline-none transition-colors duration-100 placeholder:text-ink-3 focus:border-accent disabled:cursor-default disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, wrapperClassName, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { readonly wrapperClassName?: string }) {
  return (
    <div className={cn('relative inline-flex items-center', wrapperClassName)}>
      <select
        className={cn(
          'h-8 w-full appearance-none rounded-control border border-line bg-field pr-7 pl-2.5 text-[12.5px] text-ink outline-none transition-colors duration-100 focus:border-accent disabled:cursor-default disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 size-3.5 text-ink-3" />
    </div>
  );
}

export function Stepper({
  valueLabel,
  valueTestId,
  canDecrease,
  canIncrease,
  decreaseLabel,
  increaseLabel,
  onDecrease,
  onIncrease,
}: {
  readonly valueLabel: string;
  readonly valueTestId?: string;
  readonly canDecrease: boolean;
  readonly canIncrease: boolean;
  readonly decreaseLabel: string;
  readonly increaseLabel: string;
  readonly onDecrease: () => void;
  readonly onIncrease: () => void;
}) {
  return (
    <div className="inline-flex h-7.5 items-center overflow-hidden rounded-control bg-field shadow-hairline">
      <button
        type="button"
        className="flex h-full w-7 items-center justify-center text-[14px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-35"
        aria-label={decreaseLabel}
        disabled={!canDecrease}
        onClick={onDecrease}
      >
        −
      </button>
      <span
        className="min-w-13 border-x border-line px-2 text-center font-mono text-[12px] font-medium text-ink tabular-nums"
        {...(valueTestId ? { 'data-testid': valueTestId } : {})}
      >
        {valueLabel}
      </span>
      <button
        type="button"
        className="flex h-full w-7 items-center justify-center text-[14px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-35"
        aria-label={increaseLabel}
        disabled={!canIncrease}
        onClick={onIncrease}
      >
        +
      </button>
    </div>
  );
}

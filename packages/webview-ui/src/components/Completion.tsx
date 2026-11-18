/** 输入框上方的补全列表（Beautiful UI PromptBar @ / / 浮层风格）。 */
import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils.ts';
import { ValuePill } from './beautifului/index.ts';
import { FileIcon, FolderIcon, SpinnerIcon } from './icons.tsx';

export interface CompletionItem {
  readonly key: string;
  readonly icon: 'file' | 'directory' | 'command';
  readonly label: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly tag?: string;
}

export function Completion({
  items,
  selected,
  onSelect,
  onHover,
  empty,
  loading,
  label,
}: {
  items: readonly CompletionItem[];
  selected: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
  empty?: string;
  loading?: string;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <div
      className="completion absolute right-2.5 bottom-[calc(100%+4px)] left-2.5 z-15 max-h-64 overflow-y-auto rounded-[10px] bg-surface p-1 text-ink shadow-raised"
      ref={list}
      role="listbox"
      aria-label={label}
      id="composer-completion"
      data-testid="completion"
      style={{ animation: 'pop-in 170ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom center' }}
    >
      {loading ? (
        <div className="completion__empty completion__loading flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-3">
          <SpinnerIcon className="size-3.5" />
          {loading}
        </div>
      ) : null}
      {items.length === 0 && empty && !loading ? <div className="completion__empty px-2 py-1.5 text-[12px] text-ink-3">{empty}</div> : null}
      {items.map((item, index) => (
        <div
          key={item.key}
          id={`completion-${index}`}
          role="option"
          aria-selected={index === selected}
          className={cn(
            'completion__item flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-[12.5px] transition-colors duration-100',
            index === selected ? 'completion__item--selected bg-hover text-ink' : 'text-ink-2 hover:bg-hover/60 hover:text-ink',
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(index);
          }}
          onMouseMove={() => onHover(index)}
        >
          {item.icon !== 'command' ? (
            <span className={cn('completion__icon inline-flex shrink-0', index === selected ? 'text-ink' : 'text-ink-3')}>
              {item.icon === 'directory' ? <FolderIcon className="size-3.5" /> : <FileIcon className="size-3.5" />}
            </span>
          ) : null}
          <span className="completion__label max-w-[60%] shrink-0 truncate font-medium">{item.label}</span>
          {item.tag ? <ValuePill tone="neutral" className="completion__tag text-[10.5px]">{item.tag}</ValuePill> : null}
          {item.hint ? <span className="completion__hint shrink-0 font-mono text-[11px] text-ink-3">{item.hint}</span> : null}
          {item.detail ? <span className="completion__detail min-w-0 truncate text-[12px] text-ink-3">{item.detail}</span> : null}
        </div>
      ))}
    </div>
  );
}

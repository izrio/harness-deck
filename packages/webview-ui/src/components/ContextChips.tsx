/**
 * 输入框里的上下文标签（Beautiful UI Chip 胶囊）。
 */
import type { AttachmentView } from '@harness-deck/shared';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { CloseIcon, FileIcon, SelectionIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

export function attachmentLabel(a: AttachmentView): string {
  const name = a.path.split(/[\\/]/u).pop() ?? a.path;
  if (a.kind === 'file' || a.startLine === undefined) return name;
  return a.endLine && a.endLine !== a.startLine ? `${name}:${a.startLine}-${a.endLine}` : `${name}:${a.startLine}`;
}

export function openAttachment(a: AttachmentView): void {
  postToHost({ type: 'openFile', payload: { path: a.path, ...(a.startLine ? { startLine: a.startLine } : {}), ...(a.endLine ? { endLine: a.endLine } : {}) } });
}

export function ContextChips({
  active,
  included,
  onToggle,
  pinned,
}: {
  active?: AttachmentView;
  included: boolean;
  onToggle: () => void;
  pinned: readonly (AttachmentView & { readonly id: string })[];
}) {
  const t = useT();
  if (!active && pinned.length === 0) return null;
  return (
    <div className="context-chips flex flex-wrap gap-1.5 px-2 pt-1.5" data-testid="context-chips">
      {pinned.map((a) => (
        <span
          key={a.id}
          className="chip inline-flex h-6.5 max-w-full min-w-0 items-center gap-1.5 rounded-chip bg-field py-0.5 pr-1 pl-2 text-[11.5px] leading-4 text-ink-2 shadow-hairline"
          title={t('chip.pinnedTitle', a.startLine ? t('chip.lines', a.path, a.startLine, a.endLine ?? a.startLine) : a.path)}
        >
          {a.kind === 'selection' ? <SelectionIcon className="size-3 shrink-0 text-ink-3" /> : <FileIcon className="size-3 shrink-0 text-ink-3" />}
          <span className="chip__label min-w-0 truncate font-mono leading-4">{attachmentLabel(a)}</span>
          <button
            type="button"
            className="chip__remove inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"
            aria-label={t('chip.remove', attachmentLabel(a))}
            onClick={() => postToHost({ type: 'removeAttachment', payload: { id: a.id } })}
          >
            <CloseIcon className="size-3" />
          </button>
        </span>
      ))}
      {active ? (
        <button
          type="button"
          className={cn(
            'chip chip--active inline-flex h-6.5 max-w-full min-w-0 items-center gap-1.5 rounded-chip px-2 text-[11.5px] leading-4 transition-colors duration-100',
            included
              ? 'bg-field text-ink-2 shadow-hairline hover:bg-hover hover:text-ink'
              : 'chip--excluded border border-dashed border-line-strong bg-transparent text-ink-3 hover:bg-hover',
          )}
          aria-pressed={included}
          onClick={onToggle}
          title={
            active.kind === 'selection'
              ? t(included ? 'chip.includedSelection' : 'chip.excludedSelection')
              : t(included ? 'chip.includedFile' : 'chip.excludedFile')
          }
          data-testid="active-context"
        >
          {active.kind === 'selection' ? <SelectionIcon className="size-3 shrink-0 text-ink-3" /> : <FileIcon className="size-3 shrink-0 text-ink-3" />}
          <span className={cn('chip__label min-w-0 truncate font-mono leading-4', !included && 'line-through')}>{attachmentLabel(active)}</span>
          <span className="chip__hint shrink-0 leading-4 text-ink-3">{active.kind === 'selection' ? t('chip.selection') : t('chip.file')}</span>
        </button>
      ) : null}
    </div>
  );
}

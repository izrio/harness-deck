import type { ChangedFileView, DiffRef, LineStats } from '@harness-deck/shared';
import { diffKey, openDiff as trackDiff, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { cn } from '../../lib/utils.ts';
import { GlideMenu, ValuePill } from '../beautifului/index.ts';
import { DiffIcon, FileIcon, SpinnerIcon } from '../icons.tsx';
import { useT } from '../../i18n.ts';
import type { Of } from './types.ts';

export const openDiff = (ref: DiffRef) => trackDiff(ref, (token) => postToHost({ type: 'openDiff', payload: { ref, token } }));

export function useDiffOpening(ref: DiffRef | undefined): boolean {
  return useView((s) => ref !== undefined && s.openingDiff?.key === diffKey(ref));
}

export function FilePath({ path, className }: { path: string; className: string }) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slash < 0) return <span className={className}>{path}</span>;
  return (
    <span className={`${className} file-path inline-flex items-baseline gap-1.5 overflow-hidden`}>
      <span className="file-path__name min-w-[3em] flex-[0_1_auto] truncate">{path.slice(slash + 1)}</span>
      <span className="file-path__dir min-w-0 flex-[1_100_0] truncate text-[0.92em] text-ink-3">{path.slice(0, slash)}</span>
    </span>
  );
}

export function Stats({ stats }: { stats: Partial<LineStats> }) {
  const { additions, deletions } = stats;
  if (additions === undefined && deletions === undefined) return null;
  const both = !additions && !deletions;
  return (
    <span className="stats inline-flex shrink-0 items-center gap-1 font-mono text-[11.5px] leading-4 tabular-nums">
      {additions !== undefined && (additions > 0 || both) ? <span className="stats__add text-green">+{additions}</span> : null}
      {deletions !== undefined && deletions > 0 ? <span className="stats__del text-red">−{deletions}</span> : null}
    </span>
  );
}

/** 改动汇总卡片（对齐 Beautiful UI DiffTable 卡片规范：`primitive-card-bar` + `GlideMenu`）。 */
export function ChangesCard({ item }: { item: Of<'changes'> }) {
  const t = useT();
  const total = item.files.reduce(
    (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  return (
    <section className="changes overflow-hidden rounded-xl border border-line/80 bg-surface shadow-xs" aria-label={t('changes.label')}>
      <header className="changes__header primitive-card-bar flex items-center gap-2 border-b border-line/70 text-[12.5px] leading-4 font-medium text-ink">
        <DiffIcon className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">{t('changes.title', item.total)}</span>
        <Stats stats={total} />
      </header>
      <GlideMenu className="p-1.5" highlightClassName="inset-x-1.5 rounded-[6px] bg-hover">
        <ul className="changes__list m-0 flex list-none flex-col gap-0.5 p-0">
          {item.files.map((file) => (
            <li key={`${file.path}:${JSON.stringify(file.ref)}`}>
              <ChangedFileButton
                file={file}
                className="changes__file relative z-10 flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] leading-4 transition-colors duration-100"
              />
            </li>
          ))}
        </ul>
      </GlideMenu>
      {item.source === 'tools' ? <p className="changes__note m-0 border-t border-line px-3 py-1.5 text-[11.5px] text-ink-3">{t('changes.toolsOnly')}</p> : null}
      {item.total > item.files.length ? <p className="changes__note m-0 border-t border-line px-3 py-1.5 text-[11.5px] text-ink-3">{t('changes.more', item.total - item.files.length)}</p> : null}
    </section>
  );
}

export function ChangedFileButton({ file, className }: { file: ChangedFileView; className: string }) {
  const t = useT();
  const opening = useDiffOpening(file.ref);
  const slash = file.path.lastIndexOf('/');
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const dir = slash >= 0 ? file.path.slice(0, slash) : '';
  return (
    <button
      type="button"
      data-menu-row
      className={cn('group/file', className)}
      onClick={() => openDiff(file.ref)}
      title={t('edit.view', file.path)}
      aria-busy={opening}
    >
      <span className="changes__icon inline-flex shrink-0 text-ink-3">{opening ? <SpinnerIcon className="size-3.5 text-brand" /> : <FileIcon className="size-3.5" />}</span>
      <span className="changes__path min-w-0 flex-1 truncate text-left">
        <span className="changes__name font-medium text-ink group-hover/file:text-accent-ink group-hover/file:underline">{name}</span>
        {dir ? <span className="changes__dir ml-1.5 font-mono text-[11px] text-ink-3">{dir}</span> : null}
      </span>
      {file.created ? <ValuePill tone="green" className="changes__flag text-[10.5px]">{t('changes.created')}</ValuePill> : null}
      {file.flags?.includes('binary') ? <ValuePill className="changes__flag text-[10.5px]">{t('changes.binary')}</ValuePill> : null}
      {file.flags?.includes('oversized') ? <ValuePill tone="orange" className="changes__flag text-[10.5px]">{t('changes.oversized')}</ValuePill> : null}
      <Stats stats={file} />
    </button>
  );
}

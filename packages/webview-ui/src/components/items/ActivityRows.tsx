import { useState, type ReactNode } from 'react';
import { splitLabel } from '@harness-deck/shared/labels';
import { requestMarkdownPreview } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { cn } from '../../lib/utils.ts';
import { CollapsibleDrawer } from '../beautifului/index.ts';
import { isMarkdownPath } from '../MarkdownPreviewModal.tsx';
import { ChevronDownIcon, ErrorIcon, EyeIcon, FileEditIcon, GlobeIcon, PlanIcon, QuestionIcon, SearchIcon, SlashIcon, TerminalIcon, ToolIcon } from '../icons.tsx';
import { useT } from '../../i18n.ts';
import type { Of } from './types.ts';
import { FilePath, Stats, openDiff, useDiffOpening } from './ChangesCard.tsx';

export function StatusIcon({ status, icon, expandable }: { status: 'running' | 'ok' | 'error'; icon: ReactNode; expandable?: boolean }) {
  return (
    <span
      className={cn(
        'activity__icon relative inline-flex size-4 shrink-0 items-center justify-center',
        status === 'error' ? 'text-red' : status === 'running' ? 'text-accent-ink' : 'text-ink-3',
        expandable && 'transition-opacity duration-100 group-hover/row:opacity-0',
      )}
    >
      {status === 'error' ? <ErrorIcon className="size-3.5" /> : icon}
    </span>
  );
}

/** 对齐 Beautiful UI ToolChips：悬停图标变箭头、内联 bg-field 芯片、border-l 输出抽屉。 */
export function ActivityRow({ item }: { item: Of<'activity'> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { name, detail } = splitLabel(item.label);
  const expandable = Boolean(item.output);
  const command = item.variant === 'command';
  const commandVerb = item.status === 'running' ? t('command.running') : item.status === 'error' ? t('command.failed') : t('command.done');
  const chipText = command ? detail || name : detail;
  return (
    <div className={cn('activity -my-1.5 text-[12.5px]', `activity--${item.status}`, command && 'activity--command')}>
      <button
        type="button"
        className="activity__row group/row flex h-7 w-full min-w-0 items-center gap-2 text-left transition-colors duration-100 disabled:cursor-default"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        title={item.label}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <StatusIcon status={item.status} icon={command ? <TerminalIcon className="size-3.5" /> : <GenericToolIcon tool={item.tool} />} expandable={expandable} />
          {expandable ? (
            <ChevronDownIcon
 width={12}
 height={12}
 strokeWidth={2}
 className={cn(
                'chevron absolute text-ink-3 transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
                open ? 'chevron--open opacity-100' : 'opacity-0',
              )}
 style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
 />
          ) : null}
        </span>
        <span
          className={cn(
            'activity__name shrink-0 font-medium',
            item.status === 'error' ? 'text-red' : item.status === 'running' ? 'text-accent-ink' : 'text-ink',
          )}
        >
          {command ? commandVerb : name}
        </span>
        {chipText ? (
          <span className="activity__detail inline-flex h-5.5 min-w-0 items-center truncate rounded-chip bg-surface px-1.5 font-mono text-[11.5px] text-ink-2 shadow-hairline">
            {chipText}
          </span>
        ) : null}
      </button>
      <CollapsibleDrawer open={Boolean(open && item.output)}>
          {open && item.output ? (
            <pre className="activity__output terminal-surface m-0 mt-0.5 mb-1.5 ml-2 max-h-60 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere]">
              {item.output}
            </pre>
          ) : null}
      </CollapsibleDrawer>
    </div>
  );
}

export function GenericToolIcon({ tool }: { tool: string }) {
  if (tool === 'slash') return <SlashIcon className="size-3.5" />;
  if (tool === 'ask_user_question') return <QuestionIcon className="size-3.5" />;
  if (tool === 'exit_plan_mode') return <PlanIcon className="size-3.5" />;
  if (tool.startsWith('web_')) return <GlobeIcon className="size-3.5" />;
  return <ToolIcon className="size-3.5" />;
}

/** 文件编辑行（Beautiful UI ToolChips 风格）。 */
export function EditRow({ item }: { item: Of<'activity'> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const verb = item.status === 'running' ? t('edit.running') : item.status === 'error' ? t('edit.failed') : item.created ? t('edit.created') : t('edit.done');
  const diff = item.diff;
  const expandable = !diff && Boolean(item.output);
  const opening = useDiffOpening(diff);
  const onClick = () => (diff ? openDiff(diff) : item.output ? setOpen(!open) : undefined);
  return (
    <div className={cn('activity activity--edit -my-1.5 text-[12.5px]', `activity--${item.status}`)}>
      <button
        type="button"
        className="activity__row group/row flex h-7 w-full min-w-0 items-center gap-2 text-left transition-colors duration-100 disabled:cursor-default"
        disabled={!diff && !item.output}
        aria-expanded={expandable ? open : undefined}
        onClick={onClick}
        title={diff ? t('edit.view', item.label) : item.label}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <StatusIcon status={opening ? 'running' : item.status} icon={<FileEditIcon className="size-3.5" />} expandable={expandable} />
          {expandable ? (
            <ChevronDownIcon
 width={12}
 height={12}
 strokeWidth={2}
 className={cn(
                'chevron absolute text-ink-3 transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
                open ? 'chevron--open opacity-100' : 'opacity-0',
              )}
 style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
 />
          ) : null}
        </span>
        <span
          className={cn(
            'activity__name shrink-0 font-medium',
            item.status === 'error' ? 'text-red' : item.status === 'running' ? 'text-accent-ink' : 'text-ink',
          )}
        >
          {verb}
        </span>
        <FilePath
          path={item.label}
          className={cn(
            'activity__detail activity__file inline-flex h-5.5 min-w-0 items-center rounded-chip bg-surface px-1.5 font-mono text-[11.5px] shadow-hairline',
            diff ? 'activity__file--link text-accent-ink group-hover/row:underline' : 'text-ink-2',
          )}
        />
        {item.stats ? <Stats stats={item.stats} /> : null}
      </button>
      <CollapsibleDrawer open={Boolean(open && item.output)}>
          {open && item.output ? (
            <pre className="activity__output terminal-surface m-0 mt-0.5 mb-1.5 ml-2 max-h-60 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere]">
              {item.output}
            </pre>
          ) : null}
      </CollapsibleDrawer>
    </div>
  );
}

export function ExploreRow({ item }: { item: Of<'explore'> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('activity -my-1.5 text-[12.5px]', `activity--${item.status}`)}>
      <button
        type="button"
        className="activity__row group/row flex h-7 w-full min-w-0 items-center gap-2 text-left transition-colors duration-100"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <StatusIcon status={item.status} icon={<SearchIcon className="size-3.5" />} expandable />
          <ChevronDownIcon
 width={12}
 height={12}
 strokeWidth={2}
 className={cn(
              'chevron absolute text-ink-3 transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
              open ? 'chevron--open opacity-100' : 'opacity-0',
            )}
 style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
 />
        </span>
        <span
          className={cn(
            'activity__name shrink-0 font-medium',
            item.status === 'error' ? 'text-red' : item.status === 'running' ? 'text-accent-ink' : 'text-ink',
          )}
        >
          {item.status === 'running' ? t('explore.running') : t('explore.done')}
        </span>
        <span className="activity__detail activity__detail--plain min-w-0 truncate text-ink-2">{item.summary}</span>
      </button>
      <CollapsibleDrawer open={open}>
          {open ? (
            <ul className="mt-0.5 mb-1.5 ml-2 flex list-none flex-col gap-0.5 border-l border-line py-0.5 pl-3.5 text-[12px] text-ink-2">
              {item.entries.map((entry) => {
                const { name, detail } = splitLabel(entry.label);
                const path = entry.path;
                return (
                  <li key={entry.id} className={cn('explore__entry flex min-w-0 items-center gap-1.5 leading-[1.6]', `explore__entry--${entry.status}`)}>
                    <span className={cn('shrink-0 font-medium', entry.status === 'error' ? 'text-red' : 'text-ink')}>{name}</span>
                    {path ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <button
                          type="button"
                          className="min-w-0 truncate font-mono text-[11.5px] text-accent-ink hover:underline"
                          title={t('file.open', path)}
                          onClick={() => postToHost({ type: 'openFile', payload: { path } })}
                        >
                          {detail}
                        </button>
                        {isMarkdownPath(path) ? (
                          <button
                            type="button"
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-accent-ink"
                            title={t('markdown.preview', path)}
                            aria-label={t('markdown.preview', path)}
                            onClick={() => requestMarkdownPreview(path)}
                          >
                            <EyeIcon className="size-3" />
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">{detail}</span>
                    )}
                    {entry.status === 'error' ? <ErrorIcon className="size-3.5 shrink-0 text-red" /> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
      </CollapsibleDrawer>
    </div>
  );
}

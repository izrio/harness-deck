/**
 * 对话流条目（严格对齐 Beautiful UI：ChatComposer 气泡、ThinkingState 推理流、ToolChips 工具行、DiffTable 改动卡片）。
 */
import { memo, useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChangedFileView, DiffRef, Item, LineStats } from '@harness-deck/shared';
import { splitLabel } from '@harness-deck/shared/labels';
import { splitMentions } from '../mentions.ts';
import { diffKey, openDiff as trackDiff, requestMarkdownPreview, requestPrefill, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { GlideMenu, Shimmer, ValuePill } from './beautifului/index.ts';
import { attachmentLabel, openAttachment } from './ContextChips.tsx';
import { isMarkdownPath } from './MarkdownPreviewModal.tsx';
import { Markdown } from './Markdown.tsx';
import { TurnDone } from './RunStatus.tsx';
import { ImageThumb } from './Images.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DiffIcon,
  ErrorIcon,
  EyeIcon,
  FastForwardIcon,
  FileEditIcon,
  FileIcon,
  GlobeIcon,
  InfoIcon,
  KeyIcon,
  PencilIcon,
  PlanIcon,
  QuestionIcon,
  RefreshIcon,
  SearchIcon,
  SelectionIcon,
  SendIcon,
  SlashIcon,
  SpinnerIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
} from './icons.tsx';
import { useT } from '../i18n.ts';

type Of<K extends Item['kind']> = Extract<Item, { kind: K }>;

export const ItemView = memo(function ItemView({
  item,
  hideAssistantActions = false,
  turnDoneCopyText,
}: {
  item: Item;
  hideAssistantActions?: boolean;
  turnDoneCopyText?: string;
}) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return <AssistantMessage item={item} hideActions={hideAssistantActions} />;
    case 'activity':
      if (item.variant === 'subagent' && item.subagent) return <SubagentRow item={item} />;
      return item.variant === 'edit' ? <EditRow item={item} /> : <ActivityRow item={item} />;
    case 'explore':
      return <ExploreRow item={item} />;
    case 'changes':
      return <ChangesCard item={item} />;
    case 'notice':
      return <Notice item={item} />;
    case 'turnDone':
      return <TurnDone item={item} {...(turnDoneCopyText !== undefined ? { actions: <AssistantActions text={turnDoneCopyText} inline /> } : {})} />;
  }
});

function UserBubble({ item }: { item: Of<'user'> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  if (editing && item.queue) return <QueueEditor item={item} onDone={() => setEditing(false)} />;
  return (
    <div className={cn('user group/user flex flex-col items-end pl-[14%]', item.pending && `user--${item.pending}`)}>
      {item.text ? (
        <div
          className={cn(
            'user__bubble max-w-full rounded-window bg-surface px-3.5 py-2 font-[family-name:var(--prose-font-family)] text-[length:var(--prose-font-size)] leading-[1.52] text-ink shadow-card whitespace-pre-wrap [overflow-wrap:anywhere]',
            (item.pending === 'sending' || item.pending === 'queued') && 'opacity-75',
            item.pending === 'failed' && 'shadow-[0_0_0_1px_var(--red)]',
          )}
        >
          <UserText text={item.text} />
        </div>
      ) : null}
      {item.images?.length ? (
        <div className="user__images mt-1.5 flex max-w-full flex-wrap justify-end gap-1.5">
          {item.images.map((image, index) => (
            <ImageThumb key={image.attachmentId ?? image.localId ?? index} image={image} />
          ))}
        </div>
      ) : null}
      {item.attachments?.length ? (
        <div className="user__attachments mt-1.5 flex max-w-full flex-wrap justify-end gap-1">
          {item.attachments.map((a) => (
            <button
              key={attachmentLabel(a) + a.path}
              type="button"
              className="chip chip--small inline-flex h-6 items-center gap-1 rounded-chip bg-surface px-2 text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover hover:text-ink"
              onClick={() => openAttachment(a)}
              title={t('common.open', a.path)}
            >
              {a.kind === 'selection' ? <SelectionIcon className="size-3 text-ink-3" /> : <FileIcon className="size-3 text-ink-3" />}
              <span className="chip__label font-mono">{attachmentLabel(a)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {item.pending === 'sending' ? (
        <div className="user__meta mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-3">
          <SpinnerIcon className="size-3" />
          <span>{t('user.sending')}</span>
        </div>
      ) : null}
      {item.pending === 'queued' ? <QueuedMeta item={item} onEdit={() => setEditing(true)} /> : null}
      {!item.pending && item.text ? <UserActions text={item.text} /> : null}
      {item.pending === 'failed' ? (
        <div className="user__meta user__meta--error mt-1 flex flex-wrap items-center justify-end gap-2 text-[12px] text-red">
          <span>{item.error ? t('user.failedWith', item.error) : t('user.failed')}</span>
          <button
            type="button"
            className="link-button inline-flex items-center gap-1 font-medium text-accent-ink hover:underline"
            onClick={() => item.requestId && postToHost({ type: 'retryPending', payload: { requestId: item.requestId } })}
          >
            <RefreshIcon className="size-3" />
            {t('user.retry')}
          </button>
          <button
            type="button"
            className="link-button inline-flex items-center gap-1 font-medium text-red hover:underline"
            onClick={() => item.requestId && postToHost({ type: 'discardPending', payload: { requestId: item.requestId } })}
          >
            <TrashIcon className="size-3" />
            {t('common.delete')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IconAction({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="msg-action flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function UserActions({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <div className="mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
      <IconAction
        label={copied ? t('user.copied') : t('user.copy')}
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
              clearTimeout(timerRef.current);
              timerRef.current = setTimeout(() => setCopied(false), 1_200);
            })
            .catch(() => undefined)
        }
      >
        {copied ? <CheckIcon className="size-3.5 text-green" /> : <CopyIcon className="size-3.5" />}
      </IconAction>
      <IconAction label={t('user.editResend')} title={t('user.editResendTitle')} onClick={() => requestPrefill(text)}>
        <PencilIcon className="size-3.5" />
      </IconAction>
    </div>
  );
}

function QueuedMeta({ item, onEdit }: { item: Of<'user'>; onEdit: () => void }) {
  const t = useT();
  const running = useView((s) => s.session.running);
  const queue = item.queue;
  if (!queue) return <div className="user__meta mt-1 text-[11.5px] text-ink-3">{t('queue.waiting')}</div>;
  const act = (action: 'remove' | 'steer' | 'send') => postToHost({ type: 'queueAction', payload: { action, itemId: queue.itemId } });
  if (!running) {
    return (
      <div className="user__meta user__meta--queued mt-1 flex flex-wrap items-center justify-end gap-1.5 text-[11.5px] text-ink-2" data-testid="queued-meta">
        <span className="user__status">{t('queue.stopped')}</span>
        <span className="user__tools inline-flex flex-none gap-0.5">
          <IconAction label={t('queue.sendNow')} onClick={() => act('send')}>
            <SendIcon className="size-3.5" />
          </IconAction>
          <IconAction label={t('common.edit')} onClick={onEdit}>
            <PencilIcon className="size-3.5" />
          </IconAction>
          <IconAction label={t('common.delete')} onClick={() => act('remove')}>
            <TrashIcon className="size-3.5" />
          </IconAction>
        </span>
      </div>
    );
  }
  return (
    <div className="user__meta user__meta--queued mt-1 flex flex-wrap items-center justify-end gap-1.5 text-[11.5px] text-ink-2" data-testid="queued-meta">
      <span className="user__status">{queue.target === 'next-step' ? t('queue.steered') : t('queue.waiting')}</span>
      <span className="user__tools inline-flex flex-none gap-0.5">
        <IconAction label={t('common.edit')} onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </IconAction>
        {queue.target === 'next-turn' ? (
          <IconAction label={t('queue.steer')} title={t('queue.steerTitle')} onClick={() => act('steer')}>
            <FastForwardIcon className="size-3.5" />
          </IconAction>
        ) : null}
        <IconAction label={t('common.delete')} onClick={() => act('remove')}>
          <TrashIcon className="size-3.5" />
        </IconAction>
      </span>
    </div>
  );
}

function QueueEditor({ item, onDone }: { item: Of<'user'>; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(item.text);
  const save = () => {
    if (item.queue && text.trim() && text.trim() !== item.text) {
      postToHost({ type: 'queueAction', payload: { action: 'edit', itemId: item.queue.itemId, text: text.trim() } });
    }
    onDone();
  };
  return (
    <div className="user user--queued flex flex-col items-end pl-[14%]">
      <textarea
        className="queue-editor w-full resize-y rounded-[12px] border border-line-strong bg-surface px-3 py-2 text-[13.5px] text-ink shadow-card outline-none focus:border-accent"
        value={text}
        autoFocus
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        aria-label={t('queue.editLabel')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            onDone();
          }
        }}
      />
      <div className="user__meta mt-1.5 flex items-center gap-1.5">
        <Button type="button" size="xs" onClick={save}>
          <CheckIcon className="size-3" />
          {t('common.save')}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>
          <CloseIcon className="size-3" />
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function UserText({ text }: { text: string }) {
  const t = useT();
  return (
    <>
      {splitMentions(text).map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <span key={index} className="mx-0.5 inline-flex items-center gap-0.5 align-baseline">
            <button
              type="button"
              className="mention inline-flex items-center rounded-[5px] bg-inset px-1.5 py-px font-mono text-[0.9em] text-accent-ink shadow-hairline hover:bg-hover"
              onClick={() => postToHost({ type: 'openFile', payload: { path: part.path } })}
              title={t('common.open', part.path)}
            >
              {part.text}
            </button>
            {isMarkdownPath(part.path) ? (
              <button
                type="button"
                className="inline-flex size-4.5 items-center justify-center rounded-[4px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-accent-ink"
                title={t('markdown.preview', part.path)}
                aria-label={t('markdown.preview', part.path)}
                onClick={() => requestMarkdownPreview(part.path)}
              >
                <EyeIcon className="size-3" />
              </button>
            ) : null}
          </span>
        ),
      )}
    </>
  );
}

function AssistantMessage({ item, hideActions }: { item: Of<'assistant'>; hideActions?: boolean }) {
  const markdown = useDeferredValue(item.markdown);
  return (
    <div className={cn('assistant group/assistant relative min-w-0', item.streaming && item.markdown && 'assistant--streaming')}>
      {item.reasoning ? <Reasoning text={item.reasoning} active={item.streaming && !item.markdown} /> : null}
      {markdown ? <Markdown text={markdown} /> : null}
      {item.streaming && item.markdown ? <span className="cursor" aria-hidden /> : null}
      {!item.streaming && item.markdown && !hideActions ? <AssistantActions text={item.markdown} /> : null}
    </div>
  );
}

/** 对齐 Beautiful UI StreamingText 底部操作图标行。 */
function AssistantActions({ text, inline = false }: { text: string; inline?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <div className={cn('flex items-center gap-0.5', !inline && 'mt-1.5')}>
      <IconAction
        label={copied ? t('assistant.copied') : t('assistant.copy')}
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
              clearTimeout(timerRef.current);
              timerRef.current = setTimeout(() => setCopied(false), 1_200);
            })
            .catch(() => undefined)
        }
      >
        {copied ? <CheckIcon className="size-3.5 text-green" /> : <CopyIcon className="size-3.5" />}
      </IconAction>
    </div>
  );
}

/** 对齐 Beautiful UI ThinkingState：星芒、流光标题、旋转箭头、垂直引导线 + CSS grid 平滑展开。 */
function Reasoning({ text, active }: { text: string; active: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning mb-1.5">
      <button
        type="button"
        className="reasoning__toggle flex w-fit items-center gap-2 py-1 text-[13px] font-medium text-ink-2 transition-colors duration-100 hover:text-ink"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill={active ? 'var(--ink-2)' : 'var(--ink-3)'} className="shrink-0" aria-hidden>
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        {active ? <Shimmer>{t('reasoning.active')}</Shimmer> : <span>{t('reasoning.done')}</span>}
        <svg
          aria-hidden
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="overflow-hidden">
          {open ? (
            <div className="reasoning__body mt-1 ml-[5px] border-l border-line py-1 pl-4 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
              {text}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const openDiff = (ref: DiffRef) => trackDiff(ref, (token) => postToHost({ type: 'openDiff', payload: { ref, token } }));

export function useDiffOpening(ref: DiffRef | undefined): boolean {
  return useView((s) => ref !== undefined && s.openingDiff?.key === diffKey(ref));
}

function StatusIcon({ status, icon, expandable }: { status: 'running' | 'ok' | 'error'; icon: ReactNode; expandable?: boolean }) {
  return (
    <span
      className={cn(
        'activity__icon relative inline-flex size-4 shrink-0 items-center justify-center',
        status === 'error' ? 'text-red' : 'text-ink-3',
        expandable && 'transition-opacity duration-100 group-hover/row:opacity-0',
      )}
    >
      {status === 'running' ? <SpinnerIcon className="size-3.5 text-accent" /> : status === 'error' ? <ErrorIcon className="size-3.5" /> : icon}
    </span>
  );
}

/** 对齐 Beautiful UI ToolChips：悬停图标变箭头、内联 bg-field 芯片、border-l 输出抽屉。 */
function ActivityRow({ item }: { item: Of<'activity'> }) {
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
            <svg
              aria-hidden
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn(
                'chevron absolute text-ink-3 transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
                open ? 'chevron--open opacity-100' : 'opacity-0',
              )}
              style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          ) : null}
        </span>
        <span className={cn('activity__name shrink-0 font-medium', item.status === 'error' ? 'text-red' : 'text-ink')}>
          {command ? commandVerb : name}
        </span>
        {chipText ? (
          <span className="activity__detail inline-flex h-5.5 min-w-0 items-center truncate rounded-chip bg-surface px-1.5 font-mono text-[11.5px] text-ink-2 shadow-hairline">
            {chipText}
          </span>
        ) : null}
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open && item.output ? '1fr' : '0fr',
          opacity: open && item.output ? 1 : 0,
          transitionTimingFunction: 'var(--ease-out-strong)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          {open && item.output ? (
            <pre className="activity__output terminal-surface m-0 mt-0.5 mb-1.5 ml-2 max-h-60 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere]">
              {item.output}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GenericToolIcon({ tool }: { tool: string }) {
  if (tool === 'slash') return <SlashIcon className="size-3.5" />;
  if (tool === 'ask_user_question') return <QuestionIcon className="size-3.5" />;
  if (tool === 'exit_plan_mode') return <PlanIcon className="size-3.5" />;
  if (tool.startsWith('web_')) return <GlobeIcon className="size-3.5" />;
  return <ToolIcon className="size-3.5" />;
}

/** 文件编辑行（Beautiful UI ToolChips 风格）。 */
function EditRow({ item }: { item: Of<'activity'> }) {
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
            <svg
              aria-hidden
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn(
                'chevron absolute text-ink-3 transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
                open ? 'chevron--open opacity-100' : 'opacity-0',
              )}
              style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          ) : null}
        </span>
        <span className={cn('activity__name shrink-0 font-medium', item.status === 'error' ? 'text-red' : 'text-ink')}>{verb}</span>
        <FilePath
          path={item.label}
          className={cn(
            'activity__detail activity__file inline-flex h-5.5 min-w-0 items-center rounded-chip bg-surface px-1.5 font-mono text-[11.5px] shadow-hairline',
            diff ? 'activity__file--link text-accent-ink group-hover/row:underline' : 'text-ink-2',
          )}
        />
        {item.stats ? <Stats stats={item.stats} /> : null}
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open && item.output ? '1fr' : '0fr',
          opacity: open && item.output ? 1 : 0,
          transitionTimingFunction: 'var(--ease-out-strong)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          {open && item.output ? (
            <pre className="activity__output terminal-surface m-0 mt-0.5 mb-1.5 ml-2 max-h-60 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere]">
              {item.output}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FilePath({ path, className }: { path: string; className: string }) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slash < 0) return <span className={className}>{path}</span>;
  return (
    <span className={`${className} file-path inline-flex items-baseline gap-1.5 overflow-hidden`}>
      <span className="file-path__name min-w-[3em] flex-[0_1_auto] truncate">{path.slice(slash + 1)}</span>
      <span className="file-path__dir min-w-0 flex-[1_100_0] truncate text-[0.92em] text-ink-3">{path.slice(0, slash)}</span>
    </span>
  );
}

function Stats({ stats }: { stats: Partial<LineStats> }) {
  const { additions, deletions } = stats;
  if (additions === undefined && deletions === undefined) return null;
  const both = !additions && !deletions;
  return (
    <span className="stats inline-flex shrink-0 items-center gap-1 font-mono text-[11.5px] tabular-nums">
      {additions !== undefined && (additions > 0 || both) ? <span className="stats__add text-green">+{additions}</span> : null}
      {deletions !== undefined && deletions > 0 ? <span className="stats__del text-red">−{deletions}</span> : null}
    </span>
  );
}

function ExploreRow({ item }: { item: Of<'explore'> }) {
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
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              'chevron absolute text-ink-3 transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
              open ? 'chevron--open opacity-100' : 'opacity-0',
            )}
            style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
        <span className={cn('activity__name shrink-0 font-medium', item.status === 'error' ? 'text-red' : 'text-ink')}>
          {item.status === 'running' ? t('explore.running') : t('explore.done')}
        </span>
        <span className="activity__detail activity__detail--plain min-w-0 truncate text-ink-2">{item.summary}</span>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'var(--ease-out-strong)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
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
        </div>
      </div>
    </div>
  );
}

/** 改动汇总卡片（对齐 Beautiful UI DiffTable 卡片规范：`primitive-card-bar` + `GlideMenu`）。 */
function ChangesCard({ item }: { item: Of<'changes'> }) {
  const t = useT();
  const total = item.files.reduce(
    (sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }),
    { additions: 0, deletions: 0 },
  );
  return (
    <section className="changes overflow-hidden rounded-card bg-surface shadow-card" aria-label={t('changes.label')}>
      <header className="changes__header primitive-card-bar flex items-center gap-2 border-b border-line text-[12.5px] font-medium text-ink">
        <DiffIcon className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">{t('changes.title', item.total)}</span>
        <Stats stats={total} />
      </header>
      <GlideMenu className="p-1" highlightClassName="inset-x-1 rounded-[6px] bg-hover">
        <ul className="changes__list m-0 list-none p-0">
          {item.files.map((file) => (
            <li key={`${file.path}:${JSON.stringify(file.ref)}`}>
              <ChangedFileButton
                file={file}
                className="changes__file relative z-10 flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] transition-colors duration-100"
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
      <span className="changes__icon inline-flex shrink-0 text-ink-3">{opening ? <SpinnerIcon className="size-3.5 text-accent" /> : <FileIcon className="size-3.5" />}</span>
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

export { Stats };

function Notice({ item }: { item: Of<'notice'> }) {
  const tone =
    item.level === 'error'
      ? 'bg-red-tint text-red shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_28%,transparent)]'
      : item.level === 'warning'
        ? 'bg-orange-tint text-orange shadow-[0_0_0_1px_color-mix(in_srgb,var(--orange)_28%,transparent)]'
        : 'bg-surface text-ink-2 shadow-card';
  return (
    <div className={cn('notice flex items-start gap-2 rounded-card px-3 py-2 text-[12.5px]', `notice--${item.level}`, tone)} role={item.level === 'error' ? 'alert' : undefined}>
      {item.level === 'info' ? <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" /> : <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 leading-relaxed">
        {item.text}
        {item.action ? (
          <>
            {' '}
            <button
              type="button"
              className="link-button inline-flex items-center gap-1 font-medium text-accent-ink hover:underline"
              onClick={() => postToHost({ type: item.action?.kind ?? 'openWebUI', payload: {} })}
            >
              {item.action.kind === 'configureApiKey' ? <KeyIcon className="size-3" /> : <GlobeIcon className="size-3" />}
              {item.action.label}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

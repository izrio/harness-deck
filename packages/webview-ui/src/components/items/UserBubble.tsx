import { useEffect, useRef, useState } from 'react';
import { splitMentions } from '../../mentions.ts';
import { requestMarkdownPreview, requestPrefill, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { attachmentLabel, openAttachment } from '../ContextChips.tsx';
import { isMarkdownPath } from '../MarkdownPreviewModal.tsx';
import { IconAction } from '../RunStatus.tsx';
import { ImageThumb } from '../Images.tsx';
import { CheckIcon, CloseIcon, CopyIcon, EyeIcon, FastForwardIcon, FileIcon, PencilIcon, RefreshIcon, SelectionIcon, SendIcon, SpinnerIcon, TrashIcon } from '../icons.tsx';
import { useT } from '../../i18n.ts';
import type { Of } from './types.ts';

export function UserBubble({ item }: { item: Of<'user'> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  if (editing && item.queue) return <QueueEditor item={item} onDone={() => setEditing(false)} />;
  return (
    <div className={cn('user group/user flex flex-col items-end pl-[14%]', item.pending && `user--${item.pending}`)}>
      {item.text ? (
        <div
          className={cn(
            'user__bubble max-w-full rounded-2xl border border-black/[0.04] bg-field px-3.5 py-2.5 font-[family-name:var(--prose-font-family)] text-[length:var(--prose-font-size)] leading-[1.55] text-ink whitespace-pre-wrap [overflow-wrap:anywhere] dark:border-white/[0.05]',
            (item.pending === 'sending' || item.pending === 'queued') && 'opacity-75',
            item.pending === 'failed' && 'border-red/60 shadow-[0_0_0_1px_var(--red)]',
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

export function UserActions({ text }: { text: string }) {
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

export function QueuedMeta({ item, onEdit }: { item: Of<'user'>; onEdit: () => void }) {
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

export function QueueEditor({ item, onDone }: { item: Of<'user'>; onDone: () => void }) {
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
      <Textarea
        className="queue-editor min-h-0 resize-y rounded-[12px] bg-surface text-[13.5px] shadow-card"
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

export function UserText({ text }: { text: string }) {
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

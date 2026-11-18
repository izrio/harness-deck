/**
 * 消息里的图片（Beautiful UI 缩略图卡片与 Portal 大图灯箱）。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ImageView } from '@harness-deck/shared';
import { imageKey, requestImage, useView } from '../store.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { CloseIcon, ErrorIcon, ImageIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

function useImageSrc(image: ImageView): string | 'error' | undefined {
  const key = imageKey(image);
  const value = useView((s) => (key ? s.images[key] : undefined));
  useEffect(() => {
    if (image.attachmentId && value === undefined) requestImage(image.attachmentId);
  }, [image.attachmentId, value]);
  return value === 'loading' ? undefined : value;
}

export function ImageThumb({ image, onRemove, size = 'normal' }: { image: ImageView; onRemove?: () => void; size?: 'normal' | 'small' }) {
  const t = useT();
  const src = useImageSrc(image);
  const [open, setOpen] = useState(false);
  const label = image.name ?? t('image.label');
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        className={cn(
          'flex cursor-zoom-in items-center justify-center overflow-hidden bg-field p-0 shadow-card transition-[transform,box-shadow] duration-150 hover:shadow-[0_0_0_1px_var(--accent)]',
          size === 'small' ? 'size-14 rounded-control' : 'h-[90px] w-[120px] rounded-card',
        )}
        onClick={() => src && src !== 'error' && setOpen(true)}
        title={label}
        aria-label={t('image.view', label)}
      >
        {src === 'error' ? (
          <span className="inline-flex text-red" title={t('image.failed')}>
            <ErrorIcon className="size-4" />
          </span>
        ) : src ? (
          <img src={src} alt={label} className="size-full object-cover" />
        ) : (
          <span className="inline-flex text-ink-3" style={{ animation: 'pulse 1.6s ease-in-out infinite' }}>
            <ImageIcon className="size-4" />
          </span>
        )}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="absolute -top-1.5 -right-1.5 inline-flex size-4.5 items-center justify-center rounded-full bg-surface text-ink shadow-btn transition-colors duration-100 hover:bg-red hover:text-white"
          onClick={onRemove}
          aria-label={t('image.remove', label)}
          title={t('image.remove', label)}
        >
          <CloseIcon className="size-2.5" />
        </button>
      ) : null}
      {open && src && src !== 'error' && typeof document !== 'undefined'
        ? createPortal(<Lightbox src={src} label={label} onClose={() => setOpen(false)} />, document.body)
        : null}
    </span>
  );
}

function Lightbox({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
      style={{ animation: 'fade-in 150ms ease-out both' }}
    >
      <img src={src} alt={label} onClick={(e) => e.stopPropagation()} />
      <button
        ref={closeRef}
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="sr-only"
      />
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className="absolute top-3 right-3"
        aria-label={t('common.close')}
        onClick={onClose}
      >
        <CloseIcon className="size-4" />
      </Button>
    </div>
  );
}

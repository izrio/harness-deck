/**
 * 面板内 Markdown 文件预览：
 * 与聊天回复、计划审阅共用 `.markdown`（字体、字号、行高、段距）及 `--content-width` 内容宽度。
 */
import { useEffect } from 'react';
import { useT } from '../i18n.ts';
import { closeMarkdownPreview, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ArrowLeftIcon, FileTypeIcon, SpinnerIcon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { ValuePill } from './beautifului/index.ts';
import { Button } from '@/components/ui/button';

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/iu.test(path);
}

export function MarkdownPreviewModal() {
  const preview = useView((s) => s.markdownPreview);
  const clientSurface = useView((s) => s.clientSurface);
  const t = useT();

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMarkdownPreview();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);

  if (!preview) return null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      role="dialog"
      aria-label={t('markdown.previewTitle')}
      data-testid="markdown-preview-modal"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Button type="button" variant="ghost" size="xs" data-testid="markdown-preview-close" onClick={closeMarkdownPreview}>
          <ArrowLeftIcon className="size-3.5" />
          <span>{t('common.close')}</span>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <FileTypeIcon path={preview.path} className="size-3.5 shrink-0" />
          <span className="truncate text-[13px] font-semibold text-ink">{preview.title}</span>
          <ValuePill className="hidden truncate font-mono text-[10.5px] sm:inline-flex">{preview.path}</ValuePill>
        </div>
        {clientSurface !== 'mobile-web' ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="markdown-preview-open-editor"
            onClick={() => postToHost({ type: 'openFile', payload: { path: preview.path } })}
          >
            {t('markdown.openInEditor')}
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        <div className="mx-auto w-full max-w-[var(--content-width)] rounded-card bg-surface p-4 shadow-card">
          {preview.loading ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-ink-3">
              <SpinnerIcon className="size-4" />
              <span>{t('thread.loading')}</span>
            </div>
          ) : preview.error ? (
            <div className="py-4 text-[13px] text-red">{preview.error}</div>
          ) : (
            <Markdown text={preview.content ?? ''} />
          )}
        </div>
      </div>
    </div>
  );
}

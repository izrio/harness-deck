/**
 * 插件内置文件与 Diff 查看器（同时服务桌面 IDE 插件、远程 Web 与未来独立客户端）：
 * 接收宿主单播的 `diffContent` 消息，在主内容区内展示只读代码/Markdown 预览或 unified Diff。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '../i18n.ts';
import { buildUnifiedDiffLines, parseUnifiedPatchLines, type DiffDisplayLine } from '../lib/lineDiff.ts';
import { cn } from '../lib/utils.ts';
import { closeDiffContent, useView } from '../store.ts';
import { ValuePill } from './beautifului/index.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { ArrowLeftIcon, DiffIcon, FileTypeIcon, InfoIcon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { isMarkdownPath } from './MarkdownPreviewModal.tsx';

function DiffLinesView({ lines }: { readonly lines: readonly DiffDisplayLine[] }) {
  const t = useT();
  if (lines.length === 0) {
    return <div className="p-4 text-center text-[12.5px] text-ink-3">{t('diff.modal.empty')}</div>;
  }
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.55]" data-testid="diff-lines-view">
      <div className="min-w-max">
        {lines.map((line, index) => {
          if (line.kind === 'hunk') {
            return (
              <div key={index} className="bg-field px-3 py-1 text-[11px] text-accent-ink select-none">
                {line.text}
              </div>
            );
          }
          const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
          return (
            <div
              key={index}
              className={cn(
                'flex items-stretch px-2 whitespace-pre',
                line.kind === 'add' && 'bg-green-tint text-ink',
                line.kind === 'del' && 'bg-red-tint text-ink',
                line.kind === 'context' && 'text-ink-2',
              )}
            >
              <span className="inline-block w-9 shrink-0 pr-2 text-right text-[11px] text-ink-4 select-none tabular-nums">
                {line.oldLine ?? ''}
              </span>
              <span className="inline-block w-9 shrink-0 pr-2 text-right text-[11px] text-ink-4 select-none tabular-nums">
                {line.newLine ?? ''}
              </span>
              <span
                className={cn(
                  'inline-block w-4 shrink-0 text-center select-none',
                  line.kind === 'add' && 'text-green',
                  line.kind === 'del' && 'text-red',
                )}
              >
                {prefix}
              </span>
              <span className="pr-3">{line.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DiffViewerModal() {
  const diff = useView((s) => s.diffContent);
  const t = useT();
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview');

  useEffect(() => {
    setMarkdownMode('preview');
  }, [diff?.path, diff?.kind]);

  useEffect(() => {
    if (!diff) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDiffContent();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [diff]);

  const diffLines = useMemo<readonly DiffDisplayLine[]>(() => {
    if (!diff) return [];
    if (diff.kind === 'pair') {
      return buildUnifiedDiffLines(diff.before ?? '', diff.after ?? '');
    }
    if (diff.kind === 'unified') {
      return parseUnifiedPatchLines(diff.patchText ?? '');
    }
    return [];
  }, [diff]);

  if (!diff) return null;

  const isFile = diff.kind === 'file';
  const isMarkdownFile = isFile && isMarkdownPath(diff.path);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      role="dialog"
      aria-label={isFile ? t('diff.modal.fileTitle') : t('diff.modal.title')}
      data-testid="diff-viewer-modal"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Button type="button" variant="ghost" size="xs" data-testid="diff-viewer-close" onClick={closeDiffContent}>
          <ArrowLeftIcon className="size-3.5" />
          <span>{t('common.close')}</span>
        </Button>

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {isFile ? (
            <FileTypeIcon path={diff.path} className="size-3.5 shrink-0" />
          ) : (
            <DiffIcon className="size-3.5 shrink-0 text-accent-ink" />
          )}
          <span className="truncate text-[13px] font-semibold text-ink">{diff.title}</span>
          <ValuePill className="hidden truncate font-mono text-[10.5px] sm:inline-flex">{diff.path}</ValuePill>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isMarkdownFile ? (
            <Tabs value={markdownMode} onValueChange={(v) => setMarkdownMode(v as 'preview' | 'source')}>
              <TabsList className="h-6 p-0.5">
                <TabsTrigger
                  value="preview"
                  className="px-2 py-0 text-[11px]"
                  data-testid="diff-markdown-preview-tab"
                  onClick={() => setMarkdownMode('preview')}
                >
                  {t('diff.modal.preview')}
                </TabsTrigger>
                <TabsTrigger
                  value="source"
                  className="px-2 py-0 text-[11px]"
                  data-testid="diff-markdown-source-tab"
                  onClick={() => setMarkdownMode('source')}
                >
                  {t('diff.modal.source')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          {diff.readonly ? <ValuePill tone="neutral">{t('diff.modal.readonly')}</ValuePill> : null}
          {diff.additions !== undefined ? <span className="text-[11.5px] font-medium text-green tabular-nums">+{diff.additions}</span> : null}
          {diff.deletions !== undefined ? <span className="text-[11.5px] font-medium text-red tabular-nums">−{diff.deletions}</span> : null}
        </div>
      </div>

      {diff.truncated ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-line bg-orange-tint px-3 py-1.5 text-[11.5px] text-orange"
          data-testid="diff-truncated-banner"
        >
          <InfoIcon className="size-3.5 shrink-0" />
          <span>{t('diff.modal.truncated')}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div
          className={cn(
            'mx-auto w-full overflow-hidden rounded-card bg-surface shadow-card',
            isMarkdownFile && markdownMode === 'preview' ? 'max-w-[var(--content-width)] p-4' : '',
          )}
        >
          {diff.kind === 'cannotPreview' ? (
            <div className="p-4 text-[13px] text-ink-2" data-testid="diff-cannot-preview">
              {diff.message ?? t('diff.modal.empty')}
            </div>
          ) : isMarkdownFile && markdownMode === 'preview' ? (
            <div data-testid="diff-markdown-preview">
              <Markdown text={diff.after ?? ''} />
            </div>
          ) : diff.kind === 'file' ? (
            <div className="p-2" data-testid="diff-file-preview">
              <CodeBlock code={diff.after ?? ''} {...(diff.language ? { lang: diff.language } : {})} />
            </div>
          ) : (
            <DiffLinesView lines={diffLines} />
          )}
        </div>
      </div>
    </div>
  );
}

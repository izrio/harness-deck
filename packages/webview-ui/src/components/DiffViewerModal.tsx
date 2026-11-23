/**
 * 插件内置代码编辑与 Diff 审阅查看器（HD-25 / P0-1）：
 * - 文件视图：懒加载 CodeMirror 6 编辑器（支持搜索 Ctrl/Cmd+F、折叠、主题同步与 Ctrl/Cmd+S 保存，降级回退 Shiki `CodeBlock`）；
 * - Diff 视图：支持 Unified / Split 并排对比切换、Shiki 语法高亮、词级差异高亮、按 Hunk 暂存/撤销，
 *   以及点击任意 Diff 行直接写批注并回填到对话输入框让智能体修复。
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '../i18n.ts';
import {
  buildSplitDiffRows,
  buildUnifiedDiffLines,
  computeWordDiffSegments,
  extractHunkPatch,
  parseUnifiedPatchLines,
  type DiffDisplayLine,
} from '../lib/lineDiff.ts';
import { cn } from '../lib/utils.ts';
import { closeDiffContent, requestPrefill, setActiveModule, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { ValuePill } from './beautifului/index.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { highlight, type Token } from './highlighter.ts';
import {
  ArrowLeftIcon,
  CheckIcon,
  ColumnsIcon,
  CopyIcon,
  DiffIcon,
  FileTypeIcon,
  InfoIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  UndoIcon,
} from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { isMarkdownPath } from './MarkdownPreviewModal.tsx';

const LazyCodeMirrorEditor = lazy(() => import('./CodeMirrorEditor.tsx'));

/** 异步提取每行代码的 Shiki 词法着色 token（零 innerHTML，100% 适配严格 Webview CSP）。 */
function useShikiLineTokens(
  lines: readonly DiffDisplayLine[],
  lang: string | undefined,
): ReadonlyMap<number, readonly Token[]> {
  const [map, setMap] = useState<ReadonlyMap<number, readonly Token[]>>(() => new Map());

  useEffect(() => {
    if (!lang || lines.length === 0 || lines.length > 1_200) {
      setMap(new Map());
      return;
    }
    let cancelled = false;
    const indices: number[] = [];
    const codeLines: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.kind !== 'hunk') {
        indices.push(i);
        codeLines.push(lines[i]!.text);
      }
    }
    if (codeLines.length === 0) return;
    void highlight(codeLines.join('\n'), lang).then((tokenLines) => {
      if (cancelled || !tokenLines) return;
      const next = new Map<number, readonly Token[]>();
      for (let i = 0; i < Math.min(tokenLines.length, indices.length); i += 1) {
        next.set(indices[i]!, tokenLines[i]!);
      }
      setMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [lines, lang]);

  return map;
}

function renderWordSegments(segments: readonly { readonly text: string; readonly changed: boolean }[], kind: 'add' | 'del') {
  return segments.map((seg, i) =>
    seg.changed ? (
      <mark
        key={i}
        className={cn(
          'rounded-[2px] px-0.5 text-inherit',
          kind === 'add' ? 'bg-green/25' : 'bg-red/25',
        )}
      >
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

interface DiffLinesViewProps {
  readonly lines: readonly DiffDisplayLine[];
  readonly filePath: string;
  readonly language?: string;
  readonly mode: 'unified' | 'split';
  readonly canHunkAction: boolean;
  readonly staged?: boolean;
  readonly onCommentSubmit: (lineNumber: number, lineText: string, comment: string) => void;
  readonly onStageHunk?: (patch: string) => void;
  readonly onDiscardHunk?: (patch: string) => void;
}

function DiffLinesView({
  lines,
  filePath,
  language,
  mode,
  canHunkAction,
  staged,
  onCommentSubmit,
  onStageHunk,
  onDiscardHunk,
}: DiffLinesViewProps) {
  const t = useT();
  const shikiLines = useShikiLineTokens(lines, language);
  const [commentTarget, setCommentTarget] = useState<{ readonly key: string; readonly lineNum: number; readonly text: string } | null>(null);
  const [commentText, setCommentText] = useState('');

  const hunkStartByOrdinal = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.kind === 'hunk') out.push(i);
    }
    return out;
  }, [lines]);

  // 为紧邻的 del/add 对计算词级高亮
  const wordDiffByIndex = useMemo(() => {
    const map = new Map<number, readonly { readonly text: string; readonly changed: boolean }[]>();
    for (let i = 0; i < lines.length - 1; i += 1) {
      const a = lines[i]!;
      const b = lines[i + 1]!;
      if (a.kind === 'del' && b.kind === 'add') {
        const seg = computeWordDiffSegments(a.text, b.text);
        map.set(i, seg.left);
        map.set(i + 1, seg.right);
      }
    }
    return map;
  }, [lines]);

  const splitRows = useMemo(() => (mode === 'split' ? buildSplitDiffRows(lines) : []), [lines, mode]);

  const shikiByLineObj = useMemo(() => {
    const map = new Map<DiffDisplayLine, readonly Token[]>();
    for (const [idx, tokens] of shikiLines) {
      const line = lines[idx];
      if (line) map.set(line, tokens);
    }
    return map;
  }, [lines, shikiLines]);

  const renderTokensOrText = (line: DiffDisplayLine | undefined) => {
    if (!line) return ' ';
    const tokens = shikiByLineObj.get(line);
    if (tokens && tokens.length > 0) {
      return (
        <span className="shiki">
          {tokens.map((tok, ti) => (
            <span key={ti} style={tok.style}>
              {tok.content}
            </span>
          ))}
        </span>
      );
    }
    return line.text || ' ';
  };

  if (lines.length === 0) {
    return <div className="p-4 text-center text-[12.5px] text-ink-3">{t('diff.modal.empty')}</div>;
  }

  const submitComment = () => {
    if (!commentTarget || !commentText.trim()) return;
    onCommentSubmit(commentTarget.lineNum, commentTarget.text, commentText.trim());
    setCommentTarget(null);
    setCommentText('');
  };

  const renderHunkBar = (text: string, hunkLineIndex: number, key: string | number) => {
    const patch = canHunkAction ? extractHunkPatch(filePath, lines, hunkLineIndex) : undefined;
    return (
      <div
        key={key}
        className="flex items-center justify-between gap-2 bg-field px-3 py-1 text-[11px] text-accent-ink select-none"
      >
        <span className="truncate">{text}</span>
        {patch && !staged ? (
          <div className="flex shrink-0 items-center gap-1">
            {onStageHunk ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="diff-stage-hunk"
                className="px-1.5 text-[11px] text-green hover:text-green"
                onClick={() => onStageHunk(patch)}
              >
                <PlusIcon className="size-3" />
                <span>{t('diff.modal.stageHunk')}</span>
              </Button>
            ) : null}
            {onDiscardHunk ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="diff-discard-hunk"
                className="px-1.5 text-[11px] text-red hover:text-red"
                onClick={() => onDiscardHunk(patch)}
              >
                <UndoIcon className="size-3" />
                <span>{t('diff.modal.discardHunk')}</span>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderCommentBox = () =>
    commentTarget ? (
      <div
        className="flex flex-wrap items-center gap-1.5 border-y border-line bg-surface px-3 py-2"
        data-testid="diff-line-comment-box"
      >
        <span className="font-mono text-[11px] text-accent-ink">
          L{commentTarget.lineNum}
        </span>
        <Input
          size="xs"
          autoFocus
          className="min-w-44 flex-1"
          placeholder={t('diff.modal.commentPlaceholder')}
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitComment();
            } else if (e.key === 'Escape') {
              setCommentTarget(null);
            }
          }}
        />
        <Button type="button" size="xs" disabled={!commentText.trim()} onClick={submitComment}>
          {t('diff.modal.commentSend')}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => setCommentTarget(null)}>
          {t('common.cancel')}
        </Button>
      </div>
    ) : null;

  if (mode === 'split') {
    return (
      <div className="overflow-x-auto font-mono text-[12px] leading-[1.55]" data-testid="diff-split-view">
        <div className="min-w-[680px]">
          {splitRows.map((row, idx) => {
            if (row.kind === 'hunk') {
              const startIndex = hunkStartByOrdinal[row.hunkIndex ?? 0] ?? 0;
              return renderHunkBar(row.hunkText ?? '', startIndex, `sh-${idx}`);
            }
            const left = row.left;
            const right = row.right;
            const wordPair =
              left?.kind === 'del' && right?.kind === 'add'
                ? computeWordDiffSegments(left.text, right.text)
                : undefined;
            const targetKey = `split-${idx}`;
            const lineNum = right?.newLine ?? left?.oldLine ?? 1;
            const targetText = right?.text ?? left?.text ?? '';
            return (
              <div key={idx}>
                <div className="group/row grid grid-cols-2 border-b border-line-soft/40">
                  <div
                    className={cn(
                      'flex min-w-0 items-stretch border-r border-line px-2 whitespace-pre',
                      left?.kind === 'del' && 'bg-red-tint text-ink',
                      left?.kind === 'context' && 'text-ink-2',
                      !left && 'bg-inset/40',
                    )}
                  >
                    <span className="inline-block w-9 shrink-0 pr-2 text-right text-[11px] text-ink-4 select-none tabular-nums">
                      {left?.oldLine ?? ''}
                    </span>
                    <span className="min-w-0 flex-1 overflow-x-hidden pr-2">
                      {wordPair
                        ? renderWordSegments(wordPair.left, 'del')
                        : renderTokensOrText(left)}
                    </span>
                  </div>
                  <div
                    className={cn(
                      'relative flex min-w-0 items-stretch px-2 whitespace-pre',
                      right?.kind === 'add' && 'bg-green-tint text-ink',
                      right?.kind === 'context' && 'text-ink-2',
                      !right && 'bg-inset/40',
                    )}
                  >
                    <span className="inline-block w-9 shrink-0 pr-2 text-right text-[11px] text-ink-4 select-none tabular-nums">
                      {right?.newLine ?? ''}
                    </span>
                    <span className="min-w-0 flex-1 overflow-x-hidden pr-7">
                      {wordPair
                        ? renderWordSegments(wordPair.right, 'add')
                        : renderTokensOrText(right)}
                    </span>
                    <button
                      type="button"
                      title={t('diff.modal.commentLine')}
                      aria-label={t('diff.modal.commentLine')}
                      className="absolute top-0.5 right-1 inline-flex size-5 items-center justify-center rounded bg-surface/90 text-ink-3 opacity-0 shadow-hairline transition-opacity group-hover/row:opacity-100 hover:text-accent-ink"
                      onClick={() => {
                        setCommentTarget({ key: targetKey, lineNum, text: targetText });
                        setCommentText('');
                      }}
                    >
                      <MessageSquarePlusIcon className="size-3" />
                    </button>
                  </div>
                </div>
                {commentTarget?.key === targetKey ? renderCommentBox() : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.55]" data-testid="diff-lines-view">
      <div className="min-w-max">
        {lines.map((line, index) => {
          if (line.kind === 'hunk') {
            return renderHunkBar(line.text, index, index);
          }
          const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
          const wordSegs = wordDiffByIndex.get(index);
          const shikiTokens = shikiLines.get(index);
          const rowKey = `u-${index}`;
          const lineNum = line.newLine ?? line.oldLine ?? 1;
          return (
            <div key={index}>
              <div
                className={cn(
                  'group/row flex items-stretch px-2 whitespace-pre',
                  line.kind === 'add' && 'bg-green-tint text-ink',
                  line.kind === 'del' && 'bg-red-tint text-ink',
                  line.kind === 'context' && 'text-ink-2',
                )}
              >
                <button
                  type="button"
                  title={t('diff.modal.commentLine')}
                  aria-label={t('diff.modal.commentLine')}
                  data-testid="diff-line-comment-btn"
                  className="mr-1 inline-flex size-4 shrink-0 self-center items-center justify-center rounded text-ink-3 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-hover-2 hover:text-accent-ink focus-visible:opacity-100"
                  onClick={() => {
                    setCommentTarget({ key: rowKey, lineNum, text: line.text });
                    setCommentText('');
                  }}
                >
                  <MessageSquarePlusIcon className="size-3" />
                </button>
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
                {wordSegs && (line.kind === 'add' || line.kind === 'del') ? (
                  <span className="pr-3">{renderWordSegments(wordSegs, line.kind)}</span>
                ) : shikiTokens !== undefined ? (
                  <span className="shiki pr-3">
                    {shikiTokens.length > 0
                      ? shikiTokens.map((tok, ti) => (
                          <span key={ti} style={tok.style}>
                            {tok.content}
                          </span>
                        ))
                      : ' '}
                  </span>
                ) : (
                  <span className="pr-3">{line.text || ' '}</span>
                )}
              </div>
              {commentTarget?.key === rowKey ? renderCommentBox() : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DiffViewerModal() {
  const diff = useView((s) => s.diffContent);
  const fileSavedResult = useView((s) => s.fileSavedResult);
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');
  const t = useT();
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview');
  const [diffMode, setDiffMode] = useState<'unified' | 'split'>('unified');
  const [draftContent, setDraftContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [searchSignal, setSearchSignal] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSaveContentRef = useRef<string | undefined>(undefined);
  const pendingHunkRefreshRef = useRef(false);
  const sourceControlUpdatedAt = useView((s) => s.workbench.sourceControl?.updatedAt);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    setMarkdownMode('preview');
    setCopied(false);
    setSaving(false);
    pendingSaveContentRef.current = undefined;
    pendingHunkRefreshRef.current = false;
    const initial = diff?.after ?? '';
    setDraftContent(initial);
    setSavedContent(initial);
  }, [diff?.path, diff?.kind, diff?.after]);

  useEffect(() => {
    if (!fileSavedResult || !diff || fileSavedResult.path !== diff.path) return;
    setSaving(false);
    if (fileSavedResult.ok && pendingSaveContentRef.current !== undefined) {
      setSavedContent(pendingSaveContentRef.current);
    }
    pendingSaveContentRef.current = undefined;
  }, [fileSavedResult, diff]);

  // 按 Hunk 暂存/撤销后，待源码控制状态刷新完毕自动重新拉取当前文件 Diff，避免视图停留在旧内容
  useEffect(() => {
    if (!pendingHunkRefreshRef.current || !diff?.sourceControlPath) return;
    pendingHunkRefreshRef.current = false;
    postToHost({
      type: 'openSourceControlDiff',
      payload: { path: diff.sourceControlPath, ...(diff.staged !== undefined ? { staged: diff.staged } : {}) },
    });
  }, [sourceControlUpdatedAt, diff?.sourceControlPath, diff?.staged]);

  useEffect(() => {
    if (!diff) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('.cm-search, [data-testid="diff-line-comment-box"]')) return;
        closeDiffContent();
      }
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
  const isDiff = diff.kind === 'pair' || diff.kind === 'unified';
  const isMarkdownFile = isFile && isMarkdownPath(diff.path);
  const showMarkdownPreview = isMarkdownFile && markdownMode === 'preview';
  const canEdit = isFile && Boolean(diff.editable) && !remoteReadOnly && !diff.truncated;
  const dirty = canEdit && draftContent !== savedContent;
  const canHunkAction = Boolean(isDiff && diff.sourceControlPath && !remoteReadOnly);

  const saveFile = (contentToSave = draftContent) => {
    if (!canEdit || saving) return;
    pendingSaveContentRef.current = contentToSave;
    setSaving(true);
    postToHost({ type: 'saveWorkspaceFile', payload: { path: diff.path, content: contentToSave } });
  };

  const copyFileContent = () => {
    const text = isFile ? draftContent : diff.after ?? '';
    if (!text) return;
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  };

  const sendLineComment = (lineNumber: number, lineText: string, comment: string) => {
    const snippet = lineText.trim().slice(0, 160);
    const formatted = `[Review ${diff.path}:L${lineNumber}]\n\`\`\`\n${snippet}\n\`\`\`\n${comment}`;
    closeDiffContent();
    setActiveModule('sessions');
    requestPrefill(formatted, 'restore');
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      role="dialog"
      aria-label={isFile ? t('diff.modal.fileTitle') : t('diff.modal.title')}
      data-testid="diff-viewer-modal"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
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
          {dirty ? <ValuePill tone="orange">{t('diff.modal.unsaved')}</ValuePill> : null}
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
          {isDiff ? (
            <Button
              type="button"
              variant={diffMode === 'split' ? 'secondary' : 'ghost'}
              size="xs"
              data-testid="diff-mode-toggle"
              className="hidden sm:inline-flex"
              onClick={() => setDiffMode((m) => (m === 'unified' ? 'split' : 'unified'))}
            >
              <ColumnsIcon className="size-3.5" />
              <span>{diffMode === 'split' ? t('diff.modal.split') : t('diff.modal.unified')}</span>
            </Button>
          ) : null}
          {isFile && !showMarkdownPreview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('diff.modal.search')}
              title={t('diff.modal.search')}
              onClick={() => setSearchSignal((n) => n + 1)}
            >
              <SearchIcon className="size-3.5" />
            </Button>
          ) : null}
          {canEdit && !showMarkdownPreview ? (
            <Button
              type="button"
              variant={dirty ? 'default' : 'ghost'}
              size="xs"
              disabled={!dirty || saving}
              data-testid="diff-file-save"
              onClick={() => saveFile()}
            >
              <SaveIcon className="size-3.5" />
              <span>{saving ? t('diff.modal.saving') : t('diff.modal.save')}</span>
            </Button>
          ) : null}
          {isFile && !showMarkdownPreview && diff.language ? (
            <span className="hidden font-mono text-[11px] text-ink-3 sm:inline">{diff.language}</span>
          ) : null}
          {isFile && !showMarkdownPreview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('code.copy')}
              title={copied ? t('code.copied') : t('code.copyShort')}
              onClick={copyFileContent}
              className={cn(copied ? 'text-green' : 'text-ink-3 hover:text-ink')}
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
          ) : null}
          {!canEdit && diff.readonly ? <ValuePill tone="neutral">{t('diff.modal.readonly')}</ValuePill> : null}
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

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        {diff.kind === 'cannotPreview' ? (
          <div className="p-4 text-[13px] text-ink-2" data-testid="diff-cannot-preview">
            {diff.message ?? t('diff.modal.empty')}
          </div>
        ) : showMarkdownPreview ? (
          <div className="mx-auto w-full max-w-[var(--content-width)] px-5 py-4" data-testid="diff-markdown-preview">
            <Markdown text={draftContent} />
          </div>
        ) : diff.kind === 'file' ? (
          <div className="h-full min-h-full w-full" data-testid="diff-file-preview">
            <Suspense
              fallback={
                <CodeBlock
                  variant="plain"
                  code={draftContent}
                  {...(diff.language ? { lang: diff.language } : {})}
                />
              }
            >
              <LazyCodeMirrorEditor
                key={diff.path}
                value={draftContent}
                {...(diff.language ? { language: diff.language } : {})}
                readOnly={!canEdit}
                onChange={setDraftContent}
                onSave={(v) => saveFile(v)}
                searchSignal={searchSignal}
              />
            </Suspense>
          </div>
        ) : (
          <DiffLinesView
            lines={diffLines}
            filePath={diff.sourceControlPath ?? diff.path}
            {...(diff.language ? { language: diff.language } : {})}
            mode={diffMode}
            canHunkAction={canHunkAction}
            {...(diff.staged !== undefined ? { staged: diff.staged } : {})}
            onCommentSubmit={sendLineComment}
            onStageHunk={(patch) => {
              pendingHunkRefreshRef.current = true;
              postToHost({ type: 'sourceControlStageHunk', payload: { patch } });
            }}
            onDiscardHunk={(patch) => {
              pendingHunkRefreshRef.current = true;
              postToHost({ type: 'sourceControlDiscardHunk', payload: { patch, confirmed: true } });
            }}
          />
        )}
      </div>
    </div>
  );
}

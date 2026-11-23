import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { cachedHighlight, highlight, type HighlightedLines } from './highlighter.ts';
import { cn } from '../lib/utils.ts';
import { CheckIcon, CodeIcon, CopyIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

/** Beautiful UI CodeBlock：对话内联代码块（card）与全屏文件查看器无边框代码画布（plain）共用 Shiki 高亮。 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  variant = 'card',
}: {
  code: string;
  lang?: string;
  variant?: 'card' | 'plain';
}) {
  const [lines, setLines] = useState<HighlightedLines | undefined>(() => cachedHighlight(code, lang));
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    const cached = cachedHighlight(code, lang);
    if (cached) {
      setLines(cached);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      highlight(code, lang).then(
        (result) => {
          if (!cancelled) setLines(result);
        },
        () => undefined,
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, lang]);

  const t = useT();
  const copy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  };

  const rawLines = code.split('\n');
  const totalLines = lines ? lines.length : rawLines.length;
  const gutterWidth = Math.max(variant === 'plain' ? 44 : 28, String(totalLines).length * 8 + 16);

  const codeContent = (
    <pre
      className={cn(
        'terminal-surface relative m-0 overflow-x-auto text-ink-2',
        variant === 'plain' && 'min-h-full',
        lines && 'shiki',
      )}
    >
      <code className="relative block bg-transparent py-2.5 font-mono text-inherit">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-line/70"
          style={{ left: `${gutterWidth}px` }}
        />
        {lines
          ? lines.map((line, i) => (
              <div
                className="line grid items-start"
                style={{ gridTemplateColumns: `${gutterWidth}px minmax(0,1fr)` }}
                key={i}
              >
                <span className="select-none pr-2.5 text-right text-[11px] text-ink-3 tabular-nums">{i + 1}</span>
                <span className="pr-3 pl-3 whitespace-pre">
                  {line.length === 0
                    ? '\u200b'
                    : line.map((token, j) => (
                        <span key={j} style={token.style as CSSProperties}>
                          {token.content}
                        </span>
                      ))}
                </span>
              </div>
            ))
          : rawLines.map((line, i) => (
              <div
                className="line grid items-start"
                style={{ gridTemplateColumns: `${gutterWidth}px minmax(0,1fr)` }}
                key={i}
              >
                <span className="select-none pr-2.5 text-right text-[11px] text-ink-3 tabular-nums">{i + 1}</span>
                <span className="pr-3 pl-3 whitespace-pre">{line || '\u200b'}</span>
              </div>
            ))}
      </code>
    </pre>
  );

  if (variant === 'plain') {
    return (
      <div className="code-block code-block--plain min-h-full w-full bg-canvas" data-lang={lang ?? ''}>
        {codeContent}
      </div>
    );
  }

  return (
    <div className="code-block my-2.5 w-full overflow-hidden rounded-xl border border-line bg-inset/70 dark:bg-surface">
      <div className="flex h-8 items-center gap-2 border-b border-line/70 px-3 text-[12px]">
        <span className="inline-flex min-w-0 items-center gap-2 text-ink">
          <CodeIcon width={14} height={14} strokeWidth={1.8} className="shrink-0 text-ink-3" />
          <span className="truncate font-mono leading-none text-ink-2">{lang ?? t('code.plainLabel')}</span>
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={t('code.copy')}
          title={copied ? t('code.copied') : t('code.copyShort')}
          className={cn(
            '-mr-1 ml-auto flex h-6 items-center gap-1 rounded-chip px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-hover',
            copied ? 'text-green' : 'text-ink-3 hover:text-ink',
          )}
        >
          {copied ? <CheckIcon className="size-3" strokeWidth={2.5} /> : <CopyIcon className="size-3" />}
          <span>{copied ? t('code.copied') : t('code.copyShort')}</span>
        </button>
      </div>

      {codeContent}
    </div>
  );
});

import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { cachedHighlight, highlight, type HighlightedLines } from './highlighter.ts';
import { cn } from '../lib/utils.ts';
import { CheckIcon, CopyIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

/** Beautiful UI CodeBlock：统一 surface + shadow-card、顶栏标题与复制按钮、行号与竖线分割。 */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
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

  return (
    <div className="code-block my-2.5 w-full overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex h-9 items-center gap-2 border-b border-line px-3.5 text-[12px]">
        <span className="inline-flex min-w-0 items-center gap-2 text-ink">
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3">
            <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
          </svg>
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

      <pre className={cn('terminal-surface relative m-0 overflow-x-auto text-ink-2', lines && 'shiki')}>
        <code className="relative block bg-transparent py-2.5 font-mono text-inherit">
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-7 w-px bg-line" />
          {lines
            ? lines.map((line, i) => (
                <div className="line grid grid-cols-[28px_minmax(0,1fr)] items-start" key={i}>
                  <span className="select-none text-center text-[11px] text-ink-3 tabular-nums">{i + 1}</span>
                  <span className="pr-3 pl-2.5 whitespace-pre">
                    {line.length === 0 ? '\u200b' : line.map((token, j) => (
                      <span key={j} style={token.style as CSSProperties}>
                        {token.content}
                      </span>
                    ))}
                  </span>
                </div>
              ))
            : rawLines.map((line, i) => (
                <div className="line grid grid-cols-[28px_minmax(0,1fr)] items-start" key={i}>
                  <span className="select-none text-center text-[11px] text-ink-3 tabular-nums">{i + 1}</span>
                  <span className="pr-3 pl-2.5 whitespace-pre">{line || '\u200b'}</span>
                </div>
              ))}
        </code>
      </pre>
    </div>
  );
});

/**
 * Markdown 渲染。不启用原始 HTML（react-markdown 默认就不渲染），链接一律交给 Host 校验后在外部打开。
 * 行内 Markdown 文件路径支持一键在面板内打开「Markdown 文件预览」（共用阅读与聊天排版参数）。
 */
import { memo, type ComponentProps, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requestMarkdownPreview } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { EyeIcon } from './icons.tsx';
import { useT } from '../i18n.ts';

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  event.preventDefault();
  if (href && /^https?:\/\//iu.test(href)) postToHost({ type: 'openExternal', payload: { url: href } });
}

const components: Components = {
  a: ({ href, children }: ComponentProps<'a'>) => (
    <a href={href} onClick={(event) => openLink(event, href)} title={href}>
      {children}
    </a>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const lang = /language-([\w+#.-]+)/u.exec(className ?? '')?.[1];
    // 带语言标记或多行的是代码块，其余是行内代码
    if (lang || text.includes('\n')) return <CodeBlock code={text.replace(/\n$/u, '')} {...(lang ? { lang } : {})} />;
    const file = parseFileRef(text);
    if (file) return <FileRef text={text} file={file} />;
    return <code className="inline-code">{children}</code>;
  },
  table: ({ children }) => (
    <div className="table-wrap w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <Table className="text-[0.92em]">{children}</Table>
    </div>
  ),
  thead: ({ children }) => (
    <TableHeader className="bg-inset/70 [&_tr]:border-b [&_tr]:border-line/70">{children}</TableHeader>
  ),
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tfoot: ({ children }) => <TableFooter className="border-line/70 bg-inset/50">{children}</TableFooter>,
  tr: ({ children }) => <TableRow className="border-line/65 hover:bg-hover/40">{children}</TableRow>,
  th: ({ children, style }) => (
    <TableHead
      style={style}
      className="h-auto px-3 py-2 text-[0.88em] font-semibold whitespace-normal text-ink-2 [text-wrap:pretty]"
    >
      {children}
    </TableHead>
  ),
  td: ({ children, style }) => (
    <TableCell
      style={style}
      className="px-3 py-2 align-top whitespace-normal text-ink [text-wrap:pretty]"
    >
      {children}
    </TableCell>
  ),
  img: ({ alt }) => <ImagePlaceholder alt={alt} />,
};

export interface FileRefTarget {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * 行内代码像不像一个文件路径（`src/utils/date.ts`、`packages/a/b.tsx:12`、`./x.py:3-9`）。
 * 要求带目录和扩展名：`Date.UTC`、`a/b` 这类不算，免得把普通代码变成链接。
 */
export function parseFileRef(text: string): FileRefTarget | undefined {
  const match = /^((?:\.{1,2}\/|\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:-(\d+))?)?$/u.exec(text);
  if (!match?.[1]) return undefined;
  const startLine = match[2] ? Number(match[2]) : undefined;
  const endLine = match[3] ? Number(match[3]) : undefined;
  return { path: match[1], ...(startLine ? { startLine } : {}), ...(startLine && endLine && endLine >= startLine ? { endLine } : {}) };
}

/** 回复里提到的文件：点击在编辑器里打开；如果是 Markdown 文件，右侧附带面板内预览按钮。 */
function FileRef({ text, file }: { text: string; file: FileRefTarget }) {
  const t = useT();
  const isMd = /\.(?:md|markdown|mdx)$/iu.test(file.path);
  return (
    <span className="inline-flex items-center gap-0.5 align-baseline">
      <button
        type="button"
        className="inline-code inline-code--link"
        title={t('file.open', file.path)}
        onClick={() => postToHost({ type: 'openFile', payload: file })}
      >
        {text}
      </button>
      {isMd ? (
        <button
          type="button"
          className="inline-flex size-4.5 items-center justify-center rounded-[4px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-accent-ink"
          title={t('markdown.preview', file.path)}
          aria-label={t('markdown.preview', file.path)}
          data-testid={`preview-md-${file.path}`}
          onClick={() => requestMarkdownPreview(file.path)}
        >
          <EyeIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/** 不加载图片（CSP 也不允许外部图片），只显示占位文字。 */
function ImagePlaceholder({ alt }: { alt: string | undefined }) {
  const t = useT();
  return <span className="md-image-placeholder">{alt ? t('markdown.imageAlt', alt) : t('markdown.image')}</span>;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

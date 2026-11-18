import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

/**
 * 统一的终端与命令输出展示块：共用 `--font-mono`、`--terminal-font-size`、`--terminal-line-height`。
 */
export function TerminalBlock({
  text,
  className,
  ...props
}: HTMLAttributes<HTMLPreElement> & { readonly text: string }) {
  return (
    <pre
      className={cn(
        'terminal-surface m-0 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    >
      {text}
    </pre>
  );
}

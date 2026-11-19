import { useDeferredValue, useState } from 'react';
import { cn } from '../../lib/utils.ts';
import { CollapsibleDrawer, Shimmer } from '../beautifului/index.ts';
import { Markdown } from '../Markdown.tsx';
import { AssistantActions } from '../RunStatus.tsx';
import { ChevronDownIcon, SparkleIcon } from '../icons.tsx';
import { useT } from '../../i18n.ts';
import type { Of } from './types.ts';

export function AssistantMessage({ item, hideActions }: { item: Of<'assistant'>; hideActions?: boolean }) {
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

/** 对齐 Beautiful UI ThinkingState：星芒、流光标题、旋转箭头、垂直引导线 + CSS grid 平滑展开。 */
export function Reasoning({ text, active }: { text: string; active: boolean }) {
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
        <SparkleIcon
          width={15}
          height={15}
          fill="currentColor"
          stroke="none"
          className={cn('shrink-0', active ? 'text-ink-2' : 'text-ink-3')}
        />
        {active ? <Shimmer>{t('reasoning.active')}</Shimmer> : <span>{t('reasoning.done')}</span>}
        <ChevronDownIcon
 width={13}
 height={13}
 strokeWidth={2}
 className="text-ink-3 transition-transform duration-300"
 style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
 />
      </button>
      <CollapsibleDrawer open={open}>
          {open ? (
            <div className="reasoning__body mt-1 ml-[5px] border-l border-line py-1 pl-4 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
              {text}
            </div>
          ) : null}
      </CollapsibleDrawer>
    </div>
  );
}

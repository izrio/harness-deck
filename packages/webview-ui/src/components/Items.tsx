/**
 * 对话流条目（严格对齐 Beautiful UI：ChatComposer 气泡、ThinkingState 推理流、ToolChips 工具行、DiffTable 改动卡片）。
 */
import { memo } from 'react';
import type { Item } from '@harness-deck/shared';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { TurnDone } from './RunStatus.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import { ErrorIcon, GlobeIcon, InfoIcon, KeyIcon } from './icons.tsx';
import type { Of } from './items/types.ts';
import { UserBubble } from './items/UserBubble.tsx';
import { AssistantMessage } from './items/AssistantMessage.tsx';
import { ChangesCard } from './items/ChangesCard.tsx';
import { ActivityRow, EditRow, ExploreRow } from './items/ActivityRows.tsx';

export const ItemView = memo(function ItemView({
  item,
  hideAssistantActions = false,
  turnDoneCopyText,
}: {
  item: Item;
  hideAssistantActions?: boolean;
  turnDoneCopyText?: string;
}) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return <AssistantMessage item={item} hideActions={hideAssistantActions} />;
    case 'activity':
      if (item.variant === 'subagent' && item.subagent) return <SubagentRow item={item} />;
      return item.variant === 'edit' ? <EditRow item={item} /> : <ActivityRow item={item} />;
    case 'explore':
      return <ExploreRow item={item} />;
    case 'changes':
      return <ChangesCard item={item} />;
    case 'notice':
      return <Notice item={item} />;
    case 'turnDone':
      return <TurnDone item={item} {...(turnDoneCopyText !== undefined ? { copyText: turnDoneCopyText } : {})} />;
  }
});

function Notice({ item }: { item: Of<'notice'> }) {
  const tone =
    item.level === 'error'
      ? 'bg-red-tint text-red shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_28%,transparent)]'
      : item.level === 'warning'
        ? 'bg-orange-tint text-orange shadow-[0_0_0_1px_color-mix(in_srgb,var(--orange)_28%,transparent)]'
        : 'bg-surface text-ink-2 shadow-card';
  return (
    <div className={cn('notice flex items-start gap-2 rounded-card px-3 py-2 text-[12.5px]', `notice--${item.level}`, tone)} role={item.level === 'error' ? 'alert' : undefined}>
      {item.level === 'info' ? <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" /> : <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 leading-relaxed">
        {item.text}
        {item.action ? (
          <>
            {' '}
            <button
              type="button"
              className="link-button inline-flex items-center gap-1 font-medium text-accent-ink hover:underline"
              onClick={() => postToHost({ type: item.action?.kind ?? 'openWebUI', payload: {} })}
            >
              {item.action.kind === 'configureApiKey' ? <KeyIcon className="size-3" /> : <GlobeIcon className="size-3" />}
              {item.action.label}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

export { ChangedFileButton, Stats, openDiff, useDiffOpening } from './items/ChangesCard.tsx';

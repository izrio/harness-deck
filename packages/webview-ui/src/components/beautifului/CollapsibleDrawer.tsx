import type { ReactNode } from 'react';

/** 平滑折叠面板：用 `grid-template-rows` 0fr ↔ 1fr 做高度动画，内容只在展开时渲染（由调用方决定）。 */
export function CollapsibleDrawer({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-300"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
        transitionTimingFunction: 'var(--ease-out-strong)',
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

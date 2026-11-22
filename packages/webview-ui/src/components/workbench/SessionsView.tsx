/**
 * 工作台 · 会话主工作区（SessionsView）
 *
 * 承载标签栏、运行状态栏、对话消息流与输入框。
 * 左侧工作台导航与按项目分组的会话列表已提升至全局 WorkbenchSidebar，跨模块持久展示。
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.ts';

export function SessionsView({
  hidden,
  children,
}: {
  readonly hidden?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      id="workbench-panel-sessions"
      role="tabpanel"
      aria-labelledby="workbench-tab-sessions"
      data-testid="workbench-sessions"
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', hidden && 'hidden')}
      aria-hidden={hidden || undefined}
    >
      {children}
    </div>
  );
}

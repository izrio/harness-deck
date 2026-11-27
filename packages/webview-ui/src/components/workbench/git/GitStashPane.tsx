/**
 * Git 工作台 · 贮藏（Stash）子面板（Halo 语义主题样式 + 上下分栏检查）：
 * - 上半区为贮藏列表（默认选中首条，支持右键菜单 Pop / Apply / Drop）
 * - 可拖拽 1px 分割线 + 下半区为选中贮藏的变更文件清单（点击打开 Diff）与 Apply / Pop / Drop / 保存贮藏操作栏
 */
import { useEffect, useRef, useState } from 'react';
import type { SourceControlCommitFileView, SourceControlState, SourceControlStashView } from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { useView } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import { ArchiveIcon, CheckIcon, FileTypeIcon, RotateCcwIcon, SpinnerIcon, TrashIcon } from '../../icons.tsx';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/context-menu.tsx';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatIdeaDate, splitFilePath, STATUS_STYLE } from './gitHelpers.ts';

let stashReqSeq = 1;

export interface GitStashPaneProps {
  readonly state: SourceControlState;
  readonly busy: boolean;
  readonly remoteReadOnly: boolean;
  readonly onOpenStashSave: () => void;
  readonly onApplyStash: (index: number) => void;
  readonly onPopStash: (index: number) => void;
  readonly onDropStash: (stash: SourceControlStashView) => void;
  readonly onOpenStashFileDiff: (index: number, file: SourceControlCommitFileView) => void;
}

export function GitStashPane({
  state,
  busy,
  remoteReadOnly,
  onOpenStashSave,
  onApplyStash,
  onPopStash,
  onDropStash,
  onOpenStashFileDiff,
}: GitStashPaneProps) {
  const t = useT();
  const stashDetailResult = useView((s) => s.gitStashDetailResult);
  const stashes = state.stashes ?? [];

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [filesByIndex, setFilesByIndex] = useState<Record<number, readonly SourceControlCommitFileView[]>>({});
  const [loadingIndex, setLoadingIndex] = useState<number | null>(null);
  const [topHeight, setTopHeight] = useState(170);
  const [draggingSplit, setDraggingSplit] = useState(false);

  const pendingReqRef = useRef<{ reqId: number; index: number } | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const activeStash =
    stashes.find((s) => s.index === selectedIndex) ?? (stashes.length > 0 ? stashes[0] : undefined);
  const activeIdx = activeStash?.index;

  useEffect(() => {
    setFilesByIndex({});
  }, [state.updatedAt]);

  useEffect(() => {
    if (activeIdx === undefined) return;
    if (filesByIndex[activeIdx]) return;
    const reqId = ++stashReqSeq;
    pendingReqRef.current = { reqId, index: activeIdx };
    setLoadingIndex(activeIdx);
    postToHost({ type: 'sourceControlFetchStashDetail', payload: { requestId: reqId, index: activeIdx } });
  }, [activeIdx, filesByIndex]);

  useEffect(() => {
    const pending = pendingReqRef.current;
    if (!stashDetailResult || !pending || stashDetailResult.requestId !== pending.reqId) return;
    pendingReqRef.current = null;
    setLoadingIndex(null);
    setFilesByIndex((prev) => ({ ...prev, [stashDetailResult.index]: stashDetailResult.files }));
  }, [stashDetailResult]);

  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: topHeight };
    setDraggingSplit(true);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setTopHeight(Math.max(76, Math.min(360, d.startH + (ev.clientY - d.startY))));
    };
    const onUp = () => {
      dragRef.current = null;
      setDraggingSplit(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (stashes.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[12px] text-ink-3"
        data-testid="git-stash-pane"
      >
        <ArchiveIcon className="size-5 opacity-60" />
        <div>{t('wb.git.stashEmpty')}</div>
        {!remoteReadOnly && state.files.length > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-testid="git-stash-save-btn"
            disabled={busy}
            onClick={onOpenStashSave}
          >
            <ArchiveIcon className="size-3.5" />
            <span>{t('wb.git.stashSave')}</span>
          </Button>
        ) : null}
      </div>
    );
  }

  const activeFiles = activeIdx !== undefined ? filesByIndex[activeIdx] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="git-stash-pane">
      {/* 上半区：贮藏列表 */}
      <div className="flex shrink-0 flex-col overflow-hidden" style={{ height: `${topHeight}px` }}>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 py-1.5">
            {stashes.map((stash) => {
              const selected = activeIdx === stash.index;
              const tip = `${stash.ref}${stash.branch ? ` (${stash.branch})` : ''}${stash.date ? ` · ${formatIdeaDate(stash.date)}` : ''}`;
              return (
                <ContextMenu key={stash.ref}>
                  <ContextMenuTrigger asChild>
                    <div
                      data-testid={`git-stash-row-${stash.index}`}
                      className={cn(
                        'mx-1.5 flex h-7 cursor-pointer items-center gap-2 rounded-control px-2 text-[12px] transition-colors select-none',
                        selected
                          ? 'bg-surface text-ink shadow-hairline dark:bg-white/[0.08]'
                          : 'text-ink-2 hover:bg-hover/80 hover:text-ink',
                      )}
                      title={tip}
                      onClick={() => setSelectedIndex(stash.index)}
                    >
                      <span className="min-w-[16px] shrink-0 text-right font-mono text-[11px] text-ink-3 tabular-nums">
                        {stash.index}
                      </span>
                      <span className="max-w-[70%] shrink-0 truncate font-medium text-ink">{stash.message}</span>
                      {stash.branch ? (
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3">
                          {stash.branch}
                        </span>
                      ) : null}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    {!remoteReadOnly ? (
                      <>
                        <ContextMenuItem disabled={busy} onSelect={() => onPopStash(stash.index)}>
                          <RotateCcwIcon className="size-3.5" />
                          <span>{t('wb.git.stashPop')}</span>
                        </ContextMenuItem>
                        <ContextMenuItem disabled={busy} onSelect={() => onApplyStash(stash.index)}>
                          <CheckIcon className="size-3.5" />
                          <span>{t('wb.git.stashApply')}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          disabled={busy}
                          onSelect={() => onDropStash(stash)}
                        >
                          <TrashIcon className="size-3.5" />
                          <span>{t('wb.git.stashDrop')}</span>
                        </ContextMenuItem>
                      </>
                    ) : null}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* 可拖拽分割线 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={startSplitDrag}
        className={cn(
          'relative h-px shrink-0 cursor-row-resize bg-sidebar-border transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-brand',
          draggingSplit && 'bg-brand',
        )}
      />

      {/* 下半区：选中贮藏文件清单 + 操作栏 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-inset/30">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 py-1.5">
            {activeIdx !== undefined && loadingIndex === activeIdx ? (
              <div className="flex items-center justify-center gap-1.5 py-6 text-[11.5px] text-ink-3">
                <SpinnerIcon className="size-3.5" />
                <span>{t('wb.git.stashFilesLoading')}</span>
              </div>
            ) : activeFiles && activeFiles.length > 0 && activeIdx !== undefined ? (
              activeFiles.map((file) => {
                const { normalized, name, dir } = splitFilePath(file.path);
                const style = STATUS_STYLE[file.status];
                return (
                  <div
                    key={file.path}
                    data-testid={`git-stash-file-${activeIdx}-${normalized}`}
                    className="mx-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-control px-2 text-[11.5px] transition-colors select-none hover:bg-hover/80"
                    title={normalized}
                    onClick={() => onOpenStashFileDiff(activeIdx, file)}
                  >
                    <FileTypeIcon path={file.path} className="size-3.5 shrink-0" />
                    <span className={cn('max-w-[58%] shrink-0 truncate font-medium', style.nameCls)}>{name}</span>
                    {dir ? (
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3/85">{dir}</span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    <span
                      className={cn(
                        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-semibold',
                        style.badgeCls,
                      )}
                    >
                      {style.letter}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="py-6 text-center text-[11.5px] text-ink-3">{t('wb.git.stashNoFiles')}</div>
            )}
          </div>
        </ScrollArea>

        {!remoteReadOnly && activeStash ? (
          <div className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border/80 bg-inset/45 px-2.5 py-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid={`git-stash-apply-${activeStash.index}`}
              disabled={busy}
              onClick={() => onApplyStash(activeStash.index)}
            >
              {t('wb.git.stashApply')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid={`git-stash-pop-${activeStash.index}`}
              disabled={busy}
              onClick={() => onPopStash(activeStash.index)}
            >
              {t('wb.git.stashPop')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`git-stash-drop-${activeStash.index}`}
              disabled={busy}
              onClick={() => onDropStash(activeStash)}
              className="text-red hover:bg-red-tint hover:text-red"
            >
              {t('wb.git.stashDrop')}
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="git-stash-save-btn"
              disabled={busy || state.files.length === 0}
              onClick={onOpenStashSave}
              title={t('wb.git.stashSave')}
              aria-label={t('wb.git.stashSave')}
              className="text-ink-2 hover:bg-hover hover:text-ink"
            >
              <ArchiveIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

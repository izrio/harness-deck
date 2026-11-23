/**
 * 工作台 · Git 改动面板（ChangesView）
 *
 * 参考 IntelliJ IDEA Git / Commit 工具窗口的紧凑图标化布局：
 * - 顶部单行图标工具栏：分支与增删统计 + 刷新 / 按目录分组 / 仅看本会话改动 / 创建 PR 图标操作
 * - 中部可折叠变更列表（已暂存 / 更改 / 未跟踪）：支持按目录树分组或 IDEA 风格「文件名 + 淡化目录路径」，按状态着色
 * - 底部固定提交区：多行提交信息输入（支持 Ctrl/Cmd+Enter）+ 提交与推送操作
 * 推送与创建 PR 均需二次确认，不做 force push，不切换分支，不保存任何 token（HD-09 / HD-10）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveTurns, type SourceControlFileView } from '@harness-deck/shared';
import { useIsMobile } from '../../hooks/use-mobile.ts';
import type { MessageKey } from '../../i18n.ts';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setRightPanelOpen, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTypeIcon,
  FilterIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  ListIcon,
  RefreshIcon,
  UploadIcon,
  VscodeFolderIcon,
  VscodeFolderOpenIcon,
} from '../icons.tsx';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function post(message: Parameters<typeof postToHost>[0]): void {
  postToHost(message);
}

const STATUS_STYLE: Record<
  SourceControlFileView['status'],
  { readonly letter: string; readonly nameCls: string; readonly badgeCls: string }
> = {
  modified: { letter: 'M', nameCls: 'text-accent-ink', badgeCls: 'text-accent-ink' },
  added: { letter: 'A', nameCls: 'text-green', badgeCls: 'text-green' },
  deleted: { letter: 'D', nameCls: 'text-ink-3 line-through', badgeCls: 'text-red' },
  renamed: { letter: 'R', nameCls: 'text-accent-ink', badgeCls: 'text-accent-ink' },
  untracked: { letter: 'U', nameCls: 'text-orange', badgeCls: 'text-orange' },
  conflicted: { letter: '!', nameCls: 'text-red', badgeCls: 'text-red' },
};

function splitFilePath(rawPath: string): { readonly normalized: string; readonly name: string; readonly dir: string } {
  const normalized = rawPath.replace(/\\/gu, '/');
  const slash = normalized.lastIndexOf('/');
  return {
    normalized,
    name: slash >= 0 ? normalized.slice(slash + 1) : normalized,
    dir: slash >= 0 ? normalized.slice(0, slash) : '',
  };
}

interface ChangeGroup {
  readonly id: 'staged' | 'changes' | 'untracked';
  readonly labelKey: MessageKey;
  readonly files: readonly SourceControlFileView[];
}

export function ChangesView({ compact = false }: { readonly compact?: boolean } = {}) {
  const t = useT();
  const isMobile = useIsMobile();
  const state = useView((s) => s.workbench.sourceControl);
  const session = useView((s) => s.session);
  const items = useView((s) => s.items);
  const activeDiffPath = useView((s) =>
    s.diffContent && s.diffContent.kind !== 'file' ? s.diffContent.path.replace(/\\/gu, '/') : undefined,
  );
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');
  const [commitMessage, setCommitMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);
  const [sessionOnly, setSessionOnly] = useState(false);
  const [groupByDir, setGroupByDir] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const lastActionAtRef = useRef<number | undefined>(undefined);

  const sessionPaths = useMemo(() => {
    const turns = session.turns ?? deriveTurns(items, session.running);
    const set = new Set<string>();
    for (const turn of turns) {
      for (const path of turn.authoredPaths) set.add(path.replace(/\\/gu, '/'));
    }
    return set;
  }, [session.turns, items, session.running]);

  const refresh = (): void => {
    setBusy(true);
    post({ type: 'refreshSourceControl', payload: {} });
  };

  useEffect(() => {
    refresh();
  }, []);

  // 宿主每次刷新（含 commit / push / pr 完成或失败）都会更新 updatedAt：解除本地忙碌状态，并根据 lastAction 决定清空或保留草稿。
  useEffect(() => {
    setBusy(false);
    const action = state?.lastAction;
    if (!action || action.at === lastActionAtRef.current) return;
    lastActionAtRef.current = action.at;
    if (action.kind === 'commit' && action.ok) {
      setCommitMessage('');
    } else if (action.kind === 'pr' && action.ok) {
      setPrOpen(false);
      setPrTitle('');
      setPrBody('');
    }
  }, [state?.updatedAt, state?.lastAction]);

  const hasStaged = Boolean(state?.files.some((file) => file.staged));
  const hasUnstaged = Boolean(state?.files.some((file) => !file.staged));
  const showStageToggle = hasStaged && hasUnstaged;

  const visibleFiles = useMemo(() => {
    const files = state?.files ?? [];
    if (!sessionOnly || sessionPaths.size === 0) return files;
    return files.filter((file) => {
      const normalized = file.path.replace(/\\/gu, '/');
      for (const authored of sessionPaths) {
        if (normalized === authored || normalized.endsWith(`/${authored}`) || authored.endsWith(`/${normalized}`)) {
          return true;
        }
      }
      return false;
    });
  }, [state?.files, sessionOnly, sessionPaths]);

  const groups = useMemo<readonly ChangeGroup[]>(() => {
    const staged: SourceControlFileView[] = [];
    const changes: SourceControlFileView[] = [];
    const untracked: SourceControlFileView[] = [];
    for (const file of visibleFiles) {
      if (file.staged) staged.push(file);
      else if (file.status === 'untracked') untracked.push(file);
      else changes.push(file);
    }
    const list: ChangeGroup[] = [];
    if (staged.length > 0) list.push({ id: 'staged', labelKey: 'wb.changes.groupStaged', files: staged });
    if (changes.length > 0) list.push({ id: 'changes', labelKey: 'wb.changes.groupChanges', files: changes });
    if (untracked.length > 0) list.push({ id: 'untracked', labelKey: 'wb.changes.groupUntracked', files: untracked });
    return list;
  }, [visibleFiles]);

  const commit = (): void => {
    if (!commitMessage.trim() || busy || remoteReadOnly || !state?.available || state.files.length === 0) return;
    setBusy(true);
    post({
      type: 'sourceControlCommit',
      payload: { message: commitMessage.trim(), stageAll: showStageToggle ? stageAll : true },
    });
  };

  const confirmPush = (): void => {
    setPushOpen(false);
    setBusy(true);
    post({ type: 'sourceControlPush', payload: {} });
  };

  const openPr = (): void => {
    // 保留未提交成功时的草稿；仅当标题为空时填充默认建议
    if (!prTitle.trim()) {
      setPrTitle(commitMessage.trim().split('\n')[0] || session.title || state?.branch || '');
    }
    setPrOpen(true);
  };

  const createPr = (): void => {
    if (!prTitle.trim()) return;
    setBusy(true);
    // 失败时弹窗保持打开并保留草稿；成功后由 lastAction 统一关闭并清空
    post({ type: 'sourceControlCreatePr', payload: { title: prTitle.trim(), body: prBody } });
  };

  const openDiff = (file: SourceControlFileView): void => {
    post({ type: 'openSourceControlDiff', payload: { path: file.path, staged: file.staged } });
    if (isMobile) setRightPanelOpen(false);
  };

  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleDir = (key: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const branchTooltip = [
    `${t('wb.changes.branch')}: ${state?.branch ?? 'HEAD'}`,
    state?.remote ? `${t('wb.changes.remote')}: ${state.remote}` : '',
    state?.gh
      ? state.gh.authenticated
        ? t('wb.changes.ghReady')
        : state.gh.installed
          ? t('wb.changes.ghLoginNeeded')
          : t('wb.changes.ghMissing')
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prTitleTooltip = state?.gh
    ? `${t('wb.changes.createPr')} (${
        state.gh.authenticated
          ? t('wb.changes.ghReady')
          : state.gh.installed
            ? t('wb.changes.ghLoginNeeded')
            : t('wb.changes.ghMissing')
      })`
    : t('wb.changes.createPr');

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', !compact && 'bg-canvas')}
      data-testid="workbench-changes"
    >
      {/* 顶部单行 IDEA 风格工具栏：分支/统计 + 图标操作 */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-1.5 border-b border-sidebar-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5" title={branchTooltip}>
          <GitBranchIcon className="size-3.5 shrink-0 text-accent-ink" />
          <span className="truncate text-[12px] font-medium text-ink">
            {state?.available ? (state.branch ?? 'HEAD') : t('wb.changes.title')}
          </span>
          {state?.available && (state.additions > 0 || state.deletions > 0) ? (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
              {state.additions > 0 ? <span className="text-green">+{state.additions}</span> : null}
              {state.deletions > 0 ? <span className="text-red">−{state.deletions}</span> : null}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={refresh}
            disabled={busy}
            aria-label={t('wb.changes.refresh')}
            title={t('wb.changes.refresh')}
            className="text-ink-2 hover:bg-hover hover:text-ink"
          >
            <RefreshIcon className={cn('size-3.5', busy && 'spin')} />
          </Button>
          {state?.available ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="changes-group-toggle"
                aria-label={groupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
                title={groupByDir ? t('wb.changes.flatList') : t('wb.changes.groupByDir')}
                aria-pressed={groupByDir}
                onClick={() => setGroupByDir((v) => !v)}
                className={cn(
                  'text-ink-2 hover:bg-hover hover:text-ink',
                  groupByDir && 'bg-hover text-ink',
                )}
              >
                {groupByDir ? <ListIcon className="size-3.5" /> : <FolderTreeIcon className="size-3.5" />}
              </Button>
              {sessionPaths.size > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="changes-session-filter"
                  aria-label={t('wb.changes.sessionOnly', sessionPaths.size)}
                  title={t('wb.changes.sessionOnly', sessionPaths.size)}
                  aria-pressed={sessionOnly}
                  onClick={() => setSessionOnly((v) => !v)}
                  className={cn(
                    'text-ink-2 hover:bg-hover hover:text-ink',
                    sessionOnly && 'bg-accent-tint text-accent-ink hover:bg-accent-tint',
                  )}
                >
                  <FilterIcon className="size-3.5" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="changes-pr-btn"
                aria-label={t('wb.changes.createPr')}
                title={prTitleTooltip}
                onClick={openPr}
                disabled={busy || remoteReadOnly || !state.remote}
                className="text-ink-2 hover:bg-hover hover:text-ink"
              >
                <GitPullRequestIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* 中部可滚动变更树/列表 */}
      {!state ? (
        <div className="flex flex-1 items-center justify-center px-3 py-6 text-[12px] text-ink-3">
          {t('wb.changes.refreshing')}
        </div>
      ) : !state.available ? (
        <div className="flex flex-1 items-center justify-center px-3 py-6 text-center text-[12px] text-ink-3">
          {state.error ? t('wb.changes.error', state.error) : t('wb.changes.notRepo')}
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1.5">
            {visibleFiles.length === 0 ? (
              <div className="px-2 py-8 text-center text-[12px] text-ink-3">{t('wb.changes.empty')}</div>
            ) : (
              <div className="flex flex-col gap-1" data-testid="changes-list">
                {groups.map((group) => {
                  const collapsed = Boolean(collapsedGroups[group.id]);
                  return (
                    <section key={group.id} className="flex flex-col" data-testid={`changes-group-${group.id}`}>
                      <button
                        type="button"
                        aria-expanded={!collapsed}
                        onClick={() => toggleGroup(group.id)}
                        className="flex w-full items-center gap-1 rounded-control px-1.5 py-1 text-left text-[11.5px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
                      >
                        {collapsed ? (
                          <ChevronRightIcon className="size-3 shrink-0 text-ink-3" />
                        ) : (
                          <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                        )}
                        <span className="truncate">{t(group.labelKey)}</span>
                        <span className="font-mono text-[11px] font-normal text-ink-3 tabular-nums">
                          {group.files.length}
                        </span>
                      </button>

                      {!collapsed ? (
                        groupByDir ? (
                          <DirectoryGroupedFiles
                            groupId={group.id}
                            files={group.files}
                            activeDiffPath={activeDiffPath}
                            collapsedDirs={collapsedDirs}
                            onToggleDir={toggleDir}
                            onOpenDiff={openDiff}
                          />
                        ) : (
                          <div className="flex flex-col gap-0.5 pl-2">
                            {group.files.map((file) => (
                              <ChangeFileRow
                                key={file.path}
                                file={file}
                                showDir
                                activeDiffPath={activeDiffPath}
                                onOpenDiff={openDiff}
                              />
                            ))}
                          </div>
                        )
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}

            {state.truncated ? (
              <p className="mt-2 mb-0 px-2 text-[11px] text-ink-3">{t('wb.changes.truncated', 500)}</p>
            ) : null}
            {state.error ? (
              <p className="mt-2 mb-0 px-2 text-[11px] text-red">{t('wb.changes.error', state.error)}</p>
            ) : null}
          </div>

          {/* 底部固定 IDEA 风格 Commit 区 */}
          <div className="flex shrink-0 flex-col gap-2 border-t border-sidebar-border bg-sidebar px-2.5 py-2">
            <Textarea
              rows={3}
              className="min-h-16 resize-none bg-surface/90 text-[12px] leading-snug"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                }
              }}
              placeholder={t('wb.changes.commitPlaceholder')}
              aria-label={t('wb.changes.commitPlaceholder')}
              disabled={busy || remoteReadOnly || state.files.length === 0}
            />
            <div className="flex items-center justify-between gap-2">
              {showStageToggle ? (
                <label
                  className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-ink-2"
                  title={t('wb.changes.stageAll')}
                >
                  <Checkbox checked={stageAll} onCheckedChange={(checked) => setStageAll(checked === true)} />
                  <span className="truncate">{t('wb.changes.stageAll')}</span>
                </label>
              ) : (
                <span className="truncate text-[11px] text-ink-3 tabular-nums">
                  {t('wb.changes.fileCount', visibleFiles.length)}
                </span>
              )}

              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  onClick={commit}
                  disabled={busy || remoteReadOnly || !commitMessage.trim() || state.files.length === 0}
                >
                  <GitCommitIcon className="size-3.5" />
                  <span>{t('wb.changes.commit')}</span>
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  data-testid="changes-push-btn"
                  aria-label={t('wb.changes.push')}
                  title={t('wb.changes.push')}
                  onClick={() => setPushOpen(true)}
                  disabled={busy || remoteReadOnly || !state.remote}
                >
                  <UploadIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      <Dialog open={pushOpen} onOpenChange={setPushOpen}>
        <DialogContent data-testid="changes-push-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.pushConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('wb.changes.pushConfirmDetail', state?.branch ?? 'HEAD', state?.remote ?? 'origin')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setPushOpen(false)}>
              {t('wb.changes.cancel')}
            </Button>
            <Button type="button" size="sm" data-testid="changes-push-confirm" onClick={confirmPush}>
              <UploadIcon className="size-3.5" />
              <span>{t('wb.changes.push')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={prOpen} onOpenChange={setPrOpen}>
        <DialogContent data-testid="changes-pr-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.prTitle')}</DialogTitle>
            <DialogDescription>{t('wb.changes.prHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pr-title">{t('wb.changes.prTitleLabel')}</Label>
            <Input id="pr-title" size="sm" value={prTitle} onChange={(event) => setPrTitle(event.target.value)} disabled={busy} />
            <Label htmlFor="pr-body">{t('wb.changes.prBodyLabel')}</Label>
            <Textarea id="pr-body" value={prBody} onChange={(event) => setPrBody(event.target.value)} rows={5} disabled={busy} />
            {state?.lastAction?.kind === 'pr' && !state.lastAction.ok && state.lastAction.message ? (
              <p className="m-0 text-[11.5px] text-red">{state.lastAction.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrOpen(false)} disabled={busy}>
              {t('wb.changes.cancel')}
            </Button>
            <Button type="button" size="sm" data-testid="changes-pr-confirm" onClick={createPr} disabled={busy || !prTitle.trim()}>
              <GitPullRequestIcon className="size-3.5" />
              <span>{t('wb.changes.confirmPr')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChangeFileRow({
  file,
  showDir,
  activeDiffPath,
  onOpenDiff,
}: {
  readonly file: SourceControlFileView;
  readonly showDir: boolean;
  readonly activeDiffPath?: string;
  readonly onOpenDiff: (file: SourceControlFileView) => void;
}) {
  const t = useT();
  const { normalized, name, dir } = splitFilePath(file.path);
  const style = STATUS_STYLE[file.status];
  const isSelected = activeDiffPath === normalized;
  const statusLabel = t(`wb.changes.status.${file.status}` as MessageKey);

  return (
    <button
      type="button"
      data-testid={`changes-file-${normalized}`}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left transition-colors duration-100 hover:bg-hover',
        isSelected && 'bg-hover',
      )}
      onClick={() => onOpenDiff(file)}
      title={`${normalized} (${statusLabel})`}
    >
      <FileTypeIcon path={file.path} className="size-4 shrink-0" />
      <span className={cn('shrink-0 truncate text-[12px] font-medium', showDir ? 'max-w-[55%]' : 'min-w-0 flex-1', style.nameCls)}>
        {name}
      </span>
      {showDir && dir ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">{dir}</span>
      ) : (
        <span className="flex-1" />
      )}
      {file.additions !== undefined && file.additions > 0 ? (
        <span className="shrink-0 font-mono text-[10.5px] text-green tabular-nums">+{file.additions}</span>
      ) : null}
      {file.deletions !== undefined && file.deletions > 0 ? (
        <span className="shrink-0 font-mono text-[10.5px] text-red tabular-nums">−{file.deletions}</span>
      ) : null}
      <span
        className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', style.badgeCls)}
        aria-label={statusLabel}
      >
        {style.letter}
      </span>
    </button>
  );
}

function DirectoryGroupedFiles({
  groupId,
  files,
  activeDiffPath,
  collapsedDirs,
  onToggleDir,
  onOpenDiff,
}: {
  readonly groupId: string;
  readonly files: readonly SourceControlFileView[];
  readonly activeDiffPath?: string;
  readonly collapsedDirs: Readonly<Record<string, boolean>>;
  readonly onToggleDir: (key: string) => void;
  readonly onOpenDiff: (file: SourceControlFileView) => void;
}) {
  const buckets = useMemo(() => {
    const byDir = new Map<string, SourceControlFileView[]>();
    for (const file of files) {
      const { dir } = splitFilePath(file.path);
      const list = byDir.get(dir) ?? [];
      list.push(file);
      byDir.set(dir, list);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  return (
    <div className="flex flex-col gap-0.5 pl-2" data-testid={`changes-dir-tree-${groupId}`}>
      {buckets.map(([dir, dirFiles]) => {
        if (!dir) {
          return dirFiles.map((file) => (
            <ChangeFileRow
              key={file.path}
              file={file}
              showDir={false}
              activeDiffPath={activeDiffPath}
              onOpenDiff={onOpenDiff}
            />
          ));
        }
        const key = `${groupId}:${dir}`;
        const collapsed = Boolean(collapsedDirs[key]);
        return (
          <div key={key} className="flex flex-col">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => onToggleDir(key)}
              title={dir}
              className="flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-[11.5px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
            >
              {collapsed ? (
                <ChevronRightIcon className="size-3 shrink-0 text-ink-3" />
              ) : (
                <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
              )}
              {collapsed ? (
                <VscodeFolderIcon className="size-4 shrink-0" />
              ) : (
                <VscodeFolderOpenIcon className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{dir}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-3 tabular-nums">{dirFiles.length}</span>
            </button>
            {!collapsed ? (
              <div className="flex flex-col gap-0.5 pl-4">
                {dirFiles.map((file) => (
                  <ChangeFileRow
                    key={file.path}
                    file={file}
                    showDir={false}
                    activeDiffPath={activeDiffPath}
                    onOpenDiff={onOpenDiff}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 工作台 · Git 统一工作台（GitWorkbench，借鉴 IntelliJ IDEA / vs-idea-gittool）：
 * - 顶部单行 IDEA 工具栏：分支快速切换 Popover（搜索 + 本地/远程分支 + 新建/删除）+ 领先/落后（↑N ↓M）+ 增删统计 + 拉取/抓取/刷新/PR
 * - PR 状态追踪与一键结单横幅
 * - 四大功能子标签页：
 *   1. 提交（Commit）：IDEA 风格勾选提交、Amend、提交并推送、AI 生成、进行中操作与冲突解决、平铺/目录树与右键菜单
 *   2. 历史（Log）：SVG 多泳道 DAG 提交图谱、关键字/分支过滤、提交详情与历史文件 Diff、Cherry-pick / Revert / Reset
 *   3. 分支（Branches）：本地/远程/标签分组树、领先/落后计数、检出 / 合并 / 变基 / 重命名 / 删除
 *   4. 贮藏（Stash）：保存贮藏、展开查看文件 Diff、Pop / Apply / Drop
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveTurns,
  type SourceControlCommitFileView,
  type SourceControlFileView,
  type SourceControlStashView,
} from '@harness-deck/shared';
import { useIsMobile } from '../../../hooks/use-mobile.ts';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { setRightPanelOpen, useView } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  HistoryIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SparklesIcon,
  SpinnerIcon,
  TrashIcon,
  UploadIcon,
} from '../../icons.tsx';
import { DeleteBranchDialog } from '../../DeleteBranchDialog.tsx';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { GitBranchesPane } from './GitBranchesPane.tsx';
import { GitCommitPane } from './GitCommitPane.tsx';
import { GitLogPane } from './GitLogPane.tsx';
import { GitStashPane } from './GitStashPane.tsx';

type GitSubTab = 'commit' | 'log' | 'branches' | 'stash';

function post(message: Parameters<typeof postToHost>[0]): void {
  postToHost(message);
}

let draftRequestSeq = 1;

export function GitWorkbench({ compact = false }: { readonly compact?: boolean } = {}) {
  const t = useT();
  const isMobile = useIsMobile();
  const state = useView((s) => s.workbench.sourceControl);
  const session = useView((s) => s.session);
  const items = useView((s) => s.items);
  const draftResult = useView((s) => s.draftGeneratedResult);
  const activeDiffPath = useView((s) =>
    s.diffContent && s.diffContent.kind !== 'file' ? s.diffContent.path.replace(/\\/gu, '/') : undefined,
  );
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');

  const [subTab, setSubTab] = useState<GitSubTab>('commit');
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generatingCommit, setGeneratingCommit] = useState(false);
  const [generatingPr, setGeneratingPr] = useState(false);

  // 分支快捷 Popover 状态
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [newBranchName, setNewBranchName] = useState('');

  // 各类弹窗状态
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<string | null>(null);
  const [renameBranchTarget, setRenameBranchTarget] = useState<string | null>(null);
  const [renameBranchValue, setRenameBranchValue] = useState('');
  const [newBranchFromTarget, setNewBranchFromTarget] = useState<string | null>(null);
  const [newBranchFromValue, setNewBranchFromValue] = useState('');
  const [pushOpen, setPushOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [discardTarget, setDiscardTarget] = useState<SourceControlFileView | null>(null);
  const [discardAllOpen, setDiscardAllOpen] = useState(false);
  const [resetHardTarget, setResetHardTarget] = useState<string | null>(null);
  const [stashSaveOpen, setStashSaveOpen] = useState(false);
  const [stashMessage, setStashMessage] = useState('');
  const [stashIncludeUntracked, setStashIncludeUntracked] = useState(true);
  const [stashPaths, setStashPaths] = useState<readonly string[] | undefined>(undefined);
  const [stashDropTarget, setStashDropTarget] = useState<SourceControlStashView | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settleRemoveWorktree, setSettleRemoveWorktree] = useState(false);

  const lastActionAtRef = useRef<number | undefined>(undefined);
  const pendingCommitReqRef = useRef<number | undefined>(undefined);
  const pendingPrReqRef = useRef<number | undefined>(undefined);

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

  useEffect(() => {
    setBusy(false);
    const action = state?.lastAction;
    if (!action || action.at === lastActionAtRef.current) return;
    lastActionAtRef.current = action.at;
    if ((action.kind === 'commit' || action.kind === 'commitAndPush' || action.kind === 'amend') && action.ok) {
      setCommitMessage('');
      setAmend(false);
    } else if (action.kind === 'pr' && action.ok) {
      setPrOpen(false);
      setPrTitle('');
      setPrBody('');
    } else if ((action.kind === 'checkout' || action.kind === 'branch' || action.kind === 'renameBranch') && action.ok) {
      setBranchPopoverOpen(false);
      setNewBranchName('');
      setBranchFilter('');
      setRenameBranchTarget(null);
      setRenameBranchValue('');
      setNewBranchFromTarget(null);
      setNewBranchFromValue('');
    } else if (action.kind === 'stashSave' && action.ok) {
      setStashSaveOpen(false);
      setStashMessage('');
      setStashPaths(undefined);
    } else if (action.kind === 'settle' && action.ok) {
      setSettleOpen(false);
    }
  }, [state?.updatedAt, state?.lastAction]);

  // 接收 AI / 启发式生成的 Commit Message 或 PR 草稿
  useEffect(() => {
    if (!draftResult) return;
    if (draftResult.kind === 'commit' && draftResult.requestId === pendingCommitReqRef.current) {
      pendingCommitReqRef.current = undefined;
      setGeneratingCommit(false);
      if (draftResult.message) setCommitMessage(draftResult.message);
    } else if (draftResult.kind === 'pr' && draftResult.requestId === pendingPrReqRef.current) {
      pendingPrReqRef.current = undefined;
      setGeneratingPr(false);
      if (draftResult.title) setPrTitle(draftResult.title);
      if (draftResult.body) setPrBody(draftResult.body);
    }
  }, [draftResult]);

  // ── 动作派发 ──
  const runCommit = (options: { readonly files?: readonly string[]; readonly amend: boolean; readonly push: boolean }) => {
    if (!commitMessage.trim() || busy || remoteReadOnly || !state?.available) return;
    setBusy(true);
    post({
      type: 'sourceControlCommit',
      payload: {
        message: commitMessage.trim(),
        ...(options.files ? { files: [...options.files] } : { stageAll: true }),
        ...(options.amend ? { amend: true } : {}),
        ...(options.push ? { push: true } : {}),
      },
    });
  };

  const confirmPush = (): void => {
    setPushOpen(false);
    setBusy(true);
    post({ type: 'sourceControlPush', payload: {} });
  };

  const openPr = (): void => {
    if (!prTitle.trim()) {
      setPrTitle(commitMessage.trim().split('\n')[0] || session.title || state?.branch || '');
    }
    setPrOpen(true);
  };

  const createPr = (): void => {
    if (!prTitle.trim()) return;
    setBusy(true);
    post({ type: 'sourceControlCreatePr', payload: { title: prTitle.trim(), body: prBody } });
  };

  const requestAiCommit = (): void => {
    if (generatingCommit || busy || remoteReadOnly || !state?.available || state.files.length === 0) return;
    const reqId = ++draftRequestSeq;
    pendingCommitReqRef.current = reqId;
    setGeneratingCommit(true);
    post({ type: 'sourceControlGenerateCommitMessage', payload: { requestId: reqId } });
  };

  const requestAiPr = (): void => {
    if (generatingPr || busy || remoteReadOnly) return;
    const reqId = ++draftRequestSeq;
    pendingPrReqRef.current = reqId;
    setGeneratingPr(true);
    post({ type: 'sourceControlGeneratePrDraft', payload: { requestId: reqId } });
  };

  const stageOne = (file: SourceControlFileView): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlStageFile', payload: { path: file.path } });
  };

  const unstageOne = (file: SourceControlFileView): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlUnstageFile', payload: { path: file.path } });
  };

  const stageAll = (): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlStageAll', payload: {} });
  };

  const unstageAll = (): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlUnstageAll', payload: {} });
  };

  const confirmDiscard = (): void => {
    if (!discardTarget) return;
    const target = discardTarget;
    setDiscardTarget(null);
    setBusy(true);
    post({
      type: 'sourceControlDiscardFile',
      payload: { path: target.path, untracked: target.status === 'untracked', confirmed: true },
    });
  };

  const confirmDiscardAll = (): void => {
    setDiscardAllOpen(false);
    setBusy(true);
    post({ type: 'sourceControlDiscardAll', payload: { confirmed: true } });
  };

  const checkoutBranch = (branch: string): void => {
    if (busy || remoteReadOnly || branch === state?.branch) return;
    setBusy(true);
    post({ type: 'sourceControlCheckoutBranch', payload: { branch } });
  };

  const createNewBranch = (name?: string, startPoint?: string): void => {
    const trimmed = (name ?? newBranchName).trim();
    if (!trimmed || busy || remoteReadOnly) return;
    setBusy(true);
    post({
      type: 'sourceControlCreateBranch',
      payload: { branch: trimmed, ...(startPoint ? { startPoint } : {}) },
    });
  };

  const confirmRenameBranch = (): void => {
    const oldName = renameBranchTarget?.trim();
    const newName = renameBranchValue.trim();
    if (!oldName || !newName || oldName === newName || busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlRenameBranch', payload: { oldName, newName } });
  };

  const requestDeleteBranch = (branch: string): void => {
    if (busy || remoteReadOnly || branch === state?.branch) return;
    setBranchPopoverOpen(false);
    setDeleteBranchTarget(branch);
  };

  const confirmDeleteBranch = (branch: string, force: boolean): void => {
    if (busy || remoteReadOnly || branch === state?.branch) return;
    setDeleteBranchTarget(null);
    setBusy(true);
    post({
      type: 'sourceControlDeleteBranch',
      payload: { branch, force, confirmed: true },
    });
  };

  const mergeBranch = (branch: string): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlMergeBranch', payload: { branch } });
  };

  const rebaseBranch = (branch: string): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlRebaseBranch', payload: { branch } });
  };

  const cherryPick = (hash: string): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlCherryPick', payload: { hash } });
  };

  const revertCommit = (hash: string): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlRevertCommit', payload: { hash } });
  };

  const resetCommit = (hash: string, mode: 'soft' | 'mixed' | 'hard'): void => {
    if (busy || remoteReadOnly) return;
    if (mode === 'hard') {
      setResetHardTarget(hash);
      return;
    }
    setBusy(true);
    post({ type: 'sourceControlResetToCommit', payload: { hash, mode } });
  };

  const confirmHardReset = (): void => {
    if (!resetHardTarget) return;
    const hash = resetHardTarget;
    setResetHardTarget(null);
    setBusy(true);
    post({ type: 'sourceControlResetToCommit', payload: { hash, mode: 'hard', confirmed: true } });
  };

  const openStashSave = (paths?: readonly string[]): void => {
    setStashPaths(paths);
    setStashMessage('');
    setStashIncludeUntracked(true);
    setStashSaveOpen(true);
  };

  const confirmStashSave = (): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({
      type: 'sourceControlStashSave',
      payload: {
        ...(stashMessage.trim() ? { message: stashMessage.trim() } : {}),
        includeUntracked: stashIncludeUntracked,
        ...(stashPaths && stashPaths.length > 0 ? { paths: [...stashPaths] } : {}),
      },
    });
  };

  const applyStash = (index: number): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlStashApply', payload: { index } });
  };

  const popStash = (index: number): void => {
    if (busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlStashPop', payload: { index } });
  };

  const confirmDropStash = (): void => {
    if (!stashDropTarget) return;
    const idx = stashDropTarget.index;
    setStashDropTarget(null);
    setBusy(true);
    post({ type: 'sourceControlStashDrop', payload: { index: idx, confirmed: true } });
  };

  const openDiff = (file: SourceControlFileView): void => {
    post({ type: 'openSourceControlDiff', payload: { path: file.path, staged: file.staged } });
    if (isMobile) setRightPanelOpen(false);
  };

  const openCommitFileDiff = (hash: string, file: SourceControlCommitFileView): void => {
    post({
      type: 'sourceControlOpenCommitFileDiff',
      payload: { hash, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) },
    });
    if (isMobile) setRightPanelOpen(false);
  };

  const openStashFileDiff = (index: number, path: string): void => {
    post({ type: 'sourceControlOpenStashFileDiff', payload: { index, path } });
    if (isMobile) setRightPanelOpen(false);
  };

  const filteredPopoverLocalBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    return (state?.branches ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  }, [state?.branches, branchFilter]);

  const filteredPopoverRemoteBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    return (state?.remoteBranches ?? []).filter((b) => !q || b.toLowerCase().includes(q));
  }, [state?.remoteBranches, branchFilter]);

  const branchTooltip = [
    `${t('wb.changes.branch')}: ${state?.branch ?? 'HEAD'}`,
    state?.upstream ? `Upstream: ${state.upstream}` : '',
    state?.ahead ? t('wb.git.ahead', state.ahead) : '',
    state?.behind ? t('wb.git.behind', state.behind) : '',
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

  const pr = state?.pr;
  const stashCount = state?.stashes?.length ?? 0;

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', !compact && 'bg-canvas')}
      data-testid="workbench-changes"
    >
      {/* 顶部单行工具栏：分支快速切换 + 领先/落后 + 增删统计 + 拉取/刷新/PR */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-1.5 border-b border-sidebar-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5" title={branchTooltip}>
          {state?.available && !remoteReadOnly ? (
            <Popover open={branchPopoverOpen} onOpenChange={setBranchPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="changes-branch-trigger"
                  className="min-w-0 max-w-[168px] gap-1.5 px-2 font-mono text-[11.5px] leading-4 font-medium text-ink hover:bg-hover"
                >
                  <GitBranchIcon className="size-3.5 shrink-0 text-accent-ink" />
                  <span className="min-w-0 truncate leading-4">{state.branch ?? 'HEAD'}</span>
                  <ChevronDownIcon className="-ml-0.5 size-3 shrink-0 text-ink-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-72 max-w-[calc(100vw-24px)] overflow-hidden p-1.5">
                <div className="mb-1 flex items-center justify-between gap-2 px-1.5 pt-0.5">
                  <span className="truncate text-[11px] font-medium text-ink-3">{t('wb.changes.switchBranch')}</span>
                  {state.remote ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      className="shrink-0 text-ink-2 hover:text-ink"
                      onClick={() => {
                        setBranchPopoverOpen(false);
                        setBusy(true);
                        post({ type: 'sourceControlFetch', payload: {} });
                      }}
                    >
                      <RefreshIcon className="size-3" />
                      <span>{t('wb.changes.fetch')}</span>
                    </Button>
                  ) : null}
                </div>
                {(state.branches?.length ?? 0) + (state.remoteBranches?.length ?? 0) > 6 ? (
                  <div className="relative mb-1.5 px-0.5">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-ink-3" />
                    <Input
                      size="xs"
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                      placeholder={t('wb.git.branchesSearchPlaceholder')}
                      className="pl-6"
                    />
                  </div>
                ) : null}
                <ScrollArea className="max-h-56">
                  <div className="flex flex-col gap-0.5">
                    {filteredPopoverLocalBranches.map((b) => {
                      const current = b === state.branch;
                      if (current) {
                        return (
                          <button
                            key={b}
                            type="button"
                            data-testid={`changes-branch-item-${b}`}
                            disabled={busy}
                            onClick={() => checkoutBranch(b)}
                            className="flex w-full items-center justify-between gap-2 rounded-control bg-field px-2 py-1.5 text-left text-[12px] leading-4 font-medium text-ink transition-colors hover:bg-hover"
                          >
                            <span className="truncate font-mono text-[11.5px] leading-4">{b}</span>
                            <CheckIcon className="size-3.5 shrink-0 text-accent-ink" />
                          </button>
                        );
                      }
                      return (
                        <div
                          key={b}
                          className="group/branch flex items-center gap-0.5 rounded-control transition-colors hover:bg-hover"
                        >
                          <button
                            type="button"
                            data-testid={`changes-branch-item-${b}`}
                            disabled={busy}
                            onClick={() => checkoutBranch(b)}
                            className="flex min-w-0 flex-1 items-center rounded-control px-2 py-1.5 text-left text-[12px] leading-4 text-ink-2 transition-colors hover:text-ink"
                          >
                            <span className="truncate font-mono text-[11.5px] leading-4">{b}</span>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            data-testid={`changes-branch-delete-${b}`}
                            disabled={busy}
                            aria-label={t('wb.changes.deleteBranchNamed', b)}
                            title={t('wb.changes.deleteBranch')}
                            onClick={() => requestDeleteBranch(b)}
                            className="shrink-0 text-ink-3/65 transition-colors hover:bg-red-tint hover:text-red group-hover/branch:text-ink-2"
                          >
                            <TrashIcon className="size-3" />
                          </Button>
                        </div>
                      );
                    })}

                    {filteredPopoverRemoteBranches.length > 0 ? (
                      <>
                        <div className="mt-1 px-2 pt-1 text-[10.5px] font-medium text-ink-3">
                          {t('wb.git.branchesRemote')}
                        </div>
                        {filteredPopoverRemoteBranches.slice(0, 20).map((rb) => (
                          <button
                            key={rb}
                            type="button"
                            disabled={busy}
                            onClick={() => checkoutBranch(rb)}
                            className="flex w-full items-center rounded-control px-2 py-1.5 text-left text-[11.5px] leading-4 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                          >
                            <span className="truncate font-mono">{rb}</span>
                          </button>
                        ))}
                      </>
                    ) : null}
                  </div>
                </ScrollArea>
                <div className="mt-1.5 flex items-center gap-1 border-t border-line pt-1.5">
                  <Input
                    size="xs"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder={t('wb.changes.newBranchPlaceholder')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createNewBranch();
                    }}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    size="icon-xs"
                    aria-label={t('wb.changes.createBranch')}
                    title={t('wb.changes.createBranch')}
                    disabled={!newBranchName.trim() || busy}
                    onClick={() => createNewBranch()}
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 px-1">
              <GitBranchIcon className="size-3.5 shrink-0 text-accent-ink" />
              <span className="truncate font-mono text-[11.5px] font-medium text-ink">
                {state?.available ? (state.branch ?? 'HEAD') : t('wb.changes.title')}
              </span>
            </div>
          )}

          {/* 上下游领先 / 落后指示 */}
          {state?.available && ((state.ahead ?? 0) > 0 || (state.behind ?? 0) > 0) ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-field/85 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums"
              data-testid="git-ahead-behind"
            >
              {(state.ahead ?? 0) > 0 ? (
                <span className="text-green" title={t('wb.git.ahead', state.ahead!)}>
                  ↑{state.ahead}
                </span>
              ) : null}
              {(state.behind ?? 0) > 0 ? (
                <span className="text-orange" title={t('wb.git.behind', state.behind!)}>
                  ↓{state.behind}
                </span>
              ) : null}
            </span>
          ) : null}

          {state?.available && (state.additions > 0 || state.deletions > 0) ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-field/85 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums">
              {state.additions > 0 ? <span className="text-green">+{state.additions}</span> : null}
              {state.deletions > 0 ? <span className="text-red">−{state.deletions}</span> : null}
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {state?.available && state.remote && !remoteReadOnly ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="changes-pull-btn"
              onClick={() => {
                setBusy(true);
                post({ type: 'sourceControlPull', payload: {} });
              }}
              disabled={busy}
              aria-label={t('wb.changes.pull')}
              title={t('wb.changes.pull')}
              className="text-ink-2 hover:bg-hover hover:text-ink"
            >
              <DownloadIcon className="size-3.5" />
            </Button>
          ) : null}
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
          ) : null}
        </div>
      </div>

      {/* PR 状态追踪与一键结单横幅 */}
      {pr ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-b border-sidebar-border bg-inset/70 px-2.5 py-1.5 text-[11.5px]"
          data-testid="changes-pr-status"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10.5px] font-medium',
                pr.state === 'MERGED'
                  ? 'bg-accent-tint text-accent-ink'
                  : pr.state === 'OPEN'
                    ? 'bg-green-tint text-green'
                    : 'bg-field text-ink-3',
              )}
            >
              {t(
                pr.state === 'MERGED'
                  ? 'wb.changes.prMerged'
                  : pr.state === 'OPEN'
                    ? 'wb.changes.prOpen'
                    : 'wb.changes.prClosed',
                pr.number,
              )}
            </span>
            {pr.checks ? (
              <span className="truncate font-mono text-[10.5px] text-ink-3 tabular-nums">
                {t('wb.changes.prChecks', pr.checks.passed, pr.checks.total)}
                {pr.checks.failed > 0 ? ` · ${t('wb.changes.prChecksFailed', pr.checks.failed)}` : ''}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={pr.title}
              title={pr.title}
              onClick={() => post({ type: 'openExternal', payload: { url: pr.url } })}
            >
              <ExternalLinkIcon className="size-3" />
            </Button>
            {pr.state === 'MERGED' && !remoteReadOnly ? (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                data-testid="changes-pr-settle-btn"
                onClick={() => {
                  setSettleRemoveWorktree(Boolean(session.worktreePath));
                  setSettleOpen(true);
                }}
              >
                {t('wb.changes.prSettle')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 主内容区：加载 / 非仓库 / 4 子标签页工作台 */}
      {!state ? (
        <div className="flex flex-1 items-center justify-center px-3 py-6 text-[12px] text-ink-3">
          {t('wb.changes.refreshing')}
        </div>
      ) : !state.available ? (
        <div className="flex flex-1 items-center justify-center px-3 py-6 text-center text-[12px] text-ink-3">
          {state.error ? t('wb.changes.error', state.error) : t('wb.changes.notRepo')}
        </div>
      ) : (
        <Tabs
          value={subTab}
          onValueChange={(v) => setSubTab(v as GitSubTab)}
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
        >
          <div className="flex shrink-0 items-center border-b border-sidebar-border/80 px-2">
            <TabsList
              variant="line"
              className="tabs h-8 min-w-0 flex-1 justify-start gap-0.5 overflow-x-auto overflow-y-hidden p-0"
            >
              <TabsTrigger
                value="commit"
                data-testid="git-tab-commit"
                className="h-8 flex-none gap-1 rounded-none px-2 text-[11.5px] leading-4 after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <GitCommitIcon className="size-3.5 shrink-0" />
                <span>{t('wb.git.tab.commit')}</span>
                {state.files.length > 0 ? (
                  <span className="inline-flex h-4 items-center rounded-full bg-field px-1.5 font-mono text-[10px] leading-none text-ink-2 tabular-nums">
                    {state.files.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger
                value="log"
                data-testid="git-tab-log"
                className="h-8 flex-none gap-1 rounded-none px-2 text-[11.5px] leading-4 after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <HistoryIcon className="size-3.5 shrink-0" />
                <span>{t('wb.git.tab.log')}</span>
              </TabsTrigger>
              <TabsTrigger
                value="branches"
                data-testid="git-tab-branches"
                className="h-8 flex-none gap-1 rounded-none px-2 text-[11.5px] leading-4 after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span>{t('wb.git.tab.branches')}</span>
              </TabsTrigger>
              <TabsTrigger
                value="stash"
                data-testid="git-tab-stash"
                className="h-8 flex-none gap-1 rounded-none px-2 text-[11.5px] leading-4 after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <ArchiveIcon className="size-3.5 shrink-0" />
                <span>{t('wb.git.tab.stash')}</span>
                {stashCount > 0 ? (
                  <span className="inline-flex h-4 items-center rounded-full bg-field px-1.5 font-mono text-[10px] leading-none text-ink-2 tabular-nums">
                    {stashCount}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="commit" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
            <GitCommitPane
              state={state}
              sessionPaths={sessionPaths}
              activeDiffPath={activeDiffPath}
              busy={busy}
              remoteReadOnly={remoteReadOnly}
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              amend={amend}
              onAmendChange={setAmend}
              generatingCommit={generatingCommit}
              onRequestAiCommit={requestAiCommit}
              onCommit={runCommit}
              onOpenPushDialog={() => setPushOpen(true)}
              onOpenDiff={openDiff}
              onStageFile={stageOne}
              onUnstageFile={unstageOne}
              onStageAll={stageAll}
              onUnstageAll={unstageAll}
              onRequestDiscardFile={setDiscardTarget}
              onRequestDiscardAll={() => setDiscardAllOpen(true)}
              onOpenStashSave={openStashSave}
              onContinueOp={() => {
                setBusy(true);
                post({ type: 'sourceControlContinueOp', payload: {} });
              }}
              onAbortOp={() => {
                setBusy(true);
                post({ type: 'sourceControlAbortOp', payload: {} });
              }}
              onResolveConflict={(path, strategy) => {
                setBusy(true);
                post({ type: 'sourceControlResolveConflict', payload: { path, strategy } });
              }}
            />
          </TabsContent>

          <TabsContent value="log" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
            {subTab === 'log' ? (
              <GitLogPane
                state={state}
                busy={busy}
                remoteReadOnly={remoteReadOnly}
                onCherryPick={cherryPick}
                onRevertCommit={revertCommit}
                onResetCommit={resetCommit}
                onNewBranchFrom={(startPoint) => {
                  setNewBranchFromTarget(startPoint);
                  setNewBranchFromValue('');
                }}
                onOpenCommitFileDiff={openCommitFileDiff}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="branches" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
            <GitBranchesPane
              state={state}
              busy={busy}
              remoteReadOnly={remoteReadOnly}
              onCheckoutBranch={checkoutBranch}
              onCreateBranch={(name, startPoint) => createNewBranch(name, startPoint)}
              onNewBranchFrom={(startPoint) => {
                setNewBranchFromTarget(startPoint);
                setNewBranchFromValue('');
              }}
              onRenameBranch={(oldName) => {
                setRenameBranchTarget(oldName);
                setRenameBranchValue(oldName);
              }}
              onDeleteBranch={requestDeleteBranch}
              onMergeBranch={mergeBranch}
              onRebaseBranch={rebaseBranch}
            />
          </TabsContent>

          <TabsContent value="stash" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
            <GitStashPane
              state={state}
              busy={busy}
              remoteReadOnly={remoteReadOnly}
              onOpenStashSave={() => openStashSave()}
              onApplyStash={applyStash}
              onPopStash={popStash}
              onDropStash={setStashDropTarget}
              onOpenStashFileDiff={(index, file) => openStashFileDiff(index, file.path)}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* 推送确认弹窗 */}
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

      {/* 单文件撤销确认弹窗 */}
      <Dialog open={Boolean(discardTarget)} onOpenChange={(open) => !open && setDiscardTarget(null)}>
        <DialogContent data-testid="changes-discard-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.discardConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('wb.changes.discardConfirmDesc', discardTarget?.path ?? '')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setDiscardTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="changes-discard-confirm"
              onClick={confirmDiscard}
            >
              {t('wb.changes.discardFile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 全部撤销确认弹窗 */}
      <Dialog open={discardAllOpen} onOpenChange={setDiscardAllOpen}>
        <DialogContent data-testid="git-discard-all-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.git.discardAllTitle')}</DialogTitle>
            <DialogDescription>{t('wb.git.discardAllDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setDiscardAllOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="git-discard-all-confirm"
              onClick={confirmDiscardAll}
            >
              {t('wb.git.discardAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 硬重置确认弹窗 */}
      <Dialog open={Boolean(resetHardTarget)} onOpenChange={(open) => !open && setResetHardTarget(null)}>
        <DialogContent data-testid="git-reset-hard-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.git.resetHardTitle')}</DialogTitle>
            <DialogDescription>{t('wb.git.resetHardDesc', resetHardTarget?.slice(0, 7) ?? '')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setResetHardTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="git-reset-hard-confirm"
              onClick={confirmHardReset}
            >
              {t('wb.git.resetHard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 保存贮藏弹窗 */}
      <Dialog open={stashSaveOpen} onOpenChange={setStashSaveOpen}>
        <DialogContent data-testid="git-stash-save-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.git.stashSaveTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              size="sm"
              value={stashMessage}
              onChange={(e) => setStashMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmStashSave();
              }}
              placeholder={t('wb.git.stashMessagePlaceholder')}
              data-testid="git-stash-message-input"
              disabled={busy}
            />
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
              <Checkbox
                checked={stashIncludeUntracked}
                onCheckedChange={(v) => setStashIncludeUntracked(v === true)}
                disabled={busy}
              />
              <span>{t('wb.git.stashIncludeUntracked')}</span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setStashSaveOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" data-testid="git-stash-save-confirm" onClick={confirmStashSave} disabled={busy}>
              <ArchiveIcon className="size-3.5" />
              <span>{t('wb.git.stashSave')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除贮藏确认弹窗 */}
      <Dialog open={Boolean(stashDropTarget)} onOpenChange={(open) => !open && setStashDropTarget(null)}>
        <DialogContent data-testid="git-stash-drop-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.git.stashDropTitle')}</DialogTitle>
            <DialogDescription>{t('wb.git.stashDropDesc', stashDropTarget?.ref ?? '')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setStashDropTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="git-stash-drop-confirm"
              onClick={confirmDropStash}
            >
              {t('wb.git.stashDrop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名分支弹窗 */}
      <Dialog open={Boolean(renameBranchTarget)} onOpenChange={(open) => !open && setRenameBranchTarget(null)}>
        <DialogContent data-testid="git-rename-branch-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.git.renameBranchTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            size="sm"
            value={renameBranchValue}
            onChange={(e) => setRenameBranchValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmRenameBranch();
            }}
            placeholder={t('wb.git.renameBranchPlaceholder')}
            data-testid="git-rename-branch-input"
            disabled={busy}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setRenameBranchTarget(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="git-rename-branch-confirm"
              disabled={busy || !renameBranchValue.trim() || renameBranchValue.trim() === renameBranchTarget}
              onClick={confirmRenameBranch}
            >
              {t('wb.git.renameBranch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 基于指定分支/提交新建分支弹窗 */}
      <Dialog open={Boolean(newBranchFromTarget)} onOpenChange={(open) => !open && setNewBranchFromTarget(null)}>
        <DialogContent data-testid="git-new-branch-from-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.git.newBranchFromTitle')}</DialogTitle>
            <DialogDescription>
              {t('wb.git.newBranchFromDesc', newBranchFromTarget?.slice(0, 32) ?? '')}
            </DialogDescription>
          </DialogHeader>
          <Input
            size="sm"
            value={newBranchFromValue}
            onChange={(e) => setNewBranchFromValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newBranchFromTarget) {
                createNewBranch(newBranchFromValue, newBranchFromTarget);
              }
            }}
            placeholder={t('wb.changes.newBranchPlaceholder')}
            data-testid="git-new-branch-from-input"
            disabled={busy}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setNewBranchFromTarget(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="git-new-branch-from-confirm"
              disabled={busy || !newBranchFromValue.trim()}
              onClick={() => {
                if (newBranchFromTarget) createNewBranch(newBranchFromValue, newBranchFromTarget);
              }}
            >
              {t('wb.changes.createBranch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PR 结单确认弹窗 */}
      <Dialog open={settleOpen} onOpenChange={setSettleOpen}>
        <DialogContent data-testid="changes-settle-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.prSettleTitle')}</DialogTitle>
            <DialogDescription>{t('wb.changes.prSettleDesc')}</DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
            <Checkbox checked={settleRemoveWorktree} onCheckedChange={(v) => setSettleRemoveWorktree(v === true)} />
            <span>{t('wb.changes.prSettleRemoveWorktree')}</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setSettleOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="changes-settle-confirm"
              onClick={() => {
                setBusy(true);
                post({
                  type: 'sourceControlSettlePr',
                  payload: { completeLinkedTask: true, removeWorktree: settleRemoveWorktree },
                });
              }}
            >
              {t('wb.changes.prSettle')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 创建 PR 弹窗 */}
      <Dialog open={prOpen} onOpenChange={setPrOpen}>
        <DialogContent data-testid="changes-pr-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.prTitle')}</DialogTitle>
            <DialogDescription>{t('wb.changes.prHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="pr-title">{t('wb.changes.prTitleLabel')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="changes-ai-pr-btn"
                disabled={generatingPr || busy}
                onClick={requestAiPr}
              >
                {generatingPr ? <SpinnerIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
                <span>{generatingPr ? t('wb.changes.generating') : t('wb.changes.aiPr')}</span>
              </Button>
            </div>
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

      <DeleteBranchDialog
        branch={deleteBranchTarget}
        busy={busy}
        testIdPrefix="changes-delete-branch"
        onOpenChange={(open) => !open && setDeleteBranchTarget(null)}
        onConfirm={confirmDeleteBranch}
      />
    </div>
  );
}

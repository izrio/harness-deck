/**
 * 工作台 · Git 改动面板（ChangesView，HD-09 / HD-10 / P0-2 / P1-7）：
 * - 顶部单行 IDEA 风格工具栏：分支切换 Popover（切换/新建分支）+ 增删统计 + 抓取/拉取/刷新/按目录树分组/仅看本会话改动/创建 PR
 * - PR 状态追踪横幅：展示当前分支关联 PR 的状态（OPEN / MERGED / CLOSED）、CI checks 汇总、外链与「一键结单」
 * - 中部可折叠变更列表（已暂存 / 更改 / 未跟踪）：每行支持单文件暂存（+）、取消暂存（-）、撤销更改（↩ 二次确认）
 * - 底部固定提交区：多行提交信息输入（支持 Ctrl/Cmd+Enter）+ AI 一键生成提交信息 + 提交与推送操作
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
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTypeIcon,
  FilterIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  ListIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  SparklesIcon,
  SpinnerIcon,
  UndoIcon,
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';

function post(message: Parameters<typeof postToHost>[0]): void {
  postToHost(message);
}

const STATUS_STYLE: Record<
  SourceControlFileView['status'],
  { readonly letter: string; readonly nameCls: string; readonly badgeCls: string }
> = {
  modified: { letter: 'M', nameCls: 'text-ink', badgeCls: 'bg-accent-tint text-accent-ink' },
  added: { letter: 'A', nameCls: 'text-ink', badgeCls: 'bg-green-tint text-green' },
  deleted: { letter: 'D', nameCls: 'text-ink-3 line-through', badgeCls: 'bg-red-tint text-red' },
  renamed: { letter: 'R', nameCls: 'text-ink', badgeCls: 'bg-accent-tint text-accent-ink' },
  untracked: { letter: 'U', nameCls: 'text-ink', badgeCls: 'bg-orange-tint text-orange' },
  conflicted: { letter: '!', nameCls: 'text-red', badgeCls: 'bg-red-tint text-red' },
};

const GROUP_DOT_CLASS: Record<ChangeGroup['id'], string> = {
  staged: 'bg-green',
  changes: 'bg-accent-ink',
  untracked: 'bg-orange',
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

let draftRequestSeq = 1;

export function ChangesView({ compact = false }: { readonly compact?: boolean } = {}) {
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
  const [commitMessage, setCommitMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);
  const [sessionOnly, setSessionOnly] = useState(false);
  const [groupByDir, setGroupByDir] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [generatingCommit, setGeneratingCommit] = useState(false);
  const [generatingPr, setGeneratingPr] = useState(false);
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [pushOpen, setPushOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [discardTarget, setDiscardTarget] = useState<SourceControlFileView | null>(null);
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
    if (action.kind === 'commit' && action.ok) {
      setCommitMessage('');
    } else if (action.kind === 'pr' && action.ok) {
      setPrOpen(false);
      setPrTitle('');
      setPrBody('');
    } else if ((action.kind === 'checkout' || action.kind === 'branch') && action.ok) {
      setBranchPopoverOpen(false);
      setNewBranchName('');
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

  const checkoutBranch = (branch: string): void => {
    if (busy || remoteReadOnly || branch === state?.branch) return;
    setBusy(true);
    post({ type: 'sourceControlCheckoutBranch', payload: { branch } });
  };

  const createNewBranch = (): void => {
    const trimmed = newBranchName.trim();
    if (!trimmed || busy || remoteReadOnly) return;
    setBusy(true);
    post({ type: 'sourceControlCreateBranch', payload: { branch: trimmed } });
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

  const pr = state?.pr;

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', !compact && 'bg-canvas')}
      data-testid="workbench-changes"
    >
      {/* 顶部单行工具栏：分支切换 + 增删统计 + 同步/视图/PR 操作 */}
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
                  className="min-w-0 max-w-[168px] font-mono text-[11.5px] font-medium text-ink hover:bg-hover"
                >
                  <GitBranchIcon className="size-3.5 shrink-0 text-accent-ink" />
                  <span className="min-w-0 truncate">{state.branch ?? 'HEAD'}</span>
                  <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-64 p-2">
                <div className="mb-1.5 px-1 text-[11px] font-medium text-ink-3">{t('wb.changes.switchBranch')}</div>
                <div className="max-h-44 overflow-y-auto">
                  {(state.branches ?? []).map((b) => {
                    const current = b === state.branch;
                    return (
                      <button
                        key={b}
                        type="button"
                        onClick={() => checkoutBranch(b)}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-control px-2 py-1 text-left text-[12px] transition-colors hover:bg-hover',
                          current ? 'bg-field font-medium text-ink' : 'text-ink-2',
                        )}
                      >
                        <span className="truncate font-mono text-[11.5px]">{b}</span>
                        {current ? <CheckIcon className="size-3.5 shrink-0 text-accent-ink" /> : null}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
                  <Input
                    size="xs"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder={t('wb.changes.newBranchPlaceholder')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createNewBranch();
                    }}
                  />
                  <Button
                    type="button"
                    size="icon-xs"
                    aria-label={t('wb.changes.createBranch')}
                    title={t('wb.changes.createBranch')}
                    disabled={!newBranchName.trim() || busy}
                    onClick={createNewBranch}
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                </div>
                {state.remote ? (
                  <div className="mt-1.5 flex items-center justify-end border-t border-line pt-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        setBranchPopoverOpen(false);
                        setBusy(true);
                        post({ type: 'sourceControlFetch', payload: {} });
                      }}
                    >
                      <RefreshIcon className="size-3" />
                      <span>{t('wb.changes.fetch')}</span>
                    </Button>
                  </div>
                ) : null}
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
            <>
              <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-line/70" />
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

      {/* PR 状态追踪与一键结单横幅（P1-7） */}
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
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
            {visibleFiles.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-10 text-center">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-field text-ink-3">
                  <CheckIcon className="size-4" />
                </span>
                <span className="text-[12px] text-ink-3">{t('wb.changes.empty')}</span>
              </div>
            ) : (
              <div className="flex flex-col gap-3" data-testid="changes-list">
                {groups.map((group) => {
                  const collapsed = Boolean(collapsedGroups[group.id]);
                  return (
                    <section key={group.id} className="flex flex-col gap-1" data-testid={`changes-group-${group.id}`}>
                      <button
                        type="button"
                        aria-expanded={!collapsed}
                        onClick={() => toggleGroup(group.id)}
                        className="flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-[11.5px] font-medium text-ink-2 transition-colors duration-100 hover:bg-hover/70 hover:text-ink"
                      >
                        {collapsed ? (
                          <ChevronRightIcon className="size-3 shrink-0 text-ink-3" />
                        ) : (
                          <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                        )}
                        <span
                          aria-hidden="true"
                          className={cn('size-1.5 shrink-0 rounded-full', GROUP_DOT_CLASS[group.id])}
                        />
                        <span className="min-w-0 flex-1 truncate">{t(group.labelKey)}</span>
                        <span className="shrink-0 rounded-full bg-field px-1.5 py-0.5 font-mono text-[10px] leading-none font-normal text-ink-3 tabular-nums">
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
                            canMutate={!remoteReadOnly && !busy}
                            onToggleDir={toggleDir}
                            onOpenDiff={openDiff}
                            onStage={stageOne}
                            onUnstage={unstageOne}
                            onDiscard={setDiscardTarget}
                          />
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {group.files.map((file) => (
                              <ChangeFileRow
                                key={file.path}
                                file={file}
                                showDir
                                activeDiffPath={activeDiffPath}
                                canMutate={!remoteReadOnly && !busy}
                                onOpenDiff={openDiff}
                                onStage={stageOne}
                                onUnstage={unstageOne}
                                onDiscard={setDiscardTarget}
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

          {/* 底部固定 Commit 卡片（与对话 Composer 统一的悬浮卡片风格） */}
          <div className="shrink-0 border-t border-sidebar-border/80 bg-sidebar px-2.5 py-2.5">
            <div className="flex flex-col overflow-hidden rounded-xl border border-black/8 bg-surface/90 shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring/45 focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_24%,transparent)] dark:border-white/[0.08] dark:bg-surface/75">
              <div className="relative">
                <Textarea
                  rows={2}
                  className="min-h-[60px] resize-none border-0 bg-transparent px-2.5 pt-2 pr-8 pb-1.5 text-[12px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="changes-ai-commit-btn"
                  aria-label={t('wb.changes.aiCommit')}
                  title={generatingCommit ? t('wb.changes.generating') : t('wb.changes.aiCommit')}
                  disabled={generatingCommit || busy || remoteReadOnly || state.files.length === 0}
                  onClick={requestAiCommit}
                  className="absolute top-1.5 right-1.5 text-ink-3 hover:bg-hover hover:text-accent-ink"
                >
                  {generatingCommit ? <SpinnerIcon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-line/60 bg-inset/35 px-2 py-1.5">
                {showStageToggle ? (
                  <label
                    className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-ink-2 select-none hover:text-ink"
                    title={t('wb.changes.stageAll')}
                  >
                    <Checkbox checked={stageAll} onCheckedChange={(checked) => setStageAll(checked === true)} />
                    <span className="truncate">{t('wb.changes.stageAll')}</span>
                  </label>
                ) : (
                  <span className="truncate pl-0.5 text-[11px] text-ink-3 tabular-nums">
                    {t('wb.changes.fileCount', visibleFiles.length)}
                  </span>
                )}

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    onClick={commit}
                    disabled={busy || remoteReadOnly || !commitMessage.trim() || state.files.length === 0}
                  >
                    <GitCommitIcon className="size-3.5" />
                    <span>{t('wb.changes.commit')}</span>
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
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

      <Dialog open={Boolean(discardTarget)} onOpenChange={(open) => !open && setDiscardTarget(null)}>
        <DialogContent data-testid="changes-discard-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.discardConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('wb.changes.discardConfirmDesc', discardTarget?.path ?? '')}
            </DialogDescription>
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

      <Dialog open={settleOpen} onOpenChange={setSettleOpen}>
        <DialogContent data-testid="changes-settle-dialog">
          <DialogHeader>
            <DialogTitle>{t('wb.changes.prSettleTitle')}</DialogTitle>
            <DialogDescription>{t('wb.changes.prSettleDesc')}</DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
            <Checkbox
              checked={settleRemoveWorktree}
              onCheckedChange={(v) => setSettleRemoveWorktree(v === true)}
            />
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
    </div>
  );
}

function ChangeFileRow({
  file,
  showDir,
  activeDiffPath,
  canMutate,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  readonly file: SourceControlFileView;
  readonly showDir: boolean;
  readonly activeDiffPath?: string;
  readonly canMutate: boolean;
  readonly onOpenDiff: (file: SourceControlFileView) => void;
  readonly onStage: (file: SourceControlFileView) => void;
  readonly onUnstage: (file: SourceControlFileView) => void;
  readonly onDiscard: (file: SourceControlFileView) => void;
}) {
  const t = useT();
  const { normalized, name, dir } = splitFilePath(file.path);
  const style = STATUS_STYLE[file.status];
  const isSelected = activeDiffPath === normalized;
  const statusLabel = t(`wb.changes.status.${file.status}` as MessageKey);

  const hasStats = (file.additions !== undefined && file.additions > 0) || (file.deletions !== undefined && file.deletions > 0);

  return (
    <div
      className={cn(
        'group/file relative flex w-full items-center gap-1 rounded-control pr-1.5 transition-colors duration-100',
        isSelected
          ? 'bg-surface shadow-hairline dark:bg-white/[0.07]'
          : 'hover:bg-hover/80',
      )}
    >
      <button
        type="button"
        data-testid={`changes-file-${normalized}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
        onClick={() => onOpenDiff(file)}
        title={`${normalized} (${statusLabel})`}
      >
        <FileTypeIcon path={file.path} className="size-4 shrink-0" />
        <span
          className={cn(
            'shrink-0 truncate text-[12px] leading-4 font-medium',
            showDir ? 'max-w-[56%]' : 'min-w-0 flex-1',
            style.nameCls,
          )}
        >
          {name}
        </span>
        {showDir && dir ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-4 text-ink-3/85">{dir}</span>
        ) : (
          <span className="flex-1" />
        )}
      </button>

      {/* 右侧统计与悬停操作：悬停或聚焦时切换为暂存/撤销按钮，避免遮挡目录路径 */}
      <div className="flex shrink-0 items-center justify-end">
        {hasStats ? (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 pr-1 font-mono text-[10.5px] leading-4 tabular-nums',
              canMutate && 'group-focus-within/file:hidden group-hover/file:hidden',
            )}
          >
            {file.additions !== undefined && file.additions > 0 ? (
              <span className="text-green">+{file.additions}</span>
            ) : null}
            {file.deletions !== undefined && file.deletions > 0 ? (
              <span className="text-red">−{file.deletions}</span>
            ) : null}
          </span>
        ) : null}

        {canMutate ? (
          <div className="pointer-events-none flex w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-opacity duration-100 group-focus-within/file:pointer-events-auto group-focus-within/file:w-auto group-focus-within/file:overflow-visible group-focus-within/file:opacity-100 group-hover/file:pointer-events-auto group-hover/file:w-auto group-hover/file:overflow-visible group-hover/file:opacity-100">
            {!file.staged ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid={`changes-discard-${normalized}`}
                aria-label={t('wb.changes.discardFile')}
                title={t('wb.changes.discardFile')}
                className="text-ink-3 hover:bg-hover-2 hover:text-red"
                onClick={() => onDiscard(file)}
              >
                <UndoIcon className="size-3" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid={`${file.staged ? 'changes-unstage' : 'changes-stage'}-${normalized}`}
              aria-label={file.staged ? t('wb.changes.unstageFile') : t('wb.changes.stageFile')}
              title={file.staged ? t('wb.changes.unstageFile') : t('wb.changes.stageFile')}
              className="text-ink-3 hover:bg-hover-2 hover:text-ink"
              onClick={() => (file.staged ? onUnstage(file) : onStage(file))}
            >
              {file.staged ? <MinusIcon className="size-3" /> : <PlusIcon className="size-3" />}
            </Button>
          </div>
        ) : null}
      </div>

      <span
        className={cn(
          'inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[10.5px] leading-none font-semibold',
          style.badgeCls,
        )}
        aria-label={statusLabel}
      >
        {style.letter}
      </span>
    </div>
  );
}

interface ChangeDirNode {
  readonly name: string;
  readonly fullPath: string;
  readonly dirs: readonly ChangeDirNode[];
  readonly files: readonly SourceControlFileView[];
  readonly totalFiles: number;
}

interface MutableChangeDirNode {
  name: string;
  fullPath: string;
  readonly dirs: Map<string, MutableChangeDirNode>;
  readonly files: SourceControlFileView[];
}

function finalizeChangeDirNode(raw: MutableChangeDirNode): ChangeDirNode {
  let dirs = [...raw.dirs.values()]
    .map(finalizeChangeDirNode)
    .sort((a, b) => a.name.localeCompare(b.name));
  let files = [...raw.files].sort((a, b) => splitFilePath(a.path).name.localeCompare(splitFilePath(b.path).name));
  let name = raw.name;
  let fullPath = raw.fullPath;

  while (files.length === 0 && dirs.length === 1) {
    const only = dirs[0]!;
    name = `${name}/${only.name}`;
    fullPath = only.fullPath;
    dirs = [...only.dirs];
    files = [...only.files];
  }

  const totalFiles = files.length + dirs.reduce((sum, child) => sum + child.totalFiles, 0);
  return { name, fullPath, dirs, files, totalFiles };
}

export function buildChangeDirTree(files: readonly SourceControlFileView[]): {
  readonly dirs: readonly ChangeDirNode[];
  readonly rootFiles: readonly SourceControlFileView[];
} {
  const rootDirs = new Map<string, MutableChangeDirNode>();
  const rootFiles: SourceControlFileView[] = [];

  for (const file of files) {
    const { dir } = splitFilePath(file.path);
    const segments = dir ? dir.split('/').filter(Boolean) : [];
    if (segments.length === 0) {
      rootFiles.push(file);
      continue;
    }
    let currentMap = rootDirs;
    let currentPath = '';
    let targetNode: MutableChangeDirNode | undefined;
    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      let next = currentMap.get(seg);
      if (!next) {
        next = { name: seg, fullPath: currentPath, dirs: new Map(), files: [] };
        currentMap.set(seg, next);
      }
      targetNode = next;
      currentMap = next.dirs;
    }
    targetNode?.files.push(file);
  }

  const dirs = [...rootDirs.values()]
    .map(finalizeChangeDirNode)
    .sort((a, b) => a.name.localeCompare(b.name));
  rootFiles.sort((a, b) => splitFilePath(a.path).name.localeCompare(splitFilePath(b.path).name));
  return { dirs, rootFiles };
}

function ChangeDirBranch({
  groupId,
  node,
  depth,
  activeDiffPath,
  collapsedDirs,
  canMutate,
  onToggleDir,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  readonly groupId: string;
  readonly node: ChangeDirNode;
  readonly depth: number;
  readonly activeDiffPath?: string;
  readonly collapsedDirs: Readonly<Record<string, boolean>>;
  readonly canMutate: boolean;
  readonly onToggleDir: (key: string) => void;
  readonly onOpenDiff: (file: SourceControlFileView) => void;
  readonly onStage: (file: SourceControlFileView) => void;
  readonly onUnstage: (file: SourceControlFileView) => void;
  readonly onDiscard: (file: SourceControlFileView) => void;
}) {
  const key = `${groupId}:${node.fullPath}`;
  const collapsed = Boolean(collapsedDirs[key]);
  return (
    <div className="flex flex-col" data-testid={`changes-dir-node-${node.fullPath}`}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onToggleDir(key)}
        title={node.fullPath}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        className="flex w-full items-center gap-1.5 rounded-control py-1.5 pr-2 text-left text-[11.5px] text-ink-2 transition-colors duration-100 hover:bg-hover/80 hover:text-ink"
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
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{node.name}</span>
        <span className="shrink-0 rounded-full bg-field px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-3 tabular-nums">
          {node.totalFiles}
        </span>
      </button>
      {!collapsed ? (
        <div className="flex flex-col gap-0.5">
          {node.dirs.map((childDir) => (
            <ChangeDirBranch
              key={childDir.fullPath}
              groupId={groupId}
              node={childDir}
              depth={depth + 1}
              activeDiffPath={activeDiffPath}
              collapsedDirs={collapsedDirs}
              canMutate={canMutate}
              onToggleDir={onToggleDir}
              onOpenDiff={onOpenDiff}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))}
          {node.files.map((file) => (
            <div key={file.path} style={{ paddingLeft: `${(depth + 1) * 12}px` }}>
              <ChangeFileRow
                file={file}
                showDir={false}
                activeDiffPath={activeDiffPath}
                canMutate={canMutate}
                onOpenDiff={onOpenDiff}
                onStage={onStage}
                onUnstage={onUnstage}
                onDiscard={onDiscard}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DirectoryGroupedFiles({
  groupId,
  files,
  activeDiffPath,
  collapsedDirs,
  canMutate,
  onToggleDir,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  readonly groupId: string;
  readonly files: readonly SourceControlFileView[];
  readonly activeDiffPath?: string;
  readonly collapsedDirs: Readonly<Record<string, boolean>>;
  readonly canMutate: boolean;
  readonly onToggleDir: (key: string) => void;
  readonly onOpenDiff: (file: SourceControlFileView) => void;
  readonly onStage: (file: SourceControlFileView) => void;
  readonly onUnstage: (file: SourceControlFileView) => void;
  readonly onDiscard: (file: SourceControlFileView) => void;
}) {
  const tree = useMemo(() => buildChangeDirTree(files), [files]);

  return (
    <div className="flex flex-col gap-0.5 pl-1" data-testid={`changes-dir-tree-${groupId}`}>
      {tree.dirs.map((dirNode) => (
        <ChangeDirBranch
          key={dirNode.fullPath}
          groupId={groupId}
          node={dirNode}
          depth={0}
          activeDiffPath={activeDiffPath}
          collapsedDirs={collapsedDirs}
          canMutate={canMutate}
          onToggleDir={onToggleDir}
          onOpenDiff={onOpenDiff}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
        />
      ))}
      {tree.rootFiles.map((file) => (
        <ChangeFileRow
          key={file.path}
          file={file}
          showDir={false}
          activeDiffPath={activeDiffPath}
          canMutate={canMutate}
          onOpenDiff={onOpenDiff}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
        />
      ))}
    </div>
  );
}

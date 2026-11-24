/**
 * 会话输入框下方的上下文状态条：
 * - 左侧：项目切换器 + Git 分支切换器（Popover 切换本地分支 / 新建分支 / 抓取）；
 * - 右侧：双圆环订阅用量标识（外环周用量、内环 5h 用量）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useT } from '../i18n.ts';
import { cn } from '../lib/utils.ts';
import { getProjectOptions } from '../lib/workbenchOptions.ts';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  PlusIcon,
  RefreshIcon,
} from './icons.tsx';
import { UsageBadge } from './UsageBadge.tsx';

export function ComposerFooter({ onNewWorktree }: { readonly onNewWorktree?: () => void } = {}) {
  const t = useT();
  const projects = useView((s) => s.projects);
  const sourceControl = useView((s) => s.workbench.sourceControl);
  const activeTab = useView((s) => s.tabs.items.find((item) => item.key === s.tabs.active));
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);

  const [projectOpen, setProjectOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const lastActionAtRef = useRef<number | undefined>(undefined);

  const isMobileRemote = clientSurface === 'mobile-web';
  const remoteReadOnly = isMobileRemote && clientScope === 'read-only';

  const projectOptions = useMemo(() => getProjectOptions(projects), [projects]);
  const currentProjectPath = projects.currentPath ?? sourceControl?.root;
  const currentProjectName = useMemo(() => {
    if (currentProjectPath) {
      const hit = projectOptions.find(([p]) => p === currentProjectPath);
      if (hit) return hit[1];
      return currentProjectPath.split(/[\\/]/u).pop() || currentProjectPath;
    }
    return undefined;
  }, [currentProjectPath, projectOptions]);

  const currentBranch = sourceControl?.available
    ? (sourceControl.branch ?? 'HEAD')
    : activeTab?.worktreeBranch;
  const branches = useMemo(() => {
    const list = sourceControl?.branches ?? [];
    if (list.length > 0) return list;
    return currentBranch ? [currentBranch] : [];
  }, [sourceControl?.branches, currentBranch]);

  useEffect(() => {
    const at = sourceControl?.lastAction?.at;
    if (at !== undefined && at !== lastActionAtRef.current) {
      lastActionAtRef.current = at;
      setBranchBusy(false);
      if (sourceControl?.lastAction?.ok && sourceControl.lastAction.kind === 'branch') {
        setNewBranchName('');
        setBranchOpen(false);
      }
      if (sourceControl?.lastAction?.ok && sourceControl.lastAction.kind === 'checkout') {
        setBranchOpen(false);
      }
    }
  }, [sourceControl?.lastAction]);

  const handleSelectProject = (path: string): void => {
    setProjectOpen(false);
    if (path === currentProjectPath) return;
    postToHost({ type: 'openProject', payload: { path, inPlace: true } });
  };

  const handleBranchOpenChange = (open: boolean): void => {
    setBranchOpen(open);
    if (open) {
      postToHost({ type: 'refreshSourceControl', payload: {} });
    }
  };

  const checkoutBranch = (branch: string): void => {
    if (branchBusy || remoteReadOnly) return;
    if (branch === currentBranch) {
      setBranchOpen(false);
      return;
    }
    setBranchBusy(true);
    postToHost({ type: 'sourceControlCheckoutBranch', payload: { branch } });
  };

  const createNewBranch = (): void => {
    const trimmed = newBranchName.trim();
    if (!trimmed || branchBusy || remoteReadOnly) return;
    setBranchBusy(true);
    postToHost({ type: 'sourceControlCreateBranch', payload: { branch: trimmed } });
  };

  const showProject = Boolean(currentProjectName || projectOptions.length > 0);
  const showBranch = Boolean(currentBranch);
  const canSwitchBranch = Boolean(sourceControl?.available && !remoteReadOnly);

  return (
    <div
      className={cn(
        'composer-footer flex min-w-0 items-center justify-between gap-2 px-1 pt-0.5 pb-2 max-md:pt-1 max-md:pb-3',
        isMobileRemote && 'pt-1 pb-3',
      )}
      data-testid="composer-footer"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        {showProject ? (
          <Popover open={projectOpen} onOpenChange={setProjectOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={remoteReadOnly}
                data-testid="composer-project-trigger"
                title={currentProjectPath ?? currentProjectName}
                className="min-w-0 max-w-[180px] text-ink-2 hover:bg-hover hover:text-ink max-md:max-w-[132px]"
              >
                <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
                <span className="min-w-0 truncate">{currentProjectName}</span>
                {!remoteReadOnly ? <ChevronDownIcon className="size-3 shrink-0 text-ink-3" /> : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={6}
              className="w-64 p-2"
              data-testid="composer-project-popover"
            >
              <div className="mb-1.5 px-1 text-[11px] font-medium text-ink-3">
                {t('composer.switchProject')}
              </div>
              {projectOptions.length > 0 ? (
                <div className="max-h-48 overflow-y-auto">
                  {projectOptions.map(([path, name]) => {
                    const isCurrent = path === currentProjectPath;
                    return (
                      <button
                        key={path}
                        type="button"
                        data-testid={`composer-project-item-${name}`}
                        title={path}
                        onClick={() => handleSelectProject(path)}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-hover',
                          isCurrent ? 'bg-field font-medium text-ink' : 'text-ink-2',
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-1.5">
                          <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate leading-4">{name}</span>
                            <span className="block truncate font-mono text-[10px] leading-3.5 text-ink-3">
                              {path}
                            </span>
                          </span>
                        </span>
                        {isCurrent ? <CheckIcon className="size-3.5 shrink-0 text-accent-ink" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-1.5 text-[11.5px] text-ink-3">{t('composer.noProjects')}</div>
              )}
              {!isMobileRemote ? (
                <div className="mt-1.5 border-t border-line pt-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="composer-add-project"
                    className="w-full justify-start text-ink-2 hover:text-ink"
                    onClick={() => {
                      setProjectOpen(false);
                      postToHost({ type: 'addRecentProject', payload: {} });
                    }}
                  >
                    <PlusIcon className="size-3" />
                    <span>{t('wb.sessions.addProject')}</span>
                  </Button>
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        ) : null}

        {showBranch ? (
          canSwitchBranch ? (
            <Popover open={branchOpen} onOpenChange={handleBranchOpenChange}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="composer-branch-trigger"
                  title={`${t('wb.changes.branch')}: ${currentBranch}`}
                  className="min-w-0 max-w-[160px] font-mono text-ink-2 hover:bg-hover hover:text-ink max-md:max-w-[124px]"
                >
                  <GitBranchIcon className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate">{currentBranch}</span>
                  <ChevronDownIcon className="size-3 shrink-0 text-ink-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={6}
                className="w-64 max-w-[calc(100vw-24px)] overflow-hidden p-2"
                data-testid="composer-branch-popover"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                  <span className="truncate text-[11px] font-medium text-ink-3">
                    {t('wb.changes.switchBranch')}
                  </span>
                  {sourceControl?.remote ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="composer-branch-fetch-btn"
                      disabled={branchBusy}
                      className="shrink-0 text-ink-2 hover:text-ink"
                      onClick={() => {
                        setBranchOpen(false);
                        setBranchBusy(true);
                        postToHost({ type: 'sourceControlFetch', payload: {} });
                      }}
                    >
                      <RefreshIcon className="size-3" />
                      <span>{t('wb.changes.fetch')}</span>
                    </Button>
                  ) : null}
                </div>
                <div className="max-h-44 overflow-y-auto">
                  {branches.map((branch) => {
                    const isCurrent = branch === currentBranch;
                    return (
                      <button
                        key={branch}
                        type="button"
                        data-testid={`composer-branch-item-${branch}`}
                        disabled={branchBusy}
                        onClick={() => checkoutBranch(branch)}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-control px-2 py-1 text-left text-[12px] transition-colors hover:bg-hover',
                          isCurrent ? 'bg-field font-medium text-ink' : 'text-ink-2',
                        )}
                      >
                        <span className="truncate font-mono text-[11.5px]">{branch}</span>
                        {isCurrent ? <CheckIcon className="size-3.5 shrink-0 text-accent-ink" /> : null}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
                  <Input
                    size="xs"
                    value={newBranchName}
                    data-testid="composer-new-branch-input"
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
                    data-testid="composer-create-branch-btn"
                    aria-label={t('wb.changes.createBranch')}
                    title={t('wb.changes.createBranch')}
                    disabled={!newBranchName.trim() || branchBusy}
                    onClick={createNewBranch}
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                </div>
                <div className="mt-1.5 border-t border-line pt-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="new-worktree-session"
                    disabled={branchBusy || remoteReadOnly}
                    className="w-full min-w-0 shrink justify-start text-ink-2 hover:text-ink"
                    onClick={() => {
                      setBranchOpen(false);
                      if (onNewWorktree) {
                        onNewWorktree();
                      } else {
                        postToHost({ type: 'newWorktreeSession', payload: {} });
                      }
                    }}
                  >
                    <GitForkIcon className="size-3 shrink-0" />
                    <span className="truncate">{t('wb.sessions.worktreeSession')}</span>
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <span
              data-testid="composer-branch-readonly"
              title={`${t('wb.changes.branch')}: ${currentBranch}`}
              className="inline-flex h-6 min-w-0 max-w-[160px] items-center gap-1 rounded-md px-1.5 font-mono text-xs text-ink-3"
            >
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{currentBranch}</span>
            </span>
          )
        ) : null}
      </div>

      <div className="flex shrink-0 items-center">
        <UsageBadge />
      </div>
    </div>
  );
}

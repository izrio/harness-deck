/**
 * 会话输入框下方的上下文状态条：
 * - 左侧：项目切换器 + Git 分支切换器（Popover 切换本地分支 / 新建分支 / 抓取）；
 * - 右侧：双圆环订阅用量标识（外环周用量、内环 5h 用量）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CloudEnvironmentStatus, CloudEnvironmentView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useT } from '../i18n.ts';
import { cn } from '../lib/utils.ts';
import { getProjectOptions } from '../lib/workbenchOptions.ts';
import { useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import {
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  CloudOffIcon,
  PencilIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from './icons.tsx';
import { CloudEnvironmentDialog } from './CloudEnvironmentDialog.tsx';
import { DeleteBranchDialog } from './DeleteBranchDialog.tsx';
import { UsageBadge } from './UsageBadge.tsx';

function cloudStatusDotClass(status: CloudEnvironmentStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-ok';
    case 'connecting':
    case 'reconnecting':
      return 'bg-warn animate-pulse';
    case 'error':
      return 'bg-err';
    default:
      return 'bg-ink-3/45';
  }
}

export function ComposerFooter({ onNewWorktree }: { readonly onNewWorktree?: () => void } = {}) {
  const t = useT();
  const projects = useView((s) => s.projects);
  const sourceControl = useView((s) => s.workbench.sourceControl);
  const activeTab = useView((s) => s.tabs.items.find((item) => item.key === s.tabs.active));
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);

  const [projectOpen, setProjectOpen] = useState(false);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const [editingCloudEnv, setEditingCloudEnv] = useState<CloudEnvironmentView | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<string | null>(null);
  const lastActionAtRef = useRef<number | undefined>(undefined);

  const isMobileRemote = clientSurface === 'mobile-web';
  const canManageCloud = !isMobileRemote || clientScope === 'owner';
  const remoteReadOnly = isMobileRemote && clientScope === 'read-only';

  const projectOptions = useMemo(() => getProjectOptions(projects), [projects]);
  const cloudEnvironments = projects.cloudEnvironments ?? [];
  const activeCloud = projects.activeEnvironment?.kind === 'cloud' ? projects.activeEnvironment : undefined;
  const cloudRecent = projects.cloudRecent ?? [];
  const currentProjectPath = projects.currentPath ?? sourceControl?.root;
  const currentProjectName = useMemo(() => {
    if (currentProjectPath) {
      const hit = projectOptions.find(([p]) => p === currentProjectPath);
      if (hit) return hit[1];
      return currentProjectPath.split(/[\\/]/u).pop() || currentProjectPath;
    }
    return undefined;
  }, [currentProjectPath, projectOptions]);

  const activeCloudLabel = activeCloud
    ? (activeCloud.remoteProjectName
        ? `${activeCloud.name} · ${activeCloud.remoteProjectName}`
        : activeCloud.name)
    : undefined;
  const triggerLabel = activeCloudLabel ?? currentProjectName;
  const triggerTitle = activeCloud
    ? `${activeCloud.name} (${activeCloud.remoteProjectPath ?? activeCloud.endpointUrl})`
    : (currentProjectPath ?? currentProjectName);

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
    if (!activeCloud && path === currentProjectPath) return;
    postToHost({ type: 'openProject', payload: { path, inPlace: true } });
  };

  const handleSelectCloudEnv = (env: CloudEnvironmentView): void => {
    setProjectOpen(false);
    if (activeCloud?.envId === env.id && env.status === 'connected') return;
    if (!env.hasCredentials) {
      setEditingCloudEnv(env);
      setCloudDialogOpen(true);
      return;
    }
    postToHost({ type: 'connectCloudEnvironment', payload: { id: env.id } });
  };

  const handleDisconnectCloud = (): void => {
    setProjectOpen(false);
    postToHost({ type: 'disconnectCloudEnvironment', payload: {} });
  };

  const handleSwitchCloudFolder = (path: string): void => {
    setProjectOpen(false);
    if (path === activeCloud?.remoteProjectPath) return;
    postToHost({ type: 'switchCloudProject', payload: { path } });
  };

  const openAddCloudDialog = (): void => {
    setProjectOpen(false);
    setEditingCloudEnv(null);
    setCloudDialogOpen(true);
  };

  const openEditCloudDialog = (env: CloudEnvironmentView): void => {
    setProjectOpen(false);
    setEditingCloudEnv(env);
    setCloudDialogOpen(true);
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

  const requestDeleteBranch = (branch: string): void => {
    if (branchBusy || remoteReadOnly || branch === currentBranch) return;
    setBranchOpen(false);
    setDeleteBranchTarget(branch);
  };

  const confirmDeleteBranch = (branch: string, force: boolean): void => {
    if (branchBusy || remoteReadOnly || branch === currentBranch) return;
    setDeleteBranchTarget(null);
    setBranchBusy(true);
    postToHost({
      type: 'sourceControlDeleteBranch',
      payload: { branch, force, confirmed: true },
    });
  };

  const showProject = Boolean(triggerLabel || projectOptions.length > 0 || cloudEnvironments.length > 0 || canManageCloud);
  const showBranch = Boolean(currentBranch);
  const canSwitchBranch = Boolean(sourceControl?.available && !remoteReadOnly);

  const cloudStatusLabel = (status: CloudEnvironmentStatus): string => {
    switch (status) {
      case 'connected':
        return t('cloud.status.connected');
      case 'connecting':
        return t('cloud.status.connecting');
      case 'reconnecting':
        return t('cloud.status.reconnecting');
      case 'error':
        return t('cloud.status.error');
      default:
        return t('cloud.status.disconnected');
    }
  };

  return (
    <div
      className={cn(
        'composer-footer flex min-w-0 items-center justify-between gap-2 px-1 pt-0.5 pb-2 max-md:pt-1 max-md:pb-3',
        isMobileRemote && 'pt-1 pb-3',
      )}
      data-testid="composer-footer"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {showProject ? (
          <Popover open={projectOpen} onOpenChange={setProjectOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={remoteReadOnly}
                data-testid="composer-project-trigger"
                title={triggerTitle}
                className={cn(
                  'min-w-0 max-w-[200px] gap-1.5 px-2 leading-4 text-ink-2 hover:bg-hover hover:text-ink max-md:max-w-[144px]',
                  activeCloud && 'text-ink',
                )}
              >
                {activeCloud ? (
                  <span className="relative inline-flex shrink-0 items-center">
                    <CloudIcon className="size-3.5 text-accent-ink" />
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-surface',
                        cloudStatusDotClass(activeCloud.status),
                      )}
                    />
                  </span>
                ) : (
                  <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
                )}
                <span className="min-w-0 truncate leading-4">{triggerLabel ?? t('composer.switchProject')}</span>
                {!remoteReadOnly ? <ChevronDownIcon className="-ml-0.5 size-3 shrink-0 text-ink-3" /> : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={6}
              className="w-72 p-1.5"
              data-testid="composer-project-popover"
            >
              <ScrollArea className="max-h-72">
                <div className="flex flex-col gap-1">
                  <div className="px-2 pt-0.5 text-[11px] font-medium text-ink-3">
                    {t('composer.localProjects')}
                  </div>
                  {projectOptions.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {projectOptions.map(([path, name]) => {
                        const isCurrent = !activeCloud && path === currentProjectPath;
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
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                    <div className="px-2 py-1 text-[11.5px] text-ink-3">{t('composer.noProjects')}</div>
                  )}

                  {canManageCloud || cloudEnvironments.length > 0 ? (
                    <div className="mt-1 border-t border-line pt-1.5" data-testid="composer-cloud-section">
                      <div className="mb-1 flex items-center justify-between gap-2 px-2 text-[11px] font-medium text-ink-3">
                        <span>{t('composer.cloudEnvironments')}</span>
                        {activeCloud ? (
                          <span className="text-[10.5px] font-normal text-ink-2">
                            {cloudStatusLabel(activeCloud.status)}
                          </span>
                        ) : null}
                      </div>

                      {cloudEnvironments.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {cloudEnvironments.map((env) => {
                            const isCurrent = activeCloud?.envId === env.id;
                            const subtitle = env.error
                              ? env.error
                              : (env.remoteProjectPath ?? env.endpointUrl);
                            return (
                              <div key={env.id} className="flex flex-col gap-0.5">
                                <div
                                  className={cn(
                                    'group flex w-full items-center gap-1 rounded-control px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-hover',
                                    isCurrent ? 'bg-field font-medium text-ink' : 'text-ink-2',
                                  )}
                                >
                                  <button
                                    type="button"
                                    data-testid={`composer-cloud-item-${env.id}`}
                                    title={`${env.name} · ${env.endpointUrl}`}
                                    onClick={() => handleSelectCloudEnv(env)}
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                  >
                                    <span className="relative inline-flex shrink-0 items-center">
                                      <CloudIcon
                                        className={cn(
                                          'size-3.5',
                                          isCurrent ? 'text-accent-ink' : 'text-ink-3',
                                        )}
                                      />
                                      <span
                                        aria-hidden="true"
                                        className={cn(
                                          'absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-surface',
                                          cloudStatusDotClass(env.status),
                                        )}
                                      />
                                    </span>
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                      <span className="block truncate leading-4">
                                        {env.remoteProjectName ? `${env.name} · ${env.remoteProjectName}` : env.name}
                                      </span>
                                      <span
                                        className={cn(
                                          'block truncate font-mono text-[10px] leading-3.5',
                                          env.error ? 'text-err' : 'text-ink-3',
                                        )}
                                      >
                                        {subtitle}
                                      </span>
                                    </span>
                                  </button>
                                  {canManageCloud ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-xs"
                                      data-testid={`composer-cloud-edit-${env.id}`}
                                      aria-label={t('composer.editCloud')}
                                      title={t('composer.editCloud')}
                                      onClick={() => openEditCloudDialog(env)}
                                      className="shrink-0 text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
                                    >
                                      <PencilIcon className="size-3" />
                                    </Button>
                                  ) : null}
                                  {isCurrent ? <CheckIcon className="size-3.5 shrink-0 text-accent-ink" /> : null}
                                </div>

                                {isCurrent && cloudRecent.length > 1 ? (
                                  <div className="ml-4 flex flex-col gap-0.5 border-l border-line pl-2">
                                    <div className="px-1.5 pt-0.5 text-[10px] font-medium text-ink-3">
                                      {t('composer.cloudFolders')}
                                    </div>
                                    {cloudRecent.map((remoteProj) => {
                                      const isRemoteCurrent = remoteProj.path === activeCloud.remoteProjectPath;
                                      return (
                                        <button
                                          key={remoteProj.path}
                                          type="button"
                                          onClick={() => handleSwitchCloudFolder(remoteProj.path)}
                                          title={remoteProj.path}
                                          className={cn(
                                            'flex w-full items-center justify-between gap-1.5 rounded-control px-1.5 py-1 text-left text-[11.5px] transition-colors hover:bg-hover',
                                            isRemoteCurrent ? 'bg-field/70 font-medium text-ink' : 'text-ink-2',
                                          )}
                                        >
                                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                            <FolderIcon className="size-3 shrink-0 text-ink-3" />
                                            <span className="truncate">{remoteProj.name}</span>
                                          </span>
                                          {isRemoteCurrent ? (
                                            <CheckIcon className="size-3 shrink-0 text-accent-ink" />
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="px-2 py-1 text-[11.5px] text-ink-3">
                          {t('composer.noCloudEnvironments')}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </ScrollArea>

              {canManageCloud || activeCloud ? (
                <div className="mt-1.5 flex flex-col gap-0.5 border-t border-line pt-1.5">
                  {activeCloud ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="composer-disconnect-cloud"
                      className="w-full justify-start gap-2 px-2 text-ink-2 hover:text-ink"
                      onClick={handleDisconnectCloud}
                    >
                      <CloudOffIcon className="size-3.5 shrink-0" />
                      <span>{t('composer.disconnectCloud')}</span>
                    </Button>
                  ) : null}
                  {!isMobileRemote ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="composer-add-project"
                      className="w-full justify-start gap-2 px-2 text-ink-2 hover:text-ink"
                      onClick={() => {
                        setProjectOpen(false);
                        postToHost({ type: 'addRecentProject', payload: {} });
                      }}
                    >
                      <PlusIcon className="size-3.5 shrink-0" />
                      <span>{t('wb.sessions.addProject')}</span>
                    </Button>
                  ) : null}
                  {canManageCloud ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="composer-add-cloud-env"
                      className="w-full justify-start gap-2 px-2 text-accent-ink hover:text-accent-ink"
                      onClick={openAddCloudDialog}
                    >
                      <CloudIcon className="size-3.5 shrink-0" />
                      <span>{t('composer.connectCloud')}</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        ) : null}

        {activeCloud && activeCloud.status !== 'connected' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="composer-cloud-status-pill"
            onClick={() => {
              const target = cloudEnvironments.find((e) => e.id === activeCloud.envId);
              if (activeCloud.status === 'error' && target && canManageCloud) {
                openEditCloudDialog(target);
              } else {
                setProjectOpen(true);
              }
            }}
            className={cn(
              'shrink-0 gap-1 px-1.5 text-[11px]',
              activeCloud.status === 'error' ? 'text-err hover:text-err' : 'text-warn hover:text-warn',
            )}
            title={activeCloud.error ?? cloudStatusLabel(activeCloud.status)}
          >
            <span>{cloudStatusLabel(activeCloud.status)}</span>
          </Button>
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
                  className="min-w-0 max-w-[160px] gap-1.5 px-2 font-mono leading-4 text-ink-2 hover:bg-hover hover:text-ink max-md:max-w-[124px]"
                >
                  <GitBranchIcon className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate leading-4">{currentBranch}</span>
                  <ChevronDownIcon className="-ml-0.5 size-3 shrink-0 text-ink-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={6}
                className="w-64 max-w-[calc(100vw-24px)] overflow-hidden p-1.5"
                data-testid="composer-branch-popover"
              >
                <div className="mb-1 flex items-center justify-between gap-2 px-2 pt-0.5">
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
                <ScrollArea className="max-h-44">
                  <div className="flex flex-col gap-0.5">
                    {branches.map((branch) => {
                      const isCurrent = branch === currentBranch;
                      if (isCurrent) {
                        return (
                          <button
                            key={branch}
                            type="button"
                            data-testid={`composer-branch-item-${branch}`}
                            disabled={branchBusy}
                            onClick={() => checkoutBranch(branch)}
                            className="flex w-full items-center justify-between gap-2 rounded-control bg-field px-2 py-1.5 text-left text-[12px] leading-4 font-medium text-ink transition-colors hover:bg-hover"
                          >
                            <span className="truncate font-mono text-[11.5px] leading-4">{branch}</span>
                            <CheckIcon className="size-3.5 shrink-0 text-accent-ink" />
                          </button>
                        );
                      }
                      return (
                        <div
                          key={branch}
                          className="group/branch flex items-center gap-0.5 rounded-control transition-colors hover:bg-hover"
                        >
                          <button
                            type="button"
                            data-testid={`composer-branch-item-${branch}`}
                            disabled={branchBusy}
                            onClick={() => checkoutBranch(branch)}
                            className="flex min-w-0 flex-1 items-center rounded-control px-2 py-1.5 text-left text-[12px] leading-4 text-ink-2 transition-colors hover:text-ink"
                          >
                            <span className="truncate font-mono text-[11.5px] leading-4">{branch}</span>
                          </button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            data-testid={`composer-branch-delete-${branch}`}
                            disabled={branchBusy}
                            aria-label={t('wb.changes.deleteBranchNamed', branch)}
                            title={t('wb.changes.deleteBranch')}
                            onClick={() => requestDeleteBranch(branch)}
                            className="shrink-0 text-ink-3/65 transition-colors hover:bg-red-tint hover:text-red group-hover/branch:text-ink-2"
                          >
                            <TrashIcon className="size-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
                <div className="mt-1.5 flex items-center gap-1 border-t border-line pt-1.5">
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
                    className="w-full min-w-0 shrink justify-start gap-2 px-2 text-ink-2 hover:text-ink"
                    onClick={() => {
                      setBranchOpen(false);
                      if (onNewWorktree) {
                        onNewWorktree();
                      } else {
                        postToHost({ type: 'newWorktreeSession', payload: {} });
                      }
                    }}
                  >
                    <GitForkIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{t('wb.sessions.worktreeSession')}</span>
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <span
              data-testid="composer-branch-readonly"
              title={`${t('wb.changes.branch')}: ${currentBranch}`}
              className="inline-flex h-6 min-w-0 max-w-[160px] items-center gap-1.5 rounded-md px-2 font-mono text-xs leading-4 text-ink-3"
            >
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate leading-4">{currentBranch}</span>
            </span>
          )
        ) : null}
      </div>

      <div className="flex shrink-0 items-center">
        <UsageBadge />
      </div>

      <DeleteBranchDialog
        branch={deleteBranchTarget}
        busy={branchBusy}
        testIdPrefix="composer-delete-branch"
        onOpenChange={(open) => !open && setDeleteBranchTarget(null)}
        onConfirm={confirmDeleteBranch}
      />
      <CloudEnvironmentDialog
        open={cloudDialogOpen}
        onOpenChange={setCloudDialogOpen}
        editing={editingCloudEnv}
      />
    </div>
  );
}

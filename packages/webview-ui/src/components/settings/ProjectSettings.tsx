/**
 * 设置 -> 项目：
 * macOS 设置风格：无外框浅底圆角卡片 + 卡片内缩极细横线分割 + 宽松行距呼吸感。
 */
import { useEffect, useRef, useState } from 'react';
import type { WorktreeProjectConfig } from '@harness-deck/shared';
import { SettingsSection } from './SettingsSection.tsx';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setProjectsLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { CheckIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, MoreIcon, PlusIcon, TerminalIcon, TrashIcon } from '../icons.tsx';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const EMPTY_CONFIG: WorktreeProjectConfig = {
  copyFiles: [],
  setupCommands: [],
  verifyCommands: [],
};

function toLines(items: readonly string[]): string {
  return items.join('\n');
}

function fromLines(raw: string): string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ProjectSettings() {
  const t = useT();
  const projects = useView((s) => s.projects);
  const clientSurface = useView((s) => s.clientSurface);
  const isMobileRemote = clientSurface === 'mobile-web';
  const folder = useView((s) => s.session.folder);
  const [createWtOpen, setCreateWtOpen] = useState(false);
  const [createWtBranch, setCreateWtBranch] = useState('');
  const [removeWtOpen, setRemoveWtOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(() => projects.currentPath ?? projects.recent[0]?.path);
  const activePath =
    selectedPath && projects.recent.some((r) => r.path === selectedPath)
      ? selectedPath
      : (projects.currentPath ?? projects.recent[0]?.path);
  const activeProject = projects.recent.find((r) => r.path === activePath);

  const savedConfig = (activePath ? projects.configs[activePath] : undefined) ?? EMPTY_CONFIG;
  const [copyFilesText, setCopyFilesText] = useState(() => toLines(savedConfig.copyFiles));
  const [setupText, setSetupText] = useState(() => toLines(savedConfig.setupCommands));
  const [verifyText, setVerifyText] = useState(() => toLines(savedConfig.verifyCommands));
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  useEffect(() => {
    const cfg = (activePath ? projects.configs[activePath] : undefined) ?? EMPTY_CONFIG;
    setCopyFilesText(toLines(cfg.copyFiles));
    setSetupText(toLines(cfg.setupCommands));
    setVerifyText(toLines(cfg.verifyCommands));
    setJustSaved(false);
  }, [activePath, projects.configs]);

  const saveConfig = () => {
    if (!activePath) return;
    const copyFiles = fromLines(copyFilesText);
    const setupCommands = fromLines(setupText);
    const verifyCommands = fromLines(verifyText);
    const nextConfig: WorktreeProjectConfig = { copyFiles, setupCommands, verifyCommands };
    setProjectsLocal({
      ...projects,
      configs: { ...projects.configs, [activePath]: nextConfig },
    });
    postToHost({
      type: 'setProjectWorktreeConfig',
      payload: { path: activePath, copyFiles, setupCommands, verifyCommands },
    });
    setJustSaved(true);
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setJustSaved(false), 1800);
  };

  return (
    <div className="flex flex-col gap-8" data-testid="settings-projects">
      <SettingsSection
        title={t('settings.projects.recent')}
        actions={
          !isMobileRemote ? (
            <>
              {folder ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-ink-2 hover:text-ink"
                  data-testid="project-switch-folder-btn"
                  onClick={() => postToHost({ type: 'selectFolder', payload: {} })}
                >
                  <FolderIcon className="size-3.5 text-ink-3" />
                  <span>{t('header.folder')}</span>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="project-add-btn"
                onClick={() => postToHost({ type: 'addRecentProject', payload: {} })}
              >
                <PlusIcon className="size-3.5" />
                <span>{t('settings.projects.add')}</span>
              </Button>
            </>
          ) : undefined
        }
      >
        {projects.recent.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-ink-3" data-testid="projects-empty">
            {t('settings.projects.empty')}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-line/55 px-4">
            {projects.recent.map((project, index) => {
              const selected = project.path === activePath;
              return (
                <div
                  key={project.path}
                  data-testid={`recent-project-${index}`}
                  className="flex items-center gap-3.5 py-3.5"
                >
                  <button
                    type="button"
                    className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                    onClick={() => setSelectedPath(project.path)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
                        selected
                          ? 'bg-accent-tint/70 text-accent-ink'
                          : 'bg-canvas/80 text-ink-3 group-hover:text-ink-2 dark:bg-page/55',
                      )}
                    >
                      <FolderIcon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span
                          className={cn(
                            'truncate text-[13px] leading-5 transition-colors',
                            selected ? 'font-semibold text-ink' : 'font-medium text-ink-2 group-hover:text-ink',
                          )}
                        >
                          {project.name}
                        </span>
                        {project.isCurrent ? (
                          <span className="inline-flex items-center rounded-md bg-canvas/85 px-1.5 py-0.5 text-[10.5px] leading-4 font-medium text-ink-2 dark:bg-page/55">
                            {t('settings.projects.current')}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11.5px] leading-4 text-ink-3">
                        {project.path}
                      </span>
                    </span>
                    {selected && projects.recent.length > 1 ? (
                      <CheckIcon className="size-3.5 shrink-0 text-accent-ink" />
                    ) : null}
                  </button>
                  {!isMobileRemote ? (
                    <div className="shrink-0">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-ink-2 hover:text-ink"
                            data-testid={`project-actions-${index}`}
                            aria-label={t('common.moreActions')}
                            title={t('common.moreActions')}
                          >
                            <MoreIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-36">
                          {!project.isCurrent ? (
                            <>
                              <DropdownMenuItem
                                className="gap-2 text-[12.5px]"
                                data-testid={`project-open-${index}`}
                                onSelect={() => postToHost({ type: 'openProject', payload: { path: project.path } })}
                              >
                                <FolderOpenIcon className="size-3.5 text-ink-2" />
                                <span>{t('settings.projects.open')}</span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          ) : null}
                          <DropdownMenuItem
                            variant="destructive"
                            className="gap-2 text-[12.5px]"
                            data-testid={`project-remove-${index}`}
                            onSelect={() => postToHost({ type: 'removeRecentProject', payload: { path: project.path } })}
                          >
                            <TrashIcon className="size-3.5" />
                            <span>{t('settings.projects.remove')}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {activePath ? (
        <SettingsSection
          title={t('settings.projects.worktreeTitle')}
          testId="project-worktree-editor"
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-ink-2 hover:text-ink"
                data-testid="project-create-wt-btn"
                onClick={() => {
                  if (isMobileRemote) {
                    setCreateWtBranch('');
                    setCreateWtOpen(true);
                  } else {
                    postToHost({ type: 'createWorktree', payload: { path: activePath } });
                  }
                }}
              >
                <GitBranchIcon className="size-3" />
                <span>{t('settings.projects.createWorktree')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-ink-2 hover:text-ink"
                data-testid="project-remove-wt-btn"
                onClick={() => {
                  if (isMobileRemote) {
                    setRemoveWtOpen(true);
                  } else {
                    postToHost({ type: 'removeWorktree', payload: { path: activePath } });
                  }
                }}
              >
                <TrashIcon className="size-3" />
                <span>{t('settings.projects.removeWorktree')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-ink-2 hover:text-ink"
                data-testid="project-run-verify-btn"
                onClick={() => postToHost({ type: 'runProjectVerify', payload: { path: activePath } })}
              >
                <TerminalIcon className="size-3" />
                <span>{t('settings.projects.runVerify')}</span>
              </Button>
            </>
          }
        >
          <div className="flex flex-col divide-y divide-line/55 px-4">
            <label className="flex flex-col gap-2 py-4">
              <span className="text-[13px] leading-5 font-medium text-ink">{t('settings.projects.copyFiles')}</span>
              <Textarea
                data-testid="project-copy-files"
                rows={2}
                className="min-h-14 resize-none rounded-xl border-line/60 bg-canvas/70 px-3 py-2.5 font-mono text-[12px] leading-relaxed shadow-none dark:bg-page/45"
                disabled={isMobileRemote}
                value={copyFilesText}
                placeholder={t('settings.projects.copyFilesPlaceholder')}
                onChange={(e) => setCopyFilesText(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-2 py-4">
              <span className="text-[13px] leading-5 font-medium text-ink">{t('settings.projects.setupCommands')}</span>
              <Textarea
                data-testid="project-setup-commands"
                rows={2}
                className="min-h-14 resize-none rounded-xl border-line/60 bg-canvas/70 px-3 py-2.5 font-mono text-[12px] leading-relaxed shadow-none dark:bg-page/45"
                disabled={isMobileRemote}
                value={setupText}
                placeholder={t('settings.projects.setupCommandsPlaceholder')}
                onChange={(e) => setSetupText(e.target.value)}
              />
            </label>

            <label className="flex flex-col gap-2 py-4">
              <span className="text-[13px] leading-5 font-medium text-ink">{t('settings.projects.verifyCommands')}</span>
              <Textarea
                data-testid="project-verify-commands"
                rows={2}
                className="min-h-14 resize-none rounded-xl border-line/60 bg-canvas/70 px-3 py-2.5 font-mono text-[12px] leading-relaxed shadow-none dark:bg-page/45"
                disabled={isMobileRemote}
                value={verifyText}
                placeholder={t('settings.projects.verifyCommandsPlaceholder')}
                onChange={(e) => setVerifyText(e.target.value)}
              />
            </label>

            {!isMobileRemote ? (
              <div className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
                  {justSaved ? (
                    <span className="inline-flex items-center gap-1.5 text-green">
                      <CheckIcon className="size-3.5 shrink-0" />
                      <span>{t('settings.projects.saved')}</span>
                    </span>
                  ) : activeProject ? (
                    <span className="truncate font-mono text-[11.5px]">{activeProject.name}</span>
                  ) : null}
                </div>
                <Button type="button" size="sm" data-testid="project-save-btn" onClick={saveConfig}>
                  {t('settings.projects.saveConfig')}
                </Button>
              </div>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}

      <Dialog open={createWtOpen} onOpenChange={setCreateWtOpen}>
        <DialogContent data-testid="mobile-create-worktree-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.worktreeCreateTitle')}</DialogTitle>
            <DialogDescription className="sr-only">{t('mobile.confirm.worktreePlaceholder')}</DialogDescription>
          </DialogHeader>
          <Input
            size="sm"
            data-testid="mobile-create-worktree-input"
            value={createWtBranch}
            placeholder={t('mobile.confirm.worktreePlaceholder')}
            onChange={(e) => setCreateWtBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && activePath) {
                postToHost({ type: 'createWorktree', payload: { path: activePath, branch: createWtBranch.trim() } });
                setCreateWtOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setCreateWtOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="mobile-create-worktree-confirm"
              onClick={() => {
                if (!activePath) return;
                postToHost({ type: 'createWorktree', payload: { path: activePath, branch: createWtBranch.trim() } });
                setCreateWtOpen(false);
              }}
            >
              {t('settings.projects.createWorktree')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeWtOpen} onOpenChange={setRemoveWtOpen}>
        <DialogContent data-testid="mobile-remove-worktree-dialog">
          <DialogHeader>
            <DialogTitle>{t('mobile.confirm.removeWorktreeTitle')}</DialogTitle>
            <DialogDescription>
              {t('mobile.confirm.removeWorktreeDetail', activePath ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setRemoveWtOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="mobile-remove-worktree-confirm"
              onClick={() => {
                if (!activePath) return;
                postToHost({ type: 'removeWorktree', payload: { path: activePath, confirmed: true } });
                setRemoveWtOpen(false);
              }}
            >
              {t('settings.projects.removeWorktree')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

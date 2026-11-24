/**
 * 设置 -> 扩展 -> 技能（Agent Skills，SKILL.md）：
 * 从 Git 仓库扫描并安装包含 SKILL.md 的技能目录，配置启用状态与目标 Agent，
 * Agent 启动时自动带上并支持在输入框通过 / 调用。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InstalledSkillView, SkillImportCandidate } from '@harness-deck/shared';
import { SKILL_MARKET_CATALOG, type SkillMarketCategory, type SkillMarketEntry } from './skillCatalog.ts';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { requestMarkdownPreview, setExtensionsLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  CheckIcon,
  DownloadIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  MoreIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshIcon,
  SearchIcon,
  SparklesIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import { FALLBACK_BACKENDS } from '@/lib/workbenchOptions';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

function formatInstalls(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/u, '')}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/u, '')}k`;
  return String(count);
}

const MARKET_CATEGORIES: readonly { readonly id: 'all' | SkillMarketCategory; readonly labelKey: MessageKey }[] = [
  { id: 'all', labelKey: 'settings.skills.market.catAll' },
  { id: 'frontend', labelKey: 'settings.skills.market.catFrontend' },
  { id: 'dev', labelKey: 'settings.skills.market.catDev' },
  { id: 'docs', labelKey: 'settings.skills.market.catDocs' },
  { id: 'design', labelKey: 'settings.skills.market.catDesign' },
];

function shortRepoLabel(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\/github\.com\//iu, '')
    .replace(/^git@github\.com:/iu, '')
    .replace(/\.git$/iu, '');
}

export function SkillSettings() {
  const t = useT();
  const locale = useView((s) => s.locale);
  const extensions = useView((s) => s.extensions);
  const backendItems = useView((s) => s.backends.items);
  const agents = backendItems.length > 0 ? backendItems : FALLBACK_BACKENDS;
  const { skills } = extensions;

  const [activeTab, setActiveTab] = useState<'installed' | 'market'>('installed');
  const [marketQuery, setMarketQuery] = useState('');
  const [marketCategory, setMarketCategory] = useState<'all' | SkillMarketCategory>('all');
  const [installingMarketId, setInstallingMarketId] = useState<string | undefined>();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [ref, setRef] = useState('');
  const [subpath, setSubpath] = useState('');
  const [selectedSubpaths, setSelectedSubpaths] = useState<string[]>([]);
  const [allAgentsMode, setAllAgentsMode] = useState(true);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingInstall, setPendingInstall] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [selectedImportKeys, setSelectedImportKeys] = useState<string[]>([]);
  const [importAllAgents, setImportAllAgents] = useState(true);
  const [importAgents, setImportAgents] = useState<string[]>([]);

  useEffect(() => {
    if (skills.scanned) {
      setSelectedSubpaths(skills.scanned.skills.map((item) => item.subpath));
    }
  }, [skills.scanned]);

  useEffect(() => {
    if (!skills.importCandidates) return;
    setSelectedImportKeys(skills.importCandidates.filter((c) => !c.conflict).map((c) => c.key));
  }, [skills.importCandidates]);

  useEffect(() => {
    if (!pendingInstall) return;
    if (skills.installing) return;
    setPendingInstall(false);
    if (!skills.error) {
      setDialogOpen(false);
    }
  }, [pendingInstall, skills.installing, skills.error]);

  const openInstallDialog = () => {
    setFormError(undefined);
    setRepoUrl('');
    setRef('');
    setSubpath('');
    setSelectedSubpaths([]);
    setAllAgentsMode(true);
    setSelectedAgents(agents.map((a) => a.id));
    setPendingInstall(false);
    setDialogOpen(true);
  };

  const closeInstallDialog = () => {
    if (skills.installing) return;
    setDialogOpen(false);
    setFormError(undefined);
    setPendingInstall(false);
  };

  const handleScan = () => {
    const cleanRepo = repoUrl.trim();
    if (!cleanRepo) {
      setFormError(t('settings.skills.dialog.validation'));
      return;
    }
    setFormError(undefined);
    const cleanRef = ref.trim();
    const cleanSubpath = subpath.trim();
    postToHost({
      type: 'scanGitSkills',
      payload: {
        repoUrl: cleanRepo,
        ...(cleanRef ? { ref: cleanRef } : {}),
        ...(cleanSubpath ? { subpath: cleanSubpath } : {}),
      },
    });
  };

  const discovered = skills.scanned?.skills ?? [];
  const hasScannedList = dialogOpen && skills.scanned !== undefined && discovered.length > 0;

  const toggleDiscoveredSubpath = (sp: string) => {
    setSelectedSubpaths((prev) => (prev.includes(sp) ? prev.filter((item) => item !== sp) : [...prev, sp]));
  };

  const toggleDialogAgent = (agentId: string) => {
    if (allAgentsMode) {
      setAllAgentsMode(false);
      setSelectedAgents([agentId]);
      return;
    }
    const next = selectedAgents.includes(agentId)
      ? selectedAgents.filter((id) => id !== agentId)
      : [...selectedAgents, agentId];
    if (next.length === 0) {
      setAllAgentsMode(true);
    } else {
      setSelectedAgents(next);
    }
  };

  const handleInstall = () => {
    const cleanRepo = repoUrl.trim();
    if (!cleanRepo) {
      setFormError(t('settings.skills.dialog.validation'));
      return;
    }
    setFormError(undefined);
    setPendingInstall(true);
    const cleanRef = ref.trim();
    const cleanSubpath = subpath.trim();
    postToHost({
      type: 'installGitSkills',
      payload: {
        repoUrl: cleanRepo,
        ...(cleanRef ? { ref: cleanRef } : {}),
        ...(cleanSubpath ? { subpath: cleanSubpath } : {}),
        ...(hasScannedList ? { selectedSubpaths } : {}),
        ...(!allAgentsMode && selectedAgents.length > 0 ? { agents: selectedAgents } : {}),
      },
    });
  };

  const updateSkillLocalAndHost = (
    skill: InstalledSkillView,
    patch: { readonly enabled?: boolean; readonly agents?: readonly string[] | null },
  ) => {
    const nextItems = skills.items.map((item) => {
      if (item.id !== skill.id) return item;
      const nextAgents =
        patch.agents === undefined ? item.agents : patch.agents && patch.agents.length > 0 ? patch.agents : undefined;
      const { agents: _prevAgents, ...rest } = item;
      return {
        ...rest,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(nextAgents ? { agents: nextAgents } : {}),
      };
    });
    setExtensionsLocal({
      ...extensions,
      skills: { ...skills, items: nextItems },
    });
    postToHost({
      type: 'updateSkill',
      payload: {
        id: skill.id,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.agents !== undefined ? { agents: patch.agents ? [...patch.agents] : null } : {}),
      },
    });
  };

  const toggleSkillAgent = (skill: InstalledSkillView, agentId: string) => {
    const current = skill.agents ?? [];
    if (current.length === 0) {
      updateSkillLocalAndHost(skill, { agents: [agentId] });
      return;
    }
    const next = current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId];
    updateSkillLocalAndHost(skill, { agents: next.length > 0 ? next : null });
  };

  useEffect(() => {
    if (!skills.installing) {
      setInstallingMarketId(undefined);
    }
  }, [skills.installing]);

  const marketRetriedRef = useRef(false);

  useEffect(() => {
    if (activeTab !== 'market') {
      marketRetriedRef.current = false;
      return;
    }
    if (!skills.market) {
      postToHost({ type: 'fetchSkillMarket', payload: {} });
      return;
    }
    if (skills.market.source === 'fallback' && !skills.market.loading && !marketRetriedRef.current) {
      marketRetriedRef.current = true;
      const q = marketQuery.trim();
      postToHost({ type: 'fetchSkillMarket', payload: { ...(q ? { query: q } : {}), force: true } });
    }
  }, [activeTab, skills.market, marketQuery]);

  useEffect(() => {
    if (activeTab !== 'market' || !skills.market) return;
    const trimmed = marketQuery.trim();
    if (trimmed.length === 1) return;
    if (trimmed === (skills.market.query ?? '')) return;
    const timer = window.setTimeout(() => {
      postToHost({ type: 'fetchSkillMarket', payload: trimmed ? { query: trimmed } : {} });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeTab, marketQuery, skills.market]);

  const marketItems = useMemo(() => {
    if (skills.market) {
      if (skills.market.items.length > 0 || (skills.market.source === 'online' && skills.market.query)) {
        return skills.market.items;
      }
    }
    return SKILL_MARKET_CATALOG;
  }, [skills.market]);
  const marketLoading = Boolean(skills.market?.loading);
  const marketSource = skills.market?.source;

  const installedNames = new Set(skills.items.map((item) => item.name.toLowerCase()));
  const importCandidates: readonly SkillImportCandidate[] = skills.importCandidates ?? [];
  const selectedImportCandidates = importCandidates.filter((c) => selectedImportKeys.includes(c.key));

  const filteredMarket = useMemo(() => {
    const q = marketQuery.trim().toLowerCase();
    const serverMatched =
      skills.market?.source === 'online' &&
      Boolean(q) &&
      (skills.market.query?.trim().toLowerCase() ?? '') === q;
    return marketItems.filter((entry) => {
      if (marketCategory !== 'all' && entry.category !== marketCategory) return false;
      if (!q || serverMatched) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.repo.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        (entry.descZh?.toLowerCase().includes(q) ?? false) ||
        (entry.descEn?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [marketCategory, marketItems, marketQuery, skills.market?.query, skills.market?.source]);

  const installFromMarket = (entry: SkillMarketEntry) => {
    if (skills.installing) return;
    setInstallingMarketId(entry.id);
    postToHost({
      type: 'installGitSkills',
      payload: {
        repoUrl: entry.repo,
        ref: entry.ref,
        subpath: entry.subpath,
      },
    });
  };

  const openImportDialog = () => {
    setImportAllAgents(true);
    setImportAgents(agents.map((a) => a.id));
    setImportOpen(true);
    postToHost({ type: 'scanAgentSkills', payload: {} });
  };

  const toggleImportCandidate = (key: string) => {
    setSelectedImportKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const toggleImportAgent = (agentId: string) => {
    if (importAllAgents) {
      setImportAllAgents(false);
      setImportAgents([agentId]);
      return;
    }
    const next = importAgents.includes(agentId)
      ? importAgents.filter((id) => id !== agentId)
      : [...importAgents, agentId];
    if (next.length === 0) {
      setImportAllAgents(true);
    } else {
      setImportAgents(next);
    }
  };

  const submitImport = () => {
    if (selectedImportCandidates.length === 0) return;
    postToHost({
      type: 'importLocalSkills',
      payload: {
        skills: selectedImportCandidates.map((item) => ({
          sourceDir: item.sourceDir,
          importedFrom: item.sourceAgentName,
        })),
        ...(!importAllAgents && importAgents.length > 0 ? { agents: importAgents } : {}),
      },
    });
    setImportOpen(false);
  };

  return (
    <div className="flex flex-col gap-5" data-testid="settings-skills">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-1">
        <h3 className="m-0 truncate text-[13px] font-semibold tracking-tight text-ink">
          {t('settings.skills.title')}
        </h3>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-ink-2 hover:text-ink"
            data-testid="skill-import-btn"
            onClick={openImportDialog}
          >
            <DownloadIcon className="size-3.5" />
            <span>{t('settings.skills.importBtn')}</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="skill-install-btn"
            onClick={openInstallDialog}
          >
            <PlusIcon className="size-3.5" />
            <span>{t('settings.skills.installBtn')}</span>
          </Button>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'installed' | 'market')}
        className="gap-4"
      >
        <TabsList className="h-auto w-fit gap-1 rounded-xl bg-field/65 p-1 dark:bg-surface/65">
          <TabsTrigger
            value="installed"
            data-testid="skills-tab-installed"
            onClick={() => setActiveTab('installed')}
            className="flex-none gap-1.5 rounded-lg border-0 px-3 py-1.5 text-[12.5px] shadow-none data-[state=active]:bg-canvas data-[state=active]:shadow-none dark:data-[state=active]:bg-page/75"
          >
            <PuzzleIcon className="size-3.5 shrink-0" />
            <span>{t('settings.skills.tabInstalled')}</span>
            <span className="text-[11px] font-normal text-ink-3 tabular-nums">
              {skills.items.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="market"
            data-testid="skills-tab-market"
            onClick={() => setActiveTab('market')}
            className="flex-none gap-1.5 rounded-lg border-0 px-3 py-1.5 text-[12.5px] shadow-none data-[state=active]:bg-canvas data-[state=active]:shadow-none dark:data-[state=active]:bg-page/75"
          >
            <SparklesIcon className="size-3.5 shrink-0" />
            <span>{t('settings.skills.tabMarket')}</span>
            <span className="text-[11px] font-normal text-ink-3 tabular-nums">
              {marketItems.length}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="installed" className="mt-0" data-testid="skills-panel-installed">
          {skills.items.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 rounded-2xl bg-field/55 px-4 py-10 text-center text-[12px] text-ink-3 dark:bg-surface/65"
              data-testid="skills-empty"
            >
              <span>{t('settings.skills.empty')}</span>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => setActiveTab('market')}
              >
                <SparklesIcon className="size-3" />
                <span>{t('settings.skills.tabMarket')}</span>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {skills.items.map((skill) => {
                const isUniversal = !skill.agents || skill.agents.length === 0;
                const busy = skill.busy !== undefined;
                return (
                  <div
                    key={skill.id}
                    className={cn(
                      'flex flex-col gap-2.5 rounded-2xl bg-field/55 px-4 py-3.5 transition-colors hover:bg-field/80 dark:bg-surface/65 dark:hover:bg-surface/85',
                      skill.enabled ? '' : 'opacity-60',
                    )}
                    data-testid={`skill-item-${skill.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="font-mono text-[13px] font-semibold text-ink">
                            /{skill.name}
                          </span>
                          <span
                            className="inline-flex items-center gap-1 truncate font-mono text-[11px] text-ink-3"
                            title={skill.repoUrl}
                          >
                            {skill.sourceKind === 'local' ? (
                              <>
                                <FolderIcon className="size-3 shrink-0" />
                                <span>{skill.importedFrom || skill.repoUrl}</span>
                              </>
                            ) : (
                              <>
                                <GitBranchIcon className="size-3 shrink-0" />
                                <span>
                                  {shortRepoLabel(skill.repoUrl)}
                                  {skill.subpath ? `/${skill.subpath}` : ''}
                                </span>
                              </>
                            )}
                          </span>
                          {skill.ref || skill.commit ? (
                            <span className="font-mono text-[11px] text-ink-3">
                              {skill.ref ? `${skill.ref}${skill.commit ? `@${skill.commit}` : ''}` : skill.commit}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Switch
                          size="default"
                          checked={skill.enabled}
                          disabled={busy}
                          aria-label={skill.name}
                          data-testid={`toggle-skill-${skill.id}`}
                          onCheckedChange={(checked) => updateSkillLocalAndHost(skill, { enabled: checked })}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0 text-ink-2 hover:text-ink"
                              data-testid={`skill-actions-${skill.id}`}
                              aria-label={t('common.moreActions')}
                              title={t('common.moreActions')}
                            >
                              <MoreIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-40">
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              data-testid={`preview-skill-${skill.id}`}
                              onSelect={() => requestMarkdownPreview(skill.skillMdPath)}
                            >
                              <EyeIcon className="size-3.5 text-ink-2" />
                              <span>{t('settings.skills.preview')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-[12.5px]"
                              disabled={busy}
                              data-testid={`sync-skill-${skill.id}`}
                              onSelect={() => postToHost({ type: 'syncSkill', payload: { id: skill.id } })}
                            >
                              {skill.busy === 'updating' ? (
                                <SpinnerIcon className="size-3.5 text-ink-2" />
                              ) : (
                                <RefreshIcon className="size-3.5 text-ink-2" />
                              )}
                              <span>
                                {skill.busy === 'updating' ? t('settings.skills.syncing') : t('settings.skills.sync')}
                              </span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              className="gap-2 text-[12.5px]"
                              disabled={busy}
                              data-testid={`delete-skill-${skill.id}`}
                              onSelect={() => postToHost({ type: 'deleteSkill', payload: { id: skill.id } })}
                            >
                              <TrashIcon className="size-3.5" />
                              <span>{t('settings.skills.delete')}</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {skill.description ? (
                      <p className="m-0 text-[12px] leading-relaxed text-ink-2">{skill.description}</p>
                    ) : null}

                    <TooltipProvider delayDuration={150}>
                      <div
                        className="flex flex-wrap items-center gap-1"
                        role="group"
                        aria-label={t('settings.skills.agentsLabel')}
                      >
                        <button
                          type="button"
                          data-testid={`skill-agent-all-${skill.id}`}
                          aria-pressed={isUniversal}
                          onClick={() => updateSkillLocalAndHost(skill, { agents: null })}
                          className={cn(
                            'inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2 text-[11px] transition-colors',
                            isUniversal
                              ? 'bg-accent-tint/90 font-medium text-accent-ink'
                              : 'bg-transparent text-ink-3 hover:bg-canvas/75 hover:text-ink dark:hover:bg-page/50',
                          )}
                        >
                          {isUniversal ? <CheckIcon className="size-2.5" /> : null}
                          <span>{t('settings.skills.allAgents')}</span>
                        </button>
                        {agents.map((agent) => {
                          const selected = !isUniversal && Boolean(skill.agents?.includes(agent.id));
                          return (
                            <Tooltip key={agent.id}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  data-testid={`skill-agent-${skill.id}-${agent.id}`}
                                  aria-label={agent.name}
                                  aria-pressed={selected}
                                  title={agent.name}
                                  onClick={() => toggleSkillAgent(skill, agent.id)}
                                  className={cn(
                                    'relative inline-flex size-7 cursor-pointer items-center justify-center rounded-lg transition-all',
                                    selected
                                      ? 'bg-accent-tint/90'
                                      : 'opacity-40 grayscale hover:bg-canvas/75 hover:opacity-90 hover:grayscale-0 dark:hover:bg-page/50',
                                  )}
                                >
                                  <BackendLogo backend={agent} size="sm" />
                                  {selected ? (
                                    <span
                                      className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-brand ring-2 ring-field dark:ring-surface"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="px-2 py-1 text-[11px]">
                                {agent.name}
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                    </TooltipProvider>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="market" className="mt-0" data-testid="skills-panel-market">
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-44 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
                <Input
                  size="sm"
                  data-testid="skill-market-search"
                  value={marketQuery}
                  onChange={(e) => setMarketQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const q = marketQuery.trim();
                      postToHost({ type: 'fetchSkillMarket', payload: { ...(q ? { query: q } : {}), force: true } });
                    }
                  }}
                  placeholder={t('settings.skills.market.searchPlaceholder')}
                  aria-label={t('settings.skills.market.searchPlaceholder')}
                  className="pl-8 text-[12px]"
                />
              </div>
              <div className="flex items-center gap-1.5">
                {marketSource && !marketLoading ? (
                  <span
                    data-testid="skill-market-source"
                    title={skills.market?.error}
                    className={cn(
                      'px-1.5 text-[11px]',
                      marketSource === 'online' ? 'text-green' : 'text-ink-3',
                    )}
                  >
                    {marketSource === 'online'
                      ? t('settings.market.sourceOnline')
                      : t('settings.market.sourceFallback')}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-ink-2 hover:text-ink"
                  disabled={marketLoading}
                  data-testid="skill-market-refresh"
                  onClick={() => {
                    const q = marketQuery.trim();
                    postToHost({ type: 'fetchSkillMarket', payload: { ...(q ? { query: q } : {}), force: true } });
                  }}
                >
                  {marketLoading ? <SpinnerIcon className="size-3.5" /> : <RefreshIcon className="size-3.5" />}
                  <span>{t('settings.market.refresh')}</span>
                </Button>
              </div>
            </div>
            {marketSource === 'fallback' && !marketLoading && skills.market?.error ? (
              <div className="truncate px-1 text-[11px] text-ink-3" data-testid="skill-market-error">
                {skills.market.error}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              {MARKET_CATEGORIES.map((cat) => {
                const active = marketCategory === cat.id;
                return (
                  <Button
                    key={cat.id}
                    type="button"
                    variant={active ? 'secondary' : 'ghost'}
                    size="xs"
                    data-testid={`skill-market-cat-${cat.id}`}
                    onClick={() => setMarketCategory(cat.id)}
                    className={cn('rounded-full px-2.5', active ? 'font-medium text-ink' : 'text-ink-3 hover:text-ink')}
                  >
                    {t(cat.labelKey)}
                  </Button>
                );
              })}
            </div>

            {filteredMarket.length === 0 ? (
              <div className="rounded-2xl bg-field/55 px-4 py-10 text-center text-[12px] text-ink-3 dark:bg-surface/65">
                {t('settings.skills.market.empty')}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {filteredMarket.map((entry) => {
                  const installed = installedNames.has(entry.name.toLowerCase());
                  const installingThis = Boolean(skills.installing && installingMarketId === entry.id);
                  return (
                    <div
                      key={entry.id}
                      data-testid={`skill-market-item-${entry.name}`}
                      className="flex flex-col justify-between gap-3 rounded-2xl bg-field/55 p-4 transition-colors hover:bg-field/85 dark:bg-surface/65 dark:hover:bg-surface/90"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[12.5px] font-semibold text-ink">
                            /{entry.name}
                          </span>
                          {entry.installs !== undefined && entry.installs > 0 ? (
                            <span className="shrink-0 font-mono text-[10.5px] text-ink-3 tabular-nums">
                              {formatInstalls(entry.installs)}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 mb-0 line-clamp-2 text-[11.5px] leading-relaxed text-ink-2">
                          {locale === 'en'
                            ? (entry.descEn ?? entry.description)
                            : (entry.descZh ?? entry.description)}
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10.5px] text-ink-3">
                          <GitBranchIcon className="size-3 shrink-0" />
                          <span className="truncate">{entry.repo}</span>
                        </span>
                        {installed ? (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-green">
                            <CheckIcon className="size-3" />
                            <span>{t('settings.skills.market.installed')}</span>
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            className="shrink-0"
                            disabled={Boolean(skills.installing)}
                            data-testid={`skill-market-install-${entry.name}`}
                            onClick={() => installFromMarket(entry)}
                          >
                            {installingThis ? <SpinnerIcon className="size-3" /> : <DownloadIcon className="size-3" />}
                            <span>{installingThis ? t('settings.skills.dialog.installing') : t('settings.skills.market.install')}</span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeInstallDialog()}>
        {dialogOpen ? (
          <DialogContent data-testid="skill-install-dialog" aria-modal="true" className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[14px]">
                <PuzzleIcon className="size-4 text-accent-ink" />
                <span>{t('settings.skills.dialog.title')}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">{t('settings.skills.dialog.desc')}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.skills.dialog.repoUrl')}</span>
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    size="sm"
                    data-testid="skill-repo-url"
                    className="min-w-0 flex-1 font-mono text-[12px]"
                    value={repoUrl}
                    placeholder={t('settings.skills.dialog.repoUrlPlaceholder')}
                    onChange={(e) => setRepoUrl(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={Boolean(skills.scanning || skills.installing)}
                    data-testid="skill-scan-btn"
                    onClick={handleScan}
                  >
                    {skills.scanning ? <SpinnerIcon className="size-3.5" /> : <SearchIcon className="size-3.5" />}
                    <span>
                      {skills.scanning ? t('settings.skills.dialog.scanning') : t('settings.skills.dialog.scan')}
                    </span>
                  </Button>
                </div>
              </label>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.skills.dialog.ref')}</span>
                  <Input
                    size="sm"
                    data-testid="skill-repo-ref"
                    className="font-mono text-[12px]"
                    value={ref}
                    placeholder={t('settings.skills.dialog.refPlaceholder')}
                    onChange={(e) => setRef(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.skills.dialog.subpath')}</span>
                  <Input
                    size="sm"
                    data-testid="skill-repo-subpath"
                    className="font-mono text-[12px]"
                    value={subpath}
                    placeholder={t('settings.skills.dialog.subpathPlaceholder')}
                    onChange={(e) => setSubpath(e.target.value)}
                  />
                </label>
              </div>

              {hasScannedList ? (
                <div className="flex flex-col gap-1.5" data-testid="skill-discovered-list">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-ink-2">
                      {t('settings.skills.dialog.discovered', discovered.length)}
                    </span>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-[11px] text-accent-ink"
                        onClick={() => setSelectedSubpaths(discovered.map((item) => item.subpath))}
                      >
                        {t('settings.skills.dialog.selectAll')}
                      </Button>
                      <span className="text-ink-4">·</span>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-[11px] text-ink-3"
                        onClick={() => setSelectedSubpaths([])}
                      >
                        {t('settings.skills.dialog.selectNone')}
                      </Button>
                    </div>
                  </div>

                  <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-xl bg-field/55 p-2">
                    {discovered.map((item) => {
                      const checked = selectedSubpaths.includes(item.subpath);
                      const already = installedNames.has(item.name.toLowerCase());
                      return (
                        <label
                          key={item.subpath || item.name}
                          className="flex cursor-pointer items-start gap-2 rounded-lg bg-canvas/85 px-2.5 py-2 transition-colors hover:bg-canvas dark:bg-page/55"
                          data-testid={`discovered-skill-${item.name}`}
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={checked}
                            onCheckedChange={() => toggleDiscoveredSubpath(item.subpath)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[12px] font-semibold text-ink">/{item.name}</span>
                              {item.subpath ? (
                                <ValuePill className="font-mono text-[10px]">{item.subpath}</ValuePill>
                              ) : null}
                              {already ? (
                                <ValuePill tone="accent" className="text-[10px]">
                                  {t('settings.skills.dialog.alreadyInstalled')}
                                </ValuePill>
                              ) : null}
                            </div>
                            {item.description ? (
                              <p className="mt-0.5 mb-0 line-clamp-2 text-[11.5px] text-ink-3">
                                {item.description}
                              </p>
                            ) : null}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-2">
                  {t('settings.skills.dialog.targetAgents')}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="skill-install-agent-all"
                    onClick={() => setAllAgentsMode(true)}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors ${
                      allAgentsMode
                        ? 'bg-accent-tint font-medium text-accent-ink'
                        : 'bg-field/60 text-ink-2 hover:bg-hover hover:text-ink'
                    }`}
                  >
                    {allAgentsMode ? <CheckIcon className="size-3" /> : null}
                    <span>{t('settings.skills.allAgentsBtn')}</span>
                  </button>
                  {agents.map((agent) => {
                    const active = !allAgentsMode && selectedAgents.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        data-testid={`skill-install-agent-${agent.id}`}
                        onClick={() => toggleDialogAgent(agent.id)}
                        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors ${
                          active
                            ? 'bg-accent-tint font-medium text-accent-ink'
                            : 'bg-field/60 text-ink-2 hover:bg-hover hover:text-ink'
                        }`}
                      >
                        <BackendLogo backend={agent} size="sm" />
                        <span>{agent.name}</span>
                        {active ? <CheckIcon className="size-3" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {formError || skills.error ? (
                <div className="text-[11.5px] text-red" role="alert" data-testid="skill-install-error">
                  {formError ?? skills.error}
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(skills.installing)}
                data-testid="skill-install-cancel"
                onClick={closeInstallDialog}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={Boolean(skills.installing || (hasScannedList && selectedSubpaths.length === 0))}
                data-testid="skill-install-submit"
                onClick={handleInstall}
              >
                {skills.installing ? <SpinnerIcon className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
                <span>
                  {skills.installing ? t('settings.skills.dialog.installing') : t('settings.skills.dialog.install')}
                </span>
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      {/* 从本机 Agent 技能目录或本地目录导入弹窗 */}
      <Dialog open={importOpen} onOpenChange={(open) => !open && setImportOpen(false)}>
        {importOpen ? (
          <DialogContent data-testid="skill-import-dialog" aria-modal="true" className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[14px]">
                <DownloadIcon className="size-4 text-accent-ink" />
                <span>{t('settings.skills.import.title')}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">{t('settings.skills.import.desc')}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11.5px] text-ink-3">
                  {skills.scanningImport
                    ? t('settings.skills.import.scanning')
                    : importCandidates.length > 0
                      ? t('settings.skills.import.foundCount', skills.scannedSources?.length ?? 1, importCandidates.length)
                      : ''}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={Boolean(skills.scanningImport)}
                    data-testid="skill-import-rescan"
                    onClick={() => postToHost({ type: 'scanAgentSkills', payload: {} })}
                  >
                    {skills.scanningImport ? <SpinnerIcon className="size-3" /> : <RefreshIcon className="size-3" />}
                    <span>{t('settings.skills.import.rescan')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="skill-import-pick-dir"
                    onClick={() => postToHost({ type: 'pickLocalSkillDir', payload: {} })}
                  >
                    <FolderIcon className="size-3" />
                    <span>{t('settings.skills.import.pickDir')}</span>
                  </Button>
                </div>
              </div>

              {skills.scanningImport ? (
                <div className="flex items-center justify-center gap-2 rounded-control bg-field py-6 text-[12px] text-ink-3">
                  <SpinnerIcon className="size-4" />
                  <span>{t('settings.skills.import.scanning')}</span>
                </div>
              ) : importCandidates.length === 0 ? (
                <div
                  className="rounded-xl bg-field/60 px-3 py-6 text-center text-[12px] text-ink-3"
                  data-testid="skill-import-empty"
                >
                  {t('settings.skills.import.empty')}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-end gap-1.5 text-[11px]">
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[11px] text-accent-ink"
                      onClick={() => setSelectedImportKeys(importCandidates.map((c) => c.key))}
                    >
                      {t('settings.skills.dialog.selectAll')}
                    </Button>
                    <span className="text-ink-4">·</span>
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[11px] text-ink-3"
                      onClick={() => setSelectedImportKeys([])}
                    >
                      {t('settings.skills.dialog.selectNone')}
                    </Button>
                  </div>

                  <div
                    className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-xl bg-field/55 p-2"
                    data-testid="skill-import-candidates"
                  >
                    {importCandidates.map((item) => {
                      const checked = selectedImportKeys.includes(item.key);
                      return (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-start gap-2 rounded-lg bg-canvas/85 px-2.5 py-2 transition-colors hover:bg-canvas dark:bg-page/55"
                          data-testid={`skill-candidate-${item.name}`}
                        >
                          <Checkbox
                            data-testid={`skill-candidate-check-${item.name}`}
                            className="mt-0.5"
                            checked={checked}
                            onCheckedChange={() => toggleImportCandidate(item.key)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[12px] font-semibold text-ink">/{item.name}</span>
                              <ValuePill tone="accent" className="text-[10px]">
                                {item.sourceAgentName}
                              </ValuePill>
                              {item.conflict ? (
                                <ValuePill className="text-[10px] text-ink-3">
                                  {t('settings.skills.import.existsBadge')}
                                </ValuePill>
                              ) : null}
                            </div>
                            {item.description ? (
                              <p className="mt-0.5 mb-0 line-clamp-2 text-[11.5px] text-ink-2">
                                {item.description}
                              </p>
                            ) : null}
                            <div className="truncate font-mono text-[10.5px] text-ink-4" title={item.sourceDir}>
                              {item.sourceDir}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.skills.dialog.targetAgents')}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="skill-import-agent-all"
                    onClick={() => setImportAllAgents(true)}
                    className={`inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors ${
                      importAllAgents
                        ? 'bg-accent-tint font-medium text-accent-ink'
                        : 'bg-field/60 text-ink-2 hover:bg-hover hover:text-ink'
                    }`}
                  >
                    {importAllAgents ? <CheckIcon className="size-3" /> : null}
                    <span>{t('settings.skills.allAgentsBtn')}</span>
                  </button>
                  {agents.map((agent) => {
                    const selected = !importAllAgents && importAgents.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        data-testid={`skill-import-agent-${agent.id}`}
                        onClick={() => toggleImportAgent(agent.id)}
                        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors ${
                          selected
                            ? 'bg-accent-tint font-medium text-accent-ink'
                            : 'bg-field/60 text-ink-2 hover:bg-hover hover:text-ink'
                        }`}
                      >
                        <BackendLogo backend={agent} size="sm" />
                        <span>{agent.name}</span>
                        {selected ? <CheckIcon className="size-3" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="skill-import-cancel"
                onClick={() => setImportOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={selectedImportCandidates.length === 0 || Boolean(skills.installing)}
                data-testid="skill-import-submit"
                onClick={submitImport}
              >
                {skills.installing ? <SpinnerIcon className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
                <span>{t('settings.skills.import.submit', selectedImportCandidates.length)}</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

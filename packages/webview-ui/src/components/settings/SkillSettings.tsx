/**
 * 设置 -> 扩展 -> 技能（Agent Skills，SKILL.md）：
 * 从 Git 仓库扫描并安装包含 SKILL.md 的技能目录，配置启用状态与目标 Agent，
 * Agent 启动时自动带上并支持在输入框通过 / 调用。
 */
import { useEffect, useState } from 'react';
import type { InstalledSkillView } from '@harness-deck/shared';
import { SettingsSection } from './SettingsSection.tsx';
import { useT } from '../../i18n.ts';
import { requestMarkdownPreview, setExtensionsLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  CheckIcon,
  DownloadIcon,
  EyeIcon,
  GitBranchIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
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
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

function shortRepoLabel(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\/github\.com\//iu, '')
    .replace(/^git@github\.com:/iu, '')
    .replace(/\.git$/iu, '');
}

export function SkillSettings() {
  const t = useT();
  const extensions = useView((s) => s.extensions);
  const backendItems = useView((s) => s.backends.items);
  const agents = backendItems.length > 0 ? backendItems : FALLBACK_BACKENDS;
  const { skills } = extensions;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [ref, setRef] = useState('');
  const [subpath, setSubpath] = useState('');
  const [selectedSubpaths, setSelectedSubpaths] = useState<string[]>([]);
  const [allAgentsMode, setAllAgentsMode] = useState(true);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingInstall, setPendingInstall] = useState(false);

  useEffect(() => {
    if (skills.scanned) {
      setSelectedSubpaths(skills.scanned.skills.map((item) => item.subpath));
    }
  }, [skills.scanned]);

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

  const installedNames = new Set(skills.items.map((item) => item.name.toLowerCase()));

  return (
    <div className="flex flex-col gap-5" data-testid="settings-skills">
      <SettingsSection
        title={t('settings.skills.title')}
        actions={
          <Button
            type="button"
            variant="outline"
            size="default"
            data-testid="skill-install-btn"
            onClick={openInstallDialog}
          >
            <PlusIcon className="size-3" />
            <span>{t('settings.skills.installBtn')}</span>
          </Button>
        }
      >
        <div className="primitive-card-pad flex flex-col gap-2.5">
          <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeInstallDialog()}>
            {dialogOpen ? (
              <DialogContent data-testid="skill-install-dialog" aria-modal="true" className="sm:max-w-[560px]">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-[14px]">
                    <PuzzleIcon className="size-4 text-accent-ink" />
                    <span>{t('settings.skills.dialog.title')}</span>
                  </DialogTitle>
                  <DialogDescription className="text-[12px] leading-relaxed text-ink-3">
                    {t('settings.skills.dialog.desc')}
                  </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.skills.dialog.repoUrl')}</span>
                    <div className="flex items-center gap-2">
                      <Input
                        size="default"
                        data-testid="skill-repo-url"
                        className="flex-1 font-mono text-[12px]"
                        value={repoUrl}
                        placeholder={t('settings.skills.dialog.repoUrlPlaceholder')}
                        onChange={(e) => setRepoUrl(e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
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
                        size="default"
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
                        size="default"
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
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent px-1 text-accent-ink hover:underline"
                            onClick={() => setSelectedSubpaths(discovered.map((item) => item.subpath))}
                          >
                            {t('settings.skills.dialog.selectAll')}
                          </button>
                          <span className="text-ink-4">·</span>
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent px-1 text-ink-3 hover:underline"
                            onClick={() => setSelectedSubpaths([])}
                          >
                            {t('settings.skills.dialog.selectNone')}
                          </button>
                        </div>
                      </div>

                      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-control border border-line bg-field p-2">
                        {discovered.map((item) => {
                          const checked = selectedSubpaths.includes(item.subpath);
                          const already = installedNames.has(item.name.toLowerCase());
                          return (
                            <label
                              key={item.subpath || item.name}
                              className="flex cursor-pointer items-start gap-2 rounded-control bg-surface px-2.5 py-2 shadow-hairline"
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
                    <span className="text-[11px] text-ink-3">{t('settings.skills.dialog.targetAgentsHint')}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="skill-install-agent-all"
                        onClick={() => setAllAgentsMode(true)}
                        className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2.5 py-1 text-[11.5px] transition-colors ${
                          allAgentsMode
                            ? 'border-brand bg-accent-tint font-medium text-accent-ink'
                            : 'border-line bg-field text-ink-2 hover:bg-hover'
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
                            className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2.5 py-1 text-[11.5px] transition-colors ${
                              active
                                ? 'border-brand bg-accent-tint font-medium text-accent-ink'
                                : 'border-line bg-field text-ink-2 hover:bg-hover'
                            }`}
                          >
                            {active ? <CheckIcon className="size-3" /> : null}
                            <span>{agent.name}</span>
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
                    size="default"
                    disabled={Boolean(skills.installing)}
                    data-testid="skill-install-cancel"
                    onClick={closeInstallDialog}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="default"
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

          {skills.items.length === 0 ? (
            <div
              className="rounded-control bg-field px-3 py-5 text-center text-[12px] text-ink-3 shadow-hairline"
              data-testid="skills-empty"
            >
              {t('settings.skills.empty')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {skills.items.map((skill) => {
                const isUniversal = !skill.agents || skill.agents.length === 0;
                const busy = skill.busy !== undefined;
                return (
                  <div
                    key={skill.id}
                    className={`flex flex-col gap-2 rounded-card bg-field p-3 shadow-hairline transition-opacity ${
                      skill.enabled ? '' : 'opacity-70'
                    }`}
                    data-testid={`skill-item-${skill.id}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="inline-flex items-center rounded-chip bg-surface px-2 py-0.5 font-mono text-[12px] font-semibold text-ink shadow-hairline">
                            /{skill.name}
                          </span>
                          <ValuePill tone="accent" className="text-[10.5px]">
                            {t('settings.skills.badge')}
                          </ValuePill>
                          <span
                            className="inline-flex items-center gap-1 truncate font-mono text-[11px] text-ink-3"
                            title={skill.repoUrl}
                          >
                            <GitBranchIcon className="size-3 shrink-0" />
                            <span>
                              {shortRepoLabel(skill.repoUrl)}
                              {skill.subpath ? `/${skill.subpath}` : ''}
                            </span>
                          </span>
                          {skill.ref || skill.commit ? (
                            <ValuePill className="font-mono text-[10px]">
                              {skill.ref ? `${skill.ref}${skill.commit ? `@${skill.commit}` : ''}` : skill.commit}
                            </ValuePill>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="default"
                          data-testid={`preview-skill-${skill.id}`}
                          onClick={() => requestMarkdownPreview(skill.skillMdPath)}
                        >
                          <EyeIcon className="size-3" />
                          <span>{t('settings.skills.preview')}</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="default"
                          disabled={busy}
                          data-testid={`sync-skill-${skill.id}`}
                          onClick={() => postToHost({ type: 'syncSkill', payload: { id: skill.id } })}
                        >
                          {skill.busy === 'updating' ? (
                            <SpinnerIcon className="size-3" />
                          ) : (
                            <RefreshIcon className="size-3" />
                          )}
                          <span>
                            {skill.busy === 'updating' ? t('settings.skills.syncing') : t('settings.skills.sync')}
                          </span>
                        </Button>
                        <Switch
                          size="default"
                          checked={skill.enabled}
                          disabled={busy}
                          aria-label={skill.name}
                          data-testid={`toggle-skill-${skill.id}`}
                          onCheckedChange={(checked) => updateSkillLocalAndHost(skill, { enabled: checked })}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={busy}
                          className="text-red hover:bg-red-tint hover:text-red"
                          aria-label={t('settings.skills.delete')}
                          data-testid={`delete-skill-${skill.id}`}
                          onClick={() => postToHost({ type: 'deleteSkill', payload: { id: skill.id } })}
                        >
                          <TrashIcon className="size-3" />
                        </Button>
                      </div>
                    </div>

                    {skill.description ? (
                      <p className="m-0 text-[12px] leading-relaxed text-ink-2">{skill.description}</p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="text-[11px] text-ink-3">{t('settings.skills.agentsLabel')}</span>
                      <button
                        type="button"
                        data-testid={`skill-agent-all-${skill.id}`}
                        onClick={() => updateSkillLocalAndHost(skill, { agents: null })}
                        className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2 py-0.5 text-[11px] transition-colors ${
                          isUniversal
                            ? 'border-brand bg-accent-tint font-medium text-accent-ink'
                            : 'border-line bg-surface text-ink-3 hover:bg-hover'
                        }`}
                      >
                        {isUniversal ? <CheckIcon className="size-2.5" /> : null}
                        <span>{t('settings.skills.allAgents')}</span>
                      </button>
                      {agents.map((agent) => {
                        const selected = !isUniversal && Boolean(skill.agents?.includes(agent.id));
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            data-testid={`skill-agent-${skill.id}-${agent.id}`}
                            onClick={() => toggleSkillAgent(skill, agent.id)}
                            className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2 py-0.5 text-[11px] transition-colors ${
                              selected
                                ? 'border-brand bg-accent-tint font-medium text-accent-ink'
                                : 'border-line bg-surface text-ink-3 hover:bg-hover'
                            }`}
                          >
                            {selected ? <CheckIcon className="size-2.5" /> : null}
                            <span>{agent.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

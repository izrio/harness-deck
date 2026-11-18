/**
 * 设置 -> Agent -> 智能体配置：
 * Node.js/npm 运行环境、内置智能体安装/版本切换/密钥配置、以及外部 ACP 智能体管理（新增/编辑/删除）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackendView, NodeEnvState, ProviderView } from '@harness-deck/shared';
import type { MessageKey } from '../../i18n.ts';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setSettingsTab, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { BackendLogo } from '../BackendLogo.tsx';
import {
  AgentIcon,
  DownloadIcon,
  ErrorIcon,
  GlobeIcon,
  KeyIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  dsh: 'backend.desc.dsh',
  pi: 'backend.desc.pi',
  'oh-my-pi': 'backend.desc.omp',
  codebuddy: 'backend.desc.codebuddy',
  claude: 'backend.desc.claude',
  opencode: 'backend.desc.opencode',
  zcode: 'backend.desc.zcode',
};

const NODE_DOWNLOAD_URL = 'https://nodejs.org/';

interface AgentFormState {
  readonly isNew: boolean;
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly installHint: string;
  readonly singleSession: boolean;
}

function emptyForm(): AgentFormState {
  return {
    isNew: true,
    id: '',
    name: '',
    command: '',
    argsText: '',
    envText: '',
    installHint: '',
    singleSession: false,
  };
}

function formFromBackend(backend: BackendView): AgentFormState {
  const envEntries = Object.entries(backend.env ?? {}).map(([k, v]) => `${k}=${v}`);
  return {
    isNew: false,
    id: backend.id,
    name: backend.name,
    command: backend.executable ?? '',
    argsText: (backend.args ?? []).join(' '),
    envText: envEntries.join('\n'),
    installHint: backend.installHint ?? '',
    singleSession: backend.singleSession === true,
  };
}

function parseEnvText(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1);
    if (key) env[key] = val;
  }
  return env;
}

export function AgentSettings() {
  const t = useT();
  const backends = useView((s) => s.backends);
  const providers = useView((s) => s.providers.items);
  const nodeEnv = backends.nodeEnv;
  const requestedVersionsRef = useRef(new Set<string>());
  const [form, setForm] = useState<AgentFormState | undefined>();
  const [formError, setFormError] = useState<string | undefined>();

  useEffect(() => {
    if (!nodeEnv?.checked) {
      postToHost({ type: 'checkBackendEnv', payload: {} });
    }
  }, [nodeEnv?.checked]);

  useEffect(() => {
    if (!nodeEnv?.checked || !nodeEnv.hasNpm) return;
    for (const item of backends.items) {
      if (!item.npmPackage) continue;
      if (item.versions !== undefined || item.versionsLoading || item.versionsError) continue;
      if (requestedVersionsRef.current.has(item.id)) continue;
      requestedVersionsRef.current.add(item.id);
      postToHost({ type: 'fetchBackendVersions', payload: { id: item.id } });
    }
  }, [backends.items, nodeEnv]);

  const refreshAll = () => {
    requestedVersionsRef.current.clear();
    postToHost({ type: 'checkBackendEnv', payload: {} });
    if (nodeEnv?.hasNpm) {
      for (const item of backends.items) {
        if (item.npmPackage) {
          requestedVersionsRef.current.add(item.id);
          postToHost({ type: 'fetchBackendVersions', payload: { id: item.id } });
        }
      }
    }
  };

  const openAdd = () => {
    setFormError(undefined);
    setForm(emptyForm());
  };

  const openEdit = (backend: BackendView) => {
    setFormError(undefined);
    setForm(formFromBackend(backend));
  };

  const closeForm = () => {
    setForm(undefined);
    setFormError(undefined);
  };

  const submitForm = () => {
    if (!form) return;
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name || !command) {
      setFormError(t('settings.agents.form.validation'));
      return;
    }
    const rawId = (form.id.trim() || name).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-');
    const id = rawId === 'dsh' || rawId === 'zcode' ? `${rawId}-acp` : rawId || 'custom-agent';
    const args = form.argsText
      .split(/\s+/u)
      .map((s) => s.trim())
      .filter(Boolean);
    const env = parseEnvText(form.envText);
    postToHost({
      type: 'upsertBackendProfile',
      payload: {
        id,
        name,
        command,
        args,
        env,
        ...(form.installHint.trim() ? { installHint: form.installHint.trim() } : {}),
        ...(form.singleSession ? { singleSession: true } : {}),
      },
    });
    setForm(undefined);
    setFormError(undefined);
  };

  return (
    <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card" data-testid="settings-backends">
      <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
        <div className="min-w-0">
          <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.backends')}</h3>
          <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.backendsHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="outline" size="xs" data-testid="agent-add-btn" onClick={openAdd}>
            <PlusIcon className="size-3" />
            <span>{t('settings.agents.add')}</span>
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" data-testid="settings-refresh-env" title={t('settings.refresh')} aria-label={t('settings.refresh')} onClick={refreshAll}>
            <RefreshIcon className="size-3.5 text-ink-2" />
          </Button>
        </div>
      </div>

      <div className="primitive-card-pad flex flex-col gap-2.5">
        <NodeEnvBanner nodeEnv={nodeEnv} />

        <Dialog open={Boolean(form)} onOpenChange={(open) => !open && closeForm()}>
          {form ? (
            <DialogContent data-testid="agent-form" aria-modal="true" className="sm:max-w-[520px]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-[14px]">
                  <AgentIcon className="size-4 text-accent-ink" />
                  <span>
                    {form.isNew
                      ? t('settings.agents.form.addTitle')
                      : t('settings.agents.form.editTitle', form.name || form.id)}
                  </span>
                </DialogTitle>
                <DialogDescription className="sr-only">{t('settings.backendsHint')}</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.name')}</span>
                    <Input
                      data-testid="agent-form-name"
                      value={form.name}
                      placeholder={t('settings.agents.form.namePlaceholder')}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.id')}</span>
                    <Input
                      data-testid="agent-form-id"
                      disabled={!form.isNew}
                      className="font-mono text-[12px]"
                      value={form.id}
                      placeholder={t('settings.agents.form.idPlaceholder')}
                      onChange={(e) => setForm({ ...form, id: e.target.value })}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.command')}</span>
                    <Input
                      data-testid="agent-form-command"
                      className="font-mono text-[12px]"
                      value={form.command}
                      placeholder={t('settings.agents.form.commandPlaceholder')}
                      onChange={(e) => setForm({ ...form, command: e.target.value })}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.args')}</span>
                    <Input
                      data-testid="agent-form-args"
                      className="font-mono text-[12px]"
                      value={form.argsText}
                      placeholder={t('settings.agents.form.argsPlaceholder')}
                      onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.env')}</span>
                  <Textarea
                    data-testid="agent-form-env"
                    rows={2}
                    className="py-1.5 font-mono text-[12px]"
                    value={form.envText}
                    placeholder={t('settings.agents.form.envPlaceholder')}
                    onChange={(e) => setForm({ ...form, envText: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink-2">{t('settings.agents.form.installHint')}</span>
                  <Input
                    data-testid="agent-form-install-hint"
                    className="text-[12px]"
                    value={form.installHint}
                    placeholder={t('settings.agents.form.installHintPlaceholder')}
                    onChange={(e) => setForm({ ...form, installHint: e.target.value })}
                  />
                </label>

                <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-field/60 px-3 py-2">
                  <span className="flex flex-col text-[12px]">
                    <span className="font-medium text-ink">{t('settings.agents.form.singleSession')}</span>
                    <span className="text-[11px] text-ink-3">{t('settings.agents.form.singleSessionHint')}</span>
                  </span>
                  <Switch
                    data-testid="agent-form-single-session"
                    aria-label={t('settings.agents.form.singleSession')}
                    checked={form.singleSession}
                    onCheckedChange={(checked) => setForm({ ...form, singleSession: checked })}
                  />
                </div>

                {formError ? (
                  <div className="text-[11.5px] text-red" role="alert">
                    {formError}
                  </div>
                ) : null}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" size="sm" data-testid="agent-form-cancel" onClick={closeForm}>
                  {t('common.cancel')}
                </Button>
                <Button type="button" size="sm" data-testid="agent-form-save" onClick={submitForm}>
                  {t('settings.agents.form.save')}
                </Button>
              </DialogFooter>
            </DialogContent>
          ) : null}
        </Dialog>

        <div className="flex flex-col gap-2">
          {backends.items.map((backend) => (
            <BackendCard
              key={backend.id}
              backend={backend}
              active={backend.id === backends.active}
              nodeEnv={nodeEnv}
              boundProvider={providers.find(
                (p) =>
                  p.boundBackendIds.includes(backend.id) ||
                  (backend.id === 'pi' && p.boundBackendIds.includes('oh-my-pi')),
              )}
              onEdit={() => openEdit(backend)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function NodeEnvBanner({ nodeEnv }: { readonly nodeEnv?: NodeEnvState }) {
  const t = useT();
  if (!nodeEnv || !nodeEnv.checked) {
    return (
      <div className="flex items-center gap-2 rounded-control bg-field px-3 py-2 text-[12px] text-ink-2 shadow-hairline" data-testid="node-env-checking">
        <SpinnerIcon className="size-3.5" />
        <span>{t('settings.node.checking')}</span>
      </div>
    );
  }
  if (!nodeEnv.hasNode || !nodeEnv.hasNpm) {
    const msgKey: MessageKey =
      !nodeEnv.hasNode && !nodeEnv.hasNpm
        ? 'settings.node.missingBoth'
        : !nodeEnv.hasNode
          ? 'settings.node.missingNode'
          : 'settings.node.missingNpm';
    return (
      <div className="flex flex-col gap-2 rounded-card bg-orange-tint px-3 py-2.5 text-[12px] shadow-[0_0_0_1px_color-mix(in_srgb,var(--orange)_28%,transparent)]" role="alert" data-testid="node-env-missing">
        <div className="flex items-start gap-2 leading-snug text-ink">
          <ErrorIcon className="mt-0.5 size-3.5 shrink-0 text-orange" />
          <span>{t(msgKey)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="xs"
            data-testid="install-node-btn"
            onClick={() => postToHost({ type: 'openExternal', payload: { url: NODE_DOWNLOAD_URL } })}
          >
            <GlobeIcon className="size-3" />
            <span>{t('settings.node.install')}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => postToHost({ type: 'checkBackendEnv', payload: {} })}
          >
            <RefreshIcon className="size-3" />
            <span>{t('settings.refresh')}</span>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-control bg-field px-2.5 py-1.5 text-[12px] text-ink-2 shadow-hairline" data-testid="node-env-ok">
      <span className="size-1.5 rounded-full bg-green" />
      <span className="font-mono text-[11.5px]">{t('settings.node.ready', nodeEnv.nodeVersion ?? '', nodeEnv.npmVersion ?? '')}</span>
    </div>
  );
}

function BackendCard({
  backend,
  active,
  nodeEnv,
  boundProvider,
  onEdit,
}: {
  readonly backend: BackendView;
  readonly active: boolean;
  readonly nodeEnv?: NodeEnvState;
  readonly boundProvider?: ProviderView;
  readonly onEdit: () => void;
}) {
  const t = useT();
  const description = DESCRIPTIONS[backend.id];
  const [prevInstalled, setPrevInstalled] = useState(backend.version);
  const [pickedVersion, setPickedVersion] = useState(backend.version ?? '');

  if (backend.version !== prevInstalled) {
    setPrevInstalled(backend.version);
    setPickedVersion(backend.version ?? '');
  }

  const versionOptions = useMemo(() => {
    const list = backend.versions ? [...backend.versions] : [];
    if (backend.version && !list.includes(backend.version)) {
      list.unshift(backend.version);
    }
    return list;
  }, [backend.versions, backend.version]);

  const npmReady = Boolean(nodeEnv?.checked && nodeEnv.hasNode && nodeEnv.hasNpm);
  const isBusy = Boolean(backend.busy);
  const canSwitchVersion = npmReady && !isBusy && pickedVersion.length > 0 && pickedVersion !== backend.version;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-card p-3 transition-colors duration-150',
        active
          ? 'bg-inset shadow-[inset_0_0_0_1.5px_var(--accent)]'
          : 'bg-field shadow-hairline',
      )}
      data-testid={`settings-backend-${backend.id}`}
    >
      <div className="flex items-start gap-2.5">
        <BackendLogo backend={backend} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-ink">{backend.name}</span>
            {backend.kind === 'acp' ? <ValuePill className="text-[10.5px]">ACP</ValuePill> : null}
            {backend.custom ? <ValuePill className="text-[10.5px]">{t('settings.agents.customBadge')}</ValuePill> : null}
            {backend.overridden ? <ValuePill className="text-[10.5px]">{t('settings.agents.overriddenBadge')}</ValuePill> : null}
            {active ? <ValuePill tone="accent" className="text-[10.5px]">{t('settings.backend.active')}</ValuePill> : null}
            {boundProvider ? (
              <button
                type="button"
                data-testid={`backend-bound-provider-${backend.id}`}
                onClick={() => setSettingsTab('providers')}
                className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0"
              >
                <ValuePill tone="accent" className="text-[10.5px] hover:opacity-85">
                  <KeyIcon className="size-2.5" />
                  <span>{t('settings.providers.boundBadge', boundProvider.name)}</span>
                </ValuePill>
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 mb-0 text-[12px] leading-snug text-ink-2">
            {description ? t(description) : t('backend.desc.acp', backend.command ?? backend.name)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {backend.kind === 'acp' ? (
            <Button type="button" variant="ghost" size="xs" data-testid={`edit-backend-${backend.id}`} onClick={onEdit}>
              <PencilIcon className="size-3" />
              <span>{t('settings.agents.edit')}</span>
            </Button>
          ) : null}
          {backend.custom ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-red hover:bg-red-tint hover:text-red"
              data-testid={`delete-backend-${backend.id}`}
              onClick={() => postToHost({ type: 'deleteBackendProfile', payload: { id: backend.id } })}
            >
              <TrashIcon className="size-3" />
              <span>{t('settings.agents.delete')}</span>
            </Button>
          ) : backend.overridden ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid={`reset-backend-${backend.id}`}
              onClick={() => postToHost({ type: 'deleteBackendProfile', payload: { id: backend.id } })}
            >
              <span>{t('settings.agents.resetOverride')}</span>
            </Button>
          ) : null}
          {!active ? (
            <Button
              type="button"
              size="xs"
              data-testid={`select-backend-${backend.id}`}
              onClick={() => postToHost({ type: 'selectBackend', payload: { id: backend.id } })}
            >
              {t('settings.backend.use')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {backend.busy ? (
          <ValuePill tone="accent">
            <SpinnerIcon className="size-3" />
            {t(`settings.backend.busy.${backend.busy}` as MessageKey)}
          </ValuePill>
        ) : backend.available === undefined ? (
          <ValuePill>
            <SpinnerIcon className="size-3" />
            {t('backend.checking')}
          </ValuePill>
        ) : backend.available ? (
          <ValuePill tone="green">
            <span className="size-1.5 rounded-full bg-green" />
            <span>{t('backend.installed')}</span>
            {backend.version ? <code className="font-mono text-[11px]">{t('settings.backend.version', backend.version)}</code> : null}
          </ValuePill>
        ) : (
          <ValuePill tone="orange">
            <span className="size-1.5 rounded-full bg-orange" />
            <span>{t('backend.missing')}</span>
          </ValuePill>
        )}

        {active && backend.kind === 'dsh' ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <Button type="button" variant="outline" size="xs" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
              <KeyIcon className="size-3 text-ink-3" />
              <span>{t('apiKey.configure')}</span>
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={() => postToHost({ type: 'openWebUI', payload: {} })}>
              <GlobeIcon className="size-3 text-ink-3" />
              <span>{t('header.openWebUI')}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {backend.npmPackage ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="min-w-32 flex-1 [&_[data-slot=native-select-wrapper]]:w-full">
              <NativeSelect
                size="sm"
                className="bg-surface text-[12px]"
                aria-label={t('settings.backend.versionSelect', backend.name)}
                data-testid={`version-select-${backend.id}`}
                disabled={!npmReady || isBusy}
                value={pickedVersion}
                onChange={(e) => setPickedVersion(e.target.value)}
              >
                {!backend.available || (!backend.version && versionOptions.length === 0) ? (
                  <NativeSelectOption value="">{t('settings.backend.latest')}</NativeSelectOption>
                ) : null}
                {versionOptions.map((ver) => (
                  <NativeSelectOption key={ver} value={ver}>
                    {ver === backend.version ? `v${ver} (${t('backend.current')})` : `v${ver}`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            {backend.available ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  data-testid={`switch-version-${backend.id}`}
                  disabled={!canSwitchVersion}
                  onClick={() => postToHost({ type: 'installBackend', payload: { id: backend.id, version: pickedVersion } })}
                >
                  {t('settings.backend.switchVersion')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  data-testid={`uninstall-backend-${backend.id}`}
                  disabled={!npmReady || isBusy}
                  onClick={() => postToHost({ type: 'uninstallBackend', payload: { id: backend.id } })}
                >
                  <TrashIcon className="size-3" />
                  <span>{t('settings.backend.uninstall')}</span>
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="xs"
                data-testid={`install-backend-${backend.id}`}
                disabled={!npmReady || isBusy}
                onClick={() =>
                  postToHost({
                    type: 'installBackend',
                    payload: { id: backend.id, ...(pickedVersion ? { version: pickedVersion } : {}) },
                  })
                }
              >
                <DownloadIcon className="size-3" />
                <span>{t('settings.backend.install')}</span>
              </Button>
            )}
          </div>

          {backend.versionsLoading ? (
            <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
              <SpinnerIcon className="size-3" />
              <span>{t('settings.backend.loadingVersions')}</span>
            </div>
          ) : backend.versionsError ? (
            <div className="flex items-center gap-1.5 text-[11.5px] text-red">
              <span>{t('settings.backend.versionsError')}</span>
              <button type="button" className="font-medium text-ink hover:underline" onClick={() => postToHost({ type: 'fetchBackendVersions', payload: { id: backend.id } })}>
                {t('settings.backend.retryVersions')}
              </button>
            </div>
          ) : !npmReady && nodeEnv?.checked ? (
            <div className="text-[11.5px] text-ink-3">{t('settings.backend.needNpm')}</div>
          ) : null}
        </div>
      ) : backend.available === false && (backend.installHint || backend.command) ? (
        <p className="m-0 text-[12px] text-ink-2">{backend.installHint ?? backend.command}</p>
      ) : null}
    </div>
  );
}

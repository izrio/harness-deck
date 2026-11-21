import { useMemo, useState } from 'react';
import { backendCapabilities, type BackendView, type NodeEnvState, type ProviderView } from '@harness-deck/shared';
import type { MessageKey } from '../../../i18n.ts';
import { useT } from '../../../i18n.ts';
import { setSettingsTab } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import { BackendLogo } from '../../BackendLogo.tsx';
import { CheckIcon, CopyIcon, DownloadIcon, GlobeIcon, KeyIcon, PencilIcon, SpinnerIcon, TrashIcon } from '../../icons.tsx';
import { ValuePill } from '../../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

export const DESCRIPTIONS: Readonly<Record<string, MessageKey>> = {
  dsh: 'backend.desc.dsh',
  pi: 'backend.desc.pi',
  'oh-my-pi': 'backend.desc.omp',
  codebuddy: 'backend.desc.codebuddy',
  claude: 'backend.desc.claude',
  codex: 'backend.desc.codex',
  opencode: 'backend.desc.opencode',
  antigravity: 'backend.desc.antigravity',
  zcode: 'backend.desc.zcode',
};

export function BackendCard({
  backend,
  active,
  isDefault,
  nodeEnv,
  boundProvider,
  onEdit,
}: {
  readonly backend: BackendView;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly nodeEnv?: NodeEnvState;
  readonly boundProvider?: ProviderView;
  readonly onEdit: () => void;
}) {
  const t = useT();
  const capabilities = backend.capabilities ?? backendCapabilities(backend);
  const description = DESCRIPTIONS[backend.id];
  const [prevInstalled, setPrevInstalled] = useState(backend.version);
  const [pickedVersion, setPickedVersion] = useState(backend.version ?? '');
  const [copiedManual, setCopiedManual] = useState(false);

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
  const versionsError = backend.versionsError;
  const canSwitchVersion = npmReady && !isBusy && pickedVersion.length > 0 && pickedVersion !== backend.version;

  return (
    <div
      className="flex flex-col gap-2 rounded-card bg-field p-3 shadow-hairline"
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
            {isDefault ? (
              <ValuePill className="text-[10.5px]" data-testid={`backend-default-badge-${backend.id}`}>
                {t('settings.backend.default')}
              </ValuePill>
            ) : null}
            {backend.running ? (
              <ValuePill tone="accent" className="text-[10.5px]" data-testid={`backend-running-badge-${backend.id}`}>
                <SpinnerIcon className="size-2.5" />
                <span>{t('settings.backend.running')}</span>
              </ValuePill>
            ) : !active && backend.alive ? (
              <ValuePill tone="green" className="text-[10.5px]" data-testid={`backend-alive-badge-${backend.id}`}>
                <span className="size-1.5 rounded-full bg-green" />
                <span>{t('settings.backend.alive')}</span>
              </ValuePill>
            ) : null}
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
            <Button type="button" variant="ghost" size="default" data-testid={`edit-backend-${backend.id}`} onClick={onEdit}>
              <PencilIcon className="size-3" />
              <span>{t('settings.agents.edit')}</span>
            </Button>
          ) : null}
          {backend.custom ? (
            <Button
              type="button"
              variant="ghost"
              size="default"
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
              size="default"
              data-testid={`reset-backend-${backend.id}`}
              onClick={() => postToHost({ type: 'deleteBackendProfile', payload: { id: backend.id } })}
            >
              <span>{t('settings.agents.resetOverride')}</span>
            </Button>
          ) : null}
          {!isDefault ? (
            <Button
              type="button"
              variant="outline"
              size="default"
              data-testid={`default-backend-${backend.id}`}
              onClick={() => postToHost({ type: 'selectBackend', payload: { id: backend.id } })}
            >
              {t('settings.backend.setDefault')}
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

        {active && (capabilities.apiKeySetup || (capabilities.webUi && backend.webUrl)) ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {capabilities.apiKeySetup ? (
              <Button type="button" variant="outline" size="default" onClick={() => postToHost({ type: 'configureApiKey', payload: {} })}>
                <KeyIcon className="size-3 text-ink-3" />
                <span>{t('apiKey.configure')}</span>
              </Button>
            ) : null}
            {capabilities.webUi && backend.webUrl ? (
              <Button
                type="button"
                variant="link"
                size="default"
                data-testid={`open-webui-${backend.id}`}
                title={t('header.openWebUI')}
                className="h-auto max-w-60 min-w-0 px-0 text-[11.5px] font-normal text-ink-2 hover:text-ink"
                onClick={() => postToHost({ type: 'openWebUI', payload: {} })}
              >
                <GlobeIcon className="size-3 text-ink-3" />
                <span className="truncate font-mono">{backend.webUrl}</span>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {backend.npmPackage && backend.available && backend.npmOwned === false ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface/60 px-2.5 py-2 text-[11.5px] text-ink-2">
          <span>{t('settings.backend.externalInstall')}</span>
          {backend.installCommand ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid={`copy-install-${backend.id}`}
              onClick={() => {
                void navigator.clipboard?.writeText(backend.installCommand!);
                setCopiedManual(true);
                setTimeout(() => setCopiedManual(false), 1_500);
              }}
            >
              {copiedManual ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              <span>{copiedManual ? t('settings.backend.copied') : t('settings.backend.copyCommand')}</span>
            </Button>
          ) : null}
        </div>
      ) : backend.npmPackage ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="min-w-32 flex-1 [&_[data-slot=native-select-wrapper]]:w-full">
              <NativeSelect
                size="default"
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
                  size="default"
                  data-testid={`switch-version-${backend.id}`}
                  disabled={!canSwitchVersion}
                  onClick={() => postToHost({ type: 'installBackend', payload: { id: backend.id, version: pickedVersion } })}
                >
                  {t('settings.backend.switchVersion')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="default"
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
                size="default"
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
          ) : versionsError ? (
            <div className="flex flex-col gap-0.5 text-[11.5px] text-red">
              <div className="flex items-center gap-1.5">
                <span>{t('settings.backend.versionsError')}</span>
                <button
                  type="button"
                  className="font-medium text-ink hover:underline"
                  onClick={() => postToHost({ type: 'fetchBackendVersions', payload: { id: backend.id } })}
                >
                  {t('settings.backend.retryVersions')}
                </button>
              </div>
              <span className="break-all font-mono text-[11px] text-ink-3" title={versionsError}>
                {versionsError}
              </span>
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

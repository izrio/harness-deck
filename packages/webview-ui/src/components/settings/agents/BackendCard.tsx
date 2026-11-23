import { useMemo, useState } from 'react';
import { backendCapabilities, type AccountView, type BackendView, type NodeEnvState, type ProviderView } from '@harness-deck/shared';
import type { MessageKey } from '../../../i18n.ts';
import { useT } from '../../../i18n.ts';
import { setSettingsTab } from '../../../store.ts';
import { postToHost } from '../../../vscode.ts';
import { BackendLogo } from '../../BackendLogo.tsx';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GlobeIcon,
  HistoryIcon,
  KeyIcon,
  MoreIcon,
  PencilIcon,
  ReplyIcon,
  SpinnerIcon,
  TrashIcon,
  UsersIcon,
} from '../../icons.tsx';
import { ValuePill } from '../../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
  activeAccount,
  onEdit,
}: {
  readonly backend: BackendView;
  readonly active: boolean;
  readonly isDefault: boolean;
  readonly nodeEnv?: NodeEnvState;
  readonly boundProvider?: ProviderView;
  readonly activeAccount?: AccountView;
  readonly onEdit: () => void;
}) {
  const t = useT();
  const capabilities = backend.capabilities ?? backendCapabilities(backend);
  const description = DESCRIPTIONS[backend.id];
  const [prevInstalled, setPrevInstalled] = useState(backend.version);
  const [pickedVersion, setPickedVersion] = useState(backend.version ?? '');
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);

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

  const showSetDefault = !isDefault;
  const showCopyInstall = Boolean(backend.npmPackage && backend.available && backend.npmOwned === false && backend.installCommand);
  const showSwitchVersion = Boolean(backend.npmPackage && backend.available && backend.npmOwned !== false);
  const showInstall = Boolean(backend.npmPackage && !backend.available);
  const showApiKey = Boolean(active && capabilities.apiKeySetup);
  const showWebUi = Boolean(active && capabilities.webUi && backend.webUrl);
  const showEdit = backend.kind === 'acp';
  const showReset = !backend.custom && Boolean(backend.overridden);
  const showUninstall = Boolean(backend.npmPackage && backend.available && backend.npmOwned !== false);
  const showDelete = Boolean(backend.custom);

  const hasPrimaryActions =
    showSetDefault ||
    showCopyInstall ||
    showSwitchVersion ||
    showInstall ||
    showApiKey ||
    showWebUi ||
    showEdit ||
    showReset;
  const hasDestructiveActions = showUninstall || showDelete;

  return (
    <>
      <Card
        className="flex-row items-start gap-3 border-line/75 bg-surface/80 px-3.5 py-3 shadow-xs transition-colors hover:border-line-strong/80 hover:bg-surface dark:bg-surface/75"
        data-testid={`settings-backend-${backend.id}`}
      >
      <BackendLogo backend={backend} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-ink">{backend.name}</span>

          {backend.busy ? (
            <ValuePill tone="accent" className="text-[10.5px]">
              <SpinnerIcon className="size-2.5" />
              <span>{t(`settings.backend.busy.${backend.busy}` as MessageKey)}</span>
            </ValuePill>
          ) : backend.available === undefined ? (
            <ValuePill className="text-[10.5px]">
              <SpinnerIcon className="size-2.5" />
              <span>{t('backend.checking')}</span>
            </ValuePill>
          ) : backend.available ? (
            <ValuePill tone="green" className="text-[10.5px]">
              <span className="size-1.5 rounded-full bg-green" />
              <span>{t('backend.installed')}</span>
              {backend.version ? (
                <code className="font-mono text-[10.5px]">{t('settings.backend.version', backend.version)}</code>
              ) : null}
            </ValuePill>
          ) : (
            <ValuePill tone="orange" className="text-[10.5px]">
              <span className="size-1.5 rounded-full bg-orange" />
              <span>{t('backend.missing')}</span>
            </ValuePill>
          )}

          {isDefault ? (
            <ValuePill className="text-[10.5px]" data-testid={`backend-default-badge-${backend.id}`}>
              {t('settings.backend.default')}
            </ValuePill>
          ) : null}
          {backend.kind === 'acp' ? <ValuePill className="text-[10.5px]">ACP</ValuePill> : null}
          {backend.custom ? <ValuePill className="text-[10.5px]">{t('settings.agents.customBadge')}</ValuePill> : null}
          {backend.overridden ? (
            <ValuePill className="text-[10.5px]">{t('settings.agents.overriddenBadge')}</ValuePill>
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
          ) : activeAccount ? (
            <button
              type="button"
              data-testid={`backend-active-account-${backend.id}`}
              onClick={() => setSettingsTab('accounts')}
              className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0"
            >
              <ValuePill className="text-[10.5px] hover:opacity-85">
                <UsersIcon className="size-2.5" />
                <span>{t('settings.accounts.officialBadge', activeAccount.label)}</span>
              </ValuePill>
            </button>
          ) : null}
        </div>

        <p className="mt-1 mb-0 text-[12px] leading-snug text-ink-2">
          {description ? t(description) : t('backend.desc.acp', backend.command ?? backend.name)}
        </p>

        {backend.npmPackage && backend.available && backend.npmOwned === false ? (
          <p className="mt-1 mb-0 text-[11.5px] text-ink-3">{t('settings.backend.externalInstall')}</p>
        ) : !backend.npmPackage && backend.available === false && (backend.installHint || backend.command) ? (
          <p className="mt-1 mb-0 font-mono text-[11.5px] text-ink-3">{backend.installHint ?? backend.command}</p>
        ) : null}
      </div>

      {hasPrimaryActions || hasDestructiveActions ? (
        <div className="shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-ink-2 hover:text-ink"
                data-testid={`backend-actions-${backend.id}`}
                aria-label={t('common.moreActions')}
                title={t('common.moreActions')}
              >
                <MoreIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {showSetDefault ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`default-backend-${backend.id}`}
                  onSelect={() => postToHost({ type: 'selectBackend', payload: { id: backend.id } })}
                >
                  <CheckIcon className="size-3.5 text-ink-2" />
                  <span>{t('settings.backend.setDefault')}</span>
                </DropdownMenuItem>
              ) : null}
              {showSwitchVersion ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`switch-version-menu-${backend.id}`}
                  disabled={!npmReady || isBusy}
                  onSelect={() => {
                    setPickedVersion(backend.version ?? '');
                    setVersionDialogOpen(true);
                  }}
                >
                  <HistoryIcon className="size-3.5 text-ink-2" />
                  <span>{t('settings.backend.switchVersion')}</span>
                </DropdownMenuItem>
              ) : null}
              {showInstall ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`install-backend-menu-${backend.id}`}
                  disabled={!npmReady || isBusy}
                  onSelect={() => {
                    setPickedVersion('');
                    setVersionDialogOpen(true);
                  }}
                >
                  <DownloadIcon className="size-3.5 text-ink-2" />
                  <span>{t('settings.backend.install')}</span>
                </DropdownMenuItem>
              ) : null}
              {showCopyInstall ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`copy-install-${backend.id}`}
                  onSelect={() => {
                    void navigator.clipboard?.writeText(backend.installCommand!);
                  }}
                >
                  <CopyIcon className="size-3.5 text-ink-2" />
                  <span>{t('settings.backend.copyCommand')}</span>
                </DropdownMenuItem>
              ) : null}
              {showApiKey ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  onSelect={() => postToHost({ type: 'configureApiKey', payload: {} })}
                >
                  <KeyIcon className="size-3.5 text-ink-2" />
                  <span>{t('apiKey.configure')}</span>
                </DropdownMenuItem>
              ) : null}
              {showWebUi ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`open-webui-${backend.id}`}
                  onSelect={() => postToHost({ type: 'openWebUI', payload: {} })}
                >
                  <GlobeIcon className="size-3.5 text-ink-2" />
                  <span>{t('header.openWebUI')}</span>
                </DropdownMenuItem>
              ) : null}
              {showEdit ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`edit-backend-${backend.id}`}
                  onSelect={onEdit}
                >
                  <PencilIcon className="size-3.5 text-ink-2" />
                  <span>{t('settings.agents.edit')}</span>
                </DropdownMenuItem>
              ) : null}
              {showReset ? (
                <DropdownMenuItem
                  className="gap-2 text-[12.5px]"
                  data-testid={`reset-backend-${backend.id}`}
                  onSelect={() => postToHost({ type: 'deleteBackendProfile', payload: { id: backend.id } })}
                >
                  <ReplyIcon className="size-3.5 text-ink-2" />
                  <span>{t('settings.agents.resetOverride')}</span>
                </DropdownMenuItem>
              ) : null}
              {hasPrimaryActions && hasDestructiveActions ? <DropdownMenuSeparator /> : null}
              {showUninstall ? (
                <DropdownMenuItem
                  variant="destructive"
                  className="gap-2 text-[12.5px]"
                  data-testid={`uninstall-backend-${backend.id}`}
                  disabled={!npmReady || isBusy}
                  onSelect={() => postToHost({ type: 'uninstallBackend', payload: { id: backend.id } })}
                >
                  <TrashIcon className="size-3.5" />
                  <span>{t('settings.backend.uninstall')}</span>
                </DropdownMenuItem>
              ) : null}
              {showDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  className="gap-2 text-[12.5px]"
                  data-testid={`delete-backend-${backend.id}`}
                  onSelect={() => postToHost({ type: 'deleteBackendProfile', payload: { id: backend.id } })}
                >
                  <TrashIcon className="size-3.5" />
                  <span>{t('settings.agents.delete')}</span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      </Card>

      {backend.npmPackage && backend.npmOwned !== false ? (
        <Dialog open={versionDialogOpen} onOpenChange={setVersionDialogOpen}>
          <DialogContent className="sm:max-w-[400px]" data-testid={`version-dialog-${backend.id}`}>
            <DialogHeader>
              <DialogTitle>
                {backend.available
                  ? t('settings.backend.versionDialogTitle', backend.name)
                  : t('settings.backend.installDialogTitle', backend.name)}
              </DialogTitle>
              <DialogDescription>
                {backend.available && backend.version
                  ? t('settings.backend.currentVersion', backend.version)
                  : t('settings.backend.versionSelect', backend.name)}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2.5">
              <div className="[&_[data-slot=native-select-wrapper]]:w-full">
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

            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setVersionDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              {backend.available ? (
                <Button
                  type="button"
                  size="sm"
                  data-testid={`switch-version-${backend.id}`}
                  disabled={!canSwitchVersion}
                  onClick={() => {
                    postToHost({ type: 'installBackend', payload: { id: backend.id, version: pickedVersion } });
                    setVersionDialogOpen(false);
                  }}
                >
                  {t('settings.backend.switchVersion')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  data-testid={`install-backend-${backend.id}`}
                  disabled={!npmReady || isBusy}
                  onClick={() => {
                    postToHost({
                      type: 'installBackend',
                      payload: { id: backend.id, ...(pickedVersion ? { version: pickedVersion } : {}) },
                    });
                    setVersionDialogOpen(false);
                  }}
                >
                  <DownloadIcon className="size-3.5" />
                  <span>{t('settings.backend.install')}</span>
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

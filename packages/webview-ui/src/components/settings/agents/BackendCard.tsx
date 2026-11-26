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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const LATEST_VERSION_VALUE = '__latest__';

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
      <div
        className="flex items-center gap-3.5 py-3.5"
        data-testid={`settings-backend-${backend.id}`}
      >
        <BackendLogo backend={backend} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className="text-[13px] leading-5 font-semibold text-ink sm:w-28 sm:shrink-0 sm:truncate"
              title={backend.name}
            >
              {backend.name}
            </span>

            <div className="inline-flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              {backend.busy ? (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-none text-accent-ink sm:min-w-[72px]">
                  <SpinnerIcon className="size-3 shrink-0" />
                  <span>{t(`settings.backend.busy.${backend.busy}` as MessageKey)}</span>
                </span>
              ) : backend.available === undefined ? (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-none text-ink-3 sm:min-w-[72px]">
                  <SpinnerIcon className="size-3 shrink-0" />
                  <span>{t('backend.checking')}</span>
                </span>
              ) : backend.available ? (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-none text-ink-3 tabular-nums sm:min-w-[72px]">
                  <span className="size-1.5 shrink-0 rounded-full bg-green" aria-label={t('backend.installed')} />
                  {backend.version ? (
                    <code className="font-mono text-[11.5px] leading-none text-ink-3">
                      {t('settings.backend.version', backend.version)}
                    </code>
                  ) : null}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-none text-orange">
                  <span className="size-1.5 shrink-0 rounded-full bg-orange" />
                  <span>{t('backend.missing')}</span>
                </span>
              )}

              {isDefault ? (
                <span
                  className="inline-flex items-center rounded-md bg-canvas/85 px-1.5 py-0.5 text-[10.5px] leading-4 font-medium text-ink-2 dark:bg-page/55"
                  data-testid={`backend-default-badge-${backend.id}`}
                >
                  {t('settings.backend.default')}
                </span>
              ) : null}

              {backend.running ? (
                <span
                  className="inline-flex items-center gap-1 text-[11px] leading-none font-medium text-accent-ink"
                  data-testid={`backend-running-badge-${backend.id}`}
                >
                  <SpinnerIcon className="size-2.5 shrink-0" />
                  <span>{t('settings.backend.running')}</span>
                </span>
              ) : null}
            </div>
          </div>

          {!backend.npmPackage && backend.available === false && (backend.installHint || backend.command) ? (
            <p className="mt-1 mb-0 truncate font-mono text-[11.5px] leading-4 text-ink-3">
              {backend.installHint ?? backend.command}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {boundProvider ? (
            <button
              type="button"
              data-testid={`backend-bound-provider-${backend.id}`}
              onClick={() => setSettingsTab('providers')}
              className="inline-flex max-w-44 cursor-pointer items-center gap-1.5 rounded-lg bg-accent-tint/75 px-2.5 py-1 text-[11.5px] font-medium text-accent-ink transition-opacity hover:opacity-85"
            >
              <KeyIcon className="size-3 shrink-0" />
              <span className="truncate">{t('settings.providers.boundBadge', boundProvider.name)}</span>
            </button>
          ) : activeAccount ? (
            <button
              type="button"
              data-testid={`backend-active-account-${backend.id}`}
              onClick={() => setSettingsTab('accounts')}
              className="inline-flex max-w-44 cursor-pointer items-center gap-1.5 rounded-lg bg-canvas/80 px-2.5 py-1 text-[11.5px] text-ink-2 transition-colors hover:bg-canvas hover:text-ink dark:bg-page/45 dark:hover:bg-page/75"
            >
              <UsersIcon className="size-3 shrink-0" />
              <span className="truncate">{t('settings.accounts.officialBadge', activeAccount.label)}</span>
            </button>
          ) : null}

          {hasPrimaryActions || hasDestructiveActions ? (
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
          ) : null}
        </div>
      </div>

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
              {(() => {
                const showLatestOption = !backend.available || (!backend.version && versionOptions.length === 0);
                const selectValue = pickedVersion || (showLatestOption ? LATEST_VERSION_VALUE : undefined);
                return (
                  <Select
                    disabled={!npmReady || isBusy}
                    value={selectValue}
                    onValueChange={(value) => setPickedVersion(value === LATEST_VERSION_VALUE ? '' : value)}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full bg-surface text-[12px]"
                      aria-label={t('settings.backend.versionSelect', backend.name)}
                      data-testid={`version-select-${backend.id}`}
                    >
                      <SelectValue placeholder={t('settings.backend.latest')} />
                    </SelectTrigger>
                    <SelectContent>
                      {showLatestOption ? (
                        <SelectItem value={LATEST_VERSION_VALUE}>{t('settings.backend.latest')}</SelectItem>
                      ) : null}
                      {versionOptions.map((ver) => (
                        <SelectItem key={ver} value={ver}>
                          {ver === backend.version ? `v${ver} (${t('backend.current')})` : `v${ver}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              })()}

              {backend.versionsLoading ? (
                <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                  <SpinnerIcon className="size-3" />
                  <span>{t('settings.backend.loadingVersions')}</span>
                </div>
              ) : versionsError ? (
                <div className="flex flex-col gap-0.5 text-[11.5px] text-red">
                  <div className="flex items-center gap-1.5">
                    <span>{t('settings.backend.versionsError')}</span>
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[11.5px] font-medium text-ink"
                      onClick={() => postToHost({ type: 'fetchBackendVersions', payload: { id: backend.id } })}
                    >
                      {t('settings.backend.retryVersions')}
                    </Button>
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

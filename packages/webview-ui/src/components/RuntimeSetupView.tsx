/**
 * 无可用运行时初始化页：
 * 当本机尚未安装任何智能体运行时、或当前选中的运行时未安装时展示，
 * 避免直接进入无法对话的首页，引导用户一键启用已安装运行时或一键安装。
 */
import { useEffect, useState } from 'react';
import type { BackendView } from '@harness-deck/shared';
import { openSettingsPage, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { useT, type MessageKey } from '../i18n.ts';
import { Button } from '@/components/ui/button';
import { BackendLogo } from './BackendLogo.tsx';
import { HarnessDeckLogo } from './HarnessDeckLogo.tsx';
import { DESCRIPTIONS } from './settings/agents/BackendCard.tsx';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GlobeIcon,
  RefreshIcon,
  SettingsIcon,
  SpinnerIcon,
} from './icons.tsx';

export function RuntimeSetupView() {
  const t = useT();
  const backends = useView((s) => s.backends);
  const clientSurface = useView((s) => s.clientSurface);
  const clientScope = useView((s) => s.clientScope);
  const isMobileRemote = clientSurface === 'mobile-web';
  const remoteReadOnly = isMobileRemote && clientScope === 'read-only';
  const nodeEnv = backends.nodeEnv;
  const npmReady = Boolean(nodeEnv?.checked && nodeEnv.hasNode && nodeEnv.hasNpm);
  const [copiedId, setCopiedId] = useState<string | undefined>();

  useEffect(() => {
    if (!isMobileRemote && !nodeEnv?.checked) {
      postToHost({ type: 'checkBackendEnv', payload: {} });
    }
  }, [isMobileRemote, nodeEnv?.checked]);

  const installedBackends = backends.items.filter((b) => b.available === true);
  const uninstalledBackends = backends.items.filter((b) => b.available !== true);

  const copyCommand = (backend: BackendView) => {
    const cmd = backend.installCommand ?? backend.installHint;
    if (!cmd) return;
    try {
      void navigator.clipboard?.writeText(cmd);
    } catch {
      // ignore in restricted clipboard env
    }
    setCopiedId(backend.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === backend.id ? undefined : prev)), 1_500);
  };

  const describeBackend = (backend: BackendView): string | undefined => {
    const key = DESCRIPTIONS[backend.id];
    if (key) return t(key);
    if (backend.installHint) return backend.installHint;
    if (backend.command) return t('backend.desc.acp', backend.command);
    return undefined;
  };

  return (
    <div
      className="empty relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-8"
      data-testid="runtime-setup-page"
    >
      <div className="home-backdrop pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative z-10 mx-auto flex w-full max-w-[520px] flex-col items-center gap-6">
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-3.5 flex items-center justify-center" aria-hidden="true">
            <div className="home-emblem-glow pointer-events-none absolute -inset-4 rounded-full blur-md" />
            <div className="relative flex size-13 items-center justify-center rounded-2xl bg-surface/90 p-1 shadow-raised backdrop-blur-sm">
              <HarnessDeckLogo className="size-10 rounded-[11px]" />
            </div>
          </div>
          <h1 className="m-0 text-[21px] leading-tight font-semibold tracking-[-0.025em] text-balance text-ink">
            {t('setup.title')}
          </h1>
          {isMobileRemote ? (
            <p className="mt-1.5 mb-0 text-[12.5px] text-ink-3">{t('setup.mobileHint')}</p>
          ) : null}
        </div>

        {installedBackends.length > 0 ? (
          <section className="flex w-full flex-col gap-2" data-testid="runtime-setup-installed">
            <div className="px-1 text-[11.5px] font-medium text-ink-3">{t('setup.readySection')}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {installedBackends.map((backend) => (
                <button
                  key={backend.id}
                  type="button"
                  disabled={remoteReadOnly}
                  data-testid={`runtime-setup-use-${backend.id}`}
                  onClick={() => postToHost({ type: 'selectBackend', payload: { id: backend.id } })}
                  className="flex items-center gap-3 rounded-2xl bg-field/55 px-4 py-3 text-left transition-colors hover:bg-field/90 disabled:cursor-default disabled:opacity-55 dark:bg-surface/65 dark:hover:bg-surface/95"
                >
                  <BackendLogo backend={backend} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold text-ink">{backend.name}</span>
                      <span className="size-1.5 shrink-0 rounded-full bg-green" aria-hidden="true" />
                    </div>
                    {backend.version ? (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-ink-3">
                        {t('settings.backend.version', backend.version)}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[12px] font-medium text-accent-ink">{t('setup.use')}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {uninstalledBackends.length > 0 ? (
          <section className="flex w-full flex-col gap-2" data-testid="runtime-setup-installable">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-[11.5px] font-medium text-ink-3">{t('setup.installSection')}</span>
              {!isMobileRemote && nodeEnv?.checked && !nodeEnv.hasNpm ? (
                <button
                  type="button"
                  onClick={() => postToHost({ type: 'openExternal', payload: { url: 'https://nodejs.org' } })}
                  className="inline-flex items-center gap-1 text-[11.5px] text-accent-ink hover:underline"
                >
                  <GlobeIcon className="size-3" />
                  <span>{t('settings.backend.needNpm')}</span>
                </button>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              {uninstalledBackends.map((backend) => {
                const desc = describeBackend(backend);
                const canOneClickInstall = Boolean(!isMobileRemote && backend.npmPackage && npmReady);
                const copyText = backend.installCommand ?? backend.installHint;
                const copied = copiedId === backend.id;
                return (
                  <div
                    key={backend.id}
                    data-testid={`runtime-setup-item-${backend.id}`}
                    className="flex items-center gap-3.5 rounded-2xl bg-field/55 px-4 py-3 transition-colors hover:bg-field/85 dark:bg-surface/65 dark:hover:bg-surface/90"
                  >
                    <BackendLogo backend={backend} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">{backend.name}</div>
                      {desc ? (
                        <p className="mt-0.5 mb-0 line-clamp-1 text-[11.5px] text-ink-3">{desc}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center">
                      {backend.busy ? (
                        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-ink">
                          <SpinnerIcon className="size-3.5" />
                          <span>{t(`settings.backend.busy.${backend.busy}` as MessageKey)}</span>
                        </span>
                      ) : canOneClickInstall ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          data-testid={`runtime-setup-install-${backend.id}`}
                          onClick={() => postToHost({ type: 'installBackend', payload: { id: backend.id } })}
                        >
                          <DownloadIcon className="size-3" />
                          <span>{t('settings.backend.install')}</span>
                        </Button>
                      ) : copyText ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          data-testid={`runtime-setup-copy-${backend.id}`}
                          onClick={() => copyCommand(backend)}
                          className="text-ink-2 hover:text-ink"
                        >
                          {copied ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                          <span>{copied ? t('settings.backend.copied') : t('settings.backend.copyCommand')}</span>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {!isMobileRemote ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="runtime-setup-recheck"
              onClick={() => {
                postToHost({ type: 'checkBackendEnv', payload: {} });
                postToHost({ type: 'restartRuntime', payload: {} });
              }}
              className="text-ink-2 hover:text-ink"
            >
              <RefreshIcon className="size-3.5" />
              <span>{t('setup.recheck')}</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="runtime-setup-open-settings"
            onClick={() => openSettingsPage('agents')}
          >
            <SettingsIcon className="size-3.5" />
            <span>{t('setup.openSettings')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

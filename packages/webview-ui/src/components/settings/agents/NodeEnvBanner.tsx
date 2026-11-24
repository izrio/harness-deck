import type { NodeEnvState } from '@harness-deck/shared';
import type { MessageKey } from '../../../i18n.ts';
import { useT } from '../../../i18n.ts';
import { postToHost } from '../../../vscode.ts';
import { ErrorIcon, GlobeIcon, RefreshIcon, SpinnerIcon } from '../../icons.tsx';
import { Button } from '@/components/ui/button';

export const NODE_DOWNLOAD_URL = 'https://nodejs.org/';

export function NodeEnvBanner({
  nodeEnv,
  onRefresh,
}: {
  readonly nodeEnv?: NodeEnvState;
  readonly onRefresh?: () => void;
}) {
  const t = useT();
  const refresh = onRefresh ?? (() => postToHost({ type: 'checkBackendEnv', payload: {} }));

  if (!nodeEnv || !nodeEnv.checked) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-2xl bg-field/45 px-4 py-2.5 text-[12px] text-ink-3 dark:bg-surface/50"
        data-testid="node-env-checking"
      >
        <div className="flex items-center gap-2">
          <SpinnerIcon className="size-3.5" />
          <span>{t('settings.node.checking')}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="settings-refresh-env"
          title={t('settings.refresh')}
          aria-label={t('settings.refresh')}
          onClick={refresh}
        >
          <RefreshIcon className="size-3.5 text-ink-3" />
        </Button>
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
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-orange-tint px-4 py-3 text-[12px]"
        role="alert"
        data-testid="node-env-missing"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2 leading-snug text-ink">
          <ErrorIcon className="mt-0.5 size-3.5 shrink-0 text-orange" />
          <span>{t(msgKey)}</span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            data-testid="install-node-btn"
            onClick={() => postToHost({ type: 'openExternal', payload: { url: NODE_DOWNLOAD_URL } })}
          >
            <GlobeIcon className="size-3.5" />
            <span>{t('settings.node.install')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="settings-refresh-env"
            onClick={refresh}
          >
            <RefreshIcon className="size-3.5" />
            <span>{t('settings.refresh')}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-2xl bg-field/45 px-4 py-2.5 text-[12px] text-ink-2 dark:bg-surface/50"
      data-testid="node-env-ok"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-green" />
        <span className="truncate font-mono text-[11.5px]">
          {t('settings.node.ready', nodeEnv.nodeVersion ?? '', nodeEnv.npmVersion ?? '')}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-ink-3 hover:text-ink"
        data-testid="settings-refresh-env"
        title={t('settings.refresh')}
        aria-label={t('settings.refresh')}
        onClick={refresh}
      >
        <RefreshIcon className="size-3.5" />
      </Button>
    </div>
  );
}

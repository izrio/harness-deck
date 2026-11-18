import type { NodeEnvState } from '@harness-deck/shared';
import type { MessageKey } from '../../../i18n.ts';
import { useT } from '../../../i18n.ts';
import { postToHost } from '../../../vscode.ts';
import { ErrorIcon, GlobeIcon, RefreshIcon, SpinnerIcon } from '../../icons.tsx';
import { Button } from '@/components/ui/button';

export const NODE_DOWNLOAD_URL = 'https://nodejs.org/';

export function NodeEnvBanner({ nodeEnv }: { readonly nodeEnv?: NodeEnvState }) {
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

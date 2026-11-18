/** dsh 运行时和连接状态提示（Beautiful UI 卡片）。连接正常时不显示。 */
import { useState } from 'react';
import type { ConnectionState, RuntimeStatus } from '@harness-deck/shared';
import { openSettingsPage } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '@/components/ui/button';
import { LoaderGrid, Shimmer } from './beautifului/index.ts';
import { ErrorIcon, LogIcon, RefreshIcon, SettingsIcon } from './icons.tsx';
import { useT, type Translate } from '../i18n.ts';

export function RuntimeBanner({ status, connection }: { status: RuntimeStatus; connection: ConnectionState }) {
  const t = useT();
  const view = describe(status, connection, t);
  if (!view) return null;
  const canInstallInSettings = status.kind === 'notInstalled' || status.kind === 'unsupportedVersion';
  const warn = view.tone === 'warn';
  return (
    <div className="content-column mt-2 mb-1">
      <section
        className="banner overflow-hidden rounded-card bg-surface shadow-card"
        role="status"
        style={{ animation: 'fade-up 240ms var(--ease-out-strong) both' }}
      >
      <div className={cn('primitive-card-bar flex items-center gap-2', (view.detail || view.actions) && 'border-b border-line')}>
        {warn ? (
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-orange-tint text-orange">
            <ErrorIcon className="size-3.5" />
          </span>
        ) : (
          <LoaderGrid />
        )}
        <p className="banner__title m-0 min-w-0 flex-1 text-[13px] font-medium text-ink">
          {warn ? view.title : <Shimmer>{view.title}</Shimmer>}
        </p>
      </div>
      {view.detail ? (
        <div className="primitive-card-pad">
          <BannerDetail text={view.detail} />
        </div>
      ) : null}
      {view.actions ? (
        <div className="banner__actions primitive-card-footer flex flex-wrap gap-2 border-t border-line">
          {canInstallInSettings ? (
            <Button type="button" size="sm" data-testid="banner-open-settings" onClick={() => openSettingsPage('agents')}>
              <SettingsIcon className="size-3.5" />
              {t('runtime.openSettings')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={canInstallInSettings ? 'outline' : 'default'}
            size="sm"
            onClick={() => postToHost({ type: 'restartRuntime', payload: {} })}
          >
            <RefreshIcon className="size-3.5" />
            {t('runtime.retry')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => postToHost({ type: 'showLogs', payload: {} })}>
            <LogIcon className="size-3.5" />
            {t('runtime.logs')}
          </Button>
        </div>
      ) : null}
      </section>
    </div>
  );
}

/** 错误信息可能带着堆栈：先只显示第一行，点开看全部。 */
function BannerDetail({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const first = text.split('\n', 1)[0] ?? '';
  const summary = first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT)}…` : first;
  if (summary === text) return <p className="m-0 text-[12.5px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{text}</p>;
  return (
    <div className="text-[12.5px] text-ink-2 [overflow-wrap:anywhere]">
      {open ? (
        <pre className="terminal-surface m-0 mb-1.5 max-h-40 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink shadow-hairline [overflow-wrap:anywhere]">
          {text}
        </pre>
      ) : (
        <p className="m-0 leading-relaxed">{summary}</p>
      )}
      <Button type="button" variant="ghost" size="xs" className="mt-1 -ml-2 text-ink-2 hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t('banner.less') : t('banner.more')}
      </Button>
    </div>
  );
}

const SUMMARY_LIMIT = 160;

interface BannerView {
  readonly title: string;
  readonly detail?: string;
  readonly tone: 'info' | 'warn';
  readonly actions?: boolean;
}

export function describe(status: RuntimeStatus, connection: ConnectionState, t: Translate): BannerView | undefined {
  switch (status.kind) {
    case 'idle':
      return undefined;
    case 'locating':
      return { title: t('runtime.locating'), tone: 'info' };
    case 'starting':
      return { title: t('runtime.starting'), ...(status.version ? { detail: t('runtime.version', status.version) } : {}), tone: 'info' };
    case 'connected':
      if (connection !== 'connected') return { title: t('runtime.connecting'), tone: 'info' };
      return status.newerThanTested
        ? { title: t('runtime.newer', status.version), detail: t('runtime.newerDetail'), tone: 'info' }
        : undefined;
    case 'reconnecting':
      return { title: t('runtime.restarting', status.attempt), tone: 'warn' };
    case 'notInstalled':
      return {
        title: t('runtime.notInstalled'),
        detail: status.detail ?? t('runtime.notInstalledDetail'),
        tone: 'warn',
        actions: true,
      };
    case 'unsupportedVersion':
      return { title: t('runtime.tooOld', status.version), detail: t('runtime.tooOldDetail', status.minimum), tone: 'warn', actions: true };
    case 'failed':
      return { title: t('runtime.failed'), detail: status.message, tone: 'warn', actions: true };
    case 'untrusted':
      return { title: t('runtime.untrusted'), detail: t('runtime.untrustedDetail'), tone: 'warn' };
  }
}

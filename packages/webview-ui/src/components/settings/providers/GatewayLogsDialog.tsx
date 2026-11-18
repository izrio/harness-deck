import { type ProviderGatewayLogEntry } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { postToHost } from '../../../vscode.ts';
import { ValuePill } from '../../beautifului/index.ts';
import { LogIcon, TrashIcon } from '../../icons.tsx';

export function GatewayLogsDialog({
  open,
  logs,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly logs: readonly ProviderGatewayLogEntry[];
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="provider-gateway-logs-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings.providers.gatewayLogsTitle')}</DialogTitle>
          <DialogDescription>{t('settings.providers.gatewayLogsDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
          {logs.length === 0 ? (
            <div
              className="rounded-control bg-field px-3 py-6 text-center text-[12px] text-ink-3 shadow-hairline"
              data-testid="provider-gateway-logs-empty"
            >
              {t('settings.providers.gatewayLogsEmpty')}
            </div>
          ) : (
            logs.map((entry) => {
              const tone =
                entry.level === 'error'
                  ? 'red'
                  : entry.level === 'warn'
                    ? 'orange'
                    : entry.status && entry.status < 400
                      ? 'green'
                      : 'neutral';
              const modelText =
                entry.requestModel && entry.mappedModel && entry.requestModel !== entry.mappedModel
                  ? `${entry.requestModel} → ${entry.mappedModel}`
                  : (entry.mappedModel ?? entry.requestModel);
              return (
                <div
                  key={entry.id}
                  data-testid={`provider-gateway-log-${entry.id}`}
                  className="flex flex-col gap-1 rounded-control bg-field/70 px-3 py-2 text-[11.5px] shadow-hairline"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10.5px] text-ink-3">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <ValuePill tone={tone} className="font-mono text-[10px]">
                      {entry.status !== undefined ? `HTTP ${entry.status}` : entry.level.toUpperCase()}
                    </ValuePill>
                    <ValuePill tone={entry.converted ? 'accent' : 'neutral'} className="text-[10px]">
                      {entry.converted
                        ? t('settings.providers.gatewayLogsConverted')
                        : t('settings.providers.gatewayLogsDirect')}
                    </ValuePill>
                    <span className="font-medium text-ink">{entry.providerName ?? entry.providerId}</span>
                    {entry.durationMs !== undefined ? (
                      <span className="ml-auto font-mono text-[10.5px] text-ink-3">{entry.durationMs}ms</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-ink-2">
                    <span>
                      {entry.method} {entry.path}
                    </span>
                    {modelText ? <span className="text-accent-ink">[{modelText}]</span> : null}
                  </div>
                  {entry.targetUrl ? (
                    <div className="truncate font-mono text-[10.5px] text-ink-3" title={entry.targetUrl}>
                      {entry.targetUrl}
                    </div>
                  ) : null}
                  <div className={cn('text-[11.5px] leading-snug', entry.level === 'error' ? 'text-destructive' : 'text-ink')}>
                    {entry.message}
                  </div>
                  {entry.detail ? (
                    <pre className="m-0 max-h-24 overflow-auto rounded bg-inset px-2 py-1 font-mono text-[10.5px] whitespace-pre-wrap break-all text-ink-2">
                      {entry.detail}
                    </pre>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={logs.length === 0}
            data-testid="provider-gateway-clear-logs-btn"
            onClick={() => postToHost({ type: 'clearProtocolGatewayLogs', payload: {} })}
          >
            <TrashIcon className="size-3" />
            <span>{t('settings.providers.gatewayClearLogsBtn')}</span>
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="provider-gateway-open-output-btn"
              onClick={() => postToHost({ type: 'showLogs', payload: {} })}
            >
              <LogIcon className="size-3" />
              <span>{t('settings.providers.gatewayOpenOutputBtn')}</span>
            </Button>
            <Button type="button" size="xs" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

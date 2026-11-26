import type { BackendView, ProviderView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { MoreIcon, PencilIcon, TrashIcon } from '../../icons.tsx';
import { ProviderVendorIcon } from './ProviderVendorIcon.tsx';

export function SavedProviderCard({
  provider,
  backends,
  workbenchAgents,
  protocolGatewayEnabled,
  editing,
  onEdit,
  onDelete,
}: {
  readonly provider: ProviderView;
  readonly backends: readonly BackendView[];
  readonly workbenchAgents: readonly { readonly id: string; readonly name: string }[];
  readonly protocolGatewayEnabled: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const t = useT();
  const usesGatewayConversion =
    protocolGatewayEnabled &&
    Boolean(provider.openaiChatUrl?.trim() || provider.openaiResponsesUrl?.trim()) &&
    (provider.convertOpenaiToAnthropic === true || !provider.anthropicUrl?.trim());

  const boundBackendNames = provider.boundBackendIds.map(
    (id) => backends.find((b) => b.id === id)?.name ?? id,
  );
  const boundWbNames = (provider.boundAgentIds ?? []).map(
    (id) => workbenchAgents.find((a) => a.id === id)?.name ?? id,
  );
  const allBoundNames = [...boundBackendNames, ...boundWbNames];

  return (
    <div
      data-testid={`provider-card-${provider.id}`}
      className={cn(
        'flex items-center gap-3.5 px-4 py-3.5 transition-colors duration-150',
        editing ? 'bg-accent-tint/45' : 'hover:bg-canvas/45 dark:hover:bg-hover/30',
      )}
    >
      <ProviderVendorIcon
        presetId={provider.presetId}
        name={provider.name}
        defaultModel={provider.defaultModel}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[13px] leading-5 font-semibold text-ink">{provider.name}</span>
          {provider.defaultModel ? (
            <code className="font-mono text-[11.5px] leading-none text-ink-3">
              {provider.defaultModel}
            </code>
          ) : null}
          {!provider.hasApiKey ? (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] leading-none text-orange">
              <span className="size-1.5 shrink-0 rounded-full bg-orange" />
              <span>{t('settings.providers.apiKeyMissingBadge')}</span>
            </span>
          ) : null}
          {usesGatewayConversion ? (
            <span className="inline-flex items-center rounded-md bg-canvas/85 px-1.5 py-0.5 text-[10.5px] leading-4 font-medium text-ink-2 dark:bg-page/55">
              {t('settings.providers.convertedBadge')}
            </span>
          ) : null}
        </div>

        {allBoundNames.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {allBoundNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center rounded-md bg-canvas/85 px-2 py-0.5 text-[11px] leading-4 text-ink-2 dark:bg-page/55"
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-ink-2 hover:text-ink"
              data-testid={`provider-actions-${provider.id}`}
              aria-label={t('common.moreActions')}
              title={t('common.moreActions')}
            >
              <MoreIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            <DropdownMenuItem
              className="gap-2 text-[12.5px]"
              data-testid={`edit-provider-${provider.id}`}
              onSelect={onEdit}
            >
              <PencilIcon className="size-3.5 text-ink-2" />
              <span>{t('common.edit')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="gap-2 text-[12.5px]"
              data-testid={`delete-provider-${provider.id}`}
              onSelect={onDelete}
            >
              <TrashIcon className="size-3.5" />
              <span>{t('common.delete')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

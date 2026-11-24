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
        'flex items-start justify-between gap-3 rounded-xl px-3 py-3 transition-colors duration-150',
        editing ? 'bg-accent-tint/50' : 'hover:bg-canvas/70 dark:hover:bg-hover/35',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderVendorIcon
            presetId={provider.presetId}
            name={provider.name}
            defaultModel={provider.defaultModel}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[13px] font-semibold text-ink">{provider.name}</span>
              {provider.hasApiKey ? (
                <span className="text-[11.5px] text-green">
                  {t('settings.providers.apiKeySavedBadge')}
                </span>
              ) : (
                <span className="text-[11.5px] text-orange">
                  {t('settings.providers.apiKeyMissingBadge')}
                </span>
              )}
              {provider.defaultModel ? (
                <span className="font-mono text-[11.5px] text-ink-3">
                  {t('settings.providers.defaultTag', provider.defaultModel)}
                </span>
              ) : null}
              {provider.smallModel && provider.smallModel !== provider.defaultModel ? (
                <span className="font-mono text-[11.5px] text-ink-3">
                  {t('settings.providers.smallTag', provider.smallModel)}
                </span>
              ) : null}
              {usesGatewayConversion ? (
                <span className="rounded-md bg-accent-tint/70 px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">
                  {t('settings.providers.convertedBadge')}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pl-9.5 text-[11.5px]">
          {allBoundNames.length > 0 ? (
            allBoundNames.map((name) => (
              <span
                key={name}
                className="rounded-md bg-accent-tint/65 px-1.5 py-0.5 text-[11px] font-medium text-accent-ink"
              >
                {name}
              </span>
            ))
          ) : (
            <span className="text-ink-3">{t('settings.providers.unbound')}</span>
          )}
        </div>
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

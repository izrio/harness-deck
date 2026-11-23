import { PROVIDER_PRESETS, type BackendView, type ProviderView } from '@harness-deck/shared';
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
import { ValuePill } from '../../beautifului/index.ts';
import { MoreIcon, PencilIcon, TrashIcon } from '../../icons.tsx';

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
  const preset = PROVIDER_PRESETS.find((p) => p.id === provider.presetId);
  const badge = preset?.badge ?? provider.name.slice(0, 1).toUpperCase();
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
        'flex items-start justify-between gap-3 px-3.5 py-3 transition-colors duration-150',
        editing ? 'bg-accent-tint/45 shadow-[inset_2px_0_0_0_var(--accent)]' : 'hover:bg-hover/35',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-inset text-[12px] font-semibold text-ink shadow-hairline">
            {badge}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-semibold text-ink">{provider.name}</span>
              {provider.hasApiKey ? (
                <ValuePill tone="green" className="text-[10.5px]">
                  {t('settings.providers.apiKeySavedBadge')}
                </ValuePill>
              ) : (
                <ValuePill tone="orange" className="text-[10.5px]">
                  {t('settings.providers.apiKeyMissingBadge')}
                </ValuePill>
              )}
              {provider.defaultModel ? (
                <ValuePill className="font-mono text-[10.5px]">
                  {t('settings.providers.defaultTag', provider.defaultModel)}
                </ValuePill>
              ) : null}
              {provider.smallModel && provider.smallModel !== provider.defaultModel ? (
                <ValuePill className="font-mono text-[10.5px]">
                  {t('settings.providers.smallTag', provider.smallModel)}
                </ValuePill>
              ) : null}
              {usesGatewayConversion ? (
                <ValuePill tone="accent" className="text-[10.5px]">
                  {t('settings.providers.convertedBadge')}
                </ValuePill>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pl-8 text-[11.5px]">
          {allBoundNames.length > 0 ? (
            allBoundNames.map((name) => (
              <ValuePill key={name} tone="accent" className="text-[11px]">
                {name}
              </ValuePill>
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

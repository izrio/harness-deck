import { PROVIDER_PRESETS, type BackendView, type ProviderView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { useT } from '../../../i18n.ts';
import { cn } from '../../../lib/utils.ts';
import { ValuePill } from '../../beautifului/index.ts';
import { PencilIcon, TrashIcon } from '../../icons.tsx';

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
        'flex flex-col gap-2 rounded-card p-3 transition-colors duration-150',
        editing ? 'bg-inset shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'bg-field shadow-hairline',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-surface text-[12px] font-semibold text-ink shadow-hairline">
            {badge}
          </span>
          <div className="min-w-0">
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

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="default"
            data-testid={`edit-provider-${provider.id}`}
            onClick={onEdit}
          >
            <PencilIcon className="size-3" />
            <span>{t('common.edit')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="text-destructive hover:text-destructive"
            data-testid={`delete-provider-${provider.id}`}
            onClick={onDelete}
          >
            <TrashIcon className="size-3" />
            <span>{t('common.delete')}</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
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
  );
}

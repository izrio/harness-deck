import type { BackendView, McpServerConfig } from '@harness-deck/shared';
import { GlobeIcon, MoreIcon, PencilIcon, TerminalIcon, TrashIcon } from '../../icons.tsx';
import { BackendLogo } from '../../BackendLogo.tsx';
import { ValuePill } from '../../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '../../../lib/utils.ts';
import { serverSummary } from './mcpParsers.ts';
import { useT } from '../../../i18n.ts';

export function McpServerCard({
  agents,
  openEdit,
  toggleServerEnabled,
  toggleServerAgent,
  deleteServer,
  server,
}: {
  agents: readonly Pick<BackendView, 'id' | 'name'>[];
  openEdit: (server: McpServerConfig) => void;
  toggleServerEnabled: (server: McpServerConfig, enabled: boolean) => void;
  toggleServerAgent: (server: McpServerConfig, agentId: string) => void;
  deleteServer: (id: string) => void;
  server: McpServerConfig;
}) {
  const t = useT();
  const envCount = server.env ? Object.keys(server.env).length : 0;
  const headerCount = server.headers ? Object.keys(server.headers).length : 0;
  const summary = serverSummary(server);
  const isRemote = server.transport !== 'stdio';

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-line/75 bg-surface/80 px-4 py-3.5 shadow-xs transition-colors hover:border-line-strong dark:bg-surface/75',
        server.enabled ? '' : 'opacity-65',
      )}
      data-testid={`mcp-server-${server.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <div
            className={cn(
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border',
              isRemote
                ? 'border-brand/25 bg-accent-tint/70 text-accent-ink'
                : 'border-line/70 bg-field text-ink-2',
            )}
            aria-hidden="true"
          >
            {isRemote ? <GlobeIcon className="size-3.5" /> : <TerminalIcon className="size-3.5" />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-mono text-[13px] font-semibold text-ink">
                {server.name}
              </span>
              <ValuePill
                tone={isRemote ? 'accent' : 'neutral'}
                className="font-mono text-[10px] uppercase"
              >
                {server.transport}
              </ValuePill>
              {server.importedFrom ? (
                <ValuePill className="text-[10.5px]">
                  {t('settings.mcp.importedFrom', server.importedFrom)}
                </ValuePill>
              ) : null}
              {envCount > 0 ? (
                <ValuePill className="text-[10.5px]">{t('settings.mcp.envCount', envCount)}</ValuePill>
              ) : null}
              {headerCount > 0 ? (
                <ValuePill className="text-[10.5px]">
                  {t('settings.mcp.headerCount', headerCount)}
                </ValuePill>
              ) : null}
            </div>

            {summary ? (
              <div
                className="mt-0.5 truncate font-mono text-[11.5px] text-ink-3"
                title={summary}
              >
                {summary}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Switch
            size="default"
            checked={server.enabled}
            aria-label={server.name}
            data-testid={`toggle-mcp-${server.id}`}
            onCheckedChange={(checked) => toggleServerEnabled(server, checked)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-ink-2 hover:text-ink"
                data-testid={`mcp-actions-${server.id}`}
                aria-label={t('common.moreActions')}
                title={t('common.moreActions')}
              >
                <MoreIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem
                className="gap-2 text-[12.5px]"
                data-testid={`edit-mcp-${server.id}`}
                onSelect={() => openEdit(server)}
              >
                <PencilIcon className="size-3.5 text-ink-2" />
                <span>{t('common.edit')}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="gap-2 text-[12.5px]"
                data-testid={`delete-mcp-${server.id}`}
                onSelect={() => deleteServer(server.id)}
              >
                <TrashIcon className="size-3.5" />
                <span>{t('common.delete')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <TooltipProvider delayDuration={150}>
        <div className="flex flex-wrap items-center gap-1.5 sm:pl-10.5">
          <span className="mr-0.5 text-[11px] text-ink-3">{t('settings.mcp.agentsLabel')}</span>
          {agents.map((agent) => {
            const selected = server.agents.includes(agent.id);
            return (
              <Tooltip key={agent.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid={`mcp-agent-${server.id}-${agent.id}`}
                    aria-label={agent.name}
                    aria-pressed={selected}
                    title={agent.name}
                    onClick={() => toggleServerAgent(server, agent.id)}
                    className={cn(
                      'relative inline-flex size-7 cursor-pointer items-center justify-center rounded-md border transition-all',
                      selected
                        ? 'border-brand/70 bg-accent-tint/90 ring-1 ring-inset ring-brand/20'
                        : 'border-line/60 bg-field/45 opacity-45 grayscale hover:border-line-strong hover:bg-hover hover:opacity-90 hover:grayscale-0',
                    )}
                  >
                    <BackendLogo backend={agent} size="sm" />
                    {selected ? (
                      <span
                        className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-brand ring-1 ring-surface"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="px-2 py-1 text-[11px]">
                  {agent.name}
                </TooltipContent>
              </Tooltip>
            );
          })}
          {server.agents.length === 0 ? (
            <span className="ml-1 text-[11px] text-ink-4">{t('settings.mcp.noAgentsSelected')}</span>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  );
}

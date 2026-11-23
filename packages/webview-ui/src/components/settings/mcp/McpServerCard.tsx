import type { McpServerConfig } from '@harness-deck/shared';
import { CheckIcon, MoreIcon, PencilIcon, TrashIcon } from '../../icons.tsx';
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
import { cn } from '../../../lib/utils.ts';
import { serverSummary } from './mcpParsers.ts';
import type { BackendView } from '@harness-deck/shared';
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
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 px-3.5 py-3 transition-colors hover:bg-hover/35',
        server.enabled ? '' : 'opacity-70',
      )}
      data-testid={`mcp-server-${server.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[13px] font-semibold text-ink">{server.name}</span>
            <ValuePill tone="accent" className="font-mono text-[10px] uppercase">
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

      <div className="truncate font-mono text-[11.5px] text-ink-3">{serverSummary(server)}</div>

      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <span className="text-[11px] text-ink-3">{t('settings.mcp.agentsLabel')}</span>
        {agents.map((agent) => {
          const selected = server.agents.includes(agent.id);
          return (
            <button
              key={agent.id}
              type="button"
              data-testid={`mcp-agent-${server.id}-${agent.id}`}
              onClick={() => toggleServerAgent(server, agent.id)}
              className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2 py-0.5 text-[11px] transition-colors ${
                selected
                  ? 'border-brand bg-accent-tint font-medium text-accent-ink'
                  : 'border-line bg-surface text-ink-3 hover:bg-hover'
              }`}
            >
              {selected ? <CheckIcon className="size-2.5" /> : null}
              <span>{agent.name}</span>
            </button>
          );
        })}
        {server.agents.length === 0 ? (
          <span className="text-[11px] text-ink-4">{t('settings.mcp.noAgentsSelected')}</span>
        ) : null}
      </div>
    </div>
  );
}

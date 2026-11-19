import type { McpServerConfig } from '@harness-deck/shared';
import { CheckIcon, PencilIcon, TrashIcon } from '../../icons.tsx';
import { ValuePill } from '../../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { serverSummary } from './mcpParsers.ts';
import type { BackendView } from '@harness-deck/shared';
import { useT } from '../../../i18n.ts';

export function McpServerCard({ agents, openEdit, toggleServerEnabled, toggleServerAgent, deleteServer, server }: { agents: readonly Pick<BackendView, 'id' | 'name'>[]; openEdit: (server: McpServerConfig) => void; toggleServerEnabled: (server: McpServerConfig, enabled: boolean) => void; toggleServerAgent: (server: McpServerConfig, agentId: string) => void; deleteServer: (id: string) => void; server: McpServerConfig }) {
  const t = useT();
  const envCount = server.env ? Object.keys(server.env).length : 0;
  const headerCount = server.headers ? Object.keys(server.headers).length : 0;
  return (
    <div
      className={`flex flex-col gap-2 rounded-card bg-field p-3 shadow-hairline transition-opacity ${
        server.enabled ? '' : 'opacity-70'
      }`}
      data-testid={`mcp-server-${server.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-chip bg-surface px-2 py-0.5 font-mono text-[12px] font-semibold text-ink shadow-hairline">
              {server.name}
            </span>
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('common.edit')}
            data-testid={`edit-mcp-${server.id}`}
            onClick={() => openEdit(server)}
          >
            <PencilIcon className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-red hover:bg-red-tint hover:text-red"
            aria-label={t('common.delete')}
            data-testid={`delete-mcp-${server.id}`}
            onClick={() => deleteServer(server.id)}
          >
            <TrashIcon className="size-3" />
          </Button>
        </div>
      </div>

      <div className="truncate rounded-control bg-surface/80 px-2.5 py-1.5 font-mono text-[11.5px] text-ink-2 shadow-hairline">
        {serverSummary(server)}
      </div>

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

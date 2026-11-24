/**
 * 设置 -> 扩展 -> MCP 服务器：
 * 统一管理 Model Context Protocol 服务器（stdio / http / sse），
 * 选择启动时交给哪些 Agent，并支持从本机与工作区各 Agent 配置文件一键导入。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpImportCandidate, McpServerConfig } from '@harness-deck/shared';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setExtensionsLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  CheckIcon,
  DownloadIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SlidersIcon,
  SparklesIcon,
  SpinnerIcon,
} from '../icons.tsx';
import { FALLBACK_BACKENDS } from '@/lib/workbenchOptions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  emptyMcpForm,
  formatArgs,
  formFromServer,
  parseKeyValueLines,
  parsePastedMcpSnippet,
  splitCommandArgs,
} from './mcp/mcpParsers.ts';
import type { McpFormState } from './mcp/mcpParsers.ts';
import { MCP_MARKET_CATALOG, type McpMarketCategory, type McpMarketEntry } from './mcp/mcpCatalog.ts';
import { McpServerCard } from './mcp/McpServerCard.tsx';
import { McpImportDialog } from './mcp/McpImportDialog.tsx';
import { McpFormDialog } from './mcp/McpFormDialog.tsx';

const MCP_MARKET_CATEGORIES: readonly { readonly id: 'all' | McpMarketCategory; readonly labelKey: MessageKey }[] = [
  { id: 'all', labelKey: 'settings.mcp.market.catAll' },
  { id: 'dev', labelKey: 'settings.mcp.market.catDev' },
  { id: 'web', labelKey: 'settings.mcp.market.catWeb' },
  { id: 'data', labelKey: 'settings.mcp.market.catData' },
  { id: 'collab', labelKey: 'settings.mcp.market.catCollab' },
];

export function McpSettings() {
  const t = useT();
  const locale = useView((s) => s.locale);
  const extensions = useView((s) => s.extensions);
  const backendItems = useView((s) => s.backends.items);
  const agents = backendItems.length > 0 ? backendItems : FALLBACK_BACKENDS;
  const { mcp } = extensions;

  const [activeTab, setActiveTab] = useState<'installed' | 'market'>('installed');
  const [marketQuery, setMarketQuery] = useState('');
  const [marketCategory, setMarketCategory] = useState<'all' | McpMarketCategory>('all');

  const [form, setForm] = useState<McpFormState | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [showJsonPaste, setShowJsonPaste] = useState(false);
  const [jsonText, setJsonText] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<string[]>([]);
  const [importAgents, setImportAgents] = useState<string[]>([]);

  useEffect(() => {
    if (!mcp.importCandidates) return;
    setSelectedCandidateKeys(mcp.importCandidates.filter((c) => !c.conflict).map((c) => c.key));
  }, [mcp.importCandidates]);

  const openAdd = () => {
    setFormError(undefined);
    setShowJsonPaste(false);
    setJsonText('');
    setForm(emptyMcpForm(agents.map((a) => a.id)));
  };

  const openEdit = (server: McpServerConfig) => {
    setFormError(undefined);
    setShowJsonPaste(false);
    setJsonText('');
    setForm(formFromServer(server));
  };

  const closeForm = () => {
    setForm(undefined);
    setFormError(undefined);
    setShowJsonPaste(false);
    setJsonText('');
  };

  const applyPastedJson = () => {
    if (!form) return;
    const patch = parsePastedMcpSnippet(jsonText, form);
    if (!patch) {
      setFormError(t('settings.mcp.form.jsonError'));
      return;
    }
    setFormError(undefined);
    setForm({ ...form, ...patch });
    setShowJsonPaste(false);
    setJsonText('');
  };

  const toggleFormAgent = (agentId: string) => {
    if (!form) return;
    const next = form.agents.includes(agentId)
      ? form.agents.filter((id) => id !== agentId)
      : [...form.agents, agentId];
    setForm({ ...form, agents: next });
  };

  const submitForm = () => {
    if (!form) return;
    const cleanName = form.name.trim();
    if (form.transport === 'stdio') {
      const cleanCmd = form.command.trim();
      if (!cleanName || !cleanCmd) {
        setFormError(t('settings.mcp.form.validationStdio'));
        return;
      }
      const args = splitCommandArgs(form.argsText);
      const env = parseKeyValueLines(form.envText, false);
      const id = form.id ?? (cleanName.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'mcp-server');
      const nextServer: McpServerConfig = {
        id,
        name: cleanName,
        transport: 'stdio',
        command: cleanCmd,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        enabled: form.enabled,
        agents: [...form.agents],
        ...(form.importedFrom ? { importedFrom: form.importedFrom } : {}),
      };
      const existingIdx = mcp.servers.findIndex((s) => s.id === (form.id ?? id));
      const nextServers =
        existingIdx >= 0
          ? mcp.servers.map((s, idx) => (idx === existingIdx ? nextServer : s))
          : [...mcp.servers, nextServer];
      setExtensionsLocal({ ...extensions, mcp: { ...mcp, servers: nextServers } });
      postToHost({
        type: 'upsertMcpServer',
        payload: {
          ...(form.id ? { id: form.id } : {}),
          name: cleanName,
          transport: 'stdio',
          command: cleanCmd,
          ...(args.length > 0 ? { args } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          enabled: form.enabled,
          agents: [...form.agents],
          ...(form.importedFrom ? { importedFrom: form.importedFrom } : {}),
        },
      });
      closeForm();
      return;
    }

    const cleanUrl = form.url.trim();
    if (!cleanName || !/^https?:\/\/\S+/iu.test(cleanUrl)) {
      setFormError(t('settings.mcp.form.validationHttp'));
      return;
    }
    const headers = parseKeyValueLines(form.headersText, true);
    const id = form.id ?? (cleanName.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'mcp-server');
    const nextServer: McpServerConfig = {
      id,
      name: cleanName,
      transport: form.transport,
      url: cleanUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      enabled: form.enabled,
      agents: [...form.agents],
      ...(form.importedFrom ? { importedFrom: form.importedFrom } : {}),
    };
    const existingIdx = mcp.servers.findIndex((s) => s.id === (form.id ?? id));
    const nextServers =
      existingIdx >= 0
        ? mcp.servers.map((s, idx) => (idx === existingIdx ? nextServer : s))
        : [...mcp.servers, nextServer];
    setExtensionsLocal({ ...extensions, mcp: { ...mcp, servers: nextServers } });
    postToHost({
      type: 'upsertMcpServer',
      payload: {
        ...(form.id ? { id: form.id } : {}),
        name: cleanName,
        transport: form.transport,
        url: cleanUrl,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        enabled: form.enabled,
        agents: [...form.agents],
        ...(form.importedFrom ? { importedFrom: form.importedFrom } : {}),
      },
    });
    closeForm();
  };

  const toggleServerEnabled = (server: McpServerConfig, enabled: boolean) => {
    setExtensionsLocal({
      ...extensions,
      mcp: {
        ...mcp,
        servers: mcp.servers.map((item) => (item.id === server.id ? { ...item, enabled } : item)),
      },
    });
    postToHost({ type: 'toggleMcpServer', payload: { id: server.id, enabled } });
  };

  const toggleServerAgent = (server: McpServerConfig, agentId: string) => {
    const nextAgents = server.agents.includes(agentId)
      ? server.agents.filter((id) => id !== agentId)
      : [...server.agents, agentId];
    setExtensionsLocal({
      ...extensions,
      mcp: {
        ...mcp,
        servers: mcp.servers.map((item) => (item.id === server.id ? { ...item, agents: nextAgents } : item)),
      },
    });
    postToHost({ type: 'toggleMcpServer', payload: { id: server.id, agents: nextAgents } });
  };

  const deleteServer = (id: string) => {
    setExtensionsLocal({
      ...extensions,
      mcp: { ...mcp, servers: mcp.servers.filter((item) => item.id !== id) },
    });
    postToHost({ type: 'deleteMcpServer', payload: { id } });
  };

  const openImportDialog = () => {
    setImportAgents(agents.map((a) => a.id));
    setImportOpen(true);
    postToHost({ type: 'scanAgentMcpConfigs', payload: {} });
  };

  const toggleCandidate = (key: string) => {
    setSelectedCandidateKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const toggleImportAgent = (agentId: string) => {
    setImportAgents((prev) => (prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]));
  };

  const candidates: readonly McpImportCandidate[] = mcp.importCandidates ?? [];
  const selectedCandidates = candidates.filter((c) => selectedCandidateKeys.includes(c.key));

  const submitImport = () => {
    if (selectedCandidates.length === 0) return;
    postToHost({
      type: 'importMcpServers',
      payload: {
        servers: selectedCandidates.map((item) => ({
          name: item.name,
          transport: item.transport,
          ...(item.command ? { command: item.command } : {}),
          ...(item.args ? { args: [...item.args] } : {}),
          ...(item.env ? { env: { ...item.env } } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.headers ? { headers: { ...item.headers } } : {}),
          importedFrom: item.sourceAgentName,
        })),
        agents: importAgents,
      },
    });
    setImportOpen(false);
  };

  const marketRetriedRef = useRef(false);

  useEffect(() => {
    if (activeTab !== 'market') {
      marketRetriedRef.current = false;
      return;
    }
    if (!mcp.market) {
      postToHost({ type: 'fetchMcpMarket', payload: {} });
      return;
    }
    if (mcp.market.source === 'fallback' && !mcp.market.loading && !marketRetriedRef.current) {
      marketRetriedRef.current = true;
      const q = marketQuery.trim();
      postToHost({ type: 'fetchMcpMarket', payload: { ...(q ? { query: q } : {}), force: true } });
    }
  }, [activeTab, mcp.market, marketQuery]);

  useEffect(() => {
    if (activeTab !== 'market' || !mcp.market) return;
    const trimmed = marketQuery.trim();
    if (trimmed === (mcp.market.query ?? '')) return;
    const timer = window.setTimeout(() => {
      postToHost({ type: 'fetchMcpMarket', payload: trimmed ? { query: trimmed } : {} });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeTab, marketQuery, mcp.market]);

  const marketItems = useMemo(() => {
    if (mcp.market) {
      if (mcp.market.items.length > 0 || (mcp.market.source === 'online' && mcp.market.query)) {
        return mcp.market.items;
      }
    }
    return MCP_MARKET_CATALOG;
  }, [mcp.market]);
  const marketLoading = Boolean(mcp.market?.loading);
  const marketSource = mcp.market?.source;

  const installedServerKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const s of mcp.servers) {
      keys.add(s.id.toLowerCase());
      keys.add(s.name.toLowerCase());
    }
    return keys;
  }, [mcp.servers]);

  const filteredMarket = useMemo(() => {
    const q = marketQuery.trim().toLowerCase();
    const serverMatched =
      mcp.market?.source === 'online' &&
      Boolean(q) &&
      (mcp.market.query?.trim().toLowerCase() ?? '') === q;
    return marketItems.filter((entry) => {
      if (marketCategory !== 'all' && entry.category !== marketCategory) return false;
      if (!q || serverMatched) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        (entry.descZh?.toLowerCase().includes(q) ?? false) ||
        (entry.descEn?.toLowerCase().includes(q) ?? false) ||
        (entry.command?.toLowerCase().includes(q) ?? false) ||
        (entry.url?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [marketCategory, marketItems, marketQuery, mcp.market?.query, mcp.market?.source]);

  const installFromMarket = (entry: McpMarketEntry) => {
    const defaultAgentIds = agents.map((a) => a.id);
    if (entry.needsConfig) {
      setFormError(undefined);
      setShowJsonPaste(false);
      setJsonText('');
      setForm({
        name: entry.name,
        transport: entry.transport,
        command: entry.command ?? '',
        argsText: formatArgs(entry.args),
        envText: entry.envKeys ? entry.envKeys.map((k) => `${k}=`).join('\n') : '',
        url: entry.url ?? '',
        headersText: '',
        enabled: true,
        agents: defaultAgentIds,
        importedFrom: 'Marketplace',
      });
      return;
    }

    const nextServer: McpServerConfig =
      entry.transport === 'stdio'
        ? {
            id: entry.id,
            name: entry.name,
            transport: 'stdio',
            command: entry.command ?? '',
            ...(entry.args && entry.args.length > 0 ? { args: [...entry.args] } : {}),
            enabled: true,
            agents: defaultAgentIds,
            importedFrom: 'Marketplace',
          }
        : {
            id: entry.id,
            name: entry.name,
            transport: entry.transport,
            url: entry.url ?? '',
            enabled: true,
            agents: defaultAgentIds,
            importedFrom: 'Marketplace',
          };
    const existingIdx = mcp.servers.findIndex((s) => s.id === entry.id);
    const nextServers =
      existingIdx >= 0
        ? mcp.servers.map((s, idx) => (idx === existingIdx ? nextServer : s))
        : [...mcp.servers, nextServer];
    setExtensionsLocal({ ...extensions, mcp: { ...mcp, servers: nextServers } });
    postToHost({
      type: 'upsertMcpServer',
      payload:
        entry.transport === 'stdio'
          ? {
              name: entry.name,
              transport: 'stdio',
              command: entry.command ?? '',
              ...(entry.args && entry.args.length > 0 ? { args: [...entry.args] } : {}),
              enabled: true,
              agents: defaultAgentIds,
              importedFrom: 'Marketplace',
            }
          : {
              name: entry.name,
              transport: entry.transport,
              url: entry.url ?? '',
              enabled: true,
              agents: defaultAgentIds,
              importedFrom: 'Marketplace',
            },
    });
  };

  return (
    <div className="flex flex-col gap-5" data-testid="settings-mcp">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-1">
        <h3 className="m-0 truncate text-[13px] font-semibold tracking-tight text-ink">
          {t('settings.mcp.title')}
        </h3>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-ink-2 hover:text-ink"
            data-testid="mcp-import-btn"
            onClick={openImportDialog}
          >
            <DownloadIcon className="size-3.5" />
            <span>{t('settings.mcp.importBtn')}</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="mcp-add-btn"
            onClick={openAdd}
          >
            <PlusIcon className="size-3.5" />
            <span>{t('settings.mcp.addBtn')}</span>
          </Button>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'installed' | 'market')}
        className="gap-4"
      >
        <TabsList className="h-auto w-fit gap-1 rounded-xl bg-field/65 p-1 dark:bg-surface/65">
          <TabsTrigger
            value="installed"
            data-testid="mcp-tab-installed"
            onClick={() => setActiveTab('installed')}
            className="flex-none gap-1.5 rounded-lg border-0 px-3 py-1.5 text-[12.5px] shadow-none data-[state=active]:bg-canvas data-[state=active]:shadow-none dark:data-[state=active]:bg-page/75"
          >
            <ServerIcon className="size-3.5 shrink-0" />
            <span>{t('settings.mcp.tabInstalled')}</span>
            <span className="text-[11px] font-normal text-ink-3 tabular-nums">
              {mcp.servers.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="market"
            data-testid="mcp-tab-market"
            onClick={() => setActiveTab('market')}
            className="flex-none gap-1.5 rounded-lg border-0 px-3 py-1.5 text-[12.5px] shadow-none data-[state=active]:bg-canvas data-[state=active]:shadow-none dark:data-[state=active]:bg-page/75"
          >
            <SparklesIcon className="size-3.5 shrink-0" />
            <span>{t('settings.mcp.tabMarket')}</span>
            <span className="text-[11px] font-normal text-ink-3 tabular-nums">
              {marketItems.length}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="installed" className="mt-0" data-testid="mcp-panel-installed">
          {mcp.servers.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 rounded-2xl bg-field/55 px-4 py-10 text-center text-[12px] text-ink-3 dark:bg-surface/65"
              data-testid="mcp-empty"
            >
              <span>{t('settings.mcp.empty')}</span>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => setActiveTab('market')}
              >
                <SparklesIcon className="size-3" />
                <span>{t('settings.mcp.tabMarket')}</span>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {mcp.servers.map((server) => (
                <McpServerCard key={server.id} agents={agents} openEdit={openEdit} toggleServerEnabled={toggleServerEnabled} toggleServerAgent={toggleServerAgent} deleteServer={deleteServer} server={server} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="market" className="mt-0" data-testid="mcp-panel-market">
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-44 flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
                <Input
                  size="sm"
                  data-testid="mcp-market-search"
                  value={marketQuery}
                  onChange={(e) => setMarketQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const q = marketQuery.trim();
                      postToHost({ type: 'fetchMcpMarket', payload: { ...(q ? { query: q } : {}), force: true } });
                    }
                  }}
                  placeholder={t('settings.mcp.market.searchPlaceholder')}
                  aria-label={t('settings.mcp.market.searchPlaceholder')}
                  className="pl-8 text-[12px]"
                />
              </div>
              <div className="flex items-center gap-1.5">
                {marketSource && !marketLoading ? (
                  <span
                    data-testid="mcp-market-source"
                    title={mcp.market?.error}
                    className={cn(
                      'px-1.5 text-[11px]',
                      marketSource === 'online' ? 'text-green' : 'text-ink-3',
                    )}
                  >
                    {marketSource === 'online'
                      ? t('settings.market.sourceOnline')
                      : t('settings.market.sourceFallback')}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-ink-2 hover:text-ink"
                  disabled={marketLoading}
                  data-testid="mcp-market-refresh"
                  onClick={() => {
                    const q = marketQuery.trim();
                    postToHost({ type: 'fetchMcpMarket', payload: { ...(q ? { query: q } : {}), force: true } });
                  }}
                >
                  {marketLoading ? <SpinnerIcon className="size-3.5" /> : <RefreshIcon className="size-3.5" />}
                  <span>{t('settings.market.refresh')}</span>
                </Button>
              </div>
            </div>
            {marketSource === 'fallback' && !marketLoading && mcp.market?.error ? (
              <div className="truncate px-1 text-[11px] text-ink-3" data-testid="mcp-market-error">
                {mcp.market.error}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              {MCP_MARKET_CATEGORIES.map((cat) => {
                const active = marketCategory === cat.id;
                return (
                  <Button
                    key={cat.id}
                    type="button"
                    variant={active ? 'secondary' : 'ghost'}
                    size="xs"
                    data-testid={`mcp-market-cat-${cat.id}`}
                    onClick={() => setMarketCategory(cat.id)}
                    className={cn('rounded-full px-2.5', active ? 'font-medium text-ink' : 'text-ink-3 hover:text-ink')}
                  >
                    {t(cat.labelKey)}
                  </Button>
                );
              })}
            </div>

            {filteredMarket.length === 0 ? (
              <div className="rounded-2xl bg-field/55 px-4 py-10 text-center text-[12px] text-ink-3 dark:bg-surface/65">
                {t('settings.mcp.market.empty')}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {filteredMarket.map((entry) => {
                  const installed =
                    installedServerKeys.has(entry.id.toLowerCase()) ||
                    installedServerKeys.has(entry.name.toLowerCase());
                  return (
                    <div
                      key={entry.id}
                      data-testid={`mcp-market-item-${entry.id}`}
                      className="flex flex-col justify-between gap-3 rounded-2xl bg-field/55 p-4 transition-colors hover:bg-field/85 dark:bg-surface/65 dark:hover:bg-surface/90"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[12.5px] font-semibold text-ink">
                            {entry.name}
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                            {entry.version ? <span>v{entry.version}</span> : null}
                            <span className={cn('uppercase', entry.transport !== 'stdio' && 'text-accent-ink')}>
                              {entry.transport}
                            </span>
                          </div>
                        </div>
                        <p className="mt-1 mb-0 line-clamp-2 text-[11.5px] leading-relaxed text-ink-2">
                          {locale === 'en'
                            ? (entry.descEn ?? entry.description)
                            : (entry.descZh ?? entry.description)}
                        </p>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        {installed ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green">
                            <CheckIcon className="size-3" />
                            <span>{t('settings.mcp.market.installed')}</span>
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            data-testid={`mcp-market-install-${entry.id}`}
                            onClick={() => installFromMarket(entry)}
                          >
                            {entry.needsConfig ? (
                              <SlidersIcon className="size-3" />
                            ) : (
                              <DownloadIcon className="size-3" />
                            )}
                            <span>
                              {entry.needsConfig
                                ? t('settings.mcp.market.configure')
                                : t('settings.mcp.market.install')}
                            </span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* 新增 / 编辑 MCP 服务器弹窗 */}
      <McpFormDialog agents={agents} form={form} setForm={setForm} formError={formError} showJsonPaste={showJsonPaste} setShowJsonPaste={setShowJsonPaste} jsonText={jsonText} setJsonText={setJsonText} closeForm={closeForm} applyPastedJson={applyPastedJson} toggleFormAgent={toggleFormAgent} submitForm={submitForm} />

      {/* 从各 Agent 配置导入弹窗 */}
      <McpImportDialog agents={agents} mcp={mcp} importOpen={importOpen} setImportOpen={setImportOpen} selectedCandidateKeys={selectedCandidateKeys} setSelectedCandidateKeys={setSelectedCandidateKeys} importAgents={importAgents} toggleCandidate={toggleCandidate} toggleImportAgent={toggleImportAgent} candidates={candidates} selectedCandidates={selectedCandidates} submitImport={submitImport} />
    </div>
  );
}

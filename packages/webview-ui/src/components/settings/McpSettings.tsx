/**
 * 设置 -> 扩展 -> MCP 服务器：
 * 统一管理 Model Context Protocol 服务器（stdio / http / sse），
 * 选择启动时交给哪些 Agent，并支持从本机与工作区各 Agent 配置文件一键导入。
 */
import { useEffect, useState } from 'react';
import type { McpImportCandidate, McpServerConfig } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { setExtensionsLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { DownloadIcon, PlugIcon, PlusIcon } from '../icons.tsx';
import { FALLBACK_BACKENDS } from '@/lib/workbenchOptions';
import { Button } from '@/components/ui/button';
import { emptyMcpForm, formFromServer, parseKeyValueLines, parsePastedMcpSnippet, splitCommandArgs } from './mcp/mcpParsers.ts';
import type { McpFormState } from './mcp/mcpParsers.ts';
import { McpServerCard } from './mcp/McpServerCard.tsx';
import { McpImportDialog } from './mcp/McpImportDialog.tsx';
import { McpFormDialog } from './mcp/McpFormDialog.tsx';

export function McpSettings() {
  const t = useT();
  const extensions = useView((s) => s.extensions);
  const backendItems = useView((s) => s.backends.items);
  const agents = backendItems.length > 0 ? backendItems : FALLBACK_BACKENDS;
  const { mcp } = extensions;

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

  return (
    <div className="flex flex-col gap-3" data-testid="settings-mcp">
      <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
        <div className="primitive-card-bar flex flex-wrap items-start justify-between gap-2 border-b border-line bg-inset/50">
          <div className="flex min-w-0 items-start gap-2">
            <PlugIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
            <div className="min-w-0">
              <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.mcp.title')}</h3>
              <p className="mt-0.5 mb-0 text-[11.5px] leading-relaxed text-ink-3">{t('settings.mcp.desc')}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="mcp-import-btn"
              onClick={openImportDialog}
            >
              <DownloadIcon className="size-3" />
              <span>{t('settings.mcp.importBtn')}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="mcp-add-btn"
              onClick={openAdd}
            >
              <PlusIcon className="size-3" />
              <span>{t('settings.mcp.addBtn')}</span>
            </Button>
          </div>
        </div>

        <div className="primitive-card-pad flex flex-col gap-2.5">
          {/* 新增 / 编辑 MCP 服务器弹窗 */}
          <McpFormDialog agents={agents} form={form} setForm={setForm} formError={formError} showJsonPaste={showJsonPaste} setShowJsonPaste={setShowJsonPaste} jsonText={jsonText} setJsonText={setJsonText} closeForm={closeForm} applyPastedJson={applyPastedJson} toggleFormAgent={toggleFormAgent} submitForm={submitForm} />

          {/* 从各 Agent 配置导入弹窗 */}
          <McpImportDialog agents={agents} mcp={mcp} importOpen={importOpen} setImportOpen={setImportOpen} selectedCandidateKeys={selectedCandidateKeys} setSelectedCandidateKeys={setSelectedCandidateKeys} importAgents={importAgents} toggleCandidate={toggleCandidate} toggleImportAgent={toggleImportAgent} candidates={candidates} selectedCandidates={selectedCandidates} submitImport={submitImport} />

          {mcp.servers.length === 0 ? (
            <div
              className="rounded-control bg-field px-3 py-5 text-center text-[12px] text-ink-3 shadow-hairline"
              data-testid="mcp-empty"
            >
              {t('settings.mcp.empty')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {mcp.servers.map((server) => (
                <McpServerCard key={server.id} agents={agents} openEdit={openEdit} toggleServerEnabled={toggleServerEnabled} toggleServerAgent={toggleServerAgent} deleteServer={deleteServer} server={server} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

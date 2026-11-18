/**
 * 设置 -> 扩展 -> MCP 服务器：
 * 统一管理 Model Context Protocol 服务器（stdio / http / sse），
 * 选择启动时交给哪些 Agent，并支持从本机与工作区各 Agent 配置文件一键导入。
 */
import { useEffect, useState } from 'react';
import type { BackendView, McpImportCandidate, McpServerConfig, McpTransport } from '@harness-deck/shared';
import { useT } from '../../i18n.ts';
import { setExtensionsLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  CheckIcon,
  DownloadIcon,
  FolderIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const FALLBACK_BACKENDS: readonly Pick<BackendView, 'id' | 'name'>[] = [
  { id: 'dsh', name: 'DeepSeek' },
  { id: 'zcode', name: 'ZCode' },
  { id: 'pi', name: 'Pi' },
  { id: 'codebuddy', name: 'CodeBuddy' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
];

interface McpFormState {
  readonly id?: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly url: string;
  readonly headersText: string;
  readonly enabled: boolean;
  readonly agents: readonly string[];
  readonly importedFrom?: string;
}

function splitCommandArgs(raw: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/gu;
  for (const match of raw.matchAll(regex)) {
    const quotedDouble = match[1];
    const quotedSingle = match[2];
    const plain = match[3];
    if (quotedDouble !== undefined) tokens.push(quotedDouble.replace(/\\"/gu, '"'));
    else if (quotedSingle !== undefined) tokens.push(quotedSingle.replace(/\\'/gu, "'"));
    else if (plain !== undefined) tokens.push(plain);
  }
  return tokens;
}

function formatArgs(args: readonly string[] | undefined): string {
  if (!args || args.length === 0) return '';
  return args.map((arg) => (/\s/u.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function parseKeyValueLines(raw: string, allowColon = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let sepIdx = trimmed.indexOf('=');
    if (allowColon) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0 && (sepIdx < 0 || colonIdx < sepIdx)) {
        sepIdx = colonIdx;
      }
    }
    if (sepIdx <= 0) continue;
    const key = trimmed.slice(0, sepIdx).trim();
    const val = trimmed.slice(sepIdx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function formatKeyValueLines(map: Readonly<Record<string, string>> | undefined, sep = '='): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}

function emptyMcpForm(defaultAgents: readonly string[]): McpFormState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
    enabled: true,
    agents: defaultAgents,
  };
}

function formFromServer(server: McpServerConfig): McpFormState {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: formatArgs(server.args),
    envText: formatKeyValueLines(server.env, '='),
    url: server.url ?? '',
    headersText: formatKeyValueLines(server.headers, ': '),
    enabled: server.enabled,
    agents: server.agents,
    importedFrom: server.importedFrom,
  };
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/** 解析用户粘贴的单条或包含 mcpServers 的 JSON 配置片段。 */
function parsePastedMcpSnippet(
  raw: string,
  currentForm: McpFormState,
): Partial<McpFormState> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // 兼容仅粘贴 `"github": { "command": ... }` 的外层缺括号片段
    try {
      parsed = JSON.parse(`{${raw.trim().replace(/,\s*$/u, '')}}`);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) return undefined;

  let inferredName = currentForm.name;
  let spec: Record<string, unknown> = parsed;

  if (isRecord(parsed.mcpServers)) {
    const first = Object.entries(parsed.mcpServers)[0];
    if (!first || !isRecord(first[1])) return undefined;
    inferredName = first[0];
    spec = first[1];
  } else if (!('command' in parsed) && !('url' in parsed) && !('serverUrl' in parsed)) {
    const entries = Object.entries(parsed);
    if (entries.length === 1 && isRecord(entries[0]![1])) {
      inferredName = entries[0]![0];
      spec = entries[0]![1];
    }
  }

  const rawType = typeof spec.type === 'string' ? spec.type.toLowerCase() : '';
  const url =
    typeof spec.url === 'string'
      ? spec.url.trim()
      : typeof spec.serverUrl === 'string'
        ? spec.serverUrl.trim()
        : '';
  const command = typeof spec.command === 'string' ? spec.command.trim() : '';

  if (url) {
    const transport: McpTransport = rawType === 'sse' ? 'sse' : 'http';
    const headers: Record<string, string> = {};
    if (isRecord(spec.headers)) {
      for (const [k, v] of Object.entries(spec.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return {
      ...(inferredName ? { name: inferredName } : {}),
      transport,
      url,
      headersText: formatKeyValueLines(headers, ': '),
    };
  }

  if (command || Array.isArray(spec.command)) {
    const cmdParts = Array.isArray(spec.command)
      ? spec.command.filter((x): x is string => typeof x === 'string')
      : [command];
    const extraArgs = Array.isArray(spec.args) ? spec.args.filter((x): x is string => typeof x === 'string') : [];
    const primaryCmd = cmdParts[0] ?? '';
    const mergedArgs = [...cmdParts.slice(1), ...extraArgs];
    const env: Record<string, string> = {};
    const envObj = isRecord(spec.env) ? spec.env : isRecord(spec.environment) ? spec.environment : undefined;
    if (envObj) {
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          env[k] = String(v);
        }
      }
    }
    return {
      ...(inferredName ? { name: inferredName } : {}),
      transport: 'stdio',
      command: primaryCmd,
      argsText: formatArgs(mergedArgs),
      envText: formatKeyValueLines(env, '='),
    };
  }

  return undefined;
}

function serverSummary(server: {
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}): string {
  if (server.transport === 'stdio') {
    return [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return server.url ?? '';
}

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
          <Dialog open={Boolean(form)} onOpenChange={(open) => !open && closeForm()}>
            {form ? (
              <DialogContent data-testid="mcp-form-dialog" aria-modal="true" className="sm:max-w-[560px]">
                <DialogHeader>
                  <DialogTitle className="flex items-center justify-between gap-2 pr-6 text-[14px]">
                    <span className="flex items-center gap-2">
                      <PlugIcon className="size-4 text-accent-ink" />
                      <span>
                        {form.id ? t('settings.mcp.form.editTitle', form.name) : t('settings.mcp.form.addTitle')}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="mcp-paste-json-toggle"
                      onClick={() => setShowJsonPaste((prev) => !prev)}
                    >
                      {t('settings.mcp.form.pasteJson')}
                    </Button>
                  </DialogTitle>
                  <DialogDescription className="sr-only">{t('settings.mcp.desc')}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                  {showJsonPaste ? (
                    <div className="flex flex-col gap-2 rounded-control border border-line bg-field p-2.5">
                      <Textarea
                        rows={3}
                        data-testid="mcp-paste-json-input"
                        className="font-mono text-[11.5px]"
                        value={jsonText}
                        placeholder={t('settings.mcp.form.pasteJsonPlaceholder')}
                        onChange={(e) => setJsonText(e.target.value)}
                      />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          data-testid="mcp-paste-json-apply"
                          onClick={applyPastedJson}
                        >
                          {t('settings.mcp.form.applyJson')}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.name')}</span>
                      <Input
                        data-testid="mcp-form-name"
                        className="font-mono text-[12px]"
                        value={form.name}
                        placeholder={t('settings.mcp.form.namePlaceholder')}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.transport')}</span>
                      <NativeSelect
                        size="sm"
                        data-testid="mcp-form-transport"
                        className="w-full text-[12px]"
                        value={form.transport}
                        onChange={(e) => setForm({ ...form, transport: e.target.value as McpTransport })}
                      >
                        <NativeSelectOption value="stdio">{t('settings.mcp.form.transportStdio')}</NativeSelectOption>
                        <NativeSelectOption value="http">{t('settings.mcp.form.transportHttp')}</NativeSelectOption>
                        <NativeSelectOption value="sse">{t('settings.mcp.form.transportSse')}</NativeSelectOption>
                      </NativeSelect>
                    </label>
                  </div>

                  {form.transport === 'stdio' ? (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.command')}</span>
                        <Input
                          data-testid="mcp-form-command"
                          className="font-mono text-[12px]"
                          value={form.command}
                          placeholder={t('settings.mcp.form.commandPlaceholder')}
                          onChange={(e) => setForm({ ...form, command: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.args')}</span>
                        <Input
                          data-testid="mcp-form-args"
                          className="font-mono text-[12px]"
                          value={form.argsText}
                          placeholder={t('settings.mcp.form.argsPlaceholder')}
                          onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.env')}</span>
                        <Textarea
                          rows={3}
                          data-testid="mcp-form-env"
                          className="font-mono text-[11.5px]"
                          value={form.envText}
                          placeholder={t('settings.mcp.form.envPlaceholder')}
                          onChange={(e) => setForm({ ...form, envText: e.target.value })}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.url')}</span>
                        <Input
                          data-testid="mcp-form-url"
                          className="font-mono text-[12px]"
                          value={form.url}
                          placeholder={t('settings.mcp.form.urlPlaceholder')}
                          onChange={(e) => setForm({ ...form, url: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.headers')}</span>
                        <Textarea
                          rows={3}
                          data-testid="mcp-form-headers"
                          className="font-mono text-[11.5px]"
                          value={form.headersText}
                          placeholder={t('settings.mcp.form.headersPlaceholder')}
                          onChange={(e) => setForm({ ...form, headersText: e.target.value })}
                        />
                      </label>
                    </>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.form.agents')}</span>
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent px-1 text-accent-ink hover:underline"
                          onClick={() => setForm({ ...form, agents: agents.map((a) => a.id) })}
                        >
                          {t('settings.mcp.form.selectAllAgents')}
                        </button>
                        <span className="text-ink-4">·</span>
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent px-1 text-ink-3 hover:underline"
                          onClick={() => setForm({ ...form, agents: [] })}
                        >
                          {t('settings.mcp.form.clearAgents')}
                        </button>
                      </div>
                    </div>
                    <span className="text-[11px] text-ink-3">{t('settings.mcp.form.agentsHint')}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {agents.map((agent) => {
                        const selected = form.agents.includes(agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            data-testid={`mcp-form-agent-${agent.id}`}
                            onClick={() => toggleFormAgent(agent.id)}
                            className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2.5 py-1 text-[11.5px] transition-colors ${
                              selected
                                ? 'border-accent bg-accent-tint font-medium text-accent-ink'
                                : 'border-line bg-field text-ink-2 hover:bg-hover'
                            }`}
                          >
                            {selected ? <CheckIcon className="size-3" /> : null}
                            <span>{agent.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {formError ? (
                    <div className="text-[11.5px] text-red" role="alert" data-testid="mcp-form-error">
                      {formError}
                    </div>
                  ) : null}
                </div>

                <DialogFooter>
                  <Button type="button" variant="outline" size="sm" data-testid="mcp-form-cancel" onClick={closeForm}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="button" size="sm" data-testid="mcp-form-save" onClick={submitForm}>
                    {t('settings.mcp.form.save')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            ) : null}
          </Dialog>

          {/* 从各 Agent 配置导入弹窗 */}
          <Dialog open={importOpen} onOpenChange={(open) => !open && setImportOpen(false)}>
            {importOpen ? (
              <DialogContent data-testid="mcp-import-dialog" aria-modal="true" className="sm:max-w-[600px]">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-[14px]">
                    <DownloadIcon className="size-4 text-accent-ink" />
                    <span>{t('settings.mcp.import.title')}</span>
                  </DialogTitle>
                  <DialogDescription className="text-[12px] leading-relaxed text-ink-3">
                    {t('settings.mcp.import.desc')}
                  </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11.5px] text-ink-3">
                      {mcp.scanningImport
                        ? t('settings.mcp.import.scanning')
                        : candidates.length > 0
                          ? t('settings.mcp.import.foundCount', mcp.scannedSources?.length ?? 1, candidates.length)
                          : ''}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={Boolean(mcp.scanningImport)}
                        data-testid="mcp-import-rescan"
                        onClick={() => postToHost({ type: 'scanAgentMcpConfigs', payload: {} })}
                      >
                        {mcp.scanningImport ? <SpinnerIcon className="size-3" /> : <RefreshIcon className="size-3" />}
                        <span>{t('settings.mcp.import.rescan')}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        data-testid="mcp-import-pick-file"
                        onClick={() => postToHost({ type: 'pickMcpConfigFile', payload: {} })}
                      >
                        <FolderIcon className="size-3" />
                        <span>{t('settings.mcp.import.pickFile')}</span>
                      </Button>
                    </div>
                  </div>

                  {mcp.scanningImport ? (
                    <div className="flex items-center justify-center gap-2 rounded-control bg-field py-6 text-[12px] text-ink-3">
                      <SpinnerIcon className="size-4" />
                      <span>{t('settings.mcp.import.scanning')}</span>
                    </div>
                  ) : candidates.length === 0 ? (
                    <div
                      className="rounded-control bg-field px-3 py-5 text-center text-[12px] text-ink-3 shadow-hairline"
                      data-testid="mcp-import-empty"
                    >
                      {t('settings.mcp.import.empty')}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-end gap-1.5 text-[11px]">
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent px-1 text-accent-ink hover:underline"
                          onClick={() => setSelectedCandidateKeys(candidates.map((c) => c.key))}
                        >
                          {t('settings.skills.dialog.selectAll')}
                        </button>
                        <span className="text-ink-4">·</span>
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent px-1 text-ink-3 hover:underline"
                          onClick={() => setSelectedCandidateKeys([])}
                        >
                          {t('settings.skills.dialog.selectNone')}
                        </button>
                      </div>

                      <div
                        className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-control border border-line bg-field p-2"
                        data-testid="mcp-import-candidates"
                      >
                        {candidates.map((item) => {
                          const checked = selectedCandidateKeys.includes(item.key);
                          return (
                            <label
                              key={item.key}
                              className="flex cursor-pointer items-start gap-2 rounded-control bg-surface px-2.5 py-2 shadow-hairline"
                              data-testid={`mcp-candidate-${item.name}`}
                            >
                              <input
                                type="checkbox"
                                data-testid={`mcp-candidate-check-${item.name}`}
                                className="mt-0.5 accent-[var(--accent)]"
                                checked={checked}
                                onChange={() => toggleCandidate(item.key)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono text-[12px] font-semibold text-ink">{item.name}</span>
                                  <ValuePill className="font-mono text-[10px] uppercase">{item.transport}</ValuePill>
                                  <ValuePill tone="accent" className="text-[10px]">
                                    {item.sourceAgentName}
                                  </ValuePill>
                                  {item.conflict ? (
                                    <ValuePill className="text-[10px] text-ink-3">
                                      {t('settings.mcp.import.existsBadge')}
                                    </ValuePill>
                                  ) : null}
                                </div>
                                <div className="mt-0.5 truncate font-mono text-[11px] text-ink-2">
                                  {serverSummary(item)}
                                </div>
                                <div className="truncate font-mono text-[10.5px] text-ink-4" title={item.sourcePath}>
                                  {item.sourcePath}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-ink-2">{t('settings.mcp.import.targetAgents')}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {agents.map((agent) => {
                        const selected = importAgents.includes(agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            data-testid={`mcp-import-agent-${agent.id}`}
                            onClick={() => toggleImportAgent(agent.id)}
                            className={`inline-flex cursor-pointer items-center gap-1 rounded-chip border px-2.5 py-1 text-[11.5px] transition-colors ${
                              selected
                                ? 'border-accent bg-accent-tint font-medium text-accent-ink'
                                : 'border-line bg-field text-ink-2 hover:bg-hover'
                            }`}
                          >
                            {selected ? <CheckIcon className="size-3" /> : null}
                            <span>{agent.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="mcp-import-cancel"
                    onClick={() => setImportOpen(false)}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={selectedCandidates.length === 0}
                    data-testid="mcp-import-submit"
                    onClick={submitImport}
                  >
                    {t('settings.mcp.import.submit', selectedCandidates.length)}
                  </Button>
                </DialogFooter>
              </DialogContent>
            ) : null}
          </Dialog>

          {mcp.servers.length === 0 ? (
            <div
              className="rounded-control bg-field px-3 py-5 text-center text-[12px] text-ink-3 shadow-hairline"
              data-testid="mcp-empty"
            >
              {t('settings.mcp.empty')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {mcp.servers.map((server) => {
                const envCount = server.env ? Object.keys(server.env).length : 0;
                const headerCount = server.headers ? Object.keys(server.headers).length : 0;
                return (
                  <div
                    key={server.id}
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
                          size="sm"
                          checked={server.enabled}
                          aria-label={server.name}
                          data-testid={`toggle-mcp-${server.id}`}
                          onCheckedChange={(checked) => toggleServerEnabled(server, checked)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('common.edit')}
                          data-testid={`edit-mcp-${server.id}`}
                          onClick={() => openEdit(server)}
                        >
                          <PencilIcon className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
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
                                ? 'border-accent bg-accent-tint font-medium text-accent-ink'
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
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

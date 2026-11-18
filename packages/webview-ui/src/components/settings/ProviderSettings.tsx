/**
 * 设置 -> Agent -> 服务商：
 * 接入第三方编程套餐（火山方舟、智谱 GLM、阿里云百炼、Kimi 编程套餐、MiniMax、CLIProxyAPI）或自定义模型网关，
 * 将 API Key 安全保存在本机 SecretStorage，并支持一键绑定到底层 CLI Agent 与工作台智能体预设。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDER_PRESETS, backendProtocolCapability, isProviderReadyForBackend, parseEffortsInput, type ProviderGatewayLogEntry, type ProviderModelItem, type ProviderPreset, type ProviderProtocol, type ProviderView } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { MessageKey } from '../../i18n.ts';
import { useT } from '../../i18n.ts';
import { setProtocolGatewayLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { ValuePill } from '../beautifului/index.ts';
import { KeyIcon, LogIcon, PlusIcon, ServerIcon } from '../icons.tsx';
import { editorFromPreset, editorFromProvider, emptyModelRow, nextRowKey, toEditableRow } from './providers/providerEditor.ts';
import type { EditableModelRow, ProviderEditorState } from './providers/providerEditor.ts';
import { GatewayLogsDialog } from './providers/GatewayLogsDialog.tsx';
import { SavedProviderCard } from './providers/SavedProviderCard.tsx';
import { ProviderEditorForm } from './providers/ProviderEditorForm.tsx';

let fetchSeq = 1;

const EMPTY_GATEWAY_LOGS: readonly ProviderGatewayLogEntry[] = [];

export function ProviderSettings() {
  const t = useT();
  const locale = useView((s) => s.locale);
  const providers = useView((s) => s.providers.items);
  const protocolGatewayEnabled = useView((s) => s.providers.protocolGatewayEnabled === true);
  const protocolGatewayOrigin = useView((s) => s.providers.protocolGatewayOrigin);
  const gatewayLogs = useView((s) => s.providers.gatewayLogs ?? EMPTY_GATEWAY_LOGS);
  const backends = useView((s) => s.backends.items);
  const workbenchAgents = useView((s) => s.workbench.agents);
  const fetchResult = useView((s) => s.providerFetchResult);

  const customPreset = PROVIDER_PRESETS.find((p) => p.id === 'custom') ?? PROVIDER_PRESETS[0]!;

  const [editor, setEditor] = useState<ProviderEditorState | undefined>(() =>
    providers.length === 0 ? editorFromPreset(customPreset, locale) : undefined,
  );
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [logsOpen, setLogsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingFetchId, setPendingFetchId] = useState<number | undefined>();
  const [fetchError, setFetchError] = useState<string | undefined>();
  const handledFetchRef = useRef<number>(-1);

  useEffect(() => {
    if (!fetchResult || fetchResult.requestId !== pendingFetchId) return;
    if (handledFetchRef.current === fetchResult.requestId) return;
    handledFetchRef.current = fetchResult.requestId;
    setPendingFetchId(undefined);

    if (fetchResult.error) {
      setFetchError(fetchResult.error);
      return;
    }
    setFetchError(undefined);
    setEditor((curr) => {
      if (!curr) return curr;
      const existingNonEmpty = curr.models.filter((m) => m.id.trim().length > 0);
      const byId = new Map(existingNonEmpty.map((m) => [m.id, m]));
      const merged = [...existingNonEmpty];
      for (const remote of fetchResult.models) {
        if (!byId.has(remote.id)) {
          const row = toEditableRow(remote);
          byId.set(remote.id, row);
          merged.push(row);
        }
      }
      const nextRows = merged.length > 0 ? merged : [emptyModelRow()];
      const firstId = nextRows.find((r) => r.id.trim())?.id.trim() ?? '';
      return {
        ...curr,
        models: nextRows,
        defaultModel: curr.defaultModel || firstId,
        smallModel: curr.smallModel || firstId,
      };
    });
  }, [fetchResult, pendingFetchId]);

  const boundOwnerByBackend = useMemo(() => {
    const map = new Map<string, ProviderView>();
    for (const p of providers) {
      for (const bid of p.boundBackendIds) {
        map.set(bid, p);
      }
    }
    return map;
  }, [providers]);

  const boundOwnerByWbAgent = useMemo(() => {
    const map = new Map<string, ProviderView>();
    for (const p of providers) {
      for (const aid of p.boundAgentIds ?? []) {
        map.set(aid, p);
      }
    }
    return map;
  }, [providers]);

  const openAdd = (preset: ProviderPreset = customPreset) => {
    setFormError(undefined);
    setFetchError(undefined);
    setBatchOpen(false);
    setBatchText('');
    setDetailsOpen(true);
    setEditor(editorFromPreset(preset, locale));
  };

  const openEdit = (provider: ProviderView) => {
    setFormError(undefined);
    setFetchError(undefined);
    setBatchOpen(false);
    setBatchText('');
    setDetailsOpen(true);
    setEditor(editorFromProvider(provider));
  };

  const closeEditor = () => {
    setEditor(undefined);
    setFormError(undefined);
    setFetchError(undefined);
    setBatchOpen(false);
  };

  const selectPreset = (preset: ProviderPreset) => {
    setFormError(undefined);
    setFetchError(undefined);
    setDetailsOpen(true);
    setEditor((curr) => editorFromPreset(preset, locale, curr));
  };

  const updateModelRow = (rowKey: number, patch: Partial<EditableModelRow>) => {
    setEditor((curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        models: curr.models.map((row) => (row.rowKey === rowKey ? { ...row, ...patch } : row)),
      };
    });
  };

  const addModelRow = () => {
    setEditor((curr) => (curr ? { ...curr, models: [...curr.models, emptyModelRow()] } : curr));
  };

  const removeModelRow = (rowKey: number) => {
    setEditor((curr) => {
      if (!curr) return curr;
      const filtered = curr.models.filter((r) => r.rowKey !== rowKey);
      return { ...curr, models: filtered.length > 0 ? filtered : [emptyModelRow()] };
    });
  };

  const applyBatchPaste = () => {
    if (!editor) return;
    const ids = batchText
      .split(/[\r\n,，;；]+/u)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setBatchOpen(false);
      return;
    }
    const existing = editor.models.filter((r) => r.id.trim().length > 0);
    const seen = new Set(existing.map((r) => r.id.trim()));
    const nextRows = [...existing];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      nextRows.push({
        rowKey: nextRowKey(),
        id,
        name: id,
        contextWindow: '',
        maxOutputTokens: '',
        effortsText: '',
        vision: false,
      });
    }
    const firstId = nextRows[0]?.id ?? '';
    setEditor({
      ...editor,
      models: nextRows.length > 0 ? nextRows : [emptyModelRow()],
      defaultModel: editor.defaultModel || firstId,
      smallModel: editor.smallModel || firstId,
    });
    setBatchText('');
    setBatchOpen(false);
  };

  const triggerFetchModels = () => {
    if (!editor) return;
    const reqId = fetchSeq++;
    setPendingFetchId(reqId);
    setFetchError(undefined);
    postToHost({
      type: 'fetchProviderModels',
      payload: {
        requestId: reqId,
        ...(editor.editingId ? { providerId: editor.editingId } : {}),
        ...(editor.apiKey.trim() ? { apiKey: editor.apiKey.trim() } : {}),
        ...(editor.anthropicUrl.trim() ? { anthropicUrl: editor.anthropicUrl.trim() } : {}),
        ...(editor.openaiChatUrl.trim() ? { openaiChatUrl: editor.openaiChatUrl.trim() } : {}),
        ...(editor.openaiResponsesUrl.trim() ? { openaiResponsesUrl: editor.openaiResponsesUrl.trim() } : {}),
      },
    });
  };

  const toggleBackendBind = (backendId: string, checked: boolean) => {
    setEditor((curr) => {
      if (!curr) return curr;
      const set = new Set(curr.boundBackendIds);
      if (checked) set.add(backendId);
      else set.delete(backendId);
      return { ...curr, boundBackendIds: [...set] };
    });
  };

  const toggleWbAgentBind = (agentId: string, checked: boolean) => {
    setEditor((curr) => {
      if (!curr) return curr;
      const set = new Set(curr.boundAgentIds);
      if (checked) set.add(agentId);
      else set.delete(agentId);
      return { ...curr, boundAgentIds: [...set] };
    });
  };

  const saveProvider = () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      setFormError(t('settings.providers.validationName'));
      return;
    }

    const seenModels = new Set<string>();
    const cleanModels: ProviderModelItem[] = [];
    for (const row of editor.models) {
      const id = row.id.trim();
      if (!id || seenModels.has(id)) continue;
      seenModels.add(id);
      const efforts = parseEffortsInput(row.effortsText);
      cleanModels.push({
        id,
        ...(row.name.trim() ? { name: row.name.trim() } : {}),
        ...(row.contextWindow.trim() ? { contextWindow: row.contextWindow.trim() } : {}),
        ...(row.maxOutputTokens.trim() ? { maxOutputTokens: row.maxOutputTokens.trim() } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(row.vision ? { vision: true } : {}),
      });
    }

    const urls = {
      anthropicUrl: editor.anthropicUrl.trim(),
      openaiChatUrl: editor.openaiChatUrl.trim(),
      openaiResponsesUrl: editor.openaiResponsesUrl.trim(),
      convertOpenaiToAnthropic: editor.convertOpenaiToAnthropic,
    };

    const hasOpenAiUrl = Boolean(urls.openaiChatUrl || urls.openaiResponsesUrl);
    const effectiveGatewayEnabled = protocolGatewayEnabled || (editor.convertOpenaiToAnthropic && hasOpenAiUrl);
    const validBoundBackends = editor.boundBackendIds.filter((bid) => {
      const backend = backends.find((b) => b.id === bid);
      return backend ? isProviderReadyForBackend(urls, backend, { protocolGatewayEnabled: effectiveGatewayEnabled }) : true;
    });

    if (editor.convertOpenaiToAnthropic && hasOpenAiUrl && !protocolGatewayEnabled) {
      setProtocolGatewayLocal(true);
    }

    const apiKeyPayload = editor.clearApiKey
      ? ''
      : editor.apiKey.trim().length > 0
        ? editor.apiKey.trim()
        : undefined;

    const resolvedDefault =
      (editor.defaultModel.trim() && seenModels.has(editor.defaultModel.trim())
        ? editor.defaultModel.trim()
        : undefined) ?? cleanModels[0]?.id;
    const resolvedSmall =
      (editor.smallModel.trim() && seenModels.has(editor.smallModel.trim())
        ? editor.smallModel.trim()
        : undefined) ?? resolvedDefault;

    postToHost({
      type: 'upsertProvider',
      payload: {
        ...(editor.editingId ? { id: editor.editingId } : {}),
        name,
        presetId: editor.presetId,
        ...(apiKeyPayload !== undefined ? { apiKey: apiKeyPayload } : {}),
        anthropicUrl: urls.anthropicUrl,
        openaiChatUrl: urls.openaiChatUrl,
        openaiResponsesUrl: urls.openaiResponsesUrl,
        convertOpenaiToAnthropic: editor.convertOpenaiToAnthropic,
        models: cleanModels,
        ...(resolvedDefault ? { defaultModel: resolvedDefault } : {}),
        ...(resolvedSmall ? { smallModel: resolvedSmall } : {}),
        boundBackendIds: validBoundBackends,
        boundAgentIds: [...editor.boundAgentIds],
      },
    });

    setEditor(undefined);
    setFormError(undefined);
  };

  const deleteProvider = (id: string) => {
    postToHost({ type: 'deleteProvider', payload: { id } });
    if (editor?.editingId === id) {
      setEditor(undefined);
    }
  };

  const validModelOptions = useMemo(() => {
    if (!editor) return [];
    const seen = new Set<string>();
    const out: { id: string; label: string }[] = [];
    for (const row of editor.models) {
      const id = row.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: row.name.trim() ? `${row.name.trim()} (${id})` : id });
    }
    return out;
  }, [editor]);

  const compatibilitySummary = useMemo(() => {
    if (!editor) return { missingHints: [] as string[], accountOnlyNames: [] as string[] };
    const urls = {
      anthropicUrl: editor.anthropicUrl,
      openaiChatUrl: editor.openaiChatUrl,
      openaiResponsesUrl: editor.openaiResponsesUrl,
      convertOpenaiToAnthropic: editor.convertOpenaiToAnthropic,
    };
    const gatewayOpts = { protocolGatewayEnabled: protocolGatewayEnabled || editor.convertOpenaiToAnthropic };
    const missingHints: string[] = [];
    const accountOnlyNames: string[] = [];
    const protocolLabel = (p: ProviderProtocol) => t(`settings.providers.protocol.${p}` as MessageKey);

    for (const backend of backends) {
      const cap = backendProtocolCapability(backend);
      if (cap.kind === 'account-only') {
        accountOnlyNames.push(backend.name);
        continue;
      }
      if (!isProviderReadyForBackend(urls, backend, gatewayOpts)) {
        const joined = cap.protocols.map(protocolLabel).join(t('settings.providers.protocolOr'));
        missingHints.push(`${backend.name}（${joined}）`);
      }
    }
    return { missingHints, accountOnlyNames };
  }, [editor, backends, protocolGatewayEnabled, t]);

  const toggleProtocolGateway = (checked: boolean) => {
    setProtocolGatewayLocal(checked);
    postToHost({ type: 'setProtocolGateway', payload: { enabled: checked } });
  };

  const hasAnyUrl = Boolean(
    editor && (editor.anthropicUrl.trim() || editor.openaiChatUrl.trim() || editor.openaiResponsesUrl.trim()),
  );

  return (
    <div className="flex flex-col gap-3" data-testid="settings-providers">
      {/* 本地协议转换网关（OpenAI 兼容 -> Claude Anthropic，默认关闭） */}
      <section
        className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
        data-testid="provider-protocol-gateway-card"
      >
        <div className="primitive-card-pad flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <ServerIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.providers.gatewayTitle')}</h3>
                {protocolGatewayEnabled ? (
                  <ValuePill tone="green" className="font-mono text-[10.5px]">
                    {protocolGatewayOrigin
                      ? t('settings.providers.gatewayRunningBadge', protocolGatewayOrigin)
                      : t('settings.providers.gatewayEnabledBadge')}
                  </ValuePill>
                ) : (
                  <ValuePill className="text-[10.5px]">{t('settings.providers.gatewayOffBadge')}</ValuePill>
                )}
              </div>
              <p className="mt-1 mb-0 text-[11.5px] leading-relaxed text-ink-3">
                {t('settings.providers.gatewayDesc')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="provider-gateway-logs-btn"
              onClick={() => setLogsOpen(true)}
            >
              <LogIcon className="size-3" />
              <span>{t('settings.providers.gatewayLogsBtn')}</span>
              {gatewayLogs.length > 0 ? (
                <ValuePill
                  tone={gatewayLogs.some((l) => l.level === 'error') ? 'red' : 'neutral'}
                  className="px-1.5 py-0 text-[10px]"
                >
                  {gatewayLogs.length}
                </ValuePill>
              ) : null}
            </Button>
            <Switch
              data-testid="provider-protocol-gateway-switch"
              aria-label={t('settings.providers.gatewayTitle')}
              checked={protocolGatewayEnabled}
              onCheckedChange={toggleProtocolGateway}
            />
          </div>
        </div>
      </section>

      {/* 已保存的服务商列表 */}
      <section className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
        <div className="primitive-card-bar flex flex-wrap items-start justify-between gap-2 border-b border-line bg-inset/50">
          <div className="flex min-w-0 items-start gap-2">
            <KeyIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
            <div className="min-w-0">
              <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.providers.title')}</h3>
              <p className="mt-0.5 mb-0 text-[11.5px] leading-relaxed text-ink-3">{t('settings.providers.desc')}</p>
            </div>
          </div>
          <Button type="button" variant="outline" size="xs" data-testid="provider-add-btn" onClick={() => openAdd()}>
            <PlusIcon className="size-3" />
            <span>{t('settings.providers.add')}</span>
          </Button>
        </div>

        <div className="primitive-card-pad flex flex-col gap-2">
          {providers.length === 0 ? (
            <div
              className="rounded-control bg-field px-3 py-4 text-center text-[12px] text-ink-3 shadow-hairline"
              data-testid="providers-empty"
            >
              {t('settings.providers.empty')}
            </div>
          ) : (
            providers.map((item) => (
              <SavedProviderCard
                key={item.id}
                provider={item}
                backends={backends}
                workbenchAgents={workbenchAgents}
                protocolGatewayEnabled={protocolGatewayEnabled}
                editing={editor?.editingId === item.id}
                onEdit={() => openEdit(item)}
                onDelete={() => deleteProvider(item.id)}
              />
            ))
          )}
        </div>
      </section>

      {/* 服务商新增 / 编辑表单 */}
      {editor ? (
        <ProviderEditorForm locale={locale} providers={providers} protocolGatewayEnabled={protocolGatewayEnabled} backends={backends} workbenchAgents={workbenchAgents} editor={editor} setEditor={setEditor} detailsOpen={detailsOpen} setDetailsOpen={setDetailsOpen} batchOpen={batchOpen} setBatchOpen={setBatchOpen} batchText={batchText} setBatchText={setBatchText} formError={formError} pendingFetchId={pendingFetchId} fetchError={fetchError} boundOwnerByBackend={boundOwnerByBackend} boundOwnerByWbAgent={boundOwnerByWbAgent} closeEditor={closeEditor} selectPreset={selectPreset} updateModelRow={updateModelRow} addModelRow={addModelRow} removeModelRow={removeModelRow} applyBatchPaste={applyBatchPaste} triggerFetchModels={triggerFetchModels} toggleBackendBind={toggleBackendBind} toggleWbAgentBind={toggleWbAgentBind} saveProvider={saveProvider} validModelOptions={validModelOptions} compatibilitySummary={compatibilitySummary} hasAnyUrl={hasAnyUrl} />
      ) : null}

      <GatewayLogsDialog open={logsOpen} logs={gatewayLogs} onOpenChange={setLogsOpen} />
    </div>
  );
}

/**
 * 设置 -> Agent -> 服务商：
 * 接入第三方编程套餐（火山方舟、智谱 GLM、阿里云百炼、Kimi 编程套餐、MiniMax、CLIProxyAPI）或自定义模型网关，
 * 将 API Key 安全保存在本机 SecretStorage，并支持一键绑定到底层 CLI Agent 与工作台智能体预设。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PROVIDER_PRESETS,
  backendProtocolCapability,
  isProviderReadyForBackend,
  parseEffortsInput,
  type BackendView,
  type ProviderModelItem,
  type ProviderPreset,
  type ProviderProtocol,
  type ProviderView,
} from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { MessageKey } from '../../i18n.ts';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setProtocolGatewayLocal, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { ValuePill } from '../beautifului/index.ts';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  KeyIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  ServerIcon,
  SpinnerIcon,
  TrashIcon,
} from '../icons.tsx';

interface EditableModelRow {
  readonly rowKey: number;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: string;
  readonly maxOutputTokens: string;
  readonly effortsText: string;
  readonly vision: boolean;
}

interface ProviderEditorState {
  readonly editingId?: string;
  readonly presetId: string;
  readonly name: string;
  readonly apiKey: string;
  readonly hasSavedApiKey: boolean;
  readonly clearApiKey: boolean;
  readonly anthropicUrl: string;
  readonly openaiChatUrl: string;
  readonly openaiResponsesUrl: string;
  readonly convertOpenaiToAnthropic: boolean;
  readonly models: readonly EditableModelRow[];
  readonly defaultModel: string;
  readonly smallModel: string;
  readonly boundBackendIds: readonly string[];
  readonly boundAgentIds: readonly string[];
}

let rowSeq = 1;

function nextRowKey(): number {
  return rowSeq++;
}

function emptyModelRow(): EditableModelRow {
  return {
    rowKey: nextRowKey(),
    id: '',
    name: '',
    contextWindow: '',
    maxOutputTokens: '',
    effortsText: '',
    vision: false,
  };
}

function toEditableRow(item: ProviderModelItem): EditableModelRow {
  return {
    rowKey: nextRowKey(),
    id: item.id,
    name: item.name ?? '',
    contextWindow: item.contextWindow ?? '',
    maxOutputTokens: item.maxOutputTokens ?? '',
    effortsText: (item.efforts ?? []).join(', '),
    vision: item.vision === true,
  };
}

function editorFromPreset(preset: ProviderPreset, locale: 'zh' | 'en', prev?: ProviderEditorState): ProviderEditorState {
  const rows = preset.models.length > 0 ? preset.models.map(toEditableRow) : [emptyModelRow()];
  const presetName = preset.id === 'custom' ? '' : locale === 'zh' ? preset.nameZh : preset.nameEn;
  return {
    editingId: prev?.editingId,
    presetId: preset.id,
    name: presetName,
    apiKey: prev?.apiKey ?? '',
    hasSavedApiKey: prev?.hasSavedApiKey ?? false,
    clearApiKey: prev?.clearApiKey ?? false,
    anthropicUrl: preset.anthropicUrl ?? '',
    openaiChatUrl: preset.openaiChatUrl ?? '',
    openaiResponsesUrl: preset.openaiResponsesUrl ?? '',
    convertOpenaiToAnthropic: prev?.convertOpenaiToAnthropic ?? false,
    models: rows,
    defaultModel: preset.defaultModel ?? preset.models[0]?.id ?? '',
    smallModel: preset.smallModel ?? preset.defaultModel ?? preset.models[0]?.id ?? '',
    boundBackendIds: prev?.boundBackendIds ?? [],
    boundAgentIds: prev?.boundAgentIds ?? [],
  };
}

function editorFromProvider(provider: ProviderView): ProviderEditorState {
  const rows = provider.models.length > 0 ? provider.models.map(toEditableRow) : [emptyModelRow()];
  return {
    editingId: provider.id,
    presetId: provider.presetId ?? 'custom',
    name: provider.name,
    apiKey: '',
    hasSavedApiKey: provider.hasApiKey,
    clearApiKey: false,
    anthropicUrl: provider.anthropicUrl ?? '',
    openaiChatUrl: provider.openaiChatUrl ?? '',
    openaiResponsesUrl: provider.openaiResponsesUrl ?? '',
    convertOpenaiToAnthropic: provider.convertOpenaiToAnthropic === true,
    models: rows,
    defaultModel: provider.defaultModel ?? '',
    smallModel: provider.smallModel ?? '',
    boundBackendIds: [...provider.boundBackendIds],
    boundAgentIds: [...(provider.boundAgentIds ?? [])],
  };
}

let fetchSeq = 1;

export function ProviderSettings() {
  const t = useT();
  const locale = useView((s) => s.locale);
  const providers = useView((s) => s.providers.items);
  const protocolGatewayEnabled = useView((s) => s.providers.protocolGatewayEnabled === true);
  const protocolGatewayOrigin = useView((s) => s.providers.protocolGatewayOrigin);
  const backends = useView((s) => s.backends.items);
  const workbenchAgents = useView((s) => s.workbench.agents);
  const fetchResult = useView((s) => s.providerFetchResult);

  const customPreset = PROVIDER_PRESETS.find((p) => p.id === 'custom') ?? PROVIDER_PRESETS[0]!;

  const [editor, setEditor] = useState<ProviderEditorState | undefined>(() =>
    providers.length === 0 ? editorFromPreset(customPreset, locale) : undefined,
  );
  const [detailsOpen, setDetailsOpen] = useState(true);
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

    const effectiveGatewayEnabled = protocolGatewayEnabled || (editor.convertOpenaiToAnthropic && Boolean(urls.openaiChatUrl));
    const validBoundBackends = editor.boundBackendIds.filter((bid) => {
      const backend = backends.find((b) => b.id === bid);
      return backend ? isProviderReadyForBackend(urls, backend, { protocolGatewayEnabled: effectiveGatewayEnabled }) : true;
    });

    if (editor.convertOpenaiToAnthropic && urls.openaiChatUrl && !protocolGatewayEnabled) {
      setProtocolGatewayLocal(true);
      postToHost({ type: 'setProtocolGateway', payload: { enabled: true } });
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
          <Switch
            data-testid="provider-protocol-gateway-switch"
            aria-label={t('settings.providers.gatewayTitle')}
            checked={protocolGatewayEnabled}
            onCheckedChange={toggleProtocolGateway}
          />
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
        <section
          className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
          data-testid="provider-editor"
        >
          <div className="primitive-card-bar flex items-center justify-between gap-2 border-b border-line bg-inset/50">
            <h3 className="m-0 text-[13px] font-semibold text-ink">
              {editor.editingId
                ? t('settings.providers.editTitle', editor.name || editor.editingId)
                : t('settings.providers.addTitle')}
            </h3>
            {providers.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('common.close')}
                data-testid="provider-editor-close"
                onClick={closeEditor}
              >
                <CloseIcon className="size-3.5 text-ink-3" />
              </Button>
            ) : null}
          </div>

          <div className="primitive-card-pad flex flex-col gap-3.5">
            {/* 预设卡片网格 */}
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="provider-presets">
                {PROVIDER_PRESETS.map((preset) => {
                  const selected = editor.presetId === preset.id;
                  const title = locale === 'zh' ? preset.nameZh : preset.nameEn;
                  const desc = locale === 'zh' ? preset.descZh : preset.descEn;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`provider-preset-${preset.id}`}
                      onClick={() => selectPreset(preset)}
                      className={cn(
                        'flex flex-col items-start gap-1 rounded-card border px-3 py-2.5 text-left transition-colors duration-150',
                        selected
                          ? 'border-primary bg-surface ring-1 ring-primary'
                          : 'border-line bg-field/60 hover:bg-hover',
                      )}
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-surface text-[11px] font-semibold text-ink-2 shadow-hairline">
                          {preset.badge}
                        </span>
                        <span className="truncate text-[12.5px] font-semibold text-ink">{title}</span>
                        {!preset.verified ? (
                          <span className="ml-auto shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-ink-3 shadow-hairline">
                            {t('settings.providers.presetUnverifiedBadge')}
                          </span>
                        ) : null}
                      </div>
                      <span className="line-clamp-1 text-[11.5px] text-ink-3">{desc}</span>
                    </button>
                  );
                })}
              </div>
              <p className="m-0 text-[11.5px] text-ink-3">{t('settings.providers.presetUnverifiedNote')}</p>
            </div>

            {/* 名称 */}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ink-2">{t('settings.providers.name')}</span>
              <Input
                data-testid="provider-form-name"
                value={editor.name}
                placeholder={t('settings.providers.namePlaceholder')}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>

            {/* API Key */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink-2">{t('settings.providers.apiKey')}</span>
                {editor.hasSavedApiKey ? (
                  editor.clearApiKey ? (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[11.5px]"
                      data-testid="provider-restore-apikey"
                      onClick={() => setEditor({ ...editor, clearApiKey: false })}
                    >
                      {t('settings.providers.apiKeyRestore')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto p-0 text-[11.5px] text-destructive"
                      data-testid="provider-clear-apikey"
                      onClick={() => setEditor({ ...editor, clearApiKey: true, apiKey: '' })}
                    >
                      {t('settings.providers.apiKeyClear')}
                    </Button>
                  )
                ) : null}
              </div>
              <Input
                type="password"
                autoComplete="off"
                data-testid="provider-form-apikey"
                value={editor.apiKey}
                placeholder={
                  editor.clearApiKey
                    ? t('settings.providers.apiKeyWillClear')
                    : editor.hasSavedApiKey
                      ? t('settings.providers.apiKeySavedPlaceholder')
                      : t('settings.providers.apiKeyPlaceholder')
                }
                onChange={(e) => setEditor({ ...editor, apiKey: e.target.value, clearApiKey: false })}
              />
              <p className="m-0 text-[11.5px] text-ink-3">{t('settings.providers.apiKeyHint')}</p>
            </div>

            {/* 折叠区：配置模型与连接地址 */}
            <div className="border-t border-line pt-3">
              <button
                type="button"
                data-testid="provider-config-toggle"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((v) => !v)}
                className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink hover:text-accent-ink"
              >
                {detailsOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                <span>{t('settings.providers.sectionToggle')}</span>
              </button>

              {detailsOpen ? (
                <div className="mt-3 flex flex-col gap-3.5" data-testid="provider-config-section">
                  {/* 协议地址 */}
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11.5px] font-medium text-ink-2">{t('settings.providers.urlAnthropic')}</span>
                      <Input
                        data-testid="provider-url-anthropic"
                        className="h-8 font-mono text-[12px]"
                        placeholder="https://api.anthropic.com"
                        value={editor.anthropicUrl}
                        onChange={(e) => setEditor({ ...editor, anthropicUrl: e.target.value })}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11.5px] font-medium text-ink-2">{t('settings.providers.urlOpenaiChat')}</span>
                      <Input
                        data-testid="provider-url-openai-chat"
                        className="h-8 font-mono text-[12px]"
                        placeholder="https://api.openai.com/v1"
                        value={editor.openaiChatUrl}
                        onChange={(e) => setEditor({ ...editor, openaiChatUrl: e.target.value })}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11.5px] font-medium text-ink-2">
                        {t('settings.providers.urlOpenaiResponses')}
                      </span>
                      <Input
                        data-testid="provider-url-openai-responses"
                        className="h-8 font-mono text-[12px]"
                        placeholder="https://api.openai.com/v1"
                        value={editor.openaiResponsesUrl}
                        onChange={(e) => setEditor({ ...editor, openaiResponsesUrl: e.target.value })}
                      />
                    </label>
                  </div>

                  {editor.openaiChatUrl.trim() ? (
                    <div className="flex flex-col gap-1 rounded-control bg-field/60 px-2.5 py-2">
                      <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] font-medium text-ink">
                        <Checkbox
                          data-testid="provider-convert-openai"
                          checked={editor.convertOpenaiToAnthropic}
                          onCheckedChange={(val) => setEditor({ ...editor, convertOpenaiToAnthropic: val === true })}
                        />
                        <span>{t('settings.providers.convertOpenaiLabel')}</span>
                      </label>
                      <p className="m-0 pl-6 text-[11px] leading-relaxed text-ink-3">
                        {t('settings.providers.convertOpenaiHint')}
                      </p>
                    </div>
                  ) : null}

                  {/* 模型表格 */}
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-ink">{t('settings.providers.modelsTitle')}</span>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-[12px]"
                        disabled={!hasAnyUrl || pendingFetchId !== undefined}
                        data-testid="provider-fetch-models"
                        onClick={triggerFetchModels}
                      >
                        {pendingFetchId !== undefined ? (
                          <>
                            <SpinnerIcon className="size-3" />
                            <span>{t('settings.providers.fetchingModels')}</span>
                          </>
                        ) : (
                          <>
                            <RefreshIcon className="size-3" />
                            <span>{t('settings.providers.fetchModels')}</span>
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="m-0 text-[11.5px] text-ink-3">{t('settings.providers.modelsPreHint')}</p>

                    {fetchError ? (
                      <div className="text-[11.5px] text-destructive" role="alert" data-testid="provider-fetch-error">
                        {fetchError}
                      </div>
                    ) : null}

                    {/* 表头（桌面宽屏展示） */}
                    <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1fr)_4rem_1.75rem] items-center gap-1.5 text-[11.5px] text-ink-3 sm:grid">
                      <span>{t('settings.providers.colModelId')}</span>
                      <span>{t('settings.providers.colDisplayName')}</span>
                      <span>{t('settings.providers.colContext')}</span>
                      <span>{t('settings.providers.colMaxOutput')}</span>
                      <span>{t('settings.providers.colEfforts')}</span>
                      <span className="text-center">{t('settings.providers.colVision')}</span>
                      <span />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      {editor.models.map((row, index) => (
                        <div
                          key={row.rowKey}
                          data-testid={`provider-model-row-${index}`}
                          className="grid grid-cols-1 items-center gap-1.5 rounded-control bg-field/40 p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_5.5rem_minmax(0,1fr)_4rem_1.75rem] sm:bg-transparent sm:p-0"
                        >
                          <Input
                            data-testid={`provider-model-id-${index}`}
                            aria-label={t('settings.providers.colModelId')}
                            className="h-8 font-mono text-[12px]"
                            placeholder="model-id"
                            value={row.id}
                            onChange={(e) => updateModelRow(row.rowKey, { id: e.target.value })}
                          />
                          <Input
                            data-testid={`provider-model-name-${index}`}
                            aria-label={t('settings.providers.colDisplayName')}
                            className="h-8 text-[12px]"
                            placeholder={t('settings.providers.colDisplayName')}
                            value={row.name}
                            onChange={(e) => updateModelRow(row.rowKey, { name: e.target.value })}
                          />
                          <Input
                            data-testid={`provider-model-ctx-${index}`}
                            aria-label={t('settings.providers.colContext')}
                            className="h-8 font-mono text-[12px]"
                            placeholder={t('settings.providers.unknownPlaceholder')}
                            value={row.contextWindow}
                            onChange={(e) => updateModelRow(row.rowKey, { contextWindow: e.target.value })}
                          />
                          <Input
                            data-testid={`provider-model-maxout-${index}`}
                            aria-label={t('settings.providers.colMaxOutput')}
                            className="h-8 font-mono text-[12px]"
                            placeholder={t('settings.providers.unknownPlaceholder')}
                            value={row.maxOutputTokens}
                            onChange={(e) => updateModelRow(row.rowKey, { maxOutputTokens: e.target.value })}
                          />
                          <Input
                            data-testid={`provider-model-efforts-${index}`}
                            aria-label={t('settings.providers.colEfforts')}
                            className="h-8 font-mono text-[12px]"
                            placeholder="low, high"
                            value={row.effortsText}
                            onChange={(e) => updateModelRow(row.rowKey, { effortsText: e.target.value })}
                          />
                          <div className="flex items-center justify-between sm:justify-center">
                            <span className="text-[11.5px] text-ink-3 sm:hidden">
                              {t('settings.providers.colVision')}
                            </span>
                            <Checkbox
                              data-testid={`provider-model-vision-${index}`}
                              aria-label={t('settings.providers.colVision')}
                              checked={row.vision}
                              onCheckedChange={(checked) => updateModelRow(row.rowKey, { vision: checked === true })}
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t('settings.providers.removeModel')}
                            data-testid={`provider-model-remove-${index}`}
                            onClick={() => removeModelRow(row.rowKey)}
                          >
                            <CloseIcon className="size-3 text-ink-3" />
                          </Button>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        data-testid="provider-add-model"
                        onClick={addModelRow}
                      >
                        {t('settings.providers.addModel')}
                      </Button>
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-[12px]"
                        data-testid="provider-batch-toggle"
                        onClick={() => setBatchOpen((v) => !v)}
                      >
                        {t('settings.providers.batchPaste')}
                      </Button>
                    </div>

                    {batchOpen ? (
                      <div
                        className="flex flex-col gap-2 rounded-card border border-line bg-field/60 p-2.5"
                        data-testid="provider-batch-box"
                      >
                        <Textarea
                          rows={3}
                          className="font-mono text-[12px]"
                          data-testid="provider-batch-input"
                          value={batchText}
                          placeholder={t('settings.providers.batchPastePlaceholder')}
                          onChange={(e) => setBatchText(e.target.value)}
                        />
                        <div className="flex justify-end gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                              setBatchOpen(false);
                              setBatchText('');
                            }}
                          >
                            {t('common.cancel')}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            data-testid="provider-batch-confirm"
                            onClick={applyBatchPaste}
                          >
                            {t('settings.providers.batchPasteConfirm')}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    <p className="m-0 text-[11.5px] leading-relaxed text-ink-3">
                      {t('settings.providers.modelsHelp')}
                    </p>
                  </div>

                  {/* 默认模型 & 小模型 */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink-2">
                        {t('settings.providers.defaultModel')}
                      </span>
                      <NativeSelect
                        size="sm"
                        className="w-full"
                        data-testid="provider-default-model"
                        value={editor.defaultModel}
                        onChange={(e) => setEditor({ ...editor, defaultModel: e.target.value })}
                      >
                        <NativeSelectOption value="">{t('settings.providers.modelUnset')}</NativeSelectOption>
                        {validModelOptions.map((opt) => (
                          <NativeSelectOption key={opt.id} value={opt.id}>
                            {opt.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </label>

                    <div className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink-2">
                        {t('settings.providers.smallModel')}
                      </span>
                      <NativeSelect
                        size="sm"
                        className="w-full"
                        data-testid="provider-small-model"
                        value={editor.smallModel}
                        onChange={(e) => setEditor({ ...editor, smallModel: e.target.value })}
                      >
                        <NativeSelectOption value="">{t('settings.providers.modelUnset')}</NativeSelectOption>
                        {validModelOptions.map((opt) => (
                          <NativeSelectOption key={opt.id} value={opt.id}>
                            {opt.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <p className="m-0 text-[11.5px] text-ink-3">{t('settings.providers.smallModelHint')}</p>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* 给哪些 Agent 用 */}
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <span className="text-[12px] font-semibold text-ink">{t('settings.providers.bindTitle')}</span>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="provider-bind-backends">
                {backends.map((backend) => {
                  const urls = {
                    anthropicUrl: editor.anthropicUrl,
                    openaiChatUrl: editor.openaiChatUrl,
                    openaiResponsesUrl: editor.openaiResponsesUrl,
                    convertOpenaiToAnthropic: editor.convertOpenaiToAnthropic,
                  };
                  const ready = isProviderReadyForBackend(urls, backend, {
                    protocolGatewayEnabled: protocolGatewayEnabled || editor.convertOpenaiToAnthropic,
                  });
                  const checked = ready && editor.boundBackendIds.includes(backend.id);
                  const currentOwner = boundOwnerByBackend.get(backend.id);
                  const ownedByOther = currentOwner && currentOwner.id !== editor.editingId;
                  return (
                    <label
                      key={backend.id}
                      className={cn(
                        'inline-flex items-center gap-1.5 text-[12.5px]',
                        ready ? 'cursor-pointer text-ink' : 'cursor-not-allowed text-ink-3 opacity-60',
                      )}
                    >
                      <Checkbox
                        data-testid={`provider-bind-backend-${backend.id}`}
                        disabled={!ready}
                        checked={checked}
                        onCheckedChange={(val) => toggleBackendBind(backend.id, val === true)}
                      />
                      <span>{backend.name}</span>
                      {ownedByOther ? (
                        <span className="text-[11px] text-ink-3">
                          ({t('settings.providers.boundElsewhere', currentOwner.name)})
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>

              {(compatibilitySummary.missingHints.length > 0 || compatibilitySummary.accountOnlyNames.length > 0) ? (
                <p
                  className="m-0 text-[11.5px] leading-relaxed text-ink-3"
                  data-testid="provider-compatibility-hint"
                >
                  {compatibilitySummary.missingHints.length > 0
                    ? t('settings.providers.bindMissingUrls', compatibilitySummary.missingHints.join('、'))
                    : ''}
                  {compatibilitySummary.missingHints.length > 0 && compatibilitySummary.accountOnlyNames.length > 0
                    ? ' '
                    : ''}
                  {compatibilitySummary.accountOnlyNames.length > 0
                    ? t('settings.providers.bindAccountOnly', compatibilitySummary.accountOnlyNames.join('、'))
                    : ''}
                </p>
              ) : null}

              {/* 可选：同时绑定到工作台智能体预设 */}
              {workbenchAgents.length > 0 ? (
                <div className="mt-1.5 flex flex-col gap-1.5 rounded-card bg-field/60 p-2.5">
                  <span className="text-[11.5px] font-medium text-ink-2">
                    {t('settings.providers.bindWorkbenchAgents')}
                  </span>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" data-testid="provider-bind-wb-agents">
                    {workbenchAgents.map((agent) => {
                      const checked = editor.boundAgentIds.includes(agent.id);
                      const owner = boundOwnerByWbAgent.get(agent.id);
                      const ownedByOther = owner && owner.id !== editor.editingId;
                      return (
                        <label key={agent.id} className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-ink">
                          <Checkbox
                            data-testid={`provider-bind-wb-agent-${agent.id}`}
                            checked={checked}
                            onCheckedChange={(val) => toggleWbAgentBind(agent.id, val === true)}
                          />
                          <span>{agent.name}</span>
                          {ownedByOther ? (
                            <span className="text-[11px] text-ink-3">
                              ({t('settings.providers.boundElsewhere', owner.name)})
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                  <p className="m-0 text-[11px] text-ink-3">{t('settings.providers.bindWorkbenchAgentsHint')}</p>
                </div>
              ) : null}
            </div>

            {formError ? (
              <div className="text-[12px] text-destructive" role="alert" data-testid="provider-form-error">
                {formError}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
              {providers.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="provider-cancel-btn"
                  onClick={closeEditor}
                >
                  {t('common.cancel')}
                </Button>
              ) : null}
              <Button type="button" size="sm" data-testid="provider-save-btn" onClick={saveProvider}>
                {t('settings.providers.save')}
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SavedProviderCard({
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
    Boolean(provider.openaiChatUrl?.trim()) &&
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
            size="xs"
            data-testid={`edit-provider-${provider.id}`}
            onClick={onEdit}
          >
            <PencilIcon className="size-3" />
            <span>{t('common.edit')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
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

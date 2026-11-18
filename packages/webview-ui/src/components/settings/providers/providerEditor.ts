import { type ProviderModelItem, type ProviderPreset, type ProviderView } from '@harness-deck/shared';

export interface EditableModelRow {
  readonly rowKey: number;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: string;
  readonly maxOutputTokens: string;
  readonly effortsText: string;
  readonly vision: boolean;
}

export interface ProviderEditorState {
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

export let rowSeq = 1;

export function nextRowKey(): number {
  return rowSeq++;
}

export function emptyModelRow(): EditableModelRow {
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

export function toEditableRow(item: ProviderModelItem): EditableModelRow {
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

export function editorFromPreset(preset: ProviderPreset, locale: 'zh' | 'en', prev?: ProviderEditorState): ProviderEditorState {
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

export function editorFromProvider(provider: ProviderView): ProviderEditorState {
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

/**
 * 第三方模型服务商（Coding Plan 编程套餐与自定义网关）配置的校验、归一化与智能体绑定逻辑。
 * 纯函数，便于独立单元测试；API Key 只存 VS Code SecretStorage，绝不进入此处的持久化结构。
 */
import { randomUUID } from 'node:crypto';
import type {
  ModelOption,
  ProviderConfig,
  ProviderModelItem,
  ProvidersState,
  ProviderView,
} from '@harness-deck/shared';

export const PROVIDER_SECRET_PREFIX = 'harnessDeck.provider.apiKey.';

export function providerSecretKey(id: string): string {
  return `${PROVIDER_SECRET_PREFIX}${id}`;
}

export function normalizeProviderId(rawId: string): string {
  return rawId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function cleanUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/u, '');
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function cleanModels(raw: unknown): ProviderModelItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProviderModelItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined;
    const contextWindow =
      typeof obj.contextWindow === 'string' && obj.contextWindow.trim() ? obj.contextWindow.trim() : undefined;
    const maxOutputTokens =
      typeof obj.maxOutputTokens === 'string' && obj.maxOutputTokens.trim() ? obj.maxOutputTokens.trim() : undefined;
    const efforts = Array.isArray(obj.efforts)
      ? [
          ...new Set(
            obj.efforts
              .filter((e): e is string => typeof e === 'string')
              .map((e) => e.trim())
              .filter(Boolean),
          ),
        ]
      : undefined;
    const vision = obj.vision === true ? true : undefined;
    out.push({
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(efforts && efforts.length > 0 ? { efforts } : {}),
      ...(vision ? { vision: true } : {}),
    });
  }
  return out;
}

function cleanStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/** 解析设置 `harnessDeck.providers` 中的服务商列表。 */
export function parseProvidersSetting(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const claimedBackends = new Set<string>();
  const claimedAgents = new Set<string>();
  const out: ProviderConfig[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;
    const rawId = typeof obj.id === 'string' && obj.id.trim() ? obj.id : name;
    const id = normalizeProviderId(rawId);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const presetId = typeof obj.presetId === 'string' && obj.presetId.trim() ? obj.presetId.trim() : undefined;
    const anthropicUrl = cleanUrl(obj.anthropicUrl);
    const openaiChatUrl = cleanUrl(obj.openaiChatUrl);
    const openaiResponsesUrl = cleanUrl(obj.openaiResponsesUrl);
    const convertOpenaiToAnthropic = obj.convertOpenaiToAnthropic === true ? true : undefined;
    const models = cleanModels(obj.models);

    const rawDefault = typeof obj.defaultModel === 'string' ? obj.defaultModel.trim() : '';
    const defaultModel =
      rawDefault && (models.length === 0 || models.some((m) => m.id === rawDefault))
        ? rawDefault
        : models[0]?.id;

    const rawSmall = typeof obj.smallModel === 'string' ? obj.smallModel.trim() : '';
    const smallModel =
      rawSmall && (models.length === 0 || models.some((m) => m.id === rawSmall))
        ? rawSmall
        : undefined;

    // 同一个智能体同一时间只绑定到一个服务商，避免默认模型与网关地址冲突
    const boundBackendIds = cleanStringList(obj.boundBackendIds).filter((bid) => {
      if (claimedBackends.has(bid)) return false;
      claimedBackends.add(bid);
      return true;
    });
    const boundAgentIds = cleanStringList(obj.boundAgentIds).filter((aid) => {
      if (claimedAgents.has(aid)) return false;
      claimedAgents.add(aid);
      return true;
    });

    out.push({
      id,
      name,
      ...(presetId ? { presetId } : {}),
      ...(anthropicUrl ? { anthropicUrl } : {}),
      ...(openaiChatUrl ? { openaiChatUrl } : {}),
      ...(openaiResponsesUrl ? { openaiResponsesUrl } : {}),
      ...(convertOpenaiToAnthropic ? { convertOpenaiToAnthropic: true } : {}),
      models,
      ...(defaultModel ? { defaultModel } : {}),
      ...(smallModel ? { smallModel } : {}),
      boundBackendIds,
      ...(boundAgentIds.length > 0 ? { boundAgentIds } : {}),
    });
  }
  return out;
}

export interface UpsertProviderInput {
  readonly id?: string;
  readonly name: string;
  readonly presetId?: string;
  readonly anthropicUrl?: string;
  readonly openaiChatUrl?: string;
  readonly openaiResponsesUrl?: string;
  readonly convertOpenaiToAnthropic?: boolean;
  readonly models: readonly ProviderModelItem[];
  readonly defaultModel?: string;
  readonly smallModel?: string;
  readonly boundBackendIds: readonly string[];
  readonly boundAgentIds?: readonly string[];
}

/** 新增或更新一项服务商配置；其绑定的智能体自动从其他服务商解绑。 */
export function upsertProviderSetting(
  existing: readonly ProviderConfig[],
  input: UpsertProviderInput,
): { readonly providers: ProviderConfig[]; readonly provider: ProviderConfig } {
  const name = input.name.trim();
  const requestedId = input.id?.trim() ? normalizeProviderId(input.id) : '';
  let id = requestedId || normalizeProviderId(name) || `provider-${randomUUID().slice(0, 8)}`;
  if (!input.id?.trim() && existing.some((p) => p.id === id)) {
    let suffix = 2;
    while (existing.some((p) => p.id === `${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const anthropicUrl = cleanUrl(input.anthropicUrl);
  const openaiChatUrl = cleanUrl(input.openaiChatUrl);
  const openaiResponsesUrl = cleanUrl(input.openaiResponsesUrl);
  const models = cleanModels(input.models);

  const rawDefault = input.defaultModel?.trim() ?? '';
  const defaultModel =
    rawDefault && (models.length === 0 || models.some((m) => m.id === rawDefault))
      ? rawDefault
      : models[0]?.id;
  const rawSmall = input.smallModel?.trim() ?? '';
  const smallModel =
    rawSmall && (models.length === 0 || models.some((m) => m.id === rawSmall))
      ? rawSmall
      : undefined;

  const boundBackendIds = cleanStringList(input.boundBackendIds);
  const boundAgentIds = cleanStringList(input.boundAgentIds ?? []);
  const claimedBackends = new Set(boundBackendIds);
  const claimedAgents = new Set(boundAgentIds);

  const provider: ProviderConfig = {
    id,
    name,
    ...(input.presetId?.trim() ? { presetId: input.presetId.trim() } : {}),
    ...(anthropicUrl ? { anthropicUrl } : {}),
    ...(openaiChatUrl ? { openaiChatUrl } : {}),
    ...(openaiResponsesUrl ? { openaiResponsesUrl } : {}),
    ...(input.convertOpenaiToAnthropic === true ? { convertOpenaiToAnthropic: true } : {}),
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(smallModel ? { smallModel } : {}),
    boundBackendIds,
    ...(boundAgentIds.length > 0 ? { boundAgentIds } : {}),
  };

  let replaced = false;
  const next = existing.map((item) => {
    if (item.id === id) {
      replaced = true;
      return provider;
    }
    const filteredBackends = item.boundBackendIds.filter((b) => !claimedBackends.has(b));
    const filteredAgents = (item.boundAgentIds ?? []).filter((a) => !claimedAgents.has(a));
    const { boundAgentIds: _oldAgents, ...rest } = item;
    return {
      ...rest,
      boundBackendIds: filteredBackends,
      ...(filteredAgents.length > 0 ? { boundAgentIds: filteredAgents } : {}),
    };
  });

  return {
    providers: replaced ? next : [...next, provider],
    provider,
  };
}

/** 删除指定 id 的服务商。 */
export function deleteProviderSetting(existing: readonly ProviderConfig[], id: string): ProviderConfig[] {
  const target = normalizeProviderId(id);
  return existing.filter((p) => p.id !== target && p.id !== id);
}

/** 仅调整某个服务商绑定的智能体列表。 */
export function bindProviderSetting(
  existing: readonly ProviderConfig[],
  id: string,
  boundBackendIds: readonly string[],
  boundAgentIds?: readonly string[],
): ProviderConfig[] {
  const target = existing.find((p) => p.id === id || p.id === normalizeProviderId(id));
  if (!target) return [...existing];
  return upsertProviderSetting(existing, {
    ...target,
    boundBackendIds,
    boundAgentIds: boundAgentIds ?? target.boundAgentIds ?? [],
  }).providers;
}

/** 查找某个底层智能体当前绑定的服务商（兼容旧配置中绑定的 `oh-my-pi`）。 */
export function providerForBackend(
  providers: readonly ProviderConfig[],
  backendId: string,
): ProviderConfig | undefined {
  return providers.find(
    (p) =>
      p.boundBackendIds.includes(backendId) ||
      (backendId === 'pi' && p.boundBackendIds.includes('oh-my-pi')),
  );
}

/** 构造下发给 Webview 的 ProvidersState（带布尔 hasApiKey，不暴露密钥内容）。 */
export function buildProvidersState(
  providers: readonly ProviderConfig[],
  hasKeyIds: ReadonlySet<string>,
  options?: { readonly protocolGatewayEnabled?: boolean; readonly protocolGatewayOrigin?: string },
): ProvidersState {
  const items: ProviderView[] = providers.map((p) => ({
    ...p,
    hasApiKey: hasKeyIds.has(p.id),
  }));
  return {
    items,
    protocolGatewayEnabled: options?.protocolGatewayEnabled === true,
    ...(options?.protocolGatewayOrigin ? { protocolGatewayOrigin: options.protocolGatewayOrigin } : {}),
  };
}

/** 把服务商配置的模型列表转为统一的 ModelOption[]（供对话模型选择器与智能体表单复用）。 */
export function providerModelOptions(provider: ProviderConfig): ModelOption[] {
  return provider.models.map((m) => {
    const efforts = (m.efforts ?? []).map((e) => ({ id: e, name: e }));
    return {
      provider: provider.id,
      model: m.id,
      name: m.name || m.id,
      group: provider.name,
      efforts,
      ...(efforts[0] ? { defaultEffort: efforts[0].id } : {}),
    };
  });
}

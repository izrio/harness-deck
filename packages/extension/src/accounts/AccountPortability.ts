/**
 * 官方账号池导入 / 导出编解码器（兼容 Halo 标准格式与 cockpit-tools 常见 JSON/Token 导出格式）。
 *
 * 安全约束：
 * - 导出默认不包含任何敏感凭据（`includeSecrets = false`）；仅用户显式勾选迁移模式时导出凭据。
 * - 导入时自动识别 `cockpit-tools` 导出的 `email` / `refresh_token` / `access_token` / `platform` / `tags` / `note` 等字段，
 *   并转换为对应底层的安全凭据槽位（如 Antigravity OAuth JSON、DeepSeek/CodeBuddy API Key）。
 */
import type { AccountConfig, AccountRegion } from '@harness-deck/shared';
import { cleanNotes, cleanTags } from './AccountStore.ts';

export const HALO_ACCOUNTS_EXPORT_FORMAT = 'halo-accounts';
export const HALO_ACCOUNTS_EXPORT_VERSION = 1;

export interface ExportedAccountSecretBundle {
  readonly apiKey?: string;
  readonly usageCookie?: string;
  /** Antigravity / CodeBuddy 凭据槽位原始快照（如 OAuth JSON）。 */
  readonly slotRaw?: string;
}

export interface ExportedAccountRecord {
  readonly id?: string;
  readonly backendId: string;
  readonly label: string;
  readonly identity?: string;
  readonly isolateSessions?: boolean;
  readonly region?: AccountRegion;
  readonly tags?: readonly string[];
  readonly notes?: string;
  readonly disabled?: boolean;
  readonly apiKey?: string;
  readonly usageCookie?: string;
  readonly slotRaw?: string;
}

export interface ImportedAccountEntry {
  readonly backendId: string;
  readonly label: string;
  readonly isolateSessions?: boolean;
  readonly region?: AccountRegion;
  readonly tags?: readonly string[];
  readonly notes?: string;
  readonly disabled?: boolean;
  readonly apiKey?: string;
  readonly usageCookie?: string;
  readonly antigravitySlotRaw?: string;
  readonly codebuddySlotRaw?: string;
}

const PLATFORM_ALIAS_MAP: Readonly<Record<string, { readonly backendId: string; readonly region?: AccountRegion }>> = {
  antigravity: { backendId: 'antigravity' },
  agy: { backendId: 'antigravity' },
  google: { backendId: 'antigravity' },
  'google-antigravity': { backendId: 'antigravity' },
  claude: { backendId: 'claude' },
  'claude-code': { backendId: 'claude' },
  anthropic: { backendId: 'claude' },
  codex: { backendId: 'codex' },
  openai: { backendId: 'codex' },
  codebuddy: { backendId: 'codebuddy' },
  'codebuddy-cn': { backendId: 'codebuddy', region: 'cn' },
  'codebuddy-ai': { backendId: 'codebuddy', region: 'ai' },
  'codebuddy-intl': { backendId: 'codebuddy', region: 'ai' },
  dsh: { backendId: 'dsh' },
  deepseek: { backendId: 'dsh' },
  pi: { backendId: 'pi' },
  'oh-my-pi': { backendId: 'pi' },
  opencode: { backendId: 'opencode' },
  zcode: { backendId: 'zcode' },
};

function readString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

function normalizePlatform(
  raw: string | undefined,
  fallbackBackendId?: string,
): { readonly backendId: string; readonly region?: AccountRegion } | undefined {
  const clean = raw?.trim().toLowerCase();
  if (clean) {
    const mapped = PLATFORM_ALIAS_MAP[clean];
    if (mapped) return mapped;
    return { backendId: clean };
  }
  if (fallbackBackendId?.trim()) {
    const fb = fallbackBackendId.trim().toLowerCase();
    return PLATFORM_ALIAS_MAP[fb] ?? { backendId: fallbackBackendId.trim() };
  }
  return undefined;
}

/** 根据 cockpit-tools 常见字段组装标准 Antigravity OAuth 凭据 JSON。 */
function buildAntigravitySlotFromRecord(obj: Record<string, unknown>): string | undefined {
  const explicitSlot = readString(obj, 'slotRaw', 'slot_raw', 'oauthJson', 'oauth_json');
  if (explicitSlot) return explicitSlot;

  const nestedToken = obj.token && typeof obj.token === 'object' ? (obj.token as Record<string, unknown>) : undefined;
  const refreshToken =
    readString(obj, 'refresh_token', 'refreshToken') ??
    (nestedToken ? readString(nestedToken, 'refresh_token', 'refreshToken') : undefined);
  const accessToken =
    readString(obj, 'access_token', 'accessToken') ??
    (nestedToken ? readString(nestedToken, 'access_token', 'accessToken') : undefined);
  if (!refreshToken && !accessToken) return undefined;

  const email = readString(obj, 'email', 'identity', 'account_email');
  const expiryRaw = obj.expiry ?? obj.expires_at ?? obj.expiresAt ?? nestedToken?.expiry ?? nestedToken?.expires_at;
  const tokenPayload: Record<string, unknown> = {
    ...(accessToken ? { access_token: accessToken } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    token_type: 'Bearer',
    ...(expiryRaw !== undefined ? { expiry: expiryRaw } : {}),
  };
  return JSON.stringify(
    {
      token: tokenPayload,
      ...(email ? { email } : {}),
    },
    null,
    2,
  );
}

/** 解析 Halo 导出 JSON 或 cockpit-tools 导出的账号/Token JSON。 */
export function parseImportedAccountsJson(
  rawJson: string,
  defaultBackendId?: string,
): { readonly entries: ImportedAccountEntry[]; readonly warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.trim());
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  let rawItems: unknown[];
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root.accounts)) {
      rawItems = root.accounts;
    } else if (root.accounts && typeof root.accounts === 'object') {
      rawItems = Object.values(root.accounts as Record<string, unknown>);
    } else if (Array.isArray(root.items)) {
      rawItems = root.items;
    } else {
      rawItems = [root];
    }
  } else {
    throw new Error('JSON must be an object or an array of accounts');
  }

  const entries: ImportedAccountEntry[] = [];
  const warnings: string[] = [];

  rawItems.forEach((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      warnings.push(`#${index + 1}: skipped non-object item`);
      return;
    }
    const obj = rawItem as Record<string, unknown>;
    const rawPlatform = readString(obj, 'backendId', 'backend_id', 'platform', 'provider', 'type', 'ide');
    const resolvedPlatform = normalizePlatform(rawPlatform, defaultBackendId);
    if (!resolvedPlatform) {
      warnings.push(`#${index + 1}: missing backend/platform`);
      return;
    }

    const email = readString(obj, 'email', 'identity', 'username', 'account');
    const label = readString(obj, 'label', 'name', 'nickname', 'title') ?? email;
    if (!label) {
      warnings.push(`#${index + 1}: missing label or email`);
      return;
    }

    const rawRegion = readString(obj, 'region')?.toLowerCase();
    const region: AccountRegion | undefined =
      rawRegion === 'cn' || rawRegion === 'ai' || rawRegion === 'internal'
        ? rawRegion
        : resolvedPlatform.region;

    // 兼容 tags 数组或单个 group 字段（cockpit-tools 分组转标签）
    const groupTag = readString(obj, 'group', 'groupName', 'group_name');
    const rawTagArray = Array.isArray(obj.tags)
      ? obj.tags
      : typeof obj.tags === 'string'
        ? obj.tags.split(/[,，]/u)
        : [];
    const tags = cleanTags([...rawTagArray, ...(groupTag ? [groupTag] : [])]);
    const notes = cleanNotes(readString(obj, 'notes', 'note', 'memo', 'remark', 'description'));
    const disabled = obj.disabled === true || obj.enabled === false ? true : undefined;
    const isolateSessions = obj.isolateSessions === true || obj.isolate_sessions === true ? true : undefined;

    const apiKey = readString(obj, 'apiKey', 'api_key');
    const usageCookie = readString(obj, 'usageCookie', 'usage_cookie', 'cookie');
    const antigravitySlotRaw =
      resolvedPlatform.backendId === 'antigravity' ? buildAntigravitySlotFromRecord(obj) : undefined;
    const codebuddySlotRaw =
      resolvedPlatform.backendId === 'codebuddy' ? readString(obj, 'slotRaw', 'slot_raw') : undefined;

    entries.push({
      backendId: resolvedPlatform.backendId,
      label,
      ...(isolateSessions ? { isolateSessions: true } : {}),
      ...(region ? { region } : {}),
      ...(tags ? { tags } : {}),
      ...(notes ? { notes } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(usageCookie ? { usageCookie } : {}),
      ...(antigravitySlotRaw ? { antigravitySlotRaw } : {}),
      ...(codebuddySlotRaw ? { codebuddySlotRaw } : {}),
    });
  });

  return { entries, warnings };
}

/** 构造标准可迁移 JSON（默认脱敏不含密钥；仅用户显式启用 `includeSecrets` 时附带凭据）。 */
export function buildAccountsExportJson(
  accounts: readonly (AccountConfig & { readonly identity?: string })[],
  secretsByAccountId: ReadonlyMap<string, ExportedAccountSecretBundle>,
  options: { readonly includeSecrets?: boolean; readonly now?: number } = {},
): string {
  const includeSecrets = options.includeSecrets === true;
  const records: ExportedAccountRecord[] = accounts.map((acc) => {
    const sec = includeSecrets ? secretsByAccountId.get(acc.id) : undefined;
    return {
      id: acc.id,
      backendId: acc.backendId,
      label: acc.label,
      ...(acc.identity ? { identity: acc.identity } : {}),
      ...(acc.isolateSessions ? { isolateSessions: true } : {}),
      ...(acc.region ? { region: acc.region } : {}),
      ...(acc.tags && acc.tags.length > 0 ? { tags: acc.tags } : {}),
      ...(acc.notes ? { notes: acc.notes } : {}),
      ...(acc.disabled ? { disabled: true } : {}),
      ...(sec?.apiKey ? { apiKey: sec.apiKey } : {}),
      ...(sec?.usageCookie ? { usageCookie: sec.usageCookie } : {}),
      ...(sec?.slotRaw ? { slotRaw: sec.slotRaw } : {}),
    };
  });

  return JSON.stringify(
    {
      format: HALO_ACCOUNTS_EXPORT_FORMAT,
      version: HALO_ACCOUNTS_EXPORT_VERSION,
      exportedAt: new Date(options.now ?? Date.now()).toISOString(),
      includesSecrets: includeSecrets,
      accounts: records,
    },
    null,
    2,
  );
}

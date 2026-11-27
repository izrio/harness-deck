/**
 * 云端开发环境配置与凭据存储：
 * - 元数据（名称、服务地址、类型、最近打开的远端项目）保存在 globalState
 * - 配对换取的 `hd_device_session` Cookie 保存在宿主 SecretStorage（不进入前端快照）
 */
import { randomUUID } from 'node:crypto';
import type {
  CloudEnvironmentProvider,
  CloudEnvironmentStatus,
  CloudEnvironmentView,
} from '@harness-deck/shared';
import type { KeyValueStore, SecretStore } from '../host/HostPlatform.ts';

const CLOUD_ENVIRONMENTS_KEY = 'harnessDeck.cloudEnvironments';
const CLOUD_COOKIE_SECRET_PREFIX = 'harnessDeck.cloudEnv.cookie.';
const MAX_CLOUD_ENVIRONMENTS = 24;

export interface StoredCloudEnvironment {
  readonly id: string;
  readonly name: string;
  readonly endpointUrl: string;
  readonly provider: CloudEnvironmentProvider;
  readonly remoteProjectName?: string;
  readonly remoteProjectPath?: string;
  readonly lastConnectedAt?: number;
  readonly createdAt: number;
}

export interface ParsedCloudPairingInput {
  readonly endpointUrl: string;
  readonly pairingCode?: string;
  readonly inferredProvider: CloudEnvironmentProvider;
  readonly suggestedName: string;
}

function isLocalLikeHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.startsWith('10.') ||
    lower.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(lower)
  );
}

/**
 * 解析用户粘贴的云环境配对链接或服务地址：
 * 支持 `https://xxx.trycloudflare.com/pair#code=xxx`、`http://127.0.0.1:37890/pair#code=xxx`、
 * 纯服务地址 `https://box.tailnet.ts.net` 或裸域名。
 */
export function parseCloudPairingInput(
  rawInput: string,
  explicitCode?: string,
): ParsedCloudPairingInput | undefined {
  const trimmed = rawInput.trim();
  if (!trimmed) return undefined;

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    const hostPart = candidate.split('/')[0] ?? '';
    const hostOnly = hostPart.replace(/:\d+$/u, '');
    candidate = `${isLocalLikeHost(hostOnly) ? 'http' : 'https'}://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (!parsed.hostname) return undefined;

  const endpointUrl = `${parsed.protocol}//${parsed.host}`;

  let codeFromUrl: string | undefined;
  if (parsed.hash) {
    const hashBody = parsed.hash.replace(/^#/u, '');
    const params = new URLSearchParams(hashBody);
    const hashCode = params.get('code')?.trim();
    if (hashCode) codeFromUrl = hashCode;
  }
  if (!codeFromUrl) {
    const queryCode = parsed.searchParams.get('code')?.trim();
    if (queryCode) codeFromUrl = queryCode;
  }

  const pairingCode = explicitCode?.trim() || codeFromUrl || undefined;
  const hostLower = parsed.hostname.toLowerCase();
  const inferredProvider: CloudEnvironmentProvider =
    hostLower.includes('colab') || hostLower.endsWith('.trycloudflare.com')
      ? 'colab'
      : hostLower.endsWith('.ts.net') || isLocalLikeHost(hostLower)
        ? 'linux'
        : 'custom';

  const shortHost = hostLower.endsWith('.trycloudflare.com')
    ? `Colab · ${hostLower.slice(0, Math.min(14, hostLower.indexOf('.')))}`
    : hostLower;

  return {
    endpointUrl,
    ...(pairingCode ? { pairingCode } : {}),
    inferredProvider,
    suggestedName: shortHost,
  };
}

function normalizeProvider(raw: unknown): CloudEnvironmentProvider {
  if (raw === 'colab' || raw === 'linux' || raw === 'custom') return raw;
  return 'custom';
}

function normalizeName(raw: string | undefined, fallback: string): string {
  const clean = (raw ?? '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 80);
  return clean || fallback;
}

export function parseStoredCloudEnvironments(raw: unknown): StoredCloudEnvironment[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StoredCloudEnvironment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id.trim() || seen.has(rec.id)) continue;
    if (typeof rec.endpointUrl !== 'string') continue;
    const parsed = parseCloudPairingInput(rec.endpointUrl);
    if (!parsed) continue;
    seen.add(rec.id);
    out.push({
      id: rec.id,
      name: normalizeName(typeof rec.name === 'string' ? rec.name : undefined, parsed.suggestedName),
      endpointUrl: parsed.endpointUrl,
      provider: normalizeProvider(rec.provider),
      ...(typeof rec.remoteProjectName === 'string' && rec.remoteProjectName.trim()
        ? { remoteProjectName: rec.remoteProjectName.trim() }
        : {}),
      ...(typeof rec.remoteProjectPath === 'string' && rec.remoteProjectPath.trim()
        ? { remoteProjectPath: rec.remoteProjectPath.trim() }
        : {}),
      ...(typeof rec.lastConnectedAt === 'number' && Number.isFinite(rec.lastConnectedAt)
        ? { lastConnectedAt: rec.lastConnectedAt }
        : {}),
      createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
    });
    if (out.length >= MAX_CLOUD_ENVIRONMENTS) break;
  }
  return out;
}

export class CloudEnvironmentStore {
  private entries: StoredCloudEnvironment[];
  private readonly credentialPresence = new Map<string, boolean>();

  constructor(
    private readonly globalState: KeyValueStore,
    private readonly secrets: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.entries = parseStoredCloudEnvironments(globalState.get<unknown>(CLOUD_ENVIRONMENTS_KEY));
  }

  /** 异步预热每个已保存云环境是否存在本地配对凭据。 */
  async hydrateCredentialPresence(): Promise<void> {
    await Promise.all(
      this.entries.map(async (entry) => {
        const cookie = await this.secrets.get(this.secretKey(entry.id));
        this.credentialPresence.set(entry.id, Boolean(cookie));
      }),
    );
  }

  list(): readonly StoredCloudEnvironment[] {
    return this.entries;
  }

  get(id: string): StoredCloudEnvironment | undefined {
    return this.entries.find((e) => e.id === id);
  }

  hasCredentials(id: string): boolean {
    return this.credentialPresence.get(id) === true;
  }

  async getCookie(id: string): Promise<string | undefined> {
    const value = await this.secrets.get(this.secretKey(id));
    this.credentialPresence.set(id, Boolean(value));
    return value;
  }

  async setCookie(id: string, cookieValue: string): Promise<void> {
    await this.secrets.store(this.secretKey(id), cookieValue);
    this.credentialPresence.set(id, true);
  }

  async add(
    input: {
      readonly name?: string;
      readonly endpointUrl: string;
      readonly provider: CloudEnvironmentProvider;
      readonly remoteProjectName?: string;
      readonly remoteProjectPath?: string;
    },
    cookieValue?: string,
  ): Promise<StoredCloudEnvironment> {
    const parsed = parseCloudPairingInput(input.endpointUrl);
    const endpointUrl = parsed?.endpointUrl ?? input.endpointUrl;
    const entry: StoredCloudEnvironment = {
      id: randomUUID(),
      name: normalizeName(input.name, parsed?.suggestedName ?? endpointUrl),
      endpointUrl,
      provider: normalizeProvider(input.provider),
      ...(input.remoteProjectName ? { remoteProjectName: input.remoteProjectName } : {}),
      ...(input.remoteProjectPath ? { remoteProjectPath: input.remoteProjectPath } : {}),
      createdAt: this.now(),
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_CLOUD_ENVIRONMENTS);
    if (cookieValue) {
      await this.setCookie(entry.id, cookieValue);
    } else {
      this.credentialPresence.set(entry.id, false);
    }
    await this.persist();
    return entry;
  }

  async update(
    id: string,
    patch: {
      readonly name?: string;
      readonly endpointUrl?: string;
      readonly provider?: CloudEnvironmentProvider;
      readonly remoteProjectName?: string;
      readonly remoteProjectPath?: string;
      readonly lastConnectedAt?: number;
    },
    cookieValue?: string,
  ): Promise<StoredCloudEnvironment | undefined> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return undefined;
    const prev = this.entries[idx]!;
    const nextEndpoint = patch.endpointUrl
      ? (parseCloudPairingInput(patch.endpointUrl)?.endpointUrl ?? patch.endpointUrl)
      : prev.endpointUrl;
    const next: StoredCloudEnvironment = {
      ...prev,
      name: patch.name !== undefined ? normalizeName(patch.name, prev.name) : prev.name,
      endpointUrl: nextEndpoint,
      provider: patch.provider ? normalizeProvider(patch.provider) : prev.provider,
      ...(patch.remoteProjectName !== undefined
        ? patch.remoteProjectName
          ? { remoteProjectName: patch.remoteProjectName }
          : {}
        : prev.remoteProjectName
          ? { remoteProjectName: prev.remoteProjectName }
          : {}),
      ...(patch.remoteProjectPath !== undefined
        ? patch.remoteProjectPath
          ? { remoteProjectPath: patch.remoteProjectPath }
          : {}
        : prev.remoteProjectPath
          ? { remoteProjectPath: prev.remoteProjectPath }
          : {}),
      ...(patch.lastConnectedAt !== undefined
        ? { lastConnectedAt: patch.lastConnectedAt }
        : prev.lastConnectedAt !== undefined
          ? { lastConnectedAt: prev.lastConnectedAt }
          : {}),
    };
    this.entries = this.entries.map((item, i) => (i === idx ? next : item));
    if (cookieValue) {
      await this.setCookie(id, cookieValue);
    }
    await this.persist();
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.credentialPresence.delete(id);
    await this.secrets.delete(this.secretKey(id));
    if (this.entries.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  toViews(
    activeEnvId: string | undefined,
    activeStatus: CloudEnvironmentStatus,
    activeError?: string,
  ): CloudEnvironmentView[] {
    return this.entries.map((entry) => {
      const isActive = entry.id === activeEnvId;
      return {
        id: entry.id,
        name: entry.name,
        endpointUrl: entry.endpointUrl,
        provider: entry.provider,
        status: isActive ? activeStatus : 'disconnected',
        hasCredentials: this.hasCredentials(entry.id),
        ...(entry.remoteProjectName ? { remoteProjectName: entry.remoteProjectName } : {}),
        ...(entry.remoteProjectPath ? { remoteProjectPath: entry.remoteProjectPath } : {}),
        ...(entry.lastConnectedAt !== undefined ? { lastConnectedAt: entry.lastConnectedAt } : {}),
        ...(isActive && activeError ? { error: activeError } : {}),
      };
    });
  }

  private secretKey(id: string): string {
    return `${CLOUD_COOKIE_SECRET_PREFIX}${id}`;
  }

  private async persist(): Promise<void> {
    await this.globalState.update(CLOUD_ENVIRONMENTS_KEY, this.entries);
  }
}

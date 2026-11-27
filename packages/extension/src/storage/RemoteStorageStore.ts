/**
 * 远端存储源配置与凭据管理（Google Cloud Storage / Google Drive / WebDAV）：
 * - 非敏感元数据存储在 `globalState`
 * - 密钥（WebDAV 密码 / Access Token / Service Account JSON / Refresh Token JSON）仅存宿主 `SecretStore`
 */
import { randomUUID } from 'node:crypto';
import type { RemoteStorageKind, RemoteStoragesState, RemoteStorageView } from '@harness-deck/shared';
import type { KeyValueStore, SecretStore } from '../host/HostPlatform.ts';

const REMOTE_STORAGES_KEY = 'harnessDeck.remoteStorages';
const REMOTE_STORAGE_SECRET_PREFIX = 'harnessDeck.remoteStorage.secret.';
const MAX_REMOTE_STORAGES = 24;

export interface StoredRemoteStorage {
  readonly id: string;
  readonly name: string;
  readonly kind: RemoteStorageKind;
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly rootPath?: string;
  readonly username?: string;
  readonly createdAt: number;
}

function normalizeKind(raw: unknown): RemoteStorageKind | undefined {
  if (raw === 'google-cloud-storage' || raw === 'google-drive' || raw === 'webdav') return raw;
  return undefined;
}

function cleanOptional(raw: unknown, maxLen = 1_024): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().slice(0, maxLen);
  return trimmed || undefined;
}

/** 若用户粘贴了 Google Service Account JSON，自动提取 client_email 作为脱敏展示标识。 */
export function extractGoogleServiceAccountEmail(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  const trimmed = secret.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.client_email === 'string' && parsed.client_email.includes('@')) {
      return parsed.client_email.trim();
    }
  } catch {
    // ignore non-json secret
  }
  return undefined;
}

export function normalizeWebDavEndpoint(raw: string | undefined): string | undefined {
  const trimmed = cleanOptional(raw, 2_048);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return trimmed.replace(/\/+$/u, '');
  } catch {
    return undefined;
  }
}

export function parseStoredRemoteStorages(raw: unknown): StoredRemoteStorage[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StoredRemoteStorage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = cleanOptional(rec.id, 120);
    const kind = normalizeKind(rec.kind);
    const name = cleanOptional(rec.name, 120);
    if (!id || !kind || !name || seen.has(id)) continue;
    seen.add(id);
    const endpoint = normalizeWebDavEndpoint(typeof rec.endpoint === 'string' ? rec.endpoint : undefined);
    const bucket = cleanOptional(rec.bucket, 256);
    const rootPath = cleanOptional(rec.rootPath, 1_024);
    const username = cleanOptional(rec.username, 256);
    out.push({
      id,
      name,
      kind,
      ...(endpoint ? { endpoint } : {}),
      ...(bucket ? { bucket } : {}),
      ...(rootPath ? { rootPath } : {}),
      ...(username ? { username } : {}),
      createdAt: typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
    });
    if (out.length >= MAX_REMOTE_STORAGES) break;
  }
  return out;
}

export class RemoteStorageStore {
  private entries: StoredRemoteStorage[];
  private readonly secretPresence = new Map<string, boolean>();

  constructor(
    private readonly globalState: KeyValueStore,
    private readonly secrets: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.entries = parseStoredRemoteStorages(globalState.get<unknown>(REMOTE_STORAGES_KEY));
  }

  async hydrateSecretPresence(): Promise<void> {
    await Promise.all(
      this.entries.map(async (entry) => {
        const value = await this.secrets.get(this.secretKey(entry.id));
        this.secretPresence.set(entry.id, Boolean(value));
      }),
    );
  }

  list(): readonly StoredRemoteStorage[] {
    return this.entries;
  }

  get(id: string): StoredRemoteStorage | undefined {
    return this.entries.find((e) => e.id === id);
  }

  async getSecret(id: string): Promise<string | undefined> {
    const value = await this.secrets.get(this.secretKey(id));
    this.secretPresence.set(id, Boolean(value));
    return value;
  }

  async upsert(input: {
    readonly id?: string;
    readonly name: string;
    readonly kind: RemoteStorageKind;
    readonly endpoint?: string;
    readonly bucket?: string;
    readonly rootPath?: string;
    readonly username?: string;
    readonly secret?: string;
  }): Promise<StoredRemoteStorage> {
    const existing = input.id ? this.get(input.id) : undefined;
    const id = existing?.id ?? randomUUID();
    const endpoint = normalizeWebDavEndpoint(input.endpoint);
    const bucket = cleanOptional(input.bucket, 256);
    const rootPath = cleanOptional(input.rootPath, 1_024);
    const inferredEmail = extractGoogleServiceAccountEmail(input.secret);
    const sameKindExistingUsername = existing && existing.kind === input.kind ? existing.username : undefined;
    const username =
      input.kind === 'webdav'
        ? cleanOptional(input.username, 256)
        : (cleanOptional(input.username, 256) ?? inferredEmail ?? sameKindExistingUsername);

    const record: StoredRemoteStorage = {
      id,
      name: cleanOptional(input.name, 120) ?? existing?.name ?? input.kind,
      kind: input.kind,
      ...(endpoint ? { endpoint } : {}),
      ...(bucket ? { bucket } : {}),
      ...(rootPath ? { rootPath } : {}),
      ...(username ? { username } : {}),
      createdAt: existing?.createdAt ?? this.now(),
    };

    if (existing) {
      this.entries = this.entries.map((e) => (e.id === id ? record : e));
    } else {
      this.entries = [record, ...this.entries].slice(0, MAX_REMOTE_STORAGES);
    }

    if (input.secret !== undefined) {
      const trimmedSecret = input.secret.trim();
      if (trimmedSecret) {
        await this.secrets.store(this.secretKey(id), trimmedSecret);
        this.secretPresence.set(id, true);
      } else {
        await this.secrets.delete(this.secretKey(id));
        this.secretPresence.set(id, false);
      }
    }

    await this.persist();
    return record;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.secretPresence.delete(id);
    await this.secrets.delete(this.secretKey(id));
    if (this.entries.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  toState(): RemoteStoragesState {
    const items: RemoteStorageView[] = this.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
      ...(entry.bucket ? { bucket: entry.bucket } : {}),
      ...(entry.rootPath ? { rootPath: entry.rootPath } : {}),
      ...(entry.username ? { username: entry.username } : {}),
      hasSecret: this.secretPresence.get(entry.id) === true,
      createdAt: entry.createdAt,
    }));
    return { items };
  }

  private secretKey(id: string): string {
    return `${REMOTE_STORAGE_SECRET_PREFIX}${id}`;
  }

  private async persist(): Promise<void> {
    await this.globalState.update(REMOTE_STORAGES_KEY, this.entries);
  }
}

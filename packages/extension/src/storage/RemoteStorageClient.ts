/**
 * 统一远端文件存储客户端：
 * - Google Cloud Storage（GCS JSON API v1，支持 Service Account JSON 原生 RS256 JWT 自动换取 Token / OAuth Access Token）
 * - Google Drive（谷歌云盘 API v3，支持 Access Token / Refresh Token JSON / Service Account JSON）
 * - WebDAV（通用 PROPFIND / GET / PUT / DELETE / MKCOL，支持 Basic / Bearer 鉴权）
 * 零额外第三方依赖，复用 `createProxyAwareFetch` 无缝适配 HTTP 代理与 WSL2。
 */
import { createHash, createSign } from 'node:crypto';
import type { RemoteFileEntry, RemoteStorageBreadcrumb } from '@harness-deck/shared';
import type { FetchLike } from '../providers/proxyFetch.ts';
import type { StoredRemoteStorage } from './RemoteStorageStore.ts';

export interface RemoteListOutput {
  readonly dirPath: string;
  readonly breadcrumbs: readonly RemoteStorageBreadcrumb[];
  readonly items: readonly RemoteFileEntry[];
}

export interface RemoteReadOutput {
  readonly bytes: Buffer;
  readonly mimeType?: string;
}

export interface RemoteStorageAdapter {
  list(dirPath: string, query?: string): Promise<RemoteListOutput>;
  read(entryId: string, path: string): Promise<RemoteReadOutput>;
  upload(dirPath: string, name: string, bytes: Buffer, mimeType?: string): Promise<void>;
  delete(entryId: string, path: string, kind: 'file' | 'directory'): Promise<void>;
  mkdir(dirPath: string, name: string): Promise<void>;
  test(): Promise<void>;
}

const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface CachedGoogleToken {
  readonly token: string;
  readonly expiresAt: number;
}

const googleTokenCache = new Map<string, CachedGoogleToken>();

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

/** 使用 Node 内置 `node:crypto` 签发 Google Service Account RS256 JWT。 */
export function signGoogleServiceAccountJwt(options: {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly scope: string;
  readonly tokenUri?: string;
  readonly nowSec?: number;
}): string {
  const iat = options.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(
    JSON.stringify({
      iss: options.clientEmail,
      scope: options.scope,
      aud: options.tokenUri ?? GOOGLE_TOKEN_URI,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64Url(signer.sign(options.privateKey));
  return `${signingInput}.${signature}`;
}

/**
 * 解析 Google 认证凭据并返回可用 Bearer Access Token：
 * 1. Service Account JSON（`type === 'service_account'`）→ RS256 JWT 换取 OAuth Token
 * 2. Refresh Token JSON（`client_id` + `client_secret` + `refresh_token`）→ 刷新 Token
 * 3. 纯文本 Access Token → 直接返回
 */
export async function resolveGoogleAccessToken(
  secret: string | undefined,
  scope: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const trimmed = secret?.trim() ?? '';
  if (!trimmed) {
    throw new Error('Missing Google credentials (Access Token or Service Account JSON)');
  }

  if (!trimmed.startsWith('{')) {
    return trimmed.replace(/^Bearer\s+/iu, '').trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid Google JSON credentials');
  }

  const secretDigest = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 16);
  const cacheKey = `${scope}:${secretDigest}`;
  const cached = googleTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  if (googleTokenCache.size > 64) {
    googleTokenCache.clear();
  }

  const tokenUri = typeof parsed.token_uri === 'string' && parsed.token_uri ? parsed.token_uri : GOOGLE_TOKEN_URI;

  if (
    parsed.type === 'service_account' &&
    typeof parsed.client_email === 'string' &&
    typeof parsed.private_key === 'string'
  ) {
    const assertion = signGoogleServiceAccountJwt({
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      scope,
      tokenUri,
    });
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const res = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== 'string') {
      throw new Error(
        `Google OAuth token exchange failed (${res.status}): ${String(json.error_description ?? json.error ?? 'unknown')}`,
      );
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    googleTokenCache.set(cacheKey, {
      token: json.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    return json.access_token;
  }

  if (typeof parsed.client_id === 'string' && typeof parsed.refresh_token === 'string') {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: parsed.client_id,
      refresh_token: parsed.refresh_token,
    });
    if (typeof parsed.client_secret === 'string' && parsed.client_secret.trim()) {
      body.set('client_secret', parsed.client_secret.trim());
    }
    const res = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== 'string') {
      throw new Error(
        `Google OAuth refresh failed (${res.status}): ${String(json.error_description ?? json.error ?? 'unknown')}`,
      );
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    googleTokenCache.set(cacheKey, {
      token: json.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    return json.access_token;
  }

  if (typeof parsed.access_token === 'string' && parsed.access_token.trim()) {
    return parsed.access_token.trim();
  }

  throw new Error('Unsupported Google JSON format (expected Service Account JSON or OAuth refresh_token JSON)');
}

function normalizeRelDir(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\\/gu, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

function sanitizeSegment(raw: string): string {
  const clean = raw.replace(/[\\/]+/gu, '').trim();
  if (!clean || clean === '.' || clean === '..') {
    throw new Error('Invalid file or folder name');
  }
  return clean;
}

function sortEntries(items: RemoteFileEntry[]): RemoteFileEntry[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function buildPathBreadcrumbs(rootLabel: string, dirPath: string): RemoteStorageBreadcrumb[] {
  const crumbs: RemoteStorageBreadcrumb[] = [{ id: '', label: rootLabel }];
  const norm = normalizeRelDir(dirPath);
  if (!norm) return crumbs;
  let acc = '';
  for (const seg of norm.split('/')) {
    acc = acc ? `${acc}/${seg}` : seg;
    crumbs.push({ id: acc, label: seg });
  }
  return crumbs;
}

async function readErrorSnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text.slice(0, 240) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ────────────────────────────────────────────────────────────
// 1. Google Cloud Storage (GCS JSON API v1)
// ────────────────────────────────────────────────────────────

export class GoogleCloudStorageAdapter implements RemoteStorageAdapter {
  private readonly apiBase: string;
  private readonly bucket: string;
  private readonly rootPrefix: string;

  constructor(
    private readonly config: StoredRemoteStorage,
    private readonly secret: string | undefined,
    private readonly fetchImpl: FetchLike,
  ) {
    this.apiBase = (config.endpoint || 'https://storage.googleapis.com').replace(/\/+$/u, '');
    const bucket = config.bucket?.trim() ?? '';
    if (!bucket) throw new Error('Google Cloud Storage bucket name is required');
    this.bucket = bucket;
    const normRoot = normalizeRelDir(config.rootPath);
    this.rootPrefix = normRoot ? `${normRoot}/` : '';
  }

  private fullPrefix(dirPath: string): string {
    const rel = normalizeRelDir(dirPath);
    return rel ? `${this.rootPrefix}${rel}/` : this.rootPrefix;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await resolveGoogleAccessToken(this.secret, GCS_SCOPE, this.fetchImpl);
    return { Authorization: `Bearer ${token}` };
  }

  async test(): Promise<void> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?maxResults=1`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`GCS connection failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async list(dirPath: string, query?: string): Promise<RemoteListOutput> {
    const headers = await this.authHeaders();
    const normDir = normalizeRelDir(dirPath);
    const prefix = this.fullPrefix(normDir);
    const params = new URLSearchParams({
      delimiter: '/',
      maxResults: '200',
    });
    if (prefix) params.set('prefix', prefix);

    const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params.toString()}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`GCS list failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
    const json = (await res.json()) as {
      prefixes?: string[];
      items?: { name: string; size?: string; updated?: string; contentType?: string }[];
    };

    const entries: RemoteFileEntry[] = [];
    for (const rawPref of json.prefixes ?? []) {
      const withoutRoot = this.rootPrefix && rawPref.startsWith(this.rootPrefix)
        ? rawPref.slice(this.rootPrefix.length)
        : rawPref;
      const cleanPath = withoutRoot.replace(/\/+$/u, '');
      const name = cleanPath.split('/').pop() ?? cleanPath;
      if (!name) continue;
      entries.push({
        id: rawPref,
        name,
        path: cleanPath,
        kind: 'directory',
      });
    }

    for (const item of json.items ?? []) {
      if (!item.name || item.name === prefix || item.name.endsWith('/')) continue;
      const withoutRoot = this.rootPrefix && item.name.startsWith(this.rootPrefix)
        ? item.name.slice(this.rootPrefix.length)
        : item.name;
      const name = withoutRoot.split('/').pop() ?? withoutRoot;
      const size = item.size !== undefined ? Number(item.size) : undefined;
      const modifiedAt = item.updated ? Date.parse(item.updated) : undefined;
      entries.push({
        id: item.name,
        name,
        path: withoutRoot,
        kind: 'file',
        ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
        ...(modifiedAt !== undefined && Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
        ...(item.contentType ? { mimeType: item.contentType } : {}),
      });
    }

    const needle = query?.trim().toLowerCase() ?? '';
    const filtered = needle
      ? entries.filter((e) => e.name.toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle))
      : entries;

    return {
      dirPath: normDir,
      breadcrumbs: buildPathBreadcrumbs(this.config.name || this.bucket, normDir),
      items: sortEntries(filtered),
    };
  }

  async read(entryId: string): Promise<RemoteReadOutput> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(entryId)}?alt=media`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`GCS download failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? undefined;
    return { bytes, ...(mimeType ? { mimeType } : {}) };
  }

  async upload(dirPath: string, name: string, bytes: Buffer, mimeType?: string): Promise<void> {
    const headers = await this.authHeaders();
    const safeName = sanitizeSegment(name);
    const objectName = `${this.fullPrefix(dirPath)}${safeName}`;
    const url = `${this.apiBase}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      throw new Error(`GCS upload failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async delete(entryId: string, _path: string, kind: 'file' | 'directory'): Promise<void> {
    const headers = await this.authHeaders();
    if (kind === 'file') {
      const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(entryId)}`;
      const res = await this.fetchImpl(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) {
        throw new Error(`GCS delete failed (${res.status}): ${await readErrorSnippet(res)}`);
      }
      return;
    }

    const prefix = entryId.endsWith('/') ? entryId : `${entryId}/`;
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ prefix, maxResults: '500' });
      if (pageToken) params.set('pageToken', pageToken);
      const listUrl = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${params.toString()}`;
      const listRes = await this.fetchImpl(listUrl, { method: 'GET', headers });
      if (!listRes.ok) {
        throw new Error(`GCS directory list failed (${listRes.status}): ${await readErrorSnippet(listRes)}`);
      }
      const json = (await listRes.json()) as { items?: { name: string }[]; nextPageToken?: string };
      for (const item of json.items ?? []) {
        const delUrl = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(item.name)}`;
        const delRes = await this.fetchImpl(delUrl, { method: 'DELETE', headers });
        if (!delRes.ok && delRes.status !== 404) {
          throw new Error(`GCS delete failed (${delRes.status}): ${await readErrorSnippet(delRes)}`);
        }
      }
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
  }

  async mkdir(dirPath: string, name: string): Promise<void> {
    const headers = await this.authHeaders();
    const safeName = sanitizeSegment(name);
    const objectName = `${this.fullPrefix(dirPath)}${safeName}/`;
    const url = `${this.apiBase}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-directory',
      },
      body: new Uint8Array(0),
    });
    if (!res.ok) {
      throw new Error(`GCS create folder failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }
}

// ────────────────────────────────────────────────────────────
// 2. Google Drive (API v3)
// ────────────────────────────────────────────────────────────

const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export class GoogleDriveAdapter implements RemoteStorageAdapter {
  private readonly apiBase: string;
  private readonly rootFolderId: string;
  private readonly folderNameCache = new Map<string, string>();

  constructor(
    private readonly config: StoredRemoteStorage,
    private readonly secret: string | undefined,
    private readonly fetchImpl: FetchLike,
  ) {
    this.apiBase = (config.endpoint || 'https://www.googleapis.com').replace(/\/+$/u, '');
    this.rootFolderId = config.rootPath?.trim() || 'root';
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await resolveGoogleAccessToken(this.secret, GDRIVE_SCOPE, this.fetchImpl);
    return { Authorization: `Bearer ${token}` };
  }

  /** dirPath 以 `id1/id2` 表示文件夹层级，空字符串代表根目录。 */
  private currentFolderId(dirPath: string): string {
    const norm = normalizeRelDir(dirPath);
    if (!norm) return this.rootFolderId;
    const parts = norm.split('/');
    return parts[parts.length - 1] ?? this.rootFolderId;
  }

  private buildBreadcrumbs(dirPath: string): RemoteStorageBreadcrumb[] {
    const crumbs: RemoteStorageBreadcrumb[] = [{ id: '', label: this.config.name || 'Google Drive' }];
    const norm = normalizeRelDir(dirPath);
    if (!norm) return crumbs;
    let acc = '';
    for (const seg of norm.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push({ id: acc, label: this.folderNameCache.get(seg) ?? seg });
    }
    return crumbs;
  }

  async test(): Promise<void> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/drive/v3/files?pageSize=1&fields=files(id)`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`Google Drive connection failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async list(dirPath: string, query?: string): Promise<RemoteListOutput> {
    const headers = await this.authHeaders();
    const normDir = normalizeRelDir(dirPath);
    const parentId = this.currentFolderId(normDir);
    const safeParent = parentId.replace(/'/gu, "\\'");
    const trimmedQuery = query?.trim() ?? '';
    const qParts = [`'${safeParent}' in parents`, 'trashed = false'];
    if (trimmedQuery) {
      const safeNeedle = trimmedQuery.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
      qParts.push(`name contains '${safeNeedle}'`);
    }

    const params = new URLSearchParams({
      q: qParts.join(' and '),
      fields: 'files(id,name,mimeType,size,modifiedTime)',
      pageSize: '200',
      orderBy: 'folder,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });

    const url = `${this.apiBase}/drive/v3/files?${params.toString()}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`Google Drive list failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
    const json = (await res.json()) as {
      files?: { id: string; name: string; mimeType?: string; size?: string; modifiedTime?: string }[];
    };

    const entries: RemoteFileEntry[] = (json.files ?? []).map((file) => {
      const isDir = file.mimeType === GDRIVE_FOLDER_MIME;
      if (isDir) {
        this.folderNameCache.set(file.id, file.name);
      }
      const size = file.size !== undefined ? Number(file.size) : undefined;
      const modifiedAt = file.modifiedTime ? Date.parse(file.modifiedTime) : undefined;
      return {
        id: file.id,
        name: file.name,
        path: isDir ? (normDir ? `${normDir}/${file.id}` : file.id) : (normDir ? `${normDir}/${file.name}` : file.name),
        kind: isDir ? 'directory' : 'file',
        ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
        ...(modifiedAt !== undefined && Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      };
    });

    return {
      dirPath: normDir,
      breadcrumbs: this.buildBreadcrumbs(normDir),
      items: sortEntries(entries),
    };
  }

  async read(entryId: string): Promise<RemoteReadOutput> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/drive/v3/files/${encodeURIComponent(entryId)}?alt=media&supportsAllDrives=true`;
    let res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok && (res.status === 403 || res.status === 400)) {
      // Google Docs/Sheets 等原生在线文档尝试导出为纯文本
      const exportUrl = `${this.apiBase}/drive/v3/files/${encodeURIComponent(entryId)}/export?mimeType=text%2Fplain`;
      const exported = await this.fetchImpl(exportUrl, { method: 'GET', headers });
      if (exported.ok) {
        res = exported;
      }
    }
    if (!res.ok) {
      throw new Error(`Google Drive download failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? undefined;
    return { bytes, ...(mimeType ? { mimeType } : {}) };
  }

  async upload(dirPath: string, name: string, bytes: Buffer, mimeType?: string): Promise<void> {
    const headers = await this.authHeaders();
    const safeName = sanitizeSegment(name);
    const parentId = this.currentFolderId(dirPath);
    const boundary = `halo_boundary_${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ name: safeName, parents: [parentId] });
    const partHeader = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
      'utf8',
    );
    const partFooter = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([partHeader, bytes, partFooter]);

    const url = `${this.apiBase}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      throw new Error(`Google Drive upload failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async delete(entryId: string): Promise<void> {
    const headers = await this.authHeaders();
    const url = `${this.apiBase}/drive/v3/files/${encodeURIComponent(entryId)}?supportsAllDrives=true`;
    const res = await this.fetchImpl(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Google Drive delete failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async mkdir(dirPath: string, name: string): Promise<void> {
    const headers = await this.authHeaders();
    const safeName = sanitizeSegment(name);
    const parentId = this.currentFolderId(dirPath);
    const url = `${this.apiBase}/drive/v3/files?supportsAllDrives=true`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: safeName,
        mimeType: GDRIVE_FOLDER_MIME,
        parents: [parentId],
      }),
    });
    if (!res.ok) {
      throw new Error(`Google Drive create folder failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }
}

// ────────────────────────────────────────────────────────────
// 3. WebDAV（通用协议：Nextcloud / Alist / 坚果云 / Synology 等）
// ────────────────────────────────────────────────────────────

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function extractXmlTag(block: string, localName: string): string | undefined {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${localName}>`, 'iu');
  const match = re.exec(block);
  if (!match?.[1]) return undefined;
  return decodeXmlEntities(match[1].trim());
}

/** 解析 WebDAV PROPFIND XML 响应，兼容不同命名空间前缀并过滤当前目录自身节点。 */
export function parseWebDavPropfindXml(
  xml: string,
  basePathname: string,
  currentDirPath: string,
): RemoteFileEntry[] {
  const normBase = basePathname.replace(/\/+$/u, '');
  const normCurrent = normalizeRelDir(currentDirPath);
  const currentFull = `${normBase}${normCurrent ? `/${normCurrent}` : ''}`.replace(/\/+$/u, '') || '/';

  const responses = xml.match(/<(?:[a-z0-9_-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[a-z0-9_-]+:)?response>/giu) ?? [];
  const entries: RemoteFileEntry[] = [];

  for (const block of responses) {
    const rawHref = extractXmlTag(block, 'href');
    if (!rawHref) continue;

    let pathname: string;
    try {
      pathname = rawHref.startsWith('http://') || rawHref.startsWith('https://')
        ? new URL(rawHref).pathname
        : rawHref;
    } catch {
      pathname = rawHref;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      decodedPath = pathname;
    }

    const cleanFull = decodedPath.replace(/\/+$/u, '') || '/';
    if (cleanFull === currentFull) continue;

    let relPath = cleanFull;
    if (normBase && cleanFull.startsWith(`${normBase}/`)) {
      relPath = cleanFull.slice(normBase.length + 1);
    } else if (cleanFull.startsWith('/')) {
      relPath = cleanFull.slice(1);
    }
    relPath = normalizeRelDir(relPath);
    if (!relPath) continue;

    const name = relPath.split('/').pop() ?? relPath;
    const resourceType = extractXmlTag(block, 'resourcetype') ?? '';
    const isDir = /<(?:[a-z0-9_-]+:)?collection\b/iu.test(resourceType) || decodedPath.endsWith('/');
    const rawSize = extractXmlTag(block, 'getcontentlength');
    const size = rawSize !== undefined ? Number(rawSize) : undefined;
    const rawMod = extractXmlTag(block, 'getlastmodified');
    const modifiedAt = rawMod ? Date.parse(rawMod) : undefined;
    const mimeType = extractXmlTag(block, 'getcontenttype');

    entries.push({
      id: relPath,
      name,
      path: relPath,
      kind: isDir ? 'directory' : 'file',
      ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
      ...(modifiedAt !== undefined && Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
      ...(mimeType ? { mimeType } : {}),
    });
  }

  return sortEntries(entries);
}

export class WebDavAdapter implements RemoteStorageAdapter {
  private readonly baseUrl: URL;
  private readonly rootPrefix: string;

  constructor(
    private readonly config: StoredRemoteStorage,
    private readonly secret: string | undefined,
    private readonly fetchImpl: FetchLike,
  ) {
    const rawEndpoint = config.endpoint?.trim() ?? '';
    if (!rawEndpoint) throw new Error('WebDAV endpoint URL is required');
    this.baseUrl = new URL(rawEndpoint.replace(/\/+$/u, ''));
    this.rootPrefix = normalizeRelDir(config.rootPath);
  }

  private authHeaders(): Record<string, string> {
    const secret = this.secret?.trim() ?? '';
    const username = this.config.username?.trim() ?? '';
    if (username) {
      const token = Buffer.from(`${username}:${secret}`, 'utf8').toString('base64');
      return { Authorization: `Basic ${token}` };
    }
    if (secret) {
      return {
        Authorization: /^(?:Basic|Bearer)\s+/iu.test(secret) ? secret : `Bearer ${secret}`,
      };
    }
    return {};
  }

  /** 返回解码后的逻辑基准路径（用于与 PROPFIND 解码后的 href 精确比对，避免中文/空格编码不匹配）。 */
  private basePathname(): string {
    let decodedEpPath: string;
    try {
      decodedEpPath = decodeURIComponent(this.baseUrl.pathname);
    } catch {
      decodedEpPath = this.baseUrl.pathname;
    }
    const epPath = decodedEpPath.replace(/\/+$/u, '');
    return this.rootPrefix ? `${epPath}/${this.rootPrefix}` : epPath;
  }

  private targetUrl(relPath: string, isDirectory = false): string {
    const baseSegs = this.basePathname().split('/').filter(Boolean);
    const relSegs = normalizeRelDir(relPath).split('/').filter(Boolean);
    const encodedPath = [...baseSegs, ...relSegs].map((seg) => encodeURIComponent(seg)).join('/');
    const joined = encodedPath ? `${this.baseUrl.origin}/${encodedPath}` : this.baseUrl.origin;
    return isDirectory ? `${joined}/` : joined;
  }

  async test(): Promise<void> {
    const res = await this.fetchImpl(this.targetUrl('', true), {
      method: 'PROPFIND',
      headers: {
        ...this.authHeaders(),
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV connection failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async list(dirPath: string, query?: string): Promise<RemoteListOutput> {
    const normDir = normalizeRelDir(dirPath);
    const res = await this.fetchImpl(this.targetUrl(normDir, true), {
      method: 'PROPFIND',
      headers: {
        ...this.authHeaders(),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV list failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
    const xml = await res.text();
    const all = parseWebDavPropfindXml(xml, this.basePathname(), normDir);
    const needle = query?.trim().toLowerCase() ?? '';
    const filtered = needle
      ? all.filter((e) => e.name.toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle))
      : all;

    return {
      dirPath: normDir,
      breadcrumbs: buildPathBreadcrumbs(this.config.name || this.baseUrl.host, normDir),
      items: filtered,
    };
  }

  async read(entryId: string): Promise<RemoteReadOutput> {
    const res = await this.fetchImpl(this.targetUrl(entryId, false), {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`WebDAV download failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? undefined;
    return { bytes, ...(mimeType ? { mimeType } : {}) };
  }

  async upload(dirPath: string, name: string, bytes: Buffer, mimeType?: string): Promise<void> {
    const safeName = sanitizeSegment(name);
    const normDir = normalizeRelDir(dirPath);
    const rel = normDir ? `${normDir}/${safeName}` : safeName;
    const res = await this.fetchImpl(this.targetUrl(rel, false), {
      method: 'PUT',
      headers: {
        ...this.authHeaders(),
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV upload failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async delete(entryId: string, _path: string, kind: 'file' | 'directory'): Promise<void> {
    const res = await this.fetchImpl(this.targetUrl(entryId, kind === 'directory'), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(`WebDAV delete failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }

  async mkdir(dirPath: string, name: string): Promise<void> {
    const safeName = sanitizeSegment(name);
    const normDir = normalizeRelDir(dirPath);
    const rel = normDir ? `${normDir}/${safeName}` : safeName;
    const res = await this.fetchImpl(this.targetUrl(rel, true), {
      method: 'MKCOL',
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 201 && res.status !== 405) {
      throw new Error(`WebDAV create folder failed (${res.status}): ${await readErrorSnippet(res)}`);
    }
  }
}

export function createRemoteStorageAdapter(
  config: StoredRemoteStorage,
  secret: string | undefined,
  fetchImpl: FetchLike,
): RemoteStorageAdapter {
  switch (config.kind) {
    case 'google-cloud-storage':
      return new GoogleCloudStorageAdapter(config, secret, fetchImpl);
    case 'google-drive':
      return new GoogleDriveAdapter(config, secret, fetchImpl);
    case 'webdav':
      return new WebDavAdapter(config, secret, fetchImpl);
  }
}

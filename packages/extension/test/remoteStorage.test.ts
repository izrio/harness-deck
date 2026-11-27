import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToWebview } from '@harness-deck/shared';
import type { HostPlatform, KeyValueStore, SecretStore } from '../src/host/HostPlatform.ts';
import { createHarnessHostRuntime } from '../src/host/HarnessHostRuntime.ts';
import type { FetchLike } from '../src/providers/proxyFetch.ts';
import {
  GoogleCloudStorageAdapter,
  GoogleDriveAdapter,
  WebDavAdapter,
  parseWebDavPropfindXml,
  signGoogleServiceAccountJwt,
} from '../src/storage/RemoteStorageClient.ts';
import { RemoteStorageStore } from '../src/storage/RemoteStorageStore.ts';
import {
  probeGcloudAuth,
  startGoogleLoopbackOAuth,
} from '../src/storage/GoogleStorageAuth.ts';
import { noWorkbench } from '../src/vm/workbench.ts';

class MemoryKVStore implements KeyValueStore {
  readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }
}

class MemorySecretStore implements SecretStore {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  onDidChange(): () => void {
    return () => undefined;
  }
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

describe('RemoteStorageStore 凭据隔离存储', () => {
  it('元数据落 globalState，Service Account 私钥仅落 SecretStore 并提取 client_email', async () => {
    const kv = new MemoryKVStore();
    const secrets = new MemorySecretStore();
    const store = new RemoteStorageStore(kv, secrets, () => 1_700_000_000_000);

    const saJson = JSON.stringify({
      type: 'service_account',
      client_email: 'halo-bot@demo-project.iam.gserviceaccount.com',
      private_key: 'PRIVATE_KEY_SECRET_VALUE',
    });

    const saved = await store.upsert({
      name: 'GCS Workspace',
      kind: 'google-cloud-storage',
      bucket: 'my-halo-bucket',
      rootPath: 'projects',
      secret: saJson,
    });

    expect(saved.username).toBe('halo-bot@demo-project.iam.gserviceaccount.com');
    expect(JSON.stringify(kv.get('harnessDeck.remoteStorages'))).not.toContain('PRIVATE_KEY_SECRET_VALUE');
    expect(await store.getSecret(saved.id)).toBe(saJson);
    expect(store.toState().items[0]).toMatchObject({
      id: saved.id,
      name: 'GCS Workspace',
      bucket: 'my-halo-bucket',
      hasSecret: true,
    });

    await store.remove(saved.id);
    expect(store.list()).toHaveLength(0);
    expect(await store.getSecret(saved.id)).toBeUndefined();
  });

  it('编辑 WebDAV 存储时允许清空 username，不残留旧用户名', async () => {
    const kv = new MemoryKVStore();
    const secrets = new MemorySecretStore();
    const store = new RemoteStorageStore(kv, secrets);

    const created = await store.upsert({
      name: 'My WebDAV',
      kind: 'webdav',
      endpoint: 'https://dav.example.com/dav',
      username: 'alice',
      secret: 'pw',
    });
    expect(created.username).toBe('alice');

    const updated = await store.upsert({
      id: created.id,
      name: 'My WebDAV',
      kind: 'webdav',
      endpoint: 'https://dav.example.com/dav',
    });
    expect(updated.username).toBeUndefined();
  });
});

describe('Google Service Account JWT 签发与 GCS 适配器', () => {
  it('使用原生 RS256 签发可验签的 JWT', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const jwt = signGoogleServiceAccountJwt({
      clientEmail: 'svc@proj.iam.gserviceaccount.com',
      privateKey,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      nowSec: 1_700_000_000,
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const verify = createVerify('RSA-SHA256');
    verify.update(`${parts[0]}.${parts[1]}`);
    verify.end();
    const sig = Buffer.from(parts[2]!.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
    expect(verify.verify(publicKey, sig)).toBe(true);
  });

  it('GCS 支持列目录、读取、上传、建目录与删除', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body });

      if (method === 'GET' && url.includes('/storage/v1/b/demo-bucket/o?')) {
        return new Response(
          JSON.stringify({
            prefixes: ['root/docs/'],
            items: [
              { name: 'root/', size: '0' },
              { name: 'root/notes.md', size: '128', updated: '2026-11-27T01:00:00Z', contentType: 'text/markdown' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'GET' && url.includes('alt=media')) {
        return new Response('# Hello GCS', { status: 200, headers: { 'Content-Type': 'text/markdown' } });
      }
      return new Response('{}', { status: 200 });
    };

    const adapter = new GoogleCloudStorageAdapter(
      { id: 's1', name: 'My GCS', kind: 'google-cloud-storage', bucket: 'demo-bucket', rootPath: 'root', createdAt: 1 },
      'ya29.test-token',
      mockFetch,
    );

    const listed = await adapter.list('');
    expect(listed.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['directory:docs', 'file:notes.md']);
    expect(listed.breadcrumbs).toEqual([{ id: '', label: 'My GCS' }]);

    const content = await adapter.read('root/notes.md');
    expect(content.bytes.toString('utf8')).toBe('# Hello GCS');

    await adapter.upload('docs', 'hello.txt', Buffer.from('hi'), 'text/plain');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('name=root%2Fdocs%2Fhello.txt'))).toBe(true);

    await adapter.mkdir('', 'assets');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('name=root%2Fassets%2F'))).toBe(true);

    await adapter.delete('root/notes.md', 'notes.md', 'file');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('root%2Fnotes.md'))).toBe(true);
  });
});

describe('Google Drive 适配器', () => {
  it('支持列出文件与文件夹、上传 multipart、新建目录与删除', async () => {
    const calls: { method: string; url: string }[] = [];
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (method === 'GET' && url.includes('/drive/v3/files?')) {
        return new Response(
          JSON.stringify({
            files: [
              { id: 'fld1', name: 'Colab', mimeType: 'application/vnd.google-apps.folder' },
              { id: 'file1', name: 'todo.md', mimeType: 'text/markdown', size: '42' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'GET' && url.includes('alt=media')) {
        return new Response('drive content', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response(JSON.stringify({ id: 'new-id' }), { status: 200 });
    };

    const adapter = new GoogleDriveAdapter(
      { id: 'd1', name: 'My Drive', kind: 'google-drive', createdAt: 1 },
      'ya29.drive-token',
      mockFetch,
    );

    const listed = await adapter.list('');
    expect(listed.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['directory:Colab', 'file:todo.md']);

    const readRes = await adapter.read('file1');
    expect(readRes.bytes.toString('utf8')).toBe('drive content');

    await adapter.upload('fld1', 'app.ts', Buffer.from('export const x = 1;'));
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('uploadType=multipart'))).toBe(true);

    await adapter.mkdir('fld1', 'sub');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/drive/v3/files?'))).toBe(true);

    await adapter.delete('file1');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/drive/v3/files/file1'))).toBe(true);
  });
});

describe('WebDAV XML 解析与适配器', () => {
  it('正确解析 PROPFIND XML 并跳过当前目录自身条目', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/dav/work/</D:href>
          <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/work/notes%201.md</D:href>
          <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>512</D:getcontentlength><D:getcontenttype>text/markdown</D:getcontenttype></D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/work/src/</D:href>
          <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
        </D:response>
      </D:multistatus>`;

    const entries = parseWebDavPropfindXml(xml, '/dav', 'work');
    expect(entries).toEqual([
      { id: 'work/src', name: 'src', path: 'work/src', kind: 'directory' },
      { id: 'work/notes 1.md', name: 'notes 1.md', path: 'work/notes 1.md', kind: 'file', size: 512, mimeType: 'text/markdown' },
    ]);
  });

  it('WebDavAdapter 执行 PROPFIND / PUT / GET / MKCOL / DELETE 并携带 Basic 认证头', async () => {
    const authHeaders: string[] = [];
    const mockFetch: FetchLike = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization) authHeaders.push(headers.Authorization);
      if (init?.method === 'PROPFIND') {
        return new Response(
          `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></D:prop></d:propstat></d:response></d:multistatus>`,
          { status: 207 },
        );
      }
      if (init?.method === 'GET') {
        return new Response('dav-bytes', { status: 200 });
      }
      return new Response('', { status: 201 });
    };

    const adapter = new WebDavAdapter(
      { id: 'w1', name: 'NAS', kind: 'webdav', endpoint: 'https://nas.example.com/dav', username: 'alice', createdAt: 1 },
      's3cr3t',
      mockFetch,
    );

    await adapter.test();
    await adapter.upload('', 'a.txt', Buffer.from('abc'));
    await adapter.mkdir('', 'dir1');
    const data = await adapter.read('a.txt');
    expect(data.bytes.toString('utf8')).toBe('dav-bytes');
    await adapter.delete('a.txt', 'a.txt', 'file');
    expect(authHeaders[0]).toBe(`Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`);
  });

  it('WebDavAdapter 在端点含中文/百分号编码路径时正确解码并过滤自身节点', async () => {
    const requestedUrls: string[] = [];
    const mockFetch: FetchLike = async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        `<D:multistatus xmlns:D="DAV:">
          <D:response>
            <D:href>/dav/%E6%96%87%E6%A1%A3/</D:href>
            <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
          </D:response>
          <D:response>
            <D:href>/dav/%E6%96%87%E6%A1%A3/%E7%AC%94%E8%AE%B0.md</D:href>
            <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>12</D:getcontentlength></D:prop></D:propstat>
          </D:response>
        </D:multistatus>`,
        { status: 207 },
      );
    };

    const adapter = new WebDavAdapter(
      { id: 'w2', name: '中文盘', kind: 'webdav', endpoint: 'https://nas.example.com/dav/%E6%96%87%E6%A1%A3', createdAt: 1 },
      undefined,
      mockFetch,
    );
    const listed = await adapter.list('');
    expect(requestedUrls[0]).toBe('https://nas.example.com/dav/%E6%96%87%E6%A1%A3/');
    expect(listed.items).toEqual([{ id: '笔记.md', name: '笔记.md', path: '笔记.md', kind: 'file', size: 12 }]);
  });
});

describe('HarnessHostRuntime 本地文件操作安全边界', () => {
  it('允许工作区内新建目录、上传与删除，并拒绝目录穿越删除', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'halo-ws-files-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'halo-outside-'));
    const outsideFile = join(outsideDir, 'keep.txt');
    await writeFile(outsideFile, 'must-stay', 'utf8');
    cleanups.push(async () => {
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });

    const posted: HostToWebview[] = [];
    const actions: Promise<void>[] = [];
    let resolveNextAction: ((msg: HostToWebview) => void) | undefined;
    const waitNext = () =>
      new Promise<HostToWebview>((resolve) => {
        resolveNextAction = resolve;
      });

    const kv = new MemoryKVStore();
    const secrets = new MemorySecretStore();
    const settingsMap = new Map<string, unknown>();
    const platform: HostPlatform = {
      hostKind: 'vscode',
      extensionVersion: '0.19.0',
      storageRoot: workspaceDir,
      globalState: kv,
      workspaceState: new MemoryKVStore(),
      settings: {
        get: <T>(key: string, fallback: T): T => (settingsMap.has(key) ? (settingsMap.get(key) as T) : fallback),
        update: async (key: string, value: unknown) => {
          if (value === undefined) settingsMap.delete(key);
          else settingsMap.set(key, value);
        },
        getHttpProxy: () => undefined,
        onDidChange: () => () => undefined,
      },
      secrets,
      workbench: noWorkbench,
      envLanguage: () => 'zh-cn',
      isWorkspaceTrusted: () => true,
      onDidGrantWorkspaceTrust: () => () => undefined,
      isWindowFocused: () => true,
      workspaceFolders: () => [{ name: 'ws', path: workspaceDir }],
      postToWebview: (msg) => {
        posted.push(msg);
        if (msg.type === 'remoteFileActionDone' || msg.type === 'toast') {
          resolveNextAction?.(msg);
          resolveNextAction = undefined;
        }
      },
      isWebviewVisible: () => true,
      focusChatView: async () => undefined,
      openWorkbenchPanel: () => undefined,
      log: () => undefined,
      runtimeLog: () => undefined,
      showLogs: () => undefined,
      openHostSettings: () => undefined,
      onStatusUpdate: () => undefined,
      openExternal: async () => true,
      resolveExternalOrigin: async (o) => o,
      writeClipboard: async () => undefined,
      showMessage: async () => undefined,
      pickQuickItem: async () => undefined,
      withCancellableProgress: async (_title, task) => task(() => undefined),
      pickOpenDialog: async () => [],
      openProjectWindow: async () => undefined,
      runInTerminal: async () => undefined,
    };

    const runtime = createHarnessHostRuntime(platform, { remoteBindHost: '127.0.0.1' });
    cleanups.push(() => runtime.dispose());

    const pUpload = waitNext();
    runtime.handleWebviewMessage({
      type: 'uploadLocalFiles',
      payload: { files: [{ name: 'demo.txt', dataBase64: Buffer.from('hello-ws').toString('base64') }] },
    });
    await pUpload;
    expect(await readFile(join(workspaceDir, 'demo.txt'), 'utf8')).toBe('hello-ws');

    // 尝试目录穿越删除工作区外文件必须被拦截
    const pDenied = waitNext();
    runtime.handleWebviewMessage({
      type: 'deleteLocalFile',
      payload: { path: outsideFile, kind: 'file' },
    });
    const deniedMsg = await pDenied;
    expect(deniedMsg.type).toBe('toast');
    expect(await readFile(outsideFile, 'utf8')).toBe('must-stay');

    // 尝试通过工作区内指向外部目录的符号链接建目录或上传文件，也必须被 realpath 校验拦截
    await symlink(outsideDir, join(workspaceDir, 'escape-link'));
    const pMkdirDenied = waitNext();
    runtime.handleWebviewMessage({
      type: 'createLocalFolder',
      payload: { dirPath: 'escape-link', name: 'evil-dir' },
    });
    const mkdirDenied = await pMkdirDenied;
    expect(mkdirDenied.type).toBe('toast');
    await expect(readFile(join(outsideDir, 'evil-dir'))).rejects.toThrow();

    const pUploadDenied = waitNext();
    runtime.handleWebviewMessage({
      type: 'uploadLocalFiles',
      payload: {
        dirPath: 'escape-link',
        files: [{ name: 'evil.txt', dataBase64: Buffer.from('nope').toString('base64') }],
      },
    });
    const uploadDenied = await pUploadDenied;
    expect(uploadDenied.type).toBe('toast');
    await expect(readFile(join(outsideDir, 'evil.txt'))).rejects.toThrow();

    // 工作区内删除正常执行
    const pDeleted = waitNext();
    runtime.handleWebviewMessage({
      type: 'deleteLocalFile',
      payload: { path: 'demo.txt', kind: 'file' },
    });
    await pDeleted;
    await expect(readFile(join(workspaceDir, 'demo.txt'), 'utf8')).rejects.toThrow();
    expect(actions).toHaveLength(0);
    expect(posted.length).toBeGreaterThan(0);
  });
});

describe('GoogleStorageAuth 一键浏览器 OAuth PKCE 回环与 gcloud ADC 探测', () => {
  it('启动 127.0.0.1 回调服务、校验 state、换取 refresh_token 并读取账号邮箱', async () => {
    let openedUrl = '';
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes('/token')) {
        const body = String(init?.body ?? '');
        expect(body).toContain('code=auth_code_xyz');
        expect(body).toContain('code_verifier=');
        return new Response(
          JSON.stringify({
            access_token: 'ya29.fresh_access',
            refresh_token: '1//fresh_refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({ email: 'dev@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const handle = await startGoogleLoopbackOAuth({
      kind: 'google-drive',
      clientId: 'demo-client.apps.googleusercontent.com',
      openExternal: async (url) => {
        openedUrl = url;
        return true;
      },
      fetchImpl: mockFetch,
    });
    cleanups.push(() => handle.cancel());

    const authParsed = new URL(openedUrl);
    expect(authParsed.hostname).toBe('accounts.google.com');
    const redirectUri = authParsed.searchParams.get('redirect_uri')!;
    const state = authParsed.searchParams.get('state')!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);

    // 模拟浏览器完成 Google 登录后跳回本地回调地址
    const cbRes = await fetch(`${redirectUri}?code=auth_code_xyz&state=${encodeURIComponent(state)}`);
    expect(cbRes.status).toBe(200);
    const html = await cbRes.text();
    expect(html).toContain('dev@example.com');

    const result = await handle.promise;
    expect(result.email).toBe('dev@example.com');
    expect(JSON.parse(result.secretJson)).toMatchObject({
      client_id: 'demo-client.apps.googleusercontent.com',
      refresh_token: '1//fresh_refresh',
      access_token: 'ya29.fresh_access',
    });
  });

  it('probeGcloudAuth 只读探测本地 ADC 凭据文件是否就绪', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'halo-adc-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const adcFile = join(dir, 'adc.json');
    await writeFile(
      adcFile,
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'c',
        client_secret: 's',
        refresh_token: 'r',
      }),
      'utf8',
    );

    const probe = await probeGcloudAuth({
      adcPath: adcFile,
      checkGcloud: async () => true,
    });
    expect(probe).toEqual({ gcloudAvailable: true, adcReady: true, adcPath: adcFile });
  });
});

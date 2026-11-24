import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { HostSnapshot, HostToWebview, WebviewToHost } from '@harness-deck/shared';
import { ClientHub } from '../src/host/ClientHub.ts';
import type { KeyValueStore } from '../src/host/HostPlatform.ts';
import { DeviceAuthStore, parseCookieHeader } from '../src/remote/DeviceAuthStore.ts';
import {
  buildWslPortProxyCommand,
  hasMatchingPortProxyRule,
  listLanInterfaces,
  mergeLanInterfaces,
  parseWindowsIpconfigOutput,
  parseWindowsPortProxyV4,
} from '../src/remote/NetworkInterfaces.ts';
import { PairingManager } from '../src/remote/PairingManager.ts';
import {
  buildVapidAuthorizationHeader,
  encryptWebPushPayload,
  formatWebhookRequest,
  generateVapidKeys,
  PushService,
} from '../src/remote/PushService.ts';
import { RemoteBridgeServer } from '../src/remote/RemoteBridgeServer.ts';
import { authorizeRemoteMessage, isAllowedHostHeader, isAllowedOriginHeader } from '../src/remote/ScopeGuard.ts';
import { configureTailscaleServe, normalizeTunnelUrl, parseTailscaleStatusJson, probeTailscaleStatus } from '../src/remote/TailscaleService.ts';
import { buildMobileDiffContent, buildMobileFileContent } from '../src/remote/mobileDiff.ts';
import { readHeadlessServerStatus, runHeadlessServer } from '../src/sidecar/headlessServer.ts';

class MemoryKVStore implements KeyValueStore {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
  }
}

function makeMinimalSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1.0.0', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 't1', title: 'S1', running: false }], active: 't1' },
    session: { title: 'S1', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: { items: [{ id: 'dsh', name: 'DeepSeek', kind: 'dsh' }], active: 'dsh' },
    ...overrides,
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
}

function nextJsonMessage<T = unknown>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(raw.toString()) as T);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before message'));
    };
    const cleanup = () => {
      ws.off('message', onMsg);
      ws.off('close', onClose);
    };
    ws.on('message', onMsg);
    ws.on('close', onClose);
  });
}

function waitForClose(ws: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('HD-22 ClientHub 单播与广播隔离', () => {
  it('区分 IDE 与 mobile-web 客户端，单播不干扰其他客户端且剥离 mobile-web 快照里的配对码', () => {
    const ideMsgs: HostToWebview[] = [];
    const mobileMsgs: HostToWebview[] = [];
    let remoteChanges = 0;

    const hub = new ClientHub({
      hostKind: 'vscode',
      postToIde: (m) => ideMsgs.push(m),
      isIdeVisible: () => false,
      onRemoteClientsChanged: () => {
        remoteChanges += 1;
      },
    });

    const unregister = hub.registerClient({
      id: 'remote:dev1:c1',
      surface: 'mobile-web',
      scope: 'operate',
      deviceId: 'dev1',
      visible: true,
      send: (m) => mobileMsgs.push(m),
    });

    expect(remoteChanges).toBe(1);
    expect(hub.remoteClientCount()).toBe(1);
    expect(hub.isAnyClientVisible()).toBe(true);

    const snap = makeMinimalSnapshot({
      remote: {
        enabled: true,
        running: true,
        bindHost: '0.0.0.0',
        interfaces: [],
        scope: 'operate',
        connectedClients: 1,
        devices: [],
        pairing: {
          url: 'http://192.168.1.2:8080/pair#code=secret',
          code: 'secret',
          scope: 'operate',
          expiresAt: 9999999,
          routeKind: 'lan',
        },
      },
    });

    hub.sendTo('remote:dev1:c1', { type: 'snapshot', payload: snap });
    expect(ideMsgs).toHaveLength(0);
    expect(mobileMsgs).toHaveLength(1);
    const stamped = mobileMsgs[0]!;
    expect(stamped.type).toBe('snapshot');
    if (stamped.type === 'snapshot') {
      expect(stamped.payload.clientSurface).toBe('mobile-web');
      expect(stamped.payload.clientScope).toBe('operate');
      expect(stamped.payload.remote?.pairing).toBeUndefined();
    }

    hub.broadcast({ type: 'toast', payload: { level: 'info', text: 'hello' } });
    expect(ideMsgs).toHaveLength(1);
    expect(mobileMsgs).toHaveLength(2);

    unregister();
    expect(hub.remoteClientCount()).toBe(0);
  });
});

describe('HD-23 PairingManager / DeviceAuthStore / ScopeGuard / NetworkInterfaces', () => {
  it('PairingManager 支持 5 分钟有效期、单次使用作废及 5 次失败自动锁定', () => {
    let now = 10_000;
    const pm = new PairingManager(() => now);
    const view = pm.generate({ scope: 'operate', baseUrl: 'http://192.168.1.10:5000/', routeKind: 'lan' });
    expect(view.url).toBe(`http://192.168.1.10:5000/pair#code=${view.code}`);

    for (let i = 0; i < 4; i += 1) {
      const fail = pm.verify('wrong');
      expect(fail).toEqual({ ok: false, reason: 'invalid', remainingAttempts: 4 - i });
    }
    expect(pm.verify('wrong')).toEqual({ ok: false, reason: 'locked', remainingAttempts: 0 });
    expect(pm.verify(view.code)).toEqual({ ok: false, reason: 'missing' });

    const view2 = pm.generate({ scope: 'read-only', baseUrl: 'http://192.168.1.10:5000', routeKind: 'lan', ttlMs: 1_000 });
    expect(pm.verify(view2.code)).toEqual({ ok: true, scope: 'read-only', routeKind: 'lan' });
    expect(pm.verify(view2.code)).toEqual({ ok: false, reason: 'missing' });

    const view3 = pm.generate({ scope: 'operate', baseUrl: 'http://192.168.1.10:5000', routeKind: 'lan', ttlMs: 100 });
    now += 200;
    expect(pm.verify(view3.code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('DeviceAuthStore 只存哈希并支持 Cookie 校验与设备吊销', async () => {
    const kv = new MemoryKVStore();
    const store = new DeviceAuthStore(kv, () => 1_000);
    const { device, cookieValue } = await store.issueDevice('iPhone', 'operate');

    expect(device.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(cookieValue).not.toContain(device.tokenHash);
    expect(store.verifyCookie(cookieValue)?.id).toBe(device.id);
    expect(store.verifyCookie(`${device.id}.bad`)).toBeUndefined();

    const parsed = parseCookieHeader(`foo=1; hd_device_session=${encodeURIComponent(cookieValue)}`);
    expect(parsed.hd_device_session).toBe(cookieValue);

    expect(await store.revokeDevice(device.id)).toBe(true);
    expect(store.verifyCookie(cookieValue)).toBeUndefined();
  });

  it('ScopeGuard 校验 Host/Origin 与 read-only / operate 权限边界', () => {
    const hosts = new Set(['192.168.1.5', 'localhost']);
    expect(isAllowedHostHeader('192.168.1.5:8080', hosts)).toBe(true);
    expect(isAllowedHostHeader('evil.example.com:8080', hosts)).toBe(false);
    expect(isAllowedOriginHeader('http://192.168.1.5:8080', hosts)).toBe(true);
    expect(isAllowedOriginHeader('https://evil.example.com', hosts)).toBe(false);

    expect(authorizeRemoteMessage('read-only', { type: 'ready', payload: {} }).ok).toBe(true);
    expect(authorizeRemoteMessage('read-only', { type: 'sendMessage', payload: { text: 'hi' } }).ok).toBe(false);
    expect(authorizeRemoteMessage('operate', { type: 'sendMessage', payload: { text: 'hi' } }).ok).toBe(true);
    expect(authorizeRemoteMessage('operate', { type: 'installBackend', payload: { id: 'pi' } }).ok).toBe(false);
    expect(authorizeRemoteMessage('operate', { type: 'setPreferences', payload: { advanced: { backendTrace: true } } }).ok).toBe(false);
  });

  it('NetworkInterfaces 过滤 Docker / WSL 虚拟网卡并优先私有 LAN IP', () => {
    const result = listLanInterfaces({
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null }],
      eth0: [{ address: '192.168.1.88', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null }],
    });
    expect(result.preferredAddress).toBe('192.168.1.88');
    expect(result.candidates).toEqual([{ name: 'eth0', address: '192.168.1.88' }]);
  });

  it('WSL 环境下解析 Windows ipconfig（中英文）与 portproxy，并优先使用 Windows 宿主机局域网 IP', () => {
    const zhIpconfig = `
Windows IP 配置

以太网适配器 以太网:

   连接特定的 DNS 后缀 . . . . . . . :
   本地链接 IPv6 地址. . . . . . . . : fe80::59ac:2662:993f:619a%6
   IPv4 地址 . . . . . . . . . . . . : 192.168.100.32
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 192.168.100.251

以太网适配器 vEthernet (WSL (Hyper-V firewall)):

   IPv4 地址 . . . . . . . . . . . . : 172.21.144.1
   子网掩码  . . . . . . . . . . . . : 255.255.240.0
   默认网关. . . . . . . . . . . . . :
`;
    const winIfaces = parseWindowsIpconfigOutput(zhIpconfig);
    expect(winIfaces).toEqual([{ name: '以太网', address: '192.168.100.32', hasGateway: true }]);

    const enIpconfig = `
Windows IP Configuration

Ethernet adapter HostOnly:
   IPv4 Address. . . . . . . . . . . : 10.0.50.2
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . :

Wireless LAN adapter Wi-Fi:
   IPv4 Address. . . . . . . . . . . : 192.168.1.45
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1
`;
    expect(parseWindowsIpconfigOutput(enIpconfig)[0]).toEqual({
      name: 'Wi-Fi',
      address: '192.168.1.45',
      hasGateway: true,
    });

    // WSL2 NAT 模式：Windows LAN IP 优先于 WSL 内部 eth0
    const natMerged = mergeLanInterfaces(
      {
        eth0: [{ address: '172.21.154.63', netmask: '255.255.240.0', family: 'IPv4', mac: '00:15:5d:28:71:c9', internal: false, cidr: null }],
      },
      winIfaces,
    );
    expect(natMerged.preferredAddress).toBe('192.168.100.32');
    expect(natMerged.candidates).toEqual([
      { name: 'Windows · 以太网', address: '192.168.100.32' },
      { name: 'WSL · eth0', address: '172.21.154.63' },
    ]);
    expect(natMerged.localAddresses.has('192.168.100.32')).toBe(false);
    expect(natMerged.wslAddress).toBe('172.21.154.63');

    // WSL2 Mirrored 模式：Windows LAN IP 已在 Linux 网卡中，自动去重且直接作为本机地址
    const mirroredMerged = mergeLanInterfaces(
      {
        eth0: [{ address: '192.168.100.32', netmask: '255.255.255.0', family: 'IPv4', mac: '00:15:5d:28:71:c9', internal: false, cidr: null }],
      },
      winIfaces,
    );
    expect(mirroredMerged.candidates).toEqual([{ name: '以太网', address: '192.168.100.32' }]);
    expect(mirroredMerged.localAddresses.has('192.168.100.32')).toBe(true);

    // portproxy 规则解析与匹配
    const rules = parseWindowsPortProxyV4(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         37890       172.21.154.63   37890
`);
    expect(rules).toEqual([
      { listenAddress: '0.0.0.0', listenPort: 37890, connectAddress: '172.21.154.63', connectPort: 37890 },
    ]);
    expect(hasMatchingPortProxyRule(rules, 37890, '172.21.154.63', '192.168.100.32')).toBe(true);
    expect(hasMatchingPortProxyRule(rules, 37891, '172.21.154.63', '192.168.100.32')).toBe(false);
    expect(buildWslPortProxyCommand(37890, '172.21.154.63')).toContain('connectaddress=172.21.154.63');
  });

  it('RemoteBridgeServer 在 WSL2 NAT 下生成 Windows LAN 配对地址、放行对应 Host 并支持刷新 portproxy 状态', async () => {
    const kv = new MemoryKVStore();
    const hub = new ClientHub({
      hostKind: 'vscode',
      postToIde: () => undefined,
      isIdeVisible: () => false,
    });
    const deviceAuth = new DeviceAuthStore(kv);
    const pushService = new PushService(kv, deviceAuth, { isWindowFocused: () => false, log: () => undefined });

    let portProxyReady = false;
    let listeningPort = 37890;
    const bridge: RemoteBridgeServer = new RemoteBridgeServer({
      hostKind: 'vscode',
      globalState: kv,
      clientHub: hub,
      deviceAuth,
      pushService,
      port: 0,
      bindHost: '0.0.0.0',
      locale: () => 'zh',
      onWebviewMessage: () => undefined,
      onStateChange: () => undefined,
      log: () => undefined,
      wslNetworkProbe: async () => ({
        windowsInterfaces: [{ name: '以太网', address: '192.168.100.32', hasGateway: true }],
        portProxyRules: portProxyReady
          ? [
              {
                listenAddress: '0.0.0.0',
                listenPort: listeningPort,
                connectAddress: '127.0.0.1',
                connectPort: listeningPort,
              },
            ]
          : [],
      }),
    });

    const getHealthStatus = (hostHeader: string, port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { Host: hostHeader } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.once('error', reject);
        req.end();
      });

    try {
      const state = await bridge.generatePairing({ routeKind: 'lan', scope: 'operate' });
      listeningPort = state.port ?? 37890;
      expect(state.selectedHost).toBe('192.168.100.32');
      expect(state.pairing?.url).toMatch(/^http:\/\/192\.168\.100\.32:\d+\/pair#code=/u);
      expect(state.wslNat?.active).toBe(true);
      expect(state.wslNat?.windowsAddress).toBe('192.168.100.32');
      expect(state.wslNat?.portProxyConfigured).toBe(false);
      expect(state.wslNat?.setupCommand).toContain(`listenport=${state.port}`);

      // Host 校验必须放行 Windows 宿主机 LAN IP，且仍拒绝伪造 Host
      expect(await getHealthStatus(`192.168.100.32:${listeningPort}`, listeningPort)).toBe(200);
      expect(await getHealthStatus(`evil.example.com:${listeningPort}`, listeningPort)).toBe(403);

      // 配置完 portproxy 后点击刷新，状态转为就绪
      portProxyReady = true;
      const refreshed = await bridge.refreshNetwork(false);
      expect(refreshed.wslNat?.portProxyConfigured).toBe(true);
    } finally {
      await bridge.stop();
    }
  });
});

describe('HD-25 mobileDiff', () => {
  it('构建 pair 与只读文件预览，超出 2000 行时截断', async () => {
    const diff = await buildMobileDiffContent(
      {
        kind: 'contents',
        path: 'src/app.ts',
        before: 'const a = 1;\n',
        after: 'const a = 2;\nconst b = 3;\n',
        created: false,
        scope: 'turn',
      },
      async () => undefined,
    );
    expect(diff.kind).toBe('pair');
    expect(diff.language).toBe('typescript');
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);

    const bigText = Array.from({ length: 2_100 }, (_, i) => `line ${i}`).join('\n');
    const fileView = buildMobileFileContent('README.md', bigText);
    expect(fileView.kind).toBe('file');
    expect(fileView.truncated).toBe(true);
    expect(fileView.readonly).toBe(true);
  });
});

describe('HD-26 TailscaleService', () => {
  it('解析 tailscale status --json 并处理 ENOENT / serve 配置失败回退命令', async () => {
    const parsed = parseTailscaleStatusJson(
      JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'devbox.tailnet.ts.net.' } }),
      JSON.stringify({ Web: { 'devbox.tailnet.ts.net:443': {} } }),
    );
    expect(parsed).toEqual({
      installed: true,
      loggedIn: true,
      dnsName: 'devbox.tailnet.ts.net',
      serveUrl: 'https://devbox.tailnet.ts.net',
      serveEnabled: true,
    });

    const missing = await probeTailscaleStatus(async () => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(missing).toEqual({ installed: false, loggedIn: false });

    const permDenied = await configureTailscaleServe(8443, true, async () => {
      throw new Error('permission denied');
    });
    expect(permDenied.ok).toBe(false);
    expect(permDenied.manualCommand).toBe('tailscale serve --bg http://127.0.0.1:8443');

    expect(normalizeTunnelUrl('https://deck.example.com/path')).toBe('https://deck.example.com');
    expect(normalizeTunnelUrl('http://insecure.example.com')).toBeUndefined();
  });
});

describe('HD-27 PushService', () => {
  it('生成 VAPID 密钥、RFC 8291/8292 加密推送、Webhook 模板、焦点抑制与 410 清理', async () => {
    const kv = new MemoryKVStore();
    const devices = new DeviceAuthStore(kv);
    const { device } = await devices.issueDevice('Pixel', 'operate');
    // 生成合法 P-256 客户端订阅密钥
    const clientVapid = generateVapidKeys();
    await devices.setPushSubscription(device.id, {
      endpoint: 'https://push.example.test/sub/1',
      keys: {
        p256dh: clientVapid.publicKey,
        auth: Buffer.from('0123456789abcdef').toString('base64url'),
      },
    });

    const calls: { url: string; method?: string; headers?: Record<string, string> }[] = [];
    let webPushCalls = 0;
    let focused = true;
    const push = new PushService(kv, devices, {
      isWindowFocused: () => focused,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? 'GET',
          headers: (init?.headers as Record<string, string>) ?? {},
        });
        if (url.includes('push.example.test')) {
          webPushCalls += 1;
          return new Response('', { status: webPushCalls === 1 ? 201 : 410 });
        }
        return new Response('', { status: 200 });
      }) as typeof fetch,
    });

    const vapid = await push.ensureVapidKeys();
    expect(buildVapidAuthorizationHeader('https://push.example.test/sub/1', vapid, undefined, 1_700_000_000)).toContain('vapid t=');

    // 真实 RFC 8291（aes128gcm）解密往返校验
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = Buffer.from('0123456789abcdef');
    const plaintext = JSON.stringify({ title: 'Halo', body: 'Approve bash' });
    const encrypted = encryptWebPushPayload(
      {
        endpoint: 'https://push.example.test/sub/roundtrip',
        keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
      },
      plaintext,
    );
    const salt = encrypted.subarray(0, 16);
    const idLen = encrypted[20]!;
    expect(idLen).toBe(65);
    const asPublic = encrypted.subarray(21, 21 + idLen);
    const bodyAndTag = encrypted.subarray(21 + idLen);
    const ciphertext = bodyAndTag.subarray(0, bodyAndTag.length - 16);
    const authTag = bodyAndTag.subarray(bodyAndTag.length - 16);
    const shared = ua.computeSecret(asPublic);
    const infoAuth = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ua.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, infoAuth, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(decrypted.at(-1)).toBe(0x02);
    expect(decrypted.subarray(0, decrypted.length - 1).toString('utf8')).toBe(plaintext);

    // 桌面焦点抑制开启且窗口聚焦时不推送
    const suppressed = await push.dispatch({ kind: 'attention', title: 'HD', body: 'Need approval' });
    expect(suppressed).toEqual({ webPushSent: 0, webhookSent: false });
    expect(calls).toHaveLength(0);

    // 切到后台 + 开启 Webhook
    focused = false;
    await push.updateConfig({
      webhook: { enabled: true, preset: 'ntfy', url: 'https://ntfy.example.test/hd' },
    });
    const sent = await push.dispatch({ kind: 'attention', title: 'HD', body: 'Need approval', url: '/?session=s1' });
    expect(sent).toEqual({ webPushSent: 1, webhookSent: true });
    expect(calls).toHaveLength(2);

    // 再次发送触发 410 Gone 自动清理订阅
    await push.dispatch({ kind: 'turnComplete', title: 'HD', body: 'Done' });
    expect(devices.listPushSubscriptions()).toHaveLength(0);

    const bark = formatWebhookRequest(
      { enabled: true, preset: 'bark', url: 'https://api.day.app/key' },
      { kind: 'test', title: 'Halo', body: 'Hello' },
    );
    expect(JSON.parse(bark!.body)).toMatchObject({ title: 'Halo', body: 'Hello', group: 'Halo' });
  });
});

describe('HD-23/25 RemoteBridgeServer 端到端集成', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('完整链路：未鉴权 WS 拒连 -> 一次码换 Cookie -> 重放失败 -> WS 单播快照 -> Scope 守卫 -> 吊销踢断', async () => {
    const kv = new MemoryKVStore();
    const deviceAuth = new DeviceAuthStore(kv);
    const pushService = new PushService(kv, deviceAuth, { isWindowFocused: () => false });
    const ideMessages: HostToWebview[] = [];
    const receivedByHost: { msg: WebviewToHost; clientId: string }[] = [];

    const hub = new ClientHub({
      hostKind: 'vscode',
      postToIde: (m) => ideMessages.push(m),
      isIdeVisible: () => true,
    });

    const bridge = new RemoteBridgeServer({
      hostKind: 'vscode',
      globalState: kv,
      clientHub: hub,
      deviceAuth,
      pushService,
      bindHost: '127.0.0.1',
      port: 0,
      locale: () => 'zh',
      onWebviewMessage: (msg, clientId) => {
        receivedByHost.push({ msg, clientId });
        if (msg.type === 'ready') {
          hub.sendTo(clientId, { type: 'snapshot', payload: makeMinimalSnapshot() });
        }
      },
      onStateChange: () => undefined,
      log: () => undefined,
    });
    cleanups.push(() => bridge.stop());

    await bridge.setEnabled(true);
    const state = await bridge.generatePairing({ scope: 'read-only', routeKind: 'lan' });
    const port = state.port!;
    const baseUrl = `http://127.0.0.1:${port}`;
    const code = state.pairing!.code;

    // 1. 未鉴权 WS 拒连
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.once('open', () => reject(new Error('unexpected open')));
        ws.once('unexpected-response', (_req, res) => {
          expect(res.statusCode).toBe(401);
          ws.close();
          resolve();
        });
        ws.once('error', () => resolve());
      }),
    ).resolves.toBeUndefined();

    // 2. 一次性配对码换 Cookie
    const pairRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Test Phone' }),
    });
    expect(pairRes.status).toBe(200);
    const setCookie = pairRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    const cookiePair = setCookie.split(';')[0]!;
    const pairJson = (await pairRes.json()) as { device: { id: string } };

    // 3. 二次复用配对码失败
    const replayRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Replay' }),
    });
    expect(replayRes.status).toBe(401);

    // 4. 携带 Cookie 建连 WS 并发送 ready，仅当前客户端拿到单播 snapshot
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookiePair } });
    cleanups.push(async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    });
    await waitForOpen(ws);

    const snapPromise = nextJsonMessage<HostToWebview>(ws);
    ws.send(JSON.stringify({ type: 'ready', payload: {} }));
    const snap = await snapPromise;
    expect(snap.type).toBe('snapshot');
    if (snap.type === 'snapshot') {
      expect(snap.payload.clientSurface).toBe('mobile-web');
      expect(snap.payload.clientScope).toBe('read-only');
    }
    expect(ideMessages).toHaveLength(0);

    // 5. read-only 设备发 sendMessage 被 ScopeGuard 拦截并回传 toast
    const blockedToastPromise = nextJsonMessage<HostToWebview>(ws);
    ws.send(JSON.stringify({ type: 'sendMessage', payload: { text: 'should be blocked' } }));
    const blockedToast = await blockedToastPromise;
    expect(blockedToast.type).toBe('toast');
    expect(receivedByHost.some((item) => item.msg.type === 'sendMessage')).toBe(false);

    // 6. 吊销设备后 WS 立刻以 4001 关闭
    const closePromise = waitForClose(ws);
    await bridge.revokeDevice(pairJson.device.id);
    const closed = await closePromise;
    expect(closed.code).toBe(4001);
  });

  it('operate 作用域禁止高危宿主机配置操作（如 installBackend）', async () => {
    const kv = new MemoryKVStore();
    const deviceAuth = new DeviceAuthStore(kv);
    const pushService = new PushService(kv, deviceAuth, { isWindowFocused: () => false });
    const hub = new ClientHub({
      hostKind: 'vscode',
      postToIde: () => undefined,
      isIdeVisible: () => true,
    });
    const received: WebviewToHost[] = [];

    const bridge = new RemoteBridgeServer({
      hostKind: 'vscode',
      globalState: kv,
      clientHub: hub,
      deviceAuth,
      pushService,
      bindHost: '127.0.0.1',
      port: 0,
      locale: () => 'en',
      onWebviewMessage: (msg) => received.push(msg),
      onStateChange: () => undefined,
      log: () => undefined,
    });
    cleanups.push(() => bridge.stop());

    const state = await bridge.generatePairing({ scope: 'operate', routeKind: 'lan' });
    const baseUrl = `http://127.0.0.1:${state.port!}`;
    const pairRes = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.pairing!.code, deviceName: 'Operator' }),
    });
    const cookiePair = (pairRes.headers.get('set-cookie') ?? '').split(';')[0]!;

    const ws = new WebSocket(`ws://127.0.0.1:${state.port!}/ws`, { headers: { Cookie: cookiePair } });
    cleanups.push(async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    });
    await waitForOpen(ws);

    const toastPromise = nextJsonMessage<HostToWebview>(ws);
    ws.send(JSON.stringify({ type: 'installBackend', payload: { id: 'pi' } }));
    const toast = await toastPromise;
    expect(toast.type).toBe('toast');
    expect(received).toHaveLength(0);
  });

  it('重启桥接后持久化的 Tailscale 域名仍在 Host/Origin 白名单中，且 /api/health 仅对白名单 Origin 返回 CORS', async () => {
    const kv = new MemoryKVStore();
    const deviceAuth = new DeviceAuthStore(kv);
    const pushService = new PushService(kv, deviceAuth, { isWindowFocused: () => false });
    const hub = new ClientHub({
      hostKind: 'vscode',
      postToIde: () => undefined,
      isIdeVisible: () => true,
    });

    const bridge1 = new RemoteBridgeServer({
      hostKind: 'vscode',
      globalState: kv,
      clientHub: hub,
      deviceAuth,
      pushService,
      bindHost: '127.0.0.1',
      port: 0,
      locale: () => 'zh',
      onWebviewMessage: () => undefined,
      onStateChange: () => undefined,
      log: () => undefined,
      tailscaleExec: async (args) => {
        if (args[0] === 'status') {
          return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'devbox.tail.ts.net.' } }), stderr: '' };
        }
        return { stdout: JSON.stringify({ Web: { 'devbox.tail.ts.net:443': {} } }), stderr: '' };
      },
    });
    await bridge1.setEnabled(true);
    await bridge1.probeTailscale();
    await bridge1.stop();

    // 模拟重启：新建实例不重新调用 probeTailscale()
    const bridge2 = new RemoteBridgeServer({
      hostKind: 'vscode',
      globalState: kv,
      clientHub: hub,
      deviceAuth,
      pushService,
      bindHost: '127.0.0.1',
      port: 0,
      locale: () => 'zh',
      onWebviewMessage: () => undefined,
      onStateChange: () => undefined,
      log: () => undefined,
    });
    cleanups.push(() => bridge2.stop());
    await bridge2.restoreIfEnabled();
    const port = bridge2.port!;

    const okRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://devbox.tail.ts.net' },
    });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('access-control-allow-origin')).toBe('https://devbox.tail.ts.net');

    const evilRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(evilRes.status).toBe(403);
  });
});

describe('HD-28 headlessServer', () => {
  it('在无 IDE 宿主下启动远程桥接，写运行状态并在 stop 后清理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-headless-srv-'));
    const project = await mkdtemp(join(tmpdir(), 'hd-headless-proj-'));
    // 探测空闲端口后释放，供 headlessServer 绑定
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const handle = await runHeadlessServer({
      configRoot: root,
      projectPath: project,
      bindHost: '127.0.0.1',
      port,
    });
    expect(handle).toBeTruthy();

    try {
      const status = await readHeadlessServerStatus(root);
      expect(status.running).toBe(true);
      expect(status.port).toBe(port);
      expect(status.pairingUrl).toContain(`http://127.0.0.1:${port}/pair#code=`);
    } finally {
      await handle?.stop();
      const after = await readHeadlessServerStatus(root);
      expect(after.running).toBe(false);
      await rm(root, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

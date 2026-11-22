/**
 * 移动端推送服务（HD-27）：
 * - 本地 VAPID P-256 密钥生成与持久化（免自建云中继）
 * - 标准 RFC 8291 (aes128gcm) 负载加密与 RFC 8292 (VAPID ES256 JWT) 鉴权
 * - 通用 Webhook 兜底（Bark / ntfy / 自定义 JSON），兼容纯局域网 HTTP 场景
 * - 尊重桌面活跃静默抑制开关（suppressWhenFocused）
 */
import { createCipheriv, createECDH, createPrivateKey, createSign, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { RemotePushConfig, RemoteWebhookConfig, RemoteWebhookPreset } from '@harness-deck/shared';
import type { KeyValueStore } from '../host/HostPlatform.ts';
import type { DeviceAuthStore, WebPushSubscriptionRecord } from './DeviceAuthStore.ts';

const VAPID_KEYS_STORAGE_KEY = 'harnessDeck.remote.vapid';
const PUSH_CONFIG_STORAGE_KEY = 'harnessDeck.remote.pushConfig';

export interface VapidKeyPair {
  readonly publicKey: string; // base64url 65-byte uncompressed P-256 point
  readonly privateJwk: JsonWebKey;
}

export interface StoredRemotePushConfig {
  readonly webPushEnabled: boolean;
  readonly suppressWhenFocused: boolean;
  readonly webhook: RemoteWebhookConfig;
}

const DEFAULT_PUSH_CONFIG: StoredRemotePushConfig = {
  webPushEnabled: true,
  suppressWhenFocused: true,
  webhook: {
    enabled: false,
    preset: 'bark',
    url: '',
  },
};

export interface PushPayload {
  readonly kind: 'attention' | 'turnComplete' | 'unexpectedExit' | 'scheduledComplete' | 'test';
  readonly title: string;
  readonly body: string;
  readonly sessionId?: string;
  readonly url?: string;
}

export function generateVapidKeys(): VapidKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(pubJwk.x ?? '', 'base64url');
  const y = Buffer.from(pubJwk.y ?? '', 'base64url');
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  return {
    publicKey: uncompressed.toString('base64url'),
    privateJwk: privJwk,
  };
}

function parseVapidKeys(raw: unknown): VapidKeyPair | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.publicKey !== 'string' || !obj.publicKey || !obj.privateJwk || typeof obj.privateJwk !== 'object') {
    return undefined;
  }
  const jwk = obj.privateJwk as JsonWebKey;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') return undefined;
  return { publicKey: obj.publicKey, privateJwk: jwk };
}

function parsePushConfig(raw: unknown): StoredRemotePushConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_PUSH_CONFIG;
  const obj = raw as Record<string, unknown>;
  const wh = obj.webhook && typeof obj.webhook === 'object' ? (obj.webhook as Record<string, unknown>) : {};
  const preset: RemoteWebhookPreset =
    wh.preset === 'ntfy' || wh.preset === 'custom' || wh.preset === 'bark' ? wh.preset : 'bark';
  return {
    webPushEnabled: typeof obj.webPushEnabled === 'boolean' ? obj.webPushEnabled : DEFAULT_PUSH_CONFIG.webPushEnabled,
    suppressWhenFocused:
      typeof obj.suppressWhenFocused === 'boolean'
        ? obj.suppressWhenFocused
        : DEFAULT_PUSH_CONFIG.suppressWhenFocused,
    webhook: {
      enabled: typeof wh.enabled === 'boolean' ? wh.enabled : false,
      preset,
      url: typeof wh.url === 'string' ? wh.url : '',
    },
  };
}

/** RFC 8292 VAPID Authorization header (`vapid t=<jwt>, k=<base64url-pub>`). */
export function buildVapidAuthorizationHeader(
  endpoint: string,
  vapid: VapidKeyPair,
  subject = 'mailto:noreply@harness-deck.local',
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const audience = new URL(endpoint).origin;
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8').toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      aud: audience,
      exp: nowSec + 12 * 60 * 60,
      sub: subject,
    }),
    'utf8',
  ).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const key = createPrivateKey({ key: vapid.privateJwk as unknown as Record<string, unknown>, format: 'jwk' });
  const signer = createSign('SHA256');
  signer.update(unsigned, 'utf8');
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${vapid.publicKey}`;
}

/** RFC 8291 (`aes128gcm`) Web Push payload encryption. */
export function encryptWebPushPayload(
  subscription: WebPushSubscriptionRecord,
  payloadText: string,
  salt: Buffer = randomBytes(16),
): Buffer {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid p256dh subscription public key');
  }
  if (authSecret.length < 12) {
    throw new Error('Invalid auth subscription secret');
  }

  const as = createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const sharedSecret = as.computeSecret(uaPublic);

  const infoAuth = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, infoAuth, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const plaintext = Buffer.concat([Buffer.from(payloadText, 'utf8'), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([asPublic.length]);
  return Buffer.concat([salt, rs, idlen, asPublic, encrypted]);
}

export function formatWebhookRequest(
  config: RemoteWebhookConfig,
  payload: PushPayload,
): { readonly url: string; readonly headers: Record<string, string>; readonly body: string } | undefined {
  const rawUrl = config.url.trim();
  if (!rawUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }

  if (config.preset === 'bark') {
    return {
      url: parsed.toString(),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        group: 'Harness Deck',
        ...(payload.url ? { url: payload.url } : {}),
      }),
    };
  }
  if (config.preset === 'ntfy') {
    return {
      url: parsed.toString(),
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: payload.title,
        ...(payload.url ? { Click: payload.url } : {}),
      },
      body: payload.body,
    };
  }
  return {
    url: parsed.toString(),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      event: payload.kind,
      title: payload.title,
      message: payload.body,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.url ? { url: payload.url } : {}),
      timestamp: Date.now(),
    }),
  };
}

export class PushService {
  private vapid: VapidKeyPair | undefined;
  private config: StoredRemotePushConfig;

  constructor(
    private readonly store: KeyValueStore,
    private readonly devices: DeviceAuthStore,
    private readonly options: {
      readonly isWindowFocused: () => boolean;
      readonly fetchImpl?: typeof fetch;
      readonly log?: (line: string) => void;
    },
  ) {
    this.vapid = parseVapidKeys(store.get<unknown>(VAPID_KEYS_STORAGE_KEY));
    this.config = parsePushConfig(store.get<unknown>(PUSH_CONFIG_STORAGE_KEY));
  }

  async ensureVapidKeys(): Promise<VapidKeyPair> {
    if (!this.vapid) {
      this.vapid = generateVapidKeys();
      await this.store.update(VAPID_KEYS_STORAGE_KEY, this.vapid);
    }
    return this.vapid;
  }

  getVapidPublicKey(): string | undefined {
    return this.vapid?.publicKey;
  }

  getConfig(): RemotePushConfig {
    return {
      webPushEnabled: this.config.webPushEnabled,
      ...(this.vapid ? { vapidPublicKey: this.vapid.publicKey } : {}),
      suppressWhenFocused: this.config.suppressWhenFocused,
      webhook: this.config.webhook,
    };
  }

  async updateConfig(patch: {
    readonly webPushEnabled?: boolean;
    readonly suppressWhenFocused?: boolean;
    readonly webhook?: {
      readonly enabled?: boolean;
      readonly preset?: RemoteWebhookPreset;
      readonly url?: string;
    };
  }): Promise<RemotePushConfig> {
    const nextWebhook: RemoteWebhookConfig = {
      enabled: patch.webhook?.enabled ?? this.config.webhook.enabled,
      preset: patch.webhook?.preset ?? this.config.webhook.preset,
      url: patch.webhook?.url !== undefined ? patch.webhook.url.trim() : this.config.webhook.url,
    };
    this.config = {
      webPushEnabled: patch.webPushEnabled ?? this.config.webPushEnabled,
      suppressWhenFocused: patch.suppressWhenFocused ?? this.config.suppressWhenFocused,
      webhook: nextWebhook,
    };
    await this.store.update(PUSH_CONFIG_STORAGE_KEY, this.config);
    return this.getConfig();
  }

  async dispatch(
    payload: PushPayload,
    options: { readonly ignoreFocusCheck?: boolean } = {},
  ): Promise<{ readonly webPushSent: number; readonly webhookSent: boolean }> {
    if (!options.ignoreFocusCheck && this.config.suppressWhenFocused && this.options.isWindowFocused()) {
      return { webPushSent: 0, webhookSent: false };
    }

    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    let webPushSent = 0;
    let webhookSent = false;

    if (this.config.webPushEnabled) {
      const subs = this.devices.listPushSubscriptions();
      if (subs.length > 0) {
        const vapid = await this.ensureVapidKeys();
        const serialized = JSON.stringify({
          title: payload.title,
          body: payload.body,
          kind: payload.kind,
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
          ...(payload.url ? { url: payload.url } : {}),
        });
        for (const { subscription } of subs) {
          try {
            const encrypted = encryptWebPushPayload(subscription, serialized);
            const authHeader = buildVapidAuthorizationHeader(subscription.endpoint, vapid);
            const res = await fetchFn(subscription.endpoint, {
              method: 'POST',
              headers: {
                Authorization: authHeader,
                TTL: '60',
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
              },
              body: new Uint8Array(encrypted),
              signal: AbortSignal.timeout(8_000),
            });
            if (res.status === 404 || res.status === 410) {
              await this.devices.removePushSubscriptionByEndpoint(subscription.endpoint);
            } else if (res.ok) {
              webPushSent += 1;
            } else {
              this.options.log?.(`Web Push 返回 HTTP ${res.status}`);
            }
          } catch (error) {
            this.options.log?.(`Web Push 发送失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    if (this.config.webhook.enabled && this.config.webhook.url.trim()) {
      const req = formatWebhookRequest(this.config.webhook, payload);
      if (req) {
        try {
          const res = await fetchFn(req.url, {
            method: 'POST',
            headers: req.headers,
            body: req.body,
            signal: AbortSignal.timeout(8_000),
          });
          webhookSent = res.ok;
          if (!res.ok) {
            this.options.log?.(`Webhook 推送返回 HTTP ${res.status}`);
          }
        } catch (error) {
          this.options.log?.(`Webhook 推送失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return { webPushSent, webhookSent };
  }
}

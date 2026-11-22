/**
 * 已授权远程设备存储（HD-23 / HD-27）：
 * - 宿主只持久化令牌 SHA-256 哈希，不保存明文会话令牌
 * - 支持签发 Cookie、恒定时间校验、单设备吊销、全部吊销及 Web Push 订阅绑定
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RemoteDeviceView, RemoteScope } from '@harness-deck/shared';
import type { KeyValueStore } from '../host/HostPlatform.ts';

const DEVICES_KEY = 'harnessDeck.remote.devices';
export const REMOTE_COOKIE_NAME = 'hd_device_session';
export const REMOTE_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export interface WebPushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface StoredDeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly scope: RemoteScope;
  readonly tokenHash: string;
  readonly createdAt: number;
  lastSeenAt: number;
  pushSubscription?: WebPushSubscriptionRecord;
}

function hashSecretHex(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function normalizeDeviceName(raw: string): string {
  const clean = raw.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 80);
  return clean || 'Mobile Browser';
}

function parseStoredDevices(raw: unknown): StoredDeviceRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredDeviceRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.id !== 'string' ||
      !rec.id ||
      typeof rec.name !== 'string' ||
      (rec.scope !== 'read-only' && rec.scope !== 'operate') ||
      typeof rec.tokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/iu.test(rec.tokenHash)
    ) {
      continue;
    }
    let pushSubscription: WebPushSubscriptionRecord | undefined;
    if (rec.pushSubscription && typeof rec.pushSubscription === 'object') {
      const sub = rec.pushSubscription as Record<string, unknown>;
      const keys = sub.keys && typeof sub.keys === 'object' ? (sub.keys as Record<string, unknown>) : undefined;
      if (
        typeof sub.endpoint === 'string' &&
        sub.endpoint.startsWith('https://') &&
        keys &&
        typeof keys.p256dh === 'string' &&
        typeof keys.auth === 'string'
      ) {
        pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
        };
      }
    }
    out.push({
      id: rec.id,
      name: normalizeDeviceName(rec.name),
      scope: rec.scope,
      tokenHash: rec.tokenHash,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : Date.now(),
      lastSeenAt: typeof rec.lastSeenAt === 'number' ? rec.lastSeenAt : Date.now(),
      ...(pushSubscription ? { pushSubscription } : {}),
    });
  }
  return out;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export class DeviceAuthStore {
  private readonly devices = new Map<string, StoredDeviceRecord>();
  private lastTouchPersistAt = 0;

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const rec of parseStoredDevices(store.get<unknown>(DEVICES_KEY))) {
      this.devices.set(rec.id, rec);
    }
  }

  async issueDevice(name: string, scope: RemoteScope): Promise<{
    readonly device: StoredDeviceRecord;
    readonly cookieValue: string;
  }> {
    const id = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    const ts = this.now();
    const record: StoredDeviceRecord = {
      id,
      name: normalizeDeviceName(name),
      scope,
      tokenHash: hashSecretHex(secret),
      createdAt: ts,
      lastSeenAt: ts,
    };
    this.devices.set(id, record);
    await this.persist();
    return {
      device: record,
      cookieValue: `${id}.${secret}`,
    };
  }

  verifyCookie(cookieValue: string | undefined): StoredDeviceRecord | undefined {
    if (!cookieValue) return undefined;
    const dot = cookieValue.indexOf('.');
    if (dot <= 0 || dot >= cookieValue.length - 1) return undefined;
    const deviceId = cookieValue.slice(0, dot);
    const secret = cookieValue.slice(dot + 1);
    const record = this.devices.get(deviceId);
    if (!record) return undefined;
    const expected = Buffer.from(record.tokenHash, 'hex');
    const actual = Buffer.from(hashSecretHex(secret), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return undefined;
    }
    return record;
  }

  touchDevice(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (!record) return;
    const ts = this.now();
    record.lastSeenAt = ts;
    if (ts - this.lastTouchPersistAt > 30_000) {
      this.lastTouchPersistAt = ts;
      void this.persist();
    }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const existed = this.devices.delete(deviceId);
    if (existed) {
      await this.persist();
    }
    return existed;
  }

  async revokeAll(): Promise<void> {
    if (this.devices.size === 0) return;
    this.devices.clear();
    await this.persist();
  }

  async setPushSubscription(
    deviceId: string,
    subscription: WebPushSubscriptionRecord | undefined,
  ): Promise<boolean> {
    const record = this.devices.get(deviceId);
    if (!record) return false;
    if (subscription) {
      record.pushSubscription = subscription;
    } else {
      delete record.pushSubscription;
    }
    await this.persist();
    return true;
  }

  async removePushSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
    let changed = false;
    for (const record of this.devices.values()) {
      if (record.pushSubscription?.endpoint === endpoint) {
        delete record.pushSubscription;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
    return changed;
  }

  listPushSubscriptions(): readonly { readonly deviceId: string; readonly subscription: WebPushSubscriptionRecord }[] {
    const out: { deviceId: string; subscription: WebPushSubscriptionRecord }[] = [];
    for (const record of this.devices.values()) {
      if (record.pushSubscription) {
        out.push({ deviceId: record.id, subscription: record.pushSubscription });
      }
    }
    return out;
  }

  listViews(connectedDeviceIds: ReadonlySet<string>): RemoteDeviceView[] {
    return [...this.devices.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((rec) => ({
        id: rec.id,
        name: rec.name,
        scope: rec.scope,
        createdAt: rec.createdAt,
        lastSeenAt: rec.lastSeenAt,
        connected: connectedDeviceIds.has(rec.id),
        ...(rec.pushSubscription ? { pushSubscribed: true } : {}),
      }));
  }

  private async persist(): Promise<void> {
    await this.store.update(DEVICES_KEY, [...this.devices.values()]);
  }
}

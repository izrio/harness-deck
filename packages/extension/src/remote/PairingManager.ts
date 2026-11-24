/**
 * 短效一次配对码管理器（HD-23）：
 * - 默认 5 分钟有效，单次成功核验后立即作废
 * - 配对码放入 URL `#fragment`（不进查询串与访问日志）
 * - SHA-256 摘要 + `crypto.timingSafeEqual` 恒定时间校验
 * - 连续失败 5 次自动锁定并作废当前配对码
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RemotePairingView, RemoteRouteKind, RemoteScope } from '@harness-deck/shared';

export const PAIR_TTL_MS = 5 * 60 * 1000;
export const MAX_PAIR_ATTEMPTS = 5;

interface ActivePairing {
  readonly code: string;
  readonly codeDigest: Buffer;
  readonly url: string;
  readonly scope: RemoteScope;
  readonly routeKind: RemoteRouteKind;
  readonly expiresAt: number;
  attempts: number;
}

export type PairingVerifyResult =
  | { readonly ok: true; readonly scope: RemoteScope; readonly routeKind: RemoteRouteKind }
  | { readonly ok: false; readonly reason: 'missing' | 'expired' | 'locked' | 'invalid'; readonly remainingAttempts?: number };

function digestCode(code: string): Buffer {
  return createHash('sha256').update(code, 'utf8').digest();
}

export class PairingManager {
  private active: ActivePairing | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  generate(options: {
    readonly scope: RemoteScope;
    readonly baseUrl: string;
    readonly routeKind: RemoteRouteKind;
    readonly ttlMs?: number;
  }): RemotePairingView {
    const code = randomBytes(12).toString('base64url');
    const cleanBase = options.baseUrl.replace(/\/+$/u, '');
    const url = `${cleanBase}/pair#code=${code}`;
    const expiresAt = this.now() + (options.ttlMs ?? PAIR_TTL_MS);
    this.active = {
      code,
      codeDigest: digestCode(code),
      url,
      scope: options.scope,
      routeKind: options.routeKind,
      expiresAt,
      attempts: 0,
    };
    return {
      url,
      code,
      scope: options.scope,
      expiresAt,
      routeKind: options.routeKind,
    };
  }

  current(): RemotePairingView | undefined {
    if (!this.active) return undefined;
    if (this.now() >= this.active.expiresAt) {
      this.active = undefined;
      return undefined;
    }
    return {
      url: this.active.url,
      code: this.active.code,
      scope: this.active.scope,
      expiresAt: this.active.expiresAt,
      routeKind: this.active.routeKind,
    };
  }

  clear(): void {
    this.active = undefined;
  }

  verify(submittedCode: string): PairingVerifyResult {
    const current = this.active;
    if (!current) return { ok: false, reason: 'missing' };
    if (this.now() >= current.expiresAt) {
      this.active = undefined;
      return { ok: false, reason: 'expired' };
    }
    const candidate = submittedCode.trim();
    const candidateDigest = digestCode(candidate);
    const matched = timingSafeEqual(candidateDigest, current.codeDigest);
    if (!matched) {
      current.attempts += 1;
      if (current.attempts >= MAX_PAIR_ATTEMPTS) {
        this.active = undefined;
        return { ok: false, reason: 'locked', remainingAttempts: 0 };
      }
      return { ok: false, reason: 'invalid', remainingAttempts: MAX_PAIR_ATTEMPTS - current.attempts };
    }
    // 一次性有效：核验成功立即作废，防止重放
    this.active = undefined;
    return { ok: true, scope: current.scope, routeKind: current.routeKind };
  }
}

export const HANDOFF_TTL_MS = 90 * 1000;
const MAX_PENDING_HANDOFFS = 16;

interface PendingHandoff {
  readonly digest: Buffer;
  readonly deviceId: string;
  readonly expiresAt: number;
}

/**
 * 跨入口无缝切换一次性票据管理器（LAN ↔ Tailscale ↔ Quick Tunnel ↔ Custom Tunnel）：
 * - 已登录设备切换访问域名时由宿主签发 90 秒单次有效票据（通过 URL `#handoff=` 传递）
 * - 在目标域名核验成功后立即作废并签发对应 Origin 的 HttpOnly Cookie，避免离开工位后被锁在配对页
 */
export class HandoffManager {
  private readonly tickets: PendingHandoff[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(deviceId: string, ttlMs = HANDOFF_TTL_MS): { readonly token: string; readonly expiresAt: number } {
    this.prune();
    const token = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    this.tickets.push({ digest: digestCode(token), deviceId, expiresAt });
    while (this.tickets.length > MAX_PENDING_HANDOFFS) {
      this.tickets.shift();
    }
    return { token, expiresAt };
  }

  redeem(submittedToken: string): { readonly ok: true; readonly deviceId: string } | { readonly ok: false } {
    this.prune();
    const clean = submittedToken.trim();
    if (!clean) return { ok: false };
    const candidate = digestCode(clean);
    for (let i = 0; i < this.tickets.length; i += 1) {
      const entry = this.tickets[i]!;
      if (timingSafeEqual(candidate, entry.digest)) {
        this.tickets.splice(i, 1);
        return { ok: true, deviceId: entry.deviceId };
      }
    }
    return { ok: false };
  }

  revokeForDevice(deviceId: string): void {
    for (let i = this.tickets.length - 1; i >= 0; i -= 1) {
      if (this.tickets[i]!.deviceId === deviceId) {
        this.tickets.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.tickets.length = 0;
  }

  private prune(): void {
    const ts = this.now();
    for (let i = this.tickets.length - 1; i >= 0; i -= 1) {
      if (ts >= this.tickets[i]!.expiresAt) {
        this.tickets.splice(i, 1);
      }
    }
  }
}

/**
 * 多客户端会话总线（HD-22）：统一管理本地 IDE Webview 与远程移动端客户端，分离单播与广播通道。
 */
import type { ClientSurface, HostIdeKind, HostToWebview, RemoteScope } from '@harness-deck/shared';

export interface ConnectedClient {
  readonly id: string;
  readonly surface: ClientSurface;
  scope: RemoteScope;
  readonly deviceId?: string;
  visible: boolean;
  readonly send: (message: HostToWebview) => void;
  readonly close?: (code?: number, reason?: string) => void;
}

export interface ClientHubOptions {
  readonly hostKind: HostIdeKind;
  readonly postToIde: (message: HostToWebview) => void;
  readonly isIdeVisible: () => boolean;
  readonly onRemoteClientsChanged?: () => void;
}

/** `ready` 之外仅向发起请求的那一个客户端单播的响应消息类型。 */
export const UNICAST_HOST_MESSAGE_TYPES: ReadonlySet<HostToWebview['type']> = new Set([
  'fileCandidates',
  'markdownPreview',
  'diffContent',
  'diffOpened',
  'quotaFetched',
  'providerModelsFetched',
  'restoreDraft',
  'fileSaved',
  'sourceControlDraftGenerated',
  'sourceControlLogResult',
  'sourceControlCommitDetail',
  'sourceControlStashDetail',
  'browserNetworkBody',
  'browserConsoleObject',
  'browserConsoleCompletions',
  'accountsExported',
  'remoteStorageAuthProgress',
  'remoteFilesListed',
  'remoteFileActionDone',
]);

export class ClientHub {
  private readonly clients = new Map<string, ConnectedClient>();

  constructor(private readonly options: ClientHubOptions) {
    this.clients.set('ide', {
      id: 'ide',
      surface: 'ide',
      scope: 'operate',
      visible: true,
      send: (message) => options.postToIde(message),
    });
  }

  registerClient(client: ConnectedClient): () => void {
    this.clients.set(client.id, client);
    if (client.surface === 'mobile-web') {
      this.options.onRemoteClientsChanged?.();
    }
    return () => {
      this.unregisterClient(client.id);
    };
  }

  unregisterClient(id: string): void {
    if (id === 'ide') return;
    const existing = this.clients.get(id);
    if (!existing) return;
    this.clients.delete(id);
    if (existing.surface === 'mobile-web') {
      this.options.onRemoteClientsChanged?.();
    }
  }

  getClient(id: string): ConnectedClient | undefined {
    return this.clients.get(id);
  }

  setClientVisible(id: string, visible: boolean): void {
    const client = this.clients.get(id);
    if (client) client.visible = visible;
  }

  /** 实时更新某已授权设备所有活跃远程连接的权限作用域，返回受影响的 clientId 列表。 */
  updateDeviceScope(deviceId: string, scope: RemoteScope): string[] {
    const updated: string[] = [];
    for (const client of this.clients.values()) {
      if (client.surface === 'mobile-web' && client.deviceId === deviceId) {
        client.scope = scope;
        updated.push(client.id);
      }
    }
    return updated;
  }

  remoteClientCount(): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.surface === 'mobile-web') count += 1;
    }
    return count;
  }

  connectedDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.surface === 'mobile-web' && client.deviceId) {
        ids.add(client.deviceId);
      }
    }
    return ids;
  }

  hasVisibleRemoteClients(): boolean {
    for (const client of this.clients.values()) {
      if (client.surface === 'mobile-web' && client.visible) return true;
    }
    return false;
  }

  isAnyClientVisible(): boolean {
    return this.options.isIdeVisible() || this.hasVisibleRemoteClients();
  }

  sendTo(clientId: string, message: HostToWebview): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.send(this.stampForClient(client, message));
    } catch {
      // 单个远端连接异常不影响其他端
    }
  }

  broadcast(message: HostToWebview): void {
    for (const client of this.clients.values()) {
      try {
        client.send(this.stampForClient(client, message));
      } catch {
        // 忽略失效客户端发送异常
      }
    }
  }

  broadcastIde(message: HostToWebview): void {
    for (const client of this.clients.values()) {
      if (client.surface !== 'ide') continue;
      try {
        client.send(this.stampForClient(client, message));
      } catch {
        // 忽略失效客户端发送异常
      }
    }
  }

  disconnectDevice(deviceId: string, code = 4001, reason = 'Device revoked'): void {
    for (const client of [...this.clients.values()]) {
      if (client.surface === 'mobile-web' && client.deviceId === deviceId) {
        this.clients.delete(client.id);
        client.close?.(code, reason);
      }
    }
    this.options.onRemoteClientsChanged?.();
  }

  disconnectAllRemote(code = 4000, reason = 'Remote bridge disabled'): void {
    let changed = false;
    for (const client of [...this.clients.values()]) {
      if (client.surface === 'mobile-web') {
        this.clients.delete(client.id);
        client.close?.(code, reason);
        changed = true;
      }
    }
    if (changed) {
      this.options.onRemoteClientsChanged?.();
    }
  }

  dispose(): void {
    this.disconnectAllRemote(1001, 'Host shutting down');
  }

  private stampForClient(client: ConnectedClient, message: HostToWebview): HostToWebview {
    if (message.type !== 'snapshot') return message;
    const remote =
      message.payload.remote && client.surface === 'mobile-web'
        ? (() => {
            const { pairing: _omit, bots, ...rest } = message.payload.remote;
            const sanitizedBots = bots
              ? (() => {
                  const { pairing: _omitBotPairing, ...botsRest } = bots;
                  return botsRest;
                })()
              : undefined;
            return {
              ...rest,
              ...(sanitizedBots ? { bots: sanitizedBots } : {}),
            };
          })()
        : message.payload.remote;
    return {
      type: 'snapshot',
      payload: {
        ...message.payload,
        ...(remote ? { remote } : {}),
        hostKind: message.payload.hostKind ?? this.options.hostKind,
        clientSurface: client.surface,
        clientScope: client.scope,
      },
    };
  }
}

/**
 * 远程桥接安全守卫（HD-23 / HD-26）：
 * 1. Host / Origin 防 DNS Rebinding 校验
 * 2. 作用域最小化（read-only / operate）与高危宿主机配置变更拦截
 */
import type { RemoteScope, WebviewToHost } from '@harness-deck/shared';

/** read-only 作用域允许的只读消息类型。 */
const READ_ONLY_ALLOWED_TYPES: ReadonlySet<WebviewToHost['type']> = new Set([
  'ready',
  'loadOlder',
  'openDiff',
  'openSourceControlDiff',
  'previewApproval',
  'previewMarkdown',
  'previewFile',
  'refreshSourceControl',
  'switchSession',
  'activateTab',
  'openFile',
  'loadImage',
  'searchFiles',
  'fetchQuota',
  'markUnreadRead',
  'registerWebPushSubscription',
  'unregisterWebPushSubscription',
  'terminalSelect',
  'fetchSkillMarket',
  'fetchMcpMarket',
  'browserGetConsoleObject',
]);

/** 无论何种远程作用域都默认禁止的高危宿主机配置与远程管理写操作（必须回到本机 IDE 操作）。 */
const REMOTE_BLOCKED_TYPES: ReadonlySet<WebviewToHost['type']> = new Set([
  'installBackend',
  'uninstallBackend',
  'upsertBackendProfile',
  'deleteBackendProfile',
  'upsertProvider',
  'deleteProvider',
  'bindProviderAgents',
  'setProtocolGateway',
  'clearProtocolGatewayLogs',
  'upsertMcpServer',
  'toggleMcpServer',
  'deleteMcpServer',
  'importMcpServers',
  'scanAgentMcpConfigs',
  'pickMcpConfigFile',
  'scanGitSkills',
  'installGitSkills',
  'updateSkill',
  'syncSkill',
  'deleteSkill',
  'scanAgentSkills',
  'pickLocalSkillDir',
  'importLocalSkills',
  'configureApiKey',
  'openSettings',
  'addRecentProject',
  'removeRecentProject',
  'openProject',
  'setProjectWorktreeConfig',
  'pickFiles',
  'pickTaskFiles',
  'fetchBackendModels',
  'openWorkbenchPanel',
  'showLogs',
  'setRemoteEnabled',
  'setRemoteConfig',
  'generateRemotePairing',
  'clearRemotePairing',
  'updateRemoteDevice',
  'revokeRemoteDevice',
  'disconnectAllRemote',
  'refreshRemoteNetwork',
  'probeTailscale',
  'configureTailscaleServe',
  'probeQuickTunnel',
  'setQuickTunnelEnabled',
  'setRemotePushConfig',
  'testRemotePush',
  'updateImBotChannel',
  'generateImBotPairing',
  'clearImBotPairing',
  'revokeImBotUser',
  'testImBotChannel',
  'upsertAccount',
  'deleteAccount',
  'toggleAccountDisabled',
  'setAccountAutomation',
  'importAccounts',
  'exportAccounts',
]);

export function extractHostname(hostHeader: string): string | undefined {
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end <= 1) return undefined;
    return trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

export function isAllowedHostHeader(hostHeader: string | undefined, allowedHosts: ReadonlySet<string>): boolean {
  if (!hostHeader) return false;
  const hostname = extractHostname(hostHeader);
  if (!hostname) return false;
  return allowedHosts.has(hostname);
}

export function isAllowedOriginHeader(
  originHeader: string | undefined,
  allowedHosts: ReadonlySet<string>,
  allowedOrigins?: ReadonlySet<string>,
): boolean {
  if (!originHeader) return true;
  if (allowedOrigins?.has(originHeader.toLowerCase())) return true;
  try {
    const url = new URL(originHeader);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return allowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function authorizeRemoteMessage(
  scope: RemoteScope,
  message: WebviewToHost,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (REMOTE_BLOCKED_TYPES.has(message.type)) {
    return { ok: false, reason: `Remote clients cannot execute host configuration action "${message.type}"` };
  }
  if (message.type === 'setPreferences' && message.payload.advanced !== undefined) {
    return { ok: false, reason: 'Remote clients cannot modify advanced host preferences' };
  }
  if (scope === 'read-only' && !READ_ONLY_ALLOWED_TYPES.has(message.type)) {
    return { ok: false, reason: `Read-only remote device cannot execute "${message.type}"` };
  }
  return { ok: true };
}

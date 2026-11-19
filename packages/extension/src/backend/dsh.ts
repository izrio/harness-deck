/**
 * dsh 底层：RuntimeManager 启动 dsh，DshConnection 建立连接，ChatController 投影会话。
 *
 *   RuntimeManager ──endpoint──▶ DshConnection ──client──▶ ChatController ◀──messages──▶ Webview
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import { DshConnection } from '../dsh/DshConnection.ts';
import { RuntimeManager, type RuntimeConfig } from '../runtime/RuntimeManager.ts';
import { ChatController } from '../dsh/view/ChatController.ts';
import { prepareDshProviderRuntime } from '../providers/ProviderRuntime.ts';
import { webUIUrl } from '../util/webUrl.ts';
import { t } from '../i18n.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

export function createDshBackend(profile: Extract<BackendProfile, { kind: 'dsh' }>, host: BackendHost): RunningBackend {
  const manager = new RuntimeManager({
    getConfig: () => readRuntimeConfig(profile, host),
    log: host.log,
    runtimeLog: host.runtimeLog,
  });
  const dsh = new DshConnection({ log: host.log });
  const state = host.workspaceState;
  const currentStatus = (): RuntimeStatus => (host.isWorkspaceTrusted() ? manager.currentStatus : { kind: 'untrusted' });

  /**
   * 在浏览器中打开 dsh 网页。dsh 只监听 dsh 所在机器的 127.0.0.1：远程开发时由宿主的 resolveExternalOrigin 转发端口。
   * 启动令牌让浏览器完成一次认证，之后 dsh 用 Cookie 维持登录。dsh 网页没有指向某个会话的地址，只能提示会话标题。
   */
  const openWebUI = async (sessionTitle?: string): Promise<void> => {
    const endpoint = manager.endpoint;
    if (!endpoint) {
      void host.showMessage('warning', t('ext.notStarted'));
      return;
    }
    const url = await webUIUrl(endpoint.origin, endpoint.token, host.resolveExternalOrigin, host.log);
    host.log(`在浏览器中打开 dsh：${url.replace(/token=[^&]*/u, 'token=***')}`);
    const opened = await host.openExternal(url);
    const copy = t('ext.copyLink');
    const message = !opened ? t('ext.webUIFailed') : sessionTitle ? t('ext.webUIOpenedSession', sessionTitle) : t('ext.webUIOpened');
    const choice = await host.showMessage(opened ? 'info' : 'warning', message, [copy]);
    if (choice === copy) await host.writeClipboard(url);
  };

  const chat = new ChatController({
    ...host.controllerOptions(),
    workspacePath: host.workspacePath(),
    loadActiveSessionId: () => state.get<string>(host.stateKey('dsh.activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(host.stateKey('dsh.activeSessionId'), sessionId),
    loadOpenTabs: () => state.get<string[]>(host.stateKey('dsh.openTabs')),
    saveOpenTabs: (ids) => void state.update(host.stateKey('dsh.openTabs'), [...ids]),
    restartRuntime: () => void manager.restart(),
    openWebUI: (sessionTitle) => void openWebUI(sessionTitle),
    boundProvider: () => host.boundProvider?.(profile.id),
  });

  const disposers = [
    manager.onStatus(() => {
      chat.setRuntimeStatus(currentStatus());
      host.onStatus(currentStatus());
    }),
    // Host 每次就绪（包括重启后令牌变化）都重新连接
    manager.onEndpoint((endpoint) => dsh.setEndpoint(endpoint)),
    dsh.onClient((client) => chat.setClient(client)),
    dsh.onStatus((value) => chat.setConnectionStatus(value)),
  ];

  return {
    profile,
    controller: chat,
    dshClient: () => dsh.client,
    webUrl: () => manager.endpoint?.origin.replace(/\/+$/u, ''),
    start: () => {
      if (!host.isWorkspaceTrusted()) {
        host.log('工作区未受信任，不启动 dsh');
        chat.setRuntimeStatus(currentStatus());
        host.onStatus(currentStatus());
        return;
      }
      void manager.start();
    },
    restart: () => void manager.restart(),
    currentStatus,
    stop: async () => {
      disposers.forEach((dispose) => dispose());
      chat.dispose();
      dsh.dispose();
      await manager.stop();
    },
  };
}

async function readRuntimeConfig(profile: Extract<BackendProfile, { kind: 'dsh' }>, host: BackendHost): Promise<RuntimeConfig> {
  const configuredPath = host.settings.get<string>('dsh.path', '');
  const cmdSpec = commandSpecForProfile(profile, configuredPath);
  const cachedExecutable = host.getCachedExecutable?.(profile.id, cmdSpec);
  const prepared = await host.prepareBackendLaunch?.(profile);
  const boundProvider = host.boundProvider?.(profile.id);
  let providerPatch: Awaited<ReturnType<typeof prepareDshProviderRuntime>>;
  if (boundProvider && host.ensureProviderProxy) {
    try {
      const proxy = await host.ensureProviderProxy();
      providerPatch = await prepareDshProviderRuntime(
        boundProvider,
        proxy.origin,
        proxy.token,
        host.storageRoot,
      );
    } catch (error) {
      host.log(`准备服务商 ${boundProvider.name} 的 dsh 配置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const launcherArgs = [
    ...(prepared?.launcherArgs ?? []),
    ...(providerPatch?.launcherArgs ?? []),
  ];
  return {
    configuredPath,
    profile: host.settings.get<string>('dsh.profile', 'web') || 'web',
    cwd: host.workspacePath(),
    env: host.processEnv(providerPatch?.env),
    ...(launcherArgs.length > 0 ? { launcherArgs } : {}),
    ...(cachedExecutable ? { cachedExecutable } : {}),
    onResolvedExecutable: (resolved) => host.setCachedExecutable?.(profile.id, cmdSpec, resolved),
  };
}

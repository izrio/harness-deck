/**
 * ZCode 原生底层生命周期管理：
 * 查找本机 `zcode` 命令或 ZCode 桌面端内置的 `zcode.cjs`，以 `app-server --stdio` 模式启动进程，
 * 接管 NDJSON 双向通信并挂载 `ZcodeController`。
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import type { StoredSession } from '../acp/AcpController.ts';
import { t } from '../i18n.ts';
import { prepareAcpProviderRuntime } from '../providers/ProviderRuntime.ts';
import { ZcodeConnection, ZcodeTimeoutError } from '../zcode/connection.ts';
import { locateZcode, verifyZcodeTarget } from '../zcode/locate.ts';
import { ZcodeController, type ZcodePreferredModel } from '../zcode/ZcodeController.ts';
import { probeCommandVersion } from './npmManager.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

const TRACE_LIMIT = 4_000;
const STARTUP_PROBE_TIMEOUT_MS = 15_000;

export function createZcodeBackend(
  profile: Extract<BackendProfile, { kind: 'zcode' }>,
  host: BackendHost,
): RunningBackend {
  const state = host.workspaceState;
  const key = (name: string) => host.stateKey(`zcode.${name}`);
  let status: RuntimeStatus = { kind: 'idle' };
  let connection: ZcodeConnection | undefined;
  let generation = 0;

  const common = host.controllerOptions();
  const controller = new ZcodeController({
    ...common,
    workspacePath: host.workspacePath(),
    restartRuntime: () => void restart(),
    loadActiveSessionId: () => state.get<string>(key('activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(key('activeSessionId'), sessionId),
    loadSessions: () => state.get<StoredSession[]>(key('sessions')),
    saveSessions: (sessions) => void state.update(key('sessions'), [...sessions]),
    loadPreferredModel: () => host.globalState.get<ZcodePreferredModel>('harnessDeck.zcode.model'),
    savePreferredModel: (preferred) => void host.globalState.update('harnessDeck.zcode.model', preferred),
    loadOpenTabs: () => state.get<string[]>(key('openTabs')),
    saveOpenTabs: (ids) => void state.update(key('openTabs'), [...ids]),
    ...(profile.signInHint ? { signInHint: profile.signInHint } : {}),
    boundProvider: () => host.boundProvider?.(profile.id),
    ...(host.onProviderModelSelected ? { onProviderModelSelected: host.onProviderModelSelected } : {}),
  });

  const setStatus = (next: RuntimeStatus): void => {
    status = next;
    controller.setRuntimeStatus(next);
    host.onStatus(next);
  };

  const start = async (): Promise<void> => {
    if (!host.isWorkspaceTrusted()) {
      setStatus({ kind: 'untrusted' });
      return;
    }
    if (connection?.running) return;
    const current = ++generation;
    const configuredPath = host.settings.get<string>('zcode.path', '');
    const baseEnv = host.processEnv();
    const cmdSpec = commandSpecForProfile(profile, '', configuredPath);

    setStatus({ kind: 'locating' });
    const located = await locateZcode({
      configuredPath,
      env: baseEnv,
      platform: process.platform,
      fallbackNodePath: process.execPath,
    });
    if (current !== generation) return;

    if (located.kind === 'notFound') {
      host.log(`找不到 ZCode 运行时${located.configuredPathInvalid ? `（配置路径无效：${configuredPath}）` : ''}`);
      host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
      const detail = located.configuredPathInvalid
        ? t('zcode.invalidPath', configuredPath)
        : (profile.installHint ?? t('zcode.hint'));
      setStatus({ kind: 'notInstalled', detail });
      return;
    }

    const statMeta = await verifyZcodeTarget(located.targetPath, process.platform);
    if (current !== generation) return;

    const cached = host.getCachedExecutable?.(profile.id, cmdSpec);
    let version = cached?.version ?? '';
    if (!version && located.scriptArgs.length === 0) {
      version = (await probeCommandVersion(located.command, baseEnv, process.platform)) ?? '';
    }
    if (current !== generation) return;

    host.setCachedExecutable?.(profile.id, cmdSpec, {
      command: located.targetPath,
      ...(version ? { version } : {}),
      ...(statMeta ? { mtimeMs: statMeta.mtimeMs, size: statMeta.size } : {}),
    });

    setStatus({ kind: 'starting', ...(version ? { version } : {}) });
    let spawnEnv: Record<string, string | undefined> = { ...baseEnv, ...located.extraEnv };
    const boundProvider = host.boundProvider?.(profile.id);
    if (boundProvider && host.ensureProviderProxy) {
      try {
        const proxy = await host.ensureProviderProxy();
        if (current !== generation) return;
        const adapted = await prepareAcpProviderRuntime({
          profile: { id: profile.id, name: profile.name, command: located.command, args: [] },
          provider: boundProvider,
          proxyOrigin: proxy.origin,
          proxyToken: proxy.token,
          storageDir: host.storageRoot,
          baseEnv: spawnEnv,
          protocolGatewayEnabled: host.isProtocolGatewayEnabled?.() ?? false,
        });
        if (current !== generation) return;
        if (adapted) spawnEnv = adapted.env;
      } catch (error) {
        host.log(`准备服务商 ${boundProvider.name} 的 ZCode 配置失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (host.prepareAccountLaunch) {
      try {
        const accountPatch = await host.prepareAccountLaunch(profile.id, spawnEnv);
        if (current !== generation) return;
        if (accountPatch) spawnEnv = accountPatch.env;
      } catch (error) {
        host.log(`准备 ZCode 官方账号环境失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const spawnArgs = [...located.scriptArgs, 'app-server', '--stdio'];
    const conn = new ZcodeConnection({
      command: located.command,
      args: spawnArgs,
      cwd: host.workspacePath(),
      env: spawnEnv,
      log: host.log,
      onStderr: (line) => host.runtimeLog(line, 'stderr'),
      trace: (direction, line) => {
        if (!host.settings.get<boolean>('backendTrace', false)) return;
        host.runtimeLog(
          `${direction === 'in' ? '←' : '→'} ${line.length > TRACE_LIMIT ? `${line.slice(0, TRACE_LIMIT)}…(${line.length})` : line}`,
          'stdout',
        );
      },
      onNotification: (method, params) => controller.onNotification(method, params),
      onRequest: (method, params) => controller.onAgentRequest(method, params),
      onExit: (code, signal, stderr) => {
        if (current !== generation) return;
        host.log(`ZCode 退出（${signal ?? code}）`);
        connection = undefined;
        controller.setLink(undefined);
        setStatus({
          kind: 'failed',
          message: t('acp.exited', profile.name, stderr.split('\n').slice(-5).join('\n') || String(signal ?? code)),
        });
      },
    });
    connection = conn;

    try {
      await conn.start();
      host.log(`已启动 ZCode：${located.command} ${spawnArgs.join(' ')}`);
      // 探测进程已可处理控制面消息（即使返回方法不存在等业务错误也说明 NDJSON 通道就绪）
      await conn.request('session/list', { limit: 1 }, STARTUP_PROBE_TIMEOUT_MS).catch((err: unknown) => {
        if (err instanceof ZcodeTimeoutError || !conn.running) throw err;
      });
      if (current !== generation) return;
      setStatus({ kind: 'connected', version, newerThanTested: false });
      controller.setLink(conn);
    } catch (error) {
      if (current !== generation) return;
      const message =
        error instanceof ZcodeTimeoutError
          ? t('zcode.initTimeout', STARTUP_PROBE_TIMEOUT_MS / 1000)
          : error instanceof Error
            ? error.message
            : String(error);
      host.log(`启动 ZCode 失败：${message}`);
      connection = undefined;
      await conn.dispose();
      setStatus({ kind: 'failed', message });
    }
  };

  const stopConnection = async (): Promise<void> => {
    generation++;
    const conn = connection;
    connection = undefined;
    controller.setLink(undefined);
    await conn?.dispose();
  };

  const restart = async (): Promise<void> => {
    await stopConnection();
    await start();
  };

  return {
    profile,
    controller,
    start: () => void start(),
    restart: () => void restart(),
    currentStatus: () => status,
    stop: async () => {
      await stopConnection();
      controller.dispose();
    },
  };
}

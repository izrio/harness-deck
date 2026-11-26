/**
 * OpenAI Codex 原生底层生命周期管理：
 * 查找本机 `codex` 命令，准备第三方服务商 `-c` 覆盖参数与统一 MCP 服务器参数，
 * 以 `codex app-server --listen stdio://` 启动长驻子进程，完成 `initialize` / `initialized` 握手
 * 并挂载 `CodexController`。
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import { buildProviderProxyScope } from '../accounts/SessionIsolationStore.ts';
import type { StoredSession } from '../acp/AcpController.ts';
import { CodexConnection, CodexTimeoutError } from '../codex/connection.ts';
import { CodexController, type CodexPreferredModel } from '../codex/CodexController.ts';
import { locateCodex } from '../codex/locate.ts';
import { t } from '../i18n.ts';
import { prepareCodexProviderRuntime } from '../providers/ProviderRuntime.ts';
import { verifyExecutableFile } from '../runtime/locate.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import { probeCommandVersion } from './npmManager.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

const TRACE_LIMIT = 4_000;
const STARTUP_PROBE_TIMEOUT_MS = 15_000;

export function createCodexBackend(
  profile: Extract<BackendProfile, { kind: 'codex' }>,
  host: BackendHost,
): RunningBackend {
  const state = host.workspaceState;
  const key = (name: string) => host.stateKey(`codex.${name}`);
  const modelKey = `harnessDeck.${profile.id}.model`;
  const sessionModelsKey = `harnessDeck.sessionModels.${profile.id}`;
  let status: RuntimeStatus = { kind: 'idle' };
  let connection: CodexConnection | undefined;
  let generation = 0;

  const common = host.controllerOptions();
  const controller = new CodexController({
    ...common,
    workspacePath: host.workspacePath(),
    restartRuntime: () => void restart(),
    loadActiveSessionId: () => state.get<string>(key('activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(key('activeSessionId'), sessionId),
    loadSessions: () => state.get<StoredSession[]>(key('sessions')),
    saveSessions: (sessions) => void state.update(key('sessions'), [...sessions]),
    loadPreferredModel: () => host.globalState.get<CodexPreferredModel>(modelKey),
    savePreferredModel: (preferred) => void host.globalState.update(modelKey, preferred),
    loadSessionModels: () => host.globalState.get<Record<string, CodexPreferredModel>>(sessionModelsKey),
    saveSessionModels: (models) => void host.globalState.update(sessionModelsKey, models),
    loadOpenTabs: () => state.get<string[]>(key('openTabs')),
    saveOpenTabs: (ids) => void state.update(key('openTabs'), [...ids]),
    ...(profile.signInHint ? { signInHint: profile.signInHint } : {}),
    boundProvider: () => host.boundProvider?.(profile.id),
    ...(host.onProviderModelSelected
      ? {
          onProviderModelSelected: (providerId: string, model: string, sessionId?: string) =>
            host.onProviderModelSelected?.(providerId, model, {
              backendId: profile.id,
              ...(sessionId ? { sessionId } : {}),
            }),
        }
      : {}),
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
    const configuredPath = host.settings.get<string>('codex.path', '');
    const baseEnv = host.processEnv();
    const cmdSpec = commandSpecForProfile(profile, '', '', '', '', configuredPath);

    const cached = host.getCachedExecutable?.(profile.id, cmdSpec);
    let verifiedStat = cached ? await verifyExecutableFile(cached.command, process.platform) : undefined;
    if (current !== generation) return;

    let executablePath = verifiedStat?.command;
    if (!executablePath) {
      if (cached) host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
      setStatus({ kind: 'locating' });
      const located = await locateCodex({
        configuredPath,
        env: baseEnv,
        platform: process.platform,
      });
      if (current !== generation) return;
      if (located.kind === 'notFound') {
        host.log(`找不到 Codex 命令${located.configuredPathInvalid ? `（配置路径无效：${configuredPath}）` : ''}`);
        host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
        const detail = located.configuredPathInvalid
          ? t('codex.invalidPath', configuredPath)
          : (profile.installHint ?? t('codex.hint'));
        setStatus({ kind: 'notInstalled', detail });
        return;
      }
      executablePath = located.command;
      verifiedStat = await verifyExecutableFile(executablePath, process.platform);
      if (current !== generation) return;
    }

    let version = cached?.version ?? '';
    if (!version) {
      version = (await probeCommandVersion(executablePath, baseEnv, process.platform)) ?? '';
    }
    if (current !== generation) return;

    host.setCachedExecutable?.(profile.id, cmdSpec, {
      command: executablePath,
      ...(version ? { version } : {}),
      ...(verifiedStat ? { mtimeMs: verifiedStat.mtimeMs, size: verifiedStat.size } : {}),
    });

    setStatus({ kind: 'starting', ...(version ? { version } : {}) });
    let launchEnv: Record<string, string | undefined> = baseEnv;
    let extraArgs: string[] = [];

    const boundProvider = host.boundProvider?.(profile.id);
    if (boundProvider && host.ensureProviderProxy) {
      try {
        const proxy = await host.ensureProviderProxy();
        if (current !== generation) return;
        const adapted = prepareCodexProviderRuntime({
          provider: boundProvider,
          proxyOrigin: proxy.origin,
          proxyToken: proxy.token,
          baseEnv,
          proxyScope: buildProviderProxyScope(profile.id),
        });
        if (adapted) {
          launchEnv = adapted.env;
          extraArgs = [...extraArgs, ...adapted.args];
          const savedPref = host.globalState.get<CodexPreferredModel>(modelKey);
          const chosen =
            (savedPref?.provider === boundProvider.id ? savedPref.model : undefined) ??
            boundProvider.defaultModel ??
            boundProvider.models[0]?.id;
          if (chosen) host.onProviderModelSelected?.(boundProvider.id, chosen, { backendId: profile.id });
        }
      } catch (error) {
        host.log(`准备服务商 ${boundProvider.name} 的 Codex 配置失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (host.prepareAccountLaunch) {
      try {
        const accountPatch = await host.prepareAccountLaunch(profile.id, launchEnv);
        if (current !== generation) return;
        if (accountPatch) {
          launchEnv = accountPatch.env;
        }
      } catch (error) {
        host.log(`准备 Codex 官方账号环境失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (host.prepareBackendLaunch) {
      try {
        const prepared = await host.prepareBackendLaunch(profile);
        if (current !== generation) return;
        if (prepared.extraArgs.length > 0) {
          extraArgs = [...extraArgs, ...prepared.extraArgs];
        }
      } catch (error) {
        host.log(`准备 Codex 的扩展配置失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const spawnArgs = ['app-server', '--listen', 'stdio://', ...extraArgs];
    const conn = new CodexConnection({
      command: executablePath,
      args: spawnArgs,
      cwd: host.workspacePath(),
      env: launchEnv,
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
      onRequest: (method, params, requestId) => controller.onAgentRequest(method, params, requestId),
      onExit: (code, signal, stderr) => {
        if (current !== generation) return;
        host.log(`Codex 退出（${signal ?? code}）`);
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
      host.log(`已启动 Codex：${executablePath} ${spawnArgs.join(' ')}`);
      await conn.initialize(host.extensionVersion, STARTUP_PROBE_TIMEOUT_MS);
      if (current !== generation) return;
      setStatus({ kind: 'connected', version, newerThanTested: false });
      controller.setLink(conn);
    } catch (error) {
      if (current !== generation) return;
      const message =
        error instanceof CodexTimeoutError
          ? t('codex.initTimeout', STARTUP_PROBE_TIMEOUT_MS / 1000)
          : error instanceof Error
            ? error.message
            : String(error);
      host.log(`启动 Codex 失败：${message}`);
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

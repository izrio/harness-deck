/**
 * Pi Coding Agent 原生底层生命周期管理：
 * 查找本机 `pi` 命令，准备第三方服务商代理配置（`models.json` + `PI_CODING_AGENT_DIR`）与 `--skill` 挂载参数，
 * 以 `pi --mode rpc` 启动长驻子进程，接管 NDJSON 双向通信并挂载 `PiController`。
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import type { StoredSession } from '../acp/AcpController.ts';
import { t } from '../i18n.ts';
import { PiConnection, PiTimeoutError } from '../pi/connection.ts';
import { locatePi } from '../pi/locate.ts';
import { PiController, type PiPreferredModel, type PiRpcState } from '../pi/PiController.ts';
import { resolvePiAgentDir } from '../pi/sessions.ts';
import { preparePiProviderRuntime } from '../providers/ProviderRuntime.ts';
import { verifyExecutableFile } from '../runtime/locate.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import { probeCommandVersion } from './npmManager.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

const TRACE_LIMIT = 4_000;
const STARTUP_PROBE_TIMEOUT_MS = 15_000;

export function createPiBackend(
  profile: Extract<BackendProfile, { kind: 'pi' }>,
  host: BackendHost,
): RunningBackend {
  const state = host.workspaceState;
  const key = (name: string) => host.stateKey(`pi.${name}`);
  let status: RuntimeStatus = { kind: 'idle' };
  let connection: PiConnection | undefined;
  let generation = 0;
  let currentPiAgentDir: string | undefined;

  const common = host.controllerOptions();
  const controller = new PiController({
    ...common,
    workspacePath: host.workspacePath(),
    restartRuntime: () => void restart(),
    loadActiveSessionId: () => state.get<string>(key('activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(key('activeSessionId'), sessionId),
    loadSessions: () => state.get<StoredSession[]>(key('sessions')),
    saveSessions: (sessions) => void state.update(key('sessions'), [...sessions]),
    loadPreferredModel: () => host.globalState.get<PiPreferredModel>('harnessDeck.pi.model'),
    savePreferredModel: (preferred) => void host.globalState.update('harnessDeck.pi.model', preferred),
    loadOpenTabs: () => state.get<string[]>(key('openTabs')),
    saveOpenTabs: (ids) => void state.update(key('openTabs'), [...ids]),
    piAgentDir: () => currentPiAgentDir ?? resolvePiAgentDir(host.processEnv()),
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
    const configuredPath = host.settings.get<string>('pi.path', '');
    const baseEnv = host.processEnv();
    const cmdSpec = commandSpecForProfile(profile, '', '', '', configuredPath);

    const cached = host.getCachedExecutable?.(profile.id, cmdSpec);
    let verifiedStat = cached ? await verifyExecutableFile(cached.command, process.platform) : undefined;
    if (current !== generation) return;

    let executablePath = verifiedStat?.command;
    if (!executablePath) {
      if (cached) host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
      setStatus({ kind: 'locating' });
      const located = await locatePi({
        configuredPath,
        env: baseEnv,
        platform: process.platform,
      });
      if (current !== generation) return;
      if (located.kind === 'notFound') {
        host.log(`找不到 Pi 命令${located.configuredPathInvalid ? `（配置路径无效：${configuredPath}）` : ''}`);
        host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
        const detail = located.configuredPathInvalid
          ? t('pi.invalidPath', configuredPath)
          : (profile.installHint ?? t('pi.hint'));
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
    currentPiAgentDir = undefined;

    const boundProvider = host.boundProvider?.(profile.id);
    if (boundProvider && host.ensureProviderProxy) {
      try {
        const proxy = await host.ensureProviderProxy();
        if (current !== generation) return;
        const adapted = await preparePiProviderRuntime({
          provider: boundProvider,
          proxyOrigin: proxy.origin,
          proxyToken: proxy.token,
          storageDir: host.storageRoot,
          baseEnv,
        });
        if (current !== generation) return;
        if (adapted) {
          launchEnv = adapted.env;
          extraArgs = [...adapted.args];
          currentPiAgentDir = adapted.env.PI_CODING_AGENT_DIR;
          const savedPref = host.globalState.get<PiPreferredModel>('harnessDeck.pi.model');
          const chosen = savedPref?.model ?? boundProvider.defaultModel ?? boundProvider.models[0]?.id;
          if (chosen) host.onProviderModelSelected?.(boundProvider.id, chosen);
        }
      } catch (error) {
        host.log(`准备服务商 ${boundProvider.name} 的 Pi 配置失败：${error instanceof Error ? error.message : String(error)}`);
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
        host.log(`准备 Pi 的 Skills 挂载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const conn = new PiConnection({
      command: executablePath,
      extraArgs,
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
      onEvent: (event) => controller.onEvent(event),
      onUiRequest: (req) => controller.onUiRequest(req),
      onUiNotify: (req) => controller.onUiNotify(req),
      onExit: (code, signal, stderr) => {
        if (current !== generation) return;
        host.log(`Pi 退出（${signal ?? code}）`);
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
      host.log(`已启动 Pi：${executablePath} --mode rpc ${extraArgs.join(' ')}`);
      const initialState = await conn.request<PiRpcState>('get_state', {}, STARTUP_PROBE_TIMEOUT_MS);
      if (current !== generation) return;
      setStatus({ kind: 'connected', version, newerThanTested: false });
      controller.setLink(conn, initialState);
    } catch (error) {
      if (current !== generation) return;
      const message =
        error instanceof PiTimeoutError
          ? t('pi.initTimeout', STARTUP_PROBE_TIMEOUT_MS / 1000)
          : error instanceof Error
            ? error.message
            : String(error);
      host.log(`启动 Pi 失败：${message}`);
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

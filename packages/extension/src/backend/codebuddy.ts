/**
 * CodeBuddy 原生底层生命周期管理：
 * 查找本机 `codebuddy` / `cbc` 命令，准备第三方服务商代理环境（`ProviderRuntime`）及 Skills / MCP 挂载配置，
 * 按会话以 `codebuddy -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
 * 启动独立双向流式进程并挂载 `CodebuddyController`，实现多会话并发运行。
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import type { StoredSession } from '../acp/AcpController.ts';
import { CodebuddyConnection } from '../codebuddy/connection.ts';
import {
  CodebuddyController,
  type CodebuddyAvailableModelsMetadata,
  type CodebuddyInitMetadata,
  type CodebuddyPreferredModel,
} from '../codebuddy/CodebuddyController.ts';
import { locateCodebuddy } from '../codebuddy/locate.ts';
import { resolveCodebuddyConfigDir } from '../codebuddy/sessions.ts';
import type { PreparedBackendLaunch } from '../extensions/mcpService.ts';
import { t } from '../i18n.ts';
import { prepareCodebuddyProviderRuntime } from '../providers/ProviderRuntime.ts';
import { verifyExecutableFile } from '../runtime/locate.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import { probeCommandVersion } from './npmManager.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

const TRACE_LIMIT = 4_000;

export function createCodebuddyBackend(
  profile: Extract<BackendProfile, { kind: 'codebuddy' }>,
  host: BackendHost,
): RunningBackend {
  const state = host.workspaceState;
  // 兼容旧版 ACP CodeBuddy 的会话与标签缓存键，同时优先使用原生键
  const key = (name: string) => host.stateKey(`codebuddy.${name}`);
  const legacyKey = (name: string) => host.stateKey(`acp.codebuddy.${name}`);
  let status: RuntimeStatus = { kind: 'idle' };
  let generation = 0;
  let currentCodebuddyConfigDir: string | undefined;

  const common = host.controllerOptions();
  const controller = new CodebuddyController({
    ...common,
    workspacePath: host.workspacePath(),
    restartRuntime: () => void restart(),
    loadActiveSessionId: () => state.get<string>(key('activeSessionId')) ?? state.get<string>(legacyKey('activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(key('activeSessionId'), sessionId),
    loadSessions: () => state.get<StoredSession[]>(key('sessions')) ?? state.get<StoredSession[]>(legacyKey('sessions')),
    saveSessions: (sessions) => void state.update(key('sessions'), [...sessions]),
    loadPreferredModel: () =>
      host.globalState.get<CodebuddyPreferredModel>('harnessDeck.codebuddy.model') ??
      (() => {
        const legacy = host.globalState.get<{ readonly model: string; readonly effort?: string }>('harnessDeck.acp.codebuddy.model');
        return legacy?.model
          ? { provider: 'codebuddy', model: legacy.model, ...(legacy.effort ? { effort: legacy.effort } : {}) }
          : undefined;
      })(),
    savePreferredModel: (preferred) => void host.globalState.update('harnessDeck.codebuddy.model', preferred),
    loadOpenTabs: () => state.get<string[]>(key('openTabs')) ?? state.get<string[]>(legacyKey('openTabs')),
    saveOpenTabs: (ids) => void state.update(key('openTabs'), [...ids]),
    codebuddyConfigDir: () => currentCodebuddyConfigDir ?? resolveCodebuddyConfigDir(host.processEnv()),
    ...(profile.signInHint ? { signInHint: profile.signInHint } : {}),
    boundProvider: () => host.boundProvider?.(profile.id),
    ...(host.onProviderModelSelected ? { onProviderModelSelected: host.onProviderModelSelected } : {}),
  });

  const setStatus = (next: RuntimeStatus): void => {
    status = next;
    controller.setRuntimeStatus(next);
    host.onStatus(next);
  };

  /** 轻量探测一次 `initialize`，提前填充模型列表和斜杠命令后立即退出。 */
  const probeInitMetadata = async (
    command: string,
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
    currentGen: number,
  ): Promise<void> => {
    const probe = new CodebuddyConnection({
      command,
      cwd,
      env,
      onControlRequest: async () => ({ allowed: false, message: 'Probe connection' }),
      onEvent: () => undefined,
      onExit: () => undefined,
    });
    try {
      await probe.start();
      const meta = await probe.sendControlRequest<CodebuddyInitMetadata>({ subtype: 'initialize' }, 10_000);
      if (currentGen === generation && meta) controller.applyInitMetadata(meta);
      const available = await probe
        .sendControlRequest<CodebuddyAvailableModelsMetadata>({ subtype: 'get_available_models' }, 5_000)
        .catch(() => undefined);
      if (currentGen === generation && available) controller.applyAvailableModels(available);
    } catch {
      // 探测失败不影响使用，降级为内置默认模型列表并在首次发消息时再获取
    } finally {
      await probe.dispose().catch(() => undefined);
    }
  };

  const start = async (): Promise<void> => {
    if (!host.isWorkspaceTrusted()) {
      setStatus({ kind: 'untrusted' });
      return;
    }
    if (status.kind === 'connected') return;
    const current = ++generation;
    const configuredPath = host.settings.get<string>('codebuddy.path', '');
    const baseEnv = host.processEnv();
    const cmdSpec = commandSpecForProfile(profile, '', '', '', '', '', configuredPath);

    const cached = host.getCachedExecutable?.(profile.id, cmdSpec);
    let verifiedStat = cached ? await verifyExecutableFile(cached.command, process.platform) : undefined;
    if (current !== generation) return;

    let executablePath = verifiedStat?.command;
    if (!executablePath) {
      if (cached) host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
      setStatus({ kind: 'locating' });
      const located = await locateCodebuddy({
        configuredPath,
        env: baseEnv,
        platform: process.platform,
      });
      if (current !== generation) return;
      if (located.kind === 'notFound') {
        host.log(`找不到 CodeBuddy 命令${located.configuredPathInvalid ? `（配置路径无效：${configuredPath}）` : ''}`);
        host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
        const detail = located.configuredPathInvalid
          ? t('codebuddy.invalidPath', configuredPath)
          : (profile.installHint ?? t('codebuddy.hint'));
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
    let prepared: PreparedBackendLaunch | undefined;
    if (host.prepareBackendLaunch) {
      try {
        prepared = await host.prepareBackendLaunch(profile);
      } catch (error) {
        host.log(`准备 CodeBuddy 的 Skills/MCP 挂载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (current !== generation) return;

    const resolvedCmd = executablePath;
    let probeEnv: Record<string, string | undefined> = baseEnv;
    currentCodebuddyConfigDir = undefined;
    if (!host.boundProvider?.(profile.id) && host.prepareAccountLaunch) {
      const prePatch = await host.prepareAccountLaunch(profile.id, baseEnv).catch(() => undefined);
      if (current !== generation) return;
      if (prePatch) {
        probeEnv = prePatch.env;
        currentCodebuddyConfigDir = prePatch.configDir;
      }
    }
    controller.setSpawner(async (spawnParams) => {
      let launchEnv: Record<string, string | undefined> = host.processEnv();
      const boundProvider = host.boundProvider?.(profile.id);
      if (boundProvider && host.ensureProviderProxy) {
        currentCodebuddyConfigDir = undefined;
        try {
          const proxy = await host.ensureProviderProxy();
          const adapted = prepareCodebuddyProviderRuntime({
            provider: boundProvider,
            proxyOrigin: proxy.origin,
            proxyToken: proxy.token,
            baseEnv: launchEnv,
          });
          if (adapted) {
            launchEnv = adapted.env;
            const chosen = spawnParams.model ?? boundProvider.defaultModel ?? boundProvider.models[0]?.id;
            if (chosen) host.onProviderModelSelected?.(boundProvider.id, chosen);
            host.log(`CodeBuddy 已绑定服务商 ${boundProvider.name}，代理地址：${adapted.env.CODEBUDDY_BASE_URL}`);
          } else {
            host.log(
              `服务商 ${boundProvider.name} 未满足 CodeBuddy 协议要求（需配置 OpenAI Chat 地址），本次将使用本机默认 CodeBuddy 环境启动。`,
            );
          }
        } catch (error) {
          host.log(`准备服务商 ${boundProvider.name} 的 CodeBuddy 配置失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (host.prepareAccountLaunch) {
        try {
          const accountPatch = await host.prepareAccountLaunch(profile.id, launchEnv);
          if (accountPatch) {
            launchEnv = accountPatch.env;
            currentCodebuddyConfigDir = accountPatch.configDir;
          }
        } catch (error) {
          host.log(`准备 CodeBuddy 官方账号环境失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const extraArgs = [...(prepared?.extraArgs ?? [])];
      const conn = new CodebuddyConnection({
        command: resolvedCmd,
        ...(spawnParams.resumeSessionId ? { resumeSessionId: spawnParams.resumeSessionId } : {}),
        ...(spawnParams.model ? { model: spawnParams.model } : {}),
        ...(spawnParams.effort ? { effort: spawnParams.effort } : {}),
        ...(spawnParams.permissionMode ? { permissionMode: spawnParams.permissionMode } : {}),
        extraArgs,
        cwd: spawnParams.cwd,
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
        onControlRequest: spawnParams.onControlRequest,
        onEvent: spawnParams.onEvent,
        onExit: spawnParams.onExit,
      });
      await conn.start();
      host.log(`已启动 CodeBuddy 会话进程：${resolvedCmd} -p${spawnParams.resumeSessionId ? ` --resume ${spawnParams.resumeSessionId}` : ''}`);
      return conn;
    });

    setStatus({ kind: 'connected', version, newerThanTested: false });
    void probeInitMetadata(resolvedCmd, host.workspacePath(), probeEnv, current);
  };

  const stopAll = async (): Promise<void> => {
    generation++;
    controller.setSpawner(undefined);
    status = { kind: 'idle' };
  };

  const restart = async (): Promise<void> => {
    await stopAll();
    await start();
  };

  return {
    profile,
    controller,
    start: () => void start(),
    restart: () => void restart(),
    currentStatus: () => status,
    stop: async () => {
      await stopAll();
      controller.dispose();
    },
  };
}

/**
 * Claude Code 原生底层生命周期管理：
 * 查找本机 `claude` 命令，准备第三方服务商代理环境（`ProviderRuntime`）及 Skills / MCP 挂载配置，
 * 按会话以 `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`
 * 启动双向流式进程并挂载 `ClaudeController`。
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import type { StoredSession } from '../acp/AcpController.ts';
import { ClaudeConnection } from '../claude/connection.ts';
import { ClaudeController, type ClaudePreferredModel } from '../claude/ClaudeController.ts';
import { locateClaude } from '../claude/locate.ts';
import { resolveClaudeConfigDir } from '../claude/sessions.ts';
import type { PreparedBackendLaunch } from '../extensions/mcpService.ts';
import { t } from '../i18n.ts';
import { prepareClaudeProviderRuntime } from '../providers/ProviderRuntime.ts';
import { verifyExecutableFile } from '../runtime/locate.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import { probeCommandVersion } from './npmManager.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

const TRACE_LIMIT = 4_000;

export function createClaudeBackend(
  profile: Extract<BackendProfile, { kind: 'claude' }>,
  host: BackendHost,
): RunningBackend {
  const state = host.workspaceState;
  // 兼容旧版 ACP Claude Code 的会话标题缓存键，同时优先使用原生键
  const key = (name: string) => host.stateKey(`claude.${name}`);
  const legacyKey = (name: string) => host.stateKey(`acp.claude.${name}`);
  let status: RuntimeStatus = { kind: 'idle' };
  let generation = 0;

  const common = host.controllerOptions();
  const controller = new ClaudeController({
    ...common,
    workspacePath: host.workspacePath(),
    restartRuntime: () => void restart(),
    loadActiveSessionId: () => state.get<string>(key('activeSessionId')) ?? state.get<string>(legacyKey('activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(key('activeSessionId'), sessionId),
    loadSessions: () => state.get<StoredSession[]>(key('sessions')) ?? state.get<StoredSession[]>(legacyKey('sessions')),
    saveSessions: (sessions) => void state.update(key('sessions'), [...sessions]),
    loadPreferredModel: () => host.globalState.get<ClaudePreferredModel>('harnessDeck.claude.model'),
    savePreferredModel: (preferred) => void host.globalState.update('harnessDeck.claude.model', preferred),
    loadOpenTabs: () => state.get<string[]>(key('openTabs')) ?? state.get<string[]>(legacyKey('openTabs')),
    saveOpenTabs: (ids) => void state.update(key('openTabs'), [...ids]),
    claudeConfigDir: () => resolveClaudeConfigDir(host.processEnv()),
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
    if (status.kind === 'connected') return;
    const current = ++generation;
    const configuredPath = host.settings.get<string>('claude.path', '');
    const baseEnv = host.processEnv();
    const cmdSpec = commandSpecForProfile(profile, '', '', configuredPath);

    const cached = host.getCachedExecutable?.(profile.id, cmdSpec);
    let verifiedStat = cached ? await verifyExecutableFile(cached.command, process.platform) : undefined;
    if (current !== generation) return;

    let executablePath = verifiedStat?.command;
    if (!executablePath) {
      if (cached) host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
      setStatus({ kind: 'locating' });
      const located = await locateClaude({
        configuredPath,
        env: baseEnv,
        platform: process.platform,
      });
      if (current !== generation) return;
      if (located.kind === 'notFound') {
        host.log(`找不到 Claude Code 命令${located.configuredPathInvalid ? `（配置路径无效：${configuredPath}）` : ''}`);
        host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
        const detail = located.configuredPathInvalid
          ? t('claude.invalidPath', configuredPath)
          : (profile.installHint ?? t('claude.hint'));
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
        host.log(`准备 Claude Code 的 Skills/MCP 挂载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (current !== generation) return;

    const resolvedCmd = executablePath;
    controller.setSpawner(async (spawnParams) => {
      let launchEnv: Record<string, string | undefined> = host.processEnv();
      const boundProvider = host.boundProvider?.(profile.id);
      if (boundProvider && host.ensureProviderProxy) {
        try {
          const proxy = await host.ensureProviderProxy();
          const adapted = prepareClaudeProviderRuntime({
            provider: boundProvider,
            proxyOrigin: proxy.origin,
            proxyToken: proxy.token,
            baseEnv: launchEnv,
            protocolGatewayEnabled: host.isProtocolGatewayEnabled?.() ?? false,
          });
          if (adapted) {
            launchEnv = adapted.env;
            const chosen = spawnParams.model ?? boundProvider.defaultModel ?? boundProvider.models[0]?.id;
            if (chosen) host.onProviderModelSelected?.(boundProvider.id, chosen);
          }
        } catch (error) {
          host.log(`准备服务商 ${boundProvider.name} 的 Claude Code 配置失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (spawnParams.effort) {
        launchEnv = { ...launchEnv, CLAUDE_CODE_EFFORT_LEVEL: spawnParams.effort };
      }

      const extraArgs = prepared?.extraArgs ?? [];
      const conn = new ClaudeConnection({
        command: resolvedCmd,
        ...(spawnParams.resumeSessionId ? { resumeSessionId: spawnParams.resumeSessionId } : {}),
        ...(spawnParams.model ? { model: spawnParams.model } : {}),
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
      host.log(`已启动 Claude Code 会话进程：${resolvedCmd} -p${spawnParams.resumeSessionId ? ` --resume ${spawnParams.resumeSessionId}` : ''}`);
      return conn;
    });

    setStatus({ kind: 'connected', version, newerThanTested: false });
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

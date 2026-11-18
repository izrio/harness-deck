/**
 * ACP 底层：按设置里的命令启动代理（例如 `omp acp`），`initialize` 之后交给 AcpController。
 * 代理意外退出时显示失败和最后几行错误输出，可以从横幅里重试。
 */
import type { RuntimeStatus } from '@harness-deck/shared';
import { AcpController, type AcpInitialize, type AuthMethod, type PreferredModel, type StoredSession } from '../acp/AcpController.ts';
import { AcpConnection, AcpTimeoutError } from '../acp/connection.ts';
import {
  detectAcpSkillMode,
  mcpServersForBackend,
  type AcpSkillInjectionMode,
  type PreparedBackendLaunch,
} from '../extensions/mcpService.ts';
import { skillsForBackend } from '../extensions/skillService.ts';
import { prepareAcpProviderRuntime } from '../providers/ProviderRuntime.ts';
import { locateExecutable, verifyExecutableFile } from '../runtime/locate.ts';
import { t } from '../i18n.ts';
import { commandSpecForProfile } from './envCache.ts';
import type { BackendHost } from './host.ts';
import type { BackendProfile, RunningBackend } from './types.ts';

/** 协议版本：ACP v1。 */
const PROTOCOL_VERSION = 1;
/** 排查日志里每条消息最多保留的字符数。 */
const TRACE_LIMIT = 4_000;
/** 握手最多等多久：设置里的命令不是 ACP 代理（不回复 initialize）时，不能一直停在「启动中」。 */
const INITIALIZE_TIMEOUT_MS = 30_000;

export function createAcpBackend(profile: Extract<BackendProfile, { kind: 'acp' }>, host: BackendHost): RunningBackend {
  const state = host.workspaceState;
  const key = (name: string) => host.stateKey(`acp.${profile.id}.${name}`);
  let status: RuntimeStatus = { kind: 'idle' };
  let connection: AcpConnection | undefined;
  let generation = 0;
  let latestPrepared: PreparedBackendLaunch | undefined;
  const fallbackSkillMode: AcpSkillInjectionMode = (() => {
    const kind = detectAcpSkillMode(profile);
    return kind === 'claude' ? 'claude-meta' : kind === 'generic' ? 'prompt' : 'cli';
  })();

  const common = host.controllerOptions();
  const controller = new AcpController({
    ...common,
    workspacePath: host.workspacePath(),
    backendName: profile.name,
    restartRuntime: () => void restart(),
    loadActiveSessionId: () => state.get<string>(key('activeSessionId')),
    saveActiveSessionId: (sessionId) => void state.update(key('activeSessionId'), sessionId),
    loadSessions: () => state.get<StoredSession[]>(key('sessions')),
    saveSessions: (sessions) => void state.update(key('sessions'), [...sessions]),
    // 模型选择按用户记（不分工作区）：换个项目打开，新对话也是上次选的模型
    loadPreferredModel: () => host.globalState.get<PreferredModel>(`harnessDeck.acp.${profile.id}.model`),
    savePreferredModel: (preferred) => void host.globalState.update(`harnessDeck.acp.${profile.id}.model`, preferred),
    loadOpenTabs: () => state.get<string[]>(key('openTabs')),
    saveOpenTabs: (ids) => void state.update(key('openTabs'), [...ids]),
    authenticate: (methods, run) => signIn(profile.name, methods, run, host),
    singleSession: profile.singleSession === true,
    ...(profile.signInHint ? { signInHint: profile.signInHint } : {}),
    boundProvider: () => host.boundProvider?.(profile.id),
    ...(host.onProviderModelSelected ? { onProviderModelSelected: host.onProviderModelSelected } : {}),
    mcpServers: () =>
      mcpServersForBackend(common.extensions?.().mcp.servers ?? latestPrepared?.mcpServers ?? [], profile.id),
    skillsContext: () => ({
      skills: skillsForBackend(common.extensions?.().skills.items ?? latestPrepared?.skills ?? [], profile.id),
      ...(latestPrepared?.skillBundleDir ? { bundleDir: latestPrepared.skillBundleDir } : {}),
      mode: latestPrepared?.skillMode ?? fallbackSkillMode,
    }),
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
    const env = host.processEnv(profile.env);
    const cmdSpec = commandSpecForProfile(profile);
    const cached = host.getCachedExecutable?.(profile.id, cmdSpec);
    let verifiedStat = cached ? await verifyExecutableFile(cached.command, process.platform) : undefined;
    if (current !== generation) return;

    let executablePath = verifiedStat?.command;
    if (!executablePath) {
      if (cached) host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
      setStatus({ kind: 'locating' });
      const located = await locateExecutable(profile.command, { env, platform: process.platform });
      if (current !== generation) return;
      if (located.kind === 'notFound') {
        host.log(`找不到 ${profile.name} 的命令 ${profile.command}`);
        host.setCachedExecutable?.(profile.id, cmdSpec, undefined);
        setStatus({ kind: 'notInstalled', detail: profile.installHint ?? t('acp.notFound', profile.command) });
        return;
      }
      executablePath = located.command;
      verifiedStat = await verifyExecutableFile(executablePath, process.platform);
      if (current !== generation) return;
      host.setCachedExecutable?.(profile.id, cmdSpec, {
        command: executablePath,
        ...(verifiedStat ? { mtimeMs: verifiedStat.mtimeMs, size: verifiedStat.size } : {}),
      });
    } else {
      host.log(`使用缓存的 ${profile.name} 命令路径：${executablePath}`);
    }

    setStatus({ kind: 'starting' });
    let launchArgs: readonly string[] = profile.args;
    let launchEnv: Record<string, string | undefined> = env;
    const boundProvider = host.boundProvider?.(profile.id);
    if (boundProvider && host.ensureProviderProxy) {
      try {
        const proxy = await host.ensureProviderProxy();
        if (current !== generation) return;
        const adapted = await prepareAcpProviderRuntime({
          profile,
          provider: boundProvider,
          proxyOrigin: proxy.origin,
          proxyToken: proxy.token,
          storageDir: host.storageRoot,
          baseEnv: env,
          protocolGatewayEnabled: host.isProtocolGatewayEnabled?.() ?? false,
        });
        if (current !== generation) return;
        if (adapted) {
          launchArgs = adapted.args;
          launchEnv = adapted.env;
          const savedPref = host.globalState.get<PreferredModel>(`harnessDeck.acp.${profile.id}.model`);
          const chosen = savedPref?.model ?? boundProvider.defaultModel ?? boundProvider.models[0]?.id;
          if (chosen) host.onProviderModelSelected?.(boundProvider.id, chosen);
        }
      } catch (error) {
        host.log(`准备服务商 ${boundProvider.name} 的 ${profile.name} 配置失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (host.prepareBackendLaunch) {
      try {
        latestPrepared = await host.prepareBackendLaunch(profile);
        if (current !== generation) return;
        if (latestPrepared.extraArgs.length > 0) {
          launchArgs = [...launchArgs, ...latestPrepared.extraArgs];
        }
      } catch (error) {
        host.log(`准备 ${profile.name} 的 Skills/MCP 挂载失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const conn = new AcpConnection({
      command: executablePath,
      args: launchArgs,
      cwd: host.workspacePath(),
      env: launchEnv,
      log: host.log,
      onStderr: (line) => host.runtimeLog(line, 'stderr'),
      // 排查用：设置 harnessDeck.backendTrace 打开后，收发的 ACP 消息原文写到运行日志
      trace: (direction, line) => {
        if (!host.settings.get<boolean>('backendTrace', false)) return;
        host.runtimeLog(`${direction === 'in' ? '←' : '→'} ${line.length > TRACE_LIMIT ? `${line.slice(0, TRACE_LIMIT)}…(${line.length})` : line}`, 'stdout');
      },
      onNotification: (method, params) => {
        if (method === 'session/update') controller.onSessionUpdate(params);
      },
      onRequest: (method, params) => controller.onAgentRequest(method, params),
      onExit: (code, signal, stderr) => {
        if (current !== generation) return;
        host.log(`${profile.name} 退出（${signal ?? code}）`);
        connection = undefined;
        controller.setLink(undefined);
        setStatus({ kind: 'failed', message: t('acp.exited', profile.name, stderr.split('\n').slice(-5).join('\n') || String(signal ?? code)) });
      },
    });
    connection = conn;
    try {
      await conn.start();
      host.log(`已启动 ${profile.name}：${executablePath} ${profile.args.join(' ')}`);
      const init = await conn.request<AcpInitialize>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // 文件和终端由代理自己处理（不通过编辑器）
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'harness-deck', title: 'Harness Deck', version: host.extensionVersion },
      }, INITIALIZE_TIMEOUT_MS);
      if (current !== generation) return;
      const agent = init.agentInfo;
      host.log(`${profile.name} 就绪：${agent?.title ?? agent?.name ?? ''} ${agent?.version ?? ''}（ACP v${init.protocolVersion ?? '?'}）`);
      if (agent?.version) {
        host.setCachedExecutable?.(profile.id, cmdSpec, {
          command: executablePath,
          version: agent.version,
          ...(verifiedStat ? { mtimeMs: verifiedStat.mtimeMs, size: verifiedStat.size } : {}),
        });
      }
      setStatus({ kind: 'connected', version: agent?.version ?? '', newerThanTested: false });
      controller.setLink(conn, init);
    } catch (error) {
      if (current !== generation) return;
      const message = error instanceof AcpTimeoutError ? t('acp.initTimeout', profile.command, INITIALIZE_TIMEOUT_MS / 1000) : error instanceof Error ? error.message : String(error);
      host.log(`启动 ${profile.name} 失败：${message}`);
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

/**
 * 代理要求登录：只有一种方式时直接用，多种时让用户选（CodeBuddy：iOA、Google/GitHub、微信、企业域名）。
 * 登录请求要等用户在浏览器里完成，期间显示可以取消的进度；取消只是不再等待，代理那边的登录页仍然有效。
 */
async function signIn(
  agent: string,
  methods: readonly AuthMethod[],
  run: (methodId: string) => Promise<unknown>,
  host: BackendHost,
): Promise<boolean> {
  let method = methods[0];
  if (methods.length > 1) {
    const picked = await host.pickQuickItem(
      methods.map((m) => ({ label: m.name || m.id, ...(m.description ? { detail: m.description } : {}), id: m.id })),
      { placeHolder: t('acp.signInPick', agent), ignoreFocusOut: true },
    );
    method = picked ? methods.find((m) => m.id === picked.id) : undefined;
  }
  if (!method) return false;
  const chosen = method;
  host.log(`登录 ${agent}：${chosen.id}`);
  return host.withCancellableProgress(t('acp.signingIn', agent), (onCancel) =>
    new Promise<boolean>((resolve, reject) => {
      onCancel(() => resolve(false));
      run(chosen.id).then(
        () => resolve(true),
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    }),
  );
}

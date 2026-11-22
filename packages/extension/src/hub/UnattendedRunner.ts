/**
 * 定时任务无人值守执行器（UnattendedRunner）。
 *
 * 到点新开一个隔离会话，按设置里的权限预设（默认 `danger-full-access`「全部放行」）无人值守跑完，
 * 收集完整 Markdown 输出写回规则历史，并通过 `onSessionCreated` 立即隐藏后台会话 id，不进入左侧会话列表。
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { AcpInitialize } from '../acp/AcpController.ts';
import { AcpConnection, AcpError, AcpTimeoutError } from '../acp/connection.ts';
import {
  AcpSessionProjection,
  inputFilePath,
  type AcpSessionMeta,
  type AcpToolCall,
} from '../acp/projection.ts';
import type { BackendProfile } from '../backend/types.ts';
import { ClaudeConnection } from '../claude/connection.ts';
import { locateClaude } from '../claude/locate.ts';
import { ClaudeSessionProjection } from '../claude/projection.ts';
import { CodebuddyConnection } from '../codebuddy/connection.ts';
import { locateCodebuddy } from '../codebuddy/locate.ts';
import { CodebuddySessionProjection } from '../codebuddy/projection.ts';
import { CodexConnection, CodexError, CodexTimeoutError } from '../codex/connection.ts';
import { buildCodexUserInput, codexPermissionConfig } from '../codex/CodexController.ts';
import { locateCodex } from '../codex/locate.ts';
import { CodexSessionProjection } from '../codex/projection.ts';
import { toAcpMcpServers, type PreparedBackendLaunch } from '../extensions/mcpService.ts';
import { formatSkillsPromptCatalog } from '../extensions/skillService.ts';
import { DshClient } from '../dsh/DshClient.ts';
import type { WireEvent } from '../dsh/remote/follow.ts';
import { projectEvents } from '../dsh/view/projector.ts';
import { PiConnection, PiTimeoutError } from '../pi/connection.ts';
import { locatePi } from '../pi/locate.ts';
import { PiSessionProjection } from '../pi/projection.ts';
import { launchRuntime, probeVersion, stopRuntime, type LaunchedRuntime } from '../runtime/launch.ts';
import { extraSearchDirsForCommand, locateDsh, locateExecutable } from '../runtime/locate.ts';
import { checkVersionSupport, MINIMUM_DSH_VERSION } from '../runtime/version.ts';
import { canonicalTool } from '../vm/toolNames.ts';
import { parseArguments, toolVariant } from '../vm/toolRows.ts';
import { ZcodeConnection, ZcodeError, ZcodeTimeoutError } from '../zcode/connection.ts';
import { defaultRuntimePreferences, extractZcodeSessionId, ZCODE_DELIVERY_KIND } from '../zcode/interactions.ts';
import { locateZcode } from '../zcode/locate.ts';
import { ZcodeSessionProjection } from '../zcode/projection.ts';

const PROTOCOL_VERSION = 1;
const INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_CHARS = 60_000;

export type SchedulePermissionPreset = 'danger-full-access' | 'workspace-write' | 'read-only';

export interface UnattendedRunRequest {
  readonly profile: BackendProfile;
  readonly projectPath: string;
  readonly prompt: string;
  readonly permission: SchedulePermissionPreset;
  readonly onSessionCreated: (sessionId: string) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface UnattendedRunOutcome {
  readonly status: 'succeeded' | 'failed';
  readonly sessionId?: string;
  readonly output?: string;
  readonly error?: string;
}

export interface UnattendedRunnerHost {
  readonly getActiveDshClient: () => DshClient | undefined;
  readonly getDshConfig: () => {
    readonly configuredPath: string;
    readonly profile: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  readonly getZcodeConfig?: () => {
    readonly configuredPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  readonly getClaudeConfig?: () => {
    readonly configuredPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  readonly getPiConfig?: () => {
    readonly configuredPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  readonly getCodexConfig?: () => {
    readonly configuredPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  readonly getCodebuddyConfig?: () => {
    readonly configuredPath: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  readonly getEnvForProfile: (profileEnv?: Readonly<Record<string, string>>) => Readonly<Record<string, string | undefined>>;
  readonly prepareBackendLaunch?: (profile: BackendProfile) => Promise<PreparedBackendLaunch>;
  readonly extensionVersion: string;
  readonly log: (line: string) => void;
  readonly runtimeLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export class UnattendedRunner {
  constructor(private readonly host: UnattendedRunnerHost) {}

  async run(req: UnattendedRunRequest): Promise<UnattendedRunOutcome> {
    if (req.profile.kind === 'dsh') {
      return this.runDsh(req);
    }
    if (req.profile.kind === 'zcode') {
      return this.runZcode(req.profile, req);
    }
    if (req.profile.kind === 'claude') {
      return this.runClaude(req.profile, req);
    }
    if (req.profile.kind === 'pi') {
      return this.runPi(req.profile, req);
    }
    if (req.profile.kind === 'codex') {
      return this.runCodex(req.profile, req);
    }
    if (req.profile.kind === 'codebuddy') {
      return this.runCodebuddy(req.profile, req);
    }
    return this.runAcp(req.profile, req);
  }

  private async runDsh(req: UnattendedRunRequest): Promise<UnattendedRunOutcome> {
    const existingClient = this.host.getActiveDshClient();
    let tempLaunched: LaunchedRuntime | undefined;
    let tempClient: DshClient | undefined;
    const runAbort = new AbortController();
    const timeout = setTimeout(() => runAbort.abort(new Error('Scheduled task timed out')), req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const waterfallDisposers: (() => void)[] = [];
    let sessionId: string | undefined;

    try {
      let client = existingClient;
      if (!client) {
        const cfg = this.host.getDshConfig();
        const located = await locateDsh({ configuredPath: cfg.configuredPath, env: cfg.env, platform: process.platform });
        if (located.kind === 'notFound') {
          return { status: 'failed', error: 'dsh executable not found in PATH or settings' };
        }
        const version = await probeVersion(located.command, cfg.env, undefined, runAbort.signal);
        const support = checkVersionSupport(version);
        if (support.kind !== 'supported') {
          return { status: 'failed', error: `Unsupported dsh version ${version} (minimum ${MINIMUM_DSH_VERSION})` };
        }
        const prepared = await this.host.prepareBackendLaunch?.(req.profile);
        tempLaunched = await launchRuntime({
          command: located.command,
          profile: cfg.profile,
          ...(prepared && prepared.launcherArgs.length > 0 ? { launcherArgs: prepared.launcherArgs } : {}),
          cwd: req.projectPath,
          env: cfg.env,
          onOutput: this.host.runtimeLog,
          signal: runAbort.signal,
        });
        tempClient = await DshClient.connect({
          origin: tempLaunched.origin,
          token: tempLaunched.token,
          log: this.host.log,
        });
        client = tempClient;
      }

      const { workspaceId } = await client.ensureWorkspace(req.projectPath).catch(() => ({ workspaceId: undefined }));
      sessionId = await client.createSession(workspaceId ? { workspaceId } : { cwd: req.projectPath });
      // 在发任何消息前立即登记隐藏会话 id，确保前台会话列表和交互服务都忽略该会话
      req.onSessionCreated(sessionId);
      const targetSessionId = sessionId;

      waterfallDisposers.push(
        client.events.onWaterfall('approval/request', async (wfReq) => {
          if (wfReq.agentId !== targetSessionId) return { kind: 'next' };
          const allow = req.permission === 'danger-full-access';
          return { kind: 'result', value: allow ? 'allowed-once' : 'rejected' };
        }),
        client.events.onWaterfall('user-questions/request', async (wfReq) => {
          if (wfReq.agentId !== targetSessionId) return { kind: 'next' };
          // 无人值守模式不挂起等待人工回答，直接取消提问让智能体自行决策收尾
          return { kind: 'result', value: { cancelled: true } };
        }),
      );

      await client.executeCommand(sessionId, `/permission ${req.permission}`).catch((err: unknown) => {
        this.host.log(`定时任务设置权限预设 ${req.permission} 提示：${describe(err)}`);
      });

      const events: WireEvent[] = [];
      const seenSeqs = new Set<number>();
      let sawTurnStart = false;
      let turnEnded = false;

      const followAbort = new AbortController();
      const onRunAbort = () => followAbort.abort(runAbort.signal.reason);
      runAbort.signal.addEventListener('abort', onRunAbort, { once: true });

      const pushEvent = (event: WireEvent) => {
        if (seenSeqs.has(event.seq)) return;
        seenSeqs.add(event.seq);
        events.push(event);
        if (event.type === 'turn/start') sawTurnStart = true;
        if (event.type === 'turn/end' && sawTurnStart) {
          turnEnded = true;
          followAbort.abort();
        }
      };

      const followTask = (async () => {
        try {
          for await (const frame of client.follow(targetSessionId, followAbort.signal, this.host.log)) {
            if (frame.type === 'snapshot') {
              for (const rec of frame.records) pushEvent(rec.event);
            } else if (frame.type === 'event') {
              pushEvent(frame.event);
            }
            if (turnEnded) break;
          }
        } catch (err) {
          if (!followAbort.signal.aborted) throw err;
        }
      })();

      await client.prompt(sessionId, req.prompt);
      await followTask;

      if (runAbort.signal.aborted && !turnEnded) {
        await client.cancel(sessionId).catch(() => undefined);
        return {
          status: 'failed',
          sessionId,
          error: describe(runAbort.signal.reason ?? 'Scheduled task aborted'),
        };
      }

      const projected = projectEvents({ events, workspacePath: req.projectPath });
      const assistantTexts = projected.items
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);
      const errorNotices = projected.items
        .filter((item): item is Extract<typeof item, { kind: 'notice' }> => item.kind === 'notice' && item.level === 'error')
        .map((item) => item.text.trim())
        .filter(Boolean);

      const output = assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS);
      if (errorNotices.length > 0 && !output) {
        return {
          status: 'failed',
          sessionId,
          error: errorNotices.join('\n'),
        };
      }
      return {
        status: 'succeeded',
        sessionId,
        output: output || (errorNotices.length > 0 ? errorNotices.join('\n') : ''),
      };
    } catch (error) {
      return {
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: describe(error),
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      for (const dispose of waterfallDisposers) dispose();
      tempClient?.close();
      if (tempLaunched) {
        await stopRuntime(tempLaunched.child).catch(() => undefined);
      }
    }
  }

  private async runAcp(
    profile: Extract<BackendProfile, { kind: 'acp' }>,
    req: UnattendedRunRequest,
  ): Promise<UnattendedRunOutcome> {
    const env = this.host.getEnvForProfile(profile.env);
    const located = await locateExecutable(profile.command, {
      env,
      platform: process.platform,
      extraDirs: extraSearchDirsForCommand(profile.command, env, process.platform),
    });
    if (located.kind === 'notFound') {
      return { status: 'failed', error: profile.installHint ?? `Command not found: ${profile.command}` };
    }

    const projection = new AcpSessionProjection(req.projectPath);
    let sessionId: string | undefined;
    const runAbort = new AbortController();
    const timeout = setTimeout(() => runAbort.abort(new Error('Scheduled task timed out')), req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const prepared = await this.host.prepareBackendLaunch?.(profile);
    const launchArgs = prepared && prepared.extraArgs.length > 0 ? [...profile.args, ...prepared.extraArgs] : profile.args;

    const conn = new AcpConnection({
      command: located.command,
      args: launchArgs,
      cwd: req.projectPath,
      env,
      log: this.host.log,
      onStderr: (line) => this.host.runtimeLog?.(line, 'stderr'),
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        const { sessionId: sid, update } = (params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
        if (sid && (!sessionId || sid === sessionId) && update) {
          projection.apply(update);
        }
      },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') {
          return resolveAcpUnattendedPermission(params, req.permission, req.projectPath);
        }
        throw new AcpError(method, -32601, `${method} is not supported by unattended runner`);
      },
      onExit: (code, signal, stderr) => {
        this.host.log(`定时 ACP 进程 ${profile.name} 退出（${signal ?? code}）${stderr ? `：${stderr}` : ''}`);
      },
    });

    const abortListener = () => {
      if (sessionId && conn.running) {
        conn.notify('session/cancel', { sessionId });
      }
      void conn.dispose();
    };
    runAbort.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await conn.start();
      const init = await conn.request<AcpInitialize>(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'harness-deck-scheduler', title: 'Harness Deck Scheduler', version: this.host.extensionVersion },
        },
        INITIALIZE_TIMEOUT_MS,
      );

      const mcpServers = toAcpMcpServers(prepared?.mcpServers ?? [], init?.agentCapabilities?.mcpCapabilities);
      const extraSessionParams: Record<string, unknown> = {};
      if (prepared?.skillBundleDir) {
        if (init?.agentCapabilities?.sessionCapabilities?.additionalDirectories) {
          extraSessionParams.additionalDirectories = [prepared.skillBundleDir];
        }
        if (prepared.skillMode === 'claude-meta') {
          extraSessionParams._meta = { claudeCode: { options: { additionalDirectories: [prepared.skillBundleDir] } } };
        }
      }

      const created = await conn.request<{ sessionId: string } & AcpSessionMeta>('session/new', {
        cwd: req.projectPath,
        mcpServers,
        ...extraSessionParams,
      });
      sessionId = created.sessionId;
      req.onSessionCreated(sessionId);
      projection.setSessionMeta(created);

      // 若底层暴露了 mode 选项，尝试切换到与权限预设对应的模式
      const modeOpt = projection.configOptions.find((o) => o.category === 'mode' || o.id === 'mode');
      if (modeOpt?.options?.length) {
        const desiredMode = pickAcpModeValue(modeOpt.options, req.permission);
        if (desiredMode && desiredMode !== modeOpt.currentValue) {
          const setPromise =
            modeOpt.legacyMethod === 'session/set_mode'
              ? conn.request('session/set_mode', { sessionId, modeId: desiredMode })
              : conn.request('session/set_config_option', { sessionId, configId: modeOpt.id, value: desiredMode });
          await setPromise.catch((err: unknown) => this.host.log(`设置 ACP 模式 ${desiredMode} 跳过：${describe(err)}`));
        }
      }

      const promptText =
        prepared?.skillMode === 'prompt' && prepared.skills.length > 0
          ? `${formatSkillsPromptCatalog(prepared.skills)}\n\n${req.prompt}`
          : req.prompt;
      projection.startTurn(Date.now());
      const res = await conn.request<{ stopReason?: string } | null>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: promptText }],
      });
      projection.endTurn(Date.now(), res?.stopReason ?? 'end_turn');

      const assistantTexts = projection
        .snapshotItems()
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);

      return {
        status: 'succeeded',
        sessionId,
        output: assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS),
      };
    } catch (error) {
      const msg =
        error instanceof AcpTimeoutError
          ? `ACP handshake timed out (${profile.command})`
          : runAbort.signal.aborted
            ? describe(runAbort.signal.reason ?? error)
            : describe(error);
      return {
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: msg,
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      runAbort.signal.removeEventListener('abort', abortListener);
      await conn.dispose().catch(() => undefined);
    }
  }

  private async runZcode(
    profile: Extract<BackendProfile, { kind: 'zcode' }>,
    req: UnattendedRunRequest,
  ): Promise<UnattendedRunOutcome> {
    const zcodeCfg = this.host.getZcodeConfig?.() ?? { configuredPath: '', env: this.host.getEnvForProfile() };
    const located = await locateZcode({
      configuredPath: zcodeCfg.configuredPath,
      env: zcodeCfg.env,
      platform: process.platform,
      fallbackNodePath: process.execPath,
    });
    if (located.kind === 'notFound') {
      return { status: 'failed', error: profile.installHint ?? 'zcode executable not found in PATH or settings' };
    }

    const projection = new ZcodeSessionProjection(req.projectPath);
    let sessionId: string | undefined;
    let resolveTurnDone: (() => void) | undefined;
    let rejectTurnDone: ((err: Error) => void) | undefined;
    const turnDone = new Promise<void>((resolveP, rejectP) => {
      resolveTurnDone = resolveP;
      rejectTurnDone = rejectP;
    });

    const runAbort = new AbortController();
    const timeout = setTimeout(
      () => runAbort.abort(new Error('Scheduled task timed out')),
      req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    );
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const conn = new ZcodeConnection({
      command: located.command,
      args: [...located.scriptArgs, 'app-server', '--stdio'],
      cwd: req.projectPath,
      env: { ...zcodeCfg.env, ...located.extraEnv },
      log: this.host.log,
      onStderr: (line) => this.host.runtimeLog?.(line, 'stderr'),
      onNotification: (method, params) => {
        const obj = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
        const inner = obj.event && typeof obj.event === 'object' ? (obj.event as Record<string, unknown>) : undefined;
        const sid = typeof obj.sessionId === 'string' ? obj.sessionId : typeof inner?.sessionId === 'string' ? inner.sessionId : sessionId;
        if (sessionId && sid && sid !== sessionId) return;
        const eventPayload = method === 'session/event' ? obj : { type: method, payload: obj };
        projection.applyEvent(eventPayload);
        const evType = typeof inner?.type === 'string' ? inner.type : typeof obj.type === 'string' ? obj.type : method;
        if (evType === 'turn.completed' || evType === 'turn/end') {
          resolveTurnDone?.();
        } else if (evType === 'turn.failed') {
          const last = projection.snapshotItems().at(-1);
          const errText = last?.kind === 'notice' ? last.text : 'ZCode turn failed';
          rejectTurnDone?.(new Error(errText));
        }
      },
      onRequest: async (method, params) => {
        if (method === 'session/requestRuntimePreferences') {
          return defaultRuntimePreferences(true);
        }
        if (method === 'interaction/requestPermission' || method === 'session/requestPermission' || method === 'permission/request') {
          return resolveZcodeUnattendedPermission(params, req.permission, req.projectPath);
        }
        if (method === 'interaction/requestUserInput' || method === 'session/requestUserInput' || method === 'askUserQuestion') {
          return { action: 'cancel' };
        }
        if (method === 'provider/updateAccountConfig') {
          return { ok: true };
        }
        throw new ZcodeError(method, -32601, `${method} is not supported by unattended runner`);
      },
      onExit: (code, signal, stderr) => {
        this.host.log(`定时 ZCode 进程退出（${signal ?? code}）${stderr ? `：${stderr}` : ''}`);
        rejectTurnDone?.(new Error(stderr || `ZCode exited (${signal ?? code})`));
      },
    });

    const abortListener = () => {
      if (sessionId && conn.running) {
        void conn.request('session/stop', { sessionId }).catch(() => undefined);
      }
      rejectTurnDone?.(new Error(describe(runAbort.signal.reason ?? 'Scheduled task aborted')));
      void conn.dispose();
    };
    runAbort.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await conn.start();
      const created = await conn.request<Record<string, unknown> | null>(
        'session/create',
        { workspace: { workspacePath: req.projectPath, workspaceKey: req.projectPath } },
        INITIALIZE_TIMEOUT_MS,
      );
      sessionId = extractZcodeSessionId(created);
      if (!sessionId) throw new Error('missing sessionId in session/create');
      req.onSessionCreated(sessionId);
      await conn.request('session/subscribe', { sessionId, deliveryKind: ZCODE_DELIVERY_KIND });

      const desiredMode =
        req.permission === 'danger-full-access'
          ? 'yolo'
          : req.permission === 'read-only'
            ? 'plan'
            : 'auto';
      await conn.request('session/setMode', { sessionId, mode: desiredMode }).catch(() => undefined);

      projection.startTurn(Date.now());
      await conn.request('session/send', { sessionId, content: req.prompt });
      await turnDone;

      const assistantTexts = projection
        .snapshotItems()
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);

      return {
        status: 'succeeded',
        sessionId,
        output: assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS),
      };
    } catch (error) {
      const msg =
        error instanceof ZcodeTimeoutError
          ? 'ZCode handshake timed out'
          : runAbort.signal.aborted
            ? describe(runAbort.signal.reason ?? error)
            : describe(error);
      return {
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: msg,
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      runAbort.signal.removeEventListener('abort', abortListener);
      await conn.dispose().catch(() => undefined);
    }
  }

  private async runCodex(
    profile: Extract<BackendProfile, { kind: 'codex' }>,
    req: UnattendedRunRequest,
  ): Promise<UnattendedRunOutcome> {
    const codexCfg = this.host.getCodexConfig?.() ?? { configuredPath: '', env: this.host.getEnvForProfile() };
    const located = await locateCodex({
      configuredPath: codexCfg.configuredPath,
      env: codexCfg.env,
      platform: process.platform,
    });
    if (located.kind === 'notFound') {
      return { status: 'failed', error: profile.installHint ?? 'codex executable not found in PATH or settings' };
    }

    const prepared = await this.host.prepareBackendLaunch?.(profile).catch(() => undefined);
    const projection = new CodexSessionProjection(req.projectPath);
    let threadId: string | undefined;
    let activeTurnId: string | undefined;
    let resolveTurnDone: (() => void) | undefined;
    let rejectTurnDone: ((err: Error) => void) | undefined;
    const turnDone = new Promise<void>((resolveP, rejectP) => {
      resolveTurnDone = resolveP;
      rejectTurnDone = rejectP;
    });

    const runAbort = new AbortController();
    const timeout = setTimeout(
      () => runAbort.abort(new Error('Scheduled task timed out')),
      req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    );
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const permMode =
      req.permission === 'danger-full-access'
        ? 'danger-full-access'
        : req.permission === 'read-only'
          ? 'read-only'
          : 'full-auto';
    const permCfg = codexPermissionConfig(permMode);

    const conn = new CodexConnection({
      command: located.command,
      args: ['app-server', '--listen', 'stdio://', ...(prepared?.extraArgs ?? [])],
      cwd: req.projectPath,
      env: codexCfg.env,
      log: this.host.log,
      onStderr: (line) => this.host.runtimeLog?.(line, 'stderr'),
      onNotification: (method, params) => {
        const obj = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
        const tid = typeof obj.threadId === 'string' ? obj.threadId : threadId;
        if (threadId && tid && tid !== threadId) return;
        const outcome = projection.applyNotification(method, obj);
        if (projection.activeTurnId) activeTurnId = projection.activeTurnId;
        if (outcome.turnEnded) {
          const turn = obj.turn as { status?: unknown; error?: { message?: unknown } } | undefined;
          if (turn?.status === 'failed') {
            rejectTurnDone?.(
              new Error(typeof turn.error?.message === 'string' ? turn.error.message : 'Codex turn failed'),
            );
          } else {
            resolveTurnDone?.();
          }
        }
      },
      onRequest: async (method, params) => {
        if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
          return { decision: req.permission === 'danger-full-access' ? 'acceptForSession' : 'decline' };
        }
        if (method === 'item/permissions/requestApproval') {
          const requested =
            params && typeof params === 'object' ? (params as { permissions?: unknown }).permissions : {};
          return {
            permissions: req.permission === 'danger-full-access' ? (requested ?? {}) : {},
            scope: req.permission === 'danger-full-access' ? 'session' : 'turn',
          };
        }
        if (method === 'item/tool/requestUserInput') {
          return { answers: {} };
        }
        if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
          return { decision: req.permission === 'danger-full-access' ? 'approved_for_session' : 'denied' };
        }
        if (method === 'mcpServer/elicitation/request') {
          return { action: 'cancel' };
        }
        throw new CodexError(method, -32601, `${method} is not supported by unattended runner`);
      },
      onExit: (code, signal, stderr) => {
        this.host.log(`定时 Codex 进程退出（${signal ?? code}）${stderr ? `：${stderr}` : ''}`);
        rejectTurnDone?.(new Error(stderr || `Codex exited (${signal ?? code})`));
      },
    });

    const abortListener = () => {
      if (threadId && activeTurnId && conn.running) {
        void conn.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => undefined);
      }
      rejectTurnDone?.(new Error(describe(runAbort.signal.reason ?? 'Scheduled task aborted')));
      void conn.dispose();
    };
    runAbort.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await conn.start();
      await conn.initialize(this.host.extensionVersion, INITIALIZE_TIMEOUT_MS);
      const started = await conn.request<{ thread?: { id?: string } }>(
        'thread/start',
        {
          cwd: req.projectPath,
          approvalPolicy: permCfg.approvalPolicy,
          sandbox: permCfg.sandbox,
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        },
        INITIALIZE_TIMEOUT_MS,
      );
      threadId = started?.thread?.id;
      if (!threadId) throw new Error('missing thread.id in thread/start');
      req.onSessionCreated(threadId);

      const skillCatalog =
        prepared?.skillMode === 'prompt' && prepared.skills.length > 0
          ? formatSkillsPromptCatalog(prepared.skills)
          : undefined;
      const finalPrompt = skillCatalog ? `${skillCatalog}\n\n${req.prompt}` : req.prompt;

      projection.startTurn(Date.now());
      const turnRes = await conn.request<{ turn?: { id?: string } }>('turn/start', {
        threadId,
        input: buildCodexUserInput(finalPrompt),
        cwd: req.projectPath,
        approvalPolicy: permCfg.approvalPolicy,
        sandboxPolicy: permCfg.sandboxPolicy,
      });
      if (typeof turnRes?.turn?.id === 'string') {
        activeTurnId = turnRes.turn.id;
        projection.activeTurnId = turnRes.turn.id;
      }
      await turnDone;

      const assistantTexts = projection
        .snapshotItems()
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);

      return {
        status: 'succeeded',
        sessionId: threadId,
        output: assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS),
      };
    } catch (error) {
      const msg =
        error instanceof CodexTimeoutError
          ? 'Codex handshake timed out'
          : runAbort.signal.aborted
            ? describe(runAbort.signal.reason ?? error)
            : describe(error);
      return {
        status: 'failed',
        ...(threadId ? { sessionId: threadId } : {}),
        error: msg,
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      runAbort.signal.removeEventListener('abort', abortListener);
      await conn.dispose().catch(() => undefined);
    }
  }

  private async runClaude(
    profile: Extract<BackendProfile, { kind: 'claude' }>,
    req: UnattendedRunRequest,
  ): Promise<UnattendedRunOutcome> {
    const cfg = this.host.getClaudeConfig?.() ?? { configuredPath: '', env: this.host.getEnvForProfile() };
    const located = await locateClaude({
      configuredPath: cfg.configuredPath,
      env: cfg.env,
      platform: process.platform,
    });
    if (located.kind === 'notFound') {
      return { status: 'failed', error: profile.installHint ?? 'claude executable not found in PATH or settings' };
    }

    const prepared = await this.host.prepareBackendLaunch?.(profile);
    const projection = new ClaudeSessionProjection(req.projectPath);
    let sessionId: string | undefined;
    let notifiedHidden = false;
    let resolveTurnDone: (() => void) | undefined;
    let rejectTurnDone: ((err: Error) => void) | undefined;
    const turnDone = new Promise<void>((resolveP, rejectP) => {
      resolveTurnDone = resolveP;
      rejectTurnDone = rejectP;
    });

    const runAbort = new AbortController();
    const timeout = setTimeout(
      () => runAbort.abort(new Error('Scheduled task timed out')),
      req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    );
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const conn = new ClaudeConnection({
      command: located.command,
      permissionMode: req.permission === 'read-only' ? 'plan' : 'default',
      extraArgs: prepared?.extraArgs ?? [],
      cwd: req.projectPath,
      env: cfg.env,
      log: this.host.log,
      onStderr: (line) => this.host.runtimeLog?.(line, 'stderr'),
      onEvent: (event) => {
        const sid =
          typeof event.session_id === 'string' && event.session_id
            ? event.session_id
            : typeof event.sessionId === 'string' && event.sessionId
              ? event.sessionId
              : undefined;
        if (sid && !notifiedHidden) {
          sessionId = sid;
          notifiedHidden = true;
          req.onSessionCreated(sid);
        }
        projection.applyEvent(event);
        if (event.type === 'result') {
          if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) {
            const errText =
              typeof event.result === 'string' && event.result.trim() ? event.result.trim() : 'Claude Code turn failed';
            rejectTurnDone?.(new Error(errText));
          } else {
            resolveTurnDone?.();
          }
        }
      },
      onControlRequest: async (_reqId, request) => {
        if (request.subtype !== 'can_use_tool') return {};
        return resolveClaudeUnattendedPermission(request, req.permission, req.projectPath);
      },
      onExit: (code, signal, stderr) => {
        this.host.log(`定时 Claude Code 进程退出（${signal ?? code}）${stderr ? `：${stderr}` : ''}`);
        rejectTurnDone?.(new Error(stderr || `Claude Code exited (${signal ?? code})`));
      },
    });

    const abortListener = () => {
      if (conn.running) {
        void conn.sendControlRequest({ subtype: 'interrupt' }, 3_000).catch(() => undefined);
      }
      rejectTurnDone?.(new Error(describe(runAbort.signal.reason ?? 'Scheduled task aborted')));
      void conn.dispose();
    };
    runAbort.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await conn.start();
      projection.startTurn(Date.now());
      conn.sendUserMessage(req.prompt);
      await turnDone;

      const assistantTexts = projection
        .snapshotItems()
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);

      return {
        status: 'succeeded',
        ...(sessionId ? { sessionId } : {}),
        output: assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS),
      };
    } catch (error) {
      return {
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: runAbort.signal.aborted ? describe(runAbort.signal.reason ?? error) : describe(error),
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      runAbort.signal.removeEventListener('abort', abortListener);
      await conn.dispose().catch(() => undefined);
    }
  }

  private async runCodebuddy(
    profile: Extract<BackendProfile, { kind: 'codebuddy' }>,
    req: UnattendedRunRequest,
  ): Promise<UnattendedRunOutcome> {
    const cfg = this.host.getCodebuddyConfig?.() ?? { configuredPath: '', env: this.host.getEnvForProfile() };
    const located = await locateCodebuddy({
      configuredPath: cfg.configuredPath,
      env: cfg.env,
      platform: process.platform,
    });
    if (located.kind === 'notFound') {
      return { status: 'failed', error: profile.installHint ?? 'codebuddy executable not found in PATH or settings' };
    }

    const prepared = await this.host.prepareBackendLaunch?.(profile).catch(() => undefined);
    const projection = new CodebuddySessionProjection(req.projectPath);
    let sessionId: string | undefined;
    let notifiedHidden = false;
    let resolveTurnDone: (() => void) | undefined;
    let rejectTurnDone: ((err: Error) => void) | undefined;
    const turnDone = new Promise<void>((resolveP, rejectP) => {
      resolveTurnDone = resolveP;
      rejectTurnDone = rejectP;
    });

    const runAbort = new AbortController();
    const timeout = setTimeout(
      () => runAbort.abort(new Error('Scheduled task timed out')),
      req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    );
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const conn = new CodebuddyConnection({
      command: located.command,
      permissionMode: req.permission === 'read-only' ? 'plan' : 'default',
      extraArgs: prepared?.extraArgs ?? [],
      cwd: req.projectPath,
      env: cfg.env,
      log: this.host.log,
      onStderr: (line) => this.host.runtimeLog?.(line, 'stderr'),
      onEvent: (event) => {
        const sid =
          typeof event.session_id === 'string' && event.session_id
            ? event.session_id
            : typeof event.sessionId === 'string' && event.sessionId
              ? event.sessionId
              : undefined;
        if (sid && !notifiedHidden) {
          sessionId = sid;
          notifiedHidden = true;
          req.onSessionCreated(sid);
        }
        projection.applyEvent(event);
        if (event.type === 'result') {
          if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) {
            const errText =
              typeof event.result === 'string' && event.result.trim() ? event.result.trim() : 'CodeBuddy turn failed';
            rejectTurnDone?.(new Error(errText));
          } else {
            resolveTurnDone?.();
          }
        }
      },
      onControlRequest: async (_reqId, request) => {
        if (request.subtype !== 'can_use_tool') return {};
        return resolveCodebuddyUnattendedPermission(request, req.permission, req.projectPath);
      },
      onExit: (code, signal, stderr) => {
        this.host.log(`定时 CodeBuddy 进程退出（${signal ?? code}）${stderr ? `：${stderr}` : ''}`);
        rejectTurnDone?.(new Error(stderr || `CodeBuddy exited (${signal ?? code})`));
      },
    });

    const abortListener = () => {
      if (conn.running) {
        void conn.sendControlRequest({ subtype: 'interrupt' }, 3_000).catch(() => undefined);
      }
      rejectTurnDone?.(new Error(describe(runAbort.signal.reason ?? 'Scheduled task aborted')));
      void conn.dispose();
    };
    runAbort.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await conn.start();
      projection.startTurn(Date.now());
      conn.sendUserMessage(req.prompt);
      await turnDone;

      const assistantTexts = projection
        .snapshotItems()
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);

      return {
        status: 'succeeded',
        ...(sessionId ? { sessionId } : {}),
        output: assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS),
      };
    } catch (error) {
      return {
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: runAbort.signal.aborted ? describe(runAbort.signal.reason ?? error) : describe(error),
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      runAbort.signal.removeEventListener('abort', abortListener);
      await conn.dispose().catch(() => undefined);
    }
  }

  private async runPi(
    profile: Extract<BackendProfile, { kind: 'pi' }>,
    req: UnattendedRunRequest,
  ): Promise<UnattendedRunOutcome> {
    const cfg = this.host.getPiConfig?.() ?? { configuredPath: '', env: this.host.getEnvForProfile() };
    const located = await locatePi({
      configuredPath: cfg.configuredPath,
      env: cfg.env,
      platform: process.platform,
    });
    if (located.kind === 'notFound') {
      return { status: 'failed', error: profile.installHint ?? 'pi executable not found in PATH or settings' };
    }

    const prepared = await this.host.prepareBackendLaunch?.(profile);
    const projection = new PiSessionProjection(req.projectPath);
    let sessionId: string | undefined;
    let resolveTurnDone: (() => void) | undefined;
    let rejectTurnDone: ((err: Error) => void) | undefined;
    const turnDone = new Promise<void>((resolveP, rejectP) => {
      resolveTurnDone = resolveP;
      rejectTurnDone = rejectP;
    });

    const runAbort = new AbortController();
    const timeout = setTimeout(
      () => runAbort.abort(new Error('Scheduled task timed out')),
      req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    );
    timeout.unref?.();
    const onExternalAbort = () => runAbort.abort(req.signal?.reason ?? new Error('Aborted'));
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const conn = new PiConnection({
      command: located.command,
      extraArgs: prepared?.extraArgs ?? [],
      cwd: req.projectPath,
      env: cfg.env,
      log: this.host.log,
      onStderr: (line) => this.host.runtimeLog?.(line, 'stderr'),
      onEvent: (event) => {
        projection.applyEvent(event);
        if (event.type === 'agent_end') {
          const last = projection.snapshotItems().at(-1);
          if (last?.kind === 'notice' && last.level === 'error') {
            rejectTurnDone?.(new Error(last.text));
          } else {
            resolveTurnDone?.();
          }
        }
      },
      onUiRequest: async (uiReq) => {
        if (uiReq.method === 'confirm') {
          return { confirmed: req.permission === 'danger-full-access' };
        }
        return { cancelled: true };
      },
      onExit: (code, signal, stderr) => {
        this.host.log(`定时 Pi 进程退出（${signal ?? code}）${stderr ? `：${stderr}` : ''}`);
        rejectTurnDone?.(new Error(stderr || `Pi exited (${signal ?? code})`));
      },
    });

    const abortListener = () => {
      if (conn.running) {
        void conn.request('abort').catch(() => undefined);
      }
      rejectTurnDone?.(new Error(describe(runAbort.signal.reason ?? 'Scheduled task aborted')));
      void conn.dispose();
    };
    runAbort.signal.addEventListener('abort', abortListener, { once: true });

    try {
      await conn.start();
      const state = await conn.request<{ sessionId?: string }>('get_state', {}, INITIALIZE_TIMEOUT_MS);
      sessionId = state?.sessionId;
      if (sessionId) req.onSessionCreated(sessionId);

      const promptBody =
        req.permission === 'read-only'
          ? `[Read-only Scheduled Run: Do not modify files or execute destructive commands.]\n\n${req.prompt}`
          : req.prompt;

      projection.startTurn(Date.now());
      await conn.request('prompt', { message: promptBody });
      await turnDone;

      const assistantTexts = projection
        .snapshotItems()
        .filter((item): item is Extract<typeof item, { kind: 'assistant' }> => item.kind === 'assistant')
        .map((item) => item.markdown.trim())
        .filter(Boolean);

      return {
        status: 'succeeded',
        ...(sessionId ? { sessionId } : {}),
        output: assistantTexts.join('\n\n').slice(0, MAX_OUTPUT_CHARS),
      };
    } catch (error) {
      const msg =
        error instanceof PiTimeoutError
          ? 'Pi RPC handshake timed out'
          : runAbort.signal.aborted
            ? describe(runAbort.signal.reason ?? error)
            : describe(error);
      return {
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: msg,
      };
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onExternalAbort);
      runAbort.signal.removeEventListener('abort', abortListener);
      await conn.dispose().catch(() => undefined);
    }
  }
}

function resolveAcpUnattendedPermission(
  params: unknown,
  permission: SchedulePermissionPreset,
  projectPath: string,
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const { toolCall, options } = (params ?? {}) as {
    toolCall?: AcpToolCall;
    options?: readonly { readonly optionId: string; readonly kind?: string }[];
  };
  if (!options?.length) return { outcome: { outcome: 'cancelled' } };

  const pickAllow = () =>
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind?.startsWith('allow'));
  const pickReject = () =>
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind?.startsWith('reject'));

  let shouldAllow = false;
  if (permission === 'danger-full-access') {
    shouldAllow = true;
  } else if (permission === 'read-only') {
    const kind = toolCall?.kind ?? '';
    shouldAllow = kind === 'read' || kind === 'search';
  } else {
    // workspace-write：允许只读操作与工作区目录内的文件编辑，拒绝任意终端命令或越界写入
    const kind = toolCall?.kind ?? '';
    if (kind === 'read' || kind === 'search') {
      shouldAllow = true;
    } else if (kind === 'edit') {
      const target = toolCall?.locations?.[0]?.path ?? inputFilePath(toolCall?.rawInput);
      if (target) {
        const abs = isAbsolute(target) ? resolve(target) : resolve(projectPath, target);
        const rel = relative(projectPath, abs);
        shouldAllow = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      }
    }
  }

  const chosen = shouldAllow ? pickAllow() : pickReject();
  return chosen
    ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function resolveZcodeUnattendedPermission(
  params: unknown,
  permission: SchedulePermissionPreset,
  projectPath: string,
): { readonly decision: 'allow' | 'deny' } {
  if (permission === 'danger-full-access') return { decision: 'allow' };
  const raw = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const toolName = typeof raw.toolName === 'string' ? raw.toolName : typeof raw.tool === 'string' ? raw.tool : '';
  const variant = toolVariant(toolName);
  if (variant === 'explore') return { decision: 'allow' };
  if (permission === 'workspace-write' && variant === 'edit') {
    const input = parseArguments(raw.input ?? raw.arguments ?? raw.args);
    const target = inputFilePath(input);
    if (target) {
      const abs = isAbsolute(target) ? resolve(target) : resolve(projectPath, target);
      const rel = relative(projectPath, abs);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return { decision: 'allow' };
      }
    }
  }
  return { decision: 'deny' };
}

function resolveClaudeUnattendedPermission(
  request: Record<string, unknown>,
  permission: SchedulePermissionPreset,
  projectPath: string,
): Record<string, unknown> {
  const toolName =
    typeof request.tool_name === 'string'
      ? request.tool_name
      : typeof request.toolName === 'string'
        ? request.toolName
        : 'tool';
  const canon = canonicalTool(toolName);
  if (canon === 'ask_user_question' || canon === 'exit_plan_mode') {
    return { behavior: 'deny', message: 'Unattended scheduled run cannot answer interactive questions.' };
  }
  const input = parseArguments(request.input);
  if (permission === 'danger-full-access') {
    return { behavior: 'allow', updatedInput: input };
  }
  const variant = toolVariant(toolName);
  if (variant === 'explore') {
    return { behavior: 'allow', updatedInput: input };
  }
  if (permission === 'workspace-write' && variant === 'edit') {
    const target = inputFilePath(input);
    if (target) {
      const abs = isAbsolute(target) ? resolve(target) : resolve(projectPath, target);
      const rel = relative(projectPath, abs);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return { behavior: 'allow', updatedInput: input };
      }
    }
  }
  return { behavior: 'deny', message: `Denied by unattended schedule permission (${permission}).` };
}

function resolveCodebuddyUnattendedPermission(
  request: Record<string, unknown>,
  permission: SchedulePermissionPreset,
  projectPath: string,
): Record<string, unknown> {
  const toolName =
    typeof request.tool_name === 'string'
      ? request.tool_name
      : typeof request.toolName === 'string'
        ? request.toolName
        : 'tool';
  const canon = canonicalTool(toolName);
  if (canon === 'ask_user_question' || canon === 'exit_plan_mode') {
    return { allowed: false, message: 'Unattended scheduled run cannot answer interactive questions.' };
  }
  const input = parseArguments(request.input);
  if (permission === 'danger-full-access') {
    return { allowed: true, updatedInput: input };
  }
  const variant = toolVariant(toolName);
  if (variant === 'explore') {
    return { allowed: true, updatedInput: input };
  }
  if (permission === 'workspace-write' && variant === 'edit') {
    const target = inputFilePath(input);
    if (target) {
      const abs = isAbsolute(target) ? resolve(target) : resolve(projectPath, target);
      const rel = relative(projectPath, abs);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return { allowed: true, updatedInput: input };
      }
    }
  }
  return { allowed: false, message: `Denied by unattended schedule permission (${permission}).` };
}

function pickAcpModeValue(
  options: readonly { readonly value: string; readonly name?: string }[],
  permission: SchedulePermissionPreset,
): string | undefined {
  if (permission === 'danger-full-access') {
    return options.find((o) => /bypass|full[-_]?access|yolo|unrestricted|auto/iu.test(o.value))?.value;
  }
  if (permission === 'read-only') {
    return options.find((o) => /read[-_]?only|plan/iu.test(o.value))?.value;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

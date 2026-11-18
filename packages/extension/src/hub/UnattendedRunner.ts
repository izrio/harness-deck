/**
 * 定时任务无人值守执行器（UnattendedRunner）。
 *
 * 到点新开一个隔离会话，按设置里的权限预设（默认 `danger-full-access`「全部放行」）无人值守跑完，
 * 收集完整 Markdown 输出写回规则历史，并通过 `onSessionCreated` 立即隐藏后台会话 id，不进入左侧会话列表。
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { AcpInitialize } from '../acp/AcpController.ts';
import { AcpConnection, AcpError, AcpTimeoutError } from '../acp/connection.ts';
import { AcpSessionProjection, type AcpConfigOption, type AcpToolCall } from '../acp/projection.ts';
import type { BackendProfile } from '../backend/types.ts';
import { DshClient } from '../dsh/DshClient.ts';
import type { WireEvent } from '../dsh/remote/follow.ts';
import { projectEvents } from '../dsh/view/projector.ts';
import { launchRuntime, stopRuntime, type LaunchedRuntime } from '../runtime/launch.ts';
import { locateDsh, locateExecutable } from '../runtime/locate.ts';
import { checkVersionSupport, MINIMUM_DSH_VERSION } from '../runtime/version.ts';
import { probeVersion } from '../runtime/launch.ts';

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
  readonly getEnvForProfile: (profileEnv?: Readonly<Record<string, string>>) => Readonly<Record<string, string | undefined>>;
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
        tempLaunched = await launchRuntime({
          command: located.command,
          profile: cfg.profile,
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
    const located = await locateExecutable(profile.command, { env, platform: process.platform });
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

    const conn = new AcpConnection({
      command: located.command,
      args: profile.args,
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
      await conn.request<AcpInitialize>(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'harness-deck-scheduler', title: 'Harness Deck Scheduler', version: this.host.extensionVersion },
        },
        INITIALIZE_TIMEOUT_MS,
      );

      const created = await conn.request<{ sessionId: string; configOptions?: AcpConfigOption[] }>('session/new', {
        cwd: req.projectPath,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      req.onSessionCreated(sessionId);
      projection.setConfigOptions(created.configOptions);

      // 若底层暴露了 mode 选项，尝试切换到与权限预设对应的模式
      const modeOpt = (created.configOptions ?? []).find((o) => o.category === 'mode' || o.id === 'mode');
      if (modeOpt?.options?.length) {
        const desiredMode = pickAcpModeValue(modeOpt.options, req.permission);
        if (desiredMode && desiredMode !== modeOpt.currentValue) {
          await conn
            .request('session/set_config_option', { sessionId, configId: modeOpt.id, value: desiredMode })
            .catch((err: unknown) => this.host.log(`设置 ACP 模式 ${desiredMode} 跳过：${describe(err)}`));
        }
      }

      projection.startTurn(Date.now());
      const res = await conn.request<{ stopReason?: string } | null>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: req.prompt }],
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
      const rawArgs = (toolCall?.rawInput ?? {}) as { file_path?: unknown; path?: unknown };
      const target =
        toolCall?.locations?.[0]?.path ??
        (typeof rawArgs.file_path === 'string' ? rawArgs.file_path : typeof rawArgs.path === 'string' ? rawArgs.path : undefined);
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

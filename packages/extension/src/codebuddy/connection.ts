/**
 * CodeBuddy 原生 `codebuddy -p` 流式双向连接层：
 * 以 `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
 * 启动 `codebuddy` 进程，通过 stdin/stdout NDJSON 收发用户消息、控制请求（`initialize` / `interrupt` / `set_model` / `set_permission_mode`）
 * 以及工具权限审批（`can_use_tool`，响应载荷为 `{ allowed: boolean, updatedInput?, message? }`）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnSpec, stopRuntime, trackChild } from '../runtime/launch.ts';

export class CodebuddyError extends Error {
  constructor(
    readonly subtype: string,
    message: string,
  ) {
    super(`${subtype}: ${message}`);
    this.name = 'CodebuddyError';
  }
}

export class CodebuddyClosedError extends Error {
  constructor(message = 'CodeBuddy 进程已退出') {
    super(message);
    this.name = 'CodebuddyClosedError';
  }
}

export class CodebuddyTimeoutError extends Error {
  constructor(subtype: string, timeoutMs: number) {
    super(`${subtype}: no response within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'CodebuddyTimeoutError';
  }
}

export interface CodebuddyLink {
  readonly running: boolean;
  sendUserMessage(content: string | readonly Record<string, unknown>[], sessionId?: string): void;
  sendControlRequest<T = unknown>(request: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  dispose(): Promise<void>;
}

export interface CodebuddyConnectionOptions {
  readonly command: string;
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly extraArgs?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** CodeBuddy 发来的反向控制请求（如 `can_use_tool`）。 */
  readonly onControlRequest: (requestId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** CodeBuddy 输出的流式事件帧（`system`、`stream_event`、`assistant`、`user`、`result`）。 */
  readonly onEvent: (event: Record<string, unknown>) => void;
  /** 进程意外退出回调（非 dispose 主动关闭）。 */
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
  readonly log?: (line: string) => void;
  readonly onStderr?: (line: string) => void;
  readonly trace?: (direction: 'in' | 'out', line: string) => void;
}

interface PendingControl {
  readonly subtype: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL = 20;

export function buildCodebuddyArgs(options: {
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly extraArgs?: readonly string[];
}): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.permissionMode) {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }
  return args;
}

export class CodebuddyConnection implements CodebuddyLink {
  private child: ChildProcess | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, PendingControl>();
  private buffer = '';
  private stderrTail: string[] = [];
  private disposed = false;

  constructor(private readonly options: CodebuddyConnectionOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cliArgs = buildCodebuddyArgs(this.options);
      const spec = spawnSpec(this.options.command, cliArgs, process.platform, this.options.env);
      const child = spawn(spec.file, spec.args, {
        cwd: this.options.cwd,
        env: { ...this.options.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      this.child = child;
      trackChild(child);

      child.stdin?.on('error', (error) => {
        this.options.log?.(`CodeBuddy：写入子进程失败：${error.message}`);
        this.closeAll(new CodebuddyClosedError(`无法写入 CodeBuddy 进程：${error.message}`));
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        reject(error);
        this.closeAll(new CodebuddyClosedError(error.message));
      });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.onData(chunk));

      child.stderr?.setEncoding('utf8');
      let stderrBuffer = '';
      child.stderr?.on('data', (chunk: string) => {
        stderrBuffer += chunk;
        let index: number;
        while ((index = stderrBuffer.indexOf('\n')) >= 0) {
          const line = stderrBuffer.slice(0, index).replace(/\r$/u, '');
          stderrBuffer = stderrBuffer.slice(index + 1);
          if (!line.trim()) continue;
          this.stderrTail = [...this.stderrTail, line].slice(-STDERR_TAIL);
          this.options.onStderr?.(line);
        }
      });

      child.once('exit', (code, signal) => {
        const leftover = stderrBuffer.trim();
        if (leftover) {
          stderrBuffer = '';
          this.stderrTail = [...this.stderrTail, leftover].slice(-STDERR_TAIL);
          this.options.onStderr?.(leftover);
        }
        this.closeAll(new CodebuddyClosedError(`CodeBuddy 进程已退出（${signal ?? code}）`));
        if (!this.disposed) this.options.onExit(code, signal, this.stderrTail.join('\n'));
      });
    });
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.disposed;
  }

  sendUserMessage(content: string | readonly Record<string, unknown>[], sessionId = ''): void {
    if (!this.running) throw new CodebuddyClosedError();
    this.write({
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content,
      },
    });
  }

  sendControlRequest<T = unknown>(request: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.running) return Promise.reject(new CodebuddyClosedError());
    const requestId = `hd_cb_ctrl_${++this.nextId}`;
    const subtype = typeof request.subtype === 'string' ? request.subtype : 'control';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new CodebuddyTimeoutError(subtype, timeoutMs));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        subtype,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.write({
        type: 'control_request',
        request_id: requestId,
        request,
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closeAll(new CodebuddyClosedError('连接已关闭'));
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    await stopRuntime(child, 2_000);
  }

  private write(message: Record<string, unknown>): void {
    const line = JSON.stringify(message);
    this.options.trace?.('out', line);
    this.child?.stdin?.write(`${line}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.options.trace?.('in', line);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.options.log?.(`CodeBuddy：跳过无法解析的输出：${line.slice(0, 200)}`);
        continue;
      }
      if (!frame || typeof frame !== 'object') continue;

      if (frame.type === 'control_response') {
        this.settleControl(frame);
        continue;
      }
      if (frame.type === 'control_request') {
        const reqId = typeof frame.request_id === 'string' ? frame.request_id : '';
        const req = frame.request && typeof frame.request === 'object' ? (frame.request as Record<string, unknown>) : {};
        if (reqId) void this.answerControl(reqId, req);
        continue;
      }
      this.options.onEvent(frame);
    }
  }

  private settleControl(frame: Record<string, unknown>): void {
    const resp = frame.response && typeof frame.response === 'object' ? (frame.response as Record<string, unknown>) : undefined;
    if (!resp) return;
    const reqId = typeof resp.request_id === 'string' ? resp.request_id : '';
    const waiter = this.pending.get(reqId);
    if (!waiter) return;
    this.pending.delete(reqId);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (resp.subtype === 'error') {
      const msg = typeof resp.error === 'string' ? resp.error : 'Control request failed';
      waiter.reject(new CodebuddyError(waiter.subtype, msg));
    } else {
      waiter.resolve(resp.response ?? {});
    }
  }

  private async answerControl(requestId: string, request: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.options.onControlRequest(requestId, request);
      if (!this.running) return;
      this.write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: result,
        },
      });
    } catch (error) {
      if (!this.running) return;
      this.write({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private closeAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Pi Coding Agent 原生 `pi --mode rpc` NDJSON 连接层：
 * 通过 stdin 发送 `{ id, type, ... }` 命令帧，从 stdout 接收：
 * - `{ id, type: "response", command, success, data, error }` 命令应答；
 * - 流式会话事件（`agent_start`、`message_update`、`tool_execution_*`、`agent_end` 等）；
 * - Extension UI 子协议（`extension_ui_request` -> `extension_ui_response`）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnSpec, stopRuntime, trackChild } from '../runtime/launch.ts';

export class PiError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(`${command}: ${message}`);
    this.name = 'PiError';
  }
}

export class PiClosedError extends Error {
  constructor(message = 'Pi 进程已退出') {
    super(message);
    this.name = 'PiClosedError';
  }
}

export class PiTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command}: no response within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'PiTimeoutError';
  }
}

export interface PiLink {
  readonly running: boolean;
  request<T = unknown>(commandType: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  sendUiResponse(id: string, payload: Record<string, unknown>): void;
  dispose(): Promise<void>;
}

export interface PiConnectionOptions {
  readonly command: string;
  readonly extraArgs?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Pi 输出的流式 AgentSessionEvent 帧。 */
  readonly onEvent: (event: Record<string, unknown>) => void;
  /** Pi 发起的需要交互应答的 `extension_ui_request`（confirm / select / input / editor）。 */
  readonly onUiRequest: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Pi 发起的单向 UI 通知（notify / setTitle 等）。 */
  readonly onUiNotify?: (request: Record<string, unknown>) => void;
  /** 进程意外退出（非 dispose 主动关闭）。 */
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
  readonly log?: (line: string) => void;
  readonly onStderr?: (line: string) => void;
  readonly trace?: (direction: 'in' | 'out', line: string) => void;
}

interface PendingCommand {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL = 20;
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export class PiConnection implements PiLink {
  private child: ChildProcess | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private buffer = '';
  private stderrTail: string[] = [];
  private disposed = false;

  constructor(private readonly options: PiConnectionOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cliArgs = ['--mode', 'rpc', ...(this.options.extraArgs ?? [])];
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
        this.options.log?.(`Pi：写入子进程失败：${error.message}`);
        this.closeAll(new PiClosedError(`无法写入 Pi 进程：${error.message}`));
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        reject(error);
        this.closeAll(new PiClosedError(error.message));
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
        this.closeAll(new PiClosedError(`Pi 进程已退出（${signal ?? code}）`));
        if (!this.disposed) this.options.onExit(code, signal, this.stderrTail.join('\n'));
      });
    });
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.disposed;
  }

  request<T = unknown>(commandType: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.running) return Promise.reject(new PiClosedError());
    const id = `pi_${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(new PiTimeoutError(commandType, timeoutMs));
              }
            }, timeoutMs);
      timer?.unref?.();
      this.pending.set(id, {
        command: commandType,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(timer ? { timer } : {}),
      });
      this.write({ ...params, id, type: commandType });
    });
  }

  sendUiResponse(id: string, payload: Record<string, unknown>): void {
    if (!this.running) return;
    this.write({ ...payload, type: 'extension_ui_response', id });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closeAll(new PiClosedError('连接已关闭'));
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
        this.options.log?.(`Pi：跳过无法解析的输出：${line.slice(0, 200)}`);
        continue;
      }
      if (!frame || typeof frame !== 'object') continue;

      if (frame.type === 'response') {
        this.settleResponse(frame);
        continue;
      }
      if (frame.type === 'extension_ui_request') {
        const method = typeof frame.method === 'string' ? frame.method : '';
        if (DIALOG_UI_METHODS.has(method)) {
          void this.answerUiRequest(frame);
        } else {
          this.options.onUiNotify?.(frame);
        }
        continue;
      }
      try {
        this.options.onEvent(frame);
      } catch (error) {
        this.options.log?.(`Pi：处理事件 ${String(frame.type)} 失败：${describe(error)}`);
      }
    }
  }

  private settleResponse(frame: Record<string, unknown>): void {
    const id = typeof frame.id === 'string' ? frame.id : frame.id !== undefined ? String(frame.id) : '';
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.success === false) {
      const errMsg = typeof frame.error === 'string' && frame.error.trim() ? frame.error.trim() : 'command failed';
      pending.reject(new PiError(pending.command, errMsg));
    } else {
      pending.resolve(frame.data ?? frame);
    }
  }

  private async answerUiRequest(frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (!id) return;
    try {
      const resp = await this.options.onUiRequest(frame);
      this.sendUiResponse(id, resp);
    } catch {
      this.sendUiResponse(id, { cancelled: true });
    }
  }

  private closeAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

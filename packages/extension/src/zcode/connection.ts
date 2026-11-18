/**
 * ZCode `app-server --stdio` 连接层：
 * 使用按行分隔的 NDJSON 与 ZCode 子进程通信。
 *
 * 注意：ZCode 的协议校验器拒绝包含 `"jsonrpc": "2.0"` 的信封，
 * 因此客户端发出的请求、通知与反向请求应答均不包含 `jsonrpc` 字段。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnSpec, stopRuntime, trackChild } from '../runtime/launch.ts';

export class ZcodeError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
    this.name = 'ZcodeError';
  }
}

export class ZcodeClosedError extends Error {
  constructor(message = 'ZCode 进程已退出') {
    super(message);
    this.name = 'ZcodeClosedError';
  }
}

export class ZcodeTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method}: no response within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'ZcodeTimeoutError';
  }
}

export interface ZcodeLink {
  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
}

export interface ZcodeConnectionOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** ZCode 发来的反向请求（如 `session/requestRuntimePreferences`、`interaction/requestPermission`、`interaction/requestUserInput`）。 */
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** ZCode 推送的通知（如 `session/event`）。 */
  readonly onNotification: (method: string, params: unknown) => void;
  /** 进程意外退出（非 dispose 主动关闭）。 */
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
  readonly log?: (line: string) => void;
  readonly onStderr?: (line: string) => void;
  readonly trace?: (direction: 'in' | 'out', line: string) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL = 20;

export class ZcodeConnection implements ZcodeLink {
  private child: ChildProcess | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = '';
  private stderrTail: string[] = [];
  private disposed = false;

  constructor(private readonly options: ZcodeConnectionOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const spec = spawnSpec(this.options.command, this.options.args, process.platform, this.options.env);
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
        this.options.log?.(`ZCode：写入子进程失败：${error.message}`);
        this.closeAll(new ZcodeClosedError(`无法写入 ZCode 进程：${error.message}`));
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        reject(error);
        this.closeAll(new ZcodeClosedError(error.message));
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
        this.closeAll(new ZcodeClosedError(`ZCode 进程已退出（${signal ?? code}）`));
        if (!this.disposed) this.options.onExit(code, signal, this.stderrTail.join('\n'));
      });
    });
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.disposed;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.running) return Promise.reject(new ZcodeClosedError());
    const id = ++this.nextId;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (this.pending.delete(key)) reject(new ZcodeTimeoutError(method, timeoutMs));
            }, timeoutMs);
      this.pending.set(key, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(timer ? { timer } : {}),
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.running) this.write({ method, params });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.closeAll(new ZcodeClosedError('连接已关闭'));
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
      let message: {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown } | string;
        type?: string;
      };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        this.options.log?.(`ZCode：跳过无法解析的输出：${line.slice(0, 200)}`);
        continue;
      }
      if (!message || typeof message !== 'object') continue;
      if (message.method === undefined && message.id !== undefined) {
        this.settle(message);
      } else if (message.method !== undefined && message.id !== undefined) {
        void this.answer(message.id, message.method, message.params);
      } else if (message.method !== undefined) {
        try {
          this.options.onNotification(message.method, message.params);
        } catch (error) {
          this.options.log?.(`ZCode：处理 ${message.method} 失败：${describe(error)}`);
        }
      } else if (typeof message.type === 'string') {
        // 兼容直接推送无 method 外壳的事件帧
        try {
          this.options.onNotification('session/event', message);
        } catch (error) {
          this.options.log?.(`ZCode：处理事件 ${message.type} 失败：${describe(error)}`);
        }
      }
    }
  }

  private settle(message: {
    id?: number | string;
    result?: unknown;
    error?: { code?: number; message?: string; data?: unknown } | string;
  }): void {
    const key = String(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error !== undefined && message.error !== null) {
      if (typeof message.error === 'string') {
        pending.reject(new ZcodeError(pending.method, -32603, message.error));
      } else {
        pending.reject(
          new ZcodeError(
            pending.method,
            message.error.code ?? -32603,
            message.error.message ?? 'error',
            message.error.data,
          ),
        );
      }
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ id, result: result ?? {} });
    } catch (error) {
      const code = error instanceof ZcodeError ? error.code : -32603;
      this.write({ id, error: { code, message: describe(error) } });
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

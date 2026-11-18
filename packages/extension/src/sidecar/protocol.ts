/**
 * JetBrains（或其他非 VS Code IDE）与 Node.js Sidecar 之间的 stdio NDJSON JSON-RPC 2.0 通信协议与双向通道。
 */
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { FileCandidate, HostToWebview } from '@harness-deck/shared';
import type { HostCommandId, OpenDialogOptions, QuickPickOption, StatusBarSnapshot, WorkspaceFolderItem } from '../host/HostPlatform.ts';
import { LineSplitter } from '../runtime/launch.ts';
import type { ResolvedDiffSpec } from '../vm/diffSpec.ts';
import type { EditorSnapshot } from '../vm/workbench.ts';

export const editorSnapshotSchema = z.object({
  path: z.string().min(1),
  languageId: z.string(),
  selection: z
    .object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      text: z.string(),
      diagnostics: z.array(z.string()),
    })
    .optional(),
});

export const workspaceFolderSchema = z.object({
  name: z.string(),
  path: z.string().min(1),
});

export const hostCommandSchema = z.enum([
  'openWorkbench',
  'openChat',
  'newSession',
  'interrupt',
  'selectBackend',
  'selectModel',
  'explainSelection',
  'fixSelection',
  'testSelection',
  'addToChat',
  'configureApiKey',
  'renameSession',
  'selectFolder',
  'restartRuntime',
  'openWebUI',
  'showLogs',
]);

export const sidecarInitParamsSchema = z.object({
  projectPath: z.string().min(1),
  workspaceFolders: z.array(workspaceFolderSchema).default([]),
  ideLanguage: z.string().default('en'),
  workspaceTrusted: z.boolean().default(true),
  windowFocused: z.boolean().default(true),
  httpProxy: z.string().nullable().optional(),
  extensionVersion: z.string().default('0.4.0'),
  /** 可选覆盖配置与状态根目录（默认 `~/.harness-deck`，端到端测试时传入临时目录）。 */
  configRoot: z.string().min(1).optional(),
  activeEditor: editorSnapshotSchema.nullable().optional(),
  dirtyFiles: z.array(z.string()).optional(),
});

export type SidecarInitParams = z.infer<typeof sidecarInitParamsSchema>;

export const editorStateChangedParamsSchema = z.object({
  activeEditor: editorSnapshotSchema.nullable().optional(),
  dirtyFiles: z.array(z.string()).optional(),
  windowFocused: z.boolean().optional(),
  workspaceTrusted: z.boolean().optional(),
  workspaceFolders: z.array(workspaceFolderSchema).optional(),
  httpProxy: z.string().nullable().optional(),
});

export type EditorStateChangedParams = z.infer<typeof editorStateChangedParamsSchema>;

export const executeCommandParamsSchema = z.object({
  command: hostCommandSchema,
  activeEditor: editorSnapshotSchema.nullable().optional(),
  dirtyFiles: z.array(z.string()).optional(),
});

export type ExecuteCommandParams = z.infer<typeof executeCommandParamsSchema>;

/** Sidecar 向 IDE 发出的强类型调用封装接口。 */
export interface IdeRpcClient {
  postToWebview(message: HostToWebview): void;
  statusUpdate(snapshot: StatusBarSnapshot): void;
  log(channel: 'host' | 'runtime', line: string, stream?: 'stdout' | 'stderr'): void;
  openWorkbenchPanel(title: string): void;
  openHostSettings(): void;
  showLogs(): void;
  progressStart(progressId: string, title: string): void;
  progressEnd(progressId: string): void;

  focusChatView(): Promise<void>;
  openDiff(spec: ResolvedDiffSpec): Promise<void>;
  openFile(path: string, range?: { readonly startLine: number; readonly endLine?: number }): Promise<void>;
  findFiles(query: string): Promise<readonly FileCandidate[]>;
  saveAll(): Promise<void>;
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  input(options: {
    readonly title: string;
    readonly prompt?: string;
    readonly value?: string;
    readonly placeHolder?: string;
    readonly password?: boolean;
    readonly allowEmpty?: boolean;
  }): Promise<string | undefined>;
  pickOpenDialog(options: OpenDialogOptions): Promise<readonly string[]>;
  pickQuickItem(
    items: readonly QuickPickOption[],
    options: { readonly placeHolder: string; readonly ignoreFocusOut?: boolean },
  ): Promise<string | undefined>;
  showMessage(
    level: 'info' | 'warning' | 'error',
    message: string,
    actions?: readonly string[],
  ): Promise<string | undefined>;
  openExternal(url: string): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
  openProjectWindow(path: string): Promise<void>;
  runInTerminal(options: {
    readonly name: string;
    readonly cwd: string;
    readonly commands: readonly string[];
  }): Promise<void>;
  secretGet(key: string): Promise<string | undefined>;
  secretStore(key: string, value: string): Promise<void>;
  secretDelete(key: string): Promise<void>;
}

export interface JsonRpcHandlers {
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onClose?: () => void;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

/**
 * 双向 NDJSON JSON-RPC 2.0 通道（每行一条 JSON 消息）。
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingCall>();
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonRpcHandlers,
  ) {
    const splitter = new LineSplitter((line) => this.handleLine(line));
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string | Buffer) => {
      splitter.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.input.on('end', () => {
      splitter.flush();
      this.close(new Error('Sidecar input stream ended'));
    });
    this.input.on('error', (err) => {
      this.close(err instanceof Error ? err : new Error(String(err)));
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', method, params });
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`RPC channel closed before calling ${method}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            if (this.pending.delete(id)) {
              reject(new Error(`RPC timeout calling ${method} after ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        ...(timer ? { timer } : {}),
      });
      this.writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeRaw(payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.output.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // 输出管道已断开，等待 close 清理
    }
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const id = msg.id;
    const method = msg.method;

    // 请求或通知
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') {
        void this.handlers
          .onRequest(method, msg.params)
          .then((result) => {
            this.writeRaw({ jsonrpc: '2.0', id, result: result ?? {} });
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.writeRaw({ jsonrpc: '2.0', id, error: { code: -32000, message } });
          });
      } else {
        this.handlers.onNotification(method, msg.params);
      }
      return;
    }

    // 响应
    if (typeof id === 'number' || typeof id === 'string') {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      if (call.timer) clearTimeout(call.timer);
      if (msg.error && typeof msg.error === 'object') {
        const errObj = msg.error as { message?: unknown };
        call.reject(new Error(typeof errObj.message === 'string' ? errObj.message : 'RPC error'));
      } else {
        call.resolve(msg.result);
      }
    }
  }

  close(reason = new Error('RPC channel closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(reason);
    }
    this.pending.clear();
    this.handlers.onClose?.();
  }
}

export function createIdeRpcClient(peer: JsonRpcPeer): IdeRpcClient {
  return {
    postToWebview: (message) => peer.notify('ide/postToWebview', { message }),
    statusUpdate: (snapshot) => peer.notify('ide/statusUpdate', snapshot),
    log: (channel, line, stream) => peer.notify('ide/log', { channel, line, ...(stream ? { stream } : {}) }),
    openWorkbenchPanel: (title) => peer.notify('ide/openWorkbenchPanel', { title }),
    openHostSettings: () => peer.notify('ide/openHostSettings', {}),
    showLogs: () => peer.notify('ide/showLogs', {}),
    progressStart: (progressId, title) => peer.notify('ide/progressStart', { progressId, title }),
    progressEnd: (progressId) => peer.notify('ide/progressEnd', { progressId }),

    focusChatView: async () => {
      await peer.request('ide/focusChatView', {});
    },
    openDiff: async (spec) => {
      await peer.request('ide/openDiff', { spec });
    },
    openFile: async (path, range) => {
      await peer.request('ide/openFile', { path, ...(range ? { range } : {}) });
    },
    findFiles: async (query) => {
      const res = await peer.request<{ items?: FileCandidate[] }>('ide/findFiles', { query });
      return Array.isArray(res?.items) ? res.items : [];
    },
    saveAll: async () => {
      await peer.request('ide/saveAll', {});
    },
    confirm: async (message, detail, action) => {
      const res = await peer.request<{ confirmed?: boolean }>('ide/confirm', { message, detail, action });
      return res?.confirmed === true;
    },
    input: async (options) => {
      const res = await peer.request<{ value?: string | null }>('ide/input', options);
      return typeof res?.value === 'string' ? res.value : undefined;
    },
    pickOpenDialog: async (options) => {
      const res = await peer.request<{ paths?: string[] }>('ide/pickOpenDialog', options);
      return Array.isArray(res?.paths) ? res.paths : [];
    },
    pickQuickItem: async (items, options) => {
      const res = await peer.request<{ id?: string | null }>('ide/pickQuickItem', {
        items,
        placeHolder: options.placeHolder,
        ...(options.ignoreFocusOut !== undefined ? { ignoreFocusOut: options.ignoreFocusOut } : {}),
      });
      return typeof res?.id === 'string' ? res.id : undefined;
    },
    showMessage: async (level, message, actions = []) => {
      const res = await peer.request<{ action?: string | null }>('ide/showMessage', { level, message, actions });
      return typeof res?.action === 'string' ? res.action : undefined;
    },
    openExternal: async (url) => {
      const res = await peer.request<{ opened?: boolean }>('ide/openExternal', { url });
      return res?.opened === true;
    },
    writeClipboard: async (text) => {
      await peer.request('ide/writeClipboard', { text });
    },
    openProjectWindow: async (path) => {
      await peer.request('ide/openProjectWindow', { path });
    },
    runInTerminal: async (options) => {
      await peer.request('ide/runInTerminal', options);
    },
    secretGet: async (key) => {
      const res = await peer.request<{ value?: string | null }>('ide/secretGet', { key });
      return typeof res?.value === 'string' ? res.value : undefined;
    },
    secretStore: async (key, value) => {
      await peer.request('ide/secretStore', { key, value });
    },
    secretDelete: async (key) => {
      await peer.request('ide/secretDelete', { key });
    },
  };
}

export type { EditorSnapshot, HostCommandId, WorkspaceFolderItem };

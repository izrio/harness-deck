/**
 * `~/.harness-deck/` 文件持久化实现：
 * - FileSettingsStore：`~/.harness-deck/settings.json`，支持嵌套或点分路径读写、原子写入（tmp + rename）与跨进程文件监听重载
 * - FileKeyValueStore：`~/.harness-deck/global-state.json` 与 `~/.harness-deck/workspaces/<hash>.json`
 */
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { KeyValueStore, SettingsStore } from '../host/HostPlatform.ts';

let tempSeq = 0;

async function atomicWriteJson(filePath: string, data: unknown): Promise<string> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${++tempSeq}.tmp`);
  await writeFile(tmpPath, serialized, 'utf8');
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return serialized;
}

async function readJsonObject(filePath: string): Promise<{ readonly raw: string; readonly obj: Record<string, unknown> }> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { raw, obj: parsed as Record<string, unknown> };
    }
    return { raw, obj: {} };
  } catch {
    return { raw: '', obj: {} };
  }
}

export function workspaceStateFilePath(configRoot: string, projectPath: string): string {
  const normalized = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return join(configRoot, 'workspaces', `${hash}.json`);
}

export class FileKeyValueStore implements KeyValueStore {
  private data: Record<string, unknown>;
  private lastWrittenRaw: string;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly externalListeners = new Set<() => void>();
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly filePath: string,
    initialRaw: string,
    initialData: Record<string, unknown>,
    watchExternal: boolean,
  ) {
    this.lastWrittenRaw = initialRaw;
    this.data = { ...initialData };
    if (watchExternal) {
      this.startWatching();
    }
  }

  static async open(filePath: string, options: { readonly watchExternal?: boolean } = {}): Promise<FileKeyValueStore> {
    await mkdir(dirname(filePath), { recursive: true });
    const { raw, obj } = await readJsonObject(filePath);
    return new FileKeyValueStore(filePath, raw, obj, options.watchExternal === true);
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.data[key];
    } else {
      this.data[key] = value;
    }
    const snapshot = structuredClone(this.data);
    const next = this.writeChain.then(async () => {
      this.lastWrittenRaw = await atomicWriteJson(this.filePath, snapshot);
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private startWatching(): void {
    const dir = dirname(this.filePath);
    const targetName = basename(this.filePath);
    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (filename && filename !== targetName) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          void this.reloadFromDisk();
        }, 80);
      });
    } catch {
      // 某些文件系统不支持 watch 时忽略
    }
  }

  onDidExternalChange(listener: () => void): () => void {
    this.externalListeners.add(listener);
    return () => this.externalListeners.delete(listener);
  }

  /** 供跨进程监听或测试显式触发磁盘重载。 */
  async reloadFromDisk(): Promise<void> {
    await this.writeChain;
    const { raw, obj } = await readJsonObject(this.filePath);
    if (!raw || raw === this.lastWrittenRaw) return;
    this.lastWrittenRaw = raw;
    this.data = obj;
    for (const listener of this.externalListeners) listener();
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
    this.externalListeners.clear();
  }
}

function getByDotPath(root: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(root, key)) {
    return root[key];
  }
  const parts = key.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setByDotPath(root: Record<string, unknown>, key: string, value: unknown): void {
  // 清理可能存在的旧扁平键
  if (key.includes('.') && Object.prototype.hasOwnProperty.call(root, key)) {
    delete root[key];
  }
  const parts = key.split('.');
  if (parts.length === 1) {
    if (value === undefined) delete root[key];
    else root[key] = value;
    return;
  }
  const stack: { parent: Record<string, unknown>; prop: string }[] = [];
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      if (value === undefined) return;
      const created: Record<string, unknown> = {};
      cur[part] = created;
      stack.push({ parent: cur, prop: part });
      cur = created;
    } else {
      stack.push({ parent: cur, prop: part });
      cur = next as Record<string, unknown>;
    }
  }
  const leaf = parts[parts.length - 1]!;
  if (value === undefined) {
    delete cur[leaf];
    for (let i = stack.length - 1; i >= 0; i--) {
      const { parent, prop } = stack[i]!;
      const child = parent[prop] as Record<string, unknown>;
      if (Object.keys(child).length === 0) delete parent[prop];
      else break;
    }
  } else {
    cur[leaf] = value;
  }
}

function flattenLeaves(obj: Record<string, unknown>, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // projects 是 map<projectPath, config>，顶层应视作整个 `projects` 设置项
      if (full === 'projects') {
        out.set(full, JSON.stringify(v));
      } else {
        flattenLeaves(v as Record<string, unknown>, full, out);
      }
    } else {
      out.set(full, JSON.stringify(v));
    }
  }
  return out;
}

function diffSettingKeys(prev: Record<string, unknown>, next: Record<string, unknown>): Set<string> {
  const a = flattenLeaves(prev);
  const b = flattenLeaves(next);
  const changed = new Set<string>();
  for (const [k, v] of a) {
    if (b.get(k) !== v) changed.add(k);
  }
  for (const [k, v] of b) {
    if (a.get(k) !== v) changed.add(k);
  }
  return changed;
}

export class FileSettingsStore implements SettingsStore {
  private data: Record<string, unknown>;
  private lastWrittenRaw: string;
  private httpProxy: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(changedKeys: ReadonlySet<string>) => void>();
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly filePath: string,
    initialRaw: string,
    initialData: Record<string, unknown>,
    httpProxy?: string,
  ) {
    this.lastWrittenRaw = initialRaw;
    this.data = structuredClone(initialData);
    this.httpProxy = httpProxy?.trim() || undefined;
    this.startWatching();
  }

  static async open(filePath: string, httpProxy?: string): Promise<FileSettingsStore> {
    await mkdir(dirname(filePath), { recursive: true });
    const { raw, obj } = await readJsonObject(filePath);
    return new FileSettingsStore(filePath, raw, obj, httpProxy);
  }

  get<T>(key: string, defaultValue: T): T {
    const val = getByDotPath(this.data, key);
    return val === undefined ? defaultValue : (val as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    setByDotPath(this.data, key, value);
    const snapshot = structuredClone(this.data);
    const writeTask = this.writeChain.then(async () => {
      this.lastWrittenRaw = await atomicWriteJson(this.filePath, snapshot);
    });
    this.writeChain = writeTask.catch(() => undefined);
    await writeTask;
    this.emit(new Set([key]));
  }

  getHttpProxy(): string | undefined {
    const configured = getByDotPath(this.data, 'http.proxy');
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    return this.httpProxy;
  }

  setIdeHttpProxy(proxy: string | undefined | null): void {
    this.httpProxy = proxy?.trim() || undefined;
  }

  onDidChange(listener: (changedKeys: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(changedKeys: ReadonlySet<string>): void {
    if (changedKeys.size === 0) return;
    for (const listener of this.listeners) {
      listener(changedKeys);
    }
  }

  private startWatching(): void {
    const dir = dirname(this.filePath);
    const targetName = basename(this.filePath);
    try {
      this.watcher = watch(dir, (_eventType, filename) => {
        if (filename && filename !== targetName) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          void this.reloadFromDisk();
        }, 80);
      });
    } catch {
      // ignore if fs.watch unsupported
    }
  }

  /** 供跨进程监听或测试显式触发磁盘重载。 */
  async reloadFromDisk(): Promise<void> {
    await this.writeChain;
    const { raw, obj } = await readJsonObject(this.filePath);
    if (!raw || raw === this.lastWrittenRaw) return;
    const prev = this.data;
    this.lastWrittenRaw = raw;
    this.data = obj;
    const changed = diffSettingKeys(prev, obj);
    this.emit(changed);
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
  }
}

/**
 * Sidecar 侧的 Workbench 实现：
 * - `activeEditor()` 与 `dirtyFiles()` 直接读取由 IDE（Kotlin）事件流同步过来的内存快照，保持同步返回签名；
 * - `readFile()` 直接通过 Node.js 文件系统读取本地磁盘文件；
 * - `openDiff()` 先通过 `resolveDiffSpec` 计算好两侧内容或 Unified Patch，再通过 JSON-RPC 发给 IDE 原生 Diff 视图渲染；
 * - 其余交互（打开文件、搜索文件、保存全部、模态确认、输入框）均转发给 IDE 执行。
 */
import { readFile } from 'node:fs/promises';
import type { FileCandidate } from '@harness-deck/shared';
import { resolveDiffSpec } from '../vm/diffSpec.ts';
import type { DiffRequest, EditorSnapshot, Workbench } from '../vm/workbench.ts';
import type { IdeRpcClient } from './protocol.ts';

export class RemoteWorkbench implements Workbench {
  private currentEditor: EditorSnapshot | undefined;
  private currentDirtyFiles: readonly string[] = [];

  constructor(
    private readonly ide: IdeRpcClient,
    initialEditor?: EditorSnapshot | null,
    initialDirtyFiles?: readonly string[],
  ) {
    this.currentEditor = initialEditor ?? undefined;
    this.currentDirtyFiles = initialDirtyFiles ? [...initialDirtyFiles].sort() : [];
  }

  /** 更新来自 IDE 的编辑器选区与未保存文件快照，返回是否发生了变化。 */
  updateState(patch: {
    readonly activeEditor?: EditorSnapshot | null | undefined;
    readonly dirtyFiles?: readonly string[] | undefined;
  }): boolean {
    let changed = false;
    if (patch.activeEditor !== undefined) {
      const next = patch.activeEditor ?? undefined;
      if (JSON.stringify(this.currentEditor) !== JSON.stringify(next)) {
        this.currentEditor = next;
        changed = true;
      }
    }
    if (patch.dirtyFiles !== undefined) {
      const next = [...patch.dirtyFiles].sort();
      if (
        next.length !== this.currentDirtyFiles.length ||
        next.some((item, idx) => item !== this.currentDirtyFiles[idx])
      ) {
        this.currentDirtyFiles = next;
        changed = true;
      }
    }
    return changed;
  }

  activeEditor(): EditorSnapshot | undefined {
    return this.currentEditor;
  }

  dirtyFiles(): readonly string[] {
    return this.currentDirtyFiles;
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  async openDiff(request: DiffRequest): Promise<void> {
    const spec = await resolveDiffSpec(request, (p) => this.readFile(p));
    if (spec.kind === 'cannotPreview') {
      void this.ide.showMessage('info', spec.message);
      return;
    }
    await this.ide.openDiff(spec);
  }

  async openFile(path: string, range?: { readonly startLine: number; readonly endLine?: number }): Promise<void> {
    await this.ide.openFile(path, range);
  }

  async findFiles(query: string): Promise<FileCandidate[]> {
    const items = await this.ide.findFiles(query);
    return [...items];
  }

  async saveAll(): Promise<void> {
    await this.ide.saveAll();
  }

  async confirm(message: string, detail: string, action: string): Promise<boolean> {
    return await this.ide.confirm(message, detail, action);
  }

  async input(options: {
    readonly title: string;
    readonly prompt?: string;
    readonly value?: string;
    readonly placeHolder?: string;
    readonly password?: boolean;
    readonly allowEmpty?: boolean;
  }): Promise<string | undefined> {
    return await this.ide.input(options);
  }
}

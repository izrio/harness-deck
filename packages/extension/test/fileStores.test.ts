import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyValueStore, FileSettingsStore, workspaceStateFilePath } from '../src/sidecar/fileStores.ts';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hd-filestores-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('~/.harness-deck 文件存储（FileSettingsStore & FileKeyValueStore）', () => {
  it('FileSettingsStore 支持点分路径写入嵌套 JSON、清空时移除空父对象及跨进程重载通知', async () => {
    const dir = await makeTempDir();
    const settingsPath = join(dir, 'settings.json');
    const store = await FileSettingsStore.open(settingsPath, 'http://127.0.0.1:7890');
    try {
      expect(store.get('ui.theme', 'system')).toBe('system');
      expect(store.getHttpProxy()).toBe('http://127.0.0.1:7890');

      const events: string[][] = [];
      store.onDidChange((keys) => events.push([...keys].sort()));

      await store.update('ui.theme', 'dark');
      await store.update('ui.fontSize', 15);
      expect(store.get('ui.theme', 'system')).toBe('dark');
      expect(store.get('ui.fontSize', 0)).toBe(15);

      const diskObj = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      expect(diskObj).toEqual({ ui: { theme: 'dark', fontSize: 15 } });

      // 清空两个子项后空的 `ui` 对象也被一并清理
      await store.update('ui.theme', undefined);
      await store.update('ui.fontSize', undefined);
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({});

      // 模拟另一个 JetBrains IDE 窗口修改了 settings.json
      await writeFile(
        settingsPath,
        JSON.stringify({ ui: { theme: 'light' }, backendTrace: true }, null, 2),
        'utf8',
      );
      await store.reloadFromDisk();
      expect(store.get('ui.theme', 'system')).toBe('light');
      expect(store.get('backendTrace', false)).toBe(true);
      expect(events.at(-1)).toEqual(['backendTrace', 'ui.theme']);
    } finally {
      store.dispose();
    }
  });

  it('FileKeyValueStore 持久化键值并按项目路径生成稳定隔离的 workspace 状态文件', async () => {
    const dir = await makeTempDir();
    const wsPathA = workspaceStateFilePath(dir, '/projects/alpha');
    const wsPathB = workspaceStateFilePath(dir, '/projects/beta');
    expect(wsPathA).not.toBe(wsPathB);

    const store1 = await FileKeyValueStore.open(wsPathA);
    await store1.update('dsh.openTabs', ['s1', 's2']);
    expect(store1.get<string[]>('dsh.openTabs')).toEqual(['s1', 's2']);
    store1.dispose();

    const store2 = await FileKeyValueStore.open(wsPathA);
    expect(store2.get<string[]>('dsh.openTabs')).toEqual(['s1', 's2']);
    await store2.update('dsh.openTabs', undefined);
    expect(store2.get('dsh.openTabs')).toBeUndefined();
    store2.dispose();
  });
});

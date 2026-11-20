import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyValueStore, FileSettingsStore } from '../src/sidecar/fileStores.ts';
import { runHeadlessScheduler } from '../src/sidecar/headlessScheduler.ts';

const MOCK_ACP = join(process.cwd(), 'scripts/mock-acp-agent.mjs');
const SCHEDULE_KEY = 'harnessDeck.hub.schedules';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ScheduleRuleResult {
  readonly status: string;
  readonly output?: string;
}

/** 监听 global-state.json 磁盘写入事件，等待指定规则运行结束（不使用定时轮询）。 */
function waitForScheduleCompletion(statePath: string, ruleId: string): Promise<ScheduleRuleResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const readOnce = async (): Promise<void> => {
      if (settled) return;
      try {
        const raw = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
        const data = raw[SCHEDULE_KEY] as { rules?: { id: string; lastStatus?: string; runs?: { output?: string }[] }[] } | undefined;
        const rule = data?.rules?.find((item) => item.id === ruleId);
        const status = rule?.lastStatus;
        if (status && status !== 'running') {
          settled = true;
          watcher.close();
          const output = rule?.runs?.[0]?.output;
          resolve(output !== undefined ? { status, output } : { status });
        }
      } catch {
        // 文件原子替换间隙忽略本次读取，下一次事件会重试
      }
    };
    const watcher = watch(dirname(statePath), () => {
      void readOnce();
    });
    watcher.on('error', (err) => {
      if (settled) return;
      settled = true;
      watcher.close();
      reject(err);
    });
    void readOnce();
  });
}

describe('headless scheduler', () => {
  it('在无 IDE 的宿主里跑完一条到期定时任务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-headless-test-'));
    dirs.push(root);
    const configRoot = join(root, 'config');
    const projectPath = join(root, 'project');
    await mkdir(configRoot, { recursive: true });
    await mkdir(projectPath, { recursive: true });

    const globalState = await FileKeyValueStore.open(join(configRoot, 'global-state.json'));
    const settings = await FileSettingsStore.open(join(configRoot, 'settings.json'));
    await settings.update('backends', [
      { id: 'mock', name: 'Mock ACP', command: process.execPath, args: [MOCK_ACP], env: {} },
    ]);
    await globalState.update(SCHEDULE_KEY, {
      rules: [
        {
          id: 'due-rule',
          name: 'Due rule',
          prompt: 'say hello',
          frequency: { kind: 'once', runAt: Date.now() + 1_000 },
          backendId: 'mock',
          projectPath,
          enabled: true,
          createdAt: Date.now(),
          runs: [],
        },
      ],
      hiddenSessionIds: [],
    });
    settings.dispose();
    globalState.dispose();

    const statePath = join(configRoot, 'global-state.json');
    const completion = waitForScheduleCompletion(statePath, 'due-rule');
    const handle = await runHeadlessScheduler({ configRoot, projectPath });
    expect(handle).toBeDefined();
    try {
      const result = await completion;
      expect(result.status).toBe('succeeded');
      expect(result.output).toContain('mock scheduled reply');
    } finally {
      await handle!.stop();
    }
  }, 30_000);
});

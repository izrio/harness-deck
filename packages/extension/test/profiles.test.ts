import { describe, expect, it } from 'vitest';
import {
  DSH_PROFILE,
  deleteBackendSetting,
  parseProfiles,
  profileDriver,
  profileInstanceId,
  profileView,
  upsertBackendSetting,
} from '../src/backend/profiles.ts';

describe('底层配置', () => {
  it('driver / instanceId 拆分：旧数据回退，新配置可指定实例 id', () => {
    expect(profileDriver(DSH_PROFILE)).toBe('dsh');
    expect(profileInstanceId(DSH_PROFILE)).toBe('dsh');
    expect(profileView(DSH_PROFILE)).toMatchObject({ driver: 'dsh', instanceId: 'dsh' });

    const [dsh, custom] = parseProfiles([
      { name: 'Claude Work', instanceId: 'claude-work', command: 'claude', args: ['--acp'] },
    ]);
    expect(dsh?.id).toBe('dsh');
    expect(custom).toMatchObject({
      id: 'claude-work',
      instanceId: 'claude-work',
      driver: 'acp',
      kind: 'acp',
      name: 'Claude Work',
    });
  });

  it('dsh 总在第一位；ACP 项校验后加入，id 默认取名称', () => {
    const logs: string[] = [];
    const profiles = parseProfiles(
      [
        { name: 'oh-my-pi', command: 'omp', args: ['acp', 3], env: { A: '1', B: 2 }, installHint: ' bun install ' },
        { name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
        { name: '缺命令' },
        { id: 'OH-MY-PI', name: '重复', command: 'x' },
      ],
      (line) => logs.push(line),
    );
    expect(profiles).toEqual([
      { id: 'dsh', kind: 'dsh', name: 'DeepSeek' },
      { id: 'oh-my-pi', driver: 'acp', instanceId: 'oh-my-pi', kind: 'acp', name: 'oh-my-pi', command: 'omp', args: ['acp'], env: { A: '1' }, installHint: 'bun install' },
      { id: 'gemini-cli', driver: 'acp', instanceId: 'gemini-cli', kind: 'acp', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], env: {} },
    ]);
    expect(logs).toHaveLength(2);
  });

  it('设置不是数组时只有 dsh', () => {
    expect(parseProfiles(undefined).map((p) => p.id)).toEqual(['dsh']);
    expect(parseProfiles({ name: 'x' }).map((p) => p.id)).toEqual(['dsh']);
  });

  it('支持新增、更新、删除外部智能体配置并生成完整视图', () => {
    const added = upsertBackendSetting([], {
      id: 'Gemini CLI',
      name: 'Gemini CLI',
      command: 'gemini',
      args: ['--acp'],
      env: { GEMINI_API_KEY: 'test' },
      singleSession: true,
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe('gemini-cli');

    const updated = upsertBackendSetting(added, {
      id: 'gemini-cli',
      name: 'Gemini Pro',
      command: '/usr/local/bin/gemini',
      args: ['--acp', '--fast'],
      env: {},
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Gemini Pro');

    const parsed = parseProfiles(updated);
    const view = profileView(parsed[1]!, { builtinIds: new Set(['dsh']) });
    expect(view.custom).toBe(true);
    expect(view.executable).toBe('/usr/local/bin/gemini');
    expect(view.args).toEqual(['--acp', '--fast']);

    expect(deleteBackendSetting(updated, 'gemini-cli')).toEqual([]);

    // 避免使用保留字 dsh 作为自定义 ACP 代理 id
    const dshCustom = upsertBackendSetting([], {
      id: 'dsh',
      name: 'dsh',
      command: 'custom-dsh',
      args: [],
      env: {},
    });
    expect(dshCustom[0]?.id).toBe('dsh-acp');
  });
});

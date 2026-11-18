import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@harness-deck/shared';
import { FALLBACK_BACKENDS, getMergedModels, getProjectOptions } from '../src/lib/workbenchOptions.ts';

const provider = (id: string, bound: string[], models: string[]): ProviderView =>
  ({ id, name: id.toUpperCase(), boundBackendIds: bound, models: models.map((m) => ({ id: m, name: '' })) }) as unknown as ProviderView;

describe('getProjectOptions', () => {
  it('当前工作区优先，最近项目按路径去重', () => {
    const options = getProjectOptions({
      currentPath: '/w/beta',
      recent: [
        { path: '/w/alpha', name: 'alpha' },
        { path: '/w/beta', name: 'Beta Project' },
      ],
    } as never);
    expect(options).toEqual([
      ['/w/beta', 'Beta Project'],
      ['/w/alpha', 'alpha'],
    ]);
  });

  it('当前工作区不在最近列表时用目录名', () => {
    expect(getProjectOptions({ currentPath: '/w/gamma', recent: [] } as never)).toEqual([['/w/gamma', 'gamma']]);
    expect(getProjectOptions({ recent: [] } as never)).toEqual([]);
  });
});

describe('getMergedModels', () => {
  it('绑定到当前智能体的服务商优先，并按键去重 models.options', () => {
    const list = getMergedModels(
      'claude',
      [provider('a', [], ['m1']), provider('b', ['claude'], ['m2'])],
      { options: [{ provider: 'b', model: 'm2', name: 'dup', group: 'g' }, { provider: 'x', model: 'm3', name: 'M3', group: 'rt' }] } as never,
    );
    expect(list).toEqual([
      { key: 'b::m2', label: 'm2 (B)' },
      { key: 'a::m1', label: 'm1 (A)' },
      { key: 'x::m3', label: 'M3 (rt)' },
    ]);
  });
});

describe('FALLBACK_BACKENDS', () => {
  it('包含 dsh 作为首个兜底', () => {
    expect(FALLBACK_BACKENDS[0]?.id).toBe('dsh');
  });
});

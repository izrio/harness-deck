import { beforeEach, describe, expect, it } from 'vitest';
import type { HostSnapshot, Item } from '@harness-deck/shared';
import {
  applyHostMessage,
  getState,
  openSettingsPage,
  resetStoreForTests,
  setActiveModule,
  setSettingsTab,
} from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('webview store', () => {
  it('snapshot 初始化状态并将 ready 置为 true', () => {
    const snap: HostSnapshot = makeSnapshot({
      locale: 'en',
      session: { id: 'sess-1', title: 'Audit', running: false, hasOlder: false, loadingOlder: false, sync: 'live' },
    });
    applyHostMessage({ type: 'snapshot', payload: snap });

    const s = getState();
    expect(s.ready).toBe(true);
    expect(s.locale).toBe('en');
    expect(s.sessionKey).toBe('sess-1');
  });

  it('items 非 reset 增量若 sessionKey 不匹配则丢弃', () => {
    applyHostMessage({ type: 'snapshot', payload: makeSnapshot({ session: { id: 'sess-a', title: 'A', running: false, hasOlder: false, loadingOlder: false, sync: 'live' } }) });
    const itemA: Item = { kind: 'user', id: 'u1', text: 'hello' };
    applyHostMessage({ type: 'items', payload: { sessionKey: 'sess-a', reset: true, upsert: [itemA], order: ['u1'] } });
    expect(getState().items).toHaveLength(1);

    const staleItem: Item = { kind: 'user', id: 'u2', text: 'stale' };
    applyHostMessage({ type: 'items', payload: { sessionKey: 'sess-other', reset: false, upsert: [staleItem], order: ['u1', 'u2'] } });
    expect(getState().items).toEqual([itemA]);
  });

  it('fileCandidates 忽略过期 requestId，保留单调递增的最新结果', () => {
    applyHostMessage({ type: 'fileCandidates', payload: { requestId: 5, items: [{ path: 'src/a.ts', kind: 'file' }] } });
    expect(getState().fileCandidates.requestId).toBe(5);

    applyHostMessage({ type: 'fileCandidates', payload: { requestId: 3, items: [{ path: 'src/stale.ts', kind: 'file' }] } });
    expect(getState().fileCandidates.requestId).toBe(5);
    expect(getState().fileCandidates.items).toEqual([{ path: 'src/a.ts', kind: 'file' }]);
  });

  it('setActiveModule 与 openSettingsPage 正确切换模块并规范化旧设置页标签', () => {
    setActiveModule('schedules', 'rule-1');
    expect(getState().activeModule).toBe('schedules');
    expect(getState().moduleExplicit).toBe(true);
    expect(getState().inspectScheduleRuleId).toBe('rule-1');

    openSettingsPage('interface');
    expect(getState().settingsOpen).toBe(true);
    expect(getState().settingsTab).toBe('appearance');

    setSettingsTab('extensions');
    expect(getState().settingsTab).toBe('skills');
  });
});

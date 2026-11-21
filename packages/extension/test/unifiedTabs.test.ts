import { describe, expect, it } from 'vitest';
import { UnifiedTabsModel, type PersistedUnifiedTabs } from '../src/vm/UnifiedTabs.ts';

function makeModel(saved?: unknown) {
  let persisted: PersistedUnifiedTabs | undefined;
  const model = new UnifiedTabsModel({
    load: () => saved,
    save: (next) => {
      persisted = next;
    },
  });
  return {
    model,
    get persisted() {
      return persisted;
    },
    summary: () => model.items.map((t) => ({ backendId: t.backendId, sessionId: t.sessionId, cachedTitle: t.cachedTitle })),
  };
}

const VALID = new Set(['dsh', 'claude', 'pi', 'zcode']);

describe('UnifiedTabsModel 跨智能体统一会话标签', () => {
  it('核心场景：DeepSeek 已有会话 -> 新建标签 -> 切换到 Claude，保留两个标签且归属正确', () => {
    const { model, summary } = makeModel();
    model.restore({
      defaultBackendId: 'dsh',
      validBackendIds: VALID,
      fallbackTabs: [{ sessionId: 's1', title: 'DSH 任务' }],
      fallbackActiveSessionId: 's1',
    });

    expect(summary()).toEqual([{ backendId: 'dsh', sessionId: 's1', cachedTitle: 'DSH 任务' }]);

    // 新建会话标签
    const blank = model.openNew('dsh');
    expect(summary()).toEqual([
      { backendId: 'dsh', sessionId: 's1', cachedTitle: 'DSH 任务' },
      { backendId: 'dsh', sessionId: undefined, cachedTitle: undefined },
    ]);
    expect(model.activeTabKey).toBe(blank.key);

    // 在新标签页切换到 Claude：就地改变新标签的智能体归属，不清空 DeepSeek 标签
    model.setTabBackend(blank.key, 'claude');
    expect(summary()).toEqual([
      { backendId: 'dsh', sessionId: 's1', cachedTitle: 'DSH 任务' },
      { backendId: 'claude', sessionId: undefined, cachedTitle: undefined },
    ]);
    expect(model.activeTabKey).toBe(blank.key);

    // Claude 发出首条消息：先绑定 pending key，再 rekey 为真实 sessionId
    model.bindCurrentSession('claude', 'pending:1', 'Claude 调研');
    expect(model.current).toMatchObject({ backendId: 'claude', sessionId: 'pending:1', cachedTitle: 'Claude 调研' });

    model.rekeySession('claude', 'pending:1', 'claude-real-1');
    expect(summary()).toEqual([
      { backendId: 'dsh', sessionId: 's1', cachedTitle: 'DSH 任务' },
      { backendId: 'claude', sessionId: 'claude-real-1', cachedTitle: 'Claude 调研' },
    ]);
  });

  it('持久化与冷启动恢复：保留跨智能体标签顺序与缓存标题，不持久化 pending 会话', () => {
    const first = makeModel();
    first.model.restore({
      defaultBackendId: 'dsh',
      validBackendIds: VALID,
      fallbackTabs: [{ sessionId: 's1', title: 'DSH 会话' }],
      fallbackActiveSessionId: 's1',
    });
    first.model.open('claude', 'c1', 'Claude 会话');
    first.model.openNew('pi');
    first.model.bindCurrentSession('pi', 'pending:temp', '临时');

    expect(first.persisted).toEqual({
      items: [
        { backendId: 'dsh', sessionId: 's1', title: 'DSH 会话' },
        { backendId: 'claude', sessionId: 'c1', title: 'Claude 会话' },
      ],
      active: { backendId: 'pi' },
    });

    // 重启恢复（默认智能体为 claude）：恢复 dsh 与 claude 标签并激活 claude
    const second = makeModel(first.persisted);
    const res = second.model.restore({
      defaultBackendId: 'claude',
      validBackendIds: VALID,
    });
    expect(res.restoredFromPersisted).toBe(true);
    expect(second.summary()).toEqual([
      { backendId: 'dsh', sessionId: 's1', cachedTitle: 'DSH 会话' },
      { backendId: 'claude', sessionId: 'c1', cachedTitle: 'Claude 会话' },
    ]);
    expect(second.model.current).toMatchObject({ backendId: 'claude', sessionId: 'c1' });
  });

  it('同一会话去重、后台 rekey、关闭当前/后台/最后一个标签', () => {
    const { model, summary } = makeModel();
    model.restore({
      defaultBackendId: 'dsh',
      validBackendIds: VALID,
      fallbackTabs: [{ sessionId: 's1', title: 'DSH 1' }],
      fallbackActiveSessionId: 's1',
    });
    const claudeTab = model.open('claude', 'pending:2', 'Claude 新任务');
    // 切回 DeepSeek 标签后，Claude 在后台完成 rekey
    const dshKey = model.items[0]!.key;
    model.setActive(dshKey);
    expect(model.rekeySession('claude', 'pending:2', 'c2')).toBe(true);
    expect(model.items[1]).toMatchObject({ key: claudeTab.key, backendId: 'claude', sessionId: 'c2' });

    // 重复打开已存在的 Claude 会话：直接激活不新增
    model.open('claude', 'c2');
    expect(model.items).toHaveLength(2);
    expect(model.activeTabKey).toBe(claudeTab.key);

    // 关闭非激活标签 dsh：不改变当前激活的 Claude 标签
    const closeBg = model.close(dshKey);
    expect(closeBg?.activeChanged).toBe(false);
    expect(summary()).toEqual([{ backendId: 'claude', sessionId: 'c2', cachedTitle: 'Claude 新任务' }]);

    // 关闭最后一个会话标签：替换为同智能体的空新对话标签
    const closeLast = model.close(claudeTab.key);
    expect(closeLast?.activeChanged).toBe(true);
    expect(summary()).toEqual([{ backendId: 'claude', sessionId: undefined, cachedTitle: undefined }]);

    // 仅剩一个空标签时无法关闭
    expect(model.close(model.activeTabKey)).toBeUndefined();
  });

  it('新开的标签始终追加到最右侧，不插入当前标签之后', () => {
    const { model, summary } = makeModel();
    model.restore({
      defaultBackendId: 'dsh',
      validBackendIds: VALID,
      fallbackTabs: [
        { sessionId: 's1', title: 'DSH 1' },
        { sessionId: 's2', title: 'DSH 2' },
      ],
      fallbackActiveSessionId: 's1',
    });
    expect(summary().map((t) => t.sessionId)).toEqual(['s1', 's2']);

    // 当前激活的是第一个标签，新会话仍然出现在最右侧
    const claudeTab = model.open('claude', 'c1', 'Claude 1');
    expect(summary().map((t) => t.sessionId)).toEqual(['s1', 's2', 'c1']);
    expect(model.activeTabKey).toBe(claudeTab.key);

    // 新建空对话同样追加到末尾
    const blank = model.openNew('pi');
    expect(summary().map((t) => t.sessionId)).toEqual(['s1', 's2', 'c1', undefined]);
    expect(model.activeTabKey).toBe(blank.key);
  });

  it('拖动排序写回持久化顺序，批量关闭按相对位置处理后保留活动标签或接管右侧标签', () => {
    const ctx = makeModel();
    const { model, summary } = ctx;
    const persisted = () => ctx.persisted;
    model.restore({
      defaultBackendId: 'dsh',
      validBackendIds: VALID,
      fallbackTabs: [{ sessionId: 's1', title: 'DSH 1' }],
      fallbackActiveSessionId: 's1',
    });
    model.open('claude', 'c1', 'Claude 1');
    model.open('pi', 'p1', 'Pi 1');
    const [dshTab, claudeTab, piTab] = model.items;
    expect(summary().map((t) => t.sessionId)).toEqual(['s1', 'c1', 'p1']);

    // 把第一个标签拖到最后：顺序持久化，活动标签不变
    expect(model.move(dshTab!.key, 2)).toBe(true);
    expect(summary().map((t) => t.sessionId)).toEqual(['c1', 'p1', 's1']);
    expect(persisted()?.items.map((t) => t.sessionId)).toEqual(['c1', 'p1', 's1']);
    expect(model.activeTabKey).toBe(piTab!.key);

    // 关闭其他：活动标签保留
    const others = model.closeMany([claudeTab!.key, dshTab!.key]);
    expect(others).toMatchObject({ activeChanged: false });
    expect(others?.closed.map((t) => t.sessionId).sort()).toEqual(['c1', 's1']);
    expect(summary().map((t) => t.sessionId)).toEqual(['p1']);
    expect(model.activeTabKey).toBe(piTab!.key);

    // 关闭的标签里包含活动标签：接管它右侧的标签
    model.open('claude', 'c2', 'Claude 2');
    model.open('dsh', 's2', 'DSH 2');
    const active = model.current!;
    expect(active.sessionId).toBe('s2');
    const res = model.closeMany([model.items[0]!.key, active.key]);
    expect(res?.activeChanged).toBe(true);
    expect(model.current?.sessionId).toBe('c2');

    // 关闭全部：补一个空的新对话标签
    const all = model.closeMany(model.items.map((t) => t.key));
    expect(all?.closed).toHaveLength(1);
    expect(summary()).toEqual([{ backendId: 'claude', sessionId: undefined, cachedTitle: undefined }]);
  });

  it('删除自定义智能体时清理归属标签，并在全部清空时补齐默认智能体空标签', () => {
    const { model, summary } = makeModel();
    model.restore({
      defaultBackendId: 'custom-acp',
      validBackendIds: new Set(['dsh', 'custom-acp']),
      fallbackTabs: [{ sessionId: 'a1', title: 'ACP 任务' }],
      fallbackActiveSessionId: 'a1',
    });
    const res = model.removeBackend('custom-acp', 'dsh');
    expect(res.activeChanged).toBe(true);
    expect(summary()).toEqual([{ backendId: 'dsh', sessionId: undefined, cachedTitle: undefined }]);
  });
});

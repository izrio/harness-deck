import { describe, expect, it } from 'vitest';
import type { NotificationPreferences } from '@harness-deck/shared';
import { NotificationDispatcher } from '../src/notifications/NotificationService.ts';

function createHarness(overrides: { focused?: boolean; prefs?: Partial<NotificationPreferences>; clickAction?: boolean } = {}) {
  let focused = overrides.focused ?? false;
  const shown: { level: 'info' | 'warning'; message: string; actionLabel: string }[] = [];
  const opened: (string | undefined)[] = [];
  const prefs: NotificationPreferences = {
    enabled: true,
    onlyWhenUnfocused: true,
    onAttention: true,
    onTurnComplete: true,
    onUnexpectedExit: true,
    onScheduledComplete: true,
    ...overrides.prefs,
  };
  const dispatcher = new NotificationDispatcher({
    isWindowFocused: () => focused,
    getPreferences: () => prefs,
    showNotification: async (level, message, actionLabel) => {
      shown.push({ level, message, actionLabel });
      return overrides.clickAction ?? false;
    },
    openSession: (sessionId) => {
      opened.push(sessionId);
    },
    actionLabel: () => '回到会话',
  });
  return {
    dispatcher,
    shown,
    opened,
    setFocused: (v: boolean) => {
      focused = v;
    },
    prefs,
  };
}

const format = {
  attention: (agent: string, title: string) => `${agent} 等待确认: ${title}`,
  turnComplete: (agent: string, title: string) => `${agent} 完成一轮: ${title}`,
  scheduledComplete: (title: string) => `目标完成: ${title}`,
};

describe('NotificationDispatcher', () => {
  it('窗口在前台且开启 onlyWhenUnfocused 时不通知，切到后台后通知并支持点击回到对应会话', async () => {
    const h = createHarness({ focused: true, clickAction: true });
    h.dispatcher.observeSession({
      sessionId: 's1',
      title: '重构设置页',
      agentName: 'DeepSeek',
      running: true,
      sync: 'live',
      interactionIds: ['req-1'],
      format,
    });
    await Promise.resolve();
    expect(h.shown).toHaveLength(0);

    h.setFocused(false);
    h.dispatcher.observeSession({
      sessionId: 's1',
      title: '重构设置页',
      agentName: 'DeepSeek',
      running: true,
      sync: 'live',
      interactionIds: ['req-1'],
      format,
    });
    await Promise.resolve();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.message).toContain('等待确认');
    expect(h.opened).toEqual(['s1']);

    // 同一请求不重复通知
    h.dispatcher.observeSession({
      sessionId: 's1',
      title: '重构设置页',
      agentName: 'DeepSeek',
      running: true,
      sync: 'live',
      interactionIds: ['req-1'],
      format,
    });
    await Promise.resolve();
    expect(h.shown).toHaveLength(1);
  });

  it('完成一轮、目标任务完成与异常退出时按开关通知', async () => {
    const h = createHarness({ focused: false, clickAction: true });

    h.dispatcher.observeSession({
      sessionId: 's2',
      title: '修复测试',
      agentName: 'Claude',
      running: true,
      sync: 'live',
      interactionIds: [],
      goalPhase: 'active',
      goalObjective: '跑通测试',
      format,
    });
    h.dispatcher.observeSession({
      sessionId: 's2',
      title: '修复测试',
      agentName: 'Claude',
      running: false,
      sync: 'live',
      interactionIds: [],
      goalPhase: 'complete',
      goalObjective: '跑通测试',
      format,
    });
    await Promise.resolve();

    expect(h.shown.map((s) => s.message)).toEqual(['Claude 完成一轮: 修复测试', '目标完成: 跑通测试']);
    expect(h.opened).toEqual(['s2', 's2']);

    h.dispatcher.observeRuntimeExit({ kind: 'failed', message: 'boom', sessionId: 's2', text: 'Claude 异常退出: boom' });
    await Promise.resolve();
    expect(h.shown.at(-1)?.level).toBe('warning');
  });

  it('关闭通知或关闭特定子类时不弹出，测试通知可绕过焦点限制', async () => {
    const h = createHarness({ focused: true, prefs: { onTurnComplete: false }, clickAction: true });
    h.dispatcher.observeSession({
      sessionId: 's3',
      title: '会话3',
      agentName: 'DeepSeek',
      running: true,
      sync: 'live',
      interactionIds: [],
      format,
    });
    h.setFocused(false);
    h.dispatcher.observeSession({
      sessionId: 's3',
      title: '会话3',
      agentName: 'DeepSeek',
      running: false,
      sync: 'live',
      interactionIds: [],
      format,
    });
    await Promise.resolve();
    expect(h.shown).toHaveLength(0);

    h.setFocused(true);
    await h.dispatcher.sendTest('测试通知', 's3');
    expect(h.shown).toHaveLength(1);
    expect(h.opened).toEqual(['s3']);
  });

  it('被用户中断或出错结束的轮次不误报为已完成', async () => {
    const h = createHarness({ focused: false });
    h.dispatcher.observeSession({
      sessionId: 's4',
      title: '中断测试',
      agentName: 'DeepSeek',
      running: true,
      sync: 'live',
      interactionIds: [],
      format,
    });
    h.dispatcher.observeSession({
      sessionId: 's4',
      title: '中断测试',
      agentName: 'DeepSeek',
      running: false,
      sync: 'live',
      interactionIds: [],
      turnAborted: true,
      format,
    });
    await Promise.resolve();
    expect(h.shown).toHaveLength(0);
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ScheduleRule, WorkbenchState } from '@harness-deck/shared';
import { SchedulesView } from '../src/components/workbench/SchedulesView.tsx';
import { applyHostMessage } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

function makeWorkbench(schedules: readonly ScheduleRule[]): WorkbenchState {
  return {
    overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
    schedules,
    agents: [],
    tasks: { items: [], autoRun: true },
    sessionGroups: [],
  };
}

function seedSchedules(schedules: readonly ScheduleRule[]): void {
  render(<SchedulesView />);
  act(() => {
    applyHostMessage({
      type: 'snapshot',
      payload: makeSnapshot({
        workbench: makeWorkbench(schedules),
      }),
    });
  });
}

function getRunToggle(runId: string): HTMLButtonElement {
  const container = screen.getByTestId(`schedule-run-${runId}`);
  return within(container).getByRole('button');
}

const sampleRules: readonly ScheduleRule[] = [
  {
    id: 'rule-a',
    name: '每日构建检查',
    prompt: '检查构建状态并输出报告',
    frequency: { kind: 'daily', time: '09:00' },
    backendId: 'dsh',
    projectPath: '/repo/alpha',
    enabled: true,
    createdAt: 1_700_000_000_000,
    runs: [
      {
        id: 'run-latest',
        ruleId: 'rule-a',
        startedAt: 1_700_002_000_000,
        endedAt: 1_700_002_005_000,
        status: 'succeeded',
        backendId: 'dsh',
        projectPath: '/repo/alpha',
        output: '最新执行输出内容',
      },
      {
        id: 'run-older',
        ruleId: 'rule-a',
        startedAt: 1_700_001_000_000,
        endedAt: 1_700_001_005_000,
        status: 'succeeded',
        backendId: 'dsh',
        projectPath: '/repo/alpha',
        output: '较早执行输出内容',
        unread: true,
      },
    ],
  },
  {
    id: 'rule-b',
    name: '每周依赖审计',
    prompt: '检查过期依赖',
    frequency: { kind: 'weekly', days: [1], time: '10:00' },
    backendId: 'dsh',
    projectPath: '/repo/beta',
    enabled: true,
    createdAt: 1_700_000_100_000,
    runs: [
      {
        id: 'run-b-latest',
        ruleId: 'rule-b',
        startedAt: 1_700_003_000_000,
        endedAt: 1_700_003_004_000,
        status: 'succeeded',
        backendId: 'dsh',
        projectPath: '/repo/beta',
        output: '规则 B 最新输出',
      },
      {
        id: 'run-b-older',
        ruleId: 'rule-b',
        startedAt: 1_700_002_500_000,
        endedAt: 1_700_002_504_000,
        status: 'failed',
        backendId: 'dsh',
        projectPath: '/repo/beta',
        output: '规则 B 历史输出',
      },
    ],
  },
];

beforeEach(() => {
  vscode.reset();
});

describe('SchedulesView 执行历史手风琴回归测试', () => {
  it('默认仅展开最新一条执行记录，且支持折叠、切换与全收起', () => {
    seedSchedules(sampleRules);

    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-a'));

    // 1. 最新记录默认展开，较早记录折叠
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('最新执行输出内容')).toBeTruthy();
    expect(getRunToggle('run-older').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('较早执行输出内容')).toBeNull();

    // 2. 点击最新记录标题可将其折叠
    fireEvent.click(getRunToggle('run-latest'));
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('最新执行输出内容')).toBeNull();
    expect(getRunToggle('run-older').getAttribute('aria-expanded')).toBe('false');

    // 3. 点击较早记录将其展开，且不会重新打开最新记录
    fireEvent.click(getRunToggle('run-older'));
    expect(getRunToggle('run-older').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('较早执行输出内容')).toBeTruthy();
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('最新执行输出内容')).toBeNull();

    // 4. 再次点击较早记录后两条都处于收起状态
    fireEvent.click(getRunToggle('run-older'));
    expect(getRunToggle('run-older').getAttribute('aria-expanded')).toBe('false');
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('较早执行输出内容')).toBeNull();
    expect(screen.queryByText('最新执行输出内容')).toBeNull();
  });

  it('不同规则之间的执行记录展开状态互相独立', () => {
    seedSchedules(sampleRules);

    // 在规则 A 中折叠最新记录并切换到较早记录
    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-a'));
    fireEvent.click(getRunToggle('run-older'));
    expect(getRunToggle('run-older').getAttribute('aria-expanded')).toBe('true');

    // 切换到规则 B：规则 B 仍默认展开其最新记录
    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-b'));
    expect(getRunToggle('run-b-latest').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('规则 B 最新输出')).toBeTruthy();
    expect(getRunToggle('run-b-older').getAttribute('aria-expanded')).toBe('false');

    // 收起规则 B 的最新记录
    fireEvent.click(getRunToggle('run-b-latest'));
    expect(getRunToggle('run-b-latest').getAttribute('aria-expanded')).toBe('false');

    // 切回规则 A：规则 A 仍保持之前展开 run-older 的状态
    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-a'));
    expect(getRunToggle('run-older').getAttribute('aria-expanded')).toBe('true');
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('false');
  });

  it('点击未读执行记录时仍发送 markScheduleRunRead 消息', () => {
    seedSchedules(sampleRules);

    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-a'));
    fireEvent.click(getRunToggle('run-older'));

    expect(vscode.posted).toContainEqual({
      type: 'markScheduleRunRead',
      payload: { ruleId: 'rule-a', runId: 'run-older' },
    });
  });

  it('点击立即执行会清除该规则的显式折叠覆盖，使最新记录重新默认展开', () => {
    seedSchedules(sampleRules);

    fireEvent.click(screen.getByTestId('schedule-history-toggle-rule-a'));
    fireEvent.click(getRunToggle('run-latest'));
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('schedule-run-now-rule-a'));
    expect(vscode.posted).toContainEqual({
      type: 'runScheduleNow',
      payload: { id: 'rule-a' },
    });
    expect(getRunToggle('run-latest').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('最新执行输出内容')).toBeTruthy();
  });
});

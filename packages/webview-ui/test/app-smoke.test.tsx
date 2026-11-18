// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/App.tsx';
import { applyHostMessage } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
});

describe('App jsdom 冒烟测试', () => {
  it('挂载时发送 ready 消息，应用快照后渲染首页建议并支持工作台标签切换', () => {
    render(<App />);

    expect(vscode.posted).toContainEqual({ type: 'ready', payload: {} });

    act(() => {
      applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
    });

    expect(screen.getByTestId('suggestions')).toBeTruthy();

    fireEvent.click(screen.getByTestId('workbench-tab-schedules'));
    expect(screen.getByTestId('workbench-schedules')).toBeTruthy();
  });
});

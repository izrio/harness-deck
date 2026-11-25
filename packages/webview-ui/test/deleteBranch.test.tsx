// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ComposerFooter } from '../src/components/ComposerFooter.tsx';
import { ChangesView } from '../src/components/workbench/ChangesView.tsx';
import { applyHostMessage, resetStoreForTests } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

function seedSourceControl(branches = ['main', 'feat/demo', 'fix/bug'], branch = 'main') {
  act(() => {
    applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
    applyHostMessage({
      type: 'workbench',
      payload: {
        overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
        schedules: [],
        agents: [],
        tasks: { items: [], autoRun: false },
        sessionGroups: [],
        sourceControl: {
          available: true,
          root: '/repo/harness-deck',
          branch,
          branches,
          remote: 'origin',
          files: [],
          additions: 0,
          deletions: 0,
          updatedAt: Date.now(),
        },
      },
    });
  });
}

beforeEach(() => {
  vscode.reset();
  resetStoreForTests();
});

describe('本地分支删除与二次确认弹窗', () => {
  it('ComposerFooter 禁止删除当前分支，非当前分支点击删除先弹二次确认再发送消息（含取消与强制删除）', () => {
    render(<ComposerFooter />);
    seedSourceControl();
    vscode.posted.length = 0;

    fireEvent.click(screen.getByTestId('composer-branch-trigger'));
    expect(screen.queryByTestId('composer-branch-delete-main')).toBeNull();
    expect(screen.getByTestId('composer-branch-delete-feat/demo')).toBeTruthy();

    // 1. 点击删除弹出二次确认框，此时尚未发送删除请求
    fireEvent.click(screen.getByTestId('composer-branch-delete-feat/demo'));
    expect(screen.getByTestId('composer-delete-branch-dialog')).toBeTruthy();
    expect(vscode.posted.some((m) => m.type === 'sourceControlDeleteBranch')).toBe(false);

    // 2. 点击取消关闭弹窗，不发送请求
    fireEvent.click(screen.getByTestId('composer-delete-branch-cancel'));
    expect(screen.queryByTestId('composer-delete-branch-dialog')).toBeNull();
    expect(vscode.posted.some((m) => m.type === 'sourceControlDeleteBranch')).toBe(false);

    // 3. 重新打开，勾选强制删除并确认
    fireEvent.click(screen.getByTestId('composer-branch-trigger'));
    fireEvent.click(screen.getByTestId('composer-branch-delete-fix/bug'));
    fireEvent.click(screen.getByTestId('composer-delete-branch-force'));
    fireEvent.click(screen.getByTestId('composer-delete-branch-confirm'));

    expect(vscode.posted.at(-1)).toEqual({
      type: 'sourceControlDeleteBranch',
      payload: { branch: 'fix/bug', force: true, confirmed: true },
    });
  });

  it('ChangesView 分支列表同样支持非当前分支删除与二次确认', () => {
    render(<ChangesView />);
    seedSourceControl();
    vscode.posted.length = 0;

    fireEvent.click(screen.getByTestId('changes-branch-trigger'));
    expect(screen.queryByTestId('changes-branch-delete-main')).toBeNull();

    fireEvent.click(screen.getByTestId('changes-branch-delete-feat/demo'));
    expect(screen.getByTestId('changes-delete-branch-dialog')).toBeTruthy();
    expect(vscode.posted.some((m) => m.type === 'sourceControlDeleteBranch')).toBe(false);

    fireEvent.click(screen.getByTestId('changes-delete-branch-confirm'));
    expect(vscode.posted.at(-1)).toEqual({
      type: 'sourceControlDeleteBranch',
      payload: { branch: 'feat/demo', force: false, confirmed: true },
    });
  });
});

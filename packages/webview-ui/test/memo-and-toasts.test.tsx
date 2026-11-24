// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Item } from '@harness-deck/shared';
import { App } from '../src/App.tsx';
import { ItemView } from '../src/components/Items.tsx';
import { TurnDone } from '../src/components/RunStatus.tsx';
import { translator } from '../src/i18n.ts';
import {
  applyHostMessage,
  closeSettingsPage,
  openSettingsPage,
  setActiveModule,
  toggleRightPanel,
} from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();

beforeEach(() => {
  vscode.reset();
});

describe('Toasts 挂载稳定性与 TurnDone memo', () => {
  it('切换聊天、设置、右侧面板与工作台模块时保持同一个 .toast DOM 节点不卸载重挂载', () => {
    const { container } = render(<App />);

    act(() => {
      applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
      applyHostMessage({ type: 'toast', payload: { level: 'error', text: 'Persistent error' } });
    });

    const initialToast = container.querySelector('.toast');
    const viewport = screen.getByTestId('toast-viewport');
    expect(initialToast).not.toBeNull();
    expect(initialToast?.textContent).toContain('Persistent error');
    expect(viewport.className).toContain('top-12');
    expect(viewport.className).toContain('right-3');

    act(() => {
      openSettingsPage();
    });
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(container.querySelector('.toast')).toBe(initialToast);
    expect(screen.getByTestId('toast-viewport').className).toContain('top-12');

    act(() => {
      closeSettingsPage();
    });
    expect(container.querySelector('.toast')).toBe(initialToast);
    expect(screen.getByTestId('toast-viewport').className).toContain('top-12');

    act(() => {
      toggleRightPanel();
    });
    expect(container.querySelector('.toast')).toBe(initialToast);

    act(() => {
      toggleRightPanel();
      setActiveModule('overview');
    });
    expect(container.querySelector('.toast')).toBe(initialToast);

    act(() => {
      setActiveModule('sessions');
    });
    expect(container.querySelector('.toast')).toBe(initialToast);
  });

  it('TurnDone 传入 copyText 时渲染复制按钮并随完成状态展示，未传时省略复制按钮', () => {
    const completedTurn: Extract<Item, { kind: 'turnDone' }> = {
      id: 'turn-1',
      kind: 'turnDone',
      durationMs: 2_500,
      completed: true,
    };

    const { rerender } = render(<TurnDone item={completedTurn} copyText="Hello" />);
    const copyLabel = translator('zh')('assistant.copy');

    expect(screen.getByTestId('turn-done')).toBeTruthy();
    expect(screen.getByRole('button', { name: copyLabel })).toBeTruthy();

    rerender(<TurnDone item={completedTurn} />);
    expect(screen.getByTestId('turn-done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: copyLabel })).toBeNull();
  });

  it('ItemView 与 TurnDone 使用 React.memo 并在传入 turnDoneCopyText 时正常透传', () => {
    expect((ItemView as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    expect((TurnDone as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));

    const turnDoneItem: Extract<Item, { kind: 'turnDone' }> = {
      id: 'turn-2',
      kind: 'turnDone',
      durationMs: 1_200,
      completed: true,
    };

    const { rerender } = render(<ItemView item={turnDoneItem} turnDoneCopyText="Reply text" />);
    const firstButton = screen.getByRole('button', { name: translator('zh')('assistant.copy') });

    rerender(<ItemView item={turnDoneItem} turnDoneCopyText="Reply text" />);
    expect(screen.getByRole('button', { name: translator('zh')('assistant.copy') })).toBe(firstButton);
  });
});

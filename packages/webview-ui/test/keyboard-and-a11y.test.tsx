// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKBENCH_MODULES } from '@harness-deck/shared/limits';
import { Header } from '../src/components/Header.tsx';
import { SettingsPage } from '../src/components/SettingsPage.tsx';
import { SessionsView } from '../src/components/workbench/SessionsView.tsx';
import * as store from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

describe('keyboard navigation, Escape precedence, and sidebar shortcut cleanup', () => {
  beforeEach(() => {
    mockVsCodeApi();
    document.cookie = 'sidebar_state=; path=/; max-age=0';
  });

  it('Header tablist moves focus on ArrowLeft/ArrowRight/Home/End and keeps roving tabIndex when an overlay opens', () => {
    act(() => {
      store.applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
      store.setActiveModule('overview');
    });

    render(<Header />);

    const overviewTab = screen.getByTestId('workbench-tab-overview');
    const secondModule = WORKBENCH_MODULES[1]!;
    const secondTab = screen.getByTestId(`workbench-tab-${secondModule}`);
    const lastModule = WORKBENCH_MODULES[WORKBENCH_MODULES.length - 1]!;
    const lastTab = screen.getByTestId(`workbench-tab-${lastModule}`);

    expect(overviewTab.id).toBe('workbench-tab-overview');
    expect(overviewTab.getAttribute('aria-controls')).toBe('workbench-panel-overview');
    expect(overviewTab.getAttribute('tabindex')).toBe('0');
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');

    overviewTab.focus();
    expect(document.activeElement).toBe(overviewTab);

    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    expect(store.getState().activeModule).toBe(secondModule);
    expect(document.activeElement).toBe(secondTab);
    expect(secondTab.getAttribute('tabindex')).toBe('0');
    expect(overviewTab.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(secondTab, { key: 'ArrowLeft' });
    expect(store.getState().activeModule).toBe('overview');
    expect(document.activeElement).toBe(overviewTab);

    fireEvent.keyDown(overviewTab, { key: 'End' });
    expect(store.getState().activeModule).toBe(lastModule);
    expect(document.activeElement).toBe(lastTab);

    fireEvent.keyDown(lastTab, { key: 'Home' });
    expect(store.getState().activeModule).toBe('overview');
    expect(document.activeElement).toBe(overviewTab);

    act(() => {
      store.openSettingsPage();
    });

    expect(overviewTab.getAttribute('tabindex')).toBe('0');
    expect(overviewTab.getAttribute('aria-selected')).toBe('false');
  });

  it('SettingsPage closes on Escape when no dialog is open', () => {
    act(() => {
      store.applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
      store.openSettingsPage('appearance');
    });

    render(<SettingsPage />);
    expect(store.getState().settingsOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(store.getState().settingsOpen).toBe(false);
  });

  it('SettingsPage Escape closes an open Radix dialog first without closing SettingsPage', () => {
    act(() => {
      store.applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
      store.openSettingsPage('commands');
    });

    render(<SettingsPage />);
    expect(store.getState().settingsOpen).toBe(true);

    fireEvent.click(screen.getByTestId('chat-command-add-btn'));
    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    expect(dialogContent).not.toBeNull();

    act(() => {
      fireEvent.keyDown(dialogContent!, { key: 'Escape', bubbles: true, cancelable: true });
    });

    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(store.getState().settingsOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(store.getState().settingsOpen).toBe(false);
  });

  it('SessionsView and SettingsPage do not intercept Ctrl/Cmd+B or persist sidebar_state cookie', () => {
    act(() => {
      store.applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          workbench: {
            overview: { waiting: [], todos: [], running: [], upcoming: [], unread: [] },
            schedules: [],
            agents: [],
            tasks: { items: [], autoRun: true },
            sessionGroups: [
              {
                projectPath: '/repo/demo',
                projectName: 'demo',
                isCurrent: true,
                sessions: [
                  {
                    id: 's1',
                    title: 'Session 1',
                    projectPath: '/repo/demo',
                    backendId: 'dsh',
                    backendName: 'DeepSeek',
                    running: false,
                    updatedAt: 1000,
                  },
                ],
              },
            ],
          },
        }),
      });
      store.openSettingsPage('appearance');
    });

    render(
      <>
        <SessionsView>
          <div>chat-body</div>
        </SessionsView>
        <SettingsPage />
      </>,
    );

    expect(screen.getByTestId('workbench-sessions')).toBeTruthy();

    const ctrlB = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(ctrlB);
    expect(ctrlB.defaultPrevented).toBe(false);

    const cmdB = new KeyboardEvent('keydown', { key: 'b', metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(cmdB);
    expect(cmdB.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByTestId('toggle-project-groups'));
    expect(document.cookie).not.toContain('sidebar_state');
  });
});

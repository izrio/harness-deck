// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PendingInteraction } from '@harness-deck/shared';
import { App } from '../src/App.tsx';
import { Composer } from '../src/components/Composer.tsx';
import { InteractionCard } from '../src/components/Interactions.tsx';
import { applyHostMessage, closeSettingsPage, setActiveModule } from '../src/store.ts';
import { makeSnapshot, mockVsCodeApi } from './setup.ts';

const vscode = mockVsCodeApi();
const OriginalFileReader = globalThis.FileReader;

beforeEach(() => {
  vscode.reset();
});

afterEach(() => {
  globalThis.FileReader = OriginalFileReader;
  vi.useRealTimers();
});

const twoTabs = [
  { key: 'tab-1', title: '会话一', running: false },
  { key: 'tab-2', title: '会话二', running: false },
];

const approvalInteraction: Extract<PendingInteraction, { kind: 'approval' }> = {
  kind: 'approval',
  id: 'app-1',
  toolName: 'bash',
  reason: '运行测试命令',
  subjectKind: 'command',
  subject: 'echo hello',
  dirtyFiles: [],
  previewable: false,
};

describe('Composer async image tab-switch guard', () => {
  it('stashes async-read images under the originating tab when the active tab changes mid-read', async () => {
    let triggerLoad: (() => void) | undefined;

    class DeferredFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        triggerLoad = () => {
          this.result = 'data:image/png;base64,aGVsbG8=';
          this.onload?.();
        };
      }
    }

    globalThis.FileReader = DeferredFileReader as unknown as typeof FileReader;

    render(<Composer />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({ tabs: { items: twoTabs, active: 'tab-1' } }),
      });
    });

    const file = new File(['png-bytes'], 'race.png', { type: 'image/png' });
    const fileInput = screen.getByTestId('composer-image-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(triggerLoad).toBeDefined();

    // Switch to tab-2 before FileReader finishes
    act(() => {
      applyHostMessage({
        type: 'tabs',
        payload: { items: twoTabs, active: 'tab-2' },
      });
    });

    // Resolve FileReader while tab-2 is active
    await act(async () => {
      triggerLoad?.();
      await Promise.resolve();
    });

    // Image must NOT leak into tab-2
    expect(screen.queryByTestId('composer-images')).toBeNull();

    // Switching back to tab-1 restores the stashed image
    act(() => {
      applyHostMessage({
        type: 'tabs',
        payload: { items: twoTabs, active: 'tab-1' },
      });
    });

    const imagesContainer = screen.getByTestId('composer-images');
    expect(imagesContainer.querySelectorAll('img')).toHaveLength(1);
  });
});

describe('InteractionCard resilience', () => {
  it('recovers ApprovalCard buttons after 4s timeout when interaction remains mounted', () => {
    vi.useFakeTimers();
    act(() => {
      applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
    });

    render(<InteractionCard interaction={approvalInteraction} />);

    const allowBtn = screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement;
    const rejectBtn = screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement;
    expect(allowBtn.disabled).toBe(false);

    fireEvent.click(allowBtn);
    expect(vscode.posted.at(-1)).toEqual({
      type: 'respondApproval',
      commandId: expect.any(String),
      payload: { id: 'app-1', decision: 'allow' },
    });
    expect(allowBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);
    expect(allowBtn.querySelector('.spin')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(allowBtn.disabled).toBe(false);
    expect(rejectBtn.disabled).toBe(false);
    expect(allowBtn.querySelector('.spin')).toBeNull();
  });

  it('recovers ApprovalCard sent lock immediately when dirtyFiles updates', () => {
    act(() => {
      applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
    });

    const { rerender } = render(<InteractionCard interaction={approvalInteraction} />);

    const allowBtn = screen.getByRole('button', { name: '允许本次' }) as HTMLButtonElement;
    const rejectBtn = screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement;

    fireEvent.click(allowBtn);
    expect(allowBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);

    // Host updates dirtyFiles on the still-mounted interaction
    rerender(<InteractionCard interaction={{ ...approvalInteraction, dirtyFiles: ['src/app.ts'] }} />);
    expect(rejectBtn.disabled).toBe(false);
    expect(allowBtn.disabled).toBe(true); // blocked by dirtyFiles

    // Once dirtyFiles clears, Allow is immediately available without waiting for 4s
    rerender(<InteractionCard interaction={{ ...approvalInteraction, dirtyFiles: [] }} />);
    expect(allowBtn.disabled).toBe(false);
  });

  it('renders null without throwing when QuestionCard receives an empty questions array', () => {
    act(() => {
      applyHostMessage({ type: 'snapshot', payload: makeSnapshot() });
    });

    const { container } = render(
      <InteractionCard interaction={{ kind: 'question', id: 'q-empty', questions: [] }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('RuntimeSetupView 首页无运行时初始化引导', () => {
  it('全部运行时未安装时展示初始化页面而非首页与输入框，并支持一键安装', () => {
    closeSettingsPage();
    setActiveModule('sessions');
    render(<App />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          runtime: { kind: 'notInstalled' },
          connection: 'idle',
          backends: {
            active: 'dsh',
            nodeEnv: { checked: true, hasNode: true, hasNpm: true },
            items: [
              { id: 'dsh', name: 'DeepSeek', kind: 'dsh', available: false, npmPackage: '@deepseek-ai/dsh' },
              { id: 'claude', name: 'Claude Code', kind: 'claude', available: false, npmPackage: '@anthropic-ai/claude-code' },
            ],
          },
        }),
      });
    });

    expect(screen.getByTestId('runtime-setup-page')).toBeTruthy();
    expect(screen.queryByTestId('suggestions')).toBeNull();

    fireEvent.click(screen.getByTestId('runtime-setup-install-claude'));
    expect(vscode.posted).toContainEqual({ type: 'installBackend', payload: { id: 'claude' } });
  });

  it('当前运行时未安装但本机已有其他运行时时，可一键启用并切换', () => {
    closeSettingsPage();
    setActiveModule('sessions');
    render(<App />);
    act(() => {
      applyHostMessage({
        type: 'snapshot',
        payload: makeSnapshot({
          runtime: { kind: 'notInstalled' },
          connection: 'idle',
          backends: {
            active: 'dsh',
            nodeEnv: { checked: true, hasNode: true, hasNpm: true },
            items: [
              { id: 'dsh', name: 'DeepSeek', kind: 'dsh', available: false, npmPackage: '@deepseek-ai/dsh' },
              { id: 'claude', name: 'Claude Code', kind: 'claude', available: true, version: '1.2.3' },
            ],
          },
        }),
      });
    });

    expect(screen.getByTestId('runtime-setup-installed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('runtime-setup-use-claude'));
    expect(vscode.posted).toContainEqual({ type: 'selectBackend', payload: { id: 'claude' } });
  });
});

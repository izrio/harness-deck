// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostToWebview } from '@harness-deck/shared';

const posted: unknown[] = [];
let AppearancePanel: typeof import('../src/components/AppearancePanel.tsx').AppearancePanel;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  store = await import('../src/store.ts');
  ({ AppearancePanel } = await import('../src/components/AppearancePanel.tsx'));
});

afterEach(() => {
  cleanup();
  store.resetStoreForTests();
  posted.length = 0;
});

describe('阅读与聊天排版面板', () => {
  it('加减字号、行高、段距与内容宽度：本地立即生效，并写入设置', () => {
    store.applyHostMessage({
      type: 'appearance',
      payload: { theme: 'dark', fontSize: 15, lineHeight: 1.6, paragraphSpacing: 10, contentWidth: 820 },
    } as HostToWebview);
    render(createElement(AppearancePanel));

    expect(screen.getByTestId('appearance-size').textContent).toBe('15px');
    fireEvent.click(screen.getByRole('button', { name: '增大字号' }));
    expect(store.getState().appearance.fontSize).toBe(16);
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { fontSize: 16 } });

    fireEvent.click(screen.getByRole('button', { name: '增大行高' }));
    expect(store.getState().appearance.lineHeight).toBe(1.7);
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { lineHeight: 1.7 } });

    fireEvent.click(screen.getByRole('button', { name: '增大段距' }));
    expect(store.getState().appearance.paragraphSpacing).toBe(12);
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { paragraphSpacing: 12 } });

    fireEvent.click(screen.getByTestId('width-preset-980'));
    expect(store.getState().appearance.contentWidth).toBe(980);
    expect(posted).toContainEqual({ type: 'setAppearance', payload: { contentWidth: 980 } });
  });

  it('字体输入回车保存；恢复排版默认只重置阅读与聊天排版，不重置主题', () => {
    store.applyHostMessage({
      type: 'appearance',
      payload: { theme: 'dark', fontSize: 17, lineHeight: 1.8 },
    } as HostToWebview);
    render(createElement(AppearancePanel));

    const input = screen.getByTestId('prose-font-family');
    fireEvent.change(input, { target: { value: 'Microsoft YaHei UI' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted.at(-1)).toEqual({ type: 'setAppearance', payload: { fontFamily: 'Microsoft YaHei UI' } });

    fireEvent.click(screen.getByTestId('prose-reset'));
    expect(posted.at(-1)).toEqual({
      type: 'setAppearance',
      payload: { fontSize: null, fontFamily: null, lineHeight: null, paragraphSpacing: null, contentWidth: null },
    });
    expect(store.getState().appearance).toEqual({ theme: 'dark' });
    expect(screen.getByTestId('appearance-size').textContent).toBe('14px');
  });
});

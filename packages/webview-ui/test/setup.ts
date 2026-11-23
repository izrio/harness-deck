import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { HostSnapshot, WebviewToHost } from '@harness-deck/shared';
import { resetStoreForTests } from '../src/store.ts';
import type { PersistedState } from '../src/vscode.ts';

interface VsCodeMockSink {
  posted: WebviewToHost[];
  state: PersistedState | undefined;
}

const sink: VsCodeMockSink = {
  posted: [],
  state: undefined,
};

let apiInstalled = false;

/**
 * 安装并返回一个可重置的 VS Code Webview API mock。
 * 由于 `vscode.ts` 会在模块生命周期内缓存第一次 `acquireVsCodeApi()` 的返回值，
 * 这里通过共享的 `sink` 转发所有调用，确保多个测试/用例间 `posted` 与持久化状态都能彻底重置。
 */
export function mockVsCodeApi(): {
  posted: WebviewToHost[];
  reset: () => void;
  getPersistedState: () => PersistedState | undefined;
} {
  sink.posted.length = 0;
  sink.state = undefined;

  if (!apiInstalled) {
    apiInstalled = true;
    let acquired = false;
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
      // 模拟真实 VS Code Webview 行为：同一页面只能调用一次 acquireVsCodeApi()
      if (acquired) {
        throw new Error('An instance of the VS Code API has already been acquired');
      }
      acquired = true;
      return {
        postMessage: (message: WebviewToHost) => {
          sink.posted.push(message);
        },
        getState: () => sink.state,
        setState: (next: PersistedState) => {
          sink.state = next;
        },
      };
    };
  }

  return {
    posted: sink.posted,
    reset: () => {
      sink.posted.length = 0;
      sink.state = undefined;
    },
    getPersistedState: () => sink.state,
  };
}

/** 构造一份最小可用的 `HostSnapshot`，便于组件测试按需覆盖字段。 */
export function makeSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    runtime: { kind: 'connected', version: '1.0.0', newerThanTested: false },
    connection: 'connected',
    sessions: [],
    tabs: { items: [{ key: 'tab-1', title: '新对话', running: false }], active: 'tab-1' },
    session: { title: '新对话', running: false, hasOlder: false, loadingOlder: false, sync: 'idle' },
    items: [],
    models: { options: [] },
    interactions: [],
    permissions: { options: [] },
    workspace: { dirtyFiles: 0 },
    context: { includeActiveByDefault: true, pinned: [] },
    commands: [],
    locale: 'zh',
    appearance: {},
    backends: { items: [{ id: 'dsh', name: 'DeepSeek', kind: 'dsh' }], active: 'dsh' },
    ...overrides,
  };
}

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;
  }

  if (typeof Element !== 'undefined') {
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = vi.fn();
    }
    if (typeof Element.prototype.hasPointerCapture !== 'function') {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (typeof Element.prototype.setPointerCapture !== 'function') {
      Element.prototype.setPointerCapture = vi.fn();
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = vi.fn();
    }
  }

  if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollTo !== 'function') {
    HTMLElement.prototype.scrollTo = vi.fn();
  }
}

beforeEach(() => {
  resetStoreForTests();
});

afterEach(() => {
  if (typeof document !== 'undefined') {
    cleanup();
  }
  resetStoreForTests();
});

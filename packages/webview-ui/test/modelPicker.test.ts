// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { HostToWebview } from '@harness-deck/shared';

const posted: unknown[] = [];
let ModelPicker: typeof import('../src/components/ModelPicker.tsx').ModelPicker;
let store: typeof import('../src/store.ts');

beforeAll(async () => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  store = await import('../src/store.ts');
  ({ ModelPicker } = await import('../src/components/ModelPicker.tsx'));
});

afterEach(() => {
  cleanup();
  posted.length = 0;
  store.resetStoreForTests();
});

const efforts = ['off', 'low', 'medium', 'high'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));

function setModels() {
  store.applyHostMessage({ type: 'connection', payload: 'connected' } as HostToWebview);
  store.applyHostMessage({
    type: 'models',
    payload: {
      options: [
        { provider: 'p', model: 'flash', name: 'V4.1-Flash', group: 'custom', multiplier: 0.11, efforts, defaultEffort: 'high' },
        { provider: 'p', model: 'old', name: 'V4-Flash-0731', group: 'custom', efforts: [] },
      ],
      current: { provider: 'p', model: 'flash', reasoningEffort: 'medium' },
    },
  } as HostToWebview);
}

describe('模型选择', () => {
  it('上面选择模型，下面同步展示当前模型的思考等级滑块', () => {
    setModels();
    render(createElement(ModelPicker, { disabled: false }));
    fireEvent.click(screen.getByTestId('model-picker'));

    const items = document.querySelectorAll('[data-testid="model-list"] .model-item');
    expect([...items].map((el) => el.querySelector('.menu-item__label')?.textContent)).toEqual(['V4.1-Flash', 'V4-Flash-0731']);
    const active = document.querySelector('[data-testid="model-list"] .menu-item--active');
    expect(active?.textContent).toContain('V4.1-Flash');
    expect(active?.querySelector('.model-item__check svg')).not.toBeNull();
    expect(active?.querySelector('.menu-item__hint')?.textContent).toBe('Medium');
    expect(active?.querySelector('[data-testid="model-rate"]')?.textContent).toBe('0.11x');
    expect(items[1]?.querySelector('[data-testid="model-rate"]')).toBeNull();
    expect(screen.getByTestId('model-picker-rate').textContent).toBe('0.11x');

    const level = screen.getByTestId('effort-menu');
    expect(screen.getByTestId('effort-active-label').textContent).toBe('Medium');
    expect([...level.querySelectorAll('.model-effort-option .menu-item__label')].map((el) => el.textContent)).toEqual([
      'Off',
      'Low',
      'Medium',
      'High',
    ]);
    expect(level.querySelector('.menu-item--active')?.textContent).toBe('Medium');
  });

  it('在下方思考等级区域点选等级直接发送模型和思考等级', () => {
    setModels();
    render(createElement(ModelPicker, { disabled: false }));
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(posted).toEqual([{ type: 'selectModel', payload: { provider: 'p', model: 'flash', reasoningEffort: 'high' } }]);
  });

  it('只有一种或没有思考等级的模型点一下即选中并关闭浮层', () => {
    setModels();
    render(createElement(ModelPicker, { disabled: false }));
    fireEvent.click(screen.getByTestId('model-picker'));
    fireEvent.click(screen.getByText('V4-Flash-0731'));
    expect(posted).toEqual([{ type: 'selectModel', payload: { provider: 'p', model: 'old' } }]);
    expect(screen.queryByTestId('model-list')).toBeNull();
  });

  it('根据当前模型与选项识别并展示对应的模型厂商图标', () => {
    store.applyHostMessage({ type: 'connection', payload: 'connected' } as HostToWebview);
    store.applyHostMessage({
      type: 'models',
      payload: {
        options: [
          { provider: 'acp', model: 'gemini-4-neon', name: 'Gemini 4 Neon', group: 'Antigravity', efforts, defaultEffort: 'high' },
          { provider: 'acp', model: 'claude-sonnet-4', name: 'Claude Sonnet 4', group: 'Antigravity', efforts: [] },
          { provider: 'openai', model: 'gpt-5', name: 'GPT-5', group: 'OpenAI', efforts: [] },
          { provider: 'deepseek', model: 'deepseek-reasoner', name: 'DeepSeek R1', group: 'DeepSeek', efforts: [] },
          { provider: 'bailian', model: 'qwen3-coder-plus', name: 'Qwen3-Coder-Plus', group: 'Bailian', efforts: [] },
          { provider: 'zhipu', model: 'glm-5', name: 'GLM-5', group: 'Zhipu', efforts: [] },
        ],
        current: { provider: 'acp', model: 'gemini-4-neon', reasoningEffort: 'high' },
      },
    } as HostToWebview);

    render(createElement(ModelPicker, { disabled: false }));
    const trigger = screen.getByTestId('model-picker');
    expect(trigger.querySelector('[data-vendor="gemini"]')).not.toBeNull();

    fireEvent.click(trigger);
    const vendors = [...document.querySelectorAll('[data-testid="model-list"] .model-item [data-vendor]')].map((el) =>
      el.getAttribute('data-vendor'),
    );
    expect(vendors).toEqual(['gemini', 'claude', 'openai', 'deepseek', 'qwen', 'zhipu']);
  });
});

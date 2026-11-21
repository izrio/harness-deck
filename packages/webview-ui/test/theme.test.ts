// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyThemeMode, resolveIsDark } from '../src/theme.ts';

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('主题模式（浅色 / 深色 / 跟随系统）', () => {
  it('theme 模式支持浅色、深色与跟随系统解析并同步 html.dark', () => {
    expect(resolveIsDark('light')).toBe(false);
    expect(resolveIsDark('dark')).toBe(true);
    expect(typeof resolveIsDark('system')).toBe('boolean');

    applyThemeMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    applyThemeMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

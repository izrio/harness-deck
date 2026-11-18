// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { COLOR_SCHEME_SWATCHES, applyColorScheme, applyThemeMode, resolveIsDark } from '../src/theme.ts';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.colorScheme;
});

describe('主题模式与 5 套整套界面配色', () => {
  it('theme 模式支持浅色、深色与跟随系统解析并同步 html.dark', () => {
    expect(resolveIsDark('light')).toBe(false);
    expect(resolveIsDark('dark')).toBe(true);
    expect(typeof resolveIsDark('system')).toBe('boolean');

    applyThemeMode('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    applyThemeMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('内置 5 套整套配色，每套均包含浅色与深色两套色卡定义，切换配色不影响其它状态', () => {
    expect(COLOR_SCHEME_SWATCHES).toHaveLength(5);
    expect(COLOR_SCHEME_SWATCHES.map((s) => s.id)).toEqual(['slate', 'warm', 'forest', 'violet', 'rose']);

    for (const swatch of COLOR_SCHEME_SWATCHES) {
      expect(swatch.light.canvas).toMatch(/^#[0-9a-f]{6}$/iu);
      expect(swatch.dark.canvas).toMatch(/^#[0-9a-f]{6}$/iu);
      expect(swatch.light.canvas).not.toBe(swatch.dark.canvas);
    }

    applyColorScheme('forest');
    expect(document.documentElement.dataset.colorScheme).toBe('forest');
  });
});

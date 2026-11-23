/**
 * 主题同步（P2-9）：
 * 支持浅色（light）、深色（dark）与跟随系统（system），叠加 OKLCH 精选主题预设与高对比度模式，
 * 切换瞬间施加 `.no-transitions` 避免过渡闪烁，且绝不改变阅读与聊天排版参数。
 */
import type { ThemePreset } from '@harness-deck/shared';

export type ThemeMode = 'system' | 'light' | 'dark';
export type { ThemePreset };

let currentThemeMode: ThemeMode = 'dark';

/** 在单帧内临时抑制 CSS 过渡，消除明暗主题与预设切换时的闪烁。 */
function withoutTransitions(apply: () => void): void {
  if (typeof document === 'undefined') {
    apply();
    return;
  }
  const root = document.documentElement;
  root.classList.add('no-transitions');
  apply();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove('no-transitions'));
    });
  } else {
    root.classList.remove('no-transitions');
  }
}

export function detectDarkTheme(): boolean {
  if (typeof document !== 'undefined') {
    const cls = document.body.classList;
    if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast') || cls.contains('ide-dark')) return true;
    if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light') || cls.contains('ide-light')) return false;
  }
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/** 根据主题模式解析最终是否为暗色（默认深色）。 */
export function resolveIsDark(mode: ThemeMode = 'dark'): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return detectDarkTheme();
}

/** 将指定主题模式立即应用到 `html.dark`（默认深色，无闪烁，不影响阅读与聊天排版参数）。 */
export function applyThemeMode(mode: ThemeMode = 'dark'): void {
  const prevDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  currentThemeMode = mode;
  const nextDark = resolveIsDark(mode);
  if (typeof document !== 'undefined') {
    if (prevDark !== nextDark) {
      withoutTransitions(() => document.documentElement.classList.toggle('dark', nextDark));
    } else {
      document.documentElement.classList.toggle('dark', nextDark);
    }
  }
}

/** 应用 OKLCH 主题配色预设（default / grove / ocean / ember / iris）。 */
export function applyThemePreset(preset: ThemePreset = 'default'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const current = root.getAttribute('data-theme-preset') ?? 'default';
  if (current === preset) return;
  withoutTransitions(() => {
    if (preset === 'default') root.removeAttribute('data-theme-preset');
    else root.setAttribute('data-theme-preset', preset);
  });
}

/** 应用高对比度增强模式。 */
export function applyHighContrast(enabled = false): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const current = root.getAttribute('data-high-contrast') === 'true';
  if (current === enabled) return;
  withoutTransitions(() => {
    if (enabled) root.setAttribute('data-high-contrast', 'true');
    else root.removeAttribute('data-high-contrast');
  });
}

/** 监听 VS Code `body` 类名及系统主题变化，实时同步 `html.dark`。 */
export function watchAccent(): () => void {
  const apply = () => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', resolveIsDark(currentThemeMode));
    }
  };
  apply();
  const observer = typeof document !== 'undefined' ? new MutationObserver(apply) : undefined;
  if (typeof document !== 'undefined' && document.body) {
    observer?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined;
  media?.addEventListener('change', apply);
  return () => {
    observer?.disconnect();
    media?.removeEventListener('change', apply);
  };
}

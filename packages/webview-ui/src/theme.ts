/**
 * 主题同步：
 * 主题模式支持浅色（light）、深色（dark）与跟随系统（system），同步到 `html.dark`，
 * 随主题切换自动过渡，且绝不改变阅读与聊天排版参数。
 */
export type ThemeMode = 'system' | 'light' | 'dark';

let currentThemeMode: ThemeMode = 'system';

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

/** 根据主题模式解析最终是否为暗色。 */
export function resolveIsDark(mode: ThemeMode = 'system'): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return detectDarkTheme();
}

/** 将指定主题模式立即应用到 `html.dark`（不影响阅读与聊天排版参数）。 */
export function applyThemeMode(mode: ThemeMode = 'system'): void {
  currentThemeMode = mode;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolveIsDark(mode));
  }
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

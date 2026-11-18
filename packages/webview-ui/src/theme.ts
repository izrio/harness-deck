/**
 * 主题与整套配色同步：
 * - 主题模式支持浅色（light）、深色（dark）与跟随系统（system），同步到 `html.dark`；
 * - 5 套整套界面配色（slate / warm / forest / violet / rose），同步到 `html[data-color-scheme]`，
 *   每套配色内置完整的浅色与深色令牌体系，随主题切换自动过渡，且绝不改变阅读与聊天排版参数。
 */
import type { ColorSchemeId } from '@harness-deck/shared';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface SwatchHalf {
  readonly canvas: string;
  readonly surface: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly accent: string;
  readonly line: string;
}

export interface ColorSchemeSwatch {
  readonly id: ColorSchemeId;
  readonly light: SwatchHalf;
  readonly dark: SwatchHalf;
}

/** 5 套整套界面配色的左浅右深色卡预览定义（与 beautifului-foundation.css 中的 oklch 令牌一一对应）。 */
export const COLOR_SCHEME_SWATCHES: readonly ColorSchemeSwatch[] = [
  {
    id: 'slate',
    light: {
      canvas: '#f1f4f8',
      surface: '#ffffff',
      ink: '#1b212c',
      inkMuted: '#687385',
      accent: '#2b74eb',
      line: '#e3e8ef',
    },
    dark: {
      canvas: '#191b22',
      surface: '#22252f',
      ink: '#eef1f7',
      inkMuted: '#8f98a8',
      accent: '#579cf9',
      line: '#2f3441',
    },
  },
  {
    id: 'warm',
    light: {
      canvas: '#f5efe5',
      surface: '#fdfaf4',
      ink: '#2a211b',
      inkMuted: '#7a6c60',
      accent: '#c45d38',
      line: '#e7ddd0',
    },
    dark: {
      canvas: '#1e1a17',
      surface: '#28231e',
      ink: '#f4ede3',
      inkMuted: '#a5988b',
      accent: '#e07f56',
      line: '#38312b',
    },
  },
  {
    id: 'forest',
    light: {
      canvas: '#ecf3ef',
      surface: '#fafdfb',
      ink: '#182720',
      inkMuted: '#5e7469',
      accent: '#198560',
      line: '#dce7e1',
    },
    dark: {
      canvas: '#151e1a',
      surface: '#1e2924',
      ink: '#e8f3ee',
      inkMuted: '#8ba398',
      accent: '#44b98d',
      line: '#2b3a33',
    },
  },
  {
    id: 'violet',
    light: {
      canvas: '#f3eff9',
      surface: '#fcfaff',
      ink: '#231c30',
      inkMuted: '#6f6682',
      accent: '#6e4de0',
      line: '#e4ddf0',
    },
    dark: {
      canvas: '#1b1725',
      surface: '#241f31',
      ink: '#f1ecf8',
      inkMuted: '#9b91b0',
      accent: '#9f82f6',
      line: '#332c44',
    },
  },
  {
    id: 'rose',
    light: {
      canvas: '#f8eff1',
      surface: '#fefafb',
      ink: '#2c1d22',
      inkMuted: '#7d666e',
      accent: '#cc4368',
      line: '#ebdadd',
    },
    dark: {
      canvas: '#20181b',
      surface: '#2b2025',
      ink: '#f6ebee',
      inkMuted: '#aa9299',
      accent: '#e87393',
      line: '#3b2d33',
    },
  },
];

let currentThemeMode: ThemeMode = 'system';

export function detectDarkTheme(): boolean {
  if (typeof document !== 'undefined') {
    const cls = document.body.classList;
    if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return true;
    if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) return false;
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

/** 将指定整套配色方案应用到 `html[data-color-scheme]`（随 `html.dark` 自动切换浅/深色）。 */
export function applyColorScheme(scheme: ColorSchemeId = 'slate'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.colorScheme = scheme;
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

/**
 * 设置 -> 界面 -> 外观模块：
 * 分为四个独立子块：
 * 1. 主题与配色：浅色 / 深色 / 跟随系统 + 5 套整套界面配色（色卡左浅右深，随主题切换浅深）
 * 2. 阅读与聊天：字体、字号、行高、段距与内容宽度（聊天回复、计划和 Markdown 文件预览共用，切换主题不改变）
 * 3. 终端：终端与代码字体、字号、行高
 * 4. 语言：界面显示语言（跟随 VS Code / 简体中文 / English）
 */
import { useEffect, useState } from 'react';
import type { AppearanceState, ColorSchemeId, PreferencesState } from '@harness-deck/shared';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setAppearanceLocal, setPreferencesLocal, useView } from '../../store.ts';
import { COLOR_SCHEME_SWATCHES, type ColorSchemeSwatch, type ThemeMode } from '../../theme.ts';
import { postToHost } from '../../vscode.ts';
import { AppearancePanel } from '../AppearancePanel.tsx';
import {
  BookIcon,
  CheckIcon,
  GlobeIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SunIcon,
  TerminalIcon,
} from '../icons.tsx';
import { Button } from '../ui/Button.tsx';
import { Input, Select, Stepper } from '../ui/FormControls.tsx';
import { TerminalBlock } from '../ui/TerminalBlock.tsx';
import { ValuePill } from '../ui/ValuePill.tsx';

const THEME_CARDS: readonly {
  readonly mode: ThemeMode;
  readonly titleKey: MessageKey;
  readonly descKey: MessageKey;
}[] = [
  { mode: 'light', titleKey: 'settings.appearance.theme.light', descKey: 'settings.appearance.theme.lightDesc' },
  { mode: 'dark', titleKey: 'settings.appearance.theme.dark', descKey: 'settings.appearance.theme.darkDesc' },
  { mode: 'system', titleKey: 'settings.appearance.theme.system', descKey: 'settings.appearance.theme.systemDesc' },
];

const SCHEME_LABEL_KEYS: Readonly<Record<ColorSchemeId, MessageKey>> = {
  slate: 'settings.appearance.scheme.slate',
  warm: 'settings.appearance.scheme.warm',
  forest: 'settings.appearance.scheme.forest',
  violet: 'settings.appearance.scheme.violet',
  rose: 'settings.appearance.scheme.rose',
};

const MIN_TERM_SIZE = 10;
const MAX_TERM_SIZE = 20;
const DEFAULT_TERM_SIZE = 12;

const MIN_TERM_LH = 1.2;
const MAX_TERM_LH = 2.0;
const DEFAULT_TERM_LH = 1.6;

export function AppearanceSettings() {
  const t = useT();
  const appearance = useView((s) => s.appearance);
  const preferences = useView((s) => s.preferences);

  const currentTheme: ThemeMode = appearance.theme ?? 'system';
  const currentScheme: ColorSchemeId = appearance.colorScheme ?? 'slate';

  const termSize = appearance.terminalFontSize ?? DEFAULT_TERM_SIZE;
  const termLineHeight = appearance.terminalLineHeight ?? DEFAULT_TERM_LH;
  const [codeFamily, setCodeFamily] = useState(appearance.codeFontFamily ?? '');

  useEffect(() => {
    setCodeFamily(appearance.codeFontFamily ?? '');
  }, [appearance.codeFontFamily]);

  const selectTheme = (theme: ThemeMode) => {
    const next: Record<string, unknown> = { ...appearance };
    if (theme === 'system') delete next.theme;
    else next.theme = theme;
    setAppearanceLocal(next as AppearanceState);
    postToHost({ type: 'setAppearance', payload: { theme } });
  };

  const selectColorScheme = (colorScheme: ColorSchemeId) => {
    const next: Record<string, unknown> = { ...appearance };
    if (colorScheme === 'slate') delete next.colorScheme;
    else next.colorScheme = colorScheme;
    setAppearanceLocal(next as AppearanceState);
    postToHost({ type: 'setAppearance', payload: { colorScheme } });
  };

  const updateTerminal = (patch: {
    codeFontFamily?: string | null;
    terminalFontSize?: number | null;
    terminalLineHeight?: number | null;
  }) => {
    const next: Record<string, unknown> = { ...appearance };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') delete next[key];
      else next[key] = value;
    }
    setAppearanceLocal(next as AppearanceState);
    postToHost({ type: 'setAppearance', payload: patch });
  };

  const commitCodeFamily = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === (appearance.codeFontFamily ?? '')) return;
    updateTerminal({ codeFontFamily: trimmed || null });
  };

  const resetTerminal = () => {
    setCodeFamily('');
    updateTerminal({ codeFontFamily: null, terminalFontSize: null, terminalLineHeight: null });
  };

  const updateLanguage = (language: PreferencesState['language']) => {
    setPreferencesLocal({ ...preferences, language });
    postToHost({ type: 'setPreferences', payload: { language } });
  };

  const activeSwatch = COLOR_SCHEME_SWATCHES.find((s) => s.id === currentScheme) ?? COLOR_SCHEME_SWATCHES[0]!;

  return (
    <div className="flex flex-col gap-3" data-testid="settings-appearance">
      {/* 外观模块总览与子模块锚点条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-surface px-3 py-2.5 shadow-card">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-ink">
            <PaletteIcon className="size-3.5" />
          </span>
          <div className="min-w-0">
            <h3 className="m-0 text-[13px] font-semibold text-ink">{t('settings.appearance.title')}</h3>
            <p className="m-0 truncate text-[11.5px] text-ink-3">{t('settings.appearance.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[11.5px]">
          <a href="#appearance-sec-theme" className="rounded-chip bg-field px-2 py-0.5 text-ink-2 shadow-hairline transition-colors hover:bg-hover hover:text-ink">
            {t('settings.appearance.theme')}
          </a>
          <a href="#appearance-sec-reading" className="rounded-chip bg-field px-2 py-0.5 text-ink-2 shadow-hairline transition-colors hover:bg-hover hover:text-ink">
            {t('settings.appearance.reading')}
          </a>
          <a href="#appearance-sec-terminal" className="rounded-chip bg-field px-2 py-0.5 text-ink-2 shadow-hairline transition-colors hover:bg-hover hover:text-ink">
            {t('settings.appearance.terminal')}
          </a>
          <a href="#appearance-sec-language" className="rounded-chip bg-field px-2 py-0.5 text-ink-2 shadow-hairline transition-colors hover:bg-hover hover:text-ink">
            {t('settings.appearance.language')}
          </a>
        </div>
      </div>

      {/* 1. 主题 + 5 套整套界面配色 */}
      <section id="appearance-sec-theme" className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">
        <div className="primitive-card-bar border-b border-line bg-inset/50">
          <h4 className="m-0 text-[13px] font-semibold text-ink">{t('settings.appearance.theme')}</h4>
          <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.appearance.themeHint')}</p>
        </div>

        <div className="primitive-card-pad flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label={t('settings.appearance.theme')}>
            {THEME_CARDS.map(({ mode, titleKey, descKey }) => {
              const active = currentTheme === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`theme-card-${mode}`}
                  onClick={() => selectTheme(mode)}
                  className={cn(
                    'group flex flex-col gap-2 rounded-card p-2.5 text-left transition-all duration-150',
                    active
                      ? 'bg-inset shadow-[inset_0_0_0_1.5px_var(--accent)]'
                      : 'bg-field shadow-hairline hover:bg-hover',
                  )}
                >
                  <ThemePreview mode={mode} swatch={activeSwatch} />
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={cn('inline-flex shrink-0', active ? 'text-accent-ink' : 'text-ink-3')}>
                        {mode === 'light' ? <SunIcon className="size-3.5" /> : mode === 'dark' ? <MoonIcon className="size-3.5" /> : <MonitorIcon className="size-3.5" />}
                      </span>
                      <span className="truncate text-[12.5px] font-medium text-ink">{t(titleKey)}</span>
                    </div>
                    {active ? (
                      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                        <CheckIcon className="size-2.5" />
                      </span>
                    ) : null}
                  </div>
                  <span className="text-[11px] leading-snug text-ink-3">{t(descKey)}</span>
                </button>
              );
            })}
          </div>

          {/* 5 套配色：色卡左浅右深色 */}
          <div className="border-t border-line pt-3.5" data-testid="appearance-palettes">
            <div className="mb-2.5">
              <div className="text-[12.5px] font-semibold text-ink">{t('settings.appearance.palette')}</div>
              <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.appearance.paletteHint')}</p>
            </div>

            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-5"
              role="radiogroup"
              aria-label={t('settings.appearance.palette')}
            >
              {COLOR_SCHEME_SWATCHES.map((swatch) => {
                const active = currentScheme === swatch.id;
                const label = t(SCHEME_LABEL_KEYS[swatch.id]);
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-testid={`palette-card-${swatch.id}`}
                    onClick={() => selectColorScheme(swatch.id)}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-card p-2 text-left transition-all duration-150',
                      active
                        ? 'bg-inset shadow-[inset_0_0_0_1.5px_var(--accent)]'
                        : 'bg-field shadow-hairline hover:bg-hover',
                    )}
                  >
                    <SplitPaletteSwatch swatch={swatch} />
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-[12px] font-medium text-ink">{label}</span>
                      {active ? (
                        <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                          <CheckIcon className="size-2.5" />
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 2. 阅读与聊天 */}
      <section
        id="appearance-sec-reading"
        className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
        data-testid="appearance-reading-chat"
      >
        <div className="primitive-card-bar flex items-start gap-2 border-b border-line bg-inset/50">
          <BookIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
          <div className="min-w-0">
            <h4 className="m-0 text-[13px] font-semibold text-ink">{t('settings.appearance.reading')}</h4>
            <p className="mt-0.5 mb-0 text-[11.5px] leading-relaxed text-ink-3">{t('settings.appearance.readingHint')}</p>
          </div>
        </div>
        <div className="primitive-card-pad">
          <AppearancePanel />
        </div>
      </section>

      {/* 3. 终端 */}
      <section
        id="appearance-sec-terminal"
        className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
        data-testid="appearance-terminal"
      >
        <div className="primitive-card-bar flex items-start gap-2 border-b border-line bg-inset/50">
          <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
          <div className="min-w-0">
            <h4 className="m-0 text-[13px] font-semibold text-ink">{t('settings.appearance.terminal')}</h4>
            <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.appearance.terminalHint')}</p>
          </div>
        </div>

        <div className="primitive-card-pad flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.terminalFont')}</span>
            <Input
              data-testid="terminal-font-family"
              className="font-mono text-[12px]"
              value={codeFamily}
              placeholder={t('appearance.codeFamilyPlaceholder')}
              onChange={(event) => setCodeFamily(event.target.value)}
              onBlur={() => commitCodeFamily(codeFamily)}
              onKeyDown={(event) => event.key === 'Enter' && commitCodeFamily(codeFamily)}
            />
          </label>

          <div className="flex items-center justify-between gap-2.5">
            <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.terminalSize')}</span>
            <div className="flex items-center gap-2">
              {appearance.terminalFontSize === undefined ? <ValuePill className="text-[11px]">{t('appearance.default')}</ValuePill> : null}
              <Stepper
                valueLabel={`${termSize}px`}
                valueTestId="terminal-font-size"
                canDecrease={termSize > MIN_TERM_SIZE}
                canIncrease={termSize < MAX_TERM_SIZE}
                decreaseLabel={t('settings.appearance.terminalSizeSmaller')}
                increaseLabel={t('settings.appearance.terminalSizeLarger')}
                onDecrease={() => updateTerminal({ terminalFontSize: Math.max(MIN_TERM_SIZE, termSize - 1) })}
                onIncrease={() => updateTerminal({ terminalFontSize: Math.min(MAX_TERM_SIZE, termSize + 1) })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2.5">
            <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.terminalLineHeight')}</span>
            <div className="flex items-center gap-2">
              {appearance.terminalLineHeight === undefined ? <ValuePill className="text-[11px]">{t('appearance.default')}</ValuePill> : null}
              <Stepper
                valueLabel={termLineHeight.toFixed(1)}
                valueTestId="terminal-line-height"
                canDecrease={termLineHeight > MIN_TERM_LH + 0.01}
                canIncrease={termLineHeight < MAX_TERM_LH - 0.01}
                decreaseLabel={t('settings.appearance.terminalLineHeightSmaller')}
                increaseLabel={t('settings.appearance.terminalLineHeightLarger')}
                onDecrease={() => updateTerminal({ terminalLineHeight: Number((termLineHeight - 0.1).toFixed(1)) })}
                onIncrease={() => updateTerminal({ terminalLineHeight: Number((termLineHeight + 0.1).toFixed(1)) })}
              />
            </div>
          </div>

          <TerminalBlock
            data-testid="terminal-live-preview"
            text={'$ pnpm typecheck && pnpm test\n✓ 40 test files passed (302 tests)'}
          />

          <div className="flex items-center justify-end">
            <Button variant="ghost" size="xs" data-testid="terminal-reset" onClick={resetTerminal}>
              {t('settings.appearance.resetTerminal')}
            </Button>
          </div>
        </div>
      </section>

      {/* 4. 语言 */}
      <section
        id="appearance-sec-language"
        className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card"
        data-testid="appearance-language"
      >
        <div className="primitive-card-bar flex items-start gap-2 border-b border-line bg-inset/50">
          <GlobeIcon className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
          <div className="min-w-0">
            <h4 className="m-0 text-[13px] font-semibold text-ink">{t('settings.appearance.language')}</h4>
            <p className="mt-0.5 mb-0 text-[11.5px] text-ink-3">{t('settings.appearance.languageHint')}</p>
          </div>
        </div>

        <div className="primitive-card-pad flex items-center justify-between gap-3">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.language')}</span>
          <Select
            wrapperClassName="w-44"
            data-testid="pref-language"
            aria-label={t('settings.language')}
            value={preferences.language}
            onChange={(e) => updateLanguage(e.target.value as PreferencesState['language'])}
          >
            <option value="auto">{t('settings.language.auto')}</option>
            <option value="zh">{t('settings.language.zh')}</option>
            <option value="en">{t('settings.language.en')}</option>
          </Select>
        </div>
      </section>
    </div>
  );
}

/** 配色方案色卡：左浅色、右深色，完整展示每套配色的画布、卡片、文字层级与强调色。 */
function SplitPaletteSwatch({ swatch }: { readonly swatch: ColorSchemeSwatch }) {
  return (
    <div
      className="flex h-12 w-full overflow-hidden rounded-[7px] border border-line/80"
      aria-hidden="true"
    >
      {/* 左半：浅色 */}
      <div
        data-half="light"
        className="flex w-1/2 flex-col justify-between p-1.5"
        style={{ backgroundColor: swatch.light.canvas }}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="h-1.5 w-5 rounded-full" style={{ backgroundColor: swatch.light.ink }} />
          <span className="size-2 rounded-full" style={{ backgroundColor: swatch.light.accent }} />
        </div>
        <div
          className="flex flex-col gap-1 rounded-[4px] p-1"
          style={{
            backgroundColor: swatch.light.surface,
            boxShadow: `0 0 0 1px ${swatch.light.line}`,
          }}
        >
          <span className="h-1 w-4/5 rounded-full" style={{ backgroundColor: swatch.light.inkMuted }} />
          <span className="h-1 w-1/2 rounded-full" style={{ backgroundColor: swatch.light.accent }} />
        </div>
      </div>

      {/* 右半：深色 */}
      <div
        data-half="dark"
        className="flex w-1/2 flex-col justify-between p-1.5"
        style={{ backgroundColor: swatch.dark.canvas }}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="h-1.5 w-5 rounded-full" style={{ backgroundColor: swatch.dark.ink }} />
          <span className="size-2 rounded-full" style={{ backgroundColor: swatch.dark.accent }} />
        </div>
        <div
          className="flex flex-col gap-1 rounded-[4px] p-1"
          style={{
            backgroundColor: swatch.dark.surface,
            boxShadow: `0 0 0 1px ${swatch.dark.line}`,
          }}
        >
          <span className="h-1 w-4/5 rounded-full" style={{ backgroundColor: swatch.dark.inkMuted }} />
          <span className="h-1 w-1/2 rounded-full" style={{ backgroundColor: swatch.dark.accent }} />
        </div>
      </div>
    </div>
  );
}

/** 主题模式预览卡（联动当前选中的配色方案展示浅色 / 深色 / 跟随系统）。 */
function ThemePreview({ mode, swatch }: { readonly mode: ThemeMode; readonly swatch: ColorSchemeSwatch }) {
  if (mode === 'system') {
    return (
      <div className="relative flex h-15 w-full overflow-hidden rounded-[7px] border border-line/80" aria-hidden="true">
        <div className="flex w-1/2 flex-col gap-1.5 p-2" style={{ backgroundColor: swatch.light.canvas }}>
          <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: swatch.light.ink }} />
          <div
            className="flex-1 rounded-[4px] p-1.5"
            style={{ backgroundColor: swatch.light.surface, boxShadow: `0 0 0 1px ${swatch.light.line}` }}
          >
            <div className="h-1 w-full rounded-full" style={{ backgroundColor: swatch.light.inkMuted }} />
            <div className="mt-1 h-1 w-2/3 rounded-full" style={{ backgroundColor: swatch.light.accent }} />
          </div>
        </div>
        <div className="flex w-1/2 flex-col gap-1.5 p-2" style={{ backgroundColor: swatch.dark.canvas }}>
          <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: swatch.dark.ink }} />
          <div
            className="flex-1 rounded-[4px] p-1.5"
            style={{ backgroundColor: swatch.dark.surface, boxShadow: `0 0 0 1px ${swatch.dark.line}` }}
          >
            <div className="h-1 w-full rounded-full" style={{ backgroundColor: swatch.dark.inkMuted }} />
            <div className="mt-1 h-1 w-2/3 rounded-full" style={{ backgroundColor: swatch.dark.accent }} />
          </div>
        </div>
      </div>
    );
  }

  const palette = mode === 'dark' ? swatch.dark : swatch.light;
  return (
    <div
      className="flex h-15 w-full flex-col gap-1.5 rounded-[7px] border border-line/80 p-2"
      style={{ backgroundColor: palette.canvas }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <div className="h-1.5 w-10 rounded-full" style={{ backgroundColor: palette.ink }} />
        <div className="h-1.5 w-3 rounded-full" style={{ backgroundColor: palette.accent }} />
      </div>
      <div
        className="flex flex-1 flex-col justify-center gap-1 rounded-[5px] p-1.5"
        style={{ backgroundColor: palette.surface, boxShadow: `0 0 0 1px ${palette.line}` }}
      >
        <div className="h-1.5 w-4/5 rounded-full" style={{ backgroundColor: palette.inkMuted }} />
        <div className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: palette.accent }} />
      </div>
    </div>
  );
}

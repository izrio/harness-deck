/**
 * 设置 -> 界面 -> 外观模块：
 * 分为四个独立子块：
 * 1. 主题：浅色 / 深色 / 跟随系统
 * 2. 阅读与聊天：字体、字号、行高、段距与内容宽度（聊天回复、计划和 Markdown 文件预览共用，切换主题不改变）
 * 3. 终端：终端与代码字体、字号、行高
 * 4. 语言：界面显示语言（跟随 VS Code / 简体中文 / English）
 */
import { useEffect, useState } from 'react';
import type { AppearanceState, PreferencesState, ThemePreset } from '@harness-deck/shared';
import { useT, type MessageKey } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { setAppearanceLocal, setPreferencesLocal, useView } from '../../store.ts';
import type { ThemeMode } from '../../theme.ts';
import { postToHost } from '../../vscode.ts';
import { AppearancePanel } from '../AppearancePanel.tsx';
import { SettingsSection } from './SettingsSection.tsx';
import {
  CheckIcon,
  ContrastIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from '../icons.tsx';
import { ValuePill } from '../beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { NumberStepper } from '../NumberStepper.tsx';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const THEME_PRESETS: readonly { readonly id: ThemePreset; readonly swatch: string; readonly labelKey: MessageKey }[] = [
  { id: 'default', swatch: 'oklch(0.571 0.21 264)', labelKey: 'settings.appearance.preset.default' },
  { id: 'grove', swatch: 'oklch(0.64 0.15 152)', labelKey: 'settings.appearance.preset.grove' },
  { id: 'ocean', swatch: 'oklch(0.63 0.155 226)', labelKey: 'settings.appearance.preset.ocean' },
  { id: 'ember', swatch: 'oklch(0.66 0.175 42)', labelKey: 'settings.appearance.preset.ember' },
  { id: 'iris', swatch: 'oklch(0.62 0.195 292)', labelKey: 'settings.appearance.preset.iris' },
];

const THEME_CARDS: readonly {
  readonly mode: ThemeMode;
  readonly titleKey: MessageKey;
  readonly descKey: MessageKey;
}[] = [
  { mode: 'light', titleKey: 'settings.appearance.theme.light', descKey: 'settings.appearance.theme.lightDesc' },
  { mode: 'dark', titleKey: 'settings.appearance.theme.dark', descKey: 'settings.appearance.theme.darkDesc' },
  { mode: 'system', titleKey: 'settings.appearance.theme.system', descKey: 'settings.appearance.theme.systemDesc' },
];

const LIGHT_PREVIEW = {
  canvas: '#fcfcfc',
  surface: '#ffffff',
  ink: '#18181b',
  inkMuted: '#71717a',
  accent: '#1b4ed8',
  line: '#e4e4e7',
} as const;

const DARK_PREVIEW = {
  canvas: '#1b1d24',
  surface: '#22252f',
  ink: '#eef1f7',
  inkMuted: '#8f98a8',
  accent: '#346bf1',
  line: '#2e3240',
} as const;

const MIN_TERM_SIZE = 10;
const MAX_TERM_SIZE = 20;
const DEFAULT_TERM_SIZE = 12;

const MIN_TERM_LH = 1.2;
const MAX_TERM_LH = 2.0;
const DEFAULT_TERM_LH = 1.6;

export function AppearanceSettings() {
  const t = useT();
  const hostKind = useView((s) => s.hostKind);
  const appearance = useView((s) => s.appearance);
  const preferences = useView((s) => s.preferences);

  const currentTheme: ThemeMode = appearance.theme ?? 'dark';
  const currentPreset: ThemePreset = appearance.preset ?? 'default';
  const highContrast = Boolean(appearance.highContrast);

  const termSize = appearance.terminalFontSize ?? DEFAULT_TERM_SIZE;
  const termLineHeight = appearance.terminalLineHeight ?? DEFAULT_TERM_LH;
  const [codeFamily, setCodeFamily] = useState(appearance.codeFontFamily ?? '');

  useEffect(() => {
    setCodeFamily(appearance.codeFontFamily ?? '');
  }, [appearance.codeFontFamily]);

  const selectTheme = (theme: ThemeMode) => {
    const next: Record<string, unknown> = { ...appearance, theme };
    setAppearanceLocal(next as AppearanceState);
    postToHost({ type: 'setAppearance', payload: { theme } });
  };

  const selectPreset = (preset: ThemePreset) => {
    const next: Record<string, unknown> = { ...appearance, preset };
    setAppearanceLocal(next as AppearanceState);
    postToHost({ type: 'setAppearance', payload: { preset } });
  };

  const toggleHighContrast = (enabled: boolean) => {
    const next: Record<string, unknown> = { ...appearance, highContrast: enabled };
    setAppearanceLocal(next as AppearanceState);
    postToHost({ type: 'setAppearance', payload: { highContrast: enabled } });
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

  return (
    <div className="flex flex-col gap-5" data-testid="settings-appearance">
      {/* 1. 主题 */}
      <SettingsSection id="appearance-sec-theme" title={t('settings.appearance.theme')}>
        <div className="primitive-card-pad">
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
                  <ThemePreview mode={mode} />
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={cn('inline-flex shrink-0', active ? 'text-accent-ink' : 'text-ink-3')}>
                        {mode === 'light' ? <SunIcon className="size-3.5" /> : mode === 'dark' ? <MoonIcon className="size-3.5" /> : <MonitorIcon className="size-3.5" />}
                      </span>
                      <span className="truncate text-[12.5px] font-medium text-ink">{t(titleKey)}</span>
                    </div>
                    {active ? (
                      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground">
                        <CheckIcon className="size-2.5" />
                      </span>
                    ) : null}
                  </div>
                  <span className="text-[11px] leading-snug text-ink-3">
                    {t(mode === 'system' && hostKind === 'jetbrains' ? 'settings.appearance.theme.systemDescIde' : descKey)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t border-line pt-3.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.preset')}</span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('settings.appearance.preset')}>
                {THEME_PRESETS.map(({ id, swatch, labelKey }) => {
                  const active = currentPreset === id;
                  return (
                    <Button
                      key={id}
                      type="button"
                      size="xs"
                      variant={active ? 'secondary' : 'outline'}
                      role="radio"
                      aria-checked={active}
                      data-testid={`theme-preset-${id}`}
                      className={cn(active && 'border-brand ring-1 ring-brand/40')}
                      onClick={() => selectPreset(id)}
                    >
                      <span
                        className="inline-block size-2.5 rounded-full"
                        style={{ backgroundColor: swatch }}
                        aria-hidden="true"
                      />
                      <span>{t(labelKey)}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <ContrastIcon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink">{t('settings.appearance.highContrast')}</div>
                  <div className="text-[11px] text-ink-3">{t('settings.appearance.highContrastDesc')}</div>
                </div>
              </div>
              <Switch
                checked={highContrast}
                data-testid="theme-high-contrast-switch"
                aria-label={t('settings.appearance.highContrast')}
                onCheckedChange={toggleHighContrast}
              />
            </div>
          </div>
        </div>
      </SettingsSection>

      {/* 2. 阅读与聊天 */}
      <SettingsSection
        id="appearance-sec-reading"
        testId="appearance-reading-chat"
        title={t('settings.appearance.reading')}
      >
        <div className="primitive-card-pad">
          <AppearancePanel />
        </div>
      </SettingsSection>

      {/* 3. 终端 */}
      <SettingsSection
        id="appearance-sec-terminal"
        testId="appearance-terminal"
        title={t('settings.appearance.terminal')}
      >
        <div className="primitive-card-pad flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.terminalFont')}</span>
            <Input
              size="sm"
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
              <NumberStepper
                size="sm"
                decLabel={t('settings.appearance.terminalSizeSmaller')}
                incLabel={t('settings.appearance.terminalSizeLarger')}
                decDisabled={termSize <= MIN_TERM_SIZE}
                incDisabled={termSize >= MAX_TERM_SIZE}
                onDec={() => updateTerminal({ terminalFontSize: Math.max(MIN_TERM_SIZE, termSize - 1) })}
                onInc={() => updateTerminal({ terminalFontSize: Math.min(MAX_TERM_SIZE, termSize + 1) })}
                valueTestId="terminal-font-size"
              >
                {termSize}px
              </NumberStepper>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2.5">
            <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.terminalLineHeight')}</span>
            <div className="flex items-center gap-2">
              {appearance.terminalLineHeight === undefined ? <ValuePill className="text-[11px]">{t('appearance.default')}</ValuePill> : null}
              <NumberStepper
                size="sm"
                decLabel={t('settings.appearance.terminalLineHeightSmaller')}
                incLabel={t('settings.appearance.terminalLineHeightLarger')}
                decDisabled={termLineHeight <= MIN_TERM_LH + 0.01}
                incDisabled={termLineHeight >= MAX_TERM_LH - 0.01}
                onDec={() => updateTerminal({ terminalLineHeight: Number((termLineHeight - 0.1).toFixed(1)) })}
                onInc={() => updateTerminal({ terminalLineHeight: Number((termLineHeight + 0.1).toFixed(1)) })}
                valueTestId="terminal-line-height"
              >
                {termLineHeight.toFixed(1)}
              </NumberStepper>
            </div>
          </div>

          <pre
            data-testid="terminal-live-preview"
            className="terminal-surface m-0 overflow-auto rounded-control bg-field px-3 py-2 whitespace-pre-wrap text-ink-2 shadow-hairline [overflow-wrap:anywhere]"
          >
            {'$ pnpm typecheck && pnpm test\n✓ 40 test files passed (302 tests)'}
          </pre>

          <div className="flex items-center justify-end">
            <Button type="button" variant="ghost" size="sm" data-testid="terminal-reset" onClick={resetTerminal}>
              {t('settings.appearance.resetTerminal')}
            </Button>
          </div>
        </div>
      </SettingsSection>

      {/* 4. 语言 */}
      <SettingsSection
        id="appearance-sec-language"
        testId="appearance-language"
        title={t('settings.appearance.language')}
      >
        <div className="primitive-card-pad flex items-center justify-between gap-3">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.language')}</span>
          <div className="w-44">
            <Select
              value={preferences.language}
              onValueChange={(value) => updateLanguage(value as PreferencesState['language'])}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                data-testid="pref-language"
                aria-label={t('settings.language')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {t(hostKind === 'jetbrains' ? 'settings.language.autoIde' : 'settings.language.auto')}
                </SelectItem>
                <SelectItem value="zh">{t('settings.language.zh')}</SelectItem>
                <SelectItem value="en">{t('settings.language.en')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

/** 主题模式预览卡（展示浅色 / 深色 / 跟随系统）。 */
function ThemePreview({ mode }: { readonly mode: ThemeMode }) {
  if (mode === 'system') {
    return (
      <div className="relative flex h-15 w-full overflow-hidden rounded-[7px] border border-line/80" aria-hidden="true">
        <div className="flex w-1/2 flex-col gap-1.5 p-2" style={{ backgroundColor: LIGHT_PREVIEW.canvas }}>
          <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: LIGHT_PREVIEW.ink }} />
          <div
            className="flex-1 rounded-[4px] p-1.5"
            style={{ backgroundColor: LIGHT_PREVIEW.surface, boxShadow: `0 0 0 1px ${LIGHT_PREVIEW.line}` }}
          >
            <div className="h-1 w-full rounded-full" style={{ backgroundColor: LIGHT_PREVIEW.inkMuted }} />
            <div className="mt-1 h-1 w-2/3 rounded-full" style={{ backgroundColor: LIGHT_PREVIEW.accent }} />
          </div>
        </div>
        <div className="flex w-1/2 flex-col gap-1.5 p-2" style={{ backgroundColor: DARK_PREVIEW.canvas }}>
          <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: DARK_PREVIEW.ink }} />
          <div
            className="flex-1 rounded-[4px] p-1.5"
            style={{ backgroundColor: DARK_PREVIEW.surface, boxShadow: `0 0 0 1px ${DARK_PREVIEW.line}` }}
          >
            <div className="h-1 w-full rounded-full" style={{ backgroundColor: DARK_PREVIEW.inkMuted }} />
            <div className="mt-1 h-1 w-2/3 rounded-full" style={{ backgroundColor: DARK_PREVIEW.accent }} />
          </div>
        </div>
      </div>
    );
  }

  const preview = mode === 'dark' ? DARK_PREVIEW : LIGHT_PREVIEW;
  return (
    <div
      className="flex h-15 w-full flex-col gap-1.5 rounded-[7px] border border-line/80 p-2"
      style={{ backgroundColor: preview.canvas }}
      aria-hidden="true"
    >
      <div className="flex items-center justify-between">
        <div className="h-1.5 w-10 rounded-full" style={{ backgroundColor: preview.ink }} />
        <div className="h-1.5 w-3 rounded-full" style={{ backgroundColor: preview.accent }} />
      </div>
      <div
        className="flex flex-1 flex-col justify-center gap-1 rounded-[5px] p-1.5"
        style={{ backgroundColor: preview.surface, boxShadow: `0 0 0 1px ${preview.line}` }}
      >
        <div className="h-1.5 w-4/5 rounded-full" style={{ backgroundColor: preview.inkMuted }} />
        <div className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: preview.accent }} />
      </div>
    </div>
  );
}

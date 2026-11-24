/**
 * 阅读与聊天排版控件：
 * 去线留白：移除行间分割线、冗余「默认」胶囊与预览标题，让排版控件与实时预览直接自解释。
 */
import { useEffect, useState } from 'react';
import type { AppearanceState } from '@harness-deck/shared';
import { useT } from '../i18n.ts';
import { cn } from '../lib/utils.ts';
import { setAppearanceLocal, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { Markdown } from './Markdown.tsx';
import { Button } from '@/components/ui/button';
import { NumberStepper } from './NumberStepper.tsx';
import { Input } from '@/components/ui/input';

const MIN_SIZE = 10;
const MAX_SIZE = 24;
const DEFAULT_SIZE = 14;

const MIN_LINE_HEIGHT = 1.3;
const MAX_LINE_HEIGHT = 2.2;
const DEFAULT_LINE_HEIGHT = 1.6;

const MIN_SPACING = 4;
const MAX_SPACING = 24;
const DEFAULT_SPACING = 10;

const MIN_WIDTH = 600;
const MAX_WIDTH = 1280;
const DEFAULT_WIDTH = 820;

const FONT_PRESETS = [
  { id: 'vscode', labelKey: 'settings.appearance.fontPreset.vscode' as const, value: '' },
  {
    id: 'sans',
    labelKey: 'settings.appearance.fontPreset.sans' as const,
    value: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  },
  {
    id: 'serif',
    labelKey: 'settings.appearance.fontPreset.serif' as const,
    value: 'Charter, "Source Serif 4", Georgia, "Songti SC", "Noto Serif SC", serif',
  },
] as const;

const WIDTH_PRESETS = [
  { labelKey: 'settings.appearance.widthPreset.compact' as const, width: 680 },
  { labelKey: 'settings.appearance.widthPreset.standard' as const, width: 820 },
  { labelKey: 'settings.appearance.widthPreset.wide' as const, width: 980 },
] as const;

type ProsePatch = {
  fontSize?: number | null;
  fontFamily?: string | null;
  lineHeight?: number | null;
  paragraphSpacing?: number | null;
  contentWidth?: number | null;
};

function applyProsePatch(current: AppearanceState, patch: ProsePatch): void {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  setAppearanceLocal(next as AppearanceState);
  postToHost({ type: 'setAppearance', payload: patch });
}

export function AppearancePanel() {
  const t = useT();
  const hostKind = useView((s) => s.hostKind);
  const appearance = useView((s) => s.appearance);
  const size = appearance.fontSize ?? DEFAULT_SIZE;
  const lineHeight = appearance.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const paragraphSpacing = appearance.paragraphSpacing ?? DEFAULT_SPACING;
  const contentWidth = appearance.contentWidth ?? DEFAULT_WIDTH;

  const [family, setFamily] = useState(appearance.fontFamily ?? '');

  useEffect(() => {
    setFamily(appearance.fontFamily ?? '');
  }, [appearance.fontFamily]);

  const setSize = (value: number) =>
    applyProsePatch(appearance, { fontSize: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value))) });

  const setLineHeight = (value: number) => {
    const rounded = Number(Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, value)).toFixed(1));
    applyProsePatch(appearance, { lineHeight: rounded });
  };

  const setParagraphSpacing = (value: number) =>
    applyProsePatch(appearance, { paragraphSpacing: Math.min(MAX_SPACING, Math.max(MIN_SPACING, Math.round(value))) });

  const setContentWidth = (value: number) =>
    applyProsePatch(appearance, { contentWidth: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value))) });

  const commitFamily = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === (appearance.fontFamily ?? '')) return;
    applyProsePatch(appearance, { fontFamily: trimmed || null });
  };

  const selectFontPreset = (presetValue: string) => {
    setFamily(presetValue);
    applyProsePatch(appearance, { fontFamily: presetValue || null });
  };

  const resetProse = () => {
    setFamily('');
    applyProsePatch(appearance, {
      fontSize: null,
      fontFamily: null,
      lineHeight: null,
      paragraphSpacing: null,
      contentWidth: null,
    });
  };

  const activePreset = FONT_PRESETS.find((p) => p.value === (appearance.fontFamily ?? ''));

  return (
    <div className="flex flex-col gap-5 p-4" data-testid="appearance-panel">
      {/* 字体选择：预设快捷胶囊 + 自定义输入 */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.proseFont')}</span>
          <div className="flex flex-wrap items-center gap-1">
            {FONT_PRESETS.map((preset) => {
              const selected = activePreset?.id === preset.id;
              return (
                <Button
                  key={preset.id}
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid={`font-preset-${preset.id}`}
                  onClick={() => selectFontPreset(preset.value)}
                  className={cn(
                    'rounded-full px-2.5 text-[11.5px]',
                    selected
                      ? 'bg-accent-tint font-medium text-accent-ink hover:bg-accent-tint'
                      : 'text-ink-2 hover:bg-canvas/70 hover:text-ink dark:hover:bg-page/45',
                  )}
                >
                  {t(preset.id === 'vscode' && hostKind === 'jetbrains' ? 'settings.appearance.fontPreset.ide' : preset.labelKey)}
                </Button>
              );
            })}
          </div>
        </div>
        <Input
          size="sm"
          data-testid="prose-font-family"
          value={family}
          placeholder={t('appearance.familyPlaceholder')}
          aria-label={t('appearance.family')}
          onChange={(event) => setFamily(event.target.value)}
          onBlur={() => commitFamily(family)}
          onKeyDown={(event) => event.key === 'Enter' && commitFamily(family)}
        />
      </div>

      {/* 排版数值参数 */}
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[12.5px] font-medium text-ink">{t('appearance.size')}</span>
          <NumberStepper
            size="sm"
            decLabel={t('appearance.smaller')}
            incLabel={t('appearance.larger')}
            decDisabled={size <= MIN_SIZE}
            incDisabled={size >= MAX_SIZE}
            onDec={() => setSize(size - 1)}
            onInc={() => setSize(size + 1)}
            valueTestId="appearance-size"
          >
            {size}px
          </NumberStepper>
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.lineHeight')}</span>
          <NumberStepper
            size="sm"
            decLabel={t('settings.appearance.lineHeightSmaller')}
            incLabel={t('settings.appearance.lineHeightLarger')}
            decDisabled={lineHeight <= MIN_LINE_HEIGHT + 0.01}
            incDisabled={lineHeight >= MAX_LINE_HEIGHT - 0.01}
            onDec={() => setLineHeight(lineHeight - 0.1)}
            onInc={() => setLineHeight(lineHeight + 0.1)}
            valueTestId="prose-line-height"
          >
            {lineHeight.toFixed(1)}
          </NumberStepper>
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.paragraphSpacing')}</span>
          <NumberStepper
            size="sm"
            decLabel={t('settings.appearance.paragraphSpacingSmaller')}
            incLabel={t('settings.appearance.paragraphSpacingLarger')}
            decDisabled={paragraphSpacing <= MIN_SPACING}
            incDisabled={paragraphSpacing >= MAX_SPACING}
            onDec={() => setParagraphSpacing(paragraphSpacing - 2)}
            onInc={() => setParagraphSpacing(paragraphSpacing + 2)}
            valueTestId="prose-paragraph-spacing"
          >
            {paragraphSpacing}px
          </NumberStepper>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.contentWidth')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {WIDTH_PRESETS.map((preset) => {
                const selected = contentWidth === preset.width;
                return (
                  <Button
                    key={preset.width}
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid={`width-preset-${preset.width}`}
                    onClick={() => setContentWidth(preset.width)}
                    className={cn(
                      'rounded-full px-2 text-[11px]',
                      selected
                        ? 'bg-accent-tint font-medium text-accent-ink hover:bg-accent-tint'
                        : 'text-ink-2 hover:bg-canvas/70 hover:text-ink dark:hover:bg-page/45',
                    )}
                  >
                    {t(preset.labelKey)}
                  </Button>
                );
              })}
            </div>
            <NumberStepper
              size="sm"
              decLabel={t('settings.appearance.contentWidthSmaller')}
              incLabel={t('settings.appearance.contentWidthLarger')}
              decDisabled={contentWidth <= MIN_WIDTH}
              incDisabled={contentWidth >= MAX_WIDTH}
              onDec={() => setContentWidth(contentWidth - 40)}
              onInc={() => setContentWidth(contentWidth + 40)}
              valueTestId="prose-content-width"
            >
              {contentWidth}px
            </NumberStepper>
          </div>
        </div>
      </div>

      {/* 实时预览 + 重置 */}
      <div className="flex flex-col gap-2.5">
        <div
          className="rounded-xl bg-canvas/85 p-4 dark:bg-page/55"
          data-testid="reading-live-preview"
        >
          <Markdown text={t('settings.appearance.readingPreviewSample')} />
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-ink-3 hover:text-ink"
            data-testid="prose-reset"
            onClick={resetProse}
          >
            {t('appearance.reset')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 阅读与聊天排版控件：
 * 聊天回复、计划和 Markdown 文件预览共用字体、字号、行高、段距与内容宽度，切换主题或配色不会改变这些设置。
 */
import { useEffect, useState } from 'react';
import type { AppearanceState } from '@harness-deck/shared';
import { useT } from '../i18n.ts';
import { cn } from '../lib/utils.ts';
import { setAppearanceLocal, useView } from '../store.ts';
import { postToHost } from '../vscode.ts';
import { Markdown } from './Markdown.tsx';
import { ValuePill } from './beautifului/index.ts';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
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
    <div className="flex flex-col gap-3.5" data-testid="appearance-panel">
      {/* 字体选择：预设快捷胶囊 + 自定义输入 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.proseFont')}</span>
          <div className="flex flex-wrap items-center gap-1">
            {FONT_PRESETS.map((preset) => {
              const selected = activePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`font-preset-${preset.id}`}
                  onClick={() => selectFontPreset(preset.value)}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors duration-100',
                    selected
                      ? 'bg-accent-tint font-medium text-accent-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_28%,transparent)]'
                      : 'bg-field text-ink-2 shadow-hairline hover:bg-hover hover:text-ink',
                  )}
                >
                  {t(preset.id === 'vscode' && hostKind === 'jetbrains' ? 'settings.appearance.fontPreset.ide' : preset.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
        <Input
          data-testid="prose-font-family"
          value={family}
          placeholder={t('appearance.familyPlaceholder')}
          aria-label={t('appearance.family')}
          onChange={(event) => setFamily(event.target.value)}
          onBlur={() => commitFamily(family)}
          onKeyDown={(event) => event.key === 'Enter' && commitFamily(family)}
        />
      </div>

      {/* 字号 */}
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[12.5px] font-medium text-ink">{t('appearance.size')}</span>
        <div className="flex items-center gap-2">
          {appearance.fontSize === undefined ? <ValuePill className="text-[11px]">{t('appearance.default')}</ValuePill> : null}
          <ButtonGroup>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('appearance.smaller')}
              disabled={size <= MIN_SIZE}
              onClick={() => setSize(size - 1)}
            >
              −
            </Button>
            <ButtonGroupText className="min-w-13 justify-center px-2 font-mono text-[12px] tabular-nums" data-testid="appearance-size">
              {size}px
            </ButtonGroupText>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('appearance.larger')}
              disabled={size >= MAX_SIZE}
              onClick={() => setSize(size + 1)}
            >
              +
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {/* 行高 */}
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.lineHeight')}</span>
        <div className="flex items-center gap-2">
          {appearance.lineHeight === undefined ? <ValuePill className="text-[11px]">{t('appearance.default')}</ValuePill> : null}
          <ButtonGroup>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('settings.appearance.lineHeightSmaller')}
              disabled={lineHeight <= MIN_LINE_HEIGHT + 0.01}
              onClick={() => setLineHeight(lineHeight - 0.1)}
            >
              −
            </Button>
            <ButtonGroupText className="min-w-13 justify-center px-2 font-mono text-[12px] tabular-nums" data-testid="prose-line-height">
              {lineHeight.toFixed(1)}
            </ButtonGroupText>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('settings.appearance.lineHeightLarger')}
              disabled={lineHeight >= MAX_LINE_HEIGHT - 0.01}
              onClick={() => setLineHeight(lineHeight + 0.1)}
            >
              +
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {/* 段距 */}
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.paragraphSpacing')}</span>
        <div className="flex items-center gap-2">
          {appearance.paragraphSpacing === undefined ? <ValuePill className="text-[11px]">{t('appearance.default')}</ValuePill> : null}
          <ButtonGroup>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('settings.appearance.paragraphSpacingSmaller')}
              disabled={paragraphSpacing <= MIN_SPACING}
              onClick={() => setParagraphSpacing(paragraphSpacing - 2)}
            >
              −
            </Button>
            <ButtonGroupText className="min-w-13 justify-center px-2 font-mono text-[12px] tabular-nums" data-testid="prose-paragraph-spacing">
              {paragraphSpacing}px
            </ButtonGroupText>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('settings.appearance.paragraphSpacingLarger')}
              disabled={paragraphSpacing >= MAX_SPACING}
              onClick={() => setParagraphSpacing(paragraphSpacing + 2)}
            >
              +
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {/* 内容宽度 */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <span className="text-[12.5px] font-medium text-ink">{t('settings.appearance.contentWidth')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1">
            {WIDTH_PRESETS.map((preset) => {
              const selected = contentWidth === preset.width;
              return (
                <Button
                  key={preset.width}
                  type="button"
                  variant={selected ? 'secondary' : 'ghost'}
                  size="xs"
                  data-testid={`width-preset-${preset.width}`}
                  onClick={() => setContentWidth(preset.width)}
                  className={cn(
                    'rounded-full px-2 text-[11px]',
                    selected && 'bg-accent-tint text-accent-ink',
                  )}
                >
                  {t(preset.labelKey)}
                </Button>
              );
            })}
          </div>
          <ButtonGroup>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('settings.appearance.contentWidthSmaller')}
              disabled={contentWidth <= MIN_WIDTH}
              onClick={() => setContentWidth(contentWidth - 40)}
            >
              −
            </Button>
            <ButtonGroupText className="min-w-13 justify-center px-2 font-mono text-[12px] tabular-nums" data-testid="prose-content-width">
              {contentWidth}px
            </ButtonGroupText>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label={t('settings.appearance.contentWidthLarger')}
              disabled={contentWidth >= MAX_WIDTH}
              onClick={() => setContentWidth(contentWidth + 40)}
            >
              +
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {/* 实时阅读与聊天排版预览 */}
      <div className="flex flex-col gap-1.5 rounded-card bg-inset/70 p-3 shadow-hairline" data-testid="reading-live-preview">
        <span className="text-[11px] font-medium text-ink-3">{t('settings.appearance.readingPreview')}</span>
        <Markdown text={t('settings.appearance.readingPreviewSample')} />
      </div>

      <div className="flex items-center justify-end">
        <Button type="button" variant="ghost" size="xs" data-testid="prose-reset" onClick={resetProse}>
          {t('appearance.reset')}
        </Button>
      </div>
    </div>
  );
}

// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Button } from '../src/components/ui/button.tsx';
import { Input } from '../src/components/ui/input.tsx';
import { NativeSelect, NativeSelectOption } from '../src/components/ui/native-select.tsx';
import { Select, SelectTrigger, SelectValue } from '../src/components/ui/select.tsx';
import { NumberStepper } from '../src/components/NumberStepper.tsx';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(TEST_DIR, '../src/components');

const SIZE_HEIGHT_MAP = {
  xs: 'h-6',
  sm: 'h-8',
  default: 'h-9',
  lg: 'h-10',
} as const;

const ICON_BUTTON_SIZE_MAP = {
  xs: { size: 'icon-xs', cls: 'size-6' },
  sm: { size: 'icon-sm', cls: 'size-8' },
  default: { size: 'icon', cls: 'size-9' },
  lg: { size: 'icon-lg', cls: 'size-10' },
} as const;

function walkTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsxFiles(full, acc);
    } else if (entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('组件尺寸统一规范（AGENTS.md）', () => {
  for (const [size, expectedHeight] of Object.entries(SIZE_HEIGHT_MAP) as Array<
    [keyof typeof SIZE_HEIGHT_MAP, string]
  >) {
    it(`size="${size}" 在 Button / Input / NativeSelect / SelectTrigger 上映射到同一高度 (${expectedHeight})`, () => {
      const { container, unmount } = render(
        <div>
          <Button type="button" size={size}>
            提交
          </Button>
          <Button type="button" size={ICON_BUTTON_SIZE_MAP[size].size} aria-label="图标按钮">
            +
          </Button>
          <Input size={size} aria-label="输入框" />
          <NativeSelect size={size} aria-label="下拉框" defaultValue="a">
            <NativeSelectOption value="a">A</NativeSelectOption>
          </NativeSelect>
          <Select defaultValue="a">
            <SelectTrigger size={size} aria-label="选择器">
              <SelectValue placeholder="请选择" />
            </SelectTrigger>
          </Select>
        </div>,
      );

      const buttons = container.querySelectorAll('[data-slot="button"]');
      const textBtn = buttons[0] as HTMLElement;
      const iconBtn = buttons[1] as HTMLElement;
      const input = container.querySelector('[data-slot="input"]') as HTMLElement;
      const nativeSelect = container.querySelector('[data-slot="native-select"]') as HTMLElement;
      const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;

      expect(textBtn.getAttribute('data-size')).toBe(size);
      expect(textBtn.className.split(/\s+/u)).toContain(expectedHeight);

      expect(iconBtn.getAttribute('data-size')).toBe(ICON_BUTTON_SIZE_MAP[size].size);
      expect(iconBtn.className.split(/\s+/u)).toContain(ICON_BUTTON_SIZE_MAP[size].cls);

      expect(input.getAttribute('data-size')).toBe(size);
      expect(input.className.split(/\s+/u)).toContain(expectedHeight);

      expect(nativeSelect.getAttribute('data-size')).toBe(size);
      expect(nativeSelect.className.split(/\s+/u)).toContain(expectedHeight);

      expect(selectTrigger.getAttribute('data-size')).toBe(size);
      expect(selectTrigger.className).toContain(`data-[size=${size}]:${expectedHeight}`);

      unmount();
    });
  }

  it('NumberStepper 的按钮与中间数值区在 xs / sm / default 档位下保持严格等高', () => {
    for (const [size, btnSize, expectedHeight] of [
      ['xs', 'icon-xs', 'h-6'],
      ['sm', 'icon-sm', 'h-8'],
      ['default', 'icon', 'h-9'],
    ] as const) {
      const { container, unmount } = render(
        <NumberStepper
          size={size}
          decLabel="减少"
          incLabel="增加"
          onDec={() => undefined}
          onInc={() => undefined}
          valueTestId="stepper-val"
        >
          14px
        </NumberStepper>,
      );
      const group = container.querySelector('[data-slot="button-group"]') as HTMLElement;
      const buttons = container.querySelectorAll('[data-slot="button"]');
      const val = container.querySelector('[data-testid="stepper-val"]') as HTMLElement;

      expect(group.getAttribute('data-size')).toBe(size);
      expect(buttons[0]?.getAttribute('data-size')).toBe(btnSize);
      expect(buttons[1]?.getAttribute('data-size')).toBe(btnSize);
      expect(val.className.split(/\s+/u)).toContain(expectedHeight);
      unmount();
    }
  });

  it('业务组件中不通过手写 h-7/h-8/h-9/h-10 覆盖 Input / Button / NativeSelect / SelectTrigger 高度', () => {
    const files = walkTsxFiles(COMPONENTS_DIR);
    const controlTagRe = /<(Input|Button|NativeSelect|SelectTrigger)\b([\s\S]*?)(?:\/>|>)/gu;
    const rawHeightClassRe = /className=(?:\{[\s\S]*?\}|"[^"]*")/u;
    const forbiddenHeightRe = /(?:^|[\s'"`])h-(?:6|7|8|9|10|\[[^\]]+\])(?=[\s'"`]|$)/u;

    for (const file of files) {
      const rel = relative(COMPONENTS_DIR, file).replace(/\\/gu, '/');
      if (rel.startsWith('ui/')) continue;
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(controlTagRe)) {
        const tag = match[1];
        const attrs = match[2] ?? '';
        const clsMatch = attrs.match(rawHeightClassRe);
        if (!clsMatch) continue;
        expect(
          clsMatch[0],
          `${rel} 中的 <${tag}> 请使用统一 size 属性而非在 className 中手写固定高度`,
        ).not.toMatch(forbiddenHeightRe);
      }
    }
  });
});

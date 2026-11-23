import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../src/styles/beautifului-foundation.css'), 'utf8');

/** 取出第一个以 `selector {` 开头的顶层块内容。 */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `未找到 ${selector} 块`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`${selector} 块未闭合`);
}

describe('beautifului-foundation 设计令牌', () => {
  const root = block(':root');
  const dark = block('.dark');
  const theme = block('@theme inline');

  it('--ink-4 在亮色、暗色与 @theme inline 中均已定义', () => {
    expect(root).toMatch(/--ink-4:/);
    expect(dark).toMatch(/--ink-4:/);
    expect(theme).toContain('--color-ink-4: var(--ink-4);');
  });

  it('shadcn 的 --color-accent 指向中性 hover 面，前景色不再是写死的白色', () => {
    expect(theme).toContain('--color-accent: var(--shadcn-accent);');
    expect(root).toContain('--shadcn-accent: var(--hover);');
    expect(dark).toContain('--shadcn-accent: var(--hover);');
    expect(root).toContain('--accent-foreground: var(--ink);');
    expect(dark).toContain('--accent-foreground: var(--ink);');
  });

  it('品牌色通过 --color-brand / --color-brand-foreground 暴露，accent-ink 与 accent-tint 保持不变', () => {
    expect(theme).toContain('--color-brand: var(--accent);');
    expect(theme).toContain('--color-brand-foreground: var(--brand-foreground);');
    expect(theme).toContain('--color-accent-ink: var(--accent-ink);');
    expect(theme).toContain('--color-accent-tint: var(--accent-tint);');
  });

  it('暗色主题保留偏灰的层级底色，不使用纯黑 #000000 / #0a0a0a', () => {
    expect(dark).not.toContain('#000000');
    expect(dark).not.toContain('#0a0a0a');
    expect(dark).toContain('--canvas: oklch(0.222 0.008 264);');
    expect(dark).toContain('--surface: oklch(0.258 0.01 266);');
  });
});

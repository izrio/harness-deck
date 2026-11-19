// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import checkIcon from '@iconify-icons/lucide/check';
import * as Icons from '../src/components/icons.tsx';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(TEST_DIR, '../src');

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (/\.(?:ts|tsx)$/u.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('Iconify 离线图标规范', () => {
  it('icons.tsx 导出的全部图标均可离线同步渲染为 SVG 且不触发网络请求', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('offline icon must not call fetch');
    });
    try {
      const iconEntries = Object.entries(Icons).filter(
        ([name, value]) => /^[A-Z].*Icon$/u.test(name) && name !== 'AppIcon' && typeof value === 'function',
      );
      expect(iconEntries.length).toBeGreaterThanOrEqual(70);

      for (const [name, Component] of iconEntries) {
        const IconComp = Component as (props: Icons.IconProps) => React.JSX.Element;
        const { container, unmount } = render(<IconComp />);
        const svg = container.querySelector('svg');
        expect(svg, `${name} 应渲染为 <svg>`).not.toBeNull();
        expect(svg?.getAttribute('aria-hidden'), `${name} 默认应为 aria-hidden="true"`).toBe('true');
        expect(svg?.innerHTML.trim().length, `${name} 应包含静态内联路径`).toBeGreaterThan(0);
        unmount();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('AppIcon 支持离线渲染并应用自定义尺寸、描边宽度与填充色', () => {
    const { container } = render(
      <Icons.AppIcon icon={checkIcon} width={20} height={20} strokeWidth={2.5} fill="currentColor" className="text-ink" />,
    );
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
    expect(svg?.getAttribute('class')).toContain('text-ink');
    expect(svg?.innerHTML).toContain('stroke-width="2.5"');
    expect(svg?.innerHTML).toContain('fill="currentColor"');
  });

  it('SpinnerIcon 合并自定义 className 时保留 spin 动画类', () => {
    const { container } = render(<Icons.SpinnerIcon className="size-3.5 text-ink-3" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('spin');
    expect(svg?.getAttribute('class')).toContain('size-3.5');
  });

  it('源码不引入在线 @iconify/react 入口，且业务层不直接导入 lucide-react', () => {
    const files = walkTsFiles(SRC_DIR);
    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/gu, '/');
      const content = readFileSync(file, 'utf8');
      expect(content, `${rel} 禁止使用在线 @iconify/react 入口`).not.toMatch(/from\s+['"]@iconify\/react['"]/u);
      expect(content, `${rel} 禁止引用在线 Iconify API`).not.toContain('api.iconify.design');
      if (!rel.startsWith('components/ui/')) {
        expect(content, `${rel} 禁止直接导入 lucide-react`).not.toMatch(/from\s+['"]lucide-react['"]/u);
      }
    }
  });
});

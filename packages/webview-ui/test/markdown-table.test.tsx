// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.tsx';
import './setup.ts';

describe('Markdown 表格使用 shadcn Table 与卡片容器', () => {
  it('渲染 GFM 表格时输出完整 shadcn Table slots 与圆角边框容器', () => {
    const md = [
      '| 模块 | 状态 | 说明 |',
      '| --- | :---: | --- |',
      '| 会话流 | 就绪 | 支持流式回复 |',
      '| 审批与提问 | 就绪 | 交互卡片 |',
    ].join('\n');

    const { container, unmount } = render(<Markdown text={md} />);
    const wrap = container.querySelector('.table-wrap') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.className).toContain('rounded-xl');
    expect(wrap.className).toContain('border');
    expect(wrap.className).toContain('bg-surface');

    expect(container.querySelector('[data-slot="table-container"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="table"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="table-header"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="table-body"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="table-head"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-slot="table-cell"]')).toHaveLength(6);

    // 保留 GFM 列对齐样式
    const secondHead = container.querySelectorAll('[data-slot="table-head"]')[1] as HTMLElement;
    expect(secondHead.style.textAlign).toBe('center');

    unmount();
  });
});

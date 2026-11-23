// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../src/components/ui/dialog.tsx';

describe('Dialog 全局布局与防溢出约束', () => {
  it('DialogContent 强制单列收缩与视口边界约束，避免长 URL 或高内容溢出弹窗', () => {
    const { unmount } = render(
      <Dialog open>
        <DialogContent className="sm:max-w-md" data-testid="test-dialog">
          <DialogHeader>
            <DialogTitle>官方渠道登录</DialogTitle>
            <DialogDescription>
              请在浏览器完成授权，然后把页面上显示的授权码粘贴到下方并提交。
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col">
            <div className="truncate font-mono">
              https://accounts.google.com/o/oauth2/auth?access_type=offline&amp;client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
            </div>
          </div>
          <DialogFooter>
            <button type="button">取消</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const content = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
    const header = document.querySelector('[data-slot="dialog-header"]') as HTMLElement;
    const title = document.querySelector('[data-slot="dialog-title"]') as HTMLElement;
    const desc = document.querySelector('[data-slot="dialog-description"]') as HTMLElement;
    const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement;

    const contentClasses = content.className.split(/\s+/u);
    expect(contentClasses).toContain('grid-cols-1');
    expect(contentClasses).toContain('*:min-w-0');
    expect(contentClasses).toContain('overflow-x-hidden');
    expect(contentClasses).toContain('overflow-y-auto');
    expect(contentClasses).toContain('w-[calc(100%-2rem)]');
    expect(contentClasses).toContain('max-h-[calc(100vh-2rem)]');
    expect(contentClasses).toContain('sm:max-w-md');

    const headerClasses = header.className.split(/\s+/u);
    expect(headerClasses).toContain('min-w-0');
    expect(headerClasses).toContain('pr-7');
    expect(headerClasses).toContain('text-left');

    expect(title.className.split(/\s+/u)).toContain('wrap-break-word');
    expect(desc.className.split(/\s+/u)).toContain('wrap-break-word');
    expect(footer.className.split(/\s+/u)).toContain('flex-wrap');

    unmount();
  });
});

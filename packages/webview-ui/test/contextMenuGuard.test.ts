// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installEmptyAreaContextMenuGuard } from '../src/lib/contextMenuGuard.ts';

describe('installEmptyAreaContextMenuGuard', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('右键空白区域与普通不可编辑容器时阻止宿主默认菜单', () => {
    cleanup = installEmptyAreaContextMenuGuard();
    const blank = document.createElement('div');
    blank.textContent = '空白背景区域';
    document.body.appendChild(blank);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    blank.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('在文本输入框、textarea、contenteditable、终端与非空选区上保留原生右键菜单', () => {
    cleanup = installEmptyAreaContextMenuGuard();

    const input = document.createElement('input');
    input.type = 'text';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const xtermInner = document.createElement('div');
    xterm.appendChild(xtermInner);
    const prose = document.createElement('p');
    prose.textContent = '可复制的对话内容';
    document.body.append(input, checkbox, textarea, editable, xterm, prose);

    for (const allowed of [input, textarea, editable, xtermInner]) {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      allowed.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }

    // 非文本型 input（如 checkbox）同样不弹剪切/复制/粘贴菜单
    const checkboxEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    checkbox.dispatchEvent(checkboxEv);
    expect(checkboxEv.defaultPrevented).toBe(true);

    // 选中对话文字后，在选区内右键保留原生复制菜单，但右键其他空白区仍阻止默认菜单
    const blankSibling = document.createElement('div');
    document.body.appendChild(blankSibling);
    const range = document.createRange();
    range.selectNodeContents(prose.firstChild!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const selectedEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    prose.dispatchEvent(selectedEv);
    expect(selectedEv.defaultPrevented).toBe(false);

    const blankWhileSelectedEv = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    blankSibling.dispatchEvent(blankWhileSelectedEv);
    expect(blankWhileSelectedEv.defaultPrevented).toBe(true);
  });
});

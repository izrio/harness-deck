/**
 * 抑制 Webview 空白区域右键弹出宿主默认「剪切 / 复制 / 粘贴」菜单：
 * - 自定义 Radix `<ContextMenu>` 触发的右键事件已被 `preventDefault()`，不受影响；
 * - 文本输入框（`<input>` / `<textarea>` / `contenteditable`）、终端（`.xterm`）以及命中的非空文字选区，
 *   保留原生右键菜单以支持正常复制/粘贴；
 * - 其余空白区域或不可编辑控件上右键时拦截默认行为，避免弹出全灰的原生菜单。
 */

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isEditableElement(el: Element): boolean {
  const candidate = el.closest('textarea, input, [contenteditable]');
  if (!candidate) return false;

  if (candidate instanceof HTMLTextAreaElement) {
    return !candidate.disabled;
  }
  if (candidate instanceof HTMLInputElement) {
    if (candidate.disabled) return false;
    const type = (candidate.getAttribute('type') ?? 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (candidate instanceof HTMLElement) {
    if (candidate.isContentEditable) return true;
    const attr = candidate.getAttribute('contenteditable');
    return attr === '' || attr === 'true' || attr === 'plaintext-only';
  }
  return false;
}

function isTargetInNonEmptySelection(target: EventTarget | null, win: Window): boolean {
  const selection = win.getSelection?.();
  if (!selection || selection.isCollapsed || selection.toString().trim().length === 0) {
    return false;
  }
  if (!(target instanceof Node)) return true;
  // 浏览器中右键事件目标为文本节点的直接父元素，直接比对选区起止节点及其父元素
  if (selection.anchorNode && (selection.anchorNode === target || selection.anchorNode.parentNode === target)) {
    return true;
  }
  if (selection.focusNode && (selection.focusNode === target || selection.focusNode.parentNode === target)) {
    return true;
  }
  if (selection.rangeCount > 0 && target.textContent && target.textContent.trim().length > 0) {
    const range = selection.getRangeAt(0);
    if (
      range.commonAncestorContainer.contains(target) &&
      typeof selection.containsNode === 'function' &&
      selection.containsNode(target, true)
    ) {
      return true;
    }
  }
  return false;
}

export function shouldAllowNativeContextMenu(target: EventTarget | null, win: Window = window): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  if (el.closest('[data-allow-native-context-menu], .xterm')) return true;
  if (isEditableElement(el)) return true;
  if (isTargetInNonEmptySelection(target, win)) return true;
  return false;
}

/** 在 `document` 冒泡阶段安装空白区右键抑制监听，返回清理函数。 */
export function installEmptyAreaContextMenuGuard(doc: Document = document, win: Window = window): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (shouldAllowNativeContextMenu(event.target, win)) return;
    event.preventDefault();
  };
  doc.addEventListener('contextmenu', onContextMenu);
  return () => doc.removeEventListener('contextmenu', onContextMenu);
}

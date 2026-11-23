/**
 * 懒加载 CodeMirror 6 内置代码查看与轻编辑组件（P0-1）：
 * - 按需动态分包，不影响首屏加载；
 * - 完整支持语法高亮、代码折叠、文件内搜索（Ctrl/Cmd+F）、主题同步（Light/Dark/OKLCH 预设）与 Ctrl/Cmd+S 保存；
 * - 移动端虚拟键盘与触摸滚动原生友好，零外网请求（严格适配 Webview CSP）。
 */
import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

export interface CodeMirrorEditorProps {
  readonly value: string;
  readonly language?: string;
  readonly readOnly?: boolean;
  readonly onChange?: (next: string) => void;
  readonly onSave?: (value: string) => void;
  readonly searchSignal?: number;
}

function languageExtension(lang?: string): Extension {
  switch (lang?.toLowerCase()) {
    case 'ts':
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'js':
    case 'javascript':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'json':
    case 'jsonc':
      return json();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'md':
    case 'markdown':
      return markdown();
    case 'py':
    case 'python':
      return python();
    case 'rs':
    case 'rust':
      return rust();
    case 'java':
    case 'kt':
    case 'kotlin':
      return java();
    case 'xml':
    case 'svg':
      return xml();
    case 'yml':
    case 'yaml':
      return yaml();
    default:
      return [];
  }
}

const DARK_HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: '#c792ea' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a5e844' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f78c6c' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6b7280', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#82aaff' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#ffcb6b' },
  { tag: [tags.propertyName, tags.attributeName], color: '#89ddff' },
  { tag: [tags.tagName], color: '#f07178' },
  { tag: [tags.operator, tags.punctuation], color: '#94a3b8' },
]);

const BASE_THEME = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--canvas)',
    color: 'var(--ink)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--terminal-font-size, 12.5px)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '8px 0',
    caretColor: 'var(--accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--canvas)',
    color: 'var(--ink-4)',
    borderRight: '1px solid var(--line-soft)',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px 0 12px',
    minWidth: '3.2ch',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)',
    color: 'var(--ink-2)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-tint) !important',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    borderColor: 'var(--line)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--line)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--orange-tint)',
    outline: '1px solid var(--orange)',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--field)',
    color: 'var(--ink)',
    border: '1px solid var(--line-strong)',
    borderRadius: '6px',
    padding: '2px 8px',
    fontSize: '12px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--field)',
    color: 'var(--ink)',
    border: '1px solid var(--line-strong)',
    borderRadius: '6px',
    padding: '2px 8px',
    fontSize: '12px',
    cursor: 'pointer',
  },
});

function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

export default function CodeMirrorEditor({
  value,
  language,
  readOnly = false,
  onChange,
  onSave,
  searchSignal,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const readOnlyComp = useRef(new Compartment());
  const langComp = useRef(new Compartment());
  const highlightComp = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: (view) => {
          onSaveRef.current?.(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        BASE_THEME,
        highlightComp.current.of(syntaxHighlighting(isDarkMode() ? DARK_HIGHLIGHT : defaultHighlightStyle, { fallback: true })),
        langComp.current.of(languageExtension(language)),
        readOnlyComp.current.of(EditorState.readOnly.of(readOnly)),
        saveKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            view.dispatch({
              effects: highlightComp.current.reconfigure(
                syntaxHighlighting(isDarkMode() ? DARK_HIGHLIGHT : defaultHighlightStyle, { fallback: true }),
              ),
            });
          })
        : undefined;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme-preset'] });

    return () => {
      observer?.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        readOnlyComp.current.reconfigure(EditorState.readOnly.of(readOnly)),
        langComp.current.reconfigure(languageExtension(language)),
      ],
    });
  }, [readOnly, language]);

  useEffect(() => {
    if (!searchSignal) return;
    const view = viewRef.current;
    if (view) openSearchPanel(view);
  }, [searchSignal]);

  return <div ref={hostRef} className="h-full min-h-0 w-full" data-testid="codemirror-editor" />;
}

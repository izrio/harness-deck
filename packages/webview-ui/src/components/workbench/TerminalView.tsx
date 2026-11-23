/**
 * 右侧栏「终端」标签页（P1-4，位于 Git tab 右侧）：
 * - 懒加载 `@xterm/xterm` + `@xterm/addon-fit`，完全离线打包并随 CSS 语义变量自动适配明暗主题与 OKLCH 预设；
 * - 支持多终端标签、独立 Worktree 工作目录、清屏、重启、关闭与只读模式保护；
 * - 通过 `subscribeTerminalOutput` 直连高频输出流，零 React 重渲染开销。
 */
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { getTerminalBuffer, subscribeTerminalOutput, useView } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { CloseIcon, PlusIcon, RefreshIcon, TerminalIcon, TrashIcon } from '../icons.tsx';

function readXtermTheme(): Record<string, string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { background: '#1b1d24', foreground: '#eef1f7', cursor: '#346bf1' };
  }
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.classList.contains('dark');
  return {
    background: get('--canvas', dark ? '#1b1d24' : '#fcfcfc'),
    foreground: get('--ink', dark ? '#eef1f7' : '#27272a'),
    cursor: get('--accent', '#346bf1'),
    cursorAccent: get('--canvas', dark ? '#1b1d24' : '#fcfcfc'),
    selectionBackground: get('--accent-tint', 'rgba(52,107,241,0.22)'),
    black: dark ? '#27272a' : '#18181b',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: dark ? '#e4e4e7' : '#52525b',
  };
}

export default function TerminalView() {
  const t = useT();
  const terminal = useView((s) => s.terminal);
  const appearance = useView((s) => s.appearance);
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const activeSession =
    terminal.sessions.find((s) => s.id === terminal.activeId) ?? terminal.sessions[0];
  const activeId = activeSession?.id;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeId) return;

    const fontSize = appearance.terminalFontSize ?? 12;
    const lineHeight = appearance.terminalLineHeight ?? 1.45;
    const fontFamily =
      appearance.codeFontFamily ||
      'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

    const xterm = new Terminal({
      cursorBlink: true,
      fontSize,
      lineHeight,
      fontFamily,
      scrollback: 3_000,
      convertEol: true,
      theme: readXtermTheme(),
      disableStdin: remoteReadOnly,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(el);

    const safeFit = () => {
      try {
        fitAddon.fit();
        if (!remoteReadOnly && xterm.cols >= 20 && xterm.rows >= 5) {
          postToHost({
            type: 'terminalResize',
            payload: { id: activeId, cols: xterm.cols, rows: xterm.rows },
          });
        }
      } catch {
        // 容器隐藏或尺寸为 0 时忽略
      }
    };

    const existing = getTerminalBuffer(activeId);
    if (existing) {
      xterm.write(existing);
    } else {
      // 跨端/重连首次挂载时向宿主请求回放 128KB 环形缓冲
      postToHost({ type: 'terminalSelect', payload: { id: activeId } });
    }

    const inputDisp = xterm.onData((data) => {
      if (remoteReadOnly) return;
      postToHost({ type: 'terminalInput', payload: { id: activeId, data } });
    });

    const unsubOutput = subscribeTerminalOutput((event) => {
      if (event.id !== activeId) return;
      if (event.reset) {
        xterm.reset();
      }
      if (event.data) {
        xterm.write(event.data);
      }
    });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => safeFit()) : undefined;
    ro?.observe(el);
    requestAnimationFrame(safeFit);

    const themeObserver =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            xterm.options.theme = readXtermTheme();
          })
        : undefined;
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme-preset', 'data-high-contrast'],
    });

    termRef.current = xterm;
    fitRef.current = fitAddon;

    return () => {
      themeObserver?.disconnect();
      ro?.disconnect();
      unsubOutput();
      inputDisp.dispose();
      xterm.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [activeId, remoteReadOnly, appearance.terminalFontSize, appearance.terminalLineHeight, appearance.codeFontFamily]);

  const createNew = () => {
    if (remoteReadOnly) return;
    postToHost({ type: 'terminalCreate', payload: {} });
  };

  if (terminal.sessions.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-center"
        data-testid="terminal-empty"
      >
        <div className="flex size-10 items-center justify-center rounded-xl bg-field text-ink-2 shadow-hairline">
          <TerminalIcon className="size-5" />
        </div>
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-ink">{t('wb.terminal.emptyTitle')}</p>
          <p className="max-w-64 text-[12px] leading-relaxed text-ink-3">{t('wb.terminal.emptyDesc')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={remoteReadOnly}
          data-testid="terminal-start-btn"
          onClick={createNew}
        >
          <TerminalIcon className="size-3.5" />
          <span>{t('wb.terminal.start')}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas" data-testid="terminal-view">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-sidebar-border bg-sidebar px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {terminal.sessions.map((session) => {
            const isActive = session.id === activeId;
            return (
              <div
                key={session.id}
                className={cn(
                  'group flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11.5px] transition-colors',
                  isActive
                    ? 'bg-surface font-medium text-ink shadow-hairline dark:bg-field'
                    : 'cursor-pointer text-ink-3 hover:bg-hover hover:text-ink',
                )}
              >
                <button
                  type="button"
                  className="flex items-center gap-1.5"
                  onClick={() => postToHost({ type: 'terminalSelect', payload: { id: session.id } })}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      session.running ? 'bg-green' : 'bg-ink-4',
                    )}
                  />
                  <span className="max-w-28 truncate">{session.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('wb.terminal.close')}
                  className="inline-flex size-4 items-center justify-center rounded text-ink-3 opacity-60 hover:bg-hover-2 hover:text-ink hover:opacity-100"
                  onClick={() => postToHost({ type: 'terminalClose', payload: { id: session.id } })}
                >
                  <CloseIcon className="size-2.5" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={remoteReadOnly}
            aria-label={t('wb.terminal.new')}
            title={t('wb.terminal.new')}
            data-testid="terminal-new-btn"
            onClick={createNew}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          {activeId ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={remoteReadOnly}
                aria-label={t('wb.terminal.restart')}
                title={t('wb.terminal.restart')}
                onClick={() => postToHost({ type: 'terminalRestart', payload: { id: activeId } })}
              >
                <RefreshIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('wb.terminal.clear')}
                title={t('wb.terminal.clear')}
                onClick={() => postToHost({ type: 'terminalClear', payload: { id: activeId } })}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {remoteReadOnly ? (
        <div className="shrink-0 border-b border-line bg-field px-2.5 py-1 text-[11px] text-ink-3">
          {t('wb.terminal.readOnly')}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden p-1.5"
        data-testid="terminal-canvas"
      />
    </div>
  );
}

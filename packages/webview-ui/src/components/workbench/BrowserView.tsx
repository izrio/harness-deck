/**
 * 右侧栏「浏览器」标签页（BrowserView）：
 * - 基于宿主 CDP 真实 Chromium 实例渲染实时交互画面，零 X-Frame-Options / 跨域限制；
 * - 完整支持地址栏导航、前进/后退/刷新、鼠标点击/拖拽/滚轮、键盘输入、自适应/桌面/移动视口切换、控制台日志面板；
 * - 内置 AI MCP 连接控制面板：实时显示 `harness-browser` MCP 注入状态、CDP/MCP 端点、自定义路径或远程 CDP 附着，
 *   并在 AI 自动点击或操作页面时显示操作摘要与视口点击高亮环。
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import type { BrowserViewportPreset } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import { getLastBrowserFrame, subscribeBrowserFrame, useView, type BrowserFrameEvent } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ColumnsIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MonitorIcon,
  PlayIcon,
  PlugIcon,
  RefreshIcon,
  SmartphoneIcon,
  SparklesIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from '../icons.tsx';

const QUICK_URLS = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'] as const;

const VIEWPORT_CYCLE: readonly BrowserViewportPreset[] = ['responsive', 'desktop', 'mobile'];

function executableBasename(path?: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/gu, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function keyModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function mouseButtonFromEvent(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

export default function BrowserView() {
  const t = useT();
  const browser = useView((s) => s.browser);
  const remoteReadOnly = useView((s) => s.clientSurface === 'mobile-web' && s.clientScope === 'read-only');

  const [urlInput, setUrlInput] = useState(browser.url === 'about:blank' ? '' : browser.url);
  const [frame, setFrame] = useState<BrowserFrameEvent | undefined>(() => getLastBrowserFrame());
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [aiPopoverOpen, setAiPopoverOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => !browser.detectedExecutable);
  const [customExec, setCustomExec] = useState('');
  const [customCdp, setCustomCdp] = useState('');
  const [copiedField, setCopiedField] = useState<'mcp' | 'cdp' | null>(null);
  const [pulseVisible, setPulseVisible] = useState(false);

  const viewportBoxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastMoveSentRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const urlFocusedRef = useRef(false);

  useEffect(() => {
    if (!urlFocusedRef.current) {
      setUrlInput(browser.url === 'about:blank' ? '' : browser.url);
    }
  }, [browser.url]);

  useEffect(() => {
    postToHost({ type: 'browserRequestFrame', payload: {} });
    return subscribeBrowserFrame((nextFrame) => {
      setFrame(nextFrame);
    });
  }, []);

  // AI 点击动作在视口上展示短暂脉冲环
  useEffect(() => {
    if (!browser.lastAiAction || browser.lastAiAction.x === undefined || browser.lastAiAction.y === undefined) {
      return;
    }
    setPulseVisible(true);
    const timer = setTimeout(() => setPulseVisible(false), 1_800);
    return () => clearTimeout(timer);
  }, [browser.lastAiAction?.at]);

  // 自适应模式下跟随容器宽度与高度同步 Chromium 视口
  useEffect(() => {
    if (browser.status !== 'running' || browser.viewportPreset !== 'responsive') return;
    const el = viewportBoxRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;

    const scheduleResize = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(360, Math.min(2_560, Math.round(rect.width)));
      const h = Math.max(280, Math.min(2_000, Math.round(rect.height)));
      if (Math.abs(w - browser.viewportWidth) < 8 && Math.abs(h - browser.viewportHeight) < 8) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        postToHost({ type: 'browserResize', payload: { width: w, height: h, preset: 'responsive' } });
      }, 220);
    };

    const ro = new ResizeObserver(scheduleResize);
    ro.observe(el);
    scheduleResize();
    return () => {
      ro.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [browser.status, browser.viewportPreset, browser.viewportWidth, browser.viewportHeight]);

  const computeInitialViewport = (): { readonly width: number; readonly height: number } => {
    const rect = viewportBoxRef.current?.getBoundingClientRect();
    if (rect && rect.width >= 320 && rect.height >= 240) {
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    return { width: 1024, height: 720 };
  };

  const launchBrowser = (overrideUrl?: string) => {
    if (remoteReadOnly) return;
    const size = computeInitialViewport();
    const target = (overrideUrl ?? urlInput).trim();
    postToHost({
      type: 'browserLaunch',
      payload: {
        ...(target ? { url: target } : {}),
        ...(customCdp.trim() ? { cdpUrl: customCdp.trim() } : {}),
        ...(customExec.trim() ? { executablePath: customExec.trim() } : {}),
        width: size.width,
        height: size.height,
      },
    });
  };

  const handleSubmitUrl = (event: FormEvent) => {
    event.preventDefault();
    if (remoteReadOnly) return;
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (browser.status !== 'running') {
      launchBrowser(trimmed);
      return;
    }
    postToHost({ type: 'browserNavigate', payload: { url: trimmed } });
  };

  const cycleViewportPreset = () => {
    const idx = VIEWPORT_CYCLE.indexOf(browser.viewportPreset);
    const next = VIEWPORT_CYCLE[(idx + 1) % VIEWPORT_CYCLE.length]!;
    if (next === 'desktop') {
      postToHost({ type: 'browserResize', payload: { width: 1280, height: 800, preset: 'desktop' } });
    } else if (next === 'mobile') {
      postToHost({ type: 'browserResize', payload: { width: 390, height: 844, preset: 'mobile' } });
    } else {
      const size = computeInitialViewport();
      postToHost({ type: 'browserResize', payload: { width: size.width, height: size.height, preset: 'responsive' } });
    }
  };

  const mapPointerCoords = (clientX: number, clientY: number): { readonly x: number; readonly y: number } | undefined => {
    const img = imgRef.current;
    if (!img) return undefined;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const scaleX = browser.viewportWidth / rect.width;
    const scaleY = browser.viewportHeight / rect.height;
    return {
      x: Math.max(0, Math.min(browser.viewportWidth, Math.round((clientX - rect.left) * scaleX))),
      y: Math.max(0, Math.min(browser.viewportHeight, Math.round((clientY - rect.top) * scaleY))),
    };
  };

  const handleMouseMove = (event: MouseEvent<HTMLImageElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    const now = Date.now();
    if (now - lastMoveSentRef.current < 40) return;
    lastMoveSentRef.current = now;
    const coords = mapPointerCoords(event.clientX, event.clientY);
    if (!coords) return;
    postToHost({
      type: 'browserMouse',
      payload: { action: 'move', x: coords.x, y: coords.y, button: 'none', modifiers: keyModifiers(event) },
    });
  };

  const handleMouseDown = (event: MouseEvent<HTMLImageElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    event.preventDefault();
    viewportBoxRef.current?.focus();
    const coords = mapPointerCoords(event.clientX, event.clientY);
    if (!coords) return;
    postToHost({
      type: 'browserMouse',
      payload: {
        action: 'down',
        x: coords.x,
        y: coords.y,
        button: mouseButtonFromEvent(event.button),
        clickCount: Math.max(1, Math.min(3, event.detail || 1)),
        modifiers: keyModifiers(event),
      },
    });
  };

  const handleMouseUp = (event: MouseEvent<HTMLImageElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    event.preventDefault();
    const coords = mapPointerCoords(event.clientX, event.clientY);
    if (!coords) return;
    postToHost({
      type: 'browserMouse',
      payload: {
        action: 'up',
        x: coords.x,
        y: coords.y,
        button: mouseButtonFromEvent(event.button),
        clickCount: Math.max(1, Math.min(3, event.detail || 1)),
        modifiers: keyModifiers(event),
      },
    });
  };

  const handleWheel = (event: WheelEvent<HTMLImageElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    const coords = mapPointerCoords(event.clientX, event.clientY);
    if (!coords) return;
    postToHost({
      type: 'browserMouse',
      payload: {
        action: 'wheel',
        x: coords.x,
        y: coords.y,
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        modifiers: keyModifiers(event),
      },
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
    event.preventDefault();
    postToHost({
      type: 'browserKey',
      payload: {
        action: 'down',
        key: event.key,
        code: event.code,
        modifiers: keyModifiers(event),
      },
    });
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
    event.preventDefault();
    postToHost({
      type: 'browserKey',
      payload: {
        action: 'up',
        key: event.key,
        code: event.code,
        modifiers: keyModifiers(event),
      },
    });
  };

  const copyText = (field: 'mcp' | 'cdp', value: string) => {
    try {
      void navigator.clipboard?.writeText(value);
    } catch {
      // ignore in restricted env
    }
    setCopiedField(field);
    setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1_500);
  };

  const errorCount = browser.consoleLogs.filter((entry) => entry.level === 'error').length;
  const isRunning = browser.status === 'running';
  const isStarting = browser.status === 'starting';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas" data-testid="right-panel-browser">
      {/* 顶部地址栏与工具条（严格统一 size="xs" / "icon-xs"） */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar/60 px-2">
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="browser-back-btn"
            aria-label={t('wb.browser.back')}
            title={t('wb.browser.back')}
            disabled={!isRunning || !browser.canGoBack || remoteReadOnly}
            onClick={() => postToHost({ type: 'browserBack', payload: {} })}
            className="text-ink-2 hover:bg-hover hover:text-ink"
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="browser-forward-btn"
            aria-label={t('wb.browser.forward')}
            title={t('wb.browser.forward')}
            disabled={!isRunning || !browser.canGoForward || remoteReadOnly}
            onClick={() => postToHost({ type: 'browserForward', payload: {} })}
            className="text-ink-2 hover:bg-hover hover:text-ink"
          >
            <ArrowRightIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="browser-reload-btn"
            aria-label={t('wb.browser.reload')}
            title={t('wb.browser.reload')}
            disabled={!isRunning || remoteReadOnly}
            onClick={() => postToHost({ type: 'browserReload', payload: {} })}
            className="text-ink-2 hover:bg-hover hover:text-ink"
          >
            <RefreshIcon className={cn('size-3.5', (browser.loading || isStarting) && 'spin')} />
          </Button>
        </div>

        <form onSubmit={handleSubmitUrl} className="min-w-0 flex-1">
          <Input
            size="xs"
            data-testid="browser-url-input"
            value={urlInput}
            onFocus={() => {
              urlFocusedRef.current = true;
            }}
            onBlur={() => {
              urlFocusedRef.current = false;
            }}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={t('wb.browser.urlPlaceholder')}
            aria-label={t('wb.browser.urlPlaceholder')}
            disabled={remoteReadOnly}
            className="bg-surface/90 font-mono text-[11.5px]"
          />
        </form>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* AI 连接状态与设置 Popover */}
          <Popover open={aiPopoverOpen} onOpenChange={setAiPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="browser-ai-popover-trigger"
                title={t('wb.browser.aiTitle')}
                className={cn(
                  'gap-1 px-1.5 font-medium',
                  browser.aiEnabled
                    ? 'bg-green-tint/70 text-green hover:bg-green-tint'
                    : 'text-ink-3 hover:bg-hover hover:text-ink',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 rounded-full', browser.aiEnabled ? 'bg-green' : 'bg-ink-3/50')}
                />
                <PlugIcon className="size-3" />
                <span className="text-[11px]">AI</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="w-72 p-3">
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <Label
                    htmlFor="browser-ai-switch"
                    className="flex cursor-pointer items-center gap-1.5 text-[12.5px] font-semibold text-ink"
                  >
                    <SparklesIcon className="size-3.5 text-accent-ink" />
                    <span>{t('wb.browser.aiTitle')}</span>
                  </Label>
                  <Switch
                    id="browser-ai-switch"
                    data-testid="browser-ai-switch"
                    checked={browser.aiEnabled}
                    disabled={remoteReadOnly}
                    onCheckedChange={(checked) =>
                      postToHost({ type: 'browserSetAiEnabled', payload: { enabled: checked } })
                    }
                  />
                </div>

                {browser.mcpUrl || browser.cdpUrl ? (
                  <div className="divide-y divide-line/50 overflow-hidden rounded-lg border border-line/60 bg-inset/50">
                    {browser.mcpUrl ? (
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="shrink-0 font-mono text-[10px] font-medium tracking-wide text-ink-3">MCP</span>
                        <code
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2 tabular-nums"
                          title={browser.mcpUrl}
                        >
                          {browser.mcpUrl}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('wb.browser.mcpEndpoint')}
                          title={t('wb.browser.mcpEndpoint')}
                          onClick={() => copyText('mcp', browser.mcpUrl!)}
                        >
                          {copiedField === 'mcp' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                        </Button>
                      </div>
                    ) : null}

                    {browser.cdpUrl ? (
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="shrink-0 font-mono text-[10px] font-medium tracking-wide text-ink-3">CDP</span>
                        <code
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2 tabular-nums"
                          title={browser.cdpUrl}
                        >
                          {browser.cdpUrl}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('wb.browser.cdpEndpoint')}
                          title={t('wb.browser.cdpEndpoint')}
                          onClick={() => copyText('cdp', browser.cdpUrl!)}
                        >
                          {copiedField === 'cdp' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="border-t border-line/60 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="browser-advanced-toggle"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((v) => !v)}
                    className="w-full justify-between px-1.5 text-ink-2 hover:bg-hover hover:text-ink"
                  >
                    <span className="flex items-center gap-1 text-[11.5px] font-medium">
                      {advancedOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                      <span>{t('wb.browser.advancedConnect')}</span>
                    </span>
                    <span
                      className="max-w-32 truncate font-mono text-[10.5px] font-normal text-ink-3"
                      title={browser.detectedExecutable}
                    >
                      {browser.detectedExecutable
                        ? executableBasename(browser.detectedExecutable)
                        : t('wb.browser.notDetected')}
                    </span>
                  </Button>

                  {advancedOpen ? (
                    <div className="mt-2 flex flex-col gap-2" data-testid="browser-advanced-panel">
                      <Input
                        size="sm"
                        value={customExec}
                        onChange={(e) => setCustomExec(e.target.value)}
                        placeholder={t('wb.browser.execPlaceholder')}
                        disabled={remoteReadOnly}
                        className="font-mono text-xs"
                      />
                      <Input
                        size="sm"
                        value={customCdp}
                        onChange={(e) => setCustomCdp(e.target.value)}
                        placeholder={t('wb.browser.cdpPlaceholder')}
                        disabled={remoteReadOnly}
                        className="font-mono text-xs"
                      />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          disabled={remoteReadOnly || isStarting}
                          onClick={() => {
                            setAiPopoverOpen(false);
                            launchBrowser();
                          }}
                        >
                          {isRunning ? t('wb.browser.reconnect') : t('wb.browser.connect')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="browser-viewport-btn"
            aria-label={t(`wb.browser.viewport.${browser.viewportPreset}`)}
            title={t(`wb.browser.viewport.${browser.viewportPreset}`)}
            disabled={!isRunning || remoteReadOnly}
            onClick={cycleViewportPreset}
            className="text-ink-2 hover:bg-hover hover:text-ink"
          >
            {browser.viewportPreset === 'mobile' ? (
              <SmartphoneIcon className="size-3.5" />
            ) : browser.viewportPreset === 'desktop' ? (
              <MonitorIcon className="size-3.5" />
            ) : (
              <ColumnsIcon className="size-3.5" />
            )}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="browser-console-toggle"
            aria-label={t('wb.browser.console')}
            title={t('wb.browser.console')}
            aria-pressed={consoleOpen}
            onClick={() => setConsoleOpen((v) => !v)}
            className={cn(
              'relative text-ink-2 hover:bg-hover hover:text-ink',
              consoleOpen && 'bg-hover text-ink',
            )}
          >
            <TerminalIcon className="size-3.5" />
            {errorCount > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-red" aria-hidden="true" />
            ) : null}
          </Button>

          {browser.url && browser.url !== 'about:blank' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('wb.browser.openExternal')}
              title={t('wb.browser.openExternal')}
              onClick={() => postToHost({ type: 'openExternal', payload: { url: browser.url } })}
              className="text-ink-2 hover:bg-hover hover:text-ink"
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          ) : null}

          {isRunning ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="browser-stop-btn"
              aria-label={t('wb.browser.stop')}
              title={t('wb.browser.stop')}
              disabled={remoteReadOnly}
              onClick={() => postToHost({ type: 'browserStop', payload: {} })}
              className="text-ink-2 hover:bg-hover hover:text-red"
            >
              <StopIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* AI 操作实时反馈条 */}
      {isRunning && browser.lastAiAction ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-sidebar-border/80 bg-accent-tint/45 px-2.5 py-1 text-[11px] text-accent-ink"
          data-testid="browser-ai-banner"
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <SparklesIcon className="size-3 shrink-0" />
            <span className="truncate">{t('wb.browser.aiActive', browser.lastAiAction.summary)}</span>
          </span>
          <span className="shrink-0 font-mono text-[10px] opacity-75 tabular-nums">
            {browser.viewportWidth}×{browser.viewportHeight}
          </span>
        </div>
      ) : null}

      {/* 主画面区：未启动引导卡片 / 实时交互视口 */}
      <div
        ref={viewportBoxRef}
        tabIndex={isRunning ? 0 : -1}
        data-testid="browser-viewport"
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto bg-inset/60 outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {isRunning || isStarting ? (
          frame ? (
            <div className="relative flex max-h-full max-w-full items-center justify-center">
              <img
                ref={imgRef}
                src={`data:image/jpeg;base64,${frame.data}`}
                alt={browser.title || browser.url}
                draggable={false}
                onMouseMove={handleMouseMove}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onWheel={handleWheel}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'block select-none bg-surface shadow-card',
                  browser.viewportPreset === 'responsive' ? 'h-full w-full object-contain' : 'max-h-full max-w-full object-contain',
                )}
              />
              {pulseVisible && browser.lastAiAction?.x !== undefined && browser.lastAiAction?.y !== undefined ? (
                <span
                  aria-hidden="true"
                  style={{
                    left: `${(browser.lastAiAction.x / Math.max(1, browser.viewportWidth)) * 100}%`,
                    top: `${(browser.lastAiAction.y / Math.max(1, browser.viewportHeight)) * 100}%`,
                  }}
                  className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 border-accent bg-accent/25"
                />
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 text-center text-[12px] text-ink-3">
              <RefreshIcon className="size-5 spin text-accent-ink" />
              <span>{t('wb.browser.starting')}</span>
            </div>
          )
        ) : (
          <div className="flex w-full max-w-xs flex-col items-center gap-3.5 px-5 py-8 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl border border-line/60 bg-surface text-ink-2 shadow-hairline">
              <GlobeIcon className="size-5" />
            </div>

            <h3 className="m-0 text-[13px] font-medium text-ink">{t('wb.browser.emptyTitle')}</h3>

            {browser.error ? (
              <div
                className="w-full rounded-lg border border-red/25 bg-red-tint/70 px-3 py-2 text-left text-[11.5px] leading-relaxed text-red"
                data-testid="browser-error"
              >
                {browser.error}
              </div>
            ) : null}

            <Button
              type="button"
              size="sm"
              data-testid="browser-launch-btn"
              disabled={remoteReadOnly || isStarting}
              onClick={() => launchBrowser()}
              className="px-4"
            >
              <PlayIcon className="size-3.5" />
              <span>{t('wb.browser.launch')}</span>
            </Button>

            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {QUICK_URLS.map((presetUrl) => (
                <Button
                  key={presetUrl}
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={remoteReadOnly || isStarting}
                  onClick={() => {
                    setUrlInput(presetUrl);
                    launchBrowser(presetUrl);
                  }}
                  className="font-mono text-[11px] text-ink-3 hover:text-ink"
                >
                  {presetUrl.replace('http://', '')}
                </Button>
              ))}
            </div>

            {remoteReadOnly ? (
              <p className="m-0 text-[11px] text-ink-3">{t('wb.browser.readOnly')}</p>
            ) : !browser.detectedExecutable ? (
              <p className="m-0 text-[11px] text-ink-3">{t('wb.browser.notDetected')}</p>
            ) : null}
          </div>
        )}
      </div>

      {/* 可折叠控制台日志抽屉 */}
      {consoleOpen ? (
        <div
          className="flex h-36 shrink-0 flex-col border-t border-sidebar-border bg-sidebar"
          data-testid="browser-console-drawer"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/70 px-2.5 py-1">
            <span className="text-[11px] font-medium text-ink-2">
              {t('wb.browser.console')} ({browser.consoleLogs.length})
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('wb.browser.consoleClear')}
              title={t('wb.browser.consoleClear')}
              onClick={() => postToHost({ type: 'browserClearConsole', payload: {} })}
              className="text-ink-3 hover:bg-hover hover:text-ink"
            >
              <TrashIcon className="size-3" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px]">
            {browser.consoleLogs.length === 0 ? (
              <div className="py-4 text-center text-ink-3">{t('wb.browser.consoleEmpty')}</div>
            ) : (
              browser.consoleLogs.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    'flex items-start gap-1.5 border-b border-line/40 py-0.5 break-all',
                    entry.level === 'error'
                      ? 'text-red'
                      : entry.level === 'warn'
                        ? 'text-orange'
                        : 'text-ink-2',
                  )}
                >
                  <span className="shrink-0 uppercase opacity-70">{entry.level}</span>
                  <span className="min-w-0 flex-1">{entry.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

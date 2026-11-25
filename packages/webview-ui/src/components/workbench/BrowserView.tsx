/**
 * 右侧栏「浏览器」标签页（BrowserView）：
 * - 基于宿主 CDP 真实 Chromium 实例渲染实时交互画面，零 X-Frame-Options / 跨域限制；
 * - 完整支持地址栏导航、前进/后退/刷新、鼠标点击/拖拽/滚轮、键盘输入、自适应/桌面/移动视口切换、控制台日志面板；
 * - 内置 AI MCP 连接控制面板：实时显示 `harness-browser` MCP 注入状态、CDP/MCP 端点、自定义路径或远程 CDP 附着，
 *   并在 AI 自动点击或操作页面时显示操作摘要与视口点击高亮环。
 */
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from 'react';
import type { BrowserDomElement, BrowserViewportPreset } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import {
  getLastBrowserFrame,
  subscribeBrowserClipboard,
  subscribeBrowserConsoleObject,
  subscribeBrowserFrame,
  subscribeBrowserInspect,
  subscribeBrowserNetworkBody,
  useView,
  type BrowserConsoleObjectEvent,
  type BrowserFrameEvent,
  type BrowserNetworkBodyEvent,
} from '../../store.ts';
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
  InspectIcon,
  MonitorIcon,
  PlayIcon,
  PlugIcon,
  RefreshIcon,
  SmartphoneIcon,
  SparklesIcon,
  StopIcon,
  TerminalIcon,
} from '../icons.tsx';
import {
  BrowserDevTools,
  type BrowserDevToolsDock,
  type BrowserDevToolsTab,
} from './BrowserDevTools.tsx';

const QUICK_URLS = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'] as const;

const VIEWPORT_CYCLE: readonly BrowserViewportPreset[] = ['responsive', 'desktop', 'mobile'];

function currentDeviceScaleFactor(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.devicePixelRatio)) return 1;
  return Math.round(Math.max(1, Math.min(2, window.devicePixelRatio)) * 100) / 100;
}

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
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsTab, setDevtoolsTab] = useState<BrowserDevToolsTab>('console');
  const [devtoolsDock, setDevtoolsDock] = useState<BrowserDevToolsDock>('bottom');
  const [devtoolsBottomHeight, setDevtoolsBottomHeight] = useState(220);
  const [devtoolsSideWidth, setDevtoolsSideWidth] = useState(280);
  const [inspectMode, setInspectMode] = useState(false);
  const [hoveredElement, setHoveredElement] = useState<BrowserDomElement | undefined>();
  const [selectedElement, setSelectedElement] = useState<BrowserDomElement | undefined>();
  const [highlightSelected, setHighlightSelected] = useState(true);
  const [networkBodies, setNetworkBodies] = useState<Record<string, BrowserNetworkBodyEvent>>({});
  const [consoleObjects, setConsoleObjects] = useState<Record<string, BrowserConsoleObjectEvent>>({});
  const consoleObjectReqSeqRef = useRef(0);
  const requestedConsoleObjectsRef = useRef<Set<string>>(new Set());
  const [aiPopoverOpen, setAiPopoverOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => !browser.detectedExecutable);
  const [customExec, setCustomExec] = useState('');
  const [customCdp, setCustomCdp] = useState('');
  const [copiedField, setCopiedField] = useState<'mcp' | 'cdp' | null>(null);
  const [pulseVisible, setPulseVisible] = useState(false);

  const viewportBoxRef = useRef<HTMLDivElement>(null);
  const bodyContainerRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const contextCoordsRef = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);
  const lastMoveSentRef = useRef(0);
  const lastInspectSentRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const urlFocusedRef = useRef(false);
  const lastDprRef = useRef(currentDeviceScaleFactor());

  useEffect(() => {
    if (!urlFocusedRef.current) {
      setUrlInput(browser.url === 'about:blank' ? '' : browser.url);
    }
  }, [browser.url]);

  useEffect(() => {
    postToHost({ type: 'browserRequestFrame', payload: {} });
    const unsubFrame = subscribeBrowserFrame((nextFrame) => {
      setFrame(nextFrame);
    });
    const unsubInspect = subscribeBrowserInspect((event) => {
      if (event.mode === 'hover') {
        setHoveredElement(event.element);
      } else {
        setSelectedElement(event.element);
        setHoveredElement(undefined);
        if (event.element) {
          setHighlightSelected(true);
          setDevtoolsOpen(true);
          setDevtoolsTab('elements');
        }
      }
    });
    const unsubNetBody = subscribeBrowserNetworkBody((event) => {
      setNetworkBodies((prev) => ({ ...prev, [event.requestId]: event }));
    });
    const unsubConsoleObj = subscribeBrowserConsoleObject((event) => {
      setConsoleObjects((prev) => ({ ...prev, [event.objectId]: event }));
    });
    const unsubClipboard = subscribeBrowserClipboard((text) => {
      if (text) {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      }
    });
    return () => {
      unsubFrame();
      unsubInspect();
      unsubNetBody();
      unsubConsoleObj();
      unsubClipboard();
    };
  }, []);

  // 浏览器停止或清空控制台时重置对象展开缓存
  useEffect(() => {
    if (browser.status !== 'running') {
      setInspectMode(false);
      setHoveredElement(undefined);
      setConsoleObjects({});
      requestedConsoleObjectsRef.current.clear();
    }
  }, [browser.status]);

  useEffect(() => {
    if (browser.consoleLogs.length === 0) {
      setConsoleObjects({});
      requestedConsoleObjectsRef.current.clear();
    }
  }, [browser.consoleLogs.length]);

  const requestConsoleObject = (objectId: string) => {
    if (consoleObjects[objectId] || requestedConsoleObjectsRef.current.has(objectId)) return;
    requestedConsoleObjectsRef.current.add(objectId);
    const requestId = `obj-${++consoleObjectReqSeqRef.current}`;
    postToHost({ type: 'browserGetConsoleObject', payload: { requestId, objectId } });
  };

  // 拾取模式下按 Escape 立即退出拾取
  useEffect(() => {
    if (!inspectMode) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInspectMode(false);
        setHoveredElement(undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [inspectMode]);

  const toggleInspectMode = () => {
    if (remoteReadOnly || browser.status !== 'running') return;
    setInspectMode((prev) => {
      const next = !prev;
      if (next) {
        setDevtoolsOpen(true);
        setDevtoolsTab('elements');
      } else {
        setHoveredElement(undefined);
      }
      return next;
    });
  };

  const startDevtoolsResize = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const isSide = devtoolsDock === 'left' || devtoolsDock === 'right';
    const startSize = isSide ? devtoolsSideWidth : devtoolsBottomHeight;
    const containerRect = bodyContainerRef.current?.getBoundingClientRect();
    const maxSize = isSide
      ? Math.max(220, Math.floor((containerRect?.width ?? 600) * 0.65))
      : Math.max(160, Math.floor((containerRect?.height ?? 600) * 0.65));

    const onMove = (moveEvent: globalThis.MouseEvent) => {
      if (devtoolsDock === 'bottom') {
        const next = Math.max(140, Math.min(maxSize, Math.round(startSize + (startY - moveEvent.clientY))));
        setDevtoolsBottomHeight(next);
      } else if (devtoolsDock === 'right') {
        const next = Math.max(200, Math.min(maxSize, Math.round(startSize + (startX - moveEvent.clientX))));
        setDevtoolsSideWidth(next);
      } else {
        const next = Math.max(200, Math.min(maxSize, Math.round(startSize + (moveEvent.clientX - startX))));
        setDevtoolsSideWidth(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // AI 点击动作在视口上展示短暂脉冲环
  useEffect(() => {
    if (!browser.lastAiAction || browser.lastAiAction.x === undefined || browser.lastAiAction.y === undefined) {
      return;
    }
    setPulseVisible(true);
    const timer = setTimeout(() => setPulseVisible(false), 1_800);
    return () => clearTimeout(timer);
  }, [browser.lastAiAction?.at]);

  // 自适应模式下跟随容器宽度、高度与屏幕 DPR 精确同步 Chromium 视口，消除非整数倍模糊缩放
  useEffect(() => {
    if (browser.status !== 'running' || browser.viewportPreset !== 'responsive') return;
    const el = viewportBoxRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;

    const scheduleResize = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(360, Math.min(2_560, Math.round(rect.width)));
      const h = Math.max(280, Math.min(2_000, Math.round(rect.height)));
      const dpr = currentDeviceScaleFactor();
      if (Math.abs(w - browser.viewportWidth) < 1 && Math.abs(h - browser.viewportHeight) < 1 && dpr === lastDprRef.current) {
        return;
      }
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        lastDprRef.current = dpr;
        postToHost({
          type: 'browserResize',
          payload: { width: w, height: h, preset: 'responsive', deviceScaleFactor: dpr },
        });
      }, 180);
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
    const dpr = currentDeviceScaleFactor();
    lastDprRef.current = dpr;
    const target = (overrideUrl ?? urlInput).trim();
    postToHost({
      type: 'browserLaunch',
      payload: {
        ...(target ? { url: target } : {}),
        ...(customCdp.trim() ? { cdpUrl: customCdp.trim() } : {}),
        ...(customExec.trim() ? { executablePath: customExec.trim() } : {}),
        width: size.width,
        height: size.height,
        deviceScaleFactor: dpr,
      },
    });
  };

  const submitUrl = () => {
    if (remoteReadOnly) return;
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    urlFocusedRef.current = false;
    urlInputRef.current?.blur();
    if (browser.status === 'running' || browser.status === 'starting') {
      postToHost({ type: 'browserNavigate', payload: { url: trimmed } });
      return;
    }
    launchBrowser(trimmed);
  };

  const handleSubmitUrl = (event: FormEvent) => {
    event.preventDefault();
    submitUrl();
  };

  const cycleViewportPreset = () => {
    const idx = VIEWPORT_CYCLE.indexOf(browser.viewportPreset);
    const next = VIEWPORT_CYCLE[(idx + 1) % VIEWPORT_CYCLE.length]!;
    const dpr = currentDeviceScaleFactor();
    lastDprRef.current = dpr;
    if (next === 'desktop') {
      postToHost({ type: 'browserResize', payload: { width: 1280, height: 800, preset: 'desktop', deviceScaleFactor: dpr } });
    } else if (next === 'mobile') {
      postToHost({ type: 'browserResize', payload: { width: 390, height: 844, preset: 'mobile', deviceScaleFactor: dpr } });
    } else {
      const size = computeInitialViewport();
      postToHost({
        type: 'browserResize',
        payload: { width: size.width, height: size.height, preset: 'responsive', deviceScaleFactor: dpr },
      });
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
    const coords = mapPointerCoords(event.clientX, event.clientY);
    if (!coords) return;
    const now = Date.now();
    if (inspectMode) {
      if (now - lastInspectSentRef.current < 55) return;
      lastInspectSentRef.current = now;
      postToHost({
        type: 'browserInspectAt',
        payload: { x: coords.x, y: coords.y, select: false },
      });
      return;
    }
    if (now - lastMoveSentRef.current < 40) return;
    lastMoveSentRef.current = now;
    postToHost({
      type: 'browserMouse',
      payload: {
        action: 'move',
        x: coords.x,
        y: coords.y,
        button: (event.buttons & 1) !== 0 ? 'left' : 'none',
        ...(event.buttons ? { buttons: event.buttons } : {}),
        modifiers: keyModifiers(event),
      },
    });
  };

  const handleMouseDown = (event: MouseEvent<HTMLImageElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    if (event.button === 2) {
      // 右键留给内置 ContextMenu（复制/剪切/粘贴/全选/检查元素），不破坏当前文字选区
      contextCoordsRef.current = mapPointerCoords(event.clientX, event.clientY);
      return;
    }
    event.preventDefault();
    const coords = mapPointerCoords(event.clientX, event.clientY);
    if (!coords) return;
    if (inspectMode) {
      setInspectMode(false);
      setHoveredElement(undefined);
      postToHost({
        type: 'browserInspectAt',
        payload: { x: coords.x, y: coords.y, select: true },
      });
      return;
    }
    viewportBoxRef.current?.focus();
    postToHost({
      type: 'browserMouse',
      payload: {
        action: 'down',
        x: coords.x,
        y: coords.y,
        button: mouseButtonFromEvent(event.button),
        ...(event.buttons ? { buttons: event.buttons } : {}),
        clickCount: Math.max(1, Math.min(3, event.detail || 1)),
        modifiers: keyModifiers(event),
      },
    });
  };

  const handleMouseUp = (event: MouseEvent<HTMLImageElement>) => {
    if (remoteReadOnly || browser.status !== 'running' || inspectMode) return;
    if (event.button === 2) return;
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
        ...(event.buttons ? { buttons: event.buttons } : {}),
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

  const triggerPasteFromMenu = () => {
    if (remoteReadOnly || browser.status !== 'running') return;
    const reader = navigator.clipboard?.readText;
    if (typeof reader === 'function') {
      void reader
        .call(navigator.clipboard)
        .then((text) => {
          postToHost({ type: 'browserClipboard', payload: text ? { action: 'paste', text } : { action: 'paste' } });
        })
        .catch(() => {
          postToHost({ type: 'browserClipboard', payload: { action: 'paste' } });
        });
      return;
    }
    postToHost({ type: 'browserClipboard', payload: { action: 'paste' } });
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    postToHost({
      type: 'browserClipboard',
      payload: text ? { action: 'paste', text } : { action: 'paste' },
    });
  };

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    event.preventDefault();
    postToHost({ type: 'browserClipboard', payload: { action: 'copy' } });
  };

  const handleCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    event.preventDefault();
    postToHost({ type: 'browserClipboard', payload: { action: 'cut' } });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (remoteReadOnly || browser.status !== 'running') return;
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
    const isAccel = (event.ctrlKey || event.metaKey) && !event.altKey;
    const lowerKey = event.key.toLowerCase();
    if (isAccel && !event.shiftKey) {
      if (lowerKey === 'c') {
        event.preventDefault();
        postToHost({ type: 'browserClipboard', payload: { action: 'copy' } });
        return;
      }
      if (lowerKey === 'x') {
        event.preventDefault();
        postToHost({ type: 'browserClipboard', payload: { action: 'cut' } });
        return;
      }
      if (lowerKey === 'a') {
        event.preventDefault();
        postToHost({ type: 'browserClipboard', payload: { action: 'selectAll' } });
        return;
      }
      if (lowerKey === 'v') {
        // 不拦截默认行为，让浏览器触发原生 onPaste 以零权限读取 clipboardData
        return;
      }
    }
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
    const isAccel = (event.ctrlKey || event.metaKey) && !event.altKey;
    const lowerKey = event.key.toLowerCase();
    if (isAccel && !event.shiftKey && (lowerKey === 'c' || lowerKey === 'x' || lowerKey === 'v' || lowerKey === 'a')) {
      return;
    }
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
            ref={urlInputRef}
            size="xs"
            data-testid="browser-url-input"
            value={urlInput}
            onFocus={() => {
              urlFocusedRef.current = true;
            }}
            onBlur={() => {
              urlFocusedRef.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitUrl();
              } else if (e.key === 'Escape') {
                urlFocusedRef.current = false;
                setUrlInput(browser.url === 'about:blank' ? '' : browser.url);
                urlInputRef.current?.blur();
              }
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
            data-testid="browser-inspect-btn"
            aria-label={t('wb.browser.inspect')}
            title={t('wb.browser.inspect')}
            aria-pressed={inspectMode}
            disabled={!isRunning || remoteReadOnly}
            onClick={toggleInspectMode}
            className={cn(
              'text-ink-2 hover:bg-hover hover:text-ink',
              inspectMode && 'bg-accent-tint text-accent-ink hover:bg-accent-tint',
            )}
          >
            <InspectIcon className="size-3.5" />
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="browser-console-toggle"
            aria-label={t('wb.browser.devtools')}
            title={t('wb.browser.devtools')}
            aria-pressed={devtoolsOpen}
            onClick={() => setDevtoolsOpen((v) => !v)}
            className={cn(
              'relative text-ink-2 hover:bg-hover hover:text-ink',
              devtoolsOpen && 'bg-hover text-ink',
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

      {/* 主内容区：浏览器视口 + 可停靠在左/底/右的开发者工具（Elements / Console / Network） */}
      {(() => {
        const activeOverlayEl = inspectMode
          ? hoveredElement
          : devtoolsOpen && highlightSelected && devtoolsTab === 'elements'
            ? selectedElement
            : undefined;
        const isSideDock = devtoolsDock === 'left' || devtoolsDock === 'right';
        const devtoolsNode = devtoolsOpen ? (
          <BrowserDevTools
            tab={devtoolsTab}
            onTabChange={setDevtoolsTab}
            dock={devtoolsDock}
            onDockChange={setDevtoolsDock}
            onClose={() => {
              setDevtoolsOpen(false);
              setInspectMode(false);
              setHoveredElement(undefined);
            }}
            size={isSideDock ? devtoolsSideWidth : devtoolsBottomHeight}
            running={isRunning}
            readOnly={remoteReadOnly}
            inspectMode={inspectMode}
            onToggleInspect={toggleInspectMode}
            selectedElement={selectedElement}
            highlightVisible={highlightSelected}
            onToggleHighlight={() => setHighlightSelected((v) => !v)}
            consoleLogs={browser.consoleLogs}
            preserveConsoleLog={browser.preserveConsoleLog === true}
            consoleObjects={consoleObjects}
            onRequestConsoleObject={requestConsoleObject}
            networkRequests={browser.networkRequests ?? []}
            networkBodies={networkBodies}
          />
        ) : null;

        const splitterNode = devtoolsOpen ? (
          <div
            role="separator"
            aria-orientation={isSideDock ? 'vertical' : 'horizontal'}
            data-testid="browser-devtools-splitter"
            onMouseDown={startDevtoolsResize}
            className={cn(
              'shrink-0 bg-transparent transition-colors hover:bg-accent/50',
              isSideDock ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
            )}
          />
        ) : null;

        const viewportNode = (
          <div
            ref={viewportBoxRef}
            tabIndex={isRunning ? 0 : -1}
            data-testid="browser-viewport"
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onPaste={handlePaste}
            onCopy={handleCopy}
            onCut={handleCut}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center overflow-auto bg-inset/60 outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          >
            {isRunning || isStarting ? (
              frame ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="relative flex max-h-full max-w-full items-center justify-center">
                      <img
                        ref={imgRef}
                        src={`data:image/${frame.format === 'png' ? 'png' : 'jpeg'};base64,${frame.data}`}
                        alt={browser.title || browser.url}
                        draggable={false}
                        onMouseMove={handleMouseMove}
                        onMouseLeave={() => {
                          if (inspectMode) setHoveredElement(undefined);
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseUp={handleMouseUp}
                        onWheel={handleWheel}
                        onContextMenu={(e) => {
                          contextCoordsRef.current = mapPointerCoords(e.clientX, e.clientY);
                        }}
                        style={{
                          maxWidth: `min(100%, ${browser.viewportWidth}px)`,
                          maxHeight: `min(100%, ${browser.viewportHeight}px)`,
                        }}
                        className={cn(
                          'block h-auto w-auto select-none bg-surface shadow-card',
                          inspectMode && 'cursor-crosshair',
                        )}
                      />
                      {activeOverlayEl && activeOverlayEl.rect.width > 0 && activeOverlayEl.rect.height > 0 ? (
                        <div
                          aria-hidden="true"
                          data-testid="browser-dom-highlight"
                          style={{
                            left: `${Math.max(0, Math.min(100, (activeOverlayEl.rect.x / Math.max(1, browser.viewportWidth)) * 100))}%`,
                            top: `${Math.max(0, Math.min(100, (activeOverlayEl.rect.y / Math.max(1, browser.viewportHeight)) * 100))}%`,
                            width: `${Math.max(0.5, Math.min(100, (activeOverlayEl.rect.width / Math.max(1, browser.viewportWidth)) * 100))}%`,
                            height: `${Math.max(0.5, Math.min(100, (activeOverlayEl.rect.height / Math.max(1, browser.viewportHeight)) * 100))}%`,
                          }}
                          className="pointer-events-none absolute border border-brand bg-brand/15 shadow-[inset_0_0_0_1px_rgb(255_255_255/25%)]"
                        >
                          <span className="absolute -top-5 left-0 max-w-64 truncate rounded bg-brand px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium text-brand-foreground shadow-xs">
                            {activeOverlayEl.label} · {activeOverlayEl.rect.width}×{activeOverlayEl.rect.height}
                          </span>
                        </div>
                      ) : null}
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
                  </ContextMenuTrigger>
                  <ContextMenuContent className="min-w-40">
                    <ContextMenuItem
                      disabled={remoteReadOnly || !isRunning}
                      onSelect={() => postToHost({ type: 'browserClipboard', payload: { action: 'copy' } })}
                    >
                      {t('wb.browser.ctx.copy')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={remoteReadOnly || !isRunning}
                      onSelect={() => postToHost({ type: 'browserClipboard', payload: { action: 'cut' } })}
                    >
                      {t('wb.browser.ctx.cut')}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={remoteReadOnly || !isRunning} onSelect={triggerPasteFromMenu}>
                      {t('wb.browser.ctx.paste')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={remoteReadOnly || !isRunning}
                      onSelect={() => postToHost({ type: 'browserClipboard', payload: { action: 'selectAll' } })}
                    >
                      {t('wb.browser.ctx.selectAll')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      disabled={remoteReadOnly || !isRunning}
                      onSelect={() => {
                        const coords = contextCoordsRef.current ?? {
                          x: Math.round(browser.viewportWidth / 2),
                          y: Math.round(browser.viewportHeight / 2),
                        };
                        setInspectMode(false);
                        postToHost({ type: 'browserInspectAt', payload: { x: coords.x, y: coords.y, select: true } });
                      }}
                    >
                      {t('wb.browser.ctx.inspect')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={remoteReadOnly || !isRunning}
                      onSelect={() => postToHost({ type: 'browserReload', payload: {} })}
                    >
                      {t('wb.browser.reload')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
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
                    className="max-h-40 w-full overflow-y-auto rounded-lg border border-red/25 bg-red-tint/70 px-3 py-2 text-left text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-red"
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
        );

        return (
          <div
            ref={bodyContainerRef}
            data-testid="browser-body"
            className={cn(
              'flex min-h-0 flex-1 overflow-hidden',
              devtoolsDock === 'left'
                ? 'flex-row-reverse'
                : devtoolsDock === 'right'
                  ? 'flex-row'
                  : 'flex-col',
            )}
          >
            {viewportNode}
            {splitterNode}
            {devtoolsNode}
          </div>
        );
      })()}
    </div>
  );
}

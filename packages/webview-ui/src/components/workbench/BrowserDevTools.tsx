/**
 * 内置浏览器开发者工具面板（BrowserDevTools）：
 * - 支持停靠在左侧 / 底部 / 右侧，并可拖动分隔条调整尺寸；
 * - Elements：DOM 元素选中调试（祖先面包屑、子节点钻取、盒模型、实时行内样式编辑、计算样式、属性与 OuterHTML）；
 * - Console：分级日志过滤、清空与实时 JS 表达式求值 REPL（支持上下键历史）；
 * - Network：实时网络请求捕获、类型/关键字筛选、Headers / Payload / Response（按需拉取并格式化 JSON）与复制 cURL。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { BrowserConsoleEntry, BrowserDomElement, BrowserNetworkEntry } from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import type { BrowserConsoleObjectEvent, BrowserNetworkBodyEvent } from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import { BrowserConsole } from './BrowserConsole.tsx';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  EyeIcon,
  InspectIcon,
  NetworkIcon,
  PanelBottomIcon,
  PanelRightIcon,
  SearchIcon,
  SidebarIcon,
  TargetIcon,
  TerminalIcon,
  TrashIcon,
} from '../icons.tsx';

export type BrowserDevToolsTab = 'elements' | 'console' | 'network';
export type BrowserDevToolsDock = 'bottom' | 'left' | 'right';

type NetworkTypeFilter = 'all' | 'fetch' | 'doc' | 'js' | 'css' | 'img';
type NetworkDetailTab = 'headers' | 'payload' | 'response';

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function shortUrlName(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.at(-1) || parsed.hostname;
    return parsed.search ? `${last}${parsed.search}` : last;
  } catch {
    return rawUrl;
  }
}

function matchNetworkType(entry: BrowserNetworkEntry, filter: NetworkTypeFilter): boolean {
  if (filter === 'all') return true;
  const rt = entry.resourceType.toLowerCase();
  if (filter === 'fetch') return rt === 'fetch' || rt === 'xhr';
  if (filter === 'doc') return rt === 'document';
  if (filter === 'js') return rt === 'script';
  if (filter === 'css') return rt === 'stylesheet';
  if (filter === 'img') return rt === 'image' || rt === 'media' || rt === 'font';
  return true;
}

function buildCurlCommand(entry: BrowserNetworkEntry): string {
  const esc = (s: string) => `'${s.replace(/'/gu, "'\\''")}'`;
  const parts = [`curl -X ${entry.method} ${esc(entry.url)}`];
  if (entry.requestHeaders) {
    for (const [k, v] of Object.entries(entry.requestHeaders)) {
      if (k.startsWith(':')) continue;
      parts.push(`-H ${esc(`${k}: ${v}`)}`);
    }
  }
  if (entry.postData) {
    parts.push(`--data-raw ${esc(entry.postData)}`);
  }
  return parts.join(' \\\n  ');
}

function formatMaybeJson(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

export interface BrowserDevToolsProps {
  readonly tab: BrowserDevToolsTab;
  readonly onTabChange: (tab: BrowserDevToolsTab) => void;
  readonly dock: BrowserDevToolsDock;
  readonly onDockChange: (dock: BrowserDevToolsDock) => void;
  readonly onClose: () => void;
  readonly size: number;
  readonly running: boolean;
  readonly readOnly: boolean;
  readonly inspectMode: boolean;
  readonly onToggleInspect: () => void;
  readonly selectedElement?: BrowserDomElement;
  readonly highlightVisible: boolean;
  readonly onToggleHighlight: () => void;
  readonly consoleLogs: readonly BrowserConsoleEntry[];
  readonly preserveConsoleLog?: boolean;
  readonly consoleObjects?: Readonly<Record<string, BrowserConsoleObjectEvent>>;
  readonly onRequestConsoleObject?: (objectId: string) => void;
  readonly networkRequests: readonly BrowserNetworkEntry[];
  readonly networkBodies: Readonly<Record<string, BrowserNetworkBodyEvent>>;
}

export function BrowserDevTools({
  tab,
  onTabChange,
  dock,
  onDockChange,
  onClose,
  size,
  running,
  readOnly,
  inspectMode,
  onToggleInspect,
  selectedElement,
  highlightVisible,
  onToggleHighlight,
  consoleLogs,
  preserveConsoleLog = false,
  consoleObjects = EMPTY_CONSOLE_OBJECTS,
  onRequestConsoleObject = NOOP_REQUEST_CONSOLE_OBJECT,
  networkRequests,
  networkBodies,
}: BrowserDevToolsProps) {
  const t = useT();
  const errorCount = consoleLogs.filter((entry) => entry.level === 'error').length;
  const warnCount = consoleLogs.filter((entry) => entry.level === 'warn').length;
  const isSide = dock === 'left' || dock === 'right';

  const borderClass =
    dock === 'left'
      ? 'border-r border-sidebar-border'
      : dock === 'right'
        ? 'border-l border-sidebar-border'
        : 'border-t border-sidebar-border';

  return (
    <div
      data-testid="browser-devtools-panel"
      data-dock={dock}
      style={isSide ? { width: `${size}px` } : { height: `${size}px` }}
      className={cn('flex shrink-0 flex-col overflow-hidden bg-sidebar', borderClass)}
    >
      {/* 顶栏：拾取元素 + Elements/Console/Network 标签 + 停靠位置切换（左/下/右） + 关闭 */}
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as BrowserDevToolsTab)}
        className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
      >
        <div className="flex shrink-0 items-center justify-between gap-1 border-b border-line/70 px-1.5 py-1">
          <div className="flex min-w-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="devtools-inspect-btn"
              aria-label={t('wb.browser.inspect')}
              title={t('wb.browser.inspect')}
              aria-pressed={inspectMode}
              disabled={!running || readOnly}
              onClick={onToggleInspect}
              className={cn(
                'shrink-0 text-ink-2 hover:bg-hover hover:text-ink',
                inspectMode && 'bg-accent-tint text-accent-ink hover:bg-accent-tint',
              )}
            >
              <InspectIcon className="size-3.5" />
            </Button>

            <TabsList variant="line" className="tabs h-6 min-w-0 justify-start gap-0.5 overflow-x-auto overflow-y-hidden p-0">
              <TabsTrigger
                value="elements"
                data-testid="devtools-tab-elements"
                className="h-6 flex-none gap-1 rounded-none px-1.5 text-[11px] after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <CodeIcon className="size-3 shrink-0" />
                <span>{t('wb.browser.devtools.elements')}</span>
              </TabsTrigger>
              <TabsTrigger
                value="console"
                data-testid="devtools-tab-console"
                className="h-6 flex-none gap-1 rounded-none px-1.5 text-[11px] after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <TerminalIcon className="size-3 shrink-0" />
                <span>{t('wb.browser.devtools.console')}</span>
                {errorCount > 0 ? (
                  <span className="rounded-full bg-red-tint px-1 font-mono text-[10px] font-medium text-red tabular-nums">
                    {errorCount}
                  </span>
                ) : warnCount > 0 ? (
                  <span className="rounded-full bg-orange-tint px-1 font-mono text-[10px] font-medium text-orange tabular-nums">
                    {warnCount}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger
                value="network"
                data-testid="devtools-tab-network"
                className="h-6 flex-none gap-1 rounded-none px-1.5 text-[11px] after:bg-brand group-data-[orientation=horizontal]/tabs:after:bottom-0"
              >
                <NetworkIcon className="size-3 shrink-0" />
                <span>{t('wb.browser.devtools.network')}</span>
                {networkRequests.length > 0 ? (
                  <span className="rounded-full bg-field px-1 font-mono text-[10px] text-ink-3 tabular-nums">
                    {networkRequests.length}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="devtools-dock-left"
              aria-label={t('wb.browser.devtools.dockLeft')}
              title={t('wb.browser.devtools.dockLeft')}
              aria-pressed={dock === 'left'}
              onClick={() => onDockChange('left')}
              className={cn(
                'text-ink-3 hover:bg-hover hover:text-ink',
                dock === 'left' && 'bg-hover text-ink',
              )}
            >
              <SidebarIcon className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="devtools-dock-bottom"
              aria-label={t('wb.browser.devtools.dockBottom')}
              title={t('wb.browser.devtools.dockBottom')}
              aria-pressed={dock === 'bottom'}
              onClick={() => onDockChange('bottom')}
              className={cn(
                'text-ink-3 hover:bg-hover hover:text-ink',
                dock === 'bottom' && 'bg-hover text-ink',
              )}
            >
              <PanelBottomIcon className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="devtools-dock-right"
              aria-label={t('wb.browser.devtools.dockRight')}
              title={t('wb.browser.devtools.dockRight')}
              aria-pressed={dock === 'right'}
              onClick={() => onDockChange('right')}
              className={cn(
                'text-ink-3 hover:bg-hover hover:text-ink',
                dock === 'right' && 'bg-hover text-ink',
              )}
            >
              <PanelRightIcon className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="devtools-close-btn"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={onClose}
              className="text-ink-3 hover:bg-hover hover:text-ink"
            >
              <CloseIcon className="size-3" />
            </Button>
          </div>
        </div>

        <TabsContent value="elements" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
          <ElementsPane
            element={selectedElement}
            running={running}
            readOnly={readOnly}
            inspectMode={inspectMode}
            highlightVisible={highlightVisible}
            onToggleInspect={onToggleInspect}
            onToggleHighlight={onToggleHighlight}
          />
        </TabsContent>

        <TabsContent value="console" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
          <BrowserConsole
            logs={consoleLogs}
            preserveLog={preserveConsoleLog}
            running={running}
            readOnly={readOnly}
            {...(selectedElement ? { selectedElement } : {})}
            consoleObjects={consoleObjects}
            onRequestConsoleObject={onRequestConsoleObject}
          />
        </TabsContent>

        <TabsContent value="network" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden">
          <NetworkPane requests={networkRequests} bodies={networkBodies} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ElementsPane({
  element,
  running,
  readOnly,
  inspectMode,
  highlightVisible,
  onToggleInspect,
  onToggleHighlight,
}: {
  readonly element?: BrowserDomElement;
  readonly running: boolean;
  readonly readOnly: boolean;
  readonly inspectMode: boolean;
  readonly highlightVisible: boolean;
  readonly onToggleInspect: () => void;
  readonly onToggleHighlight: () => void;
}) {
  const t = useT();
  const [styleProp, setStyleProp] = useState('');
  const [styleVal, setStyleVal] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const [childrenOpen, setChildrenOpen] = useState(true);
  const [copiedKey, setCopiedKey] = useState<'selector' | 'html' | null>(null);

  const copy = (key: 'selector' | 'html', value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1_500);
  };

  if (!element) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-4 py-6 text-center" data-testid="devtools-elements-empty">
        <p className="m-0 max-w-60 text-[11.5px] leading-relaxed text-ink-3">{t('wb.browser.inspectHint')}</p>
        <Button
          type="button"
          size="xs"
          variant={inspectMode ? 'secondary' : 'outline'}
          disabled={!running || readOnly}
          onClick={onToggleInspect}
        >
          <InspectIcon className="size-3" />
          <span>{t('wb.browser.inspectStart')}</span>
        </Button>
      </div>
    );
  }

  const applyStyle = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || !running) return;
    const prop = styleProp.trim();
    if (!prop) return;
    postToHost({
      type: 'browserEditElementStyle',
      payload: { selector: element.selector, property: prop, value: styleVal.trim() },
    });
  };

  const styleEntries = Object.entries(element.computedStyles).filter(([k, v]) => {
    const q = styleFilter.trim().toLowerCase();
    if (!q) return true;
    return k.toLowerCase().includes(q) || v.toLowerCase().includes(q);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="devtools-elements-pane">
      {/* 祖先路径面包屑 */}
      {element.ancestors.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line/50 bg-inset/40 px-2 py-1 font-mono text-[10.5px]">
          {element.ancestors.map((anc) => (
            <span key={anc.selector} className="inline-flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => postToHost({ type: 'browserSelectElement', payload: { selector: anc.selector } })}
                className="rounded px-1 py-0.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
              >
                {anc.label}
              </button>
              <ChevronRightIcon className="size-2.5 text-ink-4" />
            </span>
          ))}
          <span className="rounded bg-accent-tint/70 px-1 py-0.5 font-medium text-accent-ink">{element.label}</span>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2.5 px-2.5 py-2 text-[11.5px]">
        {/* 当前节点标题与快捷操作 */}
        <div className="flex items-start justify-between gap-1.5 rounded-lg border border-line/60 bg-surface/80 px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11.5px] font-semibold text-accent-ink" title={element.selector}>
              &lt;{element.label}&gt;
            </div>
            <div className="truncate font-mono text-[10px] text-ink-3 tabular-nums">
              {element.rect.width} × {element.rect.height} · ({element.rect.x}, {element.rect.y})
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('wb.browser.inspectCopySelector')}
              title={t('wb.browser.inspectCopySelector')}
              onClick={() => copy('selector', element.selector)}
            >
              {copiedKey === 'selector' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('wb.browser.inspectScroll')}
              title={t('wb.browser.inspectScroll')}
              disabled={!running || readOnly}
              onClick={() =>
                postToHost({
                  type: 'browserSelectElement',
                  payload: { selector: element.selector, scrollIntoView: true },
                })
              }
            >
              <TargetIcon className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('wb.browser.inspectClearHighlight')}
              title={t('wb.browser.inspectClearHighlight')}
              aria-pressed={highlightVisible}
              onClick={onToggleHighlight}
              className={cn(highlightVisible && 'bg-accent-tint/60 text-accent-ink')}
            >
              <EyeIcon className="size-3" />
            </Button>
          </div>
        </div>

        {/* 子节点钻取 */}
        {element.children.length > 0 ? (
          <div className="rounded-lg border border-line/60 bg-inset/35">
            <button
              type="button"
              onClick={() => setChildrenOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-medium text-ink-2 hover:text-ink"
            >
              {childrenOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
              <span>{t('wb.browser.inspectChildren', element.children.length)}</span>
            </button>
            {childrenOpen ? (
              <div className="max-h-28 overflow-y-auto border-t border-line/50 p-1">
                {element.children.map((child) => (
                  <button
                    key={child.selector}
                    type="button"
                    onClick={() => postToHost({ type: 'browserSelectElement', payload: { selector: child.selector } })}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left font-mono text-[10.5px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                  >
                    <span className="shrink-0 text-accent-ink">&lt;{child.label}&gt;</span>
                    {child.textPreview ? <span className="min-w-0 flex-1 truncate text-ink-3">{child.textPreview}</span> : null}
                    {child.childCount > 0 ? (
                      <span className="shrink-0 text-[10px] text-ink-3 tabular-nums">({child.childCount})</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 盒模型 */}
        {element.boxModel ? (
          <div className="space-y-1">
            <div className="text-[10.5px] font-medium text-ink-3">{t('wb.browser.inspectBoxModel')}</div>
            <div className="rounded-lg border border-dashed border-orange/45 bg-orange-tint/30 p-1.5 text-center font-mono text-[10px] tabular-nums">
              <div className="flex items-center justify-between px-1 text-ink-3">
                <span>margin</span>
                <span>{element.boxModel.margin[0]}</span>
                <span />
              </div>
              <div className="my-0.5 flex items-center gap-1">
                <span className="w-5 text-ink-3">{element.boxModel.margin[3]}</span>
                <div className="flex-1 rounded border border-green/45 bg-green-tint/30 p-1.5">
                  <div className="flex items-center justify-between px-1 text-ink-3">
                    <span>padding</span>
                    <span>{element.boxModel.padding[0]}</span>
                    <span />
                  </div>
                  <div className="my-0.5 flex items-center gap-1">
                    <span className="w-5 text-ink-3">{element.boxModel.padding[3]}</span>
                    <div className="flex-1 rounded border border-accent/45 bg-accent-tint/50 px-2 py-1 font-medium text-accent-ink">
                      {element.rect.width} × {element.rect.height}
                    </div>
                    <span className="w-5 text-ink-3">{element.boxModel.padding[1]}</span>
                  </div>
                  <div className="text-ink-3">{element.boxModel.padding[2]}</div>
                </div>
                <span className="w-5 text-ink-3">{element.boxModel.margin[1]}</span>
              </div>
              <div className="text-ink-3">{element.boxModel.margin[2]}</div>
            </div>
          </div>
        ) : null}

        {/* 实时行内样式编辑 + 计算样式 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-medium text-ink-3">{t('wb.browser.inspectStyles')}</span>
            <Input
              size="xs"
              value={styleFilter}
              onChange={(e) => setStyleFilter(e.target.value)}
              placeholder={t('wb.browser.inspectStyles')}
              aria-label={t('wb.browser.inspectStyles')}
              className="w-28 bg-surface/80 font-mono text-[10.5px]"
            />
          </div>

          <form onSubmit={applyStyle} className="flex items-center gap-1" data-testid="devtools-style-form">
            <Input
              size="xs"
              data-testid="devtools-style-prop"
              value={styleProp}
              onChange={(e) => setStyleProp(e.target.value)}
              placeholder={t('wb.browser.inspectAddStyleProp')}
              disabled={!running || readOnly}
              className="min-w-0 flex-1 bg-surface/90 font-mono text-[11px]"
            />
            <Input
              size="xs"
              data-testid="devtools-style-val"
              value={styleVal}
              onChange={(e) => setStyleVal(e.target.value)}
              placeholder={t('wb.browser.inspectAddStyleVal')}
              disabled={!running || readOnly}
              className="min-w-0 flex-1 bg-surface/90 font-mono text-[11px]"
            />
            <Button type="submit" size="xs" variant="secondary" disabled={!running || readOnly || !styleProp.trim()}>
              {t('wb.browser.inspectApplyStyle')}
            </Button>
          </form>

          <div className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/60 bg-surface/60 font-mono text-[10.5px]">
            {styleEntries.map(([prop, val]) => (
              <button
                key={prop}
                type="button"
                onClick={() => {
                  setStyleProp(prop);
                  setStyleVal(val);
                }}
                className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-left transition-colors hover:bg-hover"
              >
                <span className="shrink-0 text-ink-2">{prop}</span>
                <span className="min-w-0 truncate text-ink">{val}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 属性列表 */}
        {element.attributes.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[10.5px] font-medium text-ink-3">{t('wb.browser.inspectAttributes')}</div>
            <div className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/60 bg-surface/60 font-mono text-[10.5px]">
              {element.attributes.map((attr) => (
                <div key={attr.name} className="flex items-start gap-2 px-2 py-0.5">
                  <span className="shrink-0 text-accent-ink">{attr.name}</span>
                  <span className="min-w-0 flex-1 break-all text-ink-2">{attr.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* OuterHTML 预览 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10.5px] font-medium text-ink-3">{t('wb.browser.inspectOuterHtml')}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => copy('html', element.outerHtml)}
              className="text-ink-3 hover:text-ink"
            >
              {copiedKey === 'html' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
              <span>{t('wb.browser.inspectCopyHtml')}</span>
            </Button>
          </div>
          <pre className="m-0 max-h-32 overflow-auto rounded-lg border border-line/60 bg-inset/70 p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-ink-2">
            {element.outerHtml}
          </pre>
        </div>
        </div>
      </ScrollArea>
    </div>
  );
}

const EMPTY_CONSOLE_OBJECTS: Readonly<Record<string, BrowserConsoleObjectEvent>> = {};
const NOOP_REQUEST_CONSOLE_OBJECT = (): void => undefined;

function NetworkPane({
  requests,
  bodies,
}: {
  readonly requests: readonly BrowserNetworkEntry[];
  readonly bodies: Readonly<Record<string, BrowserNetworkBodyEvent>>;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<NetworkTypeFilter>('all');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detailTab, setDetailTab] = useState<NetworkDetailTab>('headers');
  const [copiedKey, setCopiedKey] = useState<'url' | 'curl' | 'body' | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests.filter((entry) => {
      if (!matchNetworkType(entry, typeFilter)) return false;
      if (!q) return true;
      return (
        entry.url.toLowerCase().includes(q) ||
        entry.method.toLowerCase().includes(q) ||
        String(entry.status ?? '').includes(q)
      );
    });
  }, [requests, query, typeFilter]);

  const selected = useMemo(
    () => (selectedId ? requests.find((r) => r.requestId === selectedId) : undefined),
    [requests, selectedId],
  );

  const selectedBody = selected ? bodies[selected.requestId] : undefined;

  useEffect(() => {
    if (selected && detailTab === 'response' && !selectedBody) {
      postToHost({ type: 'browserGetNetworkBody', payload: { requestId: selected.requestId } });
    }
  }, [selected, detailTab, selectedBody]);

  const copyText = (key: 'url' | 'curl' | 'body', text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1_500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="devtools-network-pane">
      {/* 顶部筛选栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line/50 px-2 py-1">
        <div className="relative min-w-28 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-3" />
          <Input
            size="xs"
            data-testid="devtools-network-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('wb.browser.networkFilterPlaceholder')}
            aria-label={t('wb.browser.networkFilterPlaceholder')}
            className="bg-surface/80 pl-6 font-mono text-[11px]"
          />
        </div>
        <div className="flex items-center gap-0.5">
          {([
            ['all', t('wb.browser.networkAll')],
            ['fetch', 'Fetch/XHR'],
            ['doc', 'Doc'],
            ['js', 'JS'],
            ['css', 'CSS'],
            ['img', 'Img'],
          ] as const).map(([key, label]) => (
            <Button
              key={key}
              type="button"
              variant="ghost"
              size="xs"
              data-testid={`devtools-network-type-${key}`}
              onClick={() => setTypeFilter(key)}
              className={cn(
                'px-1.5 text-[10.5px]',
                typeFilter === key ? 'bg-hover font-medium text-ink' : 'text-ink-3 hover:text-ink',
              )}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('wb.browser.networkClear')}
          title={t('wb.browser.networkClear')}
          onClick={() => {
            setSelectedId(undefined);
            postToHost({ type: 'browserClearNetwork', payload: {} });
          }}
          className="text-ink-3 hover:bg-hover hover:text-ink"
        >
          <TrashIcon className="size-3" />
        </Button>
      </div>

      {/* 请求列表 */}
      <ScrollArea className={cn('min-h-0 flex-1 font-mono text-[11px]', selected && 'max-h-[45%] border-b border-line/70')}>
        {filtered.length === 0 ? (
          <div className="py-6 text-center font-sans text-[11.5px] text-ink-3">{t('wb.browser.networkEmpty')}</div>
        ) : (
          filtered.map((entry) => {
            const isSelected = entry.requestId === selectedId;
            const statusColor = entry.failed || (entry.status !== undefined && entry.status >= 400)
              ? 'text-red'
              : entry.status !== undefined && entry.status >= 300
                ? 'text-accent-ink'
                : entry.status !== undefined
                  ? 'text-green'
                  : 'text-ink-3';
            return (
              <button
                key={entry.requestId}
                type="button"
                data-testid={`devtools-network-row-${entry.requestId}`}
                title={entry.url}
                onClick={() => setSelectedId(entry.requestId)}
                className={cn(
                  'flex w-full items-center gap-1.5 border-b border-line/40 px-2 py-1 text-left transition-colors hover:bg-hover',
                  isSelected && 'bg-accent-tint/55',
                )}
              >
                <span className="w-10 shrink-0 text-[10px] font-semibold text-ink-2">{entry.method}</span>
                <span className={cn('w-9 shrink-0 text-[10.5px] font-medium tabular-nums', statusColor)}>
                  {entry.failed ? 'ERR' : entry.status ?? '…'}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">{shortUrlName(entry.url)}</span>
                <span className="hidden shrink-0 text-[10px] text-ink-3 sm:inline">{entry.resourceType}</span>
                <span className="w-14 shrink-0 text-right text-[10px] text-ink-3 tabular-nums">
                  {entry.fromCache ? 'cache' : formatBytes(entry.encodedDataLength)}
                </span>
                <span className="w-12 shrink-0 text-right text-[10px] text-ink-3 tabular-nums">
                  {formatDuration(entry.durationMs)}
                </span>
              </button>
            );
          })
        )}
      </ScrollArea>

      {/* 选中请求详情区：Headers / Payload / Response */}
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface/50" data-testid="devtools-network-detail">
          <div className="flex shrink-0 items-center justify-between gap-1 border-b border-line/60 px-2 py-1">
            <div className="flex items-center gap-0.5">
              {([
                ['headers', t('wb.browser.networkHeaders')],
                ['payload', t('wb.browser.networkPayload')],
                ['response', t('wb.browser.networkResponse')],
              ] as const).map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid={`devtools-network-detail-${key}`}
                  onClick={() => setDetailTab(key)}
                  className={cn(
                    'px-1.5 text-[10.5px]',
                    detailTab === key ? 'bg-hover font-medium text-ink' : 'text-ink-3 hover:text-ink',
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => copyText('url', selected.url)}
                className="px-1.5 text-[10.5px] text-ink-3 hover:text-ink"
              >
                {copiedKey === 'url' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                <span>{t('wb.browser.networkCopyUrl')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => copyText('curl', buildCurlCommand(selected))}
                className="px-1.5 text-[10.5px] text-ink-3 hover:text-ink"
              >
                {copiedKey === 'curl' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                <span>{t('wb.browser.networkCopyCurl')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('common.close')}
                onClick={() => setSelectedId(undefined)}
                className="text-ink-3 hover:text-ink"
              >
                <CloseIcon className="size-3" />
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2 font-mono text-[10.5px]">
            {detailTab === 'headers' ? (
              <div className="space-y-2.5">
                <div>
                  <div className="mb-1 font-sans text-[10.5px] font-medium text-ink-3">{t('wb.browser.networkGeneral')}</div>
                  <div className="space-y-0.5 rounded-lg border border-line/60 bg-inset/50 p-2 break-all">
                    <div><span className="text-ink-3">URL: </span><span className="text-ink">{selected.url}</span></div>
                    <div><span className="text-ink-3">Method: </span><span className="text-ink">{selected.method}</span></div>
                    <div>
                      <span className="text-ink-3">Status: </span>
                      <span className={cn(selected.failed || (selected.status && selected.status >= 400) ? 'text-red' : 'text-green')}>
                        {selected.failed ? selected.errorText || 'Failed' : `${selected.status ?? 'Pending'} ${selected.statusText ?? ''}`}
                      </span>
                    </div>
                    {selected.mimeType ? <div><span className="text-ink-3">Type: </span><span className="text-ink">{selected.mimeType}</span></div> : null}
                  </div>
                </div>
                {selected.responseHeaders && Object.keys(selected.responseHeaders).length > 0 ? (
                  <div>
                    <div className="mb-1 font-sans text-[10.5px] font-medium text-ink-3">{t('wb.browser.networkResHeaders')}</div>
                    <div className="space-y-0.5 rounded-lg border border-line/60 bg-inset/50 p-2 break-all">
                      {Object.entries(selected.responseHeaders).map(([k, v]) => (
                        <div key={k}><span className="text-accent-ink">{k}: </span><span className="text-ink-2">{v}</span></div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {selected.requestHeaders && Object.keys(selected.requestHeaders).length > 0 ? (
                  <div>
                    <div className="mb-1 font-sans text-[10.5px] font-medium text-ink-3">{t('wb.browser.networkReqHeaders')}</div>
                    <div className="space-y-0.5 rounded-lg border border-line/60 bg-inset/50 p-2 break-all">
                      {Object.entries(selected.requestHeaders).map(([k, v]) => (
                        <div key={k}><span className="text-accent-ink">{k}: </span><span className="text-ink-2">{v}</span></div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : detailTab === 'payload' ? (
              selected.postData ? (
                <pre className="m-0 overflow-auto rounded-lg border border-line/60 bg-inset/60 p-2 leading-relaxed whitespace-pre-wrap break-all text-ink">
                  {formatMaybeJson(selected.postData)}
                </pre>
              ) : (
                <div className="py-4 text-center font-sans text-[11px] text-ink-3">{t('wb.browser.networkNoPayload')}</div>
              )
            ) : !selectedBody ? (
              <div className="py-4 text-center font-sans text-[11px] text-ink-3">{t('wb.browser.networkLoadingBody')}</div>
            ) : selectedBody.error ? (
              <div className="rounded-lg border border-red/25 bg-red-tint/60 p-2 text-red">{selectedBody.error}</div>
            ) : selectedBody.base64Encoded ? (
              <div className="py-4 text-center font-sans text-[11px] text-ink-3">
                {t('wb.browser.networkBinaryBody', selectedBody.body?.length ?? 0)}
              </div>
            ) : selectedBody.body ? (
              <div className="space-y-1.5">
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => copyText('body', selectedBody.body ?? '')}
                    className="text-ink-3 hover:text-ink"
                  >
                    {copiedKey === 'body' ? <CheckIcon className="size-3 text-green" /> : <CopyIcon className="size-3" />}
                    <span>{t('wb.browser.networkCopyBody')}</span>
                  </Button>
                </div>
                <pre
                  data-testid="devtools-network-response-body"
                  className="m-0 overflow-auto rounded-lg border border-line/60 bg-inset/60 p-2 leading-relaxed whitespace-pre-wrap break-all text-ink"
                >
                  {formatMaybeJson(selectedBody.body)}
                </pre>
              </div>
            ) : (
              <div className="py-4 text-center font-sans text-[11px] text-ink-3">{t('wb.browser.networkNoBody')}</div>
            )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}

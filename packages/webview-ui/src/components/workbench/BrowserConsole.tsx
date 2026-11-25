/**
 * 对标 Chrome DevTools 的内置浏览器控制台（BrowserConsole）：
 * - 工具栏：清空（BanIcon / Ctrl+L / Cmd+K）、过滤输入（支持 `-排除` 与正则 `.*`）、
 *   级别多选筛选（Errors / Warnings / Info / Verbose）、错误/警告计数快捷过滤、设置弹层（Preserve log / 时间戳 / 合并重复）；
 * - 日志流：分组折叠（group / groupCollapsed）、连续重复计数徽标、`%c` 安全样式渲染、`console.table` 表格、
 *   可展开调用栈、可懒加载任意层级的 RemoteObject 对象树、右键上下文菜单与智能贴底滚动；
 * - 多行 REPL：Enter 执行、Shift+Enter 换行、首尾行历史上下键回溯、`$0` 当前元素联动、无副作用属性补全弹窗。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  BrowserConsoleArg,
  BrowserConsoleEntry,
  BrowserConsoleProperty,
  BrowserConsoleStackFrame,
  BrowserDomElement,
} from '@harness-deck/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useT } from '../../i18n.ts';
import { cn } from '../../lib/utils.ts';
import {
  subscribeBrowserConsoleCompletions,
  type BrowserConsoleObjectEvent,
} from '../../store.ts';
import { postToHost } from '../../vscode.ts';
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleXIcon,
  CloseIcon,
  CopyIcon,
  CornerDownLeftIcon,
  InfoIcon,
  RegexIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
} from '../icons.tsx';

export interface ConsoleLevelVisibility {
  readonly verbose: boolean;
  readonly info: boolean;
  readonly warn: boolean;
  readonly error: boolean;
}

const DEFAULT_LEVELS: ConsoleLevelVisibility = {
  verbose: false,
  info: true,
  warn: true,
  error: true,
};

const ALL_LEVELS: ConsoleLevelVisibility = {
  verbose: true,
  info: true,
  warn: true,
  error: true,
};

const COMPLETION_DEBOUNCE_MS = 80;
const BOTTOM_STICK_THRESHOLD_PX = 32;

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function shortSourceLabel(frame: BrowserConsoleStackFrame | undefined): string | undefined {
  if (!frame) return undefined;
  const raw = frame.url.trim();
  let file = raw;
  if (raw) {
    try {
      const parsed = new URL(raw);
      const last = parsed.pathname.split('/').filter(Boolean).pop();
      file = last || parsed.hostname || raw;
    } catch {
      file = raw.split(/[\\/]/u).pop() || raw;
    }
  } else {
    file = '<anonymous>';
  }
  return frame.lineNumber > 0 ? `${file}:${frame.lineNumber}` : file;
}

function fullSourceTooltip(frame: BrowserConsoleStackFrame | undefined): string | undefined {
  if (!frame) return undefined;
  const base = frame.url || '<anonymous>';
  if (frame.lineNumber <= 0) return base;
  return frame.columnNumber > 0 ? `${base}:${frame.lineNumber}:${frame.columnNumber}` : `${base}:${frame.lineNumber}`;
}

function formatStackText(frames: readonly BrowserConsoleStackFrame[]): string {
  return frames
    .map((f) => {
      const loc = f.url ? `${f.url}:${f.lineNumber}:${f.columnNumber}` : `:${f.lineNumber}:${f.columnNumber}`;
      return `    at ${f.functionName || '(anonymous)'} (${loc})`;
    })
    .join('\n');
}

function matchesLevel(entry: BrowserConsoleEntry, vis: ConsoleLevelVisibility): boolean {
  if (entry.level === 'error') return vis.error;
  if (entry.level === 'warn') return vis.warn;
  if (entry.level === 'debug') return vis.verbose;
  return vis.info;
}

interface ParsedFilter {
  readonly regex?: RegExp;
  readonly regexError: boolean;
  readonly includeTerms: readonly string[];
  readonly excludeTerms: readonly string[];
}

function parseFilter(query: string, regexMode: boolean): ParsedFilter {
  const trimmed = query.trim();
  if (!trimmed) {
    return { regexError: false, includeTerms: [], excludeTerms: [] };
  }
  if (regexMode) {
    try {
      return { regex: new RegExp(trimmed, 'iu'), regexError: false, includeTerms: [], excludeTerms: [] };
    } catch {
      return { regexError: true, includeTerms: [], excludeTerms: [] };
    }
  }
  const includeTerms: string[] = [];
  const excludeTerms: string[] = [];
  for (const token of trimmed.split(/\s+/u)) {
    if (token.startsWith('-') && token.length > 1) {
      excludeTerms.push(token.slice(1).toLowerCase());
    } else {
      includeTerms.push(token.toLowerCase());
    }
  }
  return { regexError: false, includeTerms, excludeTerms };
}

function entryMatchesFilter(entry: BrowserConsoleEntry, filter: ParsedFilter): boolean {
  if (filter.regexError) return false;
  if (!filter.regex && filter.includeTerms.length === 0 && filter.excludeTerms.length === 0) {
    return true;
  }
  const tableText = entry.table
    ? `${entry.table.columns.join(' ')} ${entry.table.rows.map((r) => Object.values(r).join(' ')).join(' ')}`
    : '';
  if (filter.regex) {
    return (
      filter.regex.test(entry.text) ||
      (entry.source?.url ? filter.regex.test(entry.source.url) : false) ||
      (tableText ? filter.regex.test(tableText) : false)
    );
  }
  const lower = `${entry.text} ${entry.source?.url ?? ''} ${tableText}`.toLowerCase();
  for (const inc of filter.includeTerms) {
    if (!lower.includes(inc)) return false;
  }
  for (const exc of filter.excludeTerms) {
    if (lower.includes(exc)) return false;
  }
  return true;
}

function isExpandableArg(arg: BrowserConsoleArg): boolean {
  return Boolean(arg.objectId || (arg.preview && arg.preview.length > 0));
}

function inlineArgSummary(arg: BrowserConsoleArg): string {
  if (arg.type === 'function') {
    const desc = (arg.description ?? 'ƒ ()').replace(/\s+/gu, ' ').trim();
    return desc.length > 72 ? `${desc.slice(0, 69)}…` : desc;
  }
  if (arg.preview && arg.preview.length > 0) {
    if (arg.subtype === 'array') {
      const head = arg.description && arg.description !== 'Array' ? `${arg.description} ` : '';
      return `${head}[${arg.preview.filter((p) => /^\d+$/u.test(p.name)).map((p) => (p.value.type === 'string' ? JSON.stringify(p.value.value ?? '') : p.value.description ?? String(p.value.value ?? p.value.type))).join(', ')}${arg.overflow ? ', …' : ''}]`;
    }
    const pairs = arg.preview.map((p) => {
      const valStr = p.value.type === 'string' ? JSON.stringify(p.value.value ?? '') : (p.value.description ?? String(p.value.value ?? p.value.type));
      return p.name.endsWith('=>') ? `${p.name} ${valStr}` : `${p.name}: ${valStr}`;
    });
    const prefix = arg.className && arg.className !== 'Object' ? `${arg.className} ` : '';
    return `${prefix}{${pairs.join(', ')}${arg.overflow ? ', …' : ''}}`;
  }
  return arg.description || arg.className || arg.subtype || 'Object';
}

function ConsoleValueNode({
  arg,
  quoted = false,
  consoleObjects,
  onRequestObject,
  depth = 0,
}: {
  readonly arg: BrowserConsoleArg;
  readonly quoted?: boolean;
  readonly consoleObjects: Readonly<Record<string, BrowserConsoleObjectEvent>>;
  readonly onRequestObject: (objectId: string) => void;
  readonly depth?: number;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (arg.type === 'undefined') {
    return <span className="text-[var(--console-null)]">undefined</span>;
  }
  if (arg.subtype === 'null' || arg.value === null) {
    return <span className="text-[var(--console-null)]">null</span>;
  }
  if (arg.type === 'string') {
    const str = typeof arg.value === 'string' ? arg.value : (arg.description ?? '');
    if (quoted) {
      return <span className="text-[var(--console-string)]">{JSON.stringify(str)}</span>;
    }
    return <span className="whitespace-pre-wrap">{str}</span>;
  }
  if (arg.type === 'number' || arg.type === 'bigint') {
    return <span className="text-[var(--console-number)]">{arg.description ?? String(arg.value ?? 'NaN')}</span>;
  }
  if (arg.type === 'boolean') {
    return <span className="text-[var(--console-keyword)]">{String(arg.value ?? arg.description ?? false)}</span>;
  }
  if (arg.type === 'symbol') {
    return <span className="text-[var(--console-string)]">{arg.description ?? 'Symbol()'}</span>;
  }

  const expandable = isExpandableArg(arg) && depth < 10;
  const loadedObj = arg.objectId ? consoleObjects[arg.objectId] : undefined;
  const props: readonly BrowserConsoleProperty[] | undefined = loadedObj?.properties ?? arg.preview;
  const loading = expanded && Boolean(arg.objectId) && !loadedObj && !arg.preview;

  const toggleExpand = () => {
    if (!expandable) return;
    const next = !expanded;
    setExpanded(next);
    if (next && arg.objectId && !loadedObj) {
      onRequestObject(arg.objectId);
    }
  };

  if (!expandable) {
    return (
      <span
        className={cn(
          arg.type === 'function'
            ? 'italic text-[var(--console-keyword)]'
            : arg.subtype === 'node'
              ? 'text-[var(--console-node)]'
              : 'text-ink-2',
        )}
      >
        {inlineArgSummary(arg)}
      </span>
    );
  }

  return (
    <span className="inline-flex max-w-full flex-col align-top">
      <button
        type="button"
        data-testid="console-object-toggle"
        aria-expanded={expanded}
        onClick={toggleExpand}
        className="inline-flex items-start gap-0.5 rounded text-left transition-colors hover:bg-hover/70"
      >
        {expanded ? (
          <ChevronDownIcon className="mt-0.5 size-3 shrink-0 text-ink-3" />
        ) : (
          <ChevronRightIcon className="mt-0.5 size-3 shrink-0 text-ink-3" />
        )}
        <span
          className={cn(
            'break-all whitespace-pre-wrap',
            arg.type === 'function'
              ? 'italic text-[var(--console-keyword)]'
              : arg.subtype === 'node'
                ? 'text-[var(--console-node)]'
                : 'text-ink',
          )}
        >
          {inlineArgSummary(arg)}
        </span>
      </button>

      {expanded ? (
        <div className="mt-0.5 ml-3 border-l border-line/60 pl-2">
          {loading ? (
            <div className="text-[10.5px] text-ink-3 italic">{t('wb.browser.consoleLoadingProps')}</div>
          ) : loadedObj?.error && !props ? (
            <div className="text-[10.5px] text-red">{loadedObj.error}</div>
          ) : props && props.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {props.map((prop, index) => (
                <div key={`${prop.name}:${index}`} className="flex items-start gap-1 leading-4">
                  <span
                    className={cn(
                      'shrink-0',
                      prop.internal ? 'italic text-ink-3' : 'text-[var(--console-key)]',
                    )}
                  >
                    {prop.name}:
                  </span>
                  <ConsoleValueNode
                    arg={prop.value}
                    quoted
                    consoleObjects={consoleObjects}
                    onRequestObject={onRequestObject}
                    depth={depth + 1}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10.5px] text-ink-3 italic">{'{}'}</div>
          )}
        </div>
      ) : null}
    </span>
  );
}

interface DisplayConsoleRow {
  readonly entry: BrowserConsoleEntry;
  readonly repeatCount: number;
}

export interface BrowserConsoleProps {
  readonly logs: readonly BrowserConsoleEntry[];
  readonly preserveLog: boolean;
  readonly running: boolean;
  readonly readOnly: boolean;
  readonly selectedElement?: BrowserDomElement;
  readonly consoleObjects: Readonly<Record<string, BrowserConsoleObjectEvent>>;
  readonly onRequestConsoleObject: (objectId: string) => void;
}

export function BrowserConsole({
  logs,
  preserveLog,
  running,
  readOnly,
  selectedElement,
  consoleObjects,
  onRequestConsoleObject,
}: BrowserConsoleProps) {
  const t = useT();
  const [filterQuery, setFilterQuery] = useState('');
  const [regexMode, setRegexMode] = useState(false);
  const [levels, setLevels] = useState<ConsoleLevelVisibility>(DEFAULT_LEVELS);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [groupSimilar, setGroupSimilar] = useState(true);
  const [hiddenSources, setHiddenSources] = useState<readonly string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<number>>(() => new Set());
  const [expandedStacks, setExpandedStacks] = useState<ReadonlySet<number>>(() => new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);

  const [expr, setExpr] = useState('');
  const [completions, setCompletions] = useState<{ readonly prefix: string; readonly items: readonly string[] }>({
    prefix: '',
    items: [],
  });
  const [completionIdx, setCompletionIdx] = useState(0);

  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const draftRef = useRef('');
  const seenCollapsedGroupIdsRef = useRef<Set<number>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const completionReqSeqRef = useRef(0);
  const activeCompletionReqIdRef = useRef('');
  const suppressCompletionRef = useRef(false);

  // 自动折叠新增的 `console.groupCollapsed` 分组
  useEffect(() => {
    const newlyCollapsed: number[] = [];
    for (const entry of logs) {
      if (
        entry.kind === 'groupCollapsed' &&
        entry.groupId !== undefined &&
        !seenCollapsedGroupIdsRef.current.has(entry.groupId)
      ) {
        seenCollapsedGroupIdsRef.current.add(entry.groupId);
        newlyCollapsed.push(entry.groupId);
      }
    }
    if (newlyCollapsed.length > 0) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        for (const id of newlyCollapsed) next.add(id);
        return next;
      });
    }
  }, [logs]);

  // 订阅异步补全响应
  useEffect(() => {
    return subscribeBrowserConsoleCompletions((event) => {
      if (event.requestId !== activeCompletionReqIdRef.current) return;
      setCompletions({ prefix: event.prefix, items: event.items });
      setCompletionIdx(0);
    });
  }, []);

  // 输入变更时请求无副作用补全
  useEffect(() => {
    if (suppressCompletionRef.current) {
      suppressCompletionRef.current = false;
      return;
    }
    if (!running || readOnly || !expr.trim()) {
      activeCompletionReqIdRef.current = '';
      setCompletions({ prefix: '', items: [] });
      return;
    }
    const el = textareaRef.current;
    if (el && el.selectionStart !== expr.length) {
      return;
    }
    const timer = setTimeout(() => {
      const requestId = `cmp-${++completionReqSeqRef.current}`;
      activeCompletionReqIdRef.current = requestId;
      postToHost({
        type: 'browserConsoleComplete',
        payload: selectedElement?.selector
          ? { requestId, expression: expr, selectedSelector: selectedElement.selector }
          : { requestId, expression: expr },
      });
    }, COMPLETION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [expr, running, readOnly, selectedElement?.selector]);

  // 自动调整 REPL 多行输入框高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, Math.max(20, el.scrollHeight))}px`;
  }, [expr]);

  // 监控 ScrollArea 滚动容器，判断用户是否主动上翻
  useEffect(() => {
    const root = scrollContainerRef.current;
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const onScroll = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const atBottom = distanceFromBottom <= BOTTOM_STICK_THRESHOLD_PX;
      setStickToBottom(atBottom);
      if (atBottom) setHasUnreadBelow(false);
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, []);

  const errorCount = useMemo(() => logs.filter((e) => e.level === 'error').length, [logs]);
  const warnCount = useMemo(() => logs.filter((e) => e.level === 'warn').length, [logs]);

  const parsedFilter = useMemo(() => parseFilter(filterQuery, regexMode), [filterQuery, regexMode]);

  const displayRows = useMemo<readonly DisplayConsoleRow[]>(() => {
    const groupParents = new Map<number, number | undefined>();
    for (const entry of logs) {
      if (entry.groupId !== undefined) {
        groupParents.set(entry.groupId, entry.parentGroupId);
      }
    }
    const isCollapsedByAncestor = (entry: BrowserConsoleEntry): boolean => {
      let parentId = entry.parentGroupId;
      let guard = 0;
      while (parentId !== undefined && guard < 32) {
        if (collapsedGroups.has(parentId)) return true;
        parentId = groupParents.get(parentId);
        guard += 1;
      }
      return false;
    };

    const hiddenSet = new Set(hiddenSources);
    const visible: BrowserConsoleEntry[] = [];
    for (const entry of logs) {
      if (isCollapsedByAncestor(entry)) continue;
      if (!matchesLevel(entry, levels)) continue;
      if (entry.source?.url && hiddenSet.has(entry.source.url)) continue;
      if (!entryMatchesFilter(entry, parsedFilter)) continue;
      visible.push(entry);
    }

    if (!groupSimilar) {
      return visible.map((entry) => ({ entry, repeatCount: 1 }));
    }

    const merged: { entry: BrowserConsoleEntry; repeatCount: number }[] = [];
    for (const entry of visible) {
      const prev = merged.at(-1);
      const canMerge =
        prev &&
        entry.kind !== 'command' &&
        entry.kind !== 'result' &&
        entry.kind !== 'group' &&
        entry.kind !== 'groupCollapsed' &&
        prev.entry.kind !== 'command' &&
        prev.entry.kind !== 'result' &&
        prev.entry.kind !== 'group' &&
        prev.entry.kind !== 'groupCollapsed' &&
        prev.entry.level === entry.level &&
        (prev.entry.kind ?? 'console') === (entry.kind ?? 'console') &&
        prev.entry.text === entry.text &&
        (prev.entry.source?.url ?? '') === (entry.source?.url ?? '') &&
        (prev.entry.source?.lineNumber ?? 0) === (entry.source?.lineNumber ?? 0) &&
        (prev.entry.groupDepth ?? 0) === (entry.groupDepth ?? 0);
      if (canMerge) {
        prev.repeatCount += 1;
        prev.entry = { ...prev.entry, timestamp: entry.timestamp };
      } else {
        merged.push({ entry, repeatCount: 1 });
      }
    }
    return merged;
  }, [logs, collapsedGroups, levels, hiddenSources, parsedFilter, groupSimilar]);

  useEffect(() => {
    if (stickToBottom) {
      bottomRef.current?.scrollIntoView?.({ block: 'end' });
    } else if (logs.length > 0) {
      setHasUnreadBelow(true);
    }
  }, [logs.length, stickToBottom]);

  const jumpToBottom = () => {
    setStickToBottom(true);
    setHasUnreadBelow(false);
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  };

  const clearConsole = () => {
    setCollapsedGroups(new Set());
    setExpandedStacks(new Set());
    seenCollapsedGroupIdsRef.current.clear();
    postToHost({ type: 'browserClearConsole', payload: {} });
  };

  const copyEntryText = (entryId: number, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopiedId(entryId);
    setTimeout(() => setCopiedId((prev) => (prev === entryId ? null : prev)), 1_200);
  };

  const submitExpr = (event?: FormEvent) => {
    event?.preventDefault();
    if (!running || readOnly) return;
    const trimmed = expr.trim();
    if (!trimmed) return;
    historyRef.current = [...historyRef.current.slice(-49), trimmed];
    historyIdxRef.current = -1;
    draftRef.current = '';
    suppressCompletionRef.current = true;
    activeCompletionReqIdRef.current = '';
    setCompletions({ prefix: '', items: [] });
    setExpr('');
    setStickToBottom(true);
    setHasUnreadBelow(false);
    postToHost({
      type: 'browserEvalConsole',
      payload: selectedElement?.selector
        ? { expression: trimmed, selectedSelector: selectedElement.selector }
        : { expression: trimmed },
    });
  };

  const acceptCompletion = (item: string) => {
    const prefix = completions.prefix;
    const next = prefix && expr.endsWith(prefix) ? `${expr.slice(0, expr.length - prefix.length)}${item}` : `${expr}${item}`;
    suppressCompletionRef.current = true;
    activeCompletionReqIdRef.current = '';
    setCompletions({ prefix: '', items: [] });
    setExpr(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  };

  const handleExprKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const accel = event.ctrlKey || event.metaKey;
    if ((event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'l') || (event.metaKey && event.key.toLowerCase() === 'k')) {
      event.preventDefault();
      clearConsole();
      return;
    }

    if (completions.items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCompletionIdx((prev) => (prev + 1) % completions.items.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCompletionIdx((prev) => (prev - 1 + completions.items.length) % completions.items.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)) {
        event.preventDefault();
        const chosen = completions.items[completionIdx] ?? completions.items[0];
        if (chosen) acceptCompletion(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        activeCompletionReqIdRef.current = '';
        setCompletions({ prefix: '', items: [] });
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !accel && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitExpr();
      return;
    }

    const el = event.currentTarget;
    const selStart = el.selectionStart ?? 0;
    const selEnd = el.selectionEnd ?? 0;
    const onFirstLine = !expr.slice(0, selStart).includes('\n');
    const onLastLine = !expr.slice(selEnd).includes('\n');

    if (event.key === 'ArrowUp' && onFirstLine && historyRef.current.length > 0) {
      event.preventDefault();
      if (historyIdxRef.current < 0) {
        draftRef.current = expr;
      }
      const nextIdx = historyIdxRef.current < 0 ? historyRef.current.length - 1 : Math.max(0, historyIdxRef.current - 1);
      historyIdxRef.current = nextIdx;
      suppressCompletionRef.current = true;
      setExpr(historyRef.current[nextIdx] ?? '');
      return;
    }

    if (event.key === 'ArrowDown' && onLastLine && historyIdxRef.current >= 0) {
      event.preventDefault();
      const nextIdx = historyIdxRef.current + 1;
      suppressCompletionRef.current = true;
      if (nextIdx >= historyRef.current.length) {
        historyIdxRef.current = -1;
        setExpr(draftRef.current);
      } else {
        historyIdxRef.current = nextIdx;
        setExpr(historyRef.current[nextIdx] ?? '');
      }
    }
  };

  const levelSummaryLabel = useMemo(() => {
    if (levels.verbose && levels.info && levels.warn && levels.error) return t('wb.browser.consoleLevelsAll');
    if (!levels.verbose && levels.info && levels.warn && levels.error) return t('wb.browser.consoleLevelsDefault');
    const picked: string[] = [];
    if (levels.error) picked.push(t('wb.browser.consoleLevelError'));
    if (levels.warn) picked.push(t('wb.browser.consoleLevelWarn'));
    if (levels.info) picked.push(t('wb.browser.consoleLevelInfo'));
    if (levels.verbose) picked.push(t('wb.browser.consoleLevelVerbose'));
    if (picked.length === 1) return picked[0]!;
    return t('wb.browser.consoleLevelsCustom');
  }, [levels, t]);

  const toggleGroup = (groupId: number) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const toggleStack = (entryId: number) => {
    setExpandedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const isolateErrorLevel = () => {
    setLevels((prev) =>
      prev.error && !prev.warn && !prev.info && !prev.verbose
        ? DEFAULT_LEVELS
        : { verbose: false, info: false, warn: false, error: true },
    );
  };

  const isolateWarnLevel = () => {
    setLevels((prev) =>
      prev.warn && !prev.error && !prev.info && !prev.verbose
        ? DEFAULT_LEVELS
        : { verbose: false, info: false, warn: true, error: false },
    );
  };

  const toggleDollarZero = () => {
    if (!running || readOnly) return;
    const el = textareaRef.current;
    const next = expr ? `${expr}${expr.endsWith(' ') || expr.endsWith('.') ? '' : ' '}$0` : '$0';
    setExpr(next);
    el?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="browser-console-drawer">
      {/* Chrome 风格控制台工具栏（严格统一 size="xs" / "icon-xs"） */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-line/60 bg-inset/45 px-1.5 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="console-clear-btn"
            aria-label={t('wb.browser.consoleClear')}
            title={`${t('wb.browser.consoleClear')} (Ctrl+L)`}
            onClick={clearConsole}
            className="shrink-0 text-ink-3 hover:bg-hover hover:text-ink"
          >
            <BanIcon className="size-3.5" />
          </Button>

          <div className="relative min-w-24 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-3" />
            <Input
              size="xs"
              data-testid="console-filter-input"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder={t('wb.browser.consoleFilterPlaceholder')}
              aria-label={t('wb.browser.consoleFilterPlaceholder')}
              className={cn(
                'bg-surface/85 pl-6 font-mono text-[11px]',
                filterQuery && 'pr-6',
                parsedFilter.regexError && 'border-red focus-visible:ring-red/40',
              )}
            />
            {filterQuery ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('common.close')}
                onClick={() => setFilterQuery('')}
                className="absolute top-0 right-0 text-ink-3 hover:text-ink"
              >
                <CloseIcon className="size-3" />
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="console-regex-toggle"
            aria-label={t('wb.browser.consoleRegex')}
            title={t('wb.browser.consoleRegex')}
            aria-pressed={regexMode}
            onClick={() => setRegexMode((v) => !v)}
            className={cn(
              'shrink-0 text-ink-3 hover:bg-hover hover:text-ink',
              regexMode && 'bg-accent-tint text-accent-ink hover:bg-accent-tint',
            )}
          >
            <RegexIcon className="size-3" />
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="console-level-trigger"
                aria-label={t('wb.browser.consoleLevels')}
                className="shrink-0 gap-1 px-1.5 text-[11px] text-ink-2 hover:bg-hover hover:text-ink"
              >
                <span className="truncate">{levelSummaryLabel}</span>
                <ChevronDownIcon className="size-3 text-ink-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={4} className="w-48 p-2">
              <div className="mb-1.5 flex items-center justify-between border-b border-line/60 pb-1">
                <span className="text-[11px] font-semibold text-ink">{t('wb.browser.consoleLevels')}</span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="console-level-preset-default"
                    onClick={() => setLevels(DEFAULT_LEVELS)}
                    className="px-1 text-[10px] text-ink-3 hover:text-ink"
                  >
                    {t('wb.browser.consoleLevelsDefault')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="console-level-preset-all"
                    onClick={() => setLevels(ALL_LEVELS)}
                    className="px-1 text-[10px] text-ink-3 hover:text-ink"
                  >
                    {t('wb.browser.consoleAll')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {([
                  ['error', 'wb.browser.consoleLevelError', 'text-red'],
                  ['warn', 'wb.browser.consoleLevelWarn', 'text-orange'],
                  ['info', 'wb.browser.consoleLevelInfo', 'text-accent-ink'],
                  ['verbose', 'wb.browser.consoleLevelVerbose', 'text-ink-3'],
                ] as const).map(([key, labelKey, tone]) => (
                  <Label key={key} className="flex cursor-pointer items-center gap-2 text-[11.5px] font-normal text-ink">
                    <Checkbox
                      data-testid={`console-level-check-${key}`}
                      checked={levels[key]}
                      onCheckedChange={(checked) =>
                        setLevels((prev) => ({ ...prev, [key]: checked === true }))
                      }
                    />
                    <span className={tone}>{t(labelKey)}</span>
                  </Label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {errorCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="console-error-count"
              onClick={isolateErrorLevel}
              title={t('wb.browser.consoleLevelError')}
              className={cn(
                'gap-1 px-1.5 font-mono text-[10.5px] text-red tabular-nums hover:bg-red-tint/70',
                levels.error && !levels.warn && !levels.info && !levels.verbose && 'bg-red-tint',
              )}
            >
              <CircleXIcon className="size-3" />
              <span>{errorCount}</span>
            </Button>
          ) : null}

          {warnCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="console-warn-count"
              onClick={isolateWarnLevel}
              title={t('wb.browser.consoleLevelWarn')}
              className={cn(
                'gap-1 px-1.5 font-mono text-[10.5px] text-orange tabular-nums hover:bg-orange-tint/70',
                levels.warn && !levels.error && !levels.info && !levels.verbose && 'bg-orange-tint',
              )}
            >
              <AlertTriangleIcon className="size-3" />
              <span>{warnCount}</span>
            </Button>
          ) : null}

          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="console-settings-trigger"
                aria-label={t('wb.browser.consoleSettings')}
                title={t('wb.browser.consoleSettings')}
                className="text-ink-3 hover:bg-hover hover:text-ink"
              >
                <SettingsIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={4} className="w-56 p-2.5">
              <div className="mb-2 border-b border-line/60 pb-1 text-[11px] font-semibold text-ink">
                {t('wb.browser.consoleSettings')}
              </div>
              <div className="flex flex-col gap-2">
                <Label className="flex cursor-pointer items-center gap-2 text-[11.5px] font-normal text-ink">
                  <Checkbox
                    data-testid="console-setting-preserve"
                    checked={preserveLog}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      postToHost({
                        type: 'browserSetConsoleOptions',
                        payload: { preserveLog: checked === true },
                      })
                    }
                  />
                  <span>{t('wb.browser.consolePreserveLog')}</span>
                </Label>
                <Label className="flex cursor-pointer items-center gap-2 text-[11.5px] font-normal text-ink">
                  <Checkbox
                    data-testid="console-setting-timestamps"
                    checked={showTimestamps}
                    onCheckedChange={(checked) => setShowTimestamps(checked === true)}
                  />
                  <span>{t('wb.browser.consoleTimestamps')}</span>
                </Label>
                <Label className="flex cursor-pointer items-center gap-2 text-[11.5px] font-normal text-ink">
                  <Checkbox
                    data-testid="console-setting-group-similar"
                    checked={groupSimilar}
                    onCheckedChange={(checked) => setGroupSimilar(checked === true)}
                  />
                  <span>{t('wb.browser.consoleGroupSimilar')}</span>
                </Label>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* 已隐藏来源恢复条 */}
      {hiddenSources.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-b border-line/50 bg-inset/60 px-2 py-0.5 text-[10.5px] text-ink-3">
          <button
            type="button"
            onClick={() => setHiddenSources([])}
            className="text-left hover:text-ink hover:underline"
          >
            {t('wb.browser.consoleHiddenSources', hiddenSources.length)}
          </button>
        </div>
      ) : null}

      {/* 日志流主区域 */}
      <div ref={scrollContainerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollArea className="min-h-0 flex-1">
          <div className="font-mono text-[11px] leading-[18px]">
            {logs.length === 0 ? (
              <div className="py-6 text-center font-sans text-[11.5px] text-ink-3">
                {t('wb.browser.consoleEmpty')}
              </div>
            ) : displayRows.length === 0 ? (
              <div className="py-6 text-center font-sans text-[11.5px] text-ink-3">
                {t('wb.browser.consoleNoMatch')}
              </div>
            ) : (
              displayRows.map(({ entry, repeatCount }) => {
                const isGroupHeader = entry.kind === 'group' || entry.kind === 'groupCollapsed';
                const isGroupExpanded = entry.groupId !== undefined && !collapsedGroups.has(entry.groupId);
                const hasStack = Boolean(entry.stackTrace && entry.stackTrace.length > 0);
                const stackExpanded = expandedStacks.has(entry.id);
                const depth = entry.groupDepth ?? 0;
                const sourceShort = shortSourceLabel(entry.source);
                const sourceTitle = fullSourceTooltip(entry.source);

                const rowToneClass =
                  entry.level === 'error'
                    ? 'border-red/20 bg-red-tint/45 text-red'
                    : entry.level === 'warn'
                      ? 'border-orange/20 bg-orange-tint/45 text-orange'
                      : entry.kind === 'command'
                        ? 'border-line/40 bg-inset/45 text-ink'
                        : entry.kind === 'result'
                          ? 'border-line/40 bg-canvas/35 text-ink'
                          : 'border-line/40 text-ink';

                const isCommandOrResult = entry.kind === 'command' || entry.kind === 'result';

                return (
                  <ContextMenu key={entry.id}>
                    <ContextMenuTrigger asChild>
                      <div
                        data-testid={`console-row-${entry.id}`}
                        data-level={entry.level}
                        data-kind={entry.kind ?? 'console'}
                        style={depth > 0 ? { paddingLeft: `${depth * 14 + 6}px` } : undefined}
                        className={cn(
                          'group relative flex flex-col border-b px-2 py-0.5 transition-colors hover:bg-hover/40',
                          rowToneClass,
                        )}
                      >
                        <div className="flex items-start gap-1.5">
                          {/* 行首图标 / 折叠按钮 / 重复次数 */}
                          <div className="mt-[2px] flex shrink-0 items-center gap-1">
                            {isGroupHeader && entry.groupId !== undefined ? (
                              <button
                                type="button"
                                data-testid={`console-group-toggle-${entry.groupId}`}
                                onClick={() => toggleGroup(entry.groupId!)}
                                className="rounded text-ink-2 hover:bg-hover hover:text-ink"
                              >
                                {isGroupExpanded ? (
                                  <ChevronDownIcon className="size-3" />
                                ) : (
                                  <ChevronRightIcon className="size-3" />
                                )}
                              </button>
                            ) : hasStack ? (
                              <button
                                type="button"
                                data-testid={`console-stack-toggle-${entry.id}`}
                                aria-expanded={stackExpanded}
                                onClick={() => toggleStack(entry.id)}
                                className="rounded text-ink-3 hover:bg-hover hover:text-ink"
                              >
                                {stackExpanded ? (
                                  <ChevronDownIcon className="size-3" />
                                ) : (
                                  <ChevronRightIcon className="size-3" />
                                )}
                              </button>
                            ) : null}

                            {entry.kind === 'command' ? (
                              <ChevronRightIcon className="size-3 text-accent-ink" />
                            ) : entry.kind === 'result' ? (
                              <CornerDownLeftIcon className="size-3 text-ink-3" />
                            ) : entry.level === 'error' ? (
                              <CircleXIcon className="size-3 text-red" />
                            ) : entry.level === 'warn' ? (
                              <AlertTriangleIcon className="size-3 text-orange" />
                            ) : entry.level === 'info' ? (
                              <InfoIcon className="size-3 text-accent-ink" />
                            ) : null}

                            {repeatCount > 1 ? (
                              <span
                                data-testid="console-repeat-badge"
                                className={cn(
                                  'inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-3.5 tabular-nums',
                                  entry.level === 'error'
                                    ? 'bg-red text-white'
                                    : entry.level === 'warn'
                                      ? 'bg-orange text-white'
                                      : 'bg-accent-tint text-accent-ink',
                                )}
                              >
                                {repeatCount}
                              </span>
                            ) : null}

                            {showTimestamps ? (
                              <span
                                data-testid="console-timestamp"
                                className="text-[10px] text-ink-3 tabular-nums"
                              >
                                {formatTimestamp(entry.timestamp)}
                              </span>
                            ) : null}
                          </div>

                          {/* 主体内容：%c 格式化 / 结构化参数 / 纯文本兜底 */}
                          <div className="min-w-0 flex-1 break-all whitespace-pre-wrap">
                            {entry.formatted && entry.formatted.length > 0 ? (
                              <span className="inline-flex flex-wrap items-start gap-x-0.5">
                                {entry.formatted.map((seg, segIdx) =>
                                  seg.arg ? (
                                    <ConsoleValueNode
                                      key={segIdx}
                                      arg={seg.arg}
                                      quoted={false}
                                      consoleObjects={consoleObjects}
                                      onRequestObject={onRequestConsoleObject}
                                    />
                                  ) : (
                                    <span key={segIdx} style={seg.style}>
                                      {seg.text}
                                    </span>
                                  ),
                                )}
                              </span>
                            ) : entry.args && entry.args.length > 0 ? (
                              <span className="inline-flex flex-wrap items-start gap-x-1.5">
                                {entry.args.map((arg, argIdx) => (
                                  <ConsoleValueNode
                                    key={argIdx}
                                    arg={arg}
                                    quoted={isCommandOrResult}
                                    consoleObjects={consoleObjects}
                                    onRequestObject={onRequestConsoleObject}
                                  />
                                ))}
                              </span>
                            ) : (
                              <span>{entry.text}</span>
                            )}
                          </div>

                          {/* 右侧源码定位与悬浮快捷复制 */}
                          <div className="flex shrink-0 items-center gap-1">
                            {sourceShort ? (
                              <button
                                type="button"
                                title={sourceTitle}
                                onClick={() => copyEntryText(entry.id, sourceTitle ?? sourceShort)}
                                className="max-w-36 truncate text-[10px] text-ink-3 underline-offset-2 hover:text-ink hover:underline tabular-nums"
                              >
                                {sourceShort}
                              </button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={t('wb.browser.consoleCopyMessage')}
                              title={t('wb.browser.consoleCopyMessage')}
                              onClick={() => copyEntryText(entry.id, entry.text)}
                              className="opacity-0 transition-opacity group-hover:opacity-100 text-ink-3 hover:text-ink"
                            >
                              {copiedId === entry.id ? (
                                <CheckIcon className="size-3 text-green" />
                              ) : (
                                <CopyIcon className="size-3" />
                              )}
                            </Button>
                          </div>
                        </div>

                        {/* console.table 表格视图 */}
                        {entry.table ? (
                          <div
                            data-testid={`console-table-${entry.id}`}
                            className="mt-1 ml-4 overflow-hidden rounded-md border border-line/70 bg-surface/85"
                          >
                            <Table className="text-[10.5px]">
                              <TableHeader>
                                <TableRow className="border-line/70 hover:bg-transparent">
                                  {entry.table.columns.map((col) => (
                                    <TableHead key={col} className="h-6 px-2 py-0.5 text-[10.5px] font-semibold text-ink-2">
                                      {col}
                                    </TableHead>
                                  ))}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {entry.table.rows.map((row, rIdx) => (
                                  <TableRow key={rIdx} className="border-line/50">
                                    {entry.table!.columns.map((col) => (
                                      <TableCell key={col} className="px-2 py-0.5 font-mono text-[10.5px] text-ink">
                                        {row[col] ?? ''}
                                      </TableCell>
                                    ))}
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        ) : null}

                        {/* 可展开调用堆栈 */}
                        {hasStack && stackExpanded ? (
                          <div
                            data-testid={`console-stack-${entry.id}`}
                            className="mt-1 ml-4 space-y-0.5 border-l border-line/60 pl-2 text-[10.5px] text-ink-2"
                          >
                            {entry.stackTrace!.map((frame, fIdx) => (
                              <div key={fIdx} className="flex items-baseline justify-between gap-2">
                                <span className="truncate">{frame.functionName || '(anonymous)'}</span>
                                <span className="shrink-0 text-[10px] text-ink-3 tabular-nums">
                                  {shortSourceLabel(frame)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </ContextMenuTrigger>

                    <ContextMenuContent className="w-48">
                      <ContextMenuItem onClick={() => copyEntryText(entry.id, entry.text)}>
                        <CopyIcon className="size-3.5" />
                        <span>{t('wb.browser.consoleCopyMessage')}</span>
                      </ContextMenuItem>
                      {hasStack ? (
                        <ContextMenuItem
                          onClick={() =>
                            copyEntryText(
                              entry.id,
                              `${entry.text}\n${formatStackText(entry.stackTrace!)}`,
                            )
                          }
                        >
                          <CopyIcon className="size-3.5" />
                          <span>{t('wb.browser.consoleCopyStack')}</span>
                        </ContextMenuItem>
                      ) : null}
                      {entry.source?.url ? (
                        <ContextMenuItem
                          onClick={() =>
                            setHiddenSources((prev) =>
                              prev.includes(entry.source!.url) ? prev : [...prev, entry.source!.url],
                            )
                          }
                        >
                          <BanIcon className="size-3.5" />
                          <span className="truncate">
                            {t('wb.browser.consoleHideSource', sourceShort ?? entry.source.url)}
                          </span>
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={clearConsole}>
                        <BanIcon className="size-3.5" />
                        <span>{t('wb.browser.consoleClear')}</span>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {hasUnreadBelow ? (
          <div className="pointer-events-none absolute right-3 bottom-2 flex justify-end">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              data-testid="console-jump-bottom"
              onClick={jumpToBottom}
              className="pointer-events-auto gap-1 rounded-full shadow-raised"
            >
              <ArrowDownIcon className="size-3" />
              <span>{t('wb.browser.consoleJumpBottom')}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {/* 增强型多行 REPL + 补全浮层 + $0 元素联动 */}
      <div className="relative shrink-0 border-t border-line/70 bg-surface/75">
        {completions.items.length > 0 ? (
          <div
            data-testid="console-completions"
            className="dropdown-glass absolute right-2 bottom-full left-2 z-20 mb-1 max-h-40 overflow-y-auto rounded-lg border border-line bg-popover p-1 shadow-overlay"
          >
            {completions.items.map((item, idx) => (
              <button
                key={item}
                type="button"
                data-testid={`console-completion-item-${item}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptCompletion(item);
                }}
                className={cn(
                  'flex w-full items-center rounded px-2 py-0.5 text-left font-mono text-[11px] transition-colors',
                  idx === completionIdx ? 'bg-accent-tint font-medium text-accent-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
                )}
              >
                {item}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={submitExpr} className="flex items-start gap-1.5 px-2 py-1">
          <ChevronRightIcon className="mt-1 size-3.5 shrink-0 text-accent-ink" />
          <textarea
            ref={textareaRef}
            rows={1}
            data-testid="browser-console-input"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={handleExprKeyDown}
            placeholder={t('wb.browser.consoleInputPlaceholder')}
            title={t('wb.browser.consoleEvalHint')}
            disabled={!running || readOnly}
            className="min-w-0 flex-1 resize-none border-0 bg-transparent py-0.5 font-mono text-[11px] leading-[18px] text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {selectedElement ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="console-dollar-zero"
              title={selectedElement.selector}
              disabled={!running || readOnly}
              onClick={toggleDollarZero}
              className="shrink-0 bg-accent-tint/60 px-1.5 font-mono text-[10px] text-accent-ink hover:bg-accent-tint"
            >
              $0 = &lt;{selectedElement.label}&gt;
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="ghost"
            size="icon-xs"
            aria-label={t('wb.browser.consoleInputPlaceholder')}
            disabled={!running || readOnly || !expr.trim()}
            className="shrink-0 text-ink-3 hover:text-ink"
          >
            <SendIcon className="size-3" />
          </Button>
        </form>
      </div>
    </div>
  );
}

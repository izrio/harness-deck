/**
 * CDP 浏览器控制台纯格式化工具：
 * - RemoteObject / ObjectPreview / PropertyDescriptor → 结构化视图模型
 * - Console `%s/%d/%i/%f/%o/%O/%c/%%` 占位符解析与 CSS 声明白名单消毒
 * - `console.table` 表格提取、调用堆栈提取与 REPL 安全补全目标提取
 */
import type {
  BrowserConsoleArg,
  BrowserConsoleFormattedSegment,
  BrowserConsoleProperty,
  BrowserConsoleStackFrame,
  BrowserConsoleTableData,
} from '@harness-deck/shared';

const MAX_TEXT_CHARS = 2_000;
const MAX_PREVIEW_PROPS = 20;
const MAX_OBJECT_PROPS = 200;
const MAX_STACK_FRAMES = 30;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLS = 20;

const ALLOWED_CSS_PROPERTIES: Readonly<Record<string, string>> = {
  color: 'color',
  background: 'background',
  'background-color': 'backgroundColor',
  'font-weight': 'fontWeight',
  'font-style': 'fontStyle',
  'font-size': 'fontSize',
  'text-decoration': 'textDecoration',
  border: 'border',
  'border-radius': 'borderRadius',
  padding: 'padding',
  margin: 'margin',
  'line-height': 'lineHeight',
};

const DANGEROUS_CSS_RE = /url\s*\(|expression\s*\(|@import|\/\*|\*\/|[\\{}]/iu;

/** 将 CDP `%c` 的内联样式字符串做严格白名单消毒并映射为 React camelCase 样式对象。 */
export function sanitizeConsoleCss(rawCss: string): Readonly<Record<string, string>> | undefined {
  if (!rawCss.trim()) return undefined;
  const out: Record<string, string> = {};
  for (const part of rawCss.split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const rawProp = part.slice(0, colon).trim().toLowerCase();
    const camelProp = ALLOWED_CSS_PROPERTIES[rawProp];
    if (!camelProp) continue;
    const rawVal = part.slice(colon + 1).replace(/!important\b/giu, '').trim();
    if (!rawVal || rawVal.length > 160 || DANGEROUS_CSS_RE.test(rawVal)) continue;
    out[camelProp] = rawVal;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeObjectType(raw: unknown): BrowserConsoleArg['type'] {
  switch (raw) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
    case 'symbol':
    case 'bigint':
    case 'object':
    case 'function':
      return raw;
    default:
      return 'object';
  }
}

interface CdpPropertyPreview {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly value?: unknown;
  readonly valuePreview?: unknown;
}

interface CdpEntryPreview {
  readonly key?: unknown;
  readonly value?: unknown;
}

interface CdpObjectPreview {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly description?: unknown;
  readonly overflow?: unknown;
  readonly properties?: readonly CdpPropertyPreview[];
  readonly entries?: readonly CdpEntryPreview[];
}

function previewPropToArg(prop: CdpPropertyPreview): BrowserConsoleArg {
  if (prop.valuePreview && typeof prop.valuePreview === 'object') {
    return cdpPreviewToArg(prop.valuePreview as CdpObjectPreview);
  }
  const type = normalizeObjectType(prop.type);
  const subtype = typeof prop.subtype === 'string' ? prop.subtype : undefined;
  const rawVal = typeof prop.value === 'string' ? prop.value : undefined;
  if (subtype === 'null') {
    return { type: 'object', subtype: 'null', value: null, description: 'null' };
  }
  if (type === 'undefined') {
    return { type: 'undefined', description: 'undefined' };
  }
  if (type === 'boolean') {
    return { type: 'boolean', value: rawVal === 'true', description: rawVal ?? 'false' };
  }
  if (type === 'number') {
    const num = rawVal !== undefined ? Number(rawVal) : Number.NaN;
    return Number.isFinite(num)
      ? { type: 'number', value: num, description: rawVal }
      : { type: 'number', description: rawVal ?? 'NaN' };
  }
  if (type === 'string') {
    return { type: 'string', value: rawVal ?? '' };
  }
  return {
    type,
    ...(subtype ? { subtype } : {}),
    ...(rawVal !== undefined ? { description: rawVal } : {}),
  };
}

function cdpPreviewToArg(preview: CdpObjectPreview): BrowserConsoleArg {
  const type = normalizeObjectType(preview.type);
  const subtype = typeof preview.subtype === 'string' ? preview.subtype : undefined;
  const description = typeof preview.description === 'string' ? preview.description : undefined;
  const props: BrowserConsoleProperty[] = [];

  if (Array.isArray(preview.properties)) {
    for (const item of preview.properties.slice(0, MAX_PREVIEW_PROPS)) {
      if (!item || typeof item !== 'object') continue;
      const name = typeof item.name === 'string' ? item.name : String(item.name ?? '');
      if (!name) continue;
      props.push({
        name,
        value: previewPropToArg(item),
        isOwn: true,
      });
    }
  }

  if (Array.isArray(preview.entries)) {
    for (let i = 0; i < Math.min(preview.entries.length, MAX_PREVIEW_PROPS - props.length); i += 1) {
      const entry = preview.entries[i];
      if (!entry || typeof entry !== 'object') continue;
      const valArg = entry.value && typeof entry.value === 'object'
        ? cdpPreviewToArg(entry.value as CdpObjectPreview)
        : { type: 'undefined' as const, description: 'undefined' };
      if (entry.key && typeof entry.key === 'object') {
        const keyArg = cdpPreviewToArg(entry.key as CdpObjectPreview);
        const keyText = formatArgText(keyArg);
        props.push({
          name: `${keyText} =>`,
          value: valArg,
          isOwn: true,
        });
      } else {
        props.push({
          name: String(i),
          value: valArg,
          isOwn: true,
        });
      }
    }
  }

  return {
    type,
    ...(subtype ? { subtype } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(props.length > 0 ? { preview: props } : {}),
    ...(preview.overflow === true ? { overflow: true } : {}),
  };
}

/** 将 CDP `Runtime.RemoteObject` 转换为结构化 `BrowserConsoleArg`。 */
export function cdpRemoteObjectToArg(raw: unknown): BrowserConsoleArg {
  if (!raw || typeof raw !== 'object') {
    return { type: 'undefined', description: 'undefined' };
  }
  const obj = raw as {
    readonly type?: unknown;
    readonly subtype?: unknown;
    readonly className?: unknown;
    readonly value?: unknown;
    readonly unserializableValue?: unknown;
    readonly description?: unknown;
    readonly objectId?: unknown;
    readonly preview?: unknown;
  };
  const type = normalizeObjectType(obj.type);
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : undefined;
  const className = typeof obj.className === 'string' ? obj.className : undefined;
  const objectId = typeof obj.objectId === 'string' && obj.objectId ? obj.objectId : undefined;
  const unserializable = typeof obj.unserializableValue === 'string' ? obj.unserializableValue : undefined;
  const description = typeof obj.description === 'string' ? obj.description : unserializable;

  if (subtype === 'null' || obj.value === null) {
    return {
      type: 'object',
      subtype: 'null',
      value: null,
      description: 'null',
    };
  }

  if (type === 'undefined') {
    return { type: 'undefined', description: 'undefined' };
  }

  if (type === 'string' || type === 'boolean') {
    return {
      type,
      ...(typeof obj.value === 'string' || typeof obj.value === 'boolean' ? { value: obj.value } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  }

  if (type === 'number') {
    return {
      type: 'number',
      ...(typeof obj.value === 'number' && Number.isFinite(obj.value) ? { value: obj.value } : {}),
      ...(description !== undefined
        ? { description }
        : typeof obj.value === 'number'
          ? { description: String(obj.value) }
          : {}),
    };
  }

  if (type === 'bigint' || type === 'symbol') {
    return {
      type,
      ...(description !== undefined ? { description } : {}),
      ...(objectId ? { objectId } : {}),
    };
  }

  const previewParsed =
    obj.preview && typeof obj.preview === 'object' ? cdpPreviewToArg(obj.preview as CdpObjectPreview) : undefined;

  return {
    type,
    ...(subtype ? { subtype } : {}),
    ...(className ? { className } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(objectId ? { objectId } : {}),
    ...(previewParsed?.preview ? { preview: previewParsed.preview } : {}),
    ...(previewParsed?.overflow ? { overflow: true } : {}),
  };
}

/** 将 CDP `Runtime.getProperties` 结果转换并规范化为 `BrowserConsoleProperty[]`。 */
export function cdpPropertyDescriptorsToProperties(
  rawResult: unknown,
  rawInternal?: unknown,
): BrowserConsoleProperty[] {
  const props: BrowserConsoleProperty[] = [];
  if (Array.isArray(rawResult)) {
    for (const item of rawResult) {
      if (props.length >= MAX_OBJECT_PROPS) break;
      if (!item || typeof item !== 'object') continue;
      const desc = item as {
        readonly name?: unknown;
        readonly value?: unknown;
        readonly isOwn?: unknown;
        readonly get?: unknown;
      };
      const name = typeof desc.name === 'string' ? desc.name : String(desc.name ?? '');
      if (!name || name === '__proto__') continue;
      if (desc.value !== undefined) {
        props.push({
          name,
          value: cdpRemoteObjectToArg(desc.value),
          ...(desc.isOwn === true ? { isOwn: true } : {}),
        });
      } else if (desc.get) {
        props.push({
          name,
          value: { type: 'function', subtype: 'getter', description: 'Getter' },
          ...(desc.isOwn === true ? { isOwn: true } : {}),
        });
      }
    }
  }

  if (Array.isArray(rawInternal)) {
    for (const item of rawInternal) {
      if (props.length >= MAX_OBJECT_PROPS + 16) break;
      if (!item || typeof item !== 'object') continue;
      const desc = item as { readonly name?: unknown; readonly value?: unknown };
      const name = typeof desc.name === 'string' ? desc.name : '';
      if (!name || desc.value === undefined) continue;
      if (name === '[[Prototype]]' || name === '[[PromiseState]]' || name === '[[PromiseResult]]' || name === '[[Entries]]') {
        props.push({
          name,
          value: cdpRemoteObjectToArg(desc.value),
          internal: true,
        });
      }
    }
  }

  return props;
}

/** 提取 CDP 堆栈帧（将 0-based 行列号转为 1-based）。 */
export function extractStackFrames(
  rawStackTrace: unknown,
  fallback?: { readonly url?: unknown; readonly lineNumber?: unknown; readonly columnNumber?: unknown },
): readonly BrowserConsoleStackFrame[] {
  const frames: BrowserConsoleStackFrame[] = [];
  if (rawStackTrace && typeof rawStackTrace === 'object') {
    const callFrames = (rawStackTrace as { readonly callFrames?: unknown }).callFrames;
    if (Array.isArray(callFrames)) {
      for (const rawFrame of callFrames.slice(0, MAX_STACK_FRAMES)) {
        if (!rawFrame || typeof rawFrame !== 'object') continue;
        const f = rawFrame as {
          readonly functionName?: unknown;
          readonly url?: unknown;
          readonly lineNumber?: unknown;
          readonly columnNumber?: unknown;
        };
        const url = typeof f.url === 'string' ? f.url : '';
        const line0 = typeof f.lineNumber === 'number' && Number.isFinite(f.lineNumber) ? f.lineNumber : -1;
        const col0 = typeof f.columnNumber === 'number' && Number.isFinite(f.columnNumber) ? f.columnNumber : -1;
        if (!url && line0 < 0) continue;
        frames.push({
          functionName: typeof f.functionName === 'string' && f.functionName.trim() ? f.functionName.trim() : '(anonymous)',
          url,
          lineNumber: line0 >= 0 ? line0 + 1 : 0,
          columnNumber: col0 >= 0 ? col0 + 1 : 0,
        });
      }
    }
  }

  if (frames.length === 0 && fallback && typeof fallback.url === 'string' && fallback.url) {
    const line0 = typeof fallback.lineNumber === 'number' && Number.isFinite(fallback.lineNumber) ? fallback.lineNumber : -1;
    const col0 = typeof fallback.columnNumber === 'number' && Number.isFinite(fallback.columnNumber) ? fallback.columnNumber : -1;
    frames.push({
      functionName: '(anonymous)',
      url: fallback.url,
      lineNumber: line0 >= 0 ? line0 + 1 : 0,
      columnNumber: col0 >= 0 ? col0 + 1 : 0,
    });
  }

  return frames;
}

/** 将单个 `BrowserConsoleArg` 格式化为单行纯文本（用于检索、复制与纯文本回退）。 */
export function formatArgText(arg: BrowserConsoleArg, inlinePreview = true): string {
  if (arg.type === 'undefined') return 'undefined';
  if (arg.subtype === 'null' || arg.value === null) return 'null';
  if (arg.type === 'string') return typeof arg.value === 'string' ? arg.value : (arg.description ?? '');
  if (arg.type === 'boolean') return String(arg.value ?? arg.description ?? false);
  if (arg.type === 'number') return arg.description ?? String(arg.value ?? 'NaN');
  if (arg.type === 'bigint' || arg.type === 'symbol') return arg.description ?? String(arg.type);
  if (arg.type === 'function') {
    const desc = (arg.description ?? 'ƒ ()').replace(/\s+/gu, ' ').trim();
    return desc.length > 80 ? `${desc.slice(0, 77)}…` : desc;
  }

  if (inlinePreview && arg.preview && arg.preview.length > 0) {
    if (arg.subtype === 'array') {
      const items = arg.preview
        .filter((p) => /^\d+$/u.test(p.name))
        .map((p) => (p.value.type === 'string' ? JSON.stringify(p.value.value ?? '') : formatArgText(p.value, false)));
      const head = arg.description && arg.description !== 'Array' ? `${arg.description} ` : '';
      return `${head}[${items.join(', ')}${arg.overflow ? ', …' : ''}]`;
    }
    const pairs = arg.preview.map((p) => {
      const valStr = p.value.type === 'string' ? JSON.stringify(p.value.value ?? '') : formatArgText(p.value, false);
      return p.name.endsWith('=>') ? `${p.name} ${valStr}` : `${p.name}: ${valStr}`;
    });
    const prefix = arg.className && arg.className !== 'Object' ? `${arg.className} ` : '';
    return `${prefix}{${pairs.join(', ')}${arg.overflow ? ', …' : ''}}`;
  }

  return arg.description || arg.className || arg.subtype || 'Object';
}

function asInteger(arg: BrowserConsoleArg): number {
  if (arg.type === 'number' && typeof arg.value === 'number') return Math.trunc(arg.value);
  const parsed = Number.parseInt(formatArgText(arg, false), 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function asFloat(arg: BrowserConsoleArg): number {
  if (arg.type === 'number' && typeof arg.value === 'number') return arg.value;
  const parsed = Number.parseFloat(formatArgText(arg, false));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * 解析 Chrome Console 的 `%s/%d/%i/%f/%o/%O/%c/%%` 格式化模板并生成纯文本摘要。
 */
export function formatConsoleArgs(args: readonly BrowserConsoleArg[]): {
  readonly text: string;
  readonly formatted?: readonly BrowserConsoleFormattedSegment[];
} {
  if (args.length === 0) return { text: '' };

  const first = args[0]!;
  const hasSpecifiers =
    first.type === 'string' &&
    typeof first.value === 'string' &&
    args.length > 1 &&
    /%[sdifoOc%]/u.test(first.value);

  if (!hasSpecifiers) {
    const text = args
      .map((a) => formatArgText(a))
      .join(' ')
      .slice(0, MAX_TEXT_CHARS);
    return { text };
  }

  const template = first.value as string;
  const segments: BrowserConsoleFormattedSegment[] = [];
  const textParts: string[] = [];
  let argIndex = 1;
  let activeStyle: Readonly<Record<string, string>> | undefined;
  let lastIndex = 0;

  const pushText = (str: string) => {
    if (!str) return;
    textParts.push(str);
    segments.push(activeStyle ? { text: str, style: activeStyle } : { text: str });
  };

  const tokenRe = /%([sdifoOc%])/gu;
  for (const match of template.matchAll(tokenRe)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      pushText(template.slice(lastIndex, idx));
    }
    const spec = match[1]!;
    if (spec === '%') {
      pushText('%');
      lastIndex = idx + 2;
      continue;
    }
    if (argIndex >= args.length) {
      pushText(match[0]);
      lastIndex = idx + 2;
      continue;
    }
    const arg = args[argIndex++]!;
    if (spec === 'c') {
      activeStyle = sanitizeConsoleCss(formatArgText(arg, false));
    } else if (spec === 's') {
      pushText(formatArgText(arg, false));
    } else if (spec === 'd' || spec === 'i') {
      const n = asInteger(arg);
      pushText(Number.isNaN(n) ? 'NaN' : String(n));
    } else if (spec === 'f') {
      const n = asFloat(arg);
      pushText(Number.isNaN(n) ? 'NaN' : String(n));
    } else if (spec === 'o' || spec === 'O') {
      const t = formatArgText(arg, true);
      textParts.push(t);
      segments.push({ arg });
    }
    lastIndex = idx + 2;
  }

  if (lastIndex < template.length) {
    pushText(template.slice(lastIndex));
  }

  while (argIndex < args.length) {
    const remainingArg = args[argIndex++]!;
    const t = formatArgText(remainingArg, true);
    if (textParts.length > 0) {
      textParts.push(` ${t}`);
      segments.push({ text: ' ' });
    } else {
      textParts.push(t);
    }
    segments.push({ arg: remainingArg });
  }

  return {
    text: textParts.join('').slice(0, MAX_TEXT_CHARS),
    formatted: segments,
  };
}

/** 从 `console.table` 首个参数预览中提取行列表格结构。 */
export function extractConsoleTable(arg: BrowserConsoleArg | undefined): BrowserConsoleTableData | undefined {
  if (!arg?.preview || arg.preview.length === 0) return undefined;
  const cols: string[] = ['(index)'];
  const colSet = new Set<string>(cols);
  const rows: Record<string, string>[] = [];
  const hasNestedObjects = arg.preview.some((item) => item.value.preview && item.value.preview.length > 0);

  for (const entry of arg.preview.slice(0, MAX_TABLE_ROWS)) {
    const row: Record<string, string> = { '(index)': entry.name };
    if (hasNestedObjects && entry.value.preview && entry.value.preview.length > 0) {
      for (const cell of entry.value.preview) {
        if (!colSet.has(cell.name)) {
          if (cols.length >= MAX_TABLE_COLS) continue;
          colSet.add(cell.name);
          cols.push(cell.name);
        }
        row[cell.name] = formatArgText(cell.value, true);
      }
    } else {
      if (!colSet.has('Values')) {
        colSet.add('Values');
        cols.push('Values');
      }
      row.Values = formatArgText(entry.value, true);
    }
    rows.push(row);
  }

  if (rows.length === 0 || cols.length <= 1) return undefined;
  return { columns: cols, rows };
}

const SAFE_RECEIVER_RE = /^(?:\$0|[a-zA-Z_$][\w$]*)(?:\.[a-zA-Z_$][\w$]*)*$/u;

/** 从 REPL 输入末尾提取安全的全局/属性补全目标，拒绝包含函数调用或运算符的 receiver。 */
export function extractCompletionTarget(
  expression: string,
): { readonly receiver?: string; readonly prefix: string } | undefined {
  if (!expression) return { prefix: '' };
  let i = expression.length;
  while (i > 0 && /[\w$.]/u.test(expression[i - 1]!)) {
    i -= 1;
  }
  const tail = expression.slice(i);
  if (!tail) {
    const prev = i > 0 ? expression[i - 1]! : '';
    if (prev === ')' || prev === ']' || prev === '"' || prev === "'" || prev === '`') return undefined;
    return { prefix: '' };
  }
  if (tail.startsWith('.')) return undefined;
  const lastDot = tail.lastIndexOf('.');
  if (lastDot >= 0) {
    const receiver = tail.slice(0, lastDot);
    const prefix = tail.slice(lastDot + 1);
    if (!SAFE_RECEIVER_RE.test(receiver)) return undefined;
    if (prefix && !/^[a-zA-Z_$][\w$]*$/u.test(prefix)) return undefined;
    return { receiver, prefix };
  }
  if (!/^(?:\$0|[a-zA-Z_$][\w$]*)$/u.test(tail)) return undefined;
  return { prefix: tail };
}

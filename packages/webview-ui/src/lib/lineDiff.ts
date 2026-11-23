/**
 * 逐行 Diff、词级差异、Split 并排视图与单 Hunk Patch 提取（HD-25 / P0-1）。
 */

export interface DiffDisplayLine {
  readonly kind: 'hunk' | 'context' | 'add' | 'del';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface WordSegment {
  readonly text: string;
  readonly changed: boolean;
}

export interface SplitDiffRow {
  readonly kind: 'hunk' | 'pair';
  readonly hunkText?: string;
  readonly hunkIndex?: number;
  readonly left?: DiffDisplayLine;
  readonly right?: DiffDisplayLine;
}

interface RawOp {
  readonly kind: 'context' | 'add' | 'del';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

const MAX_LCS_CELLS = 1_500_000;

function computeRawOps(beforeLines: readonly string[], afterLines: readonly string[]): RawOp[] {
  let prefix = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: RawOp[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: 'context', text: beforeLines[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  const midA = beforeLines.slice(prefix, beforeLines.length - suffix);
  const midB = afterLines.slice(prefix, afterLines.length - suffix);

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (let i = 0; i < midA.length; i += 1) {
      ops.push({ kind: 'del', text: midA[i]!, oldLine: prefix + i + 1 });
    }
    for (let j = 0; j < midB.length; j += 1) {
      ops.push({ kind: 'add', text: midB[j]!, newLine: prefix + j + 1 });
    }
  } else {
    const m = midA.length;
    const n = midB.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      const row = dp[i]!;
      const next = dp[i + 1]!;
      for (let j = n - 1; j >= 0; j -= 1) {
        row[j] = midA[i] === midB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({
          kind: 'context',
          text: midA[i]!,
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
        });
        i += 1;
        j += 1;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        ops.push({ kind: 'del', text: midA[i]!, oldLine: prefix + i + 1 });
        i += 1;
      } else {
        ops.push({ kind: 'add', text: midB[j]!, newLine: prefix + j + 1 });
        j += 1;
      }
    }
    while (i < m) {
      ops.push({ kind: 'del', text: midA[i]!, oldLine: prefix + i + 1 });
      i += 1;
    }
    while (j < n) {
      ops.push({ kind: 'add', text: midB[j]!, newLine: prefix + j + 1 });
      j += 1;
    }
  }

  const tailOldStart = beforeLines.length - suffix;
  const tailNewStart = afterLines.length - suffix;
  for (let k = 0; k < suffix; k += 1) {
    ops.push({
      kind: 'context',
      text: beforeLines[tailOldStart + k]!,
      oldLine: tailOldStart + k + 1,
      newLine: tailNewStart + k + 1,
    });
  }
  return ops;
}

export function buildUnifiedDiffLines(before: string, after: string, contextLines = 3): DiffDisplayLine[] {
  const beforeLines = before ? before.split('\n') : [];
  const afterLines = after ? after.split('\n') : [];
  const ops = computeRawOps(beforeLines, afterLines);

  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== 'context') changeIndices.push(i);
  }
  if (changeIndices.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    const prev = ranges.at(-1);
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const out: DiffDisplayLine[] = [];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const firstOld = slice.find((o) => o.oldLine !== undefined)?.oldLine ?? 1;
    const firstNew = slice.find((o) => o.newLine !== undefined)?.newLine ?? 1;
    const oldCount = slice.filter((o) => o.kind !== 'add').length;
    const newCount = slice.filter((o) => o.kind !== 'del').length;
    out.push({
      kind: 'hunk',
      text: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`,
    });
    for (const op of slice) {
      out.push(op);
    }
  }
  return out;
}

export function parseUnifiedPatchLines(patchText: string): DiffDisplayLine[] {
  const lines = patchText.split('\n');
  const out: DiffDisplayLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(line);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1]!, 10);
      newLine = Number.parseInt(hunkMatch[2]!, 10);
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push({ kind: 'add', text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      out.push({ kind: 'del', text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}

/** 计算单行配对删除/新增之间的词级差异片段，用于行内高亮（P0-1）。 */
export function computeWordDiffSegments(
  oldText: string,
  newText: string,
): { readonly left: readonly WordSegment[]; readonly right: readonly WordSegment[] } {
  if (oldText === newText) {
    return { left: [{ text: oldText, changed: false }], right: [{ text: newText, changed: false }] };
  }
  const tokenize = (s: string) => s.match(/(\s+|[A-Za-z0-9_$]+|[^A-Za-z0-9_$\s]+)/gu) ?? [];
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length * b.length > 20_000) {
    return { left: [{ text: oldText, changed: true }], right: [{ text: newText, changed: true }] };
  }
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < minLen - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;

  const build = (tokens: readonly string[]): WordSegment[] => {
    const out: WordSegment[] = [];
    const pre = tokens.slice(0, p).join('');
    const mid = tokens.slice(p, tokens.length - s).join('');
    const suf = tokens.slice(tokens.length - s).join('');
    if (pre) out.push({ text: pre, changed: false });
    if (mid) out.push({ text: mid, changed: true });
    if (suf) out.push({ text: suf, changed: false });
    return out;
  };
  return { left: build(a), right: build(b) };
}

/** 将 unified 行列表配对为 Split 并排对比行（P0-1）。 */
export function buildSplitDiffRows(lines: readonly DiffDisplayLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let i = 0;
  let hunkIndex = -1;
  while (i < lines.length) {
    const cur = lines[i]!;
    if (cur.kind === 'hunk') {
      hunkIndex += 1;
      rows.push({ kind: 'hunk', hunkText: cur.text, hunkIndex });
      i += 1;
      continue;
    }
    if (cur.kind === 'context') {
      rows.push({ kind: 'pair', left: cur, right: cur });
      i += 1;
      continue;
    }
    const dels: DiffDisplayLine[] = [];
    const adds: DiffDisplayLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') {
      dels.push(lines[i]!);
      i += 1;
    }
    while (i < lines.length && lines[i]!.kind === 'add') {
      adds.push(lines[i]!);
      i += 1;
    }
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k += 1) {
      rows.push({
        kind: 'pair',
        ...(dels[k] ? { left: dels[k] } : {}),
        ...(adds[k] ? { right: adds[k] } : {}),
      });
    }
  }
  return rows;
}

/** 提取指定 Hunk 的合法 Unified Git Patch，供 `git apply --cached` / `git apply -R` 使用（P0-1）。 */
export function extractHunkPatch(
  filePath: string,
  lines: readonly DiffDisplayLine[],
  targetHunkStartIndex: number,
): string | undefined {
  const header = lines[targetHunkStartIndex];
  if (!header || header.kind !== 'hunk') return undefined;
  const normalized = filePath.replace(/\\/gu, '/').replace(/^\/+/u, '');
  const body: string[] = [];
  for (let i = targetHunkStartIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.kind === 'hunk') break;
    const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    body.push(`${prefix}${line.text}`);
  }
  if (body.length === 0) return undefined;
  return `diff --git a/${normalized} b/${normalized}\n--- a/${normalized}\n+++ b/${normalized}\n${header.text}\n${body.join('\n')}\n`;
}

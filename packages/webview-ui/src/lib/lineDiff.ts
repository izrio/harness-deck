/**
 * 轻量逐行 Diff 计算（HD-25）：用于在手机端内嵌渲染 `pair` 类型的改动前后对比与上下文折叠。
 */

export interface DiffDisplayLine {
  readonly kind: 'hunk' | 'context' | 'add' | 'del';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
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
    // 大改动回退为块级删除+新增，保证手机浏览器不卡顿
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
    if (!inHunk) {
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
        continue;
      }
    }
    if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newLine: inHunk ? newLine++ : undefined });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldLine: inHunk ? oldLine++ : undefined });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'hunk', text: line });
    } else {
      out.push({
        kind: 'context',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldLine: inHunk ? oldLine++ : undefined,
        newLine: inHunk ? newLine++ : undefined,
      });
    }
  }
  return out;
}

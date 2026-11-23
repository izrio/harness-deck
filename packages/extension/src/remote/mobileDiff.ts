/**
 * 移动端内嵌 Diff 与只读文件预览转换器（HD-25）：
 * 复用 `resolveDiffSpec` 与 `lineStats`，并在超过 200KB / 2000 行时截断以防手机浏览器卡顿。
 */
import { basename, extname } from 'node:path';
import type { DiffContentData } from '@harness-deck/shared';
import { lineStats } from '../vm/diffs.ts';
import { resolveDiffSpec, type DiffSideSpec } from '../vm/diffSpec.ts';
import type { DiffRequest } from '../vm/workbench.ts';

const MAX_BYTES = 200_000;
const MAX_LINES = 2_000;

function inferLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase().replace(/^\./u, '');
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    kt: 'kotlin',
    kts: 'kotlin',
    java: 'java',
    rs: 'rust',
    go: 'go',
    json: 'json',
    md: 'markdown',
    mdx: 'markdown',
    css: 'css',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    toml: 'toml',
    xml: 'xml',
  };
  return map[ext] ?? ext;
}

function truncateText(text: string): { readonly text: string; readonly truncated: boolean } {
  let truncated = false;
  let result = text;
  if (Buffer.byteLength(result, 'utf8') > MAX_BYTES) {
    result = Buffer.from(result, 'utf8').subarray(0, MAX_BYTES).toString('utf8');
    truncated = true;
  }
  const lines = result.split('\n');
  if (lines.length > MAX_LINES) {
    result = lines.slice(0, MAX_LINES).join('\n');
    truncated = true;
  }
  return { text: result, truncated };
}

async function resolveSideText(
  side: DiffSideSpec,
  readDiskFile: (path: string) => Promise<string | undefined>,
): Promise<string> {
  if (side.kind === 'virtual') return side.content;
  return (await readDiskFile(side.path)) ?? '';
}

export async function buildMobileDiffContent(
  request: DiffRequest,
  readDiskFile: (path: string) => Promise<string | undefined>,
): Promise<DiffContentData> {
  const spec = await resolveDiffSpec(request, readDiskFile);
  const language = inferLanguage(spec.path);

  if (spec.kind === 'cannotPreview') {
    return {
      path: spec.path,
      title: basename(spec.path),
      ...(language ? { language } : {}),
      kind: 'cannotPreview',
      message: spec.message,
    };
  }

  if (spec.kind === 'unified') {
    const patch = truncateText(spec.patchText);
    return {
      path: spec.path,
      title: basename(spec.path),
      ...(language ? { language } : {}),
      kind: 'unified',
      patchText: patch.text,
      ...(patch.truncated ? { truncated: true } : {}),
    };
  }

  const [rawBefore, rawAfter] = await Promise.all([
    resolveSideText(spec.left, readDiskFile),
    resolveSideText(spec.right, readDiskFile),
  ]);
  const stats = lineStats(rawBefore, rawAfter);
  const before = truncateText(rawBefore);
  const after = truncateText(rawAfter);

  return {
    path: spec.path,
    title: spec.title,
    ...(language ? { language } : {}),
    kind: 'pair',
    before: before.text,
    after: after.text,
    additions: stats.additions,
    deletions: stats.deletions,
    ...(before.truncated || after.truncated ? { truncated: true } : {}),
  };
}

export function buildMobileFileContent(
  path: string,
  content: string | undefined,
  missingMessage = 'File not found',
  options?: { readonly editable?: boolean },
): DiffContentData {
  const language = inferLanguage(path);
  if (content === undefined) {
    return {
      path,
      title: basename(path),
      ...(language ? { language } : {}),
      kind: 'cannotPreview',
      message: missingMessage,
      readonly: true,
    };
  }
  const clipped = truncateText(content);
  const editable = Boolean(options?.editable && !clipped.truncated);
  return {
    path,
    title: basename(path),
    ...(language ? { language } : {}),
    kind: 'file',
    after: clipped.text,
    readonly: !editable,
    ...(editable ? { editable: true } : {}),
    ...(clipped.truncated ? { truncated: true } : {}),
  };
}

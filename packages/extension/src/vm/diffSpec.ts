/**
 * 将控制器的 DiffRequest 解析为与具体 IDE 无关的对比视图描述（双侧内容对比或 Unified Patch 兜底）。
 * VS Code（VscodeWorkbench）与 JetBrains（RemoteWorkbench -> IdeaWorkbench）共用同一套还原逻辑与多语言标题。
 */
import { basename } from 'node:path';
import { t } from '../i18n.ts';
import { proposedContent, reverseHunks, reverseToolDiffs, unifiedFromHunks, unifiedFromToolDiffs } from './diffs.ts';
import type { DiffRequest } from './workbench.ts';

export type DiffSideSpec =
  | { readonly kind: 'disk'; readonly path: string }
  | { readonly kind: 'virtual'; readonly path: string; readonly label: string; readonly content: string };

export type ResolvedDiffSpec =
  | {
      readonly kind: 'pair';
      readonly path: string;
      readonly title: string;
      readonly left: DiffSideSpec;
      readonly right: DiffSideSpec;
    }
  | {
      readonly kind: 'unified';
      readonly path: string;
      readonly patchText: string;
    }
  | {
      readonly kind: 'cannotPreview';
      readonly path: string;
      readonly message: string;
    };

const diskSide = (path: string): DiffSideSpec => ({ kind: 'disk', path });
const virtualSide = (path: string, label: string, content: string): DiffSideSpec => ({ kind: 'virtual', path, label, content });

export async function resolveDiffSpec(
  request: DiffRequest,
  readDiskFile: (path: string) => Promise<string | undefined>,
): Promise<ResolvedDiffSpec> {
  const name = basename(request.path);
  switch (request.kind) {
    case 'tool': {
      if (request.created) {
        return {
          kind: 'pair',
          path: request.path,
          title: t('diff.created', name),
          left: virtualSide(request.path, 'empty', ''),
          right: diskSide(request.path),
        };
      }
      const current = await readDiskFile(request.path);
      const before = current === undefined ? undefined : reverseToolDiffs(current, request.diffs);
      if (before !== undefined) {
        return {
          kind: 'pair',
          path: request.path,
          title: t('diff.toolTitle', name),
          left: virtualSide(request.path, 'before', before),
          right: diskSide(request.path),
        };
      }
      return {
        kind: 'unified',
        path: request.path,
        patchText: unifiedFromToolDiffs(name, request.diffs),
      };
    }
    case 'turn': {
      if (!request.after) {
        const before = reverseHunks('', request.hunks) ?? '';
        return {
          kind: 'pair',
          path: request.path,
          title: t('diff.deleted', name),
          left: virtualSide(request.path, 'before', before),
          right: virtualSide(request.path, 'deleted', ''),
        };
      }
      if (!request.before) {
        return {
          kind: 'pair',
          path: request.path,
          title: t('diff.created', name),
          left: virtualSide(request.path, 'empty', ''),
          right: diskSide(request.path),
        };
      }
      const current = await readDiskFile(request.path);
      const before = current === undefined ? undefined : reverseHunks(current, request.hunks);
      if (before !== undefined) {
        return {
          kind: 'pair',
          path: request.path,
          title: t('diff.turnTitle', name),
          left: virtualSide(request.path, 'before', before),
          right: diskSide(request.path),
        };
      }
      return {
        kind: 'unified',
        path: request.path,
        patchText: unifiedFromHunks(name, request.hunks),
      };
    }
    case 'contents': {
      const right = request.after === undefined ? diskSide(request.path) : virtualSide(request.path, 'after', request.after);
      const title = request.created
        ? t('diff.created', name)
        : t(
            request.scope === 'session'
              ? 'diff.sessionTitle'
              : request.after === undefined
                ? 'diff.turnTitle'
                : 'diff.turnOnlyTitle',
            name,
          );
      return {
        kind: 'pair',
        path: request.path,
        title,
        left: virtualSide(request.path, request.created ? 'empty' : 'before', request.before),
        right,
      };
    }
    case 'proposed': {
      const current = await readDiskFile(request.path);
      const proposed = proposedContent(request.tool, request.args, current);
      if (proposed === undefined) {
        return {
          kind: 'cannotPreview',
          path: request.path,
          message: t('diff.cannotPreview', name),
        };
      }
      const left = current === undefined ? virtualSide(request.path, 'empty', '') : diskSide(request.path);
      return {
        kind: 'pair',
        path: request.path,
        title: t('diff.proposedTitle', name),
        left,
        right: virtualSide(request.path, 'proposed', proposed),
      };
    }
  }
}

/**
 * 处理文件/文件夹选择器返回的路径：
 * 图片文件（PNG/JPEG/WebP/GIF）读取为 base64 后通过 `attachImages` 放入输入框缩略图，
 * 其余文件或文件夹路径固定到编辑器上下文标签中。
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { HostToWebview, ImageMediaType, PromptImage } from '@harness-deck/shared';
import { MAX_IMAGE_BASE64, MAX_IMAGES } from '@harness-deck/shared/limits';
import { t } from '../i18n.ts';
import type { EditorContext } from './EditorContext.ts';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const EXT_TO_MEDIA_TYPE: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

let pickedImageCounter = 0;

export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return EXT_TO_MEDIA_TYPE[extname(filePath).toLowerCase()];
}

export function attachPickedPaths(
  picked: readonly string[] | undefined,
  editorContext: EditorContext,
  deps: {
    readonly post: (message: HostToWebview) => void;
    readonly toast: (level: 'info' | 'error', text: string) => void;
    readonly scheduleRender: () => void;
  },
): void {
  if (!picked || picked.length === 0) return;

  const images: PromptImage[] = [];
  const otherPaths: string[] = [];

  for (const rawPath of picked) {
    const filePath = rawPath.trim();
    if (!filePath) continue;
    const mediaType = imageMediaTypeForPath(filePath);
    if (!mediaType) {
      otherPaths.push(filePath);
      continue;
    }

    let isFile = false;
    let size = 0;
    try {
      const stat = statSync(filePath);
      isFile = stat.isFile();
      size = stat.size;
    } catch {
      deps.toast('error', t('files.imageReadFailed', basename(filePath)));
      continue;
    }

    if (!isFile) {
      otherPaths.push(filePath);
      continue;
    }

    if (size > MAX_IMAGE_BYTES) {
      deps.toast('error', t('files.imageTooLarge', basename(filePath)));
      continue;
    }

    if (images.length >= MAX_IMAGES) {
      deps.toast('error', t('files.imageTooMany', MAX_IMAGES));
      break;
    }

    try {
      const data = readFileSync(filePath).toString('base64');
      if (!data || data.length > MAX_IMAGE_BASE64) {
        deps.toast('error', t('files.imageTooLarge', basename(filePath)));
        continue;
      }
      images.push({
        localId: `picked-${Date.now().toString(36)}-${(++pickedImageCounter).toString(36)}`,
        mediaType,
        data,
        name: basename(filePath),
      });
    } catch {
      deps.toast('error', t('files.imageReadFailed', basename(filePath)));
    }
  }

  const pinned = otherPaths.length > 0 ? editorContext.pinFiles(otherPaths) : 0;
  if (images.length > 0) {
    deps.post({ type: 'attachImages', payload: { images } });
  }
  if (pinned > 0) {
    deps.scheduleRender();
  }
  if (images.length > 0 || pinned > 0) {
    deps.post({ type: 'focusComposer', payload: {} });
  }
}

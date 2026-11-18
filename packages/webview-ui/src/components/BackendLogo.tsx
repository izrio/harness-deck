/**
 * 底层的图标（Beautiful UI Monogram & Tile 风格）。
 */
import type { BackendView } from '@harness-deck/shared';
import { cn } from '../lib/utils.ts';
import claude from '../assets/backends/claude.svg?inline';
import codebuddy from '../assets/backends/codebuddy.png?inline';
import deepseek from '../assets/backends/deepseek.svg?inline';
import ohMyPi from '../assets/backends/oh-my-pi.png?inline';
import opencode from '../assets/backends/opencode.svg?inline';
import zcode from '../assets/backends/zcode.svg?inline';

const LOGOS: Readonly<Record<string, { readonly src: string; readonly tile?: boolean }>> = {
  dsh: { src: deepseek, tile: true },
  pi: { src: ohMyPi },
  'oh-my-pi': { src: ohMyPi },
  codebuddy: { src: codebuddy },
  claude: { src: claude, tile: true },
  opencode: { src: opencode },
  zcode: { src: zcode },
};

export function BackendLogo({ backend, size = 'md' }: { readonly backend: Pick<BackendView, 'id' | 'name'>; readonly size?: 'sm' | 'md' }) {
  const logo = LOGOS[backend.id];
  const sizeCls = size === 'sm' ? 'size-4 rounded-[4px]' : 'size-8.5 rounded-[9px]';
  if (logo) {
    return (
      <span
        className={cn(
          'backend-logo inline-flex shrink-0 items-center justify-center overflow-hidden',
          `backend-logo--${size}`,
          sizeCls,
          logo.tile && cn('backend-logo--tile bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]', size === 'sm' ? 'p-[1px]' : 'p-[5px]'),
        )}
        aria-hidden="true"
        data-logo={backend.id}
      >
        <img src={logo.src} alt="" draggable={false} className="block size-full object-contain" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'backend-logo backend-logo--monogram inline-flex shrink-0 items-center justify-center overflow-hidden bg-ink font-semibold text-canvas',
        `backend-logo--${size}`,
        sizeCls,
        size === 'sm' ? 'text-[8px] tracking-normal' : 'text-[11.5px] tracking-wide',
      )}
      aria-hidden="true"
    >
      {monogram(backend.name)}
    </span>
  );
}

export function monogram(name: string): string {
  const words = name.split(/[\s_-]+/u).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const word = words[0] ?? '?';
  const capitals = word.match(/\p{Lu}/gu) ?? [];
  return (capitals.length >= 2 ? capitals.slice(0, 2).join('') : [...word].slice(0, 2).join('')).toUpperCase();
}

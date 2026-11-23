import { useEffect, useState, type RefObject } from 'react';

/**
 * 离屏动画暂停（P2-10）：当元素滚动出视口时返回 true，用于对 Shimmer / LoaderGrid 施加
 * `data-offscreen="true"` 以设置 `animation-play-state: paused`，降低高刷屏与移动端 GPU 功耗。
 */
export function useOffscreenPause(ref: RefObject<Element | null>): boolean {
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setOffscreen(!entry.isIntersecting);
      },
      { rootMargin: '80px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return offscreen;
}

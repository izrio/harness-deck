import { useEffect, useState } from 'react';

/**
 * 让面板在关闭动画播放完毕后再从 DOM 移除，避免瞬间消失。
 * `shown` 在挂载后的下一帧才置真，从而保证进入动画有起始状态。
 */
export function usePanelPresence(open: boolean, durationMs = 260) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timer);
  }, [open, durationMs]);

  return { mounted, shown };
}

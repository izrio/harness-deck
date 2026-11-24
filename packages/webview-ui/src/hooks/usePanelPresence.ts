import { useEffect, useState } from 'react';

/**
 * 让面板在关闭动画播放完毕后再从 DOM 移除，避免瞬间消失；
 * 打开时使用双帧 `requestAnimationFrame` 确保初始收起态先完成首次绘制，
 * 再切换到展开态，从而在 Chromium / JCEF / Electron 下稳定触发 CSS 进入过渡动画。
 */
export function usePanelPresence(open: boolean, durationMs = 260) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let frame2 = 0;
      const frame1 = requestAnimationFrame(() => {
        frame2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(frame1);
        if (frame2) cancelAnimationFrame(frame2);
      };
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timer);
  }, [open, durationMs]);

  return { mounted, shown };
}

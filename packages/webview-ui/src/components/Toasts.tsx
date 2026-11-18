import { dismissToast, useView } from '../store.ts';
import { useT } from '../i18n.ts';
import { cn } from '../lib/utils.ts';
import { Button } from './ui/Button.tsx';
import { CloseIcon, ErrorIcon, InfoIcon } from './icons.tsx';

/** 提示（Beautiful UI 浮层通知）：普通提示几秒后自动消失；错误一直留着，点右边的 × 关掉。 */
export function Toasts() {
  const toasts = useView((s) => s.toasts);
  const t = useT();
  if (toasts.length === 0) return null;
  return (
    <div className="content-column mb-2 flex flex-col gap-1.5">
      {toasts.map((toast) => {
        const isError = toast.level === 'error';
        return (
          <div
            key={toast.id}
            role={isError ? 'alert' : 'status'}
            style={{ animation: 'pop-in 200ms cubic-bezier(0.23,1,0.32,1) both' }}
            className={cn(
              'toast flex items-center gap-2.5 rounded-card bg-surface px-3 py-2 text-left text-[12.5px] text-ink shadow-overlay',
              isError && 'toast--error',
            )}
          >
            <span
              className={cn(
                'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
                isError ? 'bg-red-tint text-red' : 'bg-accent-tint text-accent-ink',
              )}
            >
              {isError ? <ErrorIcon className="size-3.5" /> : <InfoIcon className="size-3.5" />}
            </span>
            <span className="toast__text min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{toast.text}</span>
            <Button
              variant="quiet"
              size="icon"
              className="toast__close -mr-1 text-ink-3 hover:text-ink"
              onClick={() => dismissToast(toast.id)}
              aria-label={t('toast.close')}
              title={t('toast.close')}
            >
              <CloseIcon className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

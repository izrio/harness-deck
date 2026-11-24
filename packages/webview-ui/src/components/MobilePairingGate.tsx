/**
 * 手机浏览器未配对拦截页（HD-23）：
 * - 扫码携带 `#code=` 一次码时自动完成配对连接，无需再次手动点击
 * - 若自动配对失败（过期/无效）或直接打开页面，平滑回退为手动输入表单
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '../i18n.ts';
import { detectDefaultDeviceName, pairWithHost, useTransportState } from '../vscode.ts';
import { HarnessDeckLogo } from './HarnessDeckLogo.tsx';
import { QrCodeIcon, SpinnerIcon } from './icons.tsx';

export function MobilePairingGate() {
  const t = useT();
  const transport = useTransportState();
  const [code, setCode] = useState(() => transport.pendingPairCode ?? '');
  const [deviceName, setDeviceName] = useState(() => detectDefaultDeviceName());
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | undefined>();
  const autoPairedCodeRef = useRef<string | undefined>(undefined);

  const formatError = (reason: string, remainingAttempts?: number): string => {
    switch (reason) {
      case 'expired':
        return t('mobile.pair.errExpired');
      case 'locked':
        return t('mobile.pair.errLocked');
      case 'missing':
        return t('mobile.pair.errMissing');
      case 'invalid':
        return t('mobile.pair.errInvalid', remainingAttempts ?? 0);
      default:
        return reason;
    }
  };

  useEffect(() => {
    const incoming = transport.pendingPairCode;
    if (!incoming || autoPairedCodeRef.current === incoming) return;
    autoPairedCodeRef.current = incoming;
    setCode(incoming);
    setSubmitting(true);
    setErrorText(undefined);
    void pairWithHost(incoming, detectDefaultDeviceName()).then((res) => {
      setSubmitting(false);
      if (!res.ok) {
        setErrorText(formatError(res.reason, res.remainingAttempts));
      }
    });
  }, [transport.pendingPairCode]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setErrorText(undefined);
    const res = await pairWithHost(code, deviceName);
    setSubmitting(false);
    if (!res.ok) {
      setErrorText(formatError(res.reason, res.remainingAttempts));
    }
  };

  return (
    <div
      className="flex min-h-dvh flex-1 items-center justify-center bg-canvas px-4 py-6"
      data-testid="mobile-pairing-gate"
    >
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-2xl bg-field/55 p-6 dark:bg-surface/70">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="mb-1">
            <HarnessDeckLogo />
          </div>
          <h1 className="m-0 flex items-center gap-1.5 text-[15px] font-semibold text-ink">
            <QrCodeIcon className="size-4 text-accent-ink" />
            <span>{t('mobile.pair.title')}</span>
          </h1>
          <p className="m-0 text-[12px] leading-relaxed text-ink-3">{t('mobile.pair.subtitle')}</p>
        </div>

        <form className="flex flex-col gap-3.5" onSubmit={(e) => void onSubmit(e)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pair-code-input" className="text-[12px] text-ink-2">
              {t('mobile.pair.codeLabel')}
            </Label>
            <Input
              id="pair-code-input"
              size="sm"
              data-testid="mobile-pair-code-input"
              className="font-mono"
              value={code}
              placeholder={t('mobile.pair.codePlaceholder')}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pair-device-input" className="text-[12px] text-ink-2">
              {t('mobile.pair.deviceLabel')}
            </Label>
            <Input
              id="pair-device-input"
              size="sm"
              data-testid="mobile-pair-device-input"
              value={deviceName}
              placeholder={t('mobile.pair.devicePlaceholder')}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </div>
          {errorText ? (
            <p
              className="m-0 rounded-xl bg-red-tint px-3 py-2 text-[12px] text-red"
              role="alert"
              data-testid="mobile-pair-error"
            >
              {errorText}
            </p>
          ) : null}
          <Button type="submit" size="sm" data-testid="mobile-pair-submit" disabled={!code.trim() || submitting}>
            {submitting ? <SpinnerIcon className="size-3.5" /> : null}
            <span>{submitting ? t('mobile.pair.connecting') : t('mobile.pair.submit')}</span>
          </Button>
        </form>
      </div>
    </div>
  );
}

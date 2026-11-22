/**
 * 手机浏览器未配对拦截页（HD-23）：
 * 自动读取 URL `#code=` 一次码（已在 transport 启动时从地址栏擦除），并支持手动输入配对码与设备名称。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

  useEffect(() => {
    if (transport.pendingPairCode && !code) {
      setCode(transport.pendingPairCode);
    }
  }, [transport.pendingPairCode, code]);

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
      <Card className="w-full max-w-sm shadow-raised">
        <CardHeader className="items-center text-center">
          <div className="mb-1">
            <HarnessDeckLogo />
          </div>
          <CardTitle className="flex items-center gap-1.5 text-[15px]">
            <QrCodeIcon className="size-4 text-accent-ink" />
            <span>{t('mobile.pair.title')}</span>
          </CardTitle>
          <CardDescription className="text-[12px] leading-relaxed">{t('mobile.pair.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pair-code-input" className="text-[12px]">
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
              <Label htmlFor="pair-device-input" className="text-[12px]">
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
              <p className="m-0 rounded-control bg-red-tint px-2.5 py-2 text-[12px] text-red" role="alert" data-testid="mobile-pair-error">
                {errorText}
              </p>
            ) : null}
            <Button type="submit" size="sm" data-testid="mobile-pair-submit" disabled={!code.trim() || submitting}>
              {submitting ? <SpinnerIcon className="size-3.5" /> : null}
              <span>{submitting ? t('mobile.pair.connecting') : t('mobile.pair.submit')}</span>
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

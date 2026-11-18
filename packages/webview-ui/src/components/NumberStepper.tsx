import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';

/** 「− 数值 +」步进器：只组合 shadcn-ui 的 Button / ButtonGroup。 */
export function NumberStepper({
  decLabel,
  incLabel,
  decDisabled,
  incDisabled,
  onDec,
  onInc,
  valueTestId,
  children,
}: {
  decLabel: string;
  incLabel: string;
  decDisabled?: boolean;
  incDisabled?: boolean;
  onDec: () => void;
  onInc: () => void;
  valueTestId?: string;
  children: ReactNode;
}) {
  return (
    <ButtonGroup>
      <Button type="button" variant="outline" size="icon-xs" aria-label={decLabel} disabled={decDisabled} onClick={onDec}>
        −
      </Button>
      <ButtonGroupText className="min-w-13 justify-center px-2 font-mono text-[12px] tabular-nums" data-testid={valueTestId}>
        {children}
      </ButtonGroupText>
      <Button type="button" variant="outline" size="icon-xs" aria-label={incLabel} disabled={incDisabled} onClick={onInc}>
        +
      </Button>
    </ButtonGroup>
  );
}

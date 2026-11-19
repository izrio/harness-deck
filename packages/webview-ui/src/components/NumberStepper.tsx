import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
import { cn } from '../lib/utils.ts';

/** 「− 数值 +」步进器：只组合 shadcn-ui 的 Button / ButtonGroup，支持统一 xs / sm / default 高度档位。 */
export function NumberStepper({
  size = 'xs',
  decLabel,
  incLabel,
  decDisabled,
  incDisabled,
  onDec,
  onInc,
  valueTestId,
  children,
}: {
  size?: 'xs' | 'sm' | 'default';
  decLabel: string;
  incLabel: string;
  decDisabled?: boolean;
  incDisabled?: boolean;
  onDec: () => void;
  onInc: () => void;
  valueTestId?: string;
  children: ReactNode;
}) {
  const buttonSize = size === 'default' ? 'icon' : size === 'sm' ? 'icon-sm' : 'icon-xs';
  return (
    <ButtonGroup data-size={size}>
      <Button type="button" variant="outline" size={buttonSize} aria-label={decLabel} disabled={decDisabled} onClick={onDec}>
        −
      </Button>
      <ButtonGroupText
        className={cn(
          'min-w-13 justify-center px-2 font-mono text-[12px] tabular-nums',
          size === 'default' ? 'h-9' : size === 'sm' ? 'h-8' : 'h-6',
        )}
        data-testid={valueTestId}
      >
        {children}
      </ButtonGroupText>
      <Button type="button" variant="outline" size={buttonSize} aria-label={incLabel} disabled={incDisabled} onClick={onInc}>
        +
      </Button>
    </ButtonGroup>
  );
}

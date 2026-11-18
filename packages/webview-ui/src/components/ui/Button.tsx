import type { ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.ts';

const filledShadow = 'shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]';

/**
 * Beautiful UI Button：与组件库完全一致的胶囊形按钮变体、阴影与按压微缩放反馈。
 */
export const buttonVariants = cva(
  `inline-flex items-center justify-center font-medium select-none shrink-0
   transition-[transform,background-color,color,opacity,box-shadow] duration-150 ease-out
   active:scale-[0.96] disabled:opacity-50 disabled:pointer-events-none`,
  {
    variants: {
      variant: {
        primary: `bg-ink text-canvas hover:opacity-90 dark:bg-ink dark:text-canvas ${filledShadow}`,
        secondary: 'bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover',
        ghost: 'bg-hover-2 text-ink hover:bg-line-strong',
        accent: `bg-accent text-white hover:bg-accent-ink ${filledShadow}`,
        success: `bg-green text-white hover:brightness-95 ${filledShadow}`,
        danger: 'bg-red-tint text-red shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_28%,transparent)] hover:brightness-95',
        quiet: 'text-ink hover:bg-hover',
      },
      size: {
        xs: 'h-7 rounded-full px-2.5 text-[12px] font-normal leading-none gap-1',
        sm: 'h-[27px] rounded-full px-3 text-[13px] leading-none gap-1.5',
        md: 'px-4 py-[9px] text-sm leading-none rounded-full gap-2',
        icon: 'size-6.5 rounded-[6px] p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;

export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

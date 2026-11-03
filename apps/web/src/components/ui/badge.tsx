import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  cn(
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full border border-transparent',
    'text-label-xs px-2 py-[3px] font-medium whitespace-nowrap',
    '[&>svg]:pointer-events-none [&>svg]:size-3',
  ),
  {
    variants: {
      variant: {
        brand: 'bg-brand-soft border-brand-border text-brand-text',
        danger: 'bg-danger-soft text-danger',
        info: 'bg-info-soft text-info',
        muted: 'bg-muted text-subdued',
        neutral: 'bg-neutral-soft text-neutral',
        outline: 'border-line text-subdued',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
      },
    },
    defaultVariants: {
      variant: 'brand',
    },
  },
);

function Badge({
  asChild = false,
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ className, variant }))} {...props} />
  );
}

export { Badge, badgeVariants };

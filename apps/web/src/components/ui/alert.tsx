import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  cn(
    'relative grid w-full grid-cols-[0_1fr] items-start gap-y-[3px] rounded-lg px-3 py-[11px]',
    'has-[>svg]:grid-cols-[1rem_1fr] has-[>svg]:gap-x-[10px]',
    '[&>svg]:size-4 [&>svg]:translate-y-px [&>svg]:text-current',
  ),
  {
    variants: {
      variant: {
        danger: 'bg-danger-soft text-danger',
        warning: 'bg-warning-soft text-warning',
        success: 'bg-success-soft text-success',
        muted: 'bg-subtle border-line-subtle text-faint border',
      },
    },
    defaultVariants: {
      variant: 'muted',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>): React.JSX.Element {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ className, variant }))}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="alert-title"
      className={cn('text-label-sm col-start-2 font-medium', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="alert-description"
      className={cn('text-caption text-subdued col-start-2', className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };

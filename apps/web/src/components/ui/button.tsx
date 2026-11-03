import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap',
    // `transition` takes the motion tokens' defaults; the press is a 2% dip, not a bounce.
    'text-label-md transition duration-(--duration-fast) outline-none active:scale-[0.98]',
    'disabled:pointer-events-none disabled:opacity-60',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        default: cn(
          'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85',
          'disabled:bg-muted disabled:text-faint disabled:opacity-100',
        ),
        outline: 'border-line bg-raised text-foreground hover:bg-subtle active:bg-muted border',
        ghost: 'text-subdued hover:bg-muted hover:text-foreground',
        link: 'text-brand-text rounded-sm underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[46px] px-4',
        sm: 'text-label-sm h-8 gap-1.5 px-3',
        icon: 'size-8 rounded-full',
        inline: 'h-auto p-0',
      },
    },
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
  },
);

function Button({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ className, size, variant }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

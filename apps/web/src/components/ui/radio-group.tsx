import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>): React.JSX.Element {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('flex gap-3', className)}
      {...props}
    />
  );
}

/**
 * Deliberately unstyled beyond the reset: the design makes whole cards
 * selectable, so callers own the layout and `RadioGroupDot` reads the checked
 * state back off this element's `group`.
 */
function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>): React.JSX.Element {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn('group cursor-default text-left outline-none', className)}
      {...props}
    />
  );
}

function RadioGroupDot({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="radio-group-dot"
      aria-hidden="true"
      className={cn(
        'border-line block size-[19px] shrink-0 rounded-full border transition-colors',
        'group-data-[state=checked]:border-brand group-data-[state=checked]:bg-brand',
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupDot, RadioGroupItem };

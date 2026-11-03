import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  children,
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>): React.JSX.Element {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'border-line bg-canvas text-body-md text-foreground flex h-[46px] w-full items-center',
        'gap-2.5 rounded-lg border px-[13px] text-left transition-[border-color] outline-none',
        'focus-visible:border-ring data-[placeholder]:text-faint',
        'disabled:cursor-not-allowed disabled:opacity-60',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[15px]",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-faint ml-auto" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  children,
  className,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>): React.JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={6}
        className={cn(
          'bg-raised border-line shadow-modal z-50 overflow-hidden rounded-xl border py-[7px]',
          'w-(--radix-select-trigger-width) max-h-(--radix-select-content-available-height)',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="flex flex-col gap-px">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  children,
  className,
  description,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
  description?: string;
}): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'flex cursor-default items-center gap-2.5 px-[13px] py-[9px] outline-none select-none',
        'transition-colors data-[highlighted]:bg-muted data-[state=checked]:bg-brand-soft',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {/* `ItemText` holds bare text so the trigger inherits the trigger's own
          type scale rather than this row's. */}
      <span className="min-w-0 flex-1">
        <span className="text-label-sm text-foreground block font-medium">
          <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </span>
        {description ? <span className="text-caption text-faint block">{description}</span> : null}
      </span>
      <SelectPrimitive.ItemIndicator asChild>
        <CheckIcon className="text-brand size-[15px] shrink-0" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };

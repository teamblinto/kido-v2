import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface TextFieldProps extends Omit<React.ComponentProps<'input'>, 'id'> {
  /** Leading icon rendered inside the control. */
  icon: LucideIcon;
  label: string;
  /** Rendered opposite the label, e.g. a "Forgot password?" link. */
  labelAction?: React.ReactNode;
  /** Validation message announced to assistive technology when set. */
  message?: React.ReactNode;
  /** Rendered inside the control against the trailing edge. */
  trailing?: React.ReactNode;
}

/** Labelled text input with the leading icon treatment used across the auth screens. */
export function TextField({
  className,
  icon: Icon,
  label,
  labelAction,
  message,
  trailing,
  ...props
}: TextFieldProps): React.JSX.Element {
  const id = useId();
  const messageId = `${id}-message`;

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {labelAction}
      </div>
      <div className="relative mt-[7px]">
        <Icon
          className="text-faint pointer-events-none absolute top-1/2 left-[13px] size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          id={id}
          aria-describedby={message ? messageId : undefined}
          className={cn('pl-[39px]', trailing && 'pr-[39px]', className)}
          {...props}
        />
        {trailing ? (
          <div className="absolute top-1/2 right-[13px] flex -translate-y-1/2 items-center">
            {trailing}
          </div>
        ) : null}
      </div>
      {message ? (
        <div id={messageId} className="mt-[7px]">
          {message}
        </div>
      ) : null}
    </div>
  );
}

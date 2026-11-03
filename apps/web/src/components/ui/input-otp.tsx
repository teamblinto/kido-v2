import { OTPInput, OTPInputContext } from 'input-otp';
import { useContext } from 'react';

import { cn } from '@/lib/utils';

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}): React.JSX.Element {
  return (
    <OTPInput
      data-slot="input-otp"
      containerClassName={cn('flex items-center gap-[9px]', containerClassName)}
      // The hidden input sits over the slots; the active slot border is the
      // visible focus indicator, so suppress the global outline here.
      className={cn('outline-none disabled:cursor-not-allowed', className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="input-otp-group"
      className={cn('flex flex-1 items-center gap-[9px]', className)}
      {...props}
    />
  );
}

function InputOTPSlot({
  className,
  index,
  ...props
}: React.ComponentProps<'div'> & {
  index: number;
}): React.JSX.Element {
  const inputOTPContext = useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        'border-line bg-canvas text-heading-lg relative flex h-14 flex-1 items-center justify-center',
        'rounded-lg border font-semibold transition-[border-color,box-shadow] outline-none',
        'data-[active=true]:border-ring data-[active=true]:z-10 data-[active=true]:border-[1.6px]',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="bg-foreground animate-caret-blink h-6 w-px" />
        </div>
      ) : null}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };

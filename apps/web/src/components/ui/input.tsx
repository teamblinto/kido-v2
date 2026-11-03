import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>): React.JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'border-line bg-canvas text-body-md text-foreground h-[46px] w-full min-w-0 rounded-lg border px-[13px]',
        // The focus ring itself comes from the global :focus-visible outline.
        'placeholder:text-faint transition-[border-color] outline-none focus-visible:border-ring',
        'aria-invalid:border-destructive',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export { Input };

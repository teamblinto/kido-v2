import { cn } from '@/lib/utils';

/** A keycap. Decorative next to the label it belongs to, so it is not focusable. */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted border-line-subtle text-mono-sm text-faint inline-flex items-center',
        'justify-center rounded-[5px] border px-1.5 py-0.5 font-mono',
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };

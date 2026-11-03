import type { LucideIcon } from 'lucide-react';

/** Small legal or reassurance copy sitting under the primary action. */
export function FinePrint({
  children,
  icon: Icon,
}: {
  children: React.ReactNode;
  icon?: LucideIcon;
}): React.JSX.Element {
  return (
    <p className="text-caption text-faint flex items-start gap-[7px]">
      {Icon ? <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : null}
      <span>{children}</span>
    </p>
  );
}

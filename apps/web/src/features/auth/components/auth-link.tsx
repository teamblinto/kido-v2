import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';

/** Inline navigation link styled with the brand link colour. */
export function AuthLink({
  children,
  className,
  state,
  to,
}: {
  children: React.ReactNode;
  className?: string;
  /** Router state to carry along — spec 031 forwards sign-in's return address to sign-up. */
  state?: unknown;
  to: string;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      state={state}
      className={cn(
        'text-label-sm text-brand-text rounded-sm font-medium hover:underline',
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** "Back to sign in" affordance used on the reset and two-factor screens. */
export function BackToSignInLink({ to }: { to: string }): React.JSX.Element {
  return (
    <AuthLink to={to} className="inline-flex items-center gap-1.5">
      Back to sign in
      <ChevronRight className="size-3.5" aria-hidden="true" />
    </AuthLink>
  );
}

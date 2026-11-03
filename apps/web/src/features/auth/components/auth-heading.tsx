import type { LucideIcon } from 'lucide-react';

import { Wordmark } from '@/components/wordmark';
import { cn } from '@/lib/utils';

type BadgeTone = 'brand' | 'danger' | 'success';

const badgeTones: Record<BadgeTone, string> = {
  brand: 'bg-brand-soft text-brand rounded-[14px] size-[52px]',
  danger: 'bg-danger-soft text-danger rounded-full size-14',
  success: 'bg-success-soft text-success rounded-full size-14',
};

interface AuthHeadingProps {
  /** Optional status badge shown between the wordmark and the title. */
  badge?: { icon: LucideIcon; tone?: BadgeTone };
  description?: React.ReactNode;
  title: string;
}

/** Wordmark, optional status badge, page title and supporting copy. */
export function AuthHeading({ badge, description, title }: AuthHeadingProps): React.JSX.Element {
  const BadgeIcon = badge?.icon;
  const tone = badge?.tone ?? 'brand';

  return (
    <header>
      <Wordmark />
      {BadgeIcon ? (
        <span className={cn('mt-[38px] flex items-center justify-center', badgeTones[tone])}>
          <BadgeIcon className={tone === 'brand' ? 'size-6' : 'size-7'} aria-hidden="true" />
        </span>
      ) : null}
      <h1
        className={cn(
          'text-heading-xl text-foreground font-semibold',
          BadgeIcon ? 'mt-6' : 'mt-[30px]',
        )}
      >
        {title}
      </h1>
      {description ? <p className="text-body-md text-subdued mt-2">{description}</p> : null}
    </header>
  );
}

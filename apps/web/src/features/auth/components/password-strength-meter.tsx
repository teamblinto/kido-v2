import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PasswordScore } from '../lib/password';

const segmentTone: Record<Exclude<PasswordScore, 0>, string> = {
  1: 'bg-danger',
  2: 'bg-warning',
  3: 'bg-brand',
  4: 'bg-success',
};

interface PasswordStrengthMeterProps {
  message: string;
  score: PasswordScore;
}

/** Four-segment strength meter with its supporting hint. */
export function PasswordStrengthMeter({
  message,
  score,
}: PasswordStrengthMeterProps): React.JSX.Element {
  const isStrong = score === 4;

  return (
    <div>
      <div className="flex gap-[5px] pt-[3px]" role="presentation">
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={cn(
              'h-1 flex-1 rounded-sm transition-colors',
              segment <= score && score > 0 ? segmentTone[score as 1 | 2 | 3 | 4] : 'bg-line',
            )}
          />
        ))}
      </div>
      <p
        className={cn(
          'text-caption mt-[7px] flex items-center gap-1.5',
          isStrong ? 'text-success' : 'text-subdued',
        )}
      >
        {isStrong ? <Check className="size-[13px] shrink-0" aria-hidden="true" /> : null}
        {message}
      </p>
    </div>
  );
}

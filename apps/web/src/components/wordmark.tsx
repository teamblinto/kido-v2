import { Zap } from 'lucide-react';

import { cn } from '@/lib/utils';

/** The BAIOS lockup: mark plus wordmark. */
export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <span className="bg-brand flex size-[30px] items-center justify-center rounded-[9px]">
        <Zap className="size-[17px] text-white" aria-hidden="true" />
      </span>
      <span className="text-heading-md text-foreground font-semibold">BAIOS</span>
    </span>
  );
}

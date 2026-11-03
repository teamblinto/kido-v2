import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { runPhases } from '../lib/run-phase';
import type { RunPhase } from '../types';

interface RunStatusChipProps {
  className?: string;
  phase: RunPhase;
}

/**
 * The run's phase as a dot-and-label pill. The same chip appears in the topbar
 * and on the preview's address bar, so the wording can never drift between them.
 */
export function RunStatusChip({ className, phase }: RunStatusChipProps): React.JSX.Element {
  const { isLive, label, tone } = runPhases[phase];

  return (
    <Badge variant={tone} className={cn('gap-1.5 py-1 pr-2.5 pl-2', className)}>
      <span
        className={cn('size-1.5 rounded-full bg-current', isLive && 'animate-breathe')}
        aria-hidden="true"
      />
      {label}
    </Badge>
  );
}

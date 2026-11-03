import type { WakeResponse } from '@repo/contracts';
import { AlertTriangleIcon, Loader2Icon, MoonIcon } from 'lucide-react';

import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';

interface AsleepPaneProps {
  /**
   * What the sandbox says it is doing, or `null` when it is doing nothing.
   *
   * Non-null is the whole "in flight" signal: the wake endpoint answers with a reason, so a pane
   * that watched `isPending` instead would snap back to an idle Wake button the moment the request
   * resolved — while the sandbox is still coming up.
   */
  because: WakeResponse['because'];
  className?: string;
  /** Whatever the wake attempt threw, if it threw. */
  error?: unknown;
  /** Ask the sandbox to wake. The parent owns the mutation. */
  onWake: () => void;
}

/**
 * What a stage shows when the sandbox behind it is asleep.
 *
 * Presentational on purpose: the Code stage and the Preview stage both land here, and a component
 * that owned the wake mutation would give them two separate ones — two in-flight states, two
 * refusals, and a button that goes idle in one pane while the other is still waking. The parent
 * holds the mutation and passes its state down.
 */
export function AsleepPane({
  because,
  className,
  error,
  onWake,
}: AsleepPaneProps): React.JSX.Element {
  const isWaking = because !== null;

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      <MoonIcon className="text-faint size-6" aria-hidden="true" />
      <p className="text-label-md text-subdued font-medium">This project is asleep</p>

      {error === undefined ? null : (
        <Alert variant="danger" className="max-w-[380px] text-left">
          <AlertTriangleIcon />
          <AlertTitle>{messageFor(error, 'The project could not be woken.')}</AlertTitle>
        </Alert>
      )}

      <Button type="button" variant="outline" size="sm" disabled={isWaking} onClick={onWake}>
        {isWaking ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
        {isWaking ? 'Waking…' : 'Wake'}
      </Button>

      {/* The button's own label changes, but a disabled control is skipped by some screen readers,
          so the waiting state is announced from a live region that is never disabled. */}
      <p role="status" aria-live="polite" className="sr-only">
        {isWaking ? 'Waking…' : ''}
      </p>
    </div>
  );
}

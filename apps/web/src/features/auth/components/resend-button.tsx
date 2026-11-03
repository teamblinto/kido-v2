import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCountdown } from '../hooks/use-countdown';

interface ResendButtonProps {
  /** Label once the cooldown has elapsed. */
  idleLabel: string;
  /** Whether a send is in flight. Held by the caller, which owns the mutation. */
  isPending?: boolean;
  /**
   * Ask the API to send another mail.
   *
   * The cooldown restarts whether or not this succeeds, and deliberately: the API throttles resends
   * per address and per IP, and a button that re-enabled itself on failure would invite the user to
   * spend that budget on requests already being refused.
   */
  onResend?: () => void;
  /** Label while the cooldown is running, given the formatted time left. */
  pendingLabel: (timeLeft: string) => string;
  /** Cooldown length in seconds. Pass 0 to start enabled. */
  seconds?: number;
}

/** Primary action that re-sends an email, rate limited by a visible cooldown. */
export function ResendButton({
  idleLabel,
  isPending = false,
  onResend,
  pendingLabel,
  seconds = 47,
}: ResendButtonProps): React.JSX.Element {
  const countdown = useCountdown(seconds);

  return (
    <>
      <Button
        type="button"
        className="w-full"
        disabled={countdown.isRunning || isPending}
        onClick={() => {
          countdown.restart();
          onResend?.();
        }}
      >
        {isPending ? (
          <Loader2 className="size-[15px] animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-[15px]" aria-hidden="true" />
        )}
        {countdown.isRunning ? pendingLabel(countdown.formatted) : idleLabel}
      </Button>
      {/*
        Announce only when the cooldown ends. Marking the visible label as a live
        region would make a screen reader read the countdown every second.
      */}
      <span role="status" className="sr-only">
        {countdown.isRunning ? '' : `${idleLabel} is available.`}
      </span>
    </>
  );
}

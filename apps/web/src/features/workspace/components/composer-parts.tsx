import { ArrowUpIcon, PlugIcon, SquareIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CONNECT_SUBSCRIPTION_PATH } from './model-picker';

/**
 * The composer's one primary button: Send, which becomes Stop while a run is live. Disabled, it
 * says why in a tooltip — on a focusable wrapper, since a disabled button takes no hover or focus.
 */
export function ComposerPrimaryAction({
  className,
  disabledReason,
  isRunning = false,
  isStopping = false,
  label = 'Send',
  onStop,
}: {
  readonly className?: string;
  /** Why Send cannot be pressed; `undefined` when it can. */
  readonly disabledReason?: string | undefined;
  readonly isRunning?: boolean;
  /** A stop was asked for and the run has not stopped yet: the control says so and waits. */
  readonly isStopping?: boolean;
  readonly label?: string;
  readonly onStop?: () => void;
}): React.JSX.Element {
  if (isRunning) {
    return (
      <button
        key="stop"
        type="button"
        onClick={onStop}
        disabled={isStopping}
        className={cn(
          'bg-danger-soft text-danger text-label-sm hover:bg-danger-soft/70 flex items-center',
          'animate-in fade-in-0 zoom-in-95 gap-1.5 rounded-full px-[11px] py-[7px] font-medium',
          'transition-[background-color,transform] active:scale-95',
          'disabled:hover:bg-danger-soft disabled:opacity-60',
          className,
        )}
      >
        <SquareIcon className="size-3 fill-current" aria-hidden="true" />
        {isStopping ? 'Stopping…' : 'Stop'}
      </button>
    );
  }

  const button = (
    <button
      key="send"
      type="submit"
      disabled={disabledReason !== undefined}
      className={cn(
        'bg-primary text-primary-foreground hover:bg-primary/90 flex size-8 shrink-0 items-center',
        'animate-in fade-in-0 zoom-in-95 justify-center rounded-full',
        'transition-[opacity,transform] active:scale-90 disabled:opacity-35',
        className,
      )}
    >
      <ArrowUpIcon className="size-[15px]" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );

  if (disabledReason === undefined) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-full">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

/** Said instead of sending when nothing can pay for a run: a way forward, never an error. */
export const CONNECT_TO_SEND = 'Connect your Claude subscription to send this';

/**
 * Nothing can pay for a run — no connected Claude subscription and no API key in the catalogue
 * (or the API said `subscription-not-connected`). The way forward, inline, where Send would be.
 */
export function ConnectToPay({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'bg-brand-soft border-brand-border text-body-sm flex items-start gap-2.5 rounded-xl border',
        'animate-in fade-in-0 slide-in-from-bottom-1 px-3.5 py-3',
        className,
      )}
    >
      <PlugIcon className="text-brand-text mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-foreground">
          Runs are paid by your own Claude subscription or an API key. Neither is set up yet.
        </p>
        <p className="text-subdued text-caption">
          <Link
            to={CONNECT_SUBSCRIPTION_PATH}
            className="text-brand-text font-medium underline-offset-4 hover:underline"
          >
            Connect your Claude subscription
          </Link>{' '}
          — or ask an admin to add an API key.
        </p>
      </div>
    </div>
  );
}

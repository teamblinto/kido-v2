import type { SubscriptionUsageWindow } from '@repo/contracts';
import { Loader2 } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useNow } from '@/hooks/use-now';
import { messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useSubscriptions } from '../subscription/subscription-api';
import { WINDOW_LABEL, formatResetsIn, formatUpdatedAgo } from './usage-format';

/** The connected Claude plan's own limits, one meter per window the CLI reported. */
export function SubscriptionLimits(): React.JSX.Element {
  const id = useId();
  const list = useSubscriptions();
  const now = useNow();
  const status = list.data?.claude;
  const usage = status?.state === 'connected' ? status.usage : null;

  return (
    <section aria-labelledby={`${id}-heading`} className="border-line mt-6 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={`${id}-heading`} className="text-heading-sm font-semibold">
          Subscription limits
          {status?.state === 'connected' && status.plan !== null ? (
            <span className="text-subdued font-normal"> · Claude {status.plan}</span>
          ) : null}
        </h2>
        {usage === null ? null : (
          <p className="text-caption text-faint">{formatUpdatedAgo(usage.checkedAt, now)}</p>
        )}
      </div>

      {list.isPending ? (
        <div className="mt-3 flex items-center gap-2" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-4 animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : list.isError ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-body-sm text-danger" role="alert">
            {messageFor(list.error, 'Your subscription limits could not be loaded.')}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void list.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : status?.state !== 'connected' ? (
        <p className="text-body-sm text-subdued mt-2">
          No Claude subscription is connected.{' '}
          <Link
            to={`${routes.accountSettings}#claude-subscription`}
            className="text-brand-text font-medium underline-offset-4 hover:underline"
          >
            Connect your subscription
          </Link>{' '}
          to run on your own plan and see its limits here.
        </p>
      ) : usage === null || usage.windows.length === 0 ? (
        <p className="text-body-sm text-subdued mt-2">
          No usage reported yet. Your limits appear here after your subscription&apos;s first run.
        </p>
      ) : (
        <ul className="mt-4 grid gap-4">
          {usage.windows.map((entry) => (
            <UsageMeter key={entry.kind} entry={entry} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UsageMeter({
  now,
  entry,
}: {
  readonly now: number;
  readonly entry: SubscriptionUsageWindow;
}): React.JSX.Element {
  const id = useId();
  const used = Math.round(entry.utilization);
  const resets = entry.resetsAt === null ? null : formatResetsIn(entry.resetsAt, now);

  return (
    <li className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span id={`${id}-label`} className="text-label-sm font-medium">
          {WINDOW_LABEL[entry.kind]}
        </span>
        <span className="text-caption text-subdued tabular-nums">{used}% used</span>
      </div>
      <Progress
        aria-labelledby={`${id}-label`}
        value={used}
        getValueLabel={(value) => `${String(value)}% used${resets === null ? '' : `, ${resets}`}`}
        className={cn(
          'h-1.5',
          // The bar turns to a warning as the window runs out, and danger once it has.
          used >= 100 ? '*:bg-danger' : used >= 80 ? '*:bg-warning' : undefined,
        )}
      />
      {resets === null ? null : <span className="text-caption text-faint">{resets}</span>}
    </li>
  );
}

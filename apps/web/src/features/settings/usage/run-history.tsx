import { Loader2 } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/api/problem';
import { useUsageRuns } from './usage-api';
import {
  PAID_WITH_LABEL,
  formatCost,
  formatRunDate,
  formatRunStatus,
  formatTokens,
} from './usage-format';

/** Every run the caller started in this organisation, what paid for it and what it spent. */
export function RunHistory({ orgId }: { readonly orgId: string }): React.JSX.Element {
  const id = useId();
  const query = useUsageRuns(orgId);
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-8">
      <h2 id={`${id}-heading`} className="text-heading-sm font-semibold">
        Run history
      </h2>

      {query.isPending ? (
        <div className="mt-3 flex items-center gap-2" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-4 animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : query.isError && runs.length === 0 ? (
        <RetryLine
          message={messageFor(query.error, 'Your run history could not be loaded.')}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : runs.length === 0 ? (
        <p className="text-body-sm text-subdued mt-2">
          No runs yet. Each run you start appears here with what it used.
        </p>
      ) : (
        <>
          <div className="border-line mt-3 overflow-x-auto rounded-lg border">
            <table className="text-body-sm w-full border-collapse text-left">
              <caption className="sr-only">Your runs in this organisation, newest first</caption>
              <thead className="bg-subtle text-label-xs text-subdued">
                <tr>
                  {[
                    'Date',
                    'Project',
                    'Model',
                    'Paid with',
                    'Tokens in / out',
                    'Cost',
                    'Status',
                  ].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-3 py-2 font-medium whitespace-nowrap"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const cache = run.cacheReadTokens + run.cacheWriteTokens;

                  return (
                    <tr key={run.id} className="border-line-subtle border-t">
                      <th scope="row" className="px-3 py-2 font-normal whitespace-nowrap">
                        {formatRunDate(run.createdAt)}
                      </th>
                      <td className="max-w-[160px] truncate px-3 py-2">{run.projectName}</td>
                      <td className="text-subdued px-3 py-2 whitespace-nowrap">
                        {run.model ?? '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {PAID_WITH_LABEL[run.paidWith]}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {formatTokens(run.inputTokens)} / {formatTokens(run.outputTokens)}
                        {cache === 0 ? null : (
                          <span className="text-caption text-faint block">
                            Cache {formatTokens(run.cacheReadTokens)} read ·{' '}
                            {formatTokens(run.cacheWriteTokens)} written
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {formatCost(run.costMicros)}
                      </td>
                      <td className="text-subdued px-3 py-2 whitespace-nowrap">
                        {formatRunStatus(run.status)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {query.isFetchNextPageError ? (
            <RetryLine
              message={messageFor(query.error, 'More runs could not be loaded.')}
              onRetry={() => {
                void query.fetchNextPage();
              }}
            />
          ) : query.hasNextPage ? (
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

function RetryLine({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <p className="text-body-sm text-danger" role="alert">
        {message}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

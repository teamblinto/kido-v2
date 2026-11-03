import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

import { listRuns } from '../api';

interface UseRunOptions {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

export interface RunSelection {
  /** The project has never had a run. An empty composer, not an error (FR-026). */
  readonly hasNoRuns: boolean;
  /** Still working out which run that is. Distinct from having decided there is none. */
  readonly isLoading: boolean;
  readonly runId: string | undefined;
  /** Put a run on screen, by putting it in the address (FR-025). */
  selectRun: (runId: string) => void;
}

/**
 * Which run is on screen.
 *
 * Two answers in priority order, and the order is the whole hook: `?run=` wins outright, because
 * a named run is a person returning to a particular one and asking the API which is newest could
 * only overrule them (R4). Absent that, the project's most recent, so someone who was interrupted
 * comes back to what they were watching (FR-024).
 *
 * Either way the run ends up in the address. That is not bookkeeping: it is what makes a run
 * shareable, and what makes a reload return to *this* run rather than to whatever is newest by
 * the time the page comes back.
 *
 * The query string rather than a nested route, per R4: `?run=` is already the shape the screen
 * uses, so only the meaning of the value changes — `routes.ts` is a contract with the mail
 * builder and has no business changing for this.
 */
export function useRun({ orgId, projectId }: UseRunOptions): RunSelection {
  const [searchParams, setSearchParams] = useSearchParams();
  const named = searchParams.get('run') ?? undefined;

  const selectRun = useCallback(
    (runId: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);

          next.set('run', runId);

          return next;
        },
        // Replaced rather than pushed: opening a project is one place to be, and pushing would
        // put the run between the project and wherever the person came from, so Back would walk
        // through runs they never chose.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Not asked at all when the address already names a run: the answer could not change anything,
  // and a project's whole run list is a request worth not making on every reload.
  const enabled =
    orgId !== undefined && projectId !== undefined && projectId.length > 0 && named === undefined;

  const runs = useQuery({
    enabled,
    // One run, because one is the question being asked. The run browser that needs the rest is
    // spec 022's.
    queryFn: ({ signal }) => listRuns(orgId ?? '', projectId ?? '', { limit: 1 }, signal),
    queryKey: ['runs', orgId, projectId],
  });

  const newest = runs.data?.runs[0]?.id;

  useEffect(() => {
    if (named === undefined && newest !== undefined) {
      selectRun(newest);
    }
  }, [named, newest, selectRun]);

  return {
    hasNoRuns: enabled && runs.isSuccess && runs.data.runs.length === 0,
    isLoading: enabled && runs.isPending,
    runId: named ?? newest,
    selectRun,
  };
}

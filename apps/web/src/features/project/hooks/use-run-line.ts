import { type RunLineResponse, runLineResponseSchema } from '@repo/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { apiRequest } from '@/lib/api/client';

/** How often the line is re-read while it is on screen (spec 031 plan: polling, not a stream). */
const REFRESH_MS = 3_000;

function linePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/runs/line`;
}

/** `GET …/runs/line`, parsed with the contract's schema. */
export function getRunLine(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<RunLineResponse> {
  return apiRequest('GET', linePath(orgId, projectId), { schema: runLineResponseSchema, signal });
}

/** Who holds the line and who waits, as one string: a change is a run that moved. */
function signature(line: RunLineResponse | undefined): string {
  if (line === undefined) return '';
  return [line.holder?.runId ?? '-', ...line.waiting.map((entry) => entry.runId)].join(',');
}

/**
 * The project's run line (spec 031 contracts/run-line.md § 2), re-read every 3 s while mounted.
 * When the holder or the waiting runs change, the run list is stale too — a run started, ended or
 * was cancelled — so its key `['runs', org, project, 'list']` is invalidated.
 */
export function useRunLine({
  orgId,
  projectId,
}: {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}) {
  const enabled = orgId !== undefined && projectId !== undefined && projectId.length > 0;
  const queryClient = useQueryClient();
  const query = useQuery({
    enabled,
    queryFn: ({ signal }) => getRunLine(orgId ?? '', projectId ?? '', signal),
    queryKey: ['runs', orgId, projectId, 'line'],
    refetchInterval: REFRESH_MS,
  });
  const seen = useRef<string | undefined>(undefined);
  const current = signature(query.data);

  useEffect(() => {
    if (query.data === undefined) return;

    if (seen.current !== undefined && seen.current !== current) {
      void queryClient.invalidateQueries({ queryKey: ['runs', orgId, projectId, 'list'] });
    }

    seen.current = current;
  }, [current, orgId, projectId, query.data, queryClient]);

  return query;
}

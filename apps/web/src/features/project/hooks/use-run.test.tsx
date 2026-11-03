import type { RunResponse } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { API, server } from '@/test/server';
import { useRun } from './use-run';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NEWEST = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const OLDER = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const NAMED = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

const RUNS = `${API}/orgs/${ORG}/projects/${PROJECT}/runs`;

function aRun(id: string, createdAt: string): RunResponse {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelRequestedAt: null,
    contextSkips: [],
    createdAt,
    endedAt: null,
    failureClass: null,
    id,
    inputTokens: 0,
    lastSeq: 0,
    model: 'claude-opus-5',
    outputTokens: 0,
    projectId: PROJECT,
    promptExcerpt: 'ship it',
    startedAt: null,
    status: 'succeeded',
    userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  };
}

/** `GET …/runs`, newest first — the order the contract promises. */
function listing(...runs: RunResponse[]) {
  return http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs }));
}

/**
 * Render the hook inside the router and query client it needs, and watch the address.
 *
 * The address is half of what this hook does (FR-025), so it is observed rather than inferred:
 * a probe renders beside the hook and records every location it sees.
 */
function renderRun(search = '') {
  const seen: string[] = [];

  function Probe(): null {
    seen.push(useLocation().search);

    return null;
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/projects/${PROJECT}${search}`]}>
          {children}
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return { ...renderHook(() => useRun({ orgId: ORG, projectId: PROJECT }), { wrapper }), seen };
}

describe('useRun', () => {
  it('opens the run named by ?run=', async () => {
    // R4: the parameter wins outright. A named run is a person returning to a particular one, and
    // asking the API which is newest could only overrule them.
    let listed = 0;

    server.use(
      http.get(RUNS, () => {
        listed += 1;

        return HttpResponse.json({
          nextCursor: null,
          runs: [aRun(NEWEST, '2026-01-02T00:00:00.000Z')],
        });
      }),
    );

    const { result, unmount } = renderRun(`?run=${NAMED}`);

    expect(result.current.runId).toBe(NAMED);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listed).toBe(0);
    expect(result.current.hasNoRuns).toBe(false);
    unmount();
  });

  it("opens the project's most recent run when none is named", async () => {
    // FR-024: a person who was interrupted comes back to what they were watching.
    server.use(
      listing(aRun(NEWEST, '2026-01-02T00:00:00.000Z'), aRun(OLDER, '2026-01-01T00:00:00.000Z')),
    );

    const { result, unmount } = renderRun();

    await waitFor(() => {
      expect(result.current.runId).toBe(NEWEST);
    });

    expect(result.current.hasNoRuns).toBe(false);
    unmount();
  });

  it('puts the run it opened in the address', async () => {
    // FR-025: whatever decided the run, the address names it — so the tab can be shared, or
    // reloaded onto the same run rather than onto whatever is newest by then.
    server.use(listing(aRun(NEWEST, '2026-01-02T00:00:00.000Z')));

    const { result, seen, unmount } = renderRun();

    await waitFor(() => {
      expect(result.current.runId).toBe(NEWEST);
    });

    await waitFor(() => {
      expect(seen.at(-1)).toBe(`?run=${NEWEST}`);
    });

    unmount();
  });

  it('answers hasNoRuns for a project with none', async () => {
    // FR-026: an empty composer ready to start one. Not an error, and not a blank screen — the
    // difference is whether the screen can tell "nothing yet" from "something went wrong".
    server.use(listing());

    const { result, seen, unmount } = renderRun();

    await waitFor(() => {
      expect(result.current.hasNoRuns).toBe(true);
    });

    expect(result.current.runId).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    // Nothing to name, so nothing is written to the address.
    expect(seen.at(-1)).toBe('');
    unmount();
  });

  it('selects a run by putting it in the address', async () => {
    // How a run gets on screen from anywhere else — starting one, or picking one later.
    server.use(listing());

    const { result, seen, unmount } = renderRun();

    await waitFor(() => {
      expect(result.current.hasNoRuns).toBe(true);
    });

    result.current.selectRun(OLDER);

    await waitFor(() => {
      expect(seen.at(-1)).toBe(`?run=${OLDER}`);
    });

    expect(result.current.runId).toBe(OLDER);
    unmount();
  });
});

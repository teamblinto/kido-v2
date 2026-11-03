import type { RunResponse } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { API, server } from '@/test/server';
import { useRunList } from './use-run-list';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

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

function id(n: number): string {
  return `6ba7b81${n}-9dad-11d1-80b4-00c04fd430c8`;
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  return {
    client,
    ...renderHook(() => useRunList({ orgId: ORG, projectId: PROJECT }), { wrapper }),
  };
}

describe('useRunList', () => {
  it('asks for 50 runs a page — the shared default of 25 is not this screen`s page', async () => {
    const asked: (string | null)[] = [];

    server.use(
      http.get(RUNS, ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('limit'));

        return HttpResponse.json({ nextCursor: null, runs: [aRun(id(1), '2026-01-02T00:00:00Z')] });
      }),
    );

    const { result, unmount } = renderList();

    await waitFor(() => {
      expect(result.current.runs).toHaveLength(1);
    });

    expect(asked).toEqual(['50']);
    expect(result.current.hasMore).toBe(false);
    unmount();
  });

  it('follows nextCursor for the older page and keeps both, newest first', async () => {
    const cursors: (string | null)[] = [];

    server.use(
      http.get(RUNS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');

        cursors.push(cursor);

        return cursor === null
          ? HttpResponse.json({
              nextCursor: 'older',
              runs: [aRun(id(1), '2026-01-02T00:00:00Z')],
            })
          : HttpResponse.json({ nextCursor: null, runs: [aRun(id(2), '2026-01-01T00:00:00Z')] });
      }),
    );

    const { result, unmount } = renderList();

    await waitFor(() => {
      expect(result.current.hasMore).toBe(true);
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.runs.map((run) => run.id)).toEqual([id(1), id(2)]);
    });

    expect(cursors).toEqual([null, 'older']);
    expect(result.current.hasMore).toBe(false);
    unmount();
  });

  it('caches under a key of its own, leaving spec 012`s single-run key alone', async () => {
    server.use(
      http.get(RUNS, () =>
        HttpResponse.json({ nextCursor: null, runs: [aRun(id(1), '2026-01-02T00:00:00Z')] }),
      ),
    );

    const { client, result, unmount } = renderList();

    await waitFor(() => {
      expect(result.current.runs).toHaveLength(1);
    });

    expect(client.getQueryData(['runs', ORG, PROJECT, 'list'])).toBeDefined();
    expect(client.getQueryData(['runs', ORG, PROJECT])).toBeUndefined();
    unmount();
  });
});

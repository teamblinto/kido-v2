import type { Checkpoint } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { API, server } from '@/test/server';
import { useCheckpointDiff, useCheckpoints, useRevert } from './use-checkpoints';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const HEAD = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const OLDER = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

const CHECKPOINTS = `${API}/orgs/${ORG}/projects/${PROJECT}/checkpoints`;
const project = { orgId: ORG, projectId: PROJECT };

function aCheckpoint(id: string, label: string): Checkpoint {
  return {
    actorId: null,
    createdAt: '2026-09-22T10:00:00.000Z',
    files: [],
    gitSha: 'a'.repeat(40),
    id,
    kind: 'turn',
    label,
    mirroredAt: null,
    parentId: null,
    revertsId: null,
    runId: null,
    turn: 1,
  };
}

function wrapperWith(client: QueryClient) {
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

describe('useCheckpoints', () => {
  it('follows nextCursor to the next page and appends it, newest first', async () => {
    server.use(
      http.get(CHECKPOINTS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');

        return cursor === null
          ? HttpResponse.json({ items: [aCheckpoint(HEAD, 'head')], nextCursor: 'c1' })
          : HttpResponse.json({ items: [aCheckpoint(OLDER, 'older')], nextCursor: null });
      }),
    );

    const { result } = renderHook(() => useCheckpoints(project), {
      wrapper: wrapperWith(newClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.checkpoints.map((c) => c.id)).toEqual([HEAD]);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() =>
      expect(result.current.data?.checkpoints.map((c) => c.id)).toEqual([HEAD, OLDER]),
    );
    // `nextCursor: null` is the end of the list, not another empty page waiting to be asked for.
    expect(result.current.hasNextPage).toBe(false);
  });

  it('asks nothing until the project is known', () => {
    const { result } = renderHook(
      () => useCheckpoints({ orgId: undefined, projectId: undefined }),
      { wrapper: wrapperWith(newClient()) },
    );

    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useCheckpointDiff', () => {
  it('fetches the named checkpoint and stays idle without one', async () => {
    server.use(
      http.get(`${CHECKPOINTS}/${HEAD}/diff`, () =>
        HttpResponse.json({
          checkpointId: HEAD,
          parentId: null,
          files: [
            {
              binary: false,
              patch: '@@ -0,0 +1 @@\n+hi\n',
              path: 'a.txt',
              status: 'A',
              truncated: false,
            },
          ],
        }),
      ),
    );

    const idle = renderHook(() => useCheckpointDiff(project, undefined), {
      wrapper: wrapperWith(newClient()),
    });

    expect(idle.result.current.fetchStatus).toBe('idle');

    const { result } = renderHook(() => useCheckpointDiff(project, HEAD), {
      wrapper: wrapperWith(newClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.files).toHaveLength(1);
  });
});

describe('useRevert', () => {
  it('reuses one idempotency key across a retry of the same target and mints a new one after', async () => {
    const keys: string[] = [];
    let fail = true;

    server.use(
      http.post(`${CHECKPOINTS}/${OLDER}/revert`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');

        if (fail) {
          fail = false;

          return HttpResponse.json(
            { detail: 'nope', status: 503, title: 'Unavailable' },
            { status: 503 },
          );
        }

        return HttpResponse.json(aCheckpoint(HEAD, 'revert'));
      }),
    );

    const { result } = renderHook(() => useRevert(project), { wrapper: wrapperWith(newClient()) });

    await act(async () => {
      await result.current.mutateAsync(OLDER).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(OLDER);
    });
    await act(async () => {
      await result.current.mutateAsync(OLDER);
    });

    // A retry of the failed revert carries the first attempt's key; the deliberate third revert,
    // after one succeeded, is a new action and must not be swallowed as a duplicate.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('invalidates the history, the file tree, the open file and the preview', async () => {
    server.use(
      http.post(`${CHECKPOINTS}/${OLDER}/revert`, () =>
        HttpResponse.json(aCheckpoint(HEAD, 'revert')),
      ),
    );

    const client = newClient();
    const invalidated: unknown[] = [];

    client.invalidateQueries = ((filters: { queryKey: unknown }) => {
      invalidated.push(filters.queryKey);

      return Promise.resolve();
    }) as typeof client.invalidateQueries;

    const { result } = renderHook(() => useRevert(project), { wrapper: wrapperWith(client) });

    await act(async () => {
      await result.current.mutateAsync(OLDER);
    });

    expect(invalidated).toEqual([['checkpoints'], ['files'], ['file'], ['preview']]);
  });
});

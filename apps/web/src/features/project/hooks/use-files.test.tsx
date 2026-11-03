import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { ApiProblem } from '@/lib/api/problem';
import { API, server } from '@/test/server';
import { isAsleep, useDirectory, useFile, useWake } from './use-files';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const FILES = `${API}/orgs/${ORG}/projects/${PROJECT}/files`;

/** The 409 the API answers while the sandbox is hibernated (contracts/files.md § 1). */
function asleep() {
  return HttpResponse.json(
    {
      detail: 'The sandbox is not ready.',
      extensions: { kind: 'sandbox-not-ready', state: 'hibernated' },
      instance: '/api/v1/files',
      requestId: 'req_1',
      status: 409,
      title: 'Conflict',
      type: 'https://forge.dev/problems/conflict',
    },
    { headers: { 'content-type': 'application/problem+json' }, status: 409 },
  );
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function aClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useDirectory', () => {
  it('reads one directory and keys it by org, project and directory', async () => {
    server.use(
      http.get(FILES, ({ request }) =>
        HttpResponse.json({
          entries: [{ kind: 'file', name: 'index.ts', size: 12 }],
          path: new URL(request.url).searchParams.get('path'),
        }),
      ),
    );

    const client = aClient();
    const { result } = renderHook(() => useDirectory(ORG, PROJECT, 'src'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.path).toBe('src');
    expect(client.getQueryData(['files', ORG, PROJECT, 'src'])).toBeDefined();
  });

  it('asks nothing until it knows which project and directory', () => {
    const { result } = renderHook(() => useDirectory(ORG, undefined, ''), {
      wrapper: wrapper(aClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useFile', () => {
  it('reads one file on its own key', async () => {
    server.use(
      http.get(`${FILES}/content`, () =>
        HttpResponse.json({
          baseCheckpointId: '018f5f1e-0000-7000-8000-000000000001',
          bytes: 2,
          content: 'hi',
          path: 'src/a.ts',
          renderable: true,
        }),
      ),
    );

    const client = aClient();
    const { result } = renderHook(() => useFile(ORG, PROJECT, 'src/a.ts'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(client.getQueryData(['file', ORG, PROJECT, 'src/a.ts'])).toBeDefined();
  });

  it('asks nothing for the empty path, which names no file', () => {
    const { result } = renderHook(() => useFile(ORG, PROJECT, ''), { wrapper: wrapper(aClient()) });

    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('isAsleep', () => {
  it('is the sandbox-not-ready conflict and nothing else', async () => {
    server.use(http.get(FILES, () => asleep()));

    const { result } = renderHook(() => useDirectory(ORG, PROJECT, ''), {
      wrapper: wrapper(aClient()),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(isAsleep(result.current.error)).toBe(true);

    // A conflict is a shared slug: without the extension it is somebody else's failure.
    expect(
      isAsleep(
        new ApiProblem(409, {
          detail: 'Someone else got there first.',
          instance: '/api/v1/files',
          requestId: 'req_2',
          status: 409,
          title: 'Conflict',
          type: 'https://forge.dev/problems/conflict',
        }),
      ),
    ).toBe(false);
    expect(isAsleep(new Error('offline'))).toBe(false);
  });
});

describe('useWake', () => {
  it('invalidates the tree, the open file and the preview once the wake is answered', async () => {
    server.use(http.post(`${FILES}/wake`, () => HttpResponse.json({ because: null, ready: true })));

    const client = aClient();

    client.setQueryData(['files', ORG, PROJECT, ''], { entries: [], path: '' });
    client.setQueryData(['file', ORG, PROJECT, 'a.ts'], { bytes: 0 });
    client.setQueryData(['preview', ORG, PROJECT], { url: 'https://example.test' });
    client.setQueryData(['runs', ORG, PROJECT], { runs: [] });

    const { result } = renderHook(() => useWake(ORG, PROJECT), { wrapper: wrapper(client) });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const stale = (queryKey: readonly unknown[]) =>
      client.getQueryState(queryKey as unknown[])?.isInvalidated;

    expect(stale(['files', ORG, PROJECT, ''])).toBe(true);
    expect(stale(['file', ORG, PROJECT, 'a.ts'])).toBe(true);
    expect(stale(['preview', ORG, PROJECT])).toBe(true);
    // Runs come from the API, not the sandbox: waking one has nothing to say about them.
    expect(stale(['runs', ORG, PROJECT])).toBe(false);
  });
});

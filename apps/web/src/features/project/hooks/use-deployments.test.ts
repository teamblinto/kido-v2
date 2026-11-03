import type { Deployment } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { type ReactNode, createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { problemResponse } from '@/test/render';
import { API, server } from '@/test/server';
import { useDeploy, useDeployments, useSite, useUpdateSite } from './use-deployments';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const HEAD = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const OLDER = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const DEPLOYMENT = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

const BASE = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const project = { orgId: ORG, projectId: PROJECT };

function aDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    artifactSha: null,
    attempts: 0,
    checkpointId: HEAD,
    createdAt: '2026-09-22T10:00:00.000Z',
    current: false,
    failureReason: null,
    fileCount: null,
    finishedAt: null,
    id: DEPLOYMENT,
    requestedBy: ORG,
    startedAt: null,
    state: 'queued',
    totalBytes: null,
    ...overrides,
  };
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

function wrapperWith(client: QueryClient) {
  return function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useDeploy', () => {
  it('reuses one idempotency key across a retry of the same intent and drops it on success', async () => {
    const keys: string[] = [];
    const bodies: unknown[] = [];
    let fail = true;

    server.use(
      http.post(`${BASE}/deployments`, async ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
        bodies.push(await request.json());

        if (fail) {
          fail = false;

          return problemResponse('service-unavailable', 503);
        }

        return HttpResponse.json({ deployment: aDeployment() }, { status: 202 });
      }),
    );

    const { result } = renderHook(() => useDeploy(project), { wrapper: wrapperWith(newClient()) });

    await act(async () => {
      await result.current.mutateAsync(HEAD).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(HEAD);
    });
    await act(async () => {
      await result.current.mutateAsync(HEAD);
    });

    // The retry is the same decision, so the server can collapse it; the third deploy, made after
    // one succeeded, is a new decision and must not be swallowed as a replay.
    expect(keys[0]).not.toBe('');
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(bodies).toEqual([
      { checkpointId: HEAD },
      { checkpointId: HEAD },
      { checkpointId: HEAD },
    ]);
  });

  it('keys each intent separately, so a different checkpoint is a different deploy', async () => {
    const keys: string[] = [];

    server.use(
      http.post(`${BASE}/deployments`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');

        return problemResponse('service-unavailable', 503);
      }),
    );

    const { result } = renderHook(() => useDeploy(project), { wrapper: wrapperWith(newClient()) });

    await act(async () => {
      await result.current.mutateAsync(HEAD).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(OLDER).catch(() => undefined);
    });

    expect(keys[0]).not.toBe(keys[1]);
  });

  it('invalidates the deployments and the site of this project on success', async () => {
    server.use(
      http.post(`${BASE}/deployments`, () =>
        HttpResponse.json({ deployment: aDeployment() }, { status: 202 }),
      ),
    );

    const client = newClient();
    const invalidated: unknown[] = [];

    client.invalidateQueries = ((filters: { queryKey: unknown }) => {
      invalidated.push(filters.queryKey);

      return Promise.resolve();
    }) as typeof client.invalidateQueries;

    const { result } = renderHook(() => useDeploy(project), { wrapper: wrapperWith(client) });

    await act(async () => {
      await result.current.mutateAsync(HEAD);
    });

    expect(invalidated).toEqual([
      ['deployments', ORG, PROJECT],
      ['site', ORG, PROJECT],
    ]);
  });
});

describe('useUpdateSite', () => {
  it('sends the release body and invalidates the deployments and the site', async () => {
    const bodies: unknown[] = [];

    server.use(
      http.put(`${BASE}/site`, async ({ request }) => {
        bodies.push(await request.json());

        return HttpResponse.json({
          site: {
            currentDeploymentId: DEPLOYMENT,
            deployable: true,
            offline: false,
            url: 'https://abc123.sites.example.test/',
          },
        });
      }),
    );

    const client = newClient();
    const invalidated: unknown[] = [];

    client.invalidateQueries = ((filters: { queryKey: unknown }) => {
      invalidated.push(filters.queryKey);

      return Promise.resolve();
    }) as typeof client.invalidateQueries;

    const { result } = renderHook(() => useUpdateSite(project), { wrapper: wrapperWith(client) });

    await act(async () => {
      await result.current.mutateAsync({ action: 'release', deploymentId: DEPLOYMENT });
    });

    expect(bodies).toEqual([{ action: 'release', deploymentId: DEPLOYMENT }]);
    expect(invalidated).toEqual([
      ['deployments', ORG, PROJECT],
      ['site', ORG, PROJECT],
    ]);
  });
});

describe('reads', () => {
  it('asks nothing until the project is known', () => {
    const none = { orgId: undefined, projectId: undefined };
    const client = newClient();

    const list = renderHook(() => useDeployments(none), { wrapper: wrapperWith(client) });
    const site = renderHook(() => useSite(none), { wrapper: wrapperWith(client) });

    expect(list.result.current.fetchStatus).toBe('idle');
    expect(site.result.current.fetchStatus).toBe('idle');
  });

  it('reads the list and the site through their contract schemas', async () => {
    server.use(
      http.get(`${BASE}/deployments`, () =>
        HttpResponse.json({ items: [aDeployment()], nextCursor: null }),
      ),
      http.get(`${BASE}/site`, () =>
        HttpResponse.json({
          site: { currentDeploymentId: null, deployable: true, offline: false, url: null },
        }),
      ),
    );

    const client = newClient();
    const list = renderHook(() => useDeployments(project), { wrapper: wrapperWith(client) });
    const site = renderHook(() => useSite(project), { wrapper: wrapperWith(client) });

    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(site.result.current.isSuccess).toBe(true));
    expect(list.result.current.data?.items.map((d) => d.id)).toEqual([DEPLOYMENT]);
    expect(site.result.current.data?.url).toBeNull();
  });

  it('refuses a body the contract does not describe', async () => {
    server.use(
      http.get(`${BASE}/deployments`, () =>
        HttpResponse.json({ items: [{ ...aDeployment(), logTail: '' }], nextCursor: null }),
      ),
    );

    const { result } = renderHook(() => useDeployments(project), {
      wrapper: wrapperWith(newClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

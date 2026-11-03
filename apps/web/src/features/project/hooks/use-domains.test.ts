import type { Domain, DomainState } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { type ReactNode, createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { problemResponse } from '@/test/render';
import { API, server } from '@/test/server';
import {
  DOMAIN_POLL_MS,
  domainPollInterval,
  useAddDomain,
  useDomains,
  useRemoveDomain,
} from './use-domains';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DOMAIN = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

const BASE = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const project = { orgId: ORG, projectId: PROJECT };

function aDomain(state: DomainState): Domain {
  return {
    activatedAt: null,
    addedBy: null,
    check: null,
    checkAvailableAt: null,
    createdAt: '2026-09-23T10:00:00.000Z',
    displayHostname: 'app.acme.com',
    driftedAt: null,
    failureReason: state === 'failed' ? 'verification-timeout' : null,
    hostname: 'app.acme.com',
    id: DOMAIN,
    records: [],
    releaseAt: null,
    state,
    windowEndsAt: null,
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

describe('domainPollInterval', () => {
  it('is 2 s while any row is pending or removing, and off otherwise', () => {
    expect(DOMAIN_POLL_MS).toBe(2000);

    expect(domainPollInterval([aDomain('active'), aDomain('pending')])).toBe(2000);
    expect(domainPollInterval([aDomain('removing')])).toBe(2000);

    for (const state of ['active', 'drifted', 'failed'] as const) {
      expect(domainPollInterval([aDomain(state)])).toBe(false);
    }

    expect(domainPollInterval([])).toBe(false);
    expect(domainPollInterval(undefined)).toBe(false);
  });
});

describe('useDomains', () => {
  it('re-reads the list while a row is settling and stops once none is', async () => {
    let calls = 0;

    server.use(
      http.get(`${BASE}/domains`, () => {
        calls += 1;

        return HttpResponse.json({
          canManage: true,
          items: [aDomain(calls === 1 ? 'pending' : 'active')],
        });
      }),
    );

    const { result } = renderHook(() => useDomains(project), {
      wrapper: wrapperWith(newClient()),
    });

    await waitFor(() => expect(result.current.data?.items[0]?.state).toBe('pending'));
    await waitFor(() => expect(result.current.data?.items[0]?.state).toBe('active'), {
      timeout: 4000,
    });

    const settled = calls;

    await new Promise((resolve) => {
      setTimeout(resolve, 2600);
    });

    expect(calls).toBe(settled);
  }, 15_000);

  it('asks nothing until the project is known', () => {
    // `onUnhandledRequest: 'error'` is the assertion: no handler is registered.
    const { result } = renderHook(() => useDomains({ orgId: ORG, projectId: undefined }), {
      wrapper: wrapperWith(newClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useAddDomain', () => {
  it('reuses one idempotency key across a retry of the same hostname and drops it on success', async () => {
    const keys: string[] = [];
    let fail = true;

    server.use(
      http.post(`${BASE}/domains`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key') ?? '');

        if (fail) {
          fail = false;

          return problemResponse('service-unavailable', 503);
        }

        return HttpResponse.json({ domain: aDomain('pending') }, { status: 201 });
      }),
      http.get(`${BASE}/domains`, () => HttpResponse.json({ canManage: true, items: [] })),
    );

    const { result } = renderHook(() => useAddDomain(project), {
      wrapper: wrapperWith(newClient()),
    });

    await act(async () => {
      await result.current.mutateAsync('app.acme.com').catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(' App.Acme.com ');
    });
    await act(async () => {
      await result.current.mutateAsync('app.acme.com').catch(() => undefined);
    });

    expect(keys[0]).not.toBe('');
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});

describe('useRemoveDomain', () => {
  it('invalidates the list of this project on success', async () => {
    server.use(
      http.delete(`${BASE}/domains/${DOMAIN}`, () =>
        HttpResponse.json({ deletableRecords: [], domain: aDomain('removing') }, { status: 202 }),
      ),
    );

    const client = newClient();
    const other = ['domains', ORG, 'another-project'];

    client.setQueryData(['domains', ORG, PROJECT], { canManage: true, items: [] });
    client.setQueryData(other, { canManage: true, items: [] });

    const { result } = renderHook(() => useRemoveDomain(project), {
      wrapper: wrapperWith(client),
    });

    await act(async () => {
      await result.current.mutateAsync(DOMAIN);
    });

    expect(client.getQueryState(['domains', ORG, PROJECT])?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

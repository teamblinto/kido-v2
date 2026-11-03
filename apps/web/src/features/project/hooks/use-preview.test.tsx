import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { API, server } from '@/test/server';
import { usePreview, useRotate, useSetVisibility } from './use-preview';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PREVIEW = `${API}/orgs/${ORG}/projects/${PROJECT}/preview`;
const project = { orgId: ORG, projectId: PROJECT };

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

describe('usePreview', () => {
  it('reads the preview once the project is known', async () => {
    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'private',
        }),
      ),
    );

    const { result } = renderHook(() => usePreview(project), { wrapper: wrapperWith(newClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.url).toBe('https://a.preview.test');
  });

  it('does not ask before the project is known', () => {
    const { result } = renderHook(() => usePreview({ orgId: undefined, projectId: undefined }), {
      wrapper: wrapperWith(newClient()),
    });

    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useSetVisibility', () => {
  it('refreshes the preview with the new visibility', async () => {
    let visibility = 'private';

    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility,
        }),
      ),
      http.put(`${PREVIEW}/visibility`, async ({ request }) => {
        const body = (await request.json()) as { visibility: string };

        visibility = body.visibility;

        return HttpResponse.json({
          port: 3000,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility,
        });
      }),
    );

    const client = newClient();
    const { result } = renderHook(
      () => ({ preview: usePreview(project), set: useSetVisibility(project) }),
      { wrapper: wrapperWith(client) },
    );

    await waitFor(() => expect(result.current.preview.data?.visibility).toBe('private'));

    await act(async () => {
      await result.current.set.mutateAsync('org');
    });

    await waitFor(() => expect(result.current.preview.data?.visibility).toBe('org'));
  });
});

describe('useRotate', () => {
  it('resolves with the new url and invalidates the preview', async () => {
    let url = 'https://a.preview.test';

    server.use(
      http.get(PREVIEW, () =>
        HttpResponse.json({ port: 3000, stage: 'ready', url, visibility: 'private' }),
      ),
      http.post(`${PREVIEW}/rotate`, () => {
        url = 'https://b.preview.test';

        return HttpResponse.json({ port: 3000, status: 'preview-label-rotated', url });
      }),
    );

    const client = newClient();
    const { result } = renderHook(
      () => ({ preview: usePreview(project), rotate: useRotate(project) }),
      { wrapper: wrapperWith(client) },
    );

    await waitFor(() => expect(result.current.preview.data?.url).toBe('https://a.preview.test'));

    let rotated: { url: string } | undefined;

    await act(async () => {
      rotated = await result.current.rotate.mutateAsync();
    });

    expect(rotated?.url).toBe('https://b.preview.test');
    await waitFor(() => expect(result.current.preview.data?.url).toBe('https://b.preview.test'));
  });
});

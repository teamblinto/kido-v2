import type { PresenceLocation } from '@repo/contracts';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API, server } from '@/test/server';
import { PRESENCE_POLL_MS, usePresence } from './use-presence';
import { useProjectWorkspace } from './use-project-workspace';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PRESENCE = `${API}/orgs/${ORG}/projects/${PROJECT}/presence`;

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function recordHeartbeats(): PresenceLocation[] {
  const sent: PresenceLocation[] = [];

  server.use(
    http.put(PRESENCE, async ({ request }) => {
      sent.push(((await request.json()) as { location: PresenceLocation }).location);

      return HttpResponse.json({ available: true, people: [] });
    }),
  );

  return sent;
}

describe('usePresence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('sends a heartbeat on a location change without waiting for the interval', async () => {
    const sent = recordHeartbeats();
    const { rerender } = renderHook(
      ({ location }: { location: PresenceLocation }) =>
        usePresence({ location, orgId: ORG, projectId: PROJECT }),
      { initialProps: { location: { view: 'preview' } as PresenceLocation } },
    );

    await waitFor(() => expect(sent).toHaveLength(1));

    rerender({ location: { view: 'history' } });

    await waitFor(() => expect(sent).toEqual([{ view: 'preview' }, { view: 'history' }]));
  });

  it('stops sending while the tab is hidden', async () => {
    const sent = recordHeartbeats();

    renderHook(() =>
      usePresence({ location: { view: 'preview' }, orgId: ORG, projectId: PROJECT }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));

    act(() => setVisibility('hidden'));
    await act(() => vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS * 3));

    expect(sent).toHaveLength(1);

    act(() => setVisibility('visible'));
    await waitFor(() => expect(sent).toHaveLength(2));
  });

  it('keeps sending every interval while visible', async () => {
    const sent = recordHeartbeats();

    renderHook(() =>
      usePresence({ location: { view: 'preview' }, orgId: ORG, projectId: PROJECT }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(PRESENCE_POLL_MS));

    await waitFor(() => expect(sent).toHaveLength(2));
  });

  it('answers the other people the server reported', async () => {
    server.use(
      http.put(PRESENCE, () =>
        HttpResponse.json({
          available: true,
          people: [
            {
              email: 'bob@example.com',
              location: { view: 'preview' },
              seenAt: '2026-09-23T10:00:00.000Z',
              userId: '11111111-1111-4111-8111-111111111111',
            },
          ],
        }),
      ),
    );

    const { result } = renderHook(() =>
      usePresence({ location: { view: 'preview' }, orgId: ORG, projectId: PROJECT }),
    );

    await waitFor(() => expect(result.current?.people).toHaveLength(1));
  });
});

describe('useProjectWorkspace location', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={['/p']}>{children}</MemoryRouter>;
  }

  it('the location names the open file', () => {
    const { result } = renderHook(() => useProjectWorkspace(), { wrapper });

    act(() => result.current.setStage('code'));
    act(() => result.current.onOpenFile('src/a.ts'));

    expect(result.current.location).toEqual({ path: 'src/a.ts', view: 'code' });
  });
});

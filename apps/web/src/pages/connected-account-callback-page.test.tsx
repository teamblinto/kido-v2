import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { SessionProvider } from '@/features/auth/session/session-provider';
import { routes } from '@/lib/routes';
import { problemResponse, sessionHandler, aUser } from '@/test/render';
import { API, server } from '@/test/server';
import { ConnectedAccountCallbackPage } from './connected-account-callback-page';

const STATE = 'b'.repeat(43);
const COMPLETE = `${API}/me/linked-accounts/anthropic/complete`;
const BASE = routes.connectedAccountCallback.replace(':provider', 'anthropic');

const anAccount = {
  accountLabel: 'rakibul@blinto.co',
  health: 'healthy',
  lastCheckedAt: '2026-09-23T10:00:00.000Z',
  limitedUntil: null,
  linkedAt: '2026-09-23T10:00:00.000Z',
  provider: 'anthropic',
};

/** Under StrictMode, so the development double-invoke is part of what is tested. */
function renderCallback(query: string) {
  server.use(sessionHandler(aUser));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`${BASE}?${query}`]}>
          <SessionProvider>
            <Routes>
              <Route
                path={routes.connectedAccountCallback}
                element={<ConnectedAccountCallbackPage />}
              />
              <Route path={routes.accountSettings} element={<p>Account settings</p>} />
            </Routes>
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

/** Spec 032 T030. */
describe('ConnectedAccountCallbackPage', () => {
  it('posts the code and state once, then returns to account settings', async () => {
    const bodies: unknown[] = [];

    server.use(
      http.post(COMPLETE, async ({ request }) => {
        bodies.push(await request.json());

        return HttpResponse.json(anAccount);
      }),
    );

    renderCallback(`code=c0de&state=${STATE}`);

    expect(await screen.findByText('Account settings')).toBeInTheDocument();
    expect(bodies).toEqual([{ code: 'c0de', state: STATE }]);
  });

  it('echoes a denial as access_denied and shows its sentence', async () => {
    const bodies: unknown[] = [];

    server.use(
      http.post(COMPLETE, async ({ request }) => {
        bodies.push(await request.json());

        return problemResponse('oauth-exchange-failed', 422, { reason: 'denied' });
      }),
    );

    renderCallback(`error=access_denied&state=${STATE}`);

    expect(await screen.findByText('Claude did not authorise the connection.')).toBeInTheDocument();
    expect(bodies).toEqual([{ error: 'access_denied', state: STATE }]);
  });

  it('maps any other provider error to other', async () => {
    const bodies: unknown[] = [];

    server.use(
      http.post(COMPLETE, async ({ request }) => {
        bodies.push(await request.json());

        return problemResponse('oauth-exchange-failed', 422, { reason: 'exchange-refused' });
      }),
    );

    renderCallback(`error=server_error&state=${STATE}`);

    expect(
      await screen.findByText('Claude refused the connection. Please try again.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(bodies).toEqual([{ error: 'other', state: STATE }]);
    });
  });
});

import { orgListResponseSchema } from '@repo/contracts';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppProviders } from '@/app/providers';
import { apiRequest } from '@/lib/api/client';
import { aUser, problemResponse, sessionHandler } from '@/test/render';
import { API, server } from '@/test/server';
import { RequireAuth } from './route-guards';
import { useSession } from './session-context';
import { SessionProvider } from './session-provider';

function Guarded(): React.JSX.Element {
  const { user } = useSession();

  return <p>Signed in as {user?.email}</p>;
}

/**
 * An ordinary screen query, so the global `unauthorized` reaction is observed the way it actually
 * happens — some unrelated query failing, not the session query.
 *
 * Through `useQuery` rather than a bare `apiRequest`, and the difference matters: the reaction lives
 * on the query and mutation caches, so it sees exactly the traffic React Query manages. Every
 * request this app makes goes through one of them.
 */
function Probe(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);

  useQuery({
    enabled,
    queryFn: ({ signal }) => apiRequest('GET', '/orgs', { schema: orgListResponseSchema, signal }),
    queryKey: ['orgs'],
    retry: false,
  });

  return (
    <button
      type="button"
      onClick={() => {
        setEnabled(true);
      }}
    >
      Load something
    </button>
  );
}

function renderApp(initialPath = '/'): void {
  // Before the render, and it has to be: `AppProviders` mounts a `BrowserRouter`, which reads
  // jsdom's real history. A previous test that ended up redirected to `/sign-in` would otherwise
  // start this one there.
  window.history.replaceState({}, '', initialPath);

  render(
    <AppProviders>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <>
                <Guarded />
                <Probe />
              </>
            </RequireAuth>
          }
        />
        <Route path="/sign-in" element={<p>Sign in</p>} />
      </Routes>
    </AppProviders>,
  );
}

describe('session', () => {
  it('restores a signed-in user from the cookie alone', async () => {
    server.use(sessionHandler(aUser));

    renderApp();

    expect(await screen.findByText('Signed in as rakibul@blinto.co')).toBeInTheDocument();
  });

  it('shows a pending state rather than guessing, while the cookie is being resolved', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    server.use(
      http.get(`${API}/auth/me`, async () => {
        await held;

        return HttpResponse.json({ user: aUser });
      }),
    );

    renderApp();

    // Neither answer yet. Rendering the sign-in screen here would flash it at every returning user.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument();

    release?.();
    expect(await screen.findByText(/Signed in as/)).toBeInTheDocument();
  });

  it('sends a caller with no session to sign in', async () => {
    server.use(sessionHandler(null));

    renderApp();

    expect(await screen.findByText('Sign in')).toBeInTheDocument();
  });

  it('notices a session revoked elsewhere on the very next request', async () => {
    // Criterion 6 lets another device end this one, and §11 ends it when a member is removed. The
    // tab should not have to wait for a reload to find out, and no single screen can own that.
    const user = userEvent.setup();
    let revoked = false;

    server.use(
      // The revocation lands between the two requests, which is what makes this the real sequence
      // rather than a stubbed one: `/auth/me` answered honestly, and then the session died.
      http.get(`${API}/auth/me`, () =>
        revoked ? problemResponse('unauthorized', 401) : HttpResponse.json({ user: aUser }),
      ),
      http.get(`${API}/orgs`, () => {
        revoked = true;

        return problemResponse('unauthorized', 401);
      }),
    );

    renderApp();
    await screen.findByText(/Signed in as/);

    await user.click(screen.getByRole('button', { name: 'Load something' }));

    // The session entry is reset, re-asked, refused — and `RequireAuth` redirects.
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
  });

  it('does not loop when the session query itself is refused', async () => {
    // `GET /auth/me` answering 401 is the expected answer for a signed-out visitor. A handler that
    // reacted to it by resetting and refetching the same query would never stop.
    let calls = 0;

    server.use(
      http.get(`${API}/auth/me`, () => {
        calls += 1;

        return problemResponse('unauthorized', 401);
      }),
    );

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <SessionProvider>
            <RequireAuth>
              <Guarded />
            </RequireAuth>
          </SessionProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(calls).toBeGreaterThan(0);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(calls).toBe(1);
  });
});

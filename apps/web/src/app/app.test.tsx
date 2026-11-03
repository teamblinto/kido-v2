import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, onTestFinished } from 'vitest';

import { SessionProvider } from '@/features/auth/session/session-provider';
import { routes } from '@/lib/routes';
import { type TestUser, aUser, sessionHandler } from '@/test/render';
import { API, server } from '@/test/server';
import { App } from './app';

function renderAt(path: string, user: TestUser | null = aUser): void {
  server.use(sessionHandler(user));

  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('opens the workspace on the root route for a signed-in caller', async () => {
    renderAt(routes.home);

    expect(await screen.findByRole('navigation', { name: 'Workspace' })).toBeInTheDocument();
  });

  it('sends a signed-out caller from the workspace to sign in', async () => {
    renderAt(routes.home, null);

    expect(await screen.findByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
  });

  it('renders the sign-up screen', async () => {
    renderAt(routes.signUp, null);

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('sends a signed-in caller away from sign-up', async () => {
    renderAt(routes.signUp);

    expect(await screen.findByRole('navigation', { name: 'Workspace' })).toBeInTheDocument();
  });

  /**
   * The three routes the API mails links to. `links.ts` warns that a link the web app has no route
   * for "is a mail that looks fine in every test and 404s for the user" — this is that test.
   */
  it.each([
    ['a verification link', `${routes.confirmEmail}?token=abc`, /confirming your email/i],
    ['a password reset link', `${routes.newPassword}?token=abc`, /set a new password/i],
    ['the account-exists link', routes.signInAlias, /welcome back/i],
  ])('serves the destination of %s', async (_label, path, heading) => {
    renderAt(path, null);

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it("keeps the account-exists link's ?next= through the alias to after sign-in (spec 031, R7)", async () => {
    server.use(http.post(`${API}/auth/login`, () => HttpResponse.json({ user: aUser })));
    // Session updates delivered at once, ahead of the router's transition: the order a slow browser
    // sees, and the one that used to let `RequireAnon` send the new session home instead.
    notifyManager.setScheduler((callback) => {
      callback();
    });
    onTestFinished(() => {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    });
    renderAt(`${routes.signInAlias}?next=%2Fnope-return`, null);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The return address is a path the app has no page for, so arriving there is unmistakable.
    expect(await screen.findByRole('heading', { name: /does not exist/i })).toBeInTheDocument();
  });

  it("keeps the companion's ?code= through sign-in to the local agents page (spec 040)", async () => {
    server.use(
      http.post(`${API}/auth/login`, () => HttpResponse.json({ user: aUser })),
      http.get(`${API}/me/local-agents`, () => HttpResponse.json({ devices: [] })),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () =>
        HttpResponse.json({
          companionVersion: '0.1.0',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          name: 'Studio PC',
          platform: 'macos',
        }),
      ),
    );
    renderAt(`${routes.localAgentsSettings}?code=BCDF-GHJK`, null);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Work email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Local agents' })).toBeInTheDocument();
    expect(screen.getByLabelText('Pairing code')).toHaveValue('BCDF-GHJK');
  });

  it('falls back to the not-found screen', async () => {
    renderAt('/nope', null);

    expect(await screen.findByRole('heading', { name: /does not exist/i })).toBeInTheDocument();
  });
});

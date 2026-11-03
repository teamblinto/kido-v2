import { MFA_REQUIRED } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { API, server } from '@/test/server';
import { aUser, problemResponse, renderScreen } from '@/test/render';
import { SignInPage } from './sign-in-page';

const EMAIL = 'rakibul@blinto.co';
const PASSWORD = 'correct horse battery staple';

function renderSignIn(): void {
  renderScreen(<SignInPage />, {
    path: '/sign-in',
    routes: {
      '/': <p>Dashboard</p>,
      '/sign-in/two-factor': <p>Two-factor</p>,
      '/sign-in/verify-email': <p>Confirm your address</p>,
    },
    user: null,
  });
}

async function submitCredentials(password = PASSWORD): Promise<void> {
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Work email'), EMAIL);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInPage', () => {
  it('signs in and lands on the dashboard', async () => {
    server.use(http.post(`${API}/auth/login`, () => HttpResponse.json({ user: aUser })));

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('returns to a mailed ?next= path after signing in (spec 031, R7)', async () => {
    server.use(http.post(`${API}/auth/login`, () => HttpResponse.json({ user: aUser })));

    renderScreen(<SignInPage />, {
      path: '/sign-in?next=%2Fproject-invitations%2Faccept%2Ftok%3Forg%3Do1',
      routes: {
        '/': <p>Dashboard</p>,
        '/project-invitations/accept/:token': <p>Accept page</p>,
      },
      user: null,
    });
    await submitCredentials();

    expect(await screen.findByText('Accept page')).toBeInTheDocument();
  });

  it('ignores a ?next= that is not a same-origin relative path', async () => {
    server.use(http.post(`${API}/auth/login`, () => HttpResponse.json({ user: aUser })));

    renderScreen(<SignInPage />, {
      path: '/sign-in?next=%2F%2Fevil.example%2Fx',
      routes: { '/': <p>Dashboard</p> },
      user: null,
    });
    await submitCredentials();

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('sends exactly the body the contract describes', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${API}/auth/login`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ user: aUser });
      }),
    );

    renderSignIn();
    await submitCredentials();

    // `loginRequestSchema` is a strict object, so an extra member would be a 422 from the real API.
    await waitFor(() => {
      expect(body).toEqual({ email: EMAIL, password: PASSWORD });
    });
  });

  it('routes to the challenge when the account has a second factor', async () => {
    server.use(http.post(`${API}/auth/login`, () => HttpResponse.json({ status: MFA_REQUIRED })));

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByText('Two-factor')).toBeInTheDocument();
  });

  it('takes an unverified account to the confirmation screen, still signed in', async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json({ user: { ...aUser, emailVerified: false } }),
      ),
    );

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByText('Confirm your address')).toBeInTheDocument();
  });

  it('reports incorrect credentials without revealing which field failed', async () => {
    server.use(http.post(`${API}/auth/login`, () => problemResponse('unauthorized', 401)));

    renderSignIn();
    await submitCredentials();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('That email or password is incorrect');
    // The API answers a wrong password and an unknown address identically. Naming either here
    // would rebuild the enumeration oracle in the client.
    expect(alert).not.toHaveTextContent(/no account|not found|unknown/i);
  });

  it('names a throttle rather than blaming the password for it', async () => {
    server.use(http.post(`${API}/auth/login`, () => problemResponse('rate-limited', 429)));

    renderSignIn();
    await submitCredentials();

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i);
  });

  it('rejects a malformed pair without troubling the API', async () => {
    let called = false;

    server.use(
      http.post(`${API}/auth/login`, () => {
        called = true;

        return HttpResponse.json({ user: aUser });
      }),
    );

    renderSignIn();
    // Below `PASSWORD_MAX_LENGTH` is fine, but `loginRequestSchema` requires at least one
    // character and a well-formed address; "not-an-address" fails the second.
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Work email'), 'not-an-address');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email or password is incorrect',
    );
    expect(called).toBe(false);
  });

  it('toggles password visibility', async () => {
    const user = userEvent.setup();

    renderSignIn();

    const password = await screen.findByLabelText('Password');

    expect(password).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
  });
});

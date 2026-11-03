import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { destinationAfterSignIn } from '@/features/auth/session/route-guards';
import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { InvitationAcceptPage } from './invitation-accept-page';

const ORG = '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcHxxxxxxxxxxx';
/** The shape the API's `invitationUrl` mails: token and organisation both in the query. */
const PATH = `/invitations/accept?token=${TOKEN}&org=${ORG}`;

function SignInStub(): React.JSX.Element {
  const location = useLocation();

  return <p>Sign in, then {destinationAfterSignIn(location.state)}</p>;
}

function renderAccept(user?: null): void {
  renderScreen(<InvitationAcceptPage />, {
    path: PATH,
    route: routes.invitationAccept,
    routes: { [routes.home]: <p>Home</p>, [routes.signIn]: <SignInStub /> },
    ...(user === null ? { user } : {}),
  });
}

/** Spec 033: the organisation invitation link has a page to land on. */
describe('InvitationAcceptPage', () => {
  it('sends a signed-out visitor to sign-in and comes back', async () => {
    renderAccept(null);

    expect(await screen.findByText(`Sign in, then ${PATH}`)).toBeInTheDocument();
  });

  it('accepts and opens the workspace', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${API}/orgs/${ORG}/invitations/accept`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ orgId: ORG, role: 'member', status: 'invitation-accepted' });
      }),
    );

    renderAccept();

    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(body).toEqual({ token: TOKEN });
  });

  it('shows one sentence for a dead link, naming nothing', async () => {
    server.use(
      http.post(`${API}/orgs/${ORG}/invitations/accept`, () =>
        problemResponse('token-invalid', 400),
      ),
    );

    renderAccept();

    await waitFor(() => {
      expect(screen.getByText('This invitation link no longer works.')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain(ORG);
  });
});

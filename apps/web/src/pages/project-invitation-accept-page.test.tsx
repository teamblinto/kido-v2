import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { destinationAfterSignIn } from '@/features/auth/session/route-guards';
import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ProjectInvitationAcceptPage } from './project-invitation-accept-page';

const ORG = '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55';
const PROJECT = '4f7c1d2e-8b9a-4c3d-9e2f-1a0b3c4d5e6f';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcHxxxxxxxxxxx';
const PATH = `/project-invitations/accept/${TOKEN}?org=${ORG}`;

/** Where sign-in would send the visitor back to, rendered so the test can read it. */
function SignInStub(): React.JSX.Element {
  const location = useLocation();

  return <p>Sign in, then {destinationAfterSignIn(location.state)}</p>;
}

function ProjectStub(): React.JSX.Element {
  const location = useLocation();

  return <p>Project {location.pathname}</p>;
}

function renderAccept(user?: null): void {
  renderScreen(<ProjectInvitationAcceptPage />, {
    path: PATH,
    route: routes.projectInvitationAccept,
    routes: { [routes.project]: <ProjectStub />, [routes.signIn]: <SignInStub /> },
    ...(user === null ? { user } : {}),
  });
}

/** Spec 031 T051 (research R7). */
describe('ProjectInvitationAcceptPage', () => {
  it('sends a signed-out visitor to sign-in and comes back', async () => {
    renderAccept(null);

    expect(await screen.findByText(`Sign in, then ${PATH}`)).toBeInTheDocument();
  });

  it('accepts and opens the project', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${API}/orgs/${ORG}/project-invitations/accept`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ projectId: PROJECT });
      }),
    );

    renderAccept();

    expect(await screen.findByText(`Project /projects/${PROJECT}`)).toBeInTheDocument();
    expect(body).toEqual({ token: TOKEN });
  });

  it('shows one sentence for a dead link, naming nothing', async () => {
    server.use(
      http.post(`${API}/orgs/${ORG}/project-invitations/accept`, () =>
        problemResponse('token-invalid', 400),
      ),
    );

    renderAccept();

    await waitFor(() => {
      expect(screen.getByText('This invitation link no longer works.')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain(ORG);
    expect(document.body.textContent).not.toContain(PROJECT);
  });
});

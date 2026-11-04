import type { Connection } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GITHUB_RETURN_KEY } from '@/features/project/lib/github-sync';
import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { GithubCallbackPage } from './github-callback-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

const aConnection: Connection = {
  account: { id: 9001, login: 'blinto-co', type: 'organization' },
  canCreateRepositories: true,
  circuitOpenUntil: null,
  connectedAt: '2026-09-20T10:00:00.000Z',
  connectedBy: { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', name: 'Rakibul' },
  credentialFingerprint: 'a1b2c3d4',
  health: 'healthy',
  id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastVerifiedAt: '2026-09-20T10:00:00.000Z',
  provider: 'github',
};

const PATH = `${routes.githubCallback}?installation_id=4242&setup_action=install&state=st4te`;

beforeEach(() => {
  server.use(http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })));
});

function renderCallback(path = PATH) {
  return renderScreen(<GithubCallbackPage />, {
    path,
    routes: { [routes.connectorsSettings]: <p>Connectors settings</p> },
  });
}

describe('GithubCallbackPage', () => {
  it('posts the installation and state, then returns to the settings page', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/complete`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json(aConnection);
      }),
    );

    renderCallback();

    expect(await screen.findByText('Connectors settings')).toBeInTheDocument();
    expect(body).toEqual({ installationId: 4242, state: 'st4te' });
  });

  it('shows the catalogue message for a refused state', async () => {
    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/complete`, () =>
        problemResponse('oauth-state-invalid', 400),
      ),
    );

    renderCallback();

    expect(
      await screen.findByText('That sign-in took too long. Please start again.'),
    ).toBeInTheDocument();
  });

  it('never calls the API when GitHub sent no installation', async () => {
    let called = false;

    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/complete`, () => {
        called = true;

        return HttpResponse.json(aConnection);
      }),
    );

    renderCallback(routes.githubCallback);

    expect(await screen.findByText('We could not connect GitHub')).toBeInTheDocument();
    await waitFor(() => {
      expect(called).toBe(false);
    });
  });

  describe('coming back to the project that began the install (spec 044)', () => {
    afterEach(() => {
      window.sessionStorage.clear();
    });

    function connected() {
      server.use(
        http.post(`${API}/orgs/${ORG_ID}/connectors/github/complete`, () =>
          HttpResponse.json(aConnection),
        ),
      );
    }

    function renderWithProject() {
      return renderScreen(<GithubCallbackPage />, {
        path: PATH,
        routes: {
          [routes.connectorsSettings]: <p>Connectors settings</p>,
          '/projects/:projectId': <p>The project</p>,
        },
      });
    }

    it('returns to the remembered path and forgets it', async () => {
      connected();
      window.sessionStorage.setItem(GITHUB_RETURN_KEY, '/projects/p1?panel=github');

      renderWithProject();

      expect(await screen.findByText('The project')).toBeInTheDocument();
      expect(window.sessionStorage.getItem(GITHUB_RETURN_KEY)).toBeNull();
    });

    it.each(['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com/projects/p1'])(
      'refuses %j and returns to settings',
      async (stored) => {
        connected();
        window.sessionStorage.setItem(GITHUB_RETURN_KEY, stored);

        renderWithProject();

        expect(await screen.findByText('Connectors settings')).toBeInTheDocument();
      },
    );
  });
});

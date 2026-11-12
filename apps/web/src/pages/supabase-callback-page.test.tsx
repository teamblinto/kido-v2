import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUPABASE_RETURN_KEY } from '@/features/project/hooks/use-integrations';

import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { SupabaseCallbackPage } from './supabase-callback-page';

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

const aConnection = {
  account: { name: 'Acme Supabase', ref: 'sb-org-1' },
  authType: 'oauth',
  connectedAt: '2026-09-23T10:00:00.000Z',
  connectedBy: { id: ORG_ID, name: 'Rakibul' },
  credentialFingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
  failedResources: [],
  health: 'healthy',
  id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastVerifiedAt: '2026-09-23T10:00:00.000Z',
  provider: 'supabase',
  removalRequestedAt: null,
  scopes: ['projects:read', 'secrets:read'],
};

const PATH = `${routes.supabaseCallback}?code=c0de&state=st4te`;

beforeEach(() => {
  server.use(
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })),
    http.post(`${API}/orgs/${ORG_ID}/connectors/supabase/complete`, () =>
      HttpResponse.json(aConnection, { status: 201 }),
    ),
  );
});

afterEach(() => {
  window.sessionStorage.clear();
});

function renderCallback(path = PATH) {
  return renderScreen(<SupabaseCallbackPage />, {
    path,
    routes: {
      [routes.connectorsSettings]: <p>Connectors settings</p>,
      [routes.project]: <p>The project</p>,
    },
  });
}

/** Spec 030 T047. */
describe('SupabaseCallbackPage', () => {
  it('echoes the code and state once, then returns to the settings page', async () => {
    const bodies: unknown[] = [];

    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/supabase/complete`, async ({ request }) => {
        bodies.push(await request.json());

        return HttpResponse.json(aConnection, { status: 201 });
      }),
    );

    renderCallback();

    expect(await screen.findByText('Connectors settings')).toBeInTheDocument();
    expect(bodies).toEqual([{ code: 'c0de', state: 'st4te' }]);
  });

  it('returns to the project panel that began the connect, and forgets it', async () => {
    window.sessionStorage.setItem(SUPABASE_RETURN_KEY, '/projects/p-1?panel=integrations');

    renderCallback();

    expect(await screen.findByText('The project')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(SUPABASE_RETURN_KEY)).toBeNull();
  });

  it.each(['//evil.example/x', 'https://evil.example/x', '/\\evil.example', 'projects/p-1'])(
    'ignores a stored return path that could leave the origin (%s)',
    async (stored) => {
      window.sessionStorage.setItem(SUPABASE_RETURN_KEY, stored);

      renderCallback();

      expect(await screen.findByText('Connectors settings')).toBeInTheDocument();
    },
  );

  it('renders the catalogue message for a refused state', async () => {
    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/supabase/complete`, () =>
        problemResponse('oauth-state-invalid', 400),
      ),
    );

    renderCallback();

    expect(
      await screen.findByText('That sign-in took too long. Please start again.'),
    ).toBeInTheDocument();
  });

  it('renders a declined authorisation without calling the API', async () => {
    let called = false;

    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/supabase/complete`, () => {
        called = true;

        return HttpResponse.json(aConnection, { status: 201 });
      }),
    );

    renderCallback(`${routes.supabaseCallback}?error=access_denied&state=st4te`);

    expect(
      await screen.findByText(
        'Supabase did not authorise the connection. Please start again from settings.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(called).toBe(false);
    });
  });
});

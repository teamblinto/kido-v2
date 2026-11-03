import { type Connection, MFA_STEPPED_UP } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ConnectorsSettingsPage } from './connectors-settings-page';

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

const aNeonConnection = {
  account: { name: 'Acme', ref: 'org-neon-1' },
  authType: 'token',
  connectedAt: '2026-09-23T10:00:00.000Z',
  connectedBy: { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', name: 'Rakibul' },
  credentialFingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
  failedResources: [],
  health: 'healthy',
  id: 'd8e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastVerifiedAt: '2026-09-23T10:00:00.000Z',
  provider: 'neon',
  removalRequestedAt: null,
  scopes: ['projects:read', 'branches:write'],
} satisfies Connection;

const anOperation = {
  bindingId: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  deploymentId: null,
  finishedAt: null,
  id: '77777777-7777-4777-8777-777777777777',
  kind: 'connection_remove',
  projectId: null,
  providerState: null,
  reason: null,
  requestedBy: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  startedAt: null,
  state: 'queued',
};

/** The card of one provider: every provider has its own, headed by its name. */
async function card(name: string) {
  return within(await screen.findByRole('region', { name }));
}

const INSTALL_URL = 'https://github.com/apps/forge/installations/new?state=abc';

const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  server.use(
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })),
    // The model providers section (spec 020) lives on this page too; its own suite covers it.
    http.get(`${API}/orgs/${ORG_ID}/provider-keys`, () => HttpResponse.json({ keys: [] })),
  );
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  assign.mockReset();
});

describe('ConnectorsSettingsPage', () => {
  it('lists the connection with its account, health and fingerprint — never a token', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({ connections: [aConnection] }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    const github = await card('GitHub');

    expect(await github.findByText('blinto-co')).toBeInTheDocument();
    expect(github.getByText('Healthy')).toBeInTheDocument();
    expect(github.getByText('a1b2c3d4')).toBeInTheDocument();
    expect(github.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
    expect(github.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(github.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('mounts the model providers section under its own heading', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () => HttpResponse.json({ connections: [] })),
    );

    renderScreen(<ConnectorsSettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Model providers' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('starts the install and navigates to the url the API returns', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () => HttpResponse.json({ connections: [] })),
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/install`, () =>
        HttpResponse.json({ installUrl: INSTALL_URL }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    await userEvent.click((await card('GitHub')).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(INSTALL_URL);
    });
  });

  // Spec 030 R14: removal needs a recent second factor. A stepped-up session is answered 202.
  it('removes the connection from a stepped-up session and shows the empty state', async () => {
    let removed = false;

    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({ connections: removed ? [] : [aConnection] }),
      ),
      http.delete(`${API}/orgs/${ORG_ID}/connectors/${aConnection.id}`, () => {
        removed = true;

        return HttpResponse.json(anOperation, { status: 202 });
      }),
    );

    renderScreen(<ConnectorsSettingsPage />);

    const github = await card('GitHub');
    await userEvent.click(await github.findByRole('button', { name: 'Remove' }));

    expect(await github.findByText('Not connected.')).toBeInTheDocument();
  });

  it('without a recent second factor, removal asks for a code, steps up, and retries once', async () => {
    let steppedUp = false;
    let removed = false;
    let stepUpBody: unknown;

    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({ connections: removed ? [] : [aConnection] }),
      ),
      http.delete(`${API}/orgs/${ORG_ID}/connectors/${aConnection.id}`, () => {
        if (!steppedUp) return problemResponse('step-up-required', 403);
        removed = true;

        return HttpResponse.json(anOperation, { status: 202 });
      }),
      http.post(`${API}/auth/mfa/step-up`, async ({ request }) => {
        stepUpBody = await request.json();
        steppedUp = true;

        return HttpResponse.json({ status: MFA_STEPPED_UP });
      }),
    );

    renderScreen(<ConnectorsSettingsPage />);

    const github = await card('GitHub');
    await userEvent.click(await github.findByRole('button', { name: 'Remove' }));

    const dialog = within(await screen.findByRole('dialog'));
    expect(
      dialog.getByText(/Removing a connector needs a recent second factor/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.type(dialog.getByLabelText('Authenticator code'), '123456');
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm' }));

    expect(await github.findByText('Not connected.')).toBeInTheDocument();
    expect(stepUpBody).toEqual({ code: '123456' });
  });

  it('shows one card per provider, a non-GitHub connection with its account and permissions', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({ connections: [aNeonConnection] }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    for (const name of ['GitHub', 'Netlify', 'Neon', 'Supabase', 'Resend', 'Cloudflare']) {
      expect(await screen.findByRole('region', { name })).toBeInTheDocument();
    }

    const neon = await card('Neon');
    expect(neon.getByText('Acme')).toBeInTheDocument();
    expect(neon.getByText('projects:read, branches:write')).toBeInTheDocument();
    expect(neon.getByText('sha256:0c86cb5464bdd26117552b7435cd1df3')).toBeInTheDocument();
    expect((await card('Netlify')).getByText('Not connected.')).toBeInTheDocument();
  });

  it('connects a pasted-token provider through the paste dialog', async () => {
    let connected = false;

    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({ connections: connected ? [aNeonConnection] : [] }),
      ),
      http.post(`${API}/orgs/${ORG_ID}/connectors/neon/token`, () => {
        connected = true;

        return HttpResponse.json(aNeonConnection, { status: 201 });
      }),
    );

    renderScreen(<ConnectorsSettingsPage />);

    await userEvent.click((await card('Neon')).getByRole('button', { name: 'Connect' }));

    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('Neon token'), 'napi_abc');
    await userEvent.click(dialog.getByRole('button', { name: 'Connect' }));

    expect(await (await card('Neon')).findByText('Acme')).toBeInTheDocument();
  });

  it('starts the Supabase authorisation and navigates to its url', async () => {
    const url = 'https://api.supabase.com/v1/oauth/authorize?state=abc';

    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () => HttpResponse.json({ connections: [] })),
      http.post(`${API}/orgs/${ORG_ID}/connectors/supabase/install`, () =>
        HttpResponse.json({ url }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    await userEvent.click((await card('Supabase')).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(url);
    });
  });

  it('shows Removing… with its buttons disabled while a removal runs, and names what could not be released', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({
          connections: [
            {
              ...aNeonConnection,
              failedResources: [{ kind: 'neon_branch', name: 'forge-preview-1' }],
              removalRequestedAt: '2026-09-23T10:05:00.000Z',
            },
          ],
        }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    const neon = await card('Neon');
    expect(await neon.findByRole('button', { name: 'Removing…' })).toBeDisabled();
    expect(neon.getByRole('button', { name: 'Verify' })).toBeDisabled();
    expect(neon.getByText(/forge-preview-1/u)).toBeInTheDocument();
  });

  it('verifies the connection and reflects the fresh health', async () => {
    let verified = false;

    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({
          connections: [{ ...aConnection, health: verified ? 'healthy' : 'needs_reauth' }],
        }),
      ),
      http.post(`${API}/orgs/${ORG_ID}/connectors/${aConnection.id}/verify`, () => {
        verified = true;

        return HttpResponse.json(aConnection);
      }),
    );

    renderScreen(<ConnectorsSettingsPage />);

    expect(await screen.findByText('Needs reconnecting')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('Healthy')).toBeInTheDocument();
  });

  it('offers Reconnect on a needs_reauth connection, which runs the install again', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({ connections: [{ ...aConnection, health: 'needs_reauth' }] }),
      ),
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/install`, () =>
        HttpResponse.json({ installUrl: INSTALL_URL }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    expect(
      await screen.findByText(
        'GitHub needs reconnecting. Pushes and pulls are refused until it is.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(INSTALL_URL);
    });
  });

  it('shows when an unavailable connection will be retried', async () => {
    const until = '2026-09-21T12:30:00.000Z';

    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
        HttpResponse.json({
          connections: [{ ...aConnection, circuitOpenUntil: until, health: 'unavailable' }],
        }),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    expect(
      await screen.findByText(
        `GitHub is unavailable. Retrying after ${new Date(until).toLocaleString()}.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('shows the catalogue message when the App is not configured', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () => HttpResponse.json({ connections: [] })),
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/install`, () =>
        problemResponse('oauth-provider-not-configured', 503),
      ),
    );

    renderScreen(<ConnectorsSettingsPage />);

    await userEvent.click((await card('GitHub')).getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

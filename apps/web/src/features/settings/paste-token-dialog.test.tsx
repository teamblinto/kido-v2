import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { PasteTokenDialog } from './paste-token-dialog';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const aConnection = {
  account: { name: 'Acme DNS', ref: 'cf-acct-1' },
  authType: 'token',
  connectedAt: '2026-09-23T10:00:00.000Z',
  connectedBy: { id: ORG_ID, name: 'Rakibul' },
  credentialFingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
  failedResources: [],
  health: 'healthy',
  id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastVerifiedAt: '2026-09-23T10:00:00.000Z',
  provider: 'cloudflare',
  removalRequestedAt: null,
  scopes: ['zone:read', 'dns:read'],
};

describe('PasteTokenDialog', () => {
  it('names the permissions a provider needs, and recommends a project-scoped Neon key', () => {
    renderScreen(
      <PasteTokenDialog
        orgId={ORG_ID}
        provider="neon"
        onOpenChange={() => undefined}
        onConnected={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Connect Neon' })).toBeInTheDocument();
    expect(screen.getByText(/project-scoped key is recommended/u)).toBeInTheDocument();
    expect(screen.getByText('Create and delete branches')).toBeInTheDocument();
  });

  it('posts the trimmed token and reports the connection', async () => {
    let body: unknown;
    const onConnected = vi.fn();

    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/cloudflare/token`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(aConnection, { status: 201 });
      }),
    );

    renderScreen(
      <PasteTokenDialog
        orgId={ORG_ID}
        provider="cloudflare"
        onOpenChange={() => undefined}
        onConnected={onConnected}
      />,
    );

    await userEvent.type(screen.getByLabelText('Cloudflare token'), '  cf-token-123  ');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(onConnected).toHaveBeenCalled();
    });
    expect(body).toEqual({ token: 'cf-token-123' });
  });

  it('shows what is missing from a 422', async () => {
    server.use(
      http.post(`${API}/orgs/${ORG_ID}/connectors/cloudflare/token`, () =>
        problemResponse('validation-failed', 422, {
          missing: ['dns:read'],
          reason: 'missing-scope',
        }),
      ),
    );

    renderScreen(
      <PasteTokenDialog
        orgId={ORG_ID}
        provider="cloudflare"
        onOpenChange={() => undefined}
        onConnected={() => undefined}
      />,
    );

    await userEvent.type(screen.getByLabelText('Cloudflare token'), 'cf-short');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Missing: dns:read')).toBeInTheDocument();
  });
});

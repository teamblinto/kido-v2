import {
  MFA_STEPPED_UP,
  type LocalAgentDevice,
  type LocalAgentProviderStatus,
  localAgentDeviceListSchema,
  pairingPreviewSchema,
} from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { LocalAgentsSettingsPage } from '@/pages/local-agents-settings-page';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';

const CODE = 'BCDF-GHJK';
const PATH = '/settings/local-agents';
const REQUESTED_AT = '2026-11-02T10:00:00.000Z';

function preview(expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()) {
  return pairingPreviewSchema.parse({
    companionVersion: '0.1.0',
    expiresAt,
    name: 'Studio PC',
    platform: 'windows',
    requestedAt: REQUESTED_AT,
    requesterIp: '203.0.113.0/24',
  });
}

/** Approval needs the code typed again: the address's prefill alone never approves. */
async function confirmCode(typed = 'bcdf ghjk'): Promise<void> {
  await userEvent.type(await screen.findByLabelText('Type the code again to approve'), typed);
}

function provider(overrides: Partial<LocalAgentProviderStatus> = {}): LocalAgentProviderStatus {
  return {
    auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
    checkedAt: '2026-11-02T10:00:00.000Z',
    installed: true,
    message: null,
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    policy: { allowed: true, reason: null },
    provider: 'claude',
    version: '2.1.0',
    ...overrides,
  };
}

const aDevice: LocalAgentDevice = {
  companionVersion: '0.1.0',
  createdAt: '2026-11-01T10:00:00.000Z',
  id: '0b6e7a1c-5f7e-4f55-9d0b-6a8f1f3c2d10',
  lastSeenAt: '2026-11-02T10:00:00.000Z',
  name: 'Studio PC',
  online: true,
  platform: 'windows',
  providers: [provider()],
  workspaces: [{ id: 'ws_app', label: 'baios-app' }],
};

function devices(list: LocalAgentDevice[]) {
  const body = localAgentDeviceListSchema.parse({ devices: list });

  return http.get(`${API}/me/local-agents`, () => HttpResponse.json(body));
}

function stepUpHandler(onStepUp: () => void) {
  return http.post(`${API}/auth/mfa/step-up`, () => {
    onStepUp();

    return HttpResponse.json({ status: MFA_STEPPED_UP });
  });
}

async function stepUp(): Promise<void> {
  const dialog = within(await screen.findByRole('dialog'));
  await userEvent.type(dialog.getByLabelText('Authenticator code'), '123456');
  await userEvent.click(dialog.getByRole('button', { name: 'Confirm' }));
}

describe('Local agents — pairing', () => {
  it('prefills the code from the address, normalised, and previews the computer', async () => {
    let asked: string | undefined;
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, ({ params }) => {
        asked = String(params.userCode);

        return HttpResponse.json(preview());
      }),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: `${PATH}?code=bcdf ghjk` });

    expect(screen.getByLabelText('Pairing code')).toHaveValue(CODE);
    const pair = within(screen.getByRole('region', { name: 'Pair a computer' }));
    expect(await pair.findByText('Studio PC')).toBeInTheDocument();
    expect(pair.getByText('Windows')).toBeInTheDocument();
    expect(pair.getByText('0.1.0')).toBeInTheDocument();
    expect(pair.getByText(/^[45]:\d\d$/u)).toBeInTheDocument();
    expect(asked).toBe(CODE);
  });

  it('shows when and from where the code was requested, and warns before approving', async () => {
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () => HttpResponse.json(preview())),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: `${PATH}?code=${CODE}` });

    const pair = within(screen.getByRole('region', { name: 'Pair a computer' }));
    expect(await pair.findByText(new Date(REQUESTED_AT).toLocaleString())).toBeInTheDocument();
    expect(pair.getByText('203.0.113.0/24')).toBeInTheDocument();
    expect(pair.getByRole('note')).toHaveTextContent(
      'Only approve if you just ran baios-companion pair on your own computer',
    );
  });

  it('keeps Approve disabled until the code is typed again and matches', async () => {
    const approvals: unknown[] = [];
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () => HttpResponse.json(preview())),
      http.post(`${API}/me/local-agents/pairings/approve`, async ({ request }) => {
        approvals.push(await request.json());

        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: `${PATH}?code=${CODE}` });

    const approve = await screen.findByRole('button', { name: 'Approve' });
    // The prefill from the link loads the preview but is not a confirmation.
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();

    await confirmCode('BCDF-GHJX');
    expect(approve).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Type the code again to approve'));
    await confirmCode(' bcdf-ghjk ');
    expect(approve).toBeEnabled();

    await userEvent.click(approve);
    expect(await screen.findByText(/^Paired\./u)).toBeInTheDocument();
    expect(approvals).toEqual([{ userCode: CODE }]);
  });

  it('approves after a step-up, retrying once, and says so', async () => {
    let steppedUp = false;
    const approvals: unknown[] = [];
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () => HttpResponse.json(preview())),
      http.post(`${API}/me/local-agents/pairings/approve`, async ({ request }) => {
        approvals.push(await request.json());
        if (!steppedUp) return problemResponse('step-up-required', 403);

        return new HttpResponse(null, { status: 204 });
      }),
      stepUpHandler(() => {
        steppedUp = true;
      }),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: `${PATH}?code=${CODE}` });

    await confirmCode();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await stepUp();

    expect(await screen.findByText(/^Paired\./u)).toBeInTheDocument();
    expect(approvals).toEqual([{ userCode: CODE }, { userCode: CODE }]);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('denies without a step-up', async () => {
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () => HttpResponse.json(preview())),
      http.post(
        `${API}/me/local-agents/pairings/deny`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: `${PATH}?code=${CODE}` });

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    expect(await screen.findByText(/Pairing denied/u)).toBeInTheDocument();
  });

  it('refuses to approve an expired code', async () => {
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () =>
        HttpResponse.json(preview('2020-01-01T00:00:00.000Z')),
      ),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: `${PATH}?code=${CODE}` });

    expect(await screen.findByText(/This code has expired/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('says an unknown code is not valid, by its problem type (400)', async () => {
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () =>
        problemResponse('local-agent-pairing-invalid', 400),
      ),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: PATH });
    await userEvent.type(screen.getByLabelText('Pairing code'), 'bcdfghjk');

    expect(await screen.findByText(/That pairing code is not valid/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('reads the problem type, not the status: a plain 400 is not called an invalid code', async () => {
    server.use(
      devices([]),
      http.get(`${API}/me/local-agents/pairings/:userCode`, () =>
        problemResponse('bad-request', 400),
      ),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: PATH });
    await userEvent.type(screen.getByLabelText('Pairing code'), 'bcdfghjk');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/That pairing code is not valid/u)).not.toBeInTheDocument();
  });
});

describe('Local agents — your computers', () => {
  it('shows online and offline computers with what each CLI needs', async () => {
    server.use(
      devices([
        {
          ...aDevice,
          providers: [
            provider({ auth: { method: null, plan: null, status: 'unauthenticated' } }),
            provider({
              auth: { method: 'subscription', plan: 'Plus', status: 'authenticated' },
              policy: { allowed: false, reason: 'ChatGPT sign-in is not enabled here.' },
              provider: 'codex',
            }),
          ],
        },
        {
          ...aDevice,
          id: '1c7f8b2d-6a8f-4a66-8e1c-7b9a2a4d3e21',
          name: 'Laptop',
          online: false,
          providers: [provider({ installed: false, version: null })],
          workspaces: [],
        },
      ]),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: PATH });

    const studio = within(
      (await screen.findByRole('heading', { name: 'Studio PC' })).closest('section')!,
    );
    expect(studio.getByText('Online')).toBeInTheDocument();
    expect(studio.getByText(/Not signed in/u)).toBeInTheDocument();
    expect(
      studio.getByRole('button', { name: 'Copy command: baios-companion login claude' }),
    ).toBeInTheDocument();
    expect(studio.getByText('Blocked')).toBeInTheDocument();
    expect(studio.getByText('ChatGPT sign-in is not enabled here.')).toBeInTheDocument();
    expect(studio.getByText('baios-app')).toBeInTheDocument();

    const laptop = within(screen.getByRole('heading', { name: 'Laptop' }).closest('section')!);
    expect(laptop.getByText('Offline')).toBeInTheDocument();
    expect(laptop.getByText('Not installed')).toBeInTheDocument();
    expect(laptop.getByText(/None yet/u)).toBeInTheDocument();
  });

  it('revokes after confirming and stepping up', async () => {
    let steppedUp = false;
    let deletes = 0;
    let listed: LocalAgentDevice[] = [aDevice];
    server.use(
      http.get(`${API}/me/local-agents`, () => HttpResponse.json({ devices: listed })),
      http.delete(`${API}/me/local-agents/:deviceId`, ({ params }) => {
        deletes += 1;
        expect(params.deviceId).toBe(aDevice.id);
        if (!steppedUp) return problemResponse('step-up-required', 403);
        listed = [];

        return new HttpResponse(null, { status: 204 });
      }),
      stepUpHandler(() => {
        steppedUp = true;
      }),
    );

    renderScreen(<LocalAgentsSettingsPage />, { path: PATH });

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Revoke Studio PC?' }));
    await userEvent.click(confirm.getByRole('button', { name: 'Revoke computer' }));
    await stepUp();

    expect(await screen.findByText('No computers paired yet.')).toBeInTheDocument();
    await waitFor(() => {
      expect(deletes).toBe(2);
    });
  });
});

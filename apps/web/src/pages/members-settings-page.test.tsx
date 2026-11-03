import { IDEMPOTENCY_KEY_HEADER } from '@repo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { MembersSettingsPage, ORG_INVITE_SENT_COPY } from './members-settings-page';

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

beforeEach(() => {
  server.use(
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })),
    http.get(`${API}/orgs/${ORG_ID}/members`, () =>
      HttpResponse.json({
        members: [
          {
            acceptedAt: '2026-08-01T09:00:00.000Z',
            email: 'owner@example.com',
            invitedAt: '2026-08-01T09:00:00.000Z',
            role: 'owner',
            userId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      }),
    ),
  );
});

/** Spec 033: inviting a member to the organisation. */
describe('MembersSettingsPage', () => {
  it('lists members and sends an invitation with an idempotency key', async () => {
    let body: unknown = null;
    let key: string | null = null;

    server.use(
      http.post(`${API}/orgs/${ORG_ID}/invitations`, async ({ request }) => {
        body = await request.json();
        key = request.headers.get(IDEMPOTENCY_KEY_HEADER);

        return HttpResponse.json(
          {
            expiresAt: '2026-10-12T09:00:00.000Z',
            id: '22222222-2222-4222-8222-222222222222',
            status: 'invitation-sent',
          },
          { status: 202 },
        );
      }),
    );

    renderScreen(<MembersSettingsPage />);
    const user = userEvent.setup();

    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Invite member'), 'new@example.com');
    await user.selectOptions(screen.getByLabelText('Role for the invitation'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByText(ORG_INVITE_SENT_COPY)).toBeInTheDocument();
    expect(body).toEqual({ email: 'new@example.com', role: 'admin' });
    expect(key).not.toBeNull();
  });

  it("shows the server's refusal", async () => {
    server.use(
      http.post(`${API}/orgs/${ORG_ID}/invitations`, () =>
        problemResponse('forbidden', 403, { detail: 'You may not invite to that role.' }),
      ),
    );

    renderScreen(<MembersSettingsPage />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Invite member'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

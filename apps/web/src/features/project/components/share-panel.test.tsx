import type { ProjectAccessResponse } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { INVITE_SENT_COPY, SharePanel } from './share-panel';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const OWNER = '00000000-0000-4000-8000-000000000001';
const GUEST = '00000000-0000-4000-8000-000000000002';
const INVITATION = '00000000-0000-4000-8000-000000000003';

const BASE = `${API}/orgs/${ORG}/projects/${PROJECT}`;

let access: ProjectAccessResponse;

function serve(): void {
  server.use(http.get(`${BASE}/access`, () => HttpResponse.json(access)));
}

function renderPanel(): void {
  renderScreen(<SharePanel orgId={ORG} projectId={PROJECT} />);
}

beforeEach(() => {
  access = {
    grants: [
      { email: 'owner@example.com', role: 'owner', userId: OWNER },
      { email: 'guest@example.com', role: 'editor', userId: GUEST },
    ],
    invitations: [
      {
        email: 'waiting@example.com',
        expiresAt: '2026-09-30T10:00:00.000Z',
        id: INVITATION,
        role: 'viewer',
      },
    ],
  };
  serve();
});

/** Spec 031 T054 (contracts/sharing.md §§ 1–5, 8). */
describe('SharePanel', () => {
  it('lists every grant and open invitation', async () => {
    renderPanel();

    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('guest@example.com')).toBeInTheDocument();
    expect(screen.getByText('waiting@example.com')).toBeInTheDocument();
  });

  it('invites an address and shows it waiting', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${BASE}/invitations`, async ({ request }) => {
        body = await request.json();
        access = {
          ...access,
          invitations: [
            ...access.invitations,
            {
              email: 'new@example.com',
              expiresAt: '2026-09-30T10:00:00.000Z',
              id: '00000000-0000-4000-8000-000000000004',
              role: 'editor',
            },
          ],
        };

        return HttpResponse.json(
          { expiresAt: '2026-09-30T10:00:00.000Z', id: INVITATION, status: 'invitation-sent' },
          { status: 202 },
        );
      }),
    );

    renderPanel();
    await screen.findByText('owner@example.com');

    await userEvent.type(screen.getByLabelText('Email address'), 'new@example.com');
    await userEvent.selectOptions(screen.getByLabelText('Role for the invitation'), 'editor');
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    expect(body).toEqual({ email: 'new@example.com', role: 'editor' });
  });

  it('shows the same confirmation whatever the address', async () => {
    server.use(
      http.post(`${BASE}/invitations`, () =>
        HttpResponse.json(
          { expiresAt: '2026-09-30T10:00:00.000Z', id: INVITATION, status: 'invitation-sent' },
          { status: 202 },
        ),
      ),
    );

    renderPanel();
    await screen.findByText('owner@example.com');

    for (const email of ['stranger@example.com', 'guest@example.com']) {
      await userEvent.clear(screen.getByLabelText('Email address'));
      await userEvent.type(screen.getByLabelText('Email address'), email);
      await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

      expect(await screen.findByText(INVITE_SENT_COPY)).toBeInTheDocument();
    }
  });

  it('changes a role and removes a person', async () => {
    const calls: string[] = [];

    server.use(
      http.put(`${BASE}/grants/${GUEST}`, async ({ request }) => {
        calls.push(`put ${JSON.stringify(await request.json())}`);

        return HttpResponse.json({ role: 'viewer', status: 'project-granted' });
      }),
      http.delete(`${BASE}/grants/${GUEST}`, () => {
        calls.push('delete');

        return HttpResponse.json({ status: 'project-grant-revoked' });
      }),
    );

    renderPanel();

    const row = (await screen.findByText('guest@example.com')).closest('li')!;

    await userEvent.selectOptions(
      within(row).getByLabelText('Role for guest@example.com'),
      'viewer',
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Remove guest@example.com' }));

    await waitFor(() => {
      expect(calls).toEqual(['put {"role":"viewer"}', 'delete']);
    });
  });

  it('shows the last-owner sentence on 409', async () => {
    server.use(
      http.delete(`${BASE}/grants/${OWNER}`, () =>
        problemResponse('conflict', 409, { reason: 'last-owner' }),
      ),
    );

    renderPanel();

    const row = (await screen.findByText('owner@example.com')).closest('li')!;

    await userEvent.click(within(row).getByRole('button', { name: 'Remove owner@example.com' }));

    expect(
      await screen.findByText(
        'A project needs at least one owner. Make someone else an owner first.',
      ),
    ).toBeInTheDocument();
  });
});

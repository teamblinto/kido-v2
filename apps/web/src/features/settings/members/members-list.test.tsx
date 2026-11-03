import type { OrgMemberListResponse, OrgRoleName } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { MembersList } from './members-list';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OWNER = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';
const BASE = `${API}/orgs/${ORG}/members`;

let list: OrgMemberListResponse;

function renderList(role: OrgRoleName = 'owner'): void {
  renderScreen(<MembersList orgId={ORG} role={role} />);
}

async function rowFor(email: string): Promise<HTMLElement> {
  return (await screen.findByText(email)).closest('li')!;
}

beforeEach(() => {
  list = {
    members: [
      {
        acceptedAt: '2026-08-16T10:00:00.000Z',
        email: 'owner@example.com',
        invitedAt: '2026-08-16T10:00:00.000Z',
        role: 'owner',
        userId: OWNER,
      },
      {
        acceptedAt: '2026-08-16T10:00:00.000Z',
        email: 'member@example.com',
        invitedAt: '2026-08-16T10:00:00.000Z',
        role: 'member',
        userId: MEMBER,
      },
    ],
  };
  server.use(http.get(BASE, () => HttpResponse.json(list)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MembersList', () => {
  it('changes a member’s role with a body the contract accepts', async () => {
    let body: unknown = null;

    server.use(
      http.patch(`${BASE}/${MEMBER}`, async ({ request }) => {
        body = await request.json();
        list.members[1] = { ...list.members[1]!, role: 'admin' };

        return HttpResponse.json({ role: 'admin', status: 'member-role-changed' });
      }),
    );

    renderList();
    const row = await rowFor('member@example.com');
    await userEvent.selectOptions(
      within(row).getByLabelText('Role for member@example.com'),
      'admin',
    );

    await waitFor(() => {
      expect(body).toEqual({ role: 'admin' });
    });
    await waitFor(() => {
      expect(within(row).getByLabelText('Role for member@example.com')).toHaveValue('admin');
    });
  });

  it('removes a member only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    server.use(
      http.delete(`${BASE}/${MEMBER}`, () => {
        list.members.pop();

        return HttpResponse.json({ status: 'member-removed' });
      }),
    );

    renderList();
    const row = await rowFor('member@example.com');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove member@example.com' }));

    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByText('member@example.com')).not.toBeInTheDocument();
    });
  });

  it('sends nothing when the removal is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const removed = vi.fn();

    server.use(http.delete(`${BASE}/${MEMBER}`, removed));

    renderList();
    const row = await rowFor('member@example.com');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove member@example.com' }));

    expect(removed).not.toHaveBeenCalled();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
  });

  it('shows the server’s sentence when the last owner would be lost', async () => {
    const detail = 'This is the organisation’s last owner. Appoint another owner first.';

    server.use(http.patch(`${BASE}/${OWNER}`, () => problemResponse('conflict', 409, { detail })));

    renderList();
    const row = await rowFor('owner@example.com');
    await userEvent.selectOptions(
      within(row).getByLabelText('Role for owner@example.com'),
      'admin',
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
  });

  it('gives an admin no control over an owner and no owner role to hand out', async () => {
    renderList('admin');

    const owner = await rowFor('owner@example.com');
    expect(within(owner).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(owner).queryByRole('button')).not.toBeInTheDocument();

    const member = within(await rowFor('member@example.com'));
    const options = within(member.getByLabelText('Role for member@example.com'))
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(options).not.toContain('owner');
  });

  it('gives a plain member a read-only list', async () => {
    renderList('member');

    await screen.findByText('member@example.com');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

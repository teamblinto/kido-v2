import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { PERSONAL_ACCOUNTS_LABEL, PersonalAccountsPolicySwitch } from './personal-accounts-policy';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const POLICY = `${API}/orgs/${ORG_ID}/settings/personal-accounts`;

describe('PersonalAccountsPolicySwitch', () => {
  it('shows the current value and lets an owner turn it off', async () => {
    let body: unknown;

    server.use(
      http.get(POLICY, () => HttpResponse.json({ allowed: true })),
      http.put(POLICY, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ allowed: false });
      }),
    );

    renderScreen(<PersonalAccountsPolicySwitch orgId={ORG_ID} role="owner" />);

    const toggle = screen.getByRole('switch', { name: PERSONAL_ACCOUNTS_LABEL });

    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toBeEnabled();

    await userEvent.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(body).toEqual({ allowed: false });
  });

  it('is editable by an admin', async () => {
    server.use(http.get(POLICY, () => HttpResponse.json({ allowed: false })));

    renderScreen(<PersonalAccountsPolicySwitch orgId={ORG_ID} role="admin" />);

    const toggle = screen.getByRole('switch', { name: PERSONAL_ACCOUNTS_LABEL });

    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
  });

  it('is read-only for a member', async () => {
    server.use(http.get(POLICY, () => HttpResponse.json({ allowed: true })));

    renderScreen(<PersonalAccountsPolicySwitch orgId={ORG_ID} role="member" />);

    const toggle = screen.getByRole('switch', { name: PERSONAL_ACCOUNTS_LABEL });

    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Only an owner or admin can change this.')).toBeInTheDocument();
  });
});

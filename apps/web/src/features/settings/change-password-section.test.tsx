import { PASSWORD_CHANGED } from '@repo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ChangePasswordSection } from './change-password-section';

const NEW_PASSWORD = 'tangerine kettle orbit';

async function fill(current: string, next: string, confirmation: string): Promise<void> {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('Current password'), current);
  await user.type(screen.getByLabelText('New password'), next);
  await user.type(screen.getByLabelText('Confirm new password'), confirmation);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('ChangePasswordSection', () => {
  it('labels the fields with the autocomplete tokens password managers expect', () => {
    renderScreen(<ChangePasswordSection />);

    expect(screen.getByLabelText('Current password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('sends both passwords and says the other devices were signed out', async () => {
    let body: unknown;

    server.use(
      http.post(`${API}/auth/password/change`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ status: PASSWORD_CHANGED });
      }),
    );
    renderScreen(<ChangePasswordSection />);

    await fill('old secret', NEW_PASSWORD, NEW_PASSWORD);

    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(screen.getByText(/signed out on every other device/u)).toBeInTheDocument();
    expect(body).toEqual({ currentPassword: 'old secret', newPassword: NEW_PASSWORD });
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('shows the problem when the current password is wrong', async () => {
    server.use(
      http.post(`${API}/auth/password/change`, () =>
        problemResponse('current-password-incorrect', 403),
      ),
    );
    renderScreen(<ChangePasswordSection />);

    await fill('wrong', NEW_PASSWORD, NEW_PASSWORD);

    expect(await screen.findByText('That password is incorrect.')).toBeInTheDocument();
  });

  it('does not call the API when the confirmation does not match', async () => {
    const handler = vi.fn(() => HttpResponse.json({ status: PASSWORD_CHANGED }));

    server.use(http.post(`${API}/auth/password/change`, handler));
    renderScreen(<ChangePasswordSection />);

    await fill('old secret', NEW_PASSWORD, 'something else entirely');

    expect(await screen.findByText('Both passwords need to match.')).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();
  });
});

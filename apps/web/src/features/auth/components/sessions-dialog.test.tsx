import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { SessionsDialog } from './sessions-dialog';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function aSession(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: iso(86_400_000),
    fingerprint: 'abc123',
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ip: '203.0.113.7',
    lastSeenAt: iso(60_000),
    userAgent: CHROME_WINDOWS,
    ...overrides,
  };
}

describe('SessionsDialog', () => {
  it('lists the devices the account is signed in on', async () => {
    server.use(
      http.get(`${API}/auth/sessions`, () =>
        HttpResponse.json({
          sessions: [
            aSession(),
            aSession({ id: '8f14e45f-ceea-4b73-a5f1-0d1a4e2f9c11', ip: '198.51.100.4' }),
          ],
        }),
      ),
    );

    renderScreen(<SessionsDialog open onOpenChange={() => undefined} />);

    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('203.0.113.7', { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText('198.51.100.4', { exact: false })).toBeInTheDocument();
  });

  it('never renders anything that could be a session token', async () => {
    // `session.ts` is deliberate that the listing carries neither the token nor the hash the store
    // keys a session by. The id it does carry means nothing outside the caller's own list.
    server.use(
      http.get(`${API}/auth/sessions`, () => HttpResponse.json({ sessions: [aSession()] })),
    );

    renderScreen(<SessionsDialog open onOpenChange={() => undefined} />);

    const dialog = await screen.findByRole('dialog');

    await within(dialog).findByText('203.0.113.7', { exact: false });
    expect(dialog).not.toHaveTextContent('abc123');
    expect(dialog).not.toHaveTextContent('3f2504e0');
  });

  it('revokes a device and refreshes the list', async () => {
    const user = userEvent.setup();
    let revoked: string | undefined;

    server.use(
      http.delete(`${API}/auth/sessions/:id`, ({ params }) => {
        revoked = String(params.id);

        return HttpResponse.json({ status: 'session-revoked' });
      }),
      http.get(`${API}/auth/sessions`, () =>
        HttpResponse.json({ sessions: revoked === undefined ? [aSession()] : [] }),
      ),
    );

    renderScreen(<SessionsDialog open onOpenChange={() => undefined} />);

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(revoked).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    });
  });

  it('offers a retry when the listing fails', async () => {
    server.use(http.get(`${API}/auth/sessions`, () => problemResponse('service-unavailable', 503)));

    renderScreen(<SessionsDialog open onOpenChange={() => undefined} />);

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(/temporarily unavailable/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('asks for nothing while it is closed', async () => {
    let called = false;

    server.use(
      http.get(`${API}/auth/sessions`, () => {
        called = true;

        return HttpResponse.json({ sessions: [] });
      }),
    );

    renderScreen(<SessionsDialog open={false} onOpenChange={() => undefined} />);

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(called).toBe(false);
  });
});

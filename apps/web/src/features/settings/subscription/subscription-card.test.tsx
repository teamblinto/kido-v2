import { type SubscriptionStatus, subscriptionListSchema } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { isClaudeSignInUrl } from './subscription-api';
import { SubscriptionCard } from './subscription-card';

const SIGN_IN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';

function status(overrides: Partial<SubscriptionStatus> = {}): SubscriptionStatus {
  return {
    message: null,
    plan: null,
    provider: 'claude',
    signIn: null,
    state: 'disconnected',
    updatedAt: '2026-11-03T10:00:00.000Z',
    ...overrides,
  };
}

function awaiting(): SubscriptionStatus {
  return status({
    signIn: { expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(), url: SIGN_IN_URL },
    state: 'awaiting-sign-in',
  });
}

/** Serves each status in turn, then keeps serving the last. */
function serve(...statuses: SubscriptionStatus[]) {
  const bodies = statuses.map((claude) => subscriptionListSchema.parse({ claude }));
  let i = 0;

  return http.get(`${API}/me/subscriptions`, () =>
    HttpResponse.json(bodies[Math.min(i++, bodies.length - 1)]),
  );
}

function renderCard() {
  return renderScreen(<SubscriptionCard />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SubscriptionCard', () => {
  it.each([
    [status({ state: 'provisioning' }), /Setting up your private workspace/u],
    [status({ state: 'starting' }), /Setting up your private workspace/u],
    [status({ state: 'verifying' }), 'Checking your code with Claude…'],
    [status({ plan: 'Max', state: 'connected' }), 'Connected · Max'],
    [
      status({ message: 'Signed out in Claude Code.', state: 'signed-out' }),
      'Signed out in Claude Code.',
    ],
    [status({ state: 'error' }), 'Something went wrong with your Claude subscription.'],
  ] as const)('says where it is: %#', async (current, text) => {
    server.use(serve(current));
    renderCard();

    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('explains itself and connects, announcing the new state', async () => {
    let connected = false;
    server.use(
      serve(status()),
      http.post(`${API}/me/subscriptions/claude/connect`, () => {
        connected = true;

        return HttpResponse.json(status({ state: 'provisioning' }), { status: 202 });
      }),
    );
    renderCard();

    expect(
      screen.getByText(/BAIOS never sees your Claude password or tokens/u),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Claude subscription' }),
    );

    const live = screen.getByRole('status');
    await waitFor(() => {
      expect(within(live).getByText(/Setting up your private workspace/u)).toHaveFocus();
    });
    expect(connected).toBe(true);
  });

  it.each(['signed-out', 'error'] as const)('offers Reconnect when %s', async (state) => {
    server.use(serve(status({ state })));
    renderCard();

    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('links to the sign-in page in a new tab, with an expiry countdown', async () => {
    server.use(serve(awaiting()));
    renderCard();

    const link = await screen.findByRole('link', { name: 'Sign in with Claude' });
    expect(link).toHaveAttribute('href', SIGN_IN_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/^Expires in \d+:\d\d$/u)).toBeInTheDocument();
  });

  it('sends the code once, clears the field at once, and never stores or addresses it', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    let sent: unknown;
    server.use(
      serve(awaiting(), status({ state: 'verifying' })),
      http.post(`${API}/me/subscriptions/claude/code`, async ({ request }) => {
        sent = await request.json();

        return new HttpResponse(null, { status: 202 });
      }),
    );
    renderCard();

    const field = await screen.findByLabelText('Paste the code Claude shows you');
    await userEvent.type(field, 'one-time-code#123');
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(field).toHaveValue('');
    await waitFor(() => {
      expect(sent).toEqual({ code: 'one-time-code#123' });
    });
    expect(await screen.findByText('Checking your code with Claude…')).toBeInTheDocument();
    expect(setItem.mock.calls.flat().join(' ')).not.toContain('one-time-code');
    expect(window.location.href).not.toContain('one-time-code');
  });

  it('cancels a pending sign-in', async () => {
    let cancelled = false;
    server.use(
      serve(awaiting(), status()),
      http.post(`${API}/me/subscriptions/claude/cancel`, () => {
        cancelled = true;

        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(
      await screen.findByRole('button', { name: 'Connect Claude subscription' }),
    ).toBeInTheDocument();
    expect(cancelled).toBe(true);
  });

  it('disconnects only after confirming', async () => {
    let deleted = false;
    server.use(
      serve(status({ plan: 'Pro', state: 'connected' }), status()),
      http.delete(`${API}/me/subscriptions/claude`, () => {
        deleted = true;

        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(deleted).toBe(false);
    await userEvent.click(dialog.getByRole('button', { name: 'Disconnect' }));

    expect(
      await screen.findByRole('button', { name: 'Connect Claude subscription' }),
    ).toBeInTheDocument();
    expect(deleted).toBe(true);
  });

  it('never links to a sign-in page off Claude', async () => {
    server.use(
      http.get(`${API}/me/subscriptions`, () =>
        HttpResponse.json({
          claude: {
            ...awaiting(),
            signIn: { expiresAt: '2026-11-03T10:10:00.000Z', url: 'https://evil.example/x' },
          },
        }),
      ),
    );
    renderCard();

    expect(
      await screen.findByText('Your Claude subscription could not be loaded.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
  });
});

describe('isClaudeSignInUrl', () => {
  it.each([
    ['https://claude.com/cai/oauth/authorize', true],
    ['https://claude.ai/oauth', true],
    ['http://claude.com/oauth', false],
    ['https://claude.com.evil.example/oauth', false],
    ['https://evil.example/?u=https://claude.com', false],
    ['javascript:alert(1)', false],
  ])('%s → %s', (url, ok) => {
    expect(isClaudeSignInUrl(url)).toBe(ok);
  });
});

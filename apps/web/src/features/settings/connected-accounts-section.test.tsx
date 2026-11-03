import { MFA_STEPPED_UP } from '@repo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ConnectedAccountsSection } from './connected-accounts-section';

const STATE = 'a'.repeat(43);

const anAccount = {
  accountLabel: 'rakibul@blinto.co',
  health: 'healthy',
  lastCheckedAt: '2026-09-23T10:00:00.000Z',
  limitedUntil: null,
  linkedAt: '2026-09-20T10:00:00.000Z',
  provider: 'anthropic',
};

const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  assign.mockReset();
  vi.restoreAllMocks();
});

function listing(body: { accounts: unknown[]; offered: string[] }) {
  return http.get(`${API}/me/linked-accounts`, () => HttpResponse.json(body));
}

async function card(name: string) {
  return within((await screen.findByRole('heading', { name })).closest('section')!);
}

/** Spec 032 T030. */
describe('ConnectedAccountsSection', () => {
  it('offers nothing linkable when the organisation offers no provider', async () => {
    server.use(listing({ accounts: [], offered: [] }));

    renderScreen(<ConnectedAccountsSection />);

    expect(
      await screen.findByText(/uses its own API key for Claude and OpenAI/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows only offered providers, with the linked account and a limit', async () => {
    server.use(
      listing({
        accounts: [{ ...anAccount, limitedUntil: '2026-09-24T18:00:00.000Z' }],
        offered: ['anthropic'],
      }),
    );

    renderScreen(<ConnectedAccountsSection />);

    const claude = await card('Claude');
    expect(claude.getByText('rakibul@blinto.co')).toBeInTheDocument();
    expect(claude.getByText('Healthy')).toBeInTheDocument();
    expect(claude.getByText(/Limited until/u)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'OpenAI' })).not.toBeInTheDocument();
  });

  it('connect steps up, retries begin once, then follows the redirect', async () => {
    let steppedUp = false;
    let begins = 0;

    server.use(
      listing({ accounts: [], offered: ['anthropic'] }),
      http.post(`${API}/me/linked-accounts/anthropic/begin`, () => {
        begins += 1;
        if (!steppedUp) return problemResponse('step-up-required', 403);

        return HttpResponse.json({ kind: 'redirect', url: 'https://claude.example/oauth' });
      }),
      http.post(`${API}/auth/mfa/step-up`, () => {
        steppedUp = true;

        return HttpResponse.json({ status: MFA_STEPPED_UP });
      }),
    );

    renderScreen(<ConnectedAccountsSection />);

    await userEvent.click((await card('Claude')).getByRole('button', { name: 'Connect' }));

    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('Authenticator code'), '123456');
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm' }));

    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://claude.example/oauth');
    });
    expect(begins).toBe(2);
  });

  it('shows the device code and completes when confirmed', async () => {
    let linked = false;
    const bodies: unknown[] = [];

    server.use(
      http.get(`${API}/me/linked-accounts`, () =>
        HttpResponse.json({
          accounts: linked ? [{ ...anAccount, provider: 'openai' }] : [],
          offered: ['openai'],
        }),
      ),
      http.post(`${API}/me/linked-accounts/openai/begin`, () =>
        HttpResponse.json({
          expiresAt: '2026-09-24T10:15:00.000Z',
          kind: 'device',
          state: STATE,
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://auth.openai.example/device',
        }),
      ),
      http.post(`${API}/me/linked-accounts/openai/complete`, async ({ request }) => {
        bodies.push(await request.json());
        if (bodies.length === 1) {
          return HttpResponse.json({ pending: true, retryAfterSeconds: 5 }, { status: 202 });
        }
        linked = true;

        return HttpResponse.json({ ...anAccount, provider: 'openai' });
      }),
    );

    renderScreen(<ConnectedAccountsSection />);

    const openai = await card('OpenAI');
    await userEvent.click(openai.getByRole('button', { name: 'Connect' }));
    expect(await openai.findByText('ABCD-EFGH')).toBeInTheDocument();

    await userEvent.click(openai.getByRole('button', { name: 'I have entered the code' }));
    expect(await openai.findByText(/has not confirmed yet/u)).toBeInTheDocument();

    await userEvent.click(openai.getByRole('button', { name: 'I have entered the code' }));
    expect(await openai.findByText('rakibul@blinto.co')).toBeInTheDocument();
    expect(openai.queryByText('ABCD-EFGH')).not.toBeInTheDocument();
    expect(bodies).toEqual([{ state: STATE }, { state: STATE }]);
  });

  it('disconnects after confirmation', async () => {
    let linked = true;

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    server.use(
      http.get(`${API}/me/linked-accounts`, () =>
        HttpResponse.json({ accounts: linked ? [anAccount] : [], offered: ['anthropic'] }),
      ),
      http.delete(`${API}/me/linked-accounts/anthropic`, () => {
        linked = false;

        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderScreen(<ConnectedAccountsSection />);

    const claude = await card('Claude');
    await userEvent.click(claude.getByRole('button', { name: 'Disconnect' }));

    expect(await claude.findByText('Not connected.')).toBeInTheDocument();
  });

  it('renders a refusal reason as its sentence', async () => {
    server.use(
      listing({ accounts: [{ ...anAccount, health: 'needs_reauth' }], offered: ['anthropic'] }),
      http.post(`${API}/me/linked-accounts/anthropic/verify`, () =>
        problemResponse('service-unavailable', 503, { reason: 'provider-unavailable' }),
      ),
    );

    renderScreen(<ConnectedAccountsSection />);

    const claude = await card('Claude');
    expect(claude.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    await userEvent.click(claude.getByRole('button', { name: 'Check now' }));

    expect(await claude.findByRole('alert')).toHaveTextContent(
      'Claude could not be reached. Try again shortly.',
    );
  });
});

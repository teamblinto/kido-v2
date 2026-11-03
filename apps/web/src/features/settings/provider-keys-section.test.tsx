import type { ProviderKey } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ProviderKeysSection } from './provider-keys-section';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const KEYS = `${API}/orgs/${ORG_ID}/provider-keys`;

const anthropicKey: ProviderKey = {
  addedAt: '2026-09-20T10:00:00.000Z',
  addedBy: { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', name: 'Rakibul' },
  fingerprint: 'a1b2c3d4',
  health: 'healthy',
  id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastFour: 'wxyz',
  lastVerifiedAt: '2026-09-20T10:00:00.000Z',
  provider: 'anthropic',
};

const A_KEY = 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz';

function listing(keys: () => ProviderKey[]) {
  return http.get(KEYS, () => HttpResponse.json({ keys: keys() }));
}

function anthropicCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Anthropic' });
}

async function pasteKey(card: HTMLElement, value: string): Promise<void> {
  await userEvent.type(within(card).getByLabelText('API key'), value);
  await userEvent.click(within(card).getByRole('button', { name: /^(Add|Replace) key$/ }));
}

describe('ProviderKeysSection', () => {
  it('renders one empty card per provider with an add form', async () => {
    server.use(listing(() => []));

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    expect(await screen.findByRole('region', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.getAllByText('No key stored.')).toHaveLength(2);

    const input = within(anthropicCard()).getByLabelText('API key');

    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAccessibleDescription(/sk-ant-/);
    expect(within(anthropicCard()).getByRole('button', { name: 'Add key' })).toBeDisabled();
  });

  it('stores a key and shows its last four — never the key', async () => {
    const keys: ProviderKey[] = [];
    let body: unknown;

    server.use(
      listing(() => keys),
      http.put(`${KEYS}/anthropic`, async ({ request }) => {
        body = await request.json();
        keys.push(anthropicKey);

        return HttpResponse.json(anthropicKey);
      }),
    );

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="admin" />);

    await screen.findByRole('region', { name: 'Anthropic' });
    await pasteKey(anthropicCard(), A_KEY);

    expect(await screen.findByText('••••wxyz')).toBeInTheDocument();
    expect(body).toEqual({ apiKey: A_KEY });
    expect(screen.getByText('a1b2c3d4')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText(/Rakibul/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(A_KEY);
  });

  it.each([
    ['wrong-shape', 422, 'validation-failed', 'That does not look like an Anthropic key.'],
    ['key-rejected', 422, 'validation-failed', 'The provider rejected this key.'],
    [
      'could-not-verify',
      503,
      'service-unavailable',
      'The provider could not be reached. Try again shortly.',
    ],
  ])('shows the %s sentence', async (reason, status, slug, sentence) => {
    server.use(
      listing(() => []),
      http.put(`${KEYS}/anthropic`, () => problemResponse(slug, status, { reason })),
    );

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    await screen.findByRole('region', { name: 'Anthropic' });
    await pasteKey(anthropicCard(), A_KEY);

    const alert = await within(anthropicCard()).findByRole('alert');

    expect(alert).toHaveTextContent(sentence);
    // Announced without moving focus, and the input is marked so a screen reader lands on the
    // problem when the person tabs back to it.
    expect(alert.parentElement).toHaveAttribute('aria-live', 'assertive');
    expect(within(anthropicCard()).getByLabelText('API key')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('submits from the keyboard with Enter in the input', async () => {
    let called = false;

    server.use(
      listing(() => []),
      http.put(`${KEYS}/anthropic`, () => {
        called = true;

        return HttpResponse.json(anthropicKey);
      }),
    );

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    await screen.findByRole('region', { name: 'Anthropic' });
    await userEvent.type(within(anthropicCard()).getByLabelText('API key'), `${A_KEY}{Enter}`);

    await waitFor(() => {
      expect(called).toBe(true);
    });
  });

  it('hides every control from a member', async () => {
    server.use(listing(() => [anthropicKey]));

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="member" />);

    expect(await screen.findByText('••••wxyz')).toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('replaces a stored key through the same form', async () => {
    const replaced = { ...anthropicKey, fingerprint: 'e5f6a7b8', lastFour: '9999' };
    let current = anthropicKey;

    server.use(
      listing(() => [current]),
      http.put(`${KEYS}/anthropic`, () => {
        current = replaced;

        return HttpResponse.json(replaced);
      }),
    );

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    expect(await screen.findByText('••••wxyz')).toBeInTheDocument();
    await pasteKey(anthropicCard(), A_KEY);

    expect(await screen.findByText('••••9999')).toBeInTheDocument();
    expect(screen.queryByText('••••wxyz')).not.toBeInTheDocument();
  });

  it('removes a key after a confirm and shows the empty state', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let removed = false;

    server.use(
      listing(() => (removed ? [] : [anthropicKey])),
      http.delete(`${KEYS}/anthropic`, () => {
        removed = true;

        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    await screen.findByText('••••wxyz');
    await userEvent.click(within(anthropicCard()).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(within(anthropicCard()).getByText('No key stored.')).toBeInTheDocument();
    });
    expect(confirm.mock.calls[0]?.[0]).toContain('Anthropic');
    confirm.mockRestore();
  });

  it('keeps the key when the confirm is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    server.use(listing(() => [anthropicKey]));

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    await screen.findByText('••••wxyz');
    await userEvent.click(within(anthropicCard()).getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('••••wxyz')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('shows the needs_reauth chip telling the admin to replace or remove the key', async () => {
    server.use(listing(() => [{ ...anthropicKey, health: 'needs_reauth' }]));

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    expect(await screen.findByText('Needs a new key')).toBeInTheDocument();
    expect(screen.getByText(/replace or remove this key/)).toBeInTheDocument();
  });

  it('verifies a key with a spinner and refreshes the card', async () => {
    let verified = false;

    server.use(
      listing(() => [{ ...anthropicKey, health: verified ? 'healthy' : 'needs_reauth' }]),
      http.post(`${KEYS}/anthropic/verify`, () => {
        verified = true;

        return HttpResponse.json(anthropicKey);
      }),
    );

    renderScreen(<ProviderKeysSection orgId={ORG_ID} role="owner" />);

    expect(await screen.findByText('Needs a new key')).toBeInTheDocument();
    await userEvent.click(within(anthropicCard()).getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('Healthy')).toBeInTheDocument();
    expect(screen.queryByText('Needs a new key')).not.toBeInTheDocument();
  });
});

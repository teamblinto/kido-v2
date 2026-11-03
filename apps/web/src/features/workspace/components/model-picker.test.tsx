import type { SubscriptionStatus } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server, subscriptionHandler } from '@/test/server';
import { useModelChoice } from '../hooks/use-model-choice';
import { ModelPicker } from './model-picker';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const MODELS: NonNullable<SubscriptionStatus['models']> = [
  { description: 'Most capable', id: 'opus', label: 'Opus' },
  { description: 'Everyday work', id: 'sonnet', label: 'Sonnet' },
];

function Harness(): React.JSX.Element {
  const state = useModelChoice({ orgId: ORG, projectId: 'picker-test' });

  return (
    <>
      <ModelPicker state={state} />
      <output aria-label="Choice">{JSON.stringify(state.choice ?? null)}</output>
    </>
  );
}

function renderPicker(): void {
  window.localStorage.removeItem('baios.model.picker-test');
  renderScreen(<Harness />, { routes: { '/settings/account': <h1>Account settings</h1> } });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: /change model/i }));

  return screen.findByRole('listbox', { name: 'Models' });
}

describe('ModelPicker (spec 043)', () => {
  it("lists the subscription's own models and the API keys, and picks one", async () => {
    const user = userEvent.setup();
    server.use(subscriptionHandler({ models: MODELS, state: 'connected' }));
    renderPicker();

    const list = await openPicker(user);
    const plan = within(list).getByRole('group', { name: 'Claude subscription' });
    const keys = within(list).getByRole('group', { name: 'API keys' });

    expect(
      within(plan)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([expect.stringContaining('Opus'), expect.stringContaining('Sonnet')]);
    expect(within(keys).getByRole('option', { name: 'Claude Sonnet 5' })).toBeVisible();

    await user.click(within(plan).getByRole('option', { name: 'Sonnet' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Choice')).toHaveTextContent(
      JSON.stringify({ model: 'sonnet', source: 'subscription' }),
    );
    expect(screen.getByRole('button', { name: /change model/i })).toHaveTextContent('Sonnet');
  });

  it('shows a skeleton while the subscription is checked, and never blocks the choice', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API}/me/subscriptions`, async () => {
        await delay('infinite');

        return HttpResponse.json({});
      }),
    );
    renderPicker();

    // The catalogue answered: there is already something to send on.
    await waitFor(() => {
      expect(screen.getByLabelText('Choice')).toHaveTextContent('claude-sonnet-5');
    });
    const list = await openPicker(user);

    expect(within(list).getByText('Checking your Claude subscription')).toBeInTheDocument();
  });

  it('says models appear once the subscription checks in, and asks again on Retry', async () => {
    const user = userEvent.setup();
    let reads = 0;
    server.use(
      http.get(`${API}/me/subscriptions`, () => {
        reads += 1;

        return HttpResponse.json({
          claude: {
            message: null,
            models: null,
            plan: 'Max',
            provider: 'claude',
            signIn: null,
            state: 'connected',
            updatedAt: '2026-11-03T10:00:00.000Z',
            usage: null,
          },
        });
      }),
    );
    renderPicker();

    const list = await openPicker(user);

    expect(
      within(list).getByText('Models appear once your subscription has checked in.'),
    ).toBeVisible();
    const before = reads;
    await user.click(within(list).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(reads).toBe(before + 1);
    });
  });

  it('says when the subscription could not be checked, with a retry', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${API}/me/subscriptions`, () => problemResponse('internal', 500)));
    renderPicker();

    const list = await openPicker(user);

    expect(
      await within(list).findByText('Your Claude subscription could not be checked.'),
    ).toBeVisible();
    expect(within(list).getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('offers to connect a subscription that is not connected, and goes there on Enter', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API}/orgs/:orgId/models`, () => HttpResponse.json({ default: null, models: [] })),
    );
    renderPicker();

    const list = await openPicker(user);

    expect(within(list).queryByRole('group', { name: 'API keys' })).not.toBeInTheDocument();
    expect(
      await within(list).findByRole('option', { name: 'Connect your Claude subscription' }),
    ).toBeVisible();

    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: 'Account settings' })).toBeVisible();
  });

  it('filters by the search, best match first, and picks with the keyboard', async () => {
    const user = userEvent.setup();
    server.use(subscriptionHandler({ models: MODELS, state: 'connected' }));
    renderPicker();

    await openPicker(user);
    const search = screen.getByRole('combobox', { name: 'Search models' });

    expect(search).toHaveFocus();
    await user.type(search, 'haiku');

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Claude Haiku 4.5');
    expect(search).toHaveAttribute('aria-activedescendant', options[0]?.id);

    await user.keyboard('{Enter}');

    expect(screen.getByLabelText('Choice')).toHaveTextContent(
      JSON.stringify({ model: 'claude-haiku-4-5', source: 'catalogue' }),
    );
  });

  it('moves through the options with the arrow keys and closes on Escape', async () => {
    const user = userEvent.setup();
    server.use(subscriptionHandler({ models: MODELS, state: 'connected' }));
    renderPicker();

    await openPicker(user);
    const search = screen.getByRole('combobox', { name: 'Search models' });
    // The current choice (the plan's first model) leads.
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Opus' }).id,
    );

    await user.keyboard('{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Sonnet' }).id,
    );

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on Mod+Shift+M from anywhere', async () => {
    const user = userEvent.setup();
    renderPicker();

    await screen.findByRole('button', { name: /change model/i });
    await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');

    expect(await screen.findByRole('combobox', { name: 'Search models' })).toHaveFocus();
  });
});

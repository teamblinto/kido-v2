import {
  type SubscriptionStatus,
  createRunRequestSchema,
  subscriptionListSchema,
} from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ChatComposer } from './chat-composer';

const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const KEY = `baios.pay-with.${PROJECT}`;

function renderComposer(state: SubscriptionStatus['state']) {
  const body = subscriptionListSchema.parse({
    claude: {
      message: null,
      plan: state === 'connected' ? 'Max' : null,
      provider: 'claude',
      signIn: null,
      state,
      updatedAt: '2026-11-03T10:00:00.000Z',
    },
  });
  const onSubmit = vi.fn();
  server.use(http.get(`${API}/me/subscriptions`, () => HttpResponse.json(body)));
  renderScreen(
    <ChatComposer
      isRunning={false}
      isStopping={false}
      onStop={vi.fn()}
      onSubmit={onSubmit}
      placeholder="Ask"
      projectId={PROJECT}
    />,
  );

  return onSubmit;
}

async function chooseSubscription(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('option', { name: 'My Claude subscription' })).toBeEnabled();
  });
  await userEvent.selectOptions(screen.getByLabelText('Pay with'), 'My Claude subscription');
}

afterEach(() => {
  window.localStorage.clear();
});

describe('Pay with', () => {
  it('defaults to BAIOS and sends only the prompt', async () => {
    const onSubmit = renderComposer('connected');

    expect(screen.getByLabelText('Pay with')).toHaveValue('baios');
    await userEvent.type(screen.getByRole('textbox', { name: /Ask BAIOS/u }), 'go{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('go');
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('offers the plan only once it is connected, and says where to connect it', async () => {
    renderComposer('disconnected');

    expect(
      await screen.findByRole('option', { name: 'My Claude subscription (not connected)' }),
    ).toBeDisabled();
    expect(
      await screen.findByText(/Connect your Claude subscription in Settings/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings/account#claude-subscription',
    );
  });

  it('sends the subscription and the chosen model, never a local agent, and remembers it', async () => {
    const onSubmit = renderComposer('connected');

    await chooseSubscription();
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'Opus');
    await userEvent.type(screen.getByRole('textbox', { name: /Ask BAIOS/u }), 'fix it{Enter}');

    const target = { model: 'opus', subscription: { provider: 'claude' } };
    expect(onSubmit).toHaveBeenCalledWith('fix it', target);
    expect(onSubmit.mock.calls[0]?.[1]).not.toHaveProperty('localAgent');
    expect(() => createRunRequestSchema.parse({ prompt: 'fix it', ...target })).not.toThrow();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '')).toEqual({
      model: 'opus',
      payWith: 'subscription',
    });
  });

  it('leaves the model out for Default', async () => {
    const onSubmit = renderComposer('connected');

    await chooseSubscription();
    expect(screen.getByLabelText('Model')).toHaveValue('');
    await userEvent.type(screen.getByRole('textbox', { name: /Ask BAIOS/u }), 'go{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('go', { subscription: { provider: 'claude' } });
  });

  it('blocks a remembered plan that is no longer connected', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ model: null, payWith: 'subscription' }));
    const onSubmit = renderComposer('signed-out');

    expect(
      await screen.findByText(/Connect your Claude subscription in Settings/u),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: /Ask BAIOS/u }), 'go{Enter}');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

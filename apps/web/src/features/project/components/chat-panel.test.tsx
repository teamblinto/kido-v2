import type { RunEvent } from '@repo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { stateReason } from '@/features/settings/subscription-limit';
import { ChatPanel } from './chat-panel';

const RUN = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const RESETS_AT = '2026-09-24T09:22:00.000Z';
const REASON = `Your Anthropic account (ada@example.com) is rate-limited until ${RESETS_AT}`;

function failedState(resetsAt?: string): RunEvent {
  return {
    at: '2026-09-24T08:00:00.000Z',
    data: {
      from: 'running',
      reason: REASON,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      to: 'failed',
    },
    run: RUN,
    seq: 9,
    type: 'state',
  };
}

function renderPanel(event: RunEvent) {
  renderScreen(
    <ChatPanel
      connection="closed"
      isRunning={false}
      isStopping={false}
      items={[{ event, id: 'state-9' }]}
      onRetry={vi.fn()}
      onStop={vi.fn()}
      onSubmit={vi.fn()}
      placeholder="Ask for a change to this project"
      run={undefined}
      source="history"
    />,
  );
}

/** Spec 032 T047: a subscription limit's reset, shown in the viewer's own time zone. */
describe('ChatPanel — a limited subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T08:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('renders the reset in UTC for a viewer in UTC', () => {
    vi.stubEnv('TZ', 'UTC');
    renderPanel(failedState(RESETS_AT));

    const line = screen.getByText(/is rate-limited until/);
    expect(line.textContent).toMatch(/until 09:22/);
    expect(line.textContent).not.toContain(RESETS_AT);
  });

  it('renders the same reset in Tokyo time for a viewer in Asia/Tokyo', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    renderPanel(failedState(RESETS_AT));

    const line = screen.getByText(/is rate-limited until/);
    expect(line.textContent).toMatch(/until 06:22\s?PM/);
    expect(line.textContent).not.toContain(RESETS_AT);
  });

  it('adds the date when the reset is not today', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(
      stateReason({ reason: REASON.replace(RESETS_AT, 'x'), resetsAt: '2026-09-25T09:22:00.000Z' }),
    ).toMatch(/\(until Sep 25, 09:22/);
  });

  it('leaves a reason with no reset as the run wrote it', () => {
    renderPanel(failedState());

    expect(screen.getByText(REASON)).toBeInTheDocument();
  });
});

describe('ChatPanel — a refusal with an action (spec 032 T048)', () => {
  it('shows the button beside the refusal and calls it', async () => {
    const onClick = vi.fn();
    renderScreen(
      <ChatPanel
        connection="idle"
        isRunning={false}
        isStopping={false}
        items={[]}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onSubmit={vi.fn()}
        placeholder="Ask for a change to this project"
        refusal="Your Claude subscription is limited until 09:22"
        refusalAction={{ label: "Run on the organisation's credential this time", onClick }}
        run={undefined}
        source="live"
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('limited until 09:22');
    await userEvent
      .setup()
      .click(
        screen.getByRole('button', { name: "Run on the organisation's credential this time" }),
      );
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

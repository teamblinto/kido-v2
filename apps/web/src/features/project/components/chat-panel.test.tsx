import type { RunEvent, RunResponse } from '@repo/contracts';
import { screen, within } from '@testing-library/react';
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
      items={[{ event, id: 'state-9' }]}
      onRetry={vi.fn()}
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

describe('ChatPanel — the conversation (spec 043)', () => {
  const at = '2026-09-24T08:00:00.000Z';
  const aRun: RunResponse = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelRequestedAt: null,
    contextSkips: [],
    createdAt: '2026-09-24T08:00:00.000Z',
    endedAt: '2026-09-24T08:01:20.000Z',
    failureClass: null,
    id: RUN,
    inputTokens: 0,
    lastSeq: 9,
    model: 'claude-sonnet-5',
    outputTokens: 0,
    projectId: '8f14e45f-ceea-4b73-a5f1-0d1a4e2f9c11',
    promptExcerpt: 'ship it',
    startedAt: '2026-09-24T08:00:00.000Z',
    status: 'failed',
    userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  };

  function token(text: string, n: number) {
    return {
      event: { at, data: { text }, run: RUN, seq: 1, type: 'token' } as RunEvent,
      id: `t-${String(n)}`,
    };
  }

  function tool(stepId: string, name: string, seq: number, ok?: boolean) {
    return [
      {
        event: {
          at,
          data: { input: {}, stepId, tool: name },
          run: RUN,
          seq,
          type: 'tool.start',
        } as RunEvent,
        id: `d-${String(seq)}`,
      },
      ...(ok === undefined
        ? []
        : [
            {
              event: {
                at,
                data: { ok, stepId, ...(ok ? {} : { error: 'exit 1' }) },
                run: RUN,
                seq: seq + 1,
                type: 'tool.end',
              } as RunEvent,
              id: `d-${String(seq + 1)}`,
            },
          ]),
    ];
  }

  it('renders streamed tokens as one Markdown message, without raw HTML', () => {
    renderScreen(
      <ChatPanel
        connection="closed"
        isRunning={false}
        items={[
          token('Here is the **plan**:\n\n', 1),
          token('- add a table\n- add a ', 2),
          token('button\n\n<script>alert(1)</script>\n\n```ts\nconst rows = [];\n```\n', 3),
        ]}
        onRetry={vi.fn()}
        run={undefined}
        source="history"
      />,
    );

    const log = screen.getByRole('log', { name: 'Conversation' });

    expect(within(log).getByText('plan').tagName).toBe('STRONG');
    expect(
      within(log)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['add a table', 'add a button']);
    expect(log.querySelector('script')).toBeNull();
    // Fenced code is coloured by the file view's own highlight.js grammars.
    expect(log.querySelector('pre code .hljs-keyword')).toHaveTextContent('const');
    // Streamed text is not a live region; the end of a reply is announced on its own.
    expect(log).toHaveAttribute('aria-live', 'off');
  });

  it('groups consecutive tool calls under a summary that marks a failure and expands', async () => {
    const user = userEvent.setup();
    renderScreen(
      <ChatPanel
        connection="closed"
        isRunning={false}
        items={[...tool('s1', 'run pnpm test', 1, false), ...tool('s2', 'run pnpm lint', 3, true)]}
        onRetry={vi.fn()}
        run={undefined}
        source="history"
      />,
    );

    const summary = screen.getByRole('button', { name: /Ran 2 commands/ });

    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(summary).toHaveTextContent('1 failed');
    expect(screen.queryByText('run pnpm test')).not.toBeInTheDocument();

    await user.click(summary);

    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('run pnpm test')).toBeVisible();
    expect(screen.getByText('exit 1')).toBeVisible();
  });

  it("names a subscription run with no model chosen as the CLI's default, not its provider", () => {
    renderScreen(
      <ChatPanel
        connection="closed"
        isRunning={false}
        items={[]}
        onRetry={vi.fn()}
        run={{ ...aRun, model: 'claude' }}
        source="live"
      />,
    );

    expect(screen.getByText('Worked for 1m 20s · Default model')).toBeVisible();
  });

  it('says how long a finished run worked and offers to retry a failed one', async () => {
    const user = userEvent.setup();
    const onRetryRun = vi.fn();
    renderScreen(
      <ChatPanel
        connection="closed"
        isRunning={false}
        items={[]}
        onRetry={vi.fn()}
        onRetryRun={onRetryRun}
        run={aRun}
        source="live"
      />,
    );

    expect(screen.getByText('Worked for 1m 20s · claude-sonnet-5')).toBeVisible();
    expect(screen.getByText('The reply is complete.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryRun).toHaveBeenCalledTimes(1);
  });
});

describe('ChatPanel — a refusal with an action (spec 032 T048)', () => {
  it('shows the button beside the refusal and calls it', async () => {
    const onClick = vi.fn();
    renderScreen(
      <ChatPanel
        connection="idle"
        isRunning={false}
        items={[]}
        onRetry={vi.fn()}
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

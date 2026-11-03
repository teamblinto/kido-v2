import { type RunEvent, type RunResponse, runEventSchema } from '@repo/contracts';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ChatPanel } from './chat-panel';

const ORG = '6ba7b814-9dad-11d1-80b4-00c04fd430c8';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RUN = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const DECIDE = `${API}/orgs/${ORG}/projects/${PROJECT}/runs/${RUN}/approvals/req-1`;

const request = runEventSchema.parse({
  at: '2026-11-02T10:00:00.000Z',
  data: {
    detail: 'pnpm install\n&& pnpm test',
    kind: 'command',
    requestId: 'req-1',
    title: 'Run pnpm install',
  },
  run: RUN,
  seq: 3,
  type: 'approval.request',
});

function resolved(
  by: 'run-ended' | 'timeout' | 'user',
  decision: 'allow' | 'deny',
  seq = 4,
): RunEvent {
  return runEventSchema.parse({
    at: '2026-11-02T10:01:00.000Z',
    data: { by, decision, requestId: 'req-1' },
    run: RUN,
    seq,
    type: 'approval.resolved',
  });
}

const stream: { push: (event: RunEvent) => void } = { push: () => undefined };

/** The panel as the project page mounts it, with a way to deliver the run's next event. */
function Harness({
  initial,
  run,
}: {
  readonly initial: RunEvent[];
  readonly run?: RunResponse;
}): React.JSX.Element {
  const [events, setEvents] = useState(initial);
  useEffect(() => {
    stream.push = (event) => {
      setEvents((current) => [...current, event]);
    };
  }, []);

  return (
    <ChatPanel
      connection="closed"
      isRunning={false}
      isStopping={false}
      items={events.map((event) => ({ event, id: String(event.seq) }))}
      onRetry={vi.fn()}
      onStop={vi.fn()}
      onSubmit={vi.fn()}
      orgId={ORG}
      placeholder="Ask"
      projectId={PROJECT}
      run={run}
      source="live"
    />
  );
}

async function card() {
  return within(
    (await screen.findByRole('heading', { name: 'Run pnpm install' })).closest('section')!,
  );
}

describe('ApprovalCard', () => {
  it('shows the request and posts Allow, then settles when the run resolves it', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(DECIDE, async ({ request: sent }) => {
        bodies.push(await sent.json());

        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderScreen(<Harness initial={[request]} />);

    const approval = await card();
    expect(approval.getByLabelText('Details')).toHaveTextContent('pnpm install && pnpm test');
    await userEvent.click(approval.getByRole('button', { name: 'Allow' }));

    expect(await approval.findByText(/Allowing… waiting for the agent/u)).toBeInTheDocument();
    expect(approval.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(bodies).toEqual([{ decision: 'allow' }]);

    act(() => {
      stream.push(resolved('user', 'allow'));
    });
    expect(await approval.findByText('Allowed by you.')).toBeInTheDocument();
  });

  it('posts Deny, and offers the buttons again when the answer is refused', async () => {
    server.use(http.post(DECIDE, () => problemResponse('conflict', 409)));
    renderScreen(<Harness initial={[request]} />);

    const approval = await card();
    await userEvent.click(approval.getByRole('button', { name: 'Deny' }));

    expect(await approval.findByRole('alert')).toBeInTheDocument();
    expect(approval.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it.each([
    ['timeout', 'No answer in time, so it was denied.'],
    ['run-ended', 'The run ended before it was answered.'],
  ] as const)('shows a request resolved by %s, with no buttons', async (by, text) => {
    renderScreen(<Harness initial={[request, resolved(by, 'deny')]} />);

    const approval = await card();
    expect(approval.getByText(text)).toBeInTheDocument();
    expect(approval.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ApprovalCard — a request resolved twice', () => {
  /** A worker hand-over may resolve the same request again; it is still one settled card. */
  it('shows one card, settled by the latest resolution, with no buttons', async () => {
    renderScreen(
      <Harness initial={[request, resolved('user', 'allow'), resolved('user', 'allow', 5)]} />,
    );

    const approval = await card();
    expect(approval.getByText('Allowed by you.')).toBeInTheDocument();
    expect(approval.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Run pnpm install' })).toHaveLength(1);
  });
});

describe('RunStateCard — a local agent failure', () => {
  const failedRun: RunResponse = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelRequestedAt: null,
    contextSkips: [],
    createdAt: '2026-11-02T10:00:00.000Z',
    endedAt: '2026-11-02T10:00:05.000Z',
    failureClass: 'executor',
    id: RUN,
    inputTokens: 0,
    lastSeq: 5,
    model: 'sonnet',
    outputTokens: 0,
    projectId: PROJECT,
    promptExcerpt: 'go',
    startedAt: '2026-11-02T10:00:00.000Z',
    status: 'failed',
    userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  };

  function failedWith(data: Record<string, unknown>): RunEvent {
    return runEventSchema.parse({
      at: '2026-11-02T10:00:00.000Z',
      data: { from: 'running', to: 'failed', ...data },
      run: RUN,
      seq: 5,
      type: 'state',
    });
  }

  const LINK = 'Reconnect your Claude subscription';
  const UNREACHABLE = /Your cloud workspace could not be reached/u;

  // [origin, class, provider, the one hint the strip offers]: `command:` a copyable companion
  // command, `link` the Settings reconnect link, `unreachable` the cloud sentence, `none` nothing.
  it.each([
    ['subscription', 'auth', 'claude', 'link'],
    ['subscription', 'transport', 'claude', 'unreachable'],
    ['subscription', 'usage_limit', 'claude', 'none'],
    ['device', 'auth', 'claude', 'command:baios-companion login claude'],
    ['device', 'transport', 'claude', 'command:baios-companion start'],
    ['device', 'usage_limit', 'claude', 'none'],
    [undefined, 'auth', 'claude', 'link'],
    [undefined, 'auth', 'codex', 'command:baios-companion login codex'],
    [undefined, 'transport', 'claude', 'command:baios-companion start'],
    [undefined, 'usage_limit', 'claude', 'none'],
  ] as const)(
    'origin %s, %s failure (%s): offers %s, whatever the reason says',
    async (origin, failureClass, provider, hint) => {
      renderScreen(
        <Harness
          initial={[
            failedWith({
              localAgentFailure: {
                class: failureClass,
                provider,
                ...(origin === undefined ? {} : { origin }),
              },
              reason: 'local-agent: something went wrong — try baios-companion start',
            }),
          ]}
          run={failedRun}
        />,
      );

      const strip = within(await screen.findByRole('region', { name: 'Connection' }));
      const command = hint.startsWith('command:') ? hint.slice('command:'.length) : undefined;

      if (command === undefined) {
        expect(strip.queryByRole('button', { name: /^Copy command/u })).not.toBeInTheDocument();
      } else {
        expect(strip.getByRole('button', { name: `Copy command: ${command}` })).toBeInTheDocument();
      }
      if (hint === 'link') {
        expect(strip.getByRole('link', { name: LINK })).toHaveAttribute(
          'href',
          '/settings/account#claude-subscription',
        );
      } else {
        expect(strip.queryByRole('link', { name: LINK })).not.toBeInTheDocument();
      }
      expect(strip.queryByText(UNREACHABLE) !== null).toBe(hint === 'unreachable');
    },
  );

  it('offers no command for a structured failure no command fixes, even if the reason names one', async () => {
    renderScreen(
      <Harness
        initial={[
          failedWith({
            localAgentFailure: { class: 'workspace', provider: 'claude' },
            reason: 'gone — try baios-companion start',
          }),
        ]}
        run={failedRun}
      />,
    );

    const strip = await screen.findByRole('region', { name: 'Connection' });
    expect(within(strip).queryByRole('button', { name: /^Copy command/u })).not.toBeInTheDocument();
  });

  it('falls back to the reason text for an event written before the structured failure', async () => {
    const failed = runEventSchema.parse({
      at: '2026-11-02T10:00:00.000Z',
      data: {
        from: 'running',
        reason: 'Claude Code is not signed in on Studio PC. Run baios-companion login claude.',
        to: 'failed',
      },
      run: RUN,
      seq: 5,
      type: 'state',
    });
    const run: RunResponse = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cancelRequestedAt: null,
      contextSkips: [],
      createdAt: '2026-11-02T10:00:00.000Z',
      endedAt: '2026-11-02T10:00:05.000Z',
      failureClass: 'executor',
      id: RUN,
      inputTokens: 0,
      lastSeq: 5,
      model: 'sonnet',
      outputTokens: 0,
      projectId: PROJECT,
      promptExcerpt: 'go',
      startedAt: '2026-11-02T10:00:00.000Z',
      status: 'failed',
      userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
    };
    renderScreen(<Harness initial={[failed]} run={run} />);

    const strip = await screen.findByRole('region', { name: 'Connection' });
    expect(
      within(strip).getByRole('button', { name: 'Copy command: baios-companion login claude' }),
    ).toBeInTheDocument();
  });
});

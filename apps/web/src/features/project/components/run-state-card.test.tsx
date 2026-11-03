import { type RunEvent, type RunResponse, runEventSchema } from '@repo/contracts';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { ChatPanel } from './chat-panel';

const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RUN = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

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

const resolved = runEventSchema.parse({
  at: '2026-11-02T10:01:00.000Z',
  data: { by: 'user', decision: 'allow', requestId: 'req-1' },
  run: RUN,
  seq: 4,
  type: 'approval.resolved',
});

/** The panel as the project page mounts it. */
function Harness({
  initial,
  run,
}: {
  readonly initial: RunEvent[];
  readonly run?: RunResponse;
}): React.JSX.Element {
  return (
    <ChatPanel
      connection="closed"
      isRunning={false}
      isStopping={false}
      items={initial.map((event) => ({ event, id: String(event.seq) }))}
      onRetry={vi.fn()}
      onStop={vi.fn()}
      onSubmit={vi.fn()}
      placeholder="Ask"
      projectId={PROJECT}
      run={run}
      source="live"
    />
  );
}

describe('ChatPanel — approvals from a retired local-agent run', () => {
  it('renders the stored events as nothing, with no buttons to answer them', async () => {
    renderScreen(<Harness initial={[request, resolved]} />);

    expect(await screen.findByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.queryByText('Run pnpm install')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Allow|Deny/u })).not.toBeInTheDocument();
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

  // [origin, class, provider, the one hint the strip offers]: `link` the Settings reconnect link,
  // `unreachable` the cloud sentence, `none` nothing. `device` is history from retired spec 040.
  it.each([
    ['subscription', 'auth', 'claude', 'link'],
    ['subscription', 'transport', 'claude', 'unreachable'],
    ['subscription', 'usage_limit', 'claude', 'none'],
    ['device', 'auth', 'claude', 'none'],
    ['device', 'transport', 'claude', 'none'],
    ['device', 'usage_limit', 'claude', 'none'],
    [undefined, 'auth', 'claude', 'link'],
    [undefined, 'auth', 'codex', 'none'],
    [undefined, 'transport', 'claude', 'none'],
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
      expect(strip.queryByRole('button', { name: /^Copy command/u })).not.toBeInTheDocument();
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

  it('offers no command for an old failure whose reason names a companion command', async () => {
    renderScreen(
      <Harness
        initial={[
          failedWith({
            reason: 'Claude Code is not signed in on Studio PC. Run baios-companion login claude.',
          }),
        ]}
        run={failedRun}
      />,
    );

    const strip = await screen.findByRole('region', { name: 'Connection' });
    expect(within(strip).queryByRole('button')).not.toBeInTheDocument();
  });
});

import type { RunLineResponse } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { messageFor } from '@/lib/api/problem';
import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { createRun } from '../api';
import { ChatPanel } from './chat-panel';
import { RunList } from './run-list';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const HOLDER = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const FIRST = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const SECOND = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';
const ANA = '3f2504e0-4f89-11d3-9a0c-0305e82c33aa';
const BEN = '3f2504e0-4f89-11d3-9a0c-0305e82c33bb';

const RUNS = `${API}/orgs/${ORG}/projects/${PROJECT}/runs`;
const EDITOR = ['project:agent.run', 'project:read'];
const VIEWER = ['project:read'];

function aLine(status: NonNullable<RunLineResponse['holder']>['status']): RunLineResponse {
  return {
    holder: { runId: HOLDER, startedBy: { email: 'ana@example.test', userId: ANA }, status },
    waiting: [
      {
        createdAt: '2026-09-23T10:00:01.000Z',
        position: 1,
        runId: FIRST,
        startedBy: { email: 'ben@example.test', userId: BEN },
      },
      {
        createdAt: '2026-09-23T10:00:02.000Z',
        position: 2,
        runId: SECOND,
        startedBy: { email: 'ana@example.test', userId: ANA },
      },
    ],
  };
}

function serve(line: () => RunLineResponse): void {
  server.use(
    http.get(`${RUNS}/line`, () => HttpResponse.json(line())),
    http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs: [] })),
  );
}

function renderList(permissions: readonly string[]): void {
  renderScreen(
    <RunList onSelect={vi.fn()} orgId={ORG} permissions={permissions} projectId={PROJECT} />,
  );
}

/** Spec 031 US1: who holds the project, who waits, and why the line is not moving. */
describe('RunList · the run line (031)', () => {
  it('shows the holder and each waiting run with its place in line', async () => {
    serve(() => aLine('running'));
    renderList(EDITOR);

    const line = await screen.findByRole('region', { name: 'Run line' });

    expect(await within(line).findByText('ana@example.test is running')).toBeVisible();
    expect(within(line).getByText('Waiting, 1st in line')).toBeVisible();
    expect(within(line).getByText('Waiting, 2nd in line')).toBeVisible();
    expect(within(line).getByText('ben@example.test')).toBeVisible();
  });

  it('says why the line is not moving when the holder awaits an answer', async () => {
    serve(() => aLine('awaiting_input'));
    renderList(EDITOR);

    expect(
      await screen.findByText('ana@example.test’s run is waiting for an answer'),
    ).toBeVisible();
  });

  it('cancels a waiting run and refetches the line', async () => {
    const user = userEvent.setup();
    const cancelled: string[] = [];
    let current = aLine('running');

    serve(() => current);
    server.use(
      http.post(`${RUNS}/:runId/cancel`, ({ params }) => {
        cancelled.push(String(params.runId));
        current = {
          ...current,
          waiting: current.waiting.slice(1).map((e) => ({ ...e, position: 1 })),
        };

        return new HttpResponse(null, { status: 202 });
      }),
    );
    renderList(EDITOR);

    await screen.findByText('Waiting, 2nd in line');
    await user.click(screen.getAllByRole('button', { name: /Cancel waiting run/ })[0]!);

    expect(cancelled).toEqual([FIRST]);
    expect(await screen.findByText('Waiting, 1st in line')).toBeVisible();
    expect(screen.queryByText('Waiting, 2nd in line')).not.toBeInTheDocument();
  });

  it('offers no cancel control without project:agent.run', async () => {
    serve(() => aLine('running'));
    renderList(VIEWER);

    await screen.findByText('Waiting, 1st in line');

    expect(screen.queryByRole('button', { name: /Cancel waiting run/ })).not.toBeInTheDocument();
  });

  it('shows the queue-full sentence when a start is refused', async () => {
    const user = userEvent.setup();

    server.use(
      http.post(RUNS, () =>
        HttpResponse.json(
          {
            detail: 'The line is full.',
            instance: `/api/v1/orgs/${ORG}/projects/${PROJECT}/runs`,
            reason: 'queue-full',
            requestId: '01JD0000000000000000000000',
            status: 409,
            title: 'Conflict',
            type: 'https://forge.dev/problems/conflict',
          },
          { headers: { 'content-type': 'application/problem+json' }, status: 409 },
        ),
      ),
    );

    /** The console's own wiring: `createRun` refused, the refusal through `messageFor`. */
    function Console(): React.JSX.Element {
      const start = useMutation({
        mutationFn: (prompt: string) => createRun(ORG, PROJECT, { prompt }),
      });

      return (
        <ChatPanel
          connection="idle"
          isRunning={false}
          isStopping={false}
          items={[]}
          onRetry={vi.fn()}
          onStop={vi.fn()}
          onSubmit={(prompt) => {
            start.mutate(prompt);
          }}
          placeholder="Ask for a change to this project"
          refusal={start.error === null ? undefined : messageFor(start.error)}
          run={undefined}
          source="live"
        />
      );
    }

    renderScreen(<Console />);
    await user.type(screen.getByPlaceholderText('Ask for a change to this project'), 'Add a page');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Five runs are already waiting on this project. Try again when one has started.',
    );
  });
});

import type { RunResponse } from '@repo/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useLocation, useParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { useRun } from '../hooks/use-run';
import { RunList } from './run-list';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NEWEST = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const MIDDLE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const OLDEST = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

const RUNS = `${API}/orgs/${ORG}/projects/${PROJECT}/runs`;

function aRun(id: string, promptExcerpt: string, createdAt: string): RunResponse {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelRequestedAt: null,
    contextSkips: [],
    createdAt,
    endedAt: null,
    failureClass: null,
    id,
    inputTokens: 0,
    lastSeq: 0,
    model: 'claude-opus-5',
    outputTokens: 0,
    projectId: PROJECT,
    promptExcerpt,
    startedAt: null,
    status: 'succeeded',
    userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  };
}

/** The three runs the API would answer with, newest first — the order the contract promises. */
const THREE = [
  aRun(NEWEST, 'Add a filter to the rota board', '2026-09-22T10:00:00.000Z'),
  aRun(MIDDLE, 'Rename the export column', '2026-09-22T08:00:00.000Z'),
  aRun(OLDEST, 'Scaffold the rota board', '2026-09-21T10:00:00.000Z'),
];

/** `GET …/runs` with no paging: one page, nothing older. */
function listing(...runs: RunResponse[]) {
  return http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs }));
}

/**
 * The list rendered the way `chat-rail.tsx` renders it: `onSelect` is `useRun`'s own `selectRun`.
 *
 * Wired rather than stubbed on purpose. Asserting that a callback fired would pass just as well
 * if `selectRun` stopped writing the address, which is the half of FR-019 worth protecting — so
 * the row is clicked and the real query string is read back off the router.
 */
function RunBrowser(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const { runId, selectRun } = useRun({ orgId: ORG, projectId });

  return (
    <>
      <RunList onSelect={selectRun} orgId={ORG} projectId={projectId} selectedRunId={runId} />
      <output data-testid="search">{useLocation().search}</output>
    </>
  );
}

function renderBrowser(): void {
  renderScreen(<RunBrowser />, { path: `/projects/${PROJECT}`, route: '/projects/:projectId' });
}

describe('RunList', () => {
  it('SC-006: lists three runs newest first with their excerpts and picking the oldest puts its id in the URL', async () => {
    const user = userEvent.setup();

    server.use(listing(...THREE));
    renderBrowser();

    const rows = await screen.findAllByRole('listitem');

    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Add a filter to the rota board');
    expect(rows[1]).toHaveTextContent('Rename the export column');
    expect(rows[2]).toHaveTextContent('Scaffold the rota board');
    expect(within(rows[0]!).getByText('Ready')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Scaffold the rota board/ }));

    expect(screen.getByTestId('search')).toHaveTextContent(`run=${OLDEST}`);
    expect(screen.getByRole('button', { name: /Scaffold the rota board/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('pages older runs on demand', async () => {
    const user = userEvent.setup();
    const cursors: (string | null)[] = [];

    server.use(
      http.get(RUNS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');

        cursors.push(cursor);

        return HttpResponse.json(
          cursor === null
            ? { nextCursor: 'older-than-the-first-page', runs: THREE.slice(0, 2) }
            : { nextCursor: null, runs: THREE.slice(2) },
        );
      }),
    );
    renderBrowser();

    expect(await screen.findByText('Rename the export column')).toBeVisible();
    expect(screen.queryByText('Scaffold the rota board')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load older' }));

    expect(await screen.findByText('Scaffold the rota board')).toBeVisible();
    // The first page is still on screen: older runs extend the list rather than replace it.
    expect(screen.getByText('Add a filter to the rota board')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
    expect(cursors).toContain('older-than-the-first-page');
  });

  it('reads a run with no user message as "No prompt" rather than an empty row', async () => {
    // The API answers `''` for a run started without one, which is a run to go back to and not a
    // blank line (FR-019).
    server.use(listing(aRun(NEWEST, '', '2026-09-22T10:00:00.000Z')));
    renderScreen(<RunList onSelect={vi.fn()} orgId={ORG} projectId={PROJECT} />);

    expect(await screen.findByText('No prompt')).toBeVisible();
  });
});

/** 034: a run `awaiting_input` is answered from its row (`POST …/runs/:runId/input`). */
describe('RunList · answering a waiting run', () => {
  const EDITOR = ['project:agent.run', 'project:read'];
  const waiting: RunResponse = {
    ...aRun(NEWEST, 'Add a filter to the rota board', '2026-09-22T10:00:00.000Z'),
    status: 'awaiting_input',
  };

  function renderList(permissions: readonly string[]): void {
    renderScreen(
      <RunList onSelect={vi.fn()} orgId={ORG} permissions={permissions} projectId={PROJECT} />,
    );
  }

  it('sends the answer and re-reads the list', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    let current = waiting;

    server.use(
      http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs: [current] })),
      http.post(`${RUNS}/:runId/input`, async ({ params, request }) => {
        expect(params.runId).toBe(NEWEST);
        bodies.push(await request.json());
        current = { ...waiting, status: 'queued' };

        return new HttpResponse(null, { status: 202 });
      }),
    );
    renderList(EDITOR);

    await user.type(await screen.findByLabelText('Answer the run'), '  Use the blue one  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(bodies).toEqual([{ message: 'Use the blue one' }]);
    expect(await screen.findByText('Queued')).toBeVisible();
    expect(screen.queryByLabelText('Answer the run')).not.toBeInTheDocument();
  });

  it('shows the refusal when the run has already moved on', async () => {
    const user = userEvent.setup();

    server.use(
      http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs: [waiting] })),
      http.post(`${RUNS}/:runId/input`, () =>
        HttpResponse.json(
          {
            detail: 'The run is running.',
            instance: `/api/v1/orgs/${ORG}/projects/${PROJECT}/runs/${NEWEST}/input`,
            requestId: '01JD0000000000000000000000',
            status: 409,
            title: 'Conflict',
            type: 'https://forge.dev/problems/conflict',
          },
          { headers: { 'content-type': 'application/problem+json' }, status: 409 },
        ),
      ),
    );
    renderList(EDITOR);

    await user.type(await screen.findByLabelText('Answer the run'), 'Yes');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That conflicts with something that already exists.',
    );
  });

  it('offers no answer without project:agent.run', async () => {
    server.use(http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs: [waiting] })));
    renderList(['project:read']);

    await screen.findByText('Waiting for you');

    expect(screen.queryByLabelText('Answer the run')).not.toBeInTheDocument();
  });
});

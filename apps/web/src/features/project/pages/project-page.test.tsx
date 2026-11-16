import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Navigate } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RunEvent, RunResponse } from '@repo/contracts';
import { waitFor } from '@testing-library/react';

import { createQueryClient } from '@/app/query-client';
import { RequireAuth } from '@/features/auth/session/route-guards';
import type { ModelChoice } from '@/features/workspace/lib/model-choice';
import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server, subscriptionHandler } from '@/test/server';
import { frame, sse } from '@/test/sse';
import { ProjectPage } from './project-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '8f14e45f-ceea-4b73-a5f1-0d1a4e2f9c11';
const RUN_ID = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const RUNS = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}/runs`;

const HAIKU: ModelChoice = { model: 'claude-haiku-4-5', source: 'catalogue' };

const aRun: RunResponse = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cancelRequestedAt: null,
  contextSkips: [],
  createdAt: '2026-08-18T10:00:00.000Z',
  endedAt: null,
  failureClass: null,
  id: RUN_ID,
  inputTokens: 0,
  lastSeq: 0,
  model: 'claude-opus-5',
  outputTokens: 0,
  projectId: PROJECT_ID,
  promptExcerpt: 'ship it',
  startedAt: null,
  status: 'running',
  userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
};

function token(seq: number, text: string): RunEvent {
  return { at: '2026-08-18T10:00:00.000Z', data: { text }, run: RUN_ID, seq, type: 'token' };
}

function patch(seq: number, path: string): RunEvent {
  return {
    at: '2026-08-18T10:00:00.000Z',
    data: { diff: '--- a', path },
    run: RUN_ID,
    seq,
    type: 'file.patch',
  };
}

function state(seq: number, to: 'cancelled' | 'succeeded'): RunEvent {
  return {
    at: '2026-08-18T10:00:00.000Z',
    data: { from: 'running', to },
    run: RUN_ID,
    seq,
    type: 'state',
  };
}

function toolStart(seq: number): RunEvent {
  return {
    at: '2026-08-18T10:00:00.000Z',
    data: { input: {}, stepId: 's1', tool: 'pkg.add recharts' },
    run: RUN_ID,
    seq,
    type: 'tool.start',
  };
}

function delta(seq: number, chunk: string): RunEvent {
  return {
    at: '2026-08-18T10:00:00.000Z',
    data: { chunk, stepId: 's1' },
    run: RUN_ID,
    seq,
    type: 'tool.delta',
  };
}

function toolFailed(seq: number): RunEvent {
  return {
    at: '2026-08-18T10:00:00.000Z',
    data: { error: "'rows' is not defined", ok: false, stepId: 's1' },
    run: RUN_ID,
    seq,
    type: 'tool.end',
  };
}

/**
 * A stream the test drives.
 *
 * `sse()` writes its frames and is done, which is everything the reducer's tests need. This one
 * stays open so a frame can be made to arrive *after* something the person did — which is the
 * whole of the cancel story: the acknowledgement has to stand in the gap between asking a run to
 * stop and the run saying it has.
 */
function liveStream() {
  const encoder = new TextEncoder();
  let feed!: ReadableStreamDefaultController<Uint8Array>;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      feed = controller;
      controller.enqueue(encoder.encode('retry: 10\n\n'));
    },
  });

  return {
    response: (): Response =>
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(written: string): void {
      feed.enqueue(encoder.encode(written));
    },
  };
}

/** The stop request, answered as the API answers it: `202` with no body. */
function cancelHandler(onCancel?: () => void) {
  return http.post(`${RUNS}/${RUN_ID}/cancel`, () => {
    onCancel?.();

    // Still `running`: a stop is a request, and the run is what says when it has stopped.
    return new HttpResponse(null, { status: 202 });
  });
}

/**
 * The three requests a started run makes: create it, read it, then stream it.
 *
 * The create answers with the model it was sent, or the deployment's default when it was sent
 * none — which is what the real one records on the row (spec 011 US6).
 */
function runHandlers(stream: () => Response, onCreate?: (body: unknown) => void) {
  let run = aRun;

  return [
    http.post(RUNS, async ({ request }) => {
      const body = (await request.json()) as { model?: string; prompt: string };

      onCreate?.(body);
      run = { ...aRun, model: body.model ?? 'claude-sonnet-5' };

      return HttpResponse.json(run);
    }),
    http.get(`${RUNS}/${RUN_ID}`, () => HttpResponse.json(run)),
    http.get(`${RUNS}/${RUN_ID}/stream`, stream),
  ];
}

/** Type an instruction and send it, as a person would. */
async function ask(user: ReturnType<typeof userEvent.setup>, prompt: string): Promise<void> {
  await user.type(screen.getByLabelText(/ask baios for a change/i), prompt);
  await user.keyboard('{Enter}');
}

/** Renders the screen, optionally on the run `?run=` names (R4, FR-025). */
function renderPage(run?: string): void {
  const search = run === undefined ? '' : `?run=${run}`;

  renderScreen(<ProjectPage />, {
    path: `/projects/${PROJECT_ID}${search}`,
    route: '/projects/:projectId',
  });
}

/**
 * Arrives the way the workspace composer sends somebody here: a fresh project, with the prompt
 * and the model pick in navigation state (spec 007 R7, spec 011 US6).
 */
function renderFromWorkspace(handoff: { choice?: ModelChoice; prompt: string }): void {
  renderScreen(<Navigate replace state={handoff} to={`/projects/${PROJECT_ID}`} />, {
    path: '/',
    routes: { '/projects/:projectId': <ProjectPage /> },
  });
}

/**
 * The wide and narrow tab sets are both in the DOM — only CSS hides one — so
 * stage queries go through the wide set explicitly.
 */
function stageTab(name: RegExp): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Stage' })).getByRole('tab', { name });
}

describe('ProjectPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API}/orgs/:orgId/connectors`, () => HttpResponse.json({ connections: [] })),
      http.get(`${API}/orgs/:orgId/projects/:projectId/repo-link`, () => HttpResponse.json(null)),
    );
    // The model picker remembers its choice per project (spec 043); every test starts unpicked.
    window.localStorage.removeItem(`baios.model.${PROJECT_ID}`);
    // The topbar reads the project name from the API; everything else on this screen is still
    // mock data, which is spec 002's stated scope boundary.
    server.use(
      http.get(`${API}/orgs`, () =>
        HttpResponse.json({
          orgs: [
            {
              access: 'member',
              createdAt: '2026-08-01T09:00:00.000Z',
              id: ORG_ID,
              name: 'Blinto',
              plan: 'free',
              role: 'owner',
              slug: 'blinto',
            },
          ],
        }),
      ),
      // The page asks which run to open on every render now (FR-024). A project with no runs is
      // the quiet default; the tests that start or open one answer this route themselves.
      http.get(RUNS, () => HttpResponse.json({ nextCursor: null, runs: [] })),
      // The Code stage is the real one now (T015): it lists the working tree on open. An empty
      // one keeps this file about the console — what a populated tree renders is
      // stage-code.test.tsx's job.
      http.get(`${API}/orgs/:orgId/projects/:projectId/files`, () =>
        HttpResponse.json({ entries: [], path: '' }),
      ),
      // The topbar reads the site for whether the project can be deployed at all (spec 028: the
      // Domains button is offered only on one that can). Not deployable is the quiet default.
      http.get(`${API}/orgs/:orgId/projects/:projectId/site`, () =>
        HttpResponse.json({
          site: { currentDeploymentId: null, deployable: false, offline: false, url: null },
        }),
      ),
      http.get(`${API}/orgs/:orgId/projects/:projectId`, () =>
        HttpResponse.json({
          project: {
            createdAt: '2026-08-18T10:00:00.000Z',
            id: PROJECT_ID,
            name: 'On-call rota dashboard',
            permissions: ['project:read'],
          },
        }),
      ),
    );
  });
  it('opens a project that has never had a run, ready to start one', async () => {
    // FR-026, and the first half of SC-007: nothing has happened, so the screen says so on every
    // surface rather than filling them in.
    renderPage();

    expect(await screen.findByRole('button', { name: /On-call rota dashboard/ })).toBeVisible();
    expect(screen.getByLabelText(/ask baios for a change/i)).toBeVisible();
    // Twice: the address bar has no address to show either.
    expect(screen.getAllByText('No preview yet').length).toBeGreaterThan(0);
    // Nothing in the transcript: not a spinner, not a greeting, not a suggested first prompt.
    expect(screen.getByRole('log', { name: 'Conversation' })).toHaveTextContent('');
  });

  // What you type is your own words and is shown at once; everything after it comes from the run.
  it('adds what you type to the transcript', async () => {
    const user = userEvent.setup();
    server.use(...runHandlers(() => sse([])));
    renderPage();

    await user.type(screen.getByLabelText(/ask baios for a change/i), 'Add holiday cover{Enter}');

    const log = screen.getByRole('log', { name: 'Conversation' });

    expect(within(log).getByText('Add holiday cover')).toBeVisible();
  });

  it('opens a run from its address with what was asked as its first message (spec 043)', async () => {
    server.use(...runHandlers(() => sse([])));
    renderPage(RUN_ID);

    const log = screen.getByRole('log', { name: 'Conversation' });

    expect(await within(log).findByText('ship it')).toBeVisible();
  });

  it("opens the Code stage on the project's real files, never a sample tree", async () => {
    // 012 FR-028 deferred this pane because reading a project's files needed an endpoint that
    // spec could not add; 022 adds it, so the stage lists the working tree — and still nothing
    // invented.
    const user = userEvent.setup();
    renderPage();

    await user.click(stageTab(/Code/));

    // The Code stage is the real one now (T015); what it lists is stage-code.test.tsx's job.
    expect(
      screen.queryByText("Browsing the project's files arrives in a later release"),
    ).toBeNull();
    expect(await screen.findByRole('tree', { name: 'Project files' })).toBeVisible();
  });

  it('lists the files this run changed, and defers the history', async () => {
    // FR-029: the list is the run's own `file.patch` events, deduplicated — no line counts and no
    // summary of what each file does, because the run reports neither.
    const user = userEvent.setup();

    server.use(
      ...runHandlers(() =>
        sse([
          frame(patch(1, 'src/rota.ts')),
          frame(patch(2, 'src/swap.ts')),
          frame(patch(3, 'src/rota.ts')),
        ]),
      ),
    );

    renderPage();
    await ask(user, 'go');

    await user.click(stageTab(/Git/));

    expect(await screen.findByText('2 files changed since your last save')).toBeVisible();
    expect(screen.getByText('src/rota.ts')).toBeVisible();
    expect(screen.getByText('src/swap.ts')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'History' }));

    // The History pane is the real one now (T019); what it lists is git-history.test.tsx's job.
    expect(screen.queryByText("The project's history arrives in a later release")).toBeNull();
  });

  it("opens the activity log on its shortcut and filters to the run's own problems", async () => {
    // FR-029 again: the log is what the tools wrote (`tool.delta`) and what a failed one said
    // (`tool.end`). The problem filter keeps the run's classification, not a guess from the text.
    const user = userEvent.setup();

    server.use(
      ...runHandlers(() =>
        sse([frame(toolStart(1)), frame(delta(1, 'installed recharts')), frame(toolFailed(2))]),
      ),
    );

    renderPage();
    await ask(user, 'go');

    // The card for the tool itself is the transcript's; its output belongs to the log.
    expect(await screen.findByText('pkg.add recharts')).toBeVisible();

    await user.keyboard('{Control>}j{/Control}');

    const panel = screen.getByRole('region', { name: 'Activity log' });
    expect(await within(panel).findByText('installed recharts')).toBeVisible();

    await user.click(within(panel).getByRole('button', { name: 'Problems only' }));

    expect(within(panel).queryByText('installed recharts')).not.toBeInTheDocument();
    expect(within(panel).getByText("'rows' is not defined")).toBeVisible();
  });

  it('collapses the chat to a rail, which splits the stage', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Hide the chat panel' }));

    expect(screen.getByRole('button', { name: 'Show the chat panel' })).toBeVisible();
    // Both panes of the split, each saying honestly that it has nothing yet.
    expect(await screen.findByRole('tree', { name: 'Project files' })).toBeVisible();
    expect(screen.getAllByText('No preview yet').length).toBeGreaterThan(0);
  });

  /**
   * A project the caller may not read, one that has been archived and one that never existed are
   * one refusal at the API, and one page here — never the stage standing in for a project that is
   * not there (FR-022).
   */
  it.each([
    ['not-found', 404],
    ['permission-denied', 403],
  ])(
    'shows one refusal for an archived, a missing and a foreign project (%s)',
    async (slug, status) => {
      server.use(
        http.get(`${API}/orgs/:orgId/projects/:projectId`, () => problemResponse(slug, status)),
      );
      renderPage();

      expect(
        await screen.findByRole('heading', { level: 1, name: 'That page does not exist' }),
      ).toBeVisible();
      expect(screen.queryByRole('tabpanel', { name: 'Stage' })).not.toBeInTheDocument();
    },
  );

  /**
   * The run itself, now that spec 008 and 009 have built it.
   *
   * Everything asserted here arrived as an event or as the run's own record. Nothing on these
   * surfaces is filled in by the screen (FR-003), which is what the transcript's emptiness in the
   * last case is proving.
   */
  /**
   * The production 403s (2026-11-16): an import that fails withdraws its project, and the page kept
   * polling the deleted project's preview, sync and presence. It reads the import instead, says why,
   * and asks the gone project for nothing more.
   */
  describe('an import that failed (spec 026 R2, spec 047)', () => {
    const WORKSPACE = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
    const OPERATION = '1f0c8f2e-1111-4111-8111-111111111111';

    const operation = (state: 'failed' | 'running') => ({
      commits: 0,
      createdAt: '2026-11-16T06:08:35.000Z',
      finishedAt: state === 'failed' ? '2026-11-16T06:08:39.000Z' : null,
      fromSha: null,
      id: OPERATION,
      kind: 'import',
      projectId: PROJECT_ID,
      reason: state === 'failed' ? 'import-checkout-failed' : null,
      requestedBy: { id: ORG_ID, name: 'Sayem' },
      startedAt: '2026-11-16T06:08:37.000Z',
      state,
      targetBranch: null,
      toSha: 'a'.repeat(40),
      trigger: 'manual',
    });

    it('says the import failed and why, and stops asking the withdrawn project anything', async () => {
      const asked: string[] = [];
      server.use(
        http.get(`${API}/orgs/:orgId/workspaces/:workspaceId/imports/:operationId`, () =>
          HttpResponse.json(operation('failed')),
        ),
        // The project itself still reads (a cached or racing answer): the import alone decides.
        http.all(`${API}/orgs/:orgId/projects/:projectId/:rest+`, ({ request }) => {
          asked.push(`${request.method} ${new URL(request.url).pathname}`);
          return problemResponse('permission-denied', 403);
        }),
      );

      renderScreen(<ProjectPage />, {
        path: `/projects/${PROJECT_ID}?import=${OPERATION}&ws=${WORKSPACE}`,
        route: '/projects/:projectId',
      });

      expect(await screen.findByRole('heading', { name: 'The import failed' })).toBeVisible();
      expect(screen.getByText(/could not be checked out/i)).toBeVisible();
      expect(screen.getByRole('link', { name: 'Try again' })).toBeVisible();

      // Settled: no presence beat, preview poll or sync poll reaches the deleted project.
      const settled = asked.length;
      // Longer than one presence beat (4 s) and several preview and sync polls.
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      expect(asked.slice(settled)).toEqual([]);
    }, 15_000);

    it('an import still running shows the project as usual', async () => {
      server.use(
        http.get(`${API}/orgs/:orgId/workspaces/:workspaceId/imports/:operationId`, () =>
          HttpResponse.json(operation('running')),
        ),
      );

      renderScreen(<ProjectPage />, {
        path: `/projects/${PROJECT_ID}?import=${OPERATION}&ws=${WORKSPACE}`,
        route: '/projects/:projectId',
      });

      expect(await screen.findByRole('button', { name: /On-call rota dashboard/ })).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'The import failed' })).toBeNull();
    });
  });

  describe('the GitHub panel (spec 044)', () => {
    beforeEach(() => {
      server.use(
        http.get(`${API}/orgs/:orgId/projects/:projectId/checkpoints`, () =>
          HttpResponse.json({ items: [], nextCursor: null }),
        ),
      );
    });

    it('opens from the topbar icon, in place, with one way to connect', async () => {
      const user = userEvent.setup();

      renderPage();

      await user.click(
        await screen.findByRole('button', { name: 'Set up GitHub for this project' }),
      );

      expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeVisible();
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'GitHub' })).toHaveFocus();
      });
    });

    it('is where a trip to GitHub comes back to', async () => {
      renderScreen(<ProjectPage />, {
        path: `/projects/${PROJECT_ID}?panel=github`,
        route: '/projects/:projectId',
      });

      expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    });
  });

  describe('a real run', () => {
    it('starts a run from the composer and renders what the run reports', async () => {
      const user = userEvent.setup();

      server.use(
        ...runHandlers(() =>
          sse([
            frame(patch(1, 'src/rota.ts')),
            frame(token(1, 'Adding the swap button.')),
            frame(patch(2, 'src/swap.ts')),
          ]),
        ),
      );

      renderPage();
      await ask(user, 'add a swap button');

      const log = screen.getByRole('log', { name: 'Conversation' });

      // The instruction is the person's own words and appears at once, without waiting on the run.
      expect(within(log).getByText('add a swap button')).toBeVisible();

      // Everything after it is the run's.
      expect(await within(log).findByText('Adding the swap button.')).toBeVisible();
      expect(await within(log).findByText(/src\/rota\.ts/)).toBeVisible();
      expect(await within(log).findByText(/src\/swap\.ts/)).toBeVisible();
    });

    it('reloads the preview frame when the run lands its checkpoint', async () => {
      const user = userEvent.setup();
      const live = liveStream();

      server.use(
        ...runHandlers(live.response),
        http.get(`${API}/orgs/:orgId/projects/:projectId/preview`, () =>
          HttpResponse.json({
            port: 3000,
            stage: 'ready',
            url: 'https://a.preview.test',
            visibility: 'public',
          }),
        ),
      );

      renderPage();
      await user.click(stageTab(/Preview/));
      await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
      await ask(user, 'add a swap button');
      const before = document.querySelector('iframe');

      // What a successful run ends on (agent-executor): its files committed, nothing else to say.
      live.send(
        frame({
          at: '2026-08-18T10:00:00.000Z',
          data: { checkpointId: 'c1', label: 'add a swap button' },
          run: RUN_ID,
          seq: 1,
          type: 'checkpoint',
        }),
      );

      await waitFor(() => expect(document.querySelector('iframe')).not.toBe(before));
    });

    it('rereads the GitHub state the moment a checkpoint lands (spec 044)', async () => {
      const user = userEvent.setup();
      const live = liveStream();
      let reads = 0;

      server.use(
        ...runHandlers(live.response),
        http.get(`${API}/orgs/:orgId/projects/:projectId/repo-link`, () => {
          reads += 1;

          return HttpResponse.json(null);
        }),
      );

      renderPage();
      await ask(user, 'add a swap button');
      await waitFor(() => expect(reads).toBe(1));

      live.send(
        frame({
          at: '2026-08-18T10:00:00.000Z',
          data: { checkpointId: 'c1', label: 'add a swap button' },
          run: RUN_ID,
          seq: 1,
          type: 'checkpoint',
        }),
      );

      await waitFor(() => expect(reads).toBe(2));
    });

    it('loads the preview once on open: a checkpoint the stream replays reloads nothing', async () => {
      // The run already counts its checkpoint (lastSeq 1). A fresh connection replays it, and
      // only a checkpoint newer than the connection is a reason to reload (spec 043).
      const live = liveStream();

      server.use(
        http.get(`${RUNS}/${RUN_ID}`, () => HttpResponse.json({ ...aRun, lastSeq: 1 })),
        http.get(`${RUNS}/${RUN_ID}/stream`, () => live.response()),
        http.get(`${API}/orgs/:orgId/projects/:projectId/preview`, () =>
          HttpResponse.json({
            port: 3000,
            stage: 'ready',
            url: 'https://a.preview.test',
            visibility: 'public',
          }),
        ),
      );

      renderPage(RUN_ID);
      const user = userEvent.setup();
      await user.click(stageTab(/Preview/));
      await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
      const before = document.querySelector('iframe');
      const checkpoint = (seq: number, label: string): string =>
        frame({
          at: '2026-08-18T10:00:00.000Z',
          data: { checkpointId: `c${String(seq)}`, label },
          run: RUN_ID,
          seq,
          type: 'checkpoint',
        });

      live.send(checkpoint(1, 'the replayed one'));
      const log = screen.getByRole('log', { name: 'Conversation' });
      expect(await within(log).findByText('the replayed one')).toBeVisible();
      expect(document.querySelector('iframe')).toBe(before);

      live.send(checkpoint(2, 'a new one'));
      await waitFor(() => expect(document.querySelector('iframe')).not.toBe(before));
    });

    it('says the sandbox is being prepared when the run reports it (014 FR-006)', async () => {
      const user = userEvent.setup();

      server.use(
        ...runHandlers(() =>
          sse([
            frame({
              at: '2026-08-18T10:00:00.000Z',
              data: { transition: 'creating' },
              run: RUN_ID,
              seq: 1,
              type: 'sandbox.preparing',
            }),
          ]),
        ),
      );

      renderPage();
      await ask(user, 'go');

      const log = screen.getByRole('log', { name: 'Conversation' });

      expect(await within(log).findByText('Preparing sandbox: creating')).toBeVisible();
    });

    it("shows a credential failure in the run's own words (020 US3, R7)", async () => {
      const user = userEvent.setup();
      // The `state` event carries the reason verbatim; the `credential` class sits on the run
      // record, not on the event, so the console has only the sentence to show.
      const reason =
        "Anthropic rejected the organisation's key ending ••••abcd — an admin must replace or remove it in Settings › Connectors";

      server.use(
        ...runHandlers(() =>
          sse([
            frame({
              at: '2026-08-18T10:00:00.000Z',
              data: { from: 'running', reason, to: 'failed' },
              run: RUN_ID,
              seq: 1,
              type: 'state',
            }),
          ]),
        ),
      );

      renderPage();
      await ask(user, 'go');

      const log = screen.getByRole('log', { name: 'Conversation' });

      expect(await within(log).findByText(reason)).toBeVisible();
    });

    it('follows the status the run reports', async () => {
      const user = userEvent.setup();

      server.use(...runHandlers(() => sse([])));
      renderPage();
      await ask(user, 'go');

      // `running` is spoken as "Building". The chip appears in the topbar and again on the
      // preview's address bar, and both read the one table so they can never disagree.
      await waitFor(() => {
        expect(screen.getAllByText('Building').length).toBeGreaterThan(0);
      });
    });

    it('shows the model the run reports under the conversation', async () => {
      const user = userEvent.setup();

      server.use(...runHandlers(() => sse([])));
      renderPage();
      await ask(user, 'go');

      const log = screen.getByRole('log', { name: 'Conversation' });

      expect(await within(log).findByText('claude-sonnet-5')).toBeVisible();
    });

    it("sends the catalogue's default model with the trimmed prompt when nothing was picked", async () => {
      const user = userEvent.setup();
      let body: unknown;

      server.use(
        ...runHandlers(
          () => sse([]),
          (sent) => {
            body = sent;
          },
        ),
      );

      renderPage();
      await screen.findByRole('button', { name: /Sonnet 5.*change model/ });
      await ask(user, '  add a swap button  ');

      // Spec 043: the picker is the payment choice; with no subscription connected that is the
      // organisation key the catalogue defaults to.
      await waitFor(() => {
        expect(body).toEqual({ model: 'claude-sonnet-5', prompt: 'add a swap button' });
      });
    });

    it('sends the subscription and the model picked from it (spec 041, 043)', async () => {
      const user = userEvent.setup();
      let body: unknown;

      server.use(
        subscriptionHandler({
          models: [
            { description: null, id: 'opus', label: 'Opus' },
            { description: null, id: 'sonnet', label: 'Sonnet' },
          ],
          plan: 'Max',
          state: 'connected',
        }),
        ...runHandlers(
          () => sse([]),
          (sent) => {
            body = sent;
          },
        ),
      );

      renderPage();
      await user.click(await screen.findByRole('button', { name: /Opus.*change model/ }));
      await user.click(await screen.findByRole('option', { name: 'Sonnet' }));
      await ask(user, 'add a swap button');

      await waitFor(() => {
        expect(body).toEqual({
          model: 'sonnet',
          prompt: 'add a swap button',
          subscription: { provider: 'claude' },
        });
      });
      // Remembered for this project.
      expect(window.localStorage.getItem(`baios.model.${PROJECT_ID}`)).toBe(
        JSON.stringify({ model: 'sonnet', source: 'subscription' }),
      );
    });

    it('applies a model switch to the next message, mid-conversation', async () => {
      const user = userEvent.setup();
      const bodies: unknown[] = [];

      server.use(
        ...runHandlers(
          () => sse([]),
          (sent) => {
            bodies.push(sent);
          },
        ),
      );

      renderPage();
      await screen.findByRole('button', { name: /Sonnet 5.*change model/ });
      await ask(user, 'first');
      await waitFor(() => {
        expect(bodies).toHaveLength(1);
      });

      await user.click(screen.getByRole('button', { name: /Sonnet 5.*change model/ }));
      await user.click(await screen.findByRole('option', { name: 'Claude Opus 5' }));
      await ask(user, 'second');

      await waitFor(() => {
        expect(bodies).toEqual([
          { model: 'claude-sonnet-5', prompt: 'first' },
          { model: 'claude-opus-5', prompt: 'second' },
        ]);
      });
    });

    it('answers a run that waits for input instead of starting another', async () => {
      const user = userEvent.setup();
      const stream = liveStream();
      const answers: unknown[] = [];
      let created = 0;

      server.use(
        http.get(`${RUNS}/${RUN_ID}`, () =>
          HttpResponse.json({ ...aRun, lastSeq: 1, status: 'awaiting_input' }),
        ),
        http.get(`${RUNS}/${RUN_ID}/stream`, () => stream.response()),
        http.post(RUNS, () => {
          created += 1;

          return HttpResponse.json(aRun);
        }),
        http.post(`${RUNS}/${RUN_ID}/input`, async ({ request }) => {
          answers.push(await request.json());

          return new HttpResponse(null, { status: 202 });
        }),
      );

      renderPage(RUN_ID);
      await screen.findByRole('button', { name: /Sonnet 5.*change model/ });
      await user.type(await screen.findByLabelText('Answer the run'), 'Use the blue one{Enter}');

      await waitFor(() => {
        expect(answers).toEqual([{ message: 'Use the blue one', model: 'claude-sonnet-5' }]);
      });
      expect(created).toBe(0);
      expect(
        within(screen.getByRole('log', { name: 'Conversation' })).getByText('Use the blue one'),
      ).toBeVisible();
    });

    it('keeps the prompt and claims no queued run when the run request is refused', async () => {
      const user = userEvent.setup();

      server.use(http.post(RUNS, () => problemResponse('rate-limited', 429)));
      renderPage();
      await ask(user, 'add a swap button');

      expect(
        await screen.findByText('Too many attempts. Please wait a moment and try again.'),
      ).toBeVisible();
      // The words come back to the box, and no bubble or phase pretends a run exists.
      expect(screen.getByLabelText(/ask baios for a change/i)).toHaveValue('add a swap button');
      expect(
        within(screen.getByRole('log', { name: 'Conversation' })).queryByText('add a swap button'),
      ).not.toBeInTheDocument();
      expect(within(screen.getByRole('banner')).queryByText('Queued')).not.toBeInTheDocument();
    });

    it('offers to connect instead of sending when nothing can pay for a run (spec 043)', async () => {
      // `onUnhandledRequest: 'error'` is the assertion that nothing was sent: no run handler.
      const user = userEvent.setup();

      server.use(
        http.get(`${API}/orgs/:orgId/models`, () =>
          HttpResponse.json({ default: null, models: [] }),
        ),
      );
      renderPage();

      expect(
        await screen.findByRole('link', { name: 'Connect your Claude subscription' }),
      ).toHaveAttribute('href', '/settings/account#claude-subscription');
      await ask(user, 'go');

      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the connect path, not an error, when the API says nothing can pay', async () => {
      const user = userEvent.setup();

      server.use(http.post(RUNS, () => problemResponse('subscription-not-connected', 409)));
      renderPage();
      await screen.findByRole('button', { name: /Sonnet 5.*change model/ });
      await ask(user, 'go');

      expect(
        await screen.findByRole('link', { name: 'Connect your Claude subscription' }),
      ).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('retries a failed run with its prompt, as a new run', async () => {
      const user = userEvent.setup();
      const bodies: unknown[] = [];

      server.use(
        ...runHandlers(
          () =>
            sse([
              frame({
                at: '2026-08-18T10:00:00.000Z',
                data: { from: 'running', reason: 'The model refused.', to: 'failed' },
                run: RUN_ID,
                seq: 1,
                type: 'state',
              }),
            ]),
          (sent) => {
            bodies.push(sent);
          },
        ),
      );

      renderPage();
      await screen.findByRole('button', { name: /Sonnet 5.*change model/ });
      await ask(user, 'add a swap button');
      await user.click(await screen.findByRole('button', { name: 'Retry' }));

      await waitFor(() => {
        expect(bodies).toEqual([
          { model: 'claude-sonnet-5', prompt: 'add a swap button' },
          { model: 'claude-sonnet-5', prompt: 'add a swap button' },
        ]);
      });
    });

    it('retries a failed run with the same attachment ids, without uploading again (SC-8)', async () => {
      const user = userEvent.setup();
      const bodies: unknown[] = [];
      let uploads = 0;
      const attachment = {
        createdAt: '2026-08-18T09:59:00.000Z',
        id: '6ba7b899-9dad-11d1-80b4-00c04fd430c8',
        kind: 'text',
        mimeType: 'text/markdown',
        name: 'notes.md',
        sizeBytes: 7,
      };

      server.use(
        http.post(`${API}/orgs/:orgId/projects/:projectId/attachments`, () => {
          uploads += 1;

          return HttpResponse.json(attachment, { status: 201 });
        }),
        ...runHandlers(
          () =>
            sse([
              frame({
                at: '2026-08-18T10:00:00.000Z',
                data: { from: 'running', reason: 'The model refused.', to: 'failed' },
                run: RUN_ID,
                seq: 1,
                type: 'state',
              }),
            ]),
          (sent) => {
            bodies.push(sent);
          },
        ),
      );

      renderPage();
      await screen.findByRole('button', { name: /Sonnet 5.*change model/ });
      await user.upload(screen.getByTestId('attach-input'), new File(['# notes'], 'notes.md'));
      await user.type(screen.getByLabelText(/ask baios for a change/i), 'use my notes');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
      });
      await user.keyboard('{Enter}');
      // The sent message shows what it carried.
      expect(
        await within(screen.getByRole('log', { name: 'Conversation' })).findByRole('link', {
          name: /notes\.md/,
        }),
      ).toHaveAttribute('href', expect.stringContaining(`/attachments/${attachment.id}/content`));
      await user.click(await screen.findByRole('button', { name: 'Retry' }));

      const sent = {
        attachmentIds: [attachment.id],
        model: 'claude-sonnet-5',
        prompt: 'use my notes',
      };
      await waitFor(() => {
        expect(bodies).toEqual([sent, sent]);
      });
      expect(uploads).toBe(1);
    });

    it('sends the model that rode in from the workspace on the first run, and keeps it', async () => {
      // Spec 011 US6: the workspace composer's prompt and pick arrive in navigation state, and the
      // first run is started from them without asking twice. The pick is the project's from then
      // on, so the next run, typed here, carries it too (spec 043).
      const user = userEvent.setup();
      const bodies: unknown[] = [];

      server.use(
        ...runHandlers(
          () => sse([]),
          (sent) => {
            bodies.push(sent);
          },
        ),
      );

      renderFromWorkspace({ choice: HAIKU, prompt: 'A rota board' });

      const log = screen.getByRole('log', { name: 'Conversation' });

      expect(await within(log).findByText('A rota board')).toBeVisible();
      await waitFor(() => {
        expect(bodies).toEqual([{ model: 'claude-haiku-4-5', prompt: 'A rota board' }]);
      });

      await ask(user, 'add holiday cover');

      await waitFor(() => {
        expect(bodies).toEqual([
          { model: 'claude-haiku-4-5', prompt: 'A rota board' },
          { model: 'claude-haiku-4-5', prompt: 'add holiday cover' },
        ]);
      });
    });

    it('shows the model the created run reports in the chip', async () => {
      // The chip is the run's own record, not the pick echoed back locally: what the API says it
      // will run on is what the screen says.
      server.use(...runHandlers(() => sse([])));

      renderFromWorkspace({ choice: HAIKU, prompt: 'A rota board' });

      expect(await screen.findByText('claude-haiku-4-5')).toBeVisible();
      expect(screen.queryByText('claude-sonnet-5')).not.toBeInTheDocument();
    });

    it('acknowledges a stop before the run has stopped', async () => {
      // FR-012, SC-005: the acknowledgement is the response to the stop request — never the
      // terminal `state` event, which can be a long way off. A control that waited for the run
      // would leave the person pressing Stop again, wondering if it took.
      const user = userEvent.setup();
      const stream = liveStream();

      server.use(...runHandlers(() => stream.response()), cancelHandler());

      renderPage();
      await ask(user, 'go');

      await user.click(await screen.findByRole('button', { name: 'Stop' }));

      expect(await screen.findByRole('button', { name: /stopping/i })).toBeDisabled();

      // And the run has not stopped: it is still reporting itself as running, which is exactly
      // the gap the acknowledgement exists to fill.
      expect(screen.getAllByText('Building').length).toBeGreaterThan(0);
    });

    it('settles on cancelled when the run confirms', async () => {
      const user = userEvent.setup();
      const stream = liveStream();

      server.use(...runHandlers(() => stream.response()), cancelHandler());

      renderPage();
      await ask(user, 'go');
      await user.click(await screen.findByRole('button', { name: 'Stop' }));
      await screen.findByRole('button', { name: /stopping/i });

      // The run's own word that it has stopped, which is the only thing that ends the wait.
      stream.send(frame(state(1, 'cancelled')));

      await waitFor(() => {
        expect(screen.getAllByText('Asleep').length).toBeGreaterThan(0);
      });

      expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    });

    it('offers no stop control for a finished run', async () => {
      // FR-013. The run came back already ended — a refusal, or work that turned out to be
      // nothing — so there was never anything to stop, and the composer offers Send instead.
      const user = userEvent.setup();
      let opened = 0;

      server.use(
        http.post(RUNS, () =>
          HttpResponse.json({ ...aRun, endedAt: '2026-08-18T10:00:02.000Z', status: 'succeeded' }),
        ),
        http.get(`${RUNS}/${RUN_ID}`, () =>
          HttpResponse.json({ ...aRun, endedAt: '2026-08-18T10:00:02.000Z', status: 'succeeded' }),
        ),
        http.get(`${RUNS}/${RUN_ID}/stream`, () => {
          opened += 1;

          return sse([]);
        }),
      );

      renderPage();
      await ask(user, 'go');

      await waitFor(() => {
        expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
      });

      expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      // FR-014 alongside it: nothing was opened for a run that had already ended.
      expect(opened).toBe(0);
    });

    it('reopens a finished run named in the address', async () => {
      // SC-006 through the screen: the run came from `?run=`, its transcript from the store, and
      // no stream was opened for it — `onUnhandledRequest: 'error'` is the assertion for the last
      // of those, since no stream handler is registered here.
      server.use(
        http.get(`${RUNS}/${RUN_ID}`, () =>
          HttpResponse.json({
            ...aRun,
            endedAt: '2026-08-18T10:05:00.000Z',
            lastSeq: 2,
            status: 'succeeded',
          }),
        ),
        http.get(`${RUNS}/${RUN_ID}/events`, () =>
          HttpResponse.json({
            events: [patch(1, 'src/rota.ts'), patch(2, 'src/swap.ts')],
            lastSeq: 2,
          }),
        ),
      );

      renderPage(RUN_ID);

      const log = screen.getByRole('log', { name: 'Conversation' });

      // Two file changes in a row are one work group, summarised until opened (spec 043).
      await userEvent
        .setup()
        .click(await within(log).findByRole('button', { name: /Edited 2 files/ }));
      expect(within(log).getByText(/src\/rota\.ts/)).toBeVisible();
      expect(within(log).getByText(/src\/swap\.ts/)).toBeVisible();
      expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    });

    /**
     * Every console action, refused.
     *
     * A different slug per action on purpose: what is asserted is that the sentence came from the
     * shared catalogue, and three different sentences cannot all be a hard-coded string in this
     * feature. This spec writes no sentence of its own and adds no slug — the catalogue is already
     * exhaustive by type, and R7 checked that rather than assuming it.
     */
    it.each<{
      action: string;
      provoke: (user: ReturnType<typeof userEvent.setup>) => Promise<void> | void;
      sentence: string;
    }>([
      {
        action: 'create',
        sentence: 'Too many attempts. Please wait a moment and try again.',
        provoke: async (user: ReturnType<typeof userEvent.setup>) => {
          server.use(http.post(RUNS, () => problemResponse('rate-limited', 429)));
          await ask(user, 'go');
        },
      },
      {
        action: 'cancel',
        sentence: 'That conflicts with something that already exists.',
        provoke: async (user: ReturnType<typeof userEvent.setup>) => {
          server.use(
            ...runHandlers(() => sse([])),
            http.post(`${RUNS}/${RUN_ID}/cancel`, () => problemResponse('conflict', 409)),
          );
          await ask(user, 'go');
          await user.click(await screen.findByRole('button', { name: 'Stop' }));
        },
      },
      {
        action: 'history',
        sentence: 'You do not have permission to do this. Ask an administrator for access.',
        provoke: () => {
          server.use(
            http.get(`${RUNS}/${RUN_ID}`, () =>
              HttpResponse.json({
                ...aRun,
                endedAt: '2026-08-18T10:05:00.000Z',
                lastSeq: 2,
                status: 'succeeded',
              }),
            ),
            http.get(`${RUNS}/${RUN_ID}/events`, () => problemResponse('permission-denied', 403)),
          );
          renderPage(RUN_ID);
        },
      },
    ])(
      'renders the catalogue sentence for a refusal from any console action ($action)',
      async ({ provoke, sentence }) => {
        const user = userEvent.setup();

        if (screen.queryByRole('log', { name: 'Conversation' }) === null) {
          renderPage();
        }

        await provoke(user);

        expect(await screen.findByText(sentence)).toBeVisible();
      },
    );

    it('routes an expired session to sign in rather than showing a stream failure', async () => {
      // FR-023. The session ending mid-run is not this screen's incident to report: `unauthorized`
      // means one thing in this API, and the application's own reaction to it — drop the session,
      // and `RequireAuth` redirects on the next render — lives on the query client for exactly
      // that reason. So this renders against that client and the real guard, and asserts where
      // the person ends up rather than what the console said on the way.
      server.use(http.get(`${RUNS}/${RUN_ID}`, () => problemResponse('unauthorized', 401)));

      renderScreen(
        <RequireAuth>
          <ProjectPage />
        </RequireAuth>,
        {
          client: createQueryClient(),
          path: `/projects/${PROJECT_ID}?run=${RUN_ID}`,
          route: '/projects/:projectId',
          routes: { [routes.signIn]: <h1>Welcome back</h1> },
        },
      );

      expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible();
      expect(screen.queryByRole('log', { name: 'Conversation' })).not.toBeInTheDocument();
    });

    it('tells you at a glance whether a run is live or no longer being received', async () => {
      // SC-004. The two states a stalled transcript could be confused between: one is receiving
      // and one is not, and they look identical if the screen only shows the events.
      const user = userEvent.setup();
      let opened = 0;

      server.use(
        ...runHandlers(() => {
          opened += 1;

          // The first connection opens and drops; every reconnect after it fails.
          return opened === 1
            ? sse([frame(patch(1, 'src/rota.ts'))], { closeAfter: true, retryMs: 5 })
            : HttpResponse.error();
        }),
      );

      renderPage();
      await ask(user, 'go');

      const connection = await screen.findByRole('region', { name: 'Connection' });

      expect(await within(connection).findByText('Not receiving updates')).toBeVisible();
      // And an offer of the one thing that can be done about it.
      expect(within(connection).getByRole('button', { name: /try again/i })).toBeVisible();
    });

    it('renders no sample content on any surface', async () => {
      /*
       * SC-007, asserted two ways, because the screen alone cannot prove it.
       *
       * The first is structural: no module under `features/project/` may import the sample-data
       * modules. They are deleted, so an import would already fail the build — this catches the
       * other direction, someone reintroducing one, and states the rule where a person reading
       * the tests will meet it (FR-027).
       *
       * The second is behavioural: a run that reported nothing leaves every surface saying it has
       * nothing, rather than showing what a run might have done.
       */
      const modules: Record<string, string> = import.meta.glob('../**/*.{ts,tsx}', {
        eager: true,
        import: 'default',
        query: '?raw',
      });

      const offenders = Object.entries(modules)
        .filter(([path]) => !path.endsWith('project-page.test.tsx'))
        .filter(([, source]) => /from '.*(mock-data|run-scenarios)'/.test(source))
        .map(([path]) => path);

      expect(offenders).toEqual([]);
      expect(Object.keys(modules).length).toBeGreaterThan(10);

      // A run that reported nothing at all: it started, and said nothing else.
      const user = userEvent.setup();

      server.use(...runHandlers(() => sse([])));
      renderPage();
      await ask(user, 'go');

      await waitFor(() => {
        expect(screen.getAllByText('Building').length).toBeGreaterThan(0);
      });

      expect(screen.getAllByText('No preview yet').length).toBeGreaterThan(0);
      expect(screen.getByText(/Nothing yet/)).toBeVisible();

      await user.click(stageTab(/Git/));

      expect(screen.getByText('Nothing has changed yet')).toBeVisible();
    });

    it('starts and streams nothing until somebody asks it to', async () => {
      // `onUnhandledRequest: 'error'` is the assertion: no run handlers are registered, so a
      // console that created or opened a run on mount fails here rather than in production.
      renderPage();

      expect(await screen.findByLabelText(/ask baios for a change/i)).toBeVisible();
      expect(screen.queryByText('claude-opus-5')).not.toBeInTheDocument();
    });
  });

  describe('the Domains button (spec 028 US5)', () => {
    const deployable = http.get(`${API}/orgs/:orgId/projects/:projectId/site`, () =>
      HttpResponse.json({
        site: { currentDeploymentId: null, deployable: true, offline: false, url: null },
      }),
    );

    it('sits beside Deploy/Site for a project:read holder on a deployable project', async () => {
      server.use(deployable);
      renderPage();

      expect(await screen.findByRole('button', { name: 'Domains' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Site' })).toBeVisible();
    });

    it('opens the domains panel', async () => {
      const user = userEvent.setup();

      server.use(
        deployable,
        http.get(`${API}/orgs/:orgId/projects/:projectId/domains`, () =>
          HttpResponse.json({ canManage: false, items: [] }),
        ),
      );
      renderPage();

      await user.click(await screen.findByRole('button', { name: 'Domains' }));

      expect(await screen.findByText('No custom domains yet.')).toBeVisible();
    });

    it('opens the domains panel on arrival from a mail link (?panel=domains)', async () => {
      const user = userEvent.setup();

      server.use(
        deployable,
        http.get(`${API}/orgs/:orgId/projects/:projectId/domains`, () =>
          HttpResponse.json({ canManage: false, items: [] }),
        ),
      );
      // The shape `projectDomainsUrl` in the api's mail links builds (spec 028 R14).
      renderScreen(<ProjectPage />, {
        path: `/projects/${PROJECT_ID}?panel=domains`,
        route: '/projects/:projectId',
      });

      expect(await screen.findByText('No custom domains yet.')).toBeVisible();
      // The open sheet is modal, so the button behind it is hidden from the accessibility tree.
      expect(screen.getByRole('button', { hidden: true, name: 'Domains' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );

      // Closing it drops the parameter, so it stays closed rather than reopening at once.
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByText('No custom domains yet.')).not.toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'Domains' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    it('does not open the domains panel from ?panel=domains where Domains is not offered', async () => {
      renderScreen(<ProjectPage />, {
        path: `/projects/${PROJECT_ID}?panel=domains`,
        route: '/projects/:projectId',
      });

      expect(await screen.findByRole('button', { name: 'Site' })).toBeVisible();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('is not offered on a project that cannot be deployed', async () => {
      renderPage();

      expect(await screen.findByRole('button', { name: 'Site' })).toBeVisible();
      // Let the site read settle before asserting the absence.
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Domains' })).not.toBeInTheDocument();
      });
    });
  });
});

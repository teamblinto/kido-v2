import type {
  Checkpoint,
  CheckpointDiffFile,
  CheckpointDiffResponse,
  RepoLink,
} from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { GitHistory } from './git-history';
import { StageGit } from './stage-git';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '8f14e45f-ceea-4b73-a5f1-0d1a4e2f9c11';
const RUN_ID = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const USER_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';

const BASE = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}`;

const BASELINE = '11111111-1111-4111-8111-111111111111';
const TURN_ONE = '22222222-2222-4222-8222-222222222222';
const TURN_TWO = '33333333-3333-4333-8333-333333333333';
const PULL = '44444444-4444-4444-8444-444444444444';
const REVERT = '55555555-5555-4555-8555-555555555555';
const EDIT = '66666666-6666-4666-8666-666666666666';

function sha(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

function checkpoint(over: Partial<Checkpoint> & Pick<Checkpoint, 'id' | 'kind'>): Checkpoint {
  return {
    actorId: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    files: [],
    gitSha: sha('a'),
    label: 'A saved point',
    mirroredAt: null,
    parentId: null,
    revertsId: null,
    runId: null,
    turn: null,
    ...over,
  };
}

/** Newest first, the order the endpoint answers in. */
const BASELINE_ROW = checkpoint({
  gitSha: sha('b'),
  id: BASELINE,
  kind: 'baseline',
  label: 'Project created',
});

const TURN_ONE_ROW = checkpoint({
  files: [{ bytes: 120, path: 'src/rota.ts', status: 'M' }],
  gitSha: sha('c'),
  id: TURN_ONE,
  kind: 'turn',
  label: 'Turn 1',
  parentId: BASELINE,
  runId: RUN_ID,
  turn: 1,
});

const TURN_TWO_ROW = checkpoint({
  files: [
    { bytes: 90, path: 'src/app.tsx', status: 'M' },
    { bytes: 4096, path: 'public/logo.png', status: 'A' },
  ],
  gitSha: sha('d'),
  id: TURN_TWO,
  kind: 'turn',
  label: 'Turn 2',
  parentId: TURN_ONE,
  runId: RUN_ID,
  turn: 2,
});

const PATCH = [
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
].join('\n');

function diff(id: string, files: readonly CheckpointDiffFile[]): CheckpointDiffResponse {
  return { checkpointId: id, files: [...files], parentId: BASELINE };
}

const DIFFS: Record<string, CheckpointDiffResponse> = {
  [TURN_ONE]: diff(TURN_ONE, [
    { binary: false, patch: PATCH, path: 'src/rota.ts', status: 'M', truncated: false },
  ]),
  [TURN_TWO]: diff(TURN_TWO, [
    { binary: false, patch: PATCH, path: 'src/app.tsx', status: 'M', truncated: true },
    { binary: true, bytes: 4096, path: 'public/logo.png', status: 'A' },
  ]),
  // A hand edit's diff is the same shape as a turn's, from the same endpoint (FR-010).
  [EDIT]: diff(EDIT, [
    { binary: false, patch: PATCH, path: 'src/rota.ts', status: 'M', truncated: false },
  ]),
};

/** The list handler, over a page the test can swap mid-flight. */
let page: Checkpoint[] = [];

function historyHandlers() {
  return [
    http.get(`${BASE}/checkpoints`, () => HttpResponse.json({ items: page, nextCursor: null })),
    http.get(`${BASE}/checkpoints/:checkpointId/diff`, ({ params }) => {
      const answer = DIFFS[String(params.checkpointId)];

      return answer === undefined ? problemResponse('not-found', 404) : HttpResponse.json(answer);
    }),
  ];
}

/** Everything `StageGit` asks for besides the history: the project and the GitHub panel. */
function stageHandlers(permissions: readonly string[]) {
  return [
    http.get(`${API}/orgs/:orgId/projects/:projectId`, () =>
      HttpResponse.json({
        project: {
          createdAt: '2026-08-18T09:00:00.000Z',
          id: PROJECT_ID,
          name: 'On-call rota dashboard',
          permissions: [...permissions],
        },
      }),
    ),
    http.get(`${API}/orgs/:orgId/connectors`, () => HttpResponse.json({ connections: [] })),
    http.get(`${BASE}/repo-link`, () => HttpResponse.json(null)),
  ];
}

/** The row headings, newest first — what the list is actually ordered as. */
function rowLabels(): string[] {
  return screen.getAllByRole('button', { expanded: false }).map((row) => {
    const heading = row.querySelector('span');

    return heading?.textContent ?? '';
  });
}

function renderHistory() {
  return renderScreen(<GitHistory orgId={ORG_ID} projectId={PROJECT_ID} />);
}

/**
 * The Code stage's open file, standing in for the whole of it.
 *
 * FR-011's second half is about a cache key, not about a pane: `useRevert` invalidates `['file']`,
 * and this counts what that does to a mounted reader of that key.
 */
function OpenFile({ onFetch }: { onFetch: () => void }): React.JSX.Element | null {
  useQuery({
    queryFn: () => {
      onFetch();

      return Promise.resolve('const a = 1;');
    },
    queryKey: ['file', ORG_ID, PROJECT_ID, 'src/rota.ts'],
  });

  return null;
}

function renderStage(
  permissions: readonly string[],
  isRunActive = false,
  extra: React.ReactNode = null,
) {
  server.use(...stageHandlers(permissions), ...historyHandlers());

  return renderScreen(
    <>
      <StageGit
        isRunActive={isRunActive}
        onChangeView={vi.fn()}
        orgId={ORG_ID}
        paths={[]}
        projectId={PROJECT_ID}
        view="history"
      />
      {extra}
    </>,
    { path: '/p' },
  );
}

describe('GitHistory', () => {
  beforeEach(() => {
    page = [TURN_TWO_ROW, TURN_ONE_ROW, BASELINE_ROW];
    server.use(...historyHandlers());
  });

  it('SC-003: lists baseline, turn, turn newest first and the middle diff names exactly the API’s files', async () => {
    const user = userEvent.setup();
    renderHistory();

    expect(await screen.findByText('Run turn 2')).toBeVisible();
    expect(rowLabels()).toEqual(['Run turn 2', 'Run turn 1', 'Starting point']);

    // The middle row, whose diff names one file and only one.
    await user.click(screen.getByText('Run turn 1'));

    const patch = await screen.findByRole('region', { name: 'src/rota.ts' });

    expect(within(patch).getByText('Changed')).toBeVisible();
    expect(screen.getAllByRole('region').map((file) => file.getAttribute('aria-label'))).toEqual(
      DIFFS[TURN_ONE]?.files.map((file) => file.path),
    );
  });

  it('FR-009/FR-010/SC-006: an edit row has its own label, names the member, and opens like a turn', async () => {
    const user = userEvent.setup();
    const edited = checkpoint({
      actorId: USER_ID,
      files: [{ bytes: 120, path: 'src/rota.ts', status: 'M' }],
      gitSha: sha('e'),
      id: EDIT,
      kind: 'edit',
      // What the API builds. The row must not show it raw.
      label: 'Edit src/rota.ts',
      parentId: TURN_TWO,
    });

    page = [edited, TURN_TWO_ROW, TURN_ONE_ROW, BASELINE_ROW];
    renderHistory();

    // Its own wording, beside a turn's, a revert's and a pull's — not the server's label.
    expect(await screen.findByText('Edited src/rota.ts')).toBeVisible();
    expect(screen.queryByText('Edit src/rota.ts')).not.toBeInTheDocument();
    expect(rowLabels()).toEqual([
      'Edited src/rota.ts',
      'Run turn 2',
      'Run turn 1',
      'Starting point',
    ]);

    // A member, not a run, and the same file count line every other kind gets.
    const row = screen.getByText('Edited src/rota.ts').closest('button');

    expect(within(row!).getByText(/By a member/)).toBeVisible();
    expect(within(row!).getByText(/1 file/)).toBeVisible();

    // And the diff opens with no special case: the same regions, in the same shape, as a turn's.
    await user.click(screen.getByText('Edited src/rota.ts'));

    const patch = await screen.findByRole('region', { name: 'src/rota.ts' });

    expect(within(patch).getByText('Changed')).toBeVisible();
    expect(patch.querySelector('[data-kind="remove"]')?.textContent).toContain('-const b = 2;');
    expect(patch.querySelector('[data-kind="add"]')?.textContent).toContain('+const b = 3;');
    expect(screen.getAllByRole('region').map((file) => file.getAttribute('aria-label'))).toEqual(
      DIFFS[EDIT]?.files.map((file) => file.path),
    );
  });

  it('FR-008: a revert row names the checkpoint it went back to and a pull row says pulled', async () => {
    page = [
      checkpoint({
        actorId: USER_ID,
        gitSha: sha('e'),
        id: REVERT,
        kind: 'revert',
        label: 'Revert to Project created',
        revertsId: BASELINE,
      }),
      checkpoint({ gitSha: sha('f'), id: PULL, kind: 'pull', label: 'Pulled' }),
      BASELINE_ROW,
    ];

    renderHistory();

    // Named by the same words the target's own row uses, not by the server's label.
    expect(await screen.findByText('Went back to Starting point')).toBeVisible();
    expect(screen.queryByText('Went back to Revert to Project created')).not.toBeInTheDocument();
    expect(screen.getByText('Pulled from GitHub')).toBeVisible();
    expect(rowLabels()).toEqual([
      'Went back to Starting point',
      'Pulled from GitHub',
      'Starting point',
    ]);
  });

  it('FR-009: a truncated patch says so and a binary file shows size only', async () => {
    const user = userEvent.setup();
    renderHistory();

    await user.click(await screen.findByText('Run turn 2'));

    const text = await screen.findByRole('region', { name: 'src/app.tsx' });

    // The patch is shown, each changed line carrying its marker as well as its colour, and then
    // says where it stops.
    const removed = text.querySelector('[data-kind="remove"]');
    const added = text.querySelector('[data-kind="add"]');

    expect(removed?.textContent).toContain('-const b = 2;');
    expect(added?.textContent).toContain('+const b = 3;');
    expect(within(text).getByText('This patch was too large to show in full.')).toBeVisible();

    const binary = screen.getByRole('region', { name: 'public/logo.png' });

    expect(within(binary).getByText('Binary file — 4.0 KB')).toBeVisible();
    expect(within(binary).queryByText('@@ -1,3 +1,3 @@')).not.toBeInTheDocument();
  });

  it('FR-010: revert is not offered without project:files.write, and is disabled during a run', async () => {
    const readOnly = renderStage(['project:read']);

    expect(await screen.findByText('Run turn 2')).toBeVisible();
    // Not disabled — not rendered at all.
    expect(screen.queryByRole('button', { name: 'Revert to this point' })).not.toBeInTheDocument();
    readOnly.unmount();

    renderStage(['project:read', 'project:files.write'], true);

    // The head cannot be reverted to, so two rows of three offer the control.
    const controls = await screen.findAllByRole('button', { name: 'Revert to this point' });

    expect(controls).toHaveLength(2);
    await waitFor(() => {
      expect(controls[0]).toBeDisabled();
    });
    expect(screen.getAllByText('A run is active')[0]).toBeVisible();
  });

  it('FR-011: a completed revert adds a row at the head and refetches the open file', async () => {
    const user = userEvent.setup();
    const onFetch = vi.fn();
    const reverted = checkpoint({
      actorId: USER_ID,
      gitSha: sha('e'),
      id: REVERT,
      kind: 'revert',
      label: 'Revert to Project created',
      parentId: TURN_TWO,
      revertsId: BASELINE,
    });

    server.use(
      http.post(`${BASE}/checkpoints/${BASELINE}/revert`, () => {
        page = [reverted, ...page];

        return HttpResponse.json(reverted);
      }),
    );

    renderStage(['project:read', 'project:files.write'], false, <OpenFile onFetch={onFetch} />);

    expect(await screen.findByText('Starting point')).toBeVisible();
    await waitFor(() => {
      expect(onFetch).toHaveBeenCalledTimes(1);
    });

    // The baseline is the last row, and the last control belongs to it.
    const controls = screen.getAllByRole('button', { name: 'Revert to this point' });

    await user.click(controls[controls.length - 1]!);
    await user.click(await screen.findByRole('button', { name: /^Go back to/ }));

    expect(await screen.findByText('Went back to Starting point')).toBeVisible();
    expect(rowLabels()[0]).toBe('Went back to Starting point');
    await waitFor(() => {
      expect(onFetch).toHaveBeenCalledTimes(2);
    });
  });

  it('a refused revert shows the shared sentence and changes nothing', async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${BASE}/checkpoints/${BASELINE}/revert`, () => problemResponse('conflict', 409)),
    );

    renderStage(['project:read', 'project:files.write']);

    expect(await screen.findByText('Starting point')).toBeVisible();

    const controls = screen.getAllByRole('button', { name: 'Revert to this point' });

    await user.click(controls[controls.length - 1]!);
    await user.click(await screen.findByRole('button', { name: /^Go back to/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That conflicts with something that already exists.',
    );
    // The dialog stays open, so the decision can be retried or abandoned.
    expect(screen.getByRole('button', { name: /^Go back to/ })).toBeVisible();

    // And once it is abandoned the history is exactly as it was: no new head, no rows lost.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(rowLabels()).toEqual(['Run turn 2', 'Run turn 1', 'Starting point']);
  });
});

describe('GitHistory, spec 044', () => {
  const aLink: RepoLink = {
    autoSync: true,
    branch: 'main',
    connectionId: null,
    id: RUN_ID,
    lastPushedCheckpointId: TURN_ONE,
    linkedAt: '2026-08-18T10:00:00.000Z',
    linkedBy: { id: USER_ID, name: 'Ada' },
    position: 'ahead',
    remoteHeadSha: null,
    repository: { fullName: 'blinto-co/forge', id: 42, name: 'forge', owner: 'blinto-co' },
    sideBranch: null,
    state: 'linked',
  };

  function render(link?: RepoLink) {
    server.use(...historyHandlers());

    return renderScreen(<GitHistory link={link} orgId={ORG_ID} projectId={PROJECT_ID} />);
  }

  it('shows a turn or edit label a person wrote, and keeps the plain words otherwise', async () => {
    page = [
      checkpoint({ id: EDIT, kind: 'edit', label: 'Tidy the header' }),
      checkpoint({
        files: [{ bytes: 1, path: 'src/a.ts', status: 'M' }],
        id: PULL,
        kind: 'edit',
        label: 'Edit src/a.ts',
      }),
      checkpoint({ id: TURN_TWO, kind: 'turn', label: 'Add a dark mode (turn 2)', turn: 2 }),
      TURN_ONE_ROW,
    ];

    render();

    expect(await screen.findByText('Tidy the header')).toBeVisible();
    expect(rowLabels()).toEqual([
      'Tidy the header',
      'Edited src/a.ts',
      'Add a dark mode (turn 2)',
      'Run turn 1',
    ]);
  });

  it('marks rows at or older than the last pushed one, and links only those', async () => {
    page = [TURN_TWO_ROW, TURN_ONE_ROW, BASELINE_ROW];

    render(aLink);

    expect(await screen.findByText('ddddddd')).not.toHaveAttribute('href');
    expect(screen.getAllByText('· On GitHub')).toHaveLength(2);
    expect(screen.getAllByText('· Not pushed yet')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'ccccccc' })).toHaveAttribute(
      'href',
      `https://github.com/blinto-co/forge/commit/${sha('c')}`,
    );
    expect(screen.getByRole('link', { name: 'bbbbbbb' })).toBeVisible();
  });

  it('calls every row not pushed when the last pushed one is not loaded or never was', async () => {
    page = [TURN_TWO_ROW, TURN_ONE_ROW];

    render({ ...aLink, lastPushedCheckpointId: null });

    expect(await screen.findAllByText('· Not pushed yet')).toHaveLength(2);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the short sha and no GitHub marker on an unlinked project', async () => {
    page = [TURN_ONE_ROW];

    render();

    expect(await screen.findByText('ccccccc')).toBeVisible();
    expect(screen.queryByText(/On GitHub|Not pushed yet/u)).not.toBeInTheDocument();
  });
});

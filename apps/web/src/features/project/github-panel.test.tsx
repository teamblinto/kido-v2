import type { Connection, RepoLink, Repository, SyncOperation } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { GitHubPanel } from './github-panel';
import { GITHUB_AUTHORIZE_KEY, GITHUB_RETURN_KEY } from './lib/github-sync';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PROJECT = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}`;
const ACTOR = { id: ORG_ID, name: 'Rakibul' };

const aConnection: Connection = {
  account: { id: 9001, login: 'blinto-co', type: 'organization' },
  canCreateRepositories: true,
  circuitOpenUntil: null,
  connectedAt: '2026-09-20T10:00:00.000Z',
  connectedBy: ACTOR,
  credentialFingerprint: 'a1b2c3d4',
  health: 'healthy',
  id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastVerifiedAt: '2026-09-20T10:00:00.000Z',
  provider: 'github',
};

const aRepo: Repository = {
  defaultBranch: 'main',
  fullName: 'blinto-co/forge',
  id: 42,
  name: 'forge',
  owner: 'blinto-co',
  private: true,
};

const aLink: RepoLink = {
  autoSync: false,
  branch: 'main',
  connectionId: aConnection.id,
  id: '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e',
  lastPushedCheckpointId: null,
  linkedAt: '2026-09-21T08:00:00.000Z',
  linkedBy: ACTOR,
  position: 'ahead',
  remoteHeadSha: null,
  repository: { fullName: aRepo.fullName, id: aRepo.id, name: aRepo.name, owner: aRepo.owner },
  sideBranch: null,
  state: 'linked',
};

function anOperation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    commits: 0,
    createdAt: '2026-09-21T09:00:00.000Z',
    finishedAt: null,
    fromSha: null,
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'push',
    projectId: PROJECT_ID,
    reason: null,
    requestedBy: ACTOR,
    startedAt: null,
    state: 'queued',
    targetBranch: null,
    toSha: null,
    trigger: 'manual',
    ...overrides,
  };
}

function connectors(connection: Connection | null = aConnection) {
  return http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
    HttpResponse.json({ connections: connection === null ? [] : [connection] }),
  );
}

function render() {
  return renderScreen(<GitHubPanel orgId={ORG_ID} projectId={PROJECT_ID} />);
}

/** A healthy linked project, the starting point of everything the linked view does. */
function linkedHandlers({
  link = aLink,
  operations = [],
}: { link?: RepoLink; operations?: readonly SyncOperation[] } = {}) {
  server.use(
    connectors(),
    http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(link)),
    http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations })),
  );
}

const realLocation = window.location;

/** `location.assign` is unforgeable in jsdom, so the object is swapped as the settings test does. */
function stubLocation() {
  const assign = vi.fn();

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, assign },
  });

  return assign;
}

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  window.sessionStorage.clear();
});

/**
 * Spec 026 contracts § 4: the panel asks for the FR-016 warning whenever there is a link, so it
 * is answered here by default and overridden by the one test that is about it. Null is the
 * common answer — the chosen template and the repository usually agree.
 */
beforeEach(() => {
  server.use(
    http.get(`${PROJECT}/import-mismatch`, () => HttpResponse.json({ templateMismatch: null })),
    http.get(`${PROJECT}/repo-link/branches`, () =>
      HttpResponse.json({
        branches: [
          { default: true, name: 'main', protected: false },
          { default: false, name: 'release', protected: true },
        ],
      }),
    ),
  );
});

describe('GitHubPanel', () => {
  it('names the template the repository disagrees with, and blocks nothing (FR-016)', async () => {
    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.get(`${PROJECT}/import-mismatch`, () =>
        HttpResponse.json({ templateMismatch: { chosen: 'node-api', detected: ['python'] } }),
      ),
    );

    render();

    const line = await screen.findByTestId('template-mismatch');
    expect(line).toHaveTextContent('node-api');
    expect(line).toHaveTextContent('python');
    // Not an error, and nothing is disabled by it: push and pull are still offered.
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('says nothing when the chosen template and the repository agree', async () => {
    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
    );

    render();

    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(screen.queryByTestId('template-mismatch')).not.toBeInTheDocument();
  });

  it('creates a repository and links it when the connection allows it', async () => {
    let body: unknown;

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
      http.put(`${PROJECT}/repo-link`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json(aLink);
      }),
    );

    render();

    await userEvent.type(await screen.findByLabelText('Repository name'), 'forge');
    await userEvent.click(screen.getByRole('button', { name: 'Create and link' }));

    expect(await screen.findByRole('link', { name: 'blinto-co/forge' })).toBeInTheDocument();
    expect(body).toEqual({ create: { name: 'forge', private: true } });
    expect(screen.getByText('Ahead of GitHub')).toBeInTheDocument();
  });

  it('offers only Choose when the connection cannot create, filtering by name', async () => {
    let query: string | null = null;
    let body: unknown;

    server.use(
      connectors({ ...aConnection, canCreateRepositories: false }),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
      http.get(`${API}/orgs/${ORG_ID}/connectors/${aConnection.id}/repositories`, ({ request }) => {
        query = new URL(request.url).searchParams.get('query');

        return HttpResponse.json({ repositories: query === 'fo' ? [aRepo] : [] });
      }),
      http.put(`${PROJECT}/repo-link`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json(aLink);
      }),
    );

    render();

    expect(await screen.findByText('No repositories match.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create new' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Find a repository'), 'fo');
    await userEvent.click(await screen.findByRole('button', { name: 'Link blinto-co/forge' }));

    expect(await screen.findByRole('link', { name: 'blinto-co/forge' })).toBeInTheDocument();
    expect(body).toEqual({ existing: { repoId: 42 } });
  });

  it('pushes, then lists the last five operations with their reasons', async () => {
    const operations = Array.from({ length: 6 }, (_, i) =>
      anOperation({
        id: `11111111-1111-4111-8111-11111111111${String(i)}`,
        reason: i === 0 ? 'remote-ahead' : null,
        state: i === 0 ? 'failed' : 'succeeded',
      }),
    );
    let pushed = false;

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () =>
        HttpResponse.json({ ...aLink, position: pushed ? 'level' : 'ahead' }),
      ),
      http.get(`${PROJECT}/sync`, () =>
        HttpResponse.json({ operations: pushed ? operations : [] }),
      ),
      http.post(`${PROJECT}/sync/push`, () => {
        pushed = true;

        return HttpResponse.json(anOperation(), { status: 202 });
      }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    const list = await screen.findByRole('list', { name: 'Recent operations' });

    await waitFor(() => {
      expect(list.querySelectorAll('li')).toHaveLength(5);
    });
    expect(
      screen.getByText('The repository is ahead of the project. Pull first.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Level with GitHub')).toBeInTheDocument();
  });

  it('shows the refusal reason when a push is turned away', async () => {
    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.post(`${PROJECT}/sync/push`, () =>
        problemResponse('conflict', 409, { reason: 'nothing-to-push' }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(
      await screen.findByText('Nothing to push: the project has no checkpoint yet.'),
    ).toBeInTheDocument();
  });

  it('pulls, then labels the succeeded pull as pulled from GitHub', async () => {
    let pulled = false;

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () =>
        HttpResponse.json({ ...aLink, position: pulled ? 'level' : 'behind' }),
      ),
      http.get(`${PROJECT}/sync`, () =>
        HttpResponse.json({
          operations: pulled ? [anOperation({ commits: 2, kind: 'pull', state: 'succeeded' })] : [],
        }),
      ),
      http.post(`${PROJECT}/sync/pull`, () => {
        pulled = true;

        return HttpResponse.json(anOperation({ kind: 'pull' }), { status: 202 });
      }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Pull' }));

    expect(await screen.findByText('2 checkpoints pulled from GitHub')).toBeInTheDocument();
    expect(await screen.findByText('Level with GitHub')).toBeInTheDocument();
  });

  it('shows the connection state when a pull is refused for its health', async () => {
    const until = '2026-09-21T12:30:00.000Z';

    server.use(
      connectors({ ...aConnection, circuitOpenUntil: until, health: 'unavailable' }),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.post(`${PROJECT}/sync/pull`, () =>
        problemResponse('service-unavailable', 503, { reason: 'provider-unavailable' }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Pull' }));

    expect(
      await screen.findByText('GitHub is unavailable right now. Try again later.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('connection-state')).toHaveTextContent(
      `Connection: unavailable until ${new Date(until).toLocaleString()}`,
    );
  });

  it('shows the connection needs reconnecting when a push is refused for it', async () => {
    server.use(
      connectors({ ...aConnection, health: 'needs_reauth' }),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.post(`${PROJECT}/sync/push`, () =>
        problemResponse('conflict', 409, { reason: 'needs-reauth' }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(await screen.findByTestId('connection-state')).toHaveTextContent(
      'Connection: needs reconnecting',
    );
  });

  it('unlinks after a confirm that says the repository on GitHub is not changed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let deleted = false;

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(deleted ? null : aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.delete(`${PROJECT}/repo-link`, () => {
        deleted = true;

        return new HttpResponse(null, { status: 204 });
      }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

    expect(confirm.mock.calls[0]?.[0]).toContain('The repository on GitHub is not changed.');
    expect(await screen.findByLabelText('Repository name')).toBeInTheDocument();
    expect(deleted).toBe(true);
    confirm.mockRestore();
  });

  it('keeps the link when the confirm is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.delete(`${PROJECT}/repo-link`, () => problemResponse('conflict', 409)),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));

    expect(screen.getByRole('link', { name: 'blinto-co/forge' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it('disables Push and Pull on a disconnected link and says to reconnect the organisation', async () => {
    server.use(
      connectors(null),
      http.get(`${PROJECT}/repo-link`, () =>
        HttpResponse.json({ ...aLink, connectionId: null, state: 'disconnected' }),
      ),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
    );

    render();

    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/reconnect the organisation's GitHub/iu);
  });

  /**
   * Spec 026 US3 (SC-010): a push at GitHub refreshed the link's head and nothing else. The panel
   * says so, names the commit, and offers the pull — which is the only thing a delivery may not do
   * for itself (FR-034).
   */
  it('says the remote is ahead, names the commit, and offers the pull', async () => {
    const remote = 'ab34cd7891011121314151617181920212223242';
    let pulls = 0;

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () =>
        HttpResponse.json({ ...aLink, position: 'behind', remoteHeadSha: remote }),
      ),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.get(`${PROJECT}/import-mismatch`, () => HttpResponse.json({ templateMismatch: null })),
      http.post(`${PROJECT}/sync/pull`, () => {
        pulls += 1;

        return HttpResponse.json(anOperation({ kind: 'pull' }), { status: 202 });
      }),
    );

    render();

    const notice = await screen.findByTestId('remote-ahead');

    // The commit is named — the whole point of reading the refreshed head rather than a mood.
    expect(notice).toHaveTextContent('The repository is ahead of the project at ab34cd7.');

    await userEvent.click(screen.getByRole('button', { name: 'Pull from GitHub' }));

    // The delivery never pulls (FR-034); the notice is where a person does.
    await waitFor(() => {
      expect(pulls).toBe(1);
    });
  });

  it('does not claim the remote is ahead when no head has ever been seen', async () => {
    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () =>
        HttpResponse.json({ ...aLink, position: 'unknown', remoteHeadSha: null }),
      ),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
      http.get(`${PROJECT}/import-mismatch`, () => HttpResponse.json({ templateMismatch: null })),
    );

    render();

    expect(await screen.findByText('Not synced yet')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-ahead')).not.toBeInTheDocument();
  });

  it('offers one Connect GitHub button that remembers the project and goes to the install', async () => {
    const assign = stubLocation();

    server.use(
      connectors(null),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/install`, () =>
        HttpResponse.json({ installUrl: 'https://github.com/apps/kido/installations/new' }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://github.com/apps/kido/installations/new');
    });
    expect(window.sessionStorage.getItem(GITHUB_RETURN_KEY)).toBe(
      `/projects/${PROJECT_ID}?panel=github`,
    );
  });

  it('prefills a slug of the project name, Private on', async () => {
    let body: unknown;

    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
      http.put(`${PROJECT}/repo-link`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json(aLink);
      }),
    );

    renderScreen(
      <GitHubPanel orgId={ORG_ID} projectId={PROJECT_ID} projectName="On-call Rota: v2!" />,
    );

    expect(await screen.findByLabelText('Repository name')).toHaveValue('on-call-rota-v2');
    await userEvent.click(screen.getByRole('button', { name: 'Create and link' }));

    await waitFor(() => {
      expect(body).toEqual({ create: { name: 'on-call-rota-v2', private: true } });
    });
  });

  it('sends a personal create through GitHub, remembering the project', async () => {
    const assign = stubLocation();
    const authorizeUrl = 'https://github.com/login/oauth/authorize?client_id=x';
    let body: unknown;

    server.use(
      connectors({ ...aConnection, account: { ...aConnection.account, type: 'user' } }),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
      http.post(`${PROJECT}/repo-link/authorize`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ authorizeUrl });
      }),
    );

    render();

    await userEvent.type(await screen.findByLabelText('Repository name'), 'forge');
    await userEvent.click(screen.getByRole('button', { name: 'Continue on GitHub' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(authorizeUrl);
    });
    expect(body).toEqual({ name: 'forge', private: true });
    expect(JSON.parse(window.sessionStorage.getItem(GITHUB_AUTHORIZE_KEY) ?? '')).toEqual({
      projectId: PROJECT_ID,
      returnTo: `/projects/${PROJECT_ID}?panel=github`,
    });
  });

  it('says why a personal connection that cannot create has only Choose', async () => {
    server.use(
      connectors({
        ...aConnection,
        account: { ...aConnection.account, type: 'user' },
        canCreateRepositories: false,
      }),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
      http.get(`${API}/orgs/${ORG_ID}/connectors/${aConnection.id}/repositories`, () =>
        HttpResponse.json({ repositories: [] }),
      ),
    );

    render();

    expect(
      await screen.findByText(
        'This connection cannot create repositories. Choose an existing one.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Repository name')).not.toBeInTheDocument();
  });

  it('switches branch from the picker, showing the default and protected markers', async () => {
    const user = userEvent.setup();
    let body: unknown;

    linkedHandlers();
    server.use(
      http.patch(`${PROJECT}/repo-link`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ ...aLink, branch: 'release' });
      }),
    );

    render();

    const picker = await screen.findByRole('combobox', { name: 'Branch' });

    expect(
      screen.getByText("Switching changes where pushes go, not the project's files."),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(picker).toBeEnabled();
    });
    picker.focus();
    await user.keyboard('{Enter}');

    // Radix names an option by its text alone, so the markers are read from the row.
    expect(await screen.findByRole('option', { name: 'main' })).toHaveTextContent('Default');

    const release = await screen.findByRole('option', { name: 'release' });

    expect(release).toHaveTextContent('Protected');
    await user.click(release);

    await waitFor(() => {
      expect(body).toEqual({ branch: 'release' });
    });
  });

  it('creates a new branch, refusing a name git would not take', async () => {
    const user = userEvent.setup();
    let body: unknown;

    linkedHandlers();
    server.use(
      http.post(`${PROJECT}/repo-link/branches`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ ...aLink, branch: 'draft' });
      }),
    );

    render();

    await user.click(await screen.findByRole('button', { name: 'New branch' }));
    await user.type(screen.getByLabelText('New branch name'), 'bad..name');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    await user.clear(screen.getByLabelText('New branch name'));
    await user.type(screen.getByLabelText('New branch name'), 'draft');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(body).toEqual({ name: 'draft' });
    });
  });

  it('locks the branch controls during a run and says why', async () => {
    linkedHandlers();

    renderScreen(<GitHubPanel isRunActive orgId={ORG_ID} projectId={PROJECT_ID} />);

    expect(await screen.findByRole('combobox', { name: 'Branch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New branch' })).toBeDisabled();
    expect(screen.getByText('Branches can change once the run finishes.')).toBeInTheDocument();
  });

  it('locks the branch controls during an operation and says why', async () => {
    linkedHandlers({ operations: [anOperation({ state: 'running' })] });

    render();

    expect(
      await screen.findByText('Branches can change once this sync finishes.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Branch' })).toBeDisabled();
  });

  it('turns auto-sync on with a PATCH', async () => {
    let body: unknown;
    let link = aLink;

    linkedHandlers();
    server.use(
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(link)),
      http.patch(`${PROJECT}/repo-link`, async ({ request }) => {
        body = await request.json();
        link = { ...aLink, autoSync: true };

        return HttpResponse.json(link);
      }),
    );

    render();

    const toggle = await screen.findByRole('switch', { name: 'Push after every turn' });

    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    expect(body).toEqual({ autoSync: true });
  });

  describe('Commit & push', () => {
    const CHECKPOINT = '22222222-2222-4222-8222-222222222222';

    async function commitWith(
      answer: { checkpointId: string | null; operation: SyncOperation | null },
      message?: string,
    ): Promise<unknown> {
      let body: unknown;

      linkedHandlers();
      server.use(
        http.post(`${PROJECT}/sync/commit`, async ({ request }) => {
          body = await request.json();

          return HttpResponse.json(answer);
        }),
      );

      render();

      const field = await screen.findByLabelText('Commit message (optional)');

      if (message !== undefined) await userEvent.type(field, message);
      await userEvent.click(screen.getByRole('button', { name: 'Commit & push' }));
      await waitFor(() => {
        expect(body).toBeDefined();
      });

      return body;
    }

    it('says nothing new to commit when nothing was committed or pushed', async () => {
      expect(await commitWith({ checkpointId: null, operation: null })).toEqual({});
      expect(await screen.findByText('Nothing new to commit')).toBeInTheDocument();
    });

    it('says the save rides on the sync in progress when the slot was taken', async () => {
      await commitWith({ checkpointId: CHECKPOINT, operation: null });

      expect(
        await screen.findByText('Saved; it will go out with the sync in progress'),
      ).toBeInTheDocument();
    });

    it('sends the message and says the push is on its way', async () => {
      const body = await commitWith(
        { checkpointId: CHECKPOINT, operation: anOperation() },
        'Tidy the header',
      );

      expect(body).toEqual({ message: 'Tidy the header' });
      expect(await screen.findByText('On its way to GitHub.')).toBeInTheDocument();
    });
  });

  it('explains the side branch calmly, links the comparison, and keeps Pull', async () => {
    linkedHandlers({ link: { ...aLink, position: 'diverged', sideBranch: 'kido-sync' } });

    render();

    const notice = await screen.findByTestId('side-branch');

    expect(notice).toHaveTextContent(
      "The linked branch couldn't take your latest work, so it was saved to kido-sync. Nothing was overwritten.",
    );
    expect(notice).toHaveTextContent('Merge it on GitHub, then pull.');
    expect(notice).toHaveAttribute('role', 'status');
    expect(within(notice).getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/blinto-co/forge/compare/main...kido-sync',
    );
    expect(screen.getByRole('button', { name: 'Pull' })).toBeEnabled();
  });

  it('words an automatic push apart from a person, with branch, range and count', async () => {
    const from = 'a'.repeat(40);
    const to = 'b'.repeat(40);

    linkedHandlers({
      operations: [
        anOperation({
          commits: 2,
          finishedAt: '2026-09-21T09:01:00.000Z',
          fromSha: from,
          id: '11111111-1111-4111-8111-111111111112',
          state: 'succeeded',
          targetBranch: 'kido-sync',
          toSha: to,
          trigger: 'auto',
        }),
        anOperation({ state: 'succeeded', targetBranch: 'main', toSha: to, trigger: 'manual' }),
      ],
    });

    render();

    const rows = within(
      await screen.findByRole('list', { name: 'Recent operations' }),
    ).getAllByRole('listitem');

    expect(rows[0]).toHaveTextContent('Pushed automatically after a turn');
    expect(rows[0]).not.toHaveTextContent('Rakibul');
    expect(rows[0]).toHaveTextContent('to kido-sync');
    expect(rows[0]).toHaveTextContent('2 commits');
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute(
      'href',
      `https://github.com/blinto-co/forge/compare/${from}...${to}`,
    );
    expect(rows[1]).toHaveTextContent('Push by Rakibul');
    expect(rows[1]).not.toHaveTextContent('to main');
    expect(within(rows[1]!).getByRole('link')).toHaveAttribute(
      'href',
      `https://github.com/blinto-co/forge/commit/${to}`,
    );
  });

  it('says what was last pushed in a short sha, never the checkpoint id', async () => {
    const to = 'b'.repeat(40);

    linkedHandlers({
      link: { ...aLink, lastPushedCheckpointId: '22222222-2222-4222-8222-222222222222' },
      operations: [anOperation({ state: 'succeeded', toSha: to })],
    });

    render();

    expect(await screen.findByText(/Last pushed/u)).toHaveTextContent(/Last pushed bbbbbbb/u);
    expect(screen.queryByText(/22222222/u)).not.toBeInTheDocument();
  });

  it('offers a way to reconnect when the connector was removed', async () => {
    const assign = stubLocation();

    linkedHandlers({ link: { ...aLink, connectionId: null, state: 'disconnected' } });
    server.use(
      connectors(null),
      http.post(`${API}/orgs/${ORG_ID}/connectors/github/install`, () =>
        HttpResponse.json({ installUrl: 'https://github.com/apps/kido/installations/new' }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect GitHub' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
  });

  it('offers a way to reconnect before anything is refused when the connection needs it', async () => {
    linkedHandlers();
    server.use(connectors({ ...aConnection, health: 'needs_reauth' }));

    render();

    expect(await screen.findByRole('button', { name: 'Reconnect GitHub' })).toBeEnabled();
  });

  it.each([
    ['branch-protected', 'That branch is protected on GitHub, so it refused the push.'],
    ['push-rejected', 'GitHub refused the push, usually a large file or a secret in the code.'],
    ['workflow-permission', /Workflows permission/u],
    ['repo-gone', /gone from GitHub/u],
    ['account-mismatch', /not the one connected here/u],
  ] as const)('words the %s reason', async (reason, copy) => {
    linkedHandlers();
    server.use(
      http.post(`${PROJECT}/sync/push`, () => problemResponse('conflict', 409, { reason })),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it('forgets an old refusal once something newer has been tried', async () => {
    linkedHandlers();
    server.use(
      http.post(`${PROJECT}/sync/push`, () =>
        problemResponse('conflict', 409, { reason: 'nothing-to-push' }),
      ),
      http.post(`${PROJECT}/sync/pull`, () =>
        HttpResponse.json(anOperation({ kind: 'pull' }), { status: 202 }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pull' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});

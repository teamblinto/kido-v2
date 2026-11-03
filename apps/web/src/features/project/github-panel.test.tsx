import type { Connection, RepoLink, Repository, SyncOperation } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { GitHubPanel } from './github-panel';

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
  branch: 'main',
  connectionId: aConnection.id,
  id: '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e',
  lastPushedCheckpointId: null,
  linkedAt: '2026-09-21T08:00:00.000Z',
  linkedBy: ACTOR,
  position: 'ahead',
  remoteHeadSha: null,
  repository: { fullName: aRepo.fullName, id: aRepo.id, name: aRepo.name, owner: aRepo.owner },
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
    toSha: null,
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

/**
 * Spec 026 contracts § 4: the panel asks for the FR-016 warning whenever there is a link, so it
 * is answered here by default and overridden by the one test that is about it. Null is the
 * common answer — the chosen template and the repository usually agree.
 */
beforeEach(() => {
  server.use(
    http.get(`${PROJECT}/import-mismatch`, () => HttpResponse.json({ templateMismatch: null })),
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
    expect(screen.getByRole('button', { name: /push/i })).toBeEnabled();
  });

  it('says nothing when the chosen template and the repository agree', async () => {
    server.use(
      connectors(),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(aLink)),
      http.get(`${PROJECT}/sync`, () => HttpResponse.json({ operations: [] })),
    );

    render();

    expect(await screen.findByRole('button', { name: /push/i })).toBeInTheDocument();
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

    expect(await screen.findByText('blinto-co/forge · main')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Find a repository'), 'fo');
    await userEvent.click(await screen.findByRole('button', { name: 'Link blinto-co/forge' }));

    expect(await screen.findByText('blinto-co/forge · main')).toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole('button', { name: 'Push' }));

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

    await userEvent.click(await screen.findByRole('button', { name: 'Push' }));

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

    await userEvent.click(await screen.findByRole('button', { name: 'Push' }));

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

    expect(screen.getByText('blinto-co/forge · main')).toBeInTheDocument();
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

    expect(await screen.findByRole('button', { name: 'Push' })).toBeDisabled();
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

  it('points at the organisation settings when GitHub is not connected', async () => {
    server.use(
      connectors(null),
      http.get(`${PROJECT}/repo-link`, () => HttpResponse.json(null)),
    );

    render();

    expect(
      await screen.findByText('Connect GitHub in the organisation settings first.'),
    ).toBeInTheDocument();
  });
});

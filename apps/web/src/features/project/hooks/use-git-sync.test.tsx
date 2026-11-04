import type { GithubConnection, RepoLink, SyncOperation } from '@repo/contracts';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import {
  deriveGitSyncStatus,
  type GitSyncStatus,
  invalidateGitSync,
  SYNC_POLL_ACTIVE_MS,
  SYNC_POLL_IDLE_MS,
  useGitSync,
} from './use-git-sync';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BASE = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const ACTOR = { id: ORG, name: 'Ada' };

const aConnection: GithubConnection = {
  account: { id: 1, login: 'blinto-co', type: 'organization' },
  canCreateRepositories: true,
  circuitOpenUntil: null,
  connectedAt: '2026-09-20T10:00:00.000Z',
  connectedBy: ACTOR,
  credentialFingerprint: null,
  health: 'healthy',
  id: ORG,
  lastVerifiedAt: null,
  provider: 'github',
};

const aLink: RepoLink = {
  autoSync: true,
  branch: 'main',
  connectionId: ORG,
  id: PROJECT,
  lastPushedCheckpointId: null,
  linkedAt: '2026-09-21T08:00:00.000Z',
  linkedBy: ACTOR,
  position: 'level',
  remoteHeadSha: null,
  repository: { fullName: 'blinto-co/forge', id: 42, name: 'forge', owner: 'blinto-co' },
  sideBranch: null,
  state: 'linked',
};

function anOperation(over: Partial<SyncOperation> = {}): SyncOperation {
  return {
    commits: 0,
    createdAt: '2026-09-21T09:00:00.000Z',
    finishedAt: null,
    fromSha: null,
    id: ORG,
    kind: 'push',
    projectId: PROJECT,
    reason: null,
    requestedBy: ACTOR,
    startedAt: null,
    state: 'succeeded',
    targetBranch: null,
    toSha: null,
    trigger: 'auto',
    ...over,
  };
}

describe('deriveGitSyncStatus', () => {
  const failed = anOperation({ reason: 'git-failed', state: 'failed' });
  const table: readonly [
    string,
    Partial<Parameters<typeof deriveGitSyncStatus>[0]>,
    GitSyncStatus | undefined,
  ][] = [
    ['still loading the link', { link: undefined }, undefined],
    ['connectors unreadable, as a guest', { connectorsKnown: false, link: null }, undefined],
    ['no connection, no link', { connection: undefined, link: null }, 'not-connected'],
    ['a connection, no link', { link: null }, 'not-linked'],
    ['level', {}, 'synced'],
    ['ahead', { link: { ...aLink, position: 'ahead' } }, 'ahead'],
    ['never synced', { link: { ...aLink, position: 'unknown' } }, 'ahead'],
    ['queued', { operations: [anOperation({ state: 'queued' })] }, 'syncing'],
    ['running', { operations: [anOperation({ state: 'running' })] }, 'syncing'],
    [
      'an operation running on a side branch',
      {
        link: { ...aLink, sideBranch: 'kido-sync' },
        operations: [anOperation({ state: 'running' })],
      },
      'syncing',
    ],
    ['behind', { link: { ...aLink, position: 'behind' } }, 'needs-attention'],
    ['changed on both sides', { link: { ...aLink, position: 'diverged' } }, 'needs-attention'],
    ['a side branch', { link: { ...aLink, sideBranch: 'kido-sync' } }, 'needs-attention'],
    ['the latest operation failed', { operations: [failed] }, 'needs-attention'],
    ['an older operation failed', { operations: [anOperation(), failed] }, 'synced'],
    [
      'nothing to push is not a failure worth a look',
      { operations: [anOperation({ reason: 'nothing-to-push', state: 'failed' })] },
      'synced',
    ],
    [
      'the connection needs reconnecting',
      { connection: { ...aConnection, health: 'needs_reauth' } },
      'needs-attention',
    ],
    [
      'disconnected, even with an old operation running',
      {
        connection: undefined,
        link: { ...aLink, state: 'disconnected' },
        operations: [anOperation({ state: 'running' })],
      },
      'needs-attention',
    ],
    ['a guest on a linked project', { connection: undefined, connectorsKnown: false }, 'synced'],
  ];

  it.each(table)('%s', (_, over, expected) => {
    expect(
      deriveGitSyncStatus({
        connection: aConnection,
        connectorsKnown: true,
        link: aLink,
        operations: [],
        ...over,
      }),
    ).toBe(expected);
  });
});

function Probe(): React.JSX.Element {
  const git = useGitSync(ORG, PROJECT);

  return <p data-testid="status">{git.status ?? 'unknown'}</p>;
}

/** Real timeouts carry msw; only `setInterval`, react-query's poll, is on the fake clock. */
async function tick(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
}

describe('useGitSync polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function handlers(link: RepoLink | null, operations: () => readonly SyncOperation[]) {
    const reads = { link: 0, sync: 0 };

    server.use(
      http.get(`${API}/orgs/${ORG}/connectors`, () =>
        HttpResponse.json({ connections: [aConnection] }),
      ),
      http.get(`${BASE}/repo-link`, () => {
        reads.link += 1;

        return HttpResponse.json(link);
      }),
      http.get(`${BASE}/sync`, () => {
        reads.sync += 1;

        return HttpResponse.json({ operations: operations() });
      }),
    );

    return reads;
  }

  function fakeIntervals(): void {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  }

  async function shows(status: GitSyncStatus): Promise<void> {
    // Not `waitFor`: it polls with the `setInterval` this suite has frozen.
    for (let i = 0; i < 100; i += 1) {
      if (screen.queryByTestId('status')?.textContent === status) return;
      await tick(0);
    }

    expect(screen.getByTestId('status')).toHaveTextContent(status);
  }

  it('polls every 3 seconds while an operation is in flight', async () => {
    fakeIntervals();
    const reads = handlers(aLink, () => [anOperation({ state: 'running' })]);

    renderScreen(<Probe />);
    await shows('syncing');
    const before = reads.sync;

    await tick(SYNC_POLL_ACTIVE_MS);
    await tick(SYNC_POLL_ACTIVE_MS);

    expect(reads.sync).toBe(before + 2);
  });

  it('settles to every 30 seconds when idle, and rereads the link as an operation ends', async () => {
    fakeIntervals();
    let state: SyncOperation['state'] = 'running';
    const reads = handlers(aLink, () => [anOperation({ state })]);

    renderScreen(<Probe />);
    await shows('syncing');
    const linkReads = reads.link;

    state = 'succeeded';
    await tick(SYNC_POLL_ACTIVE_MS);
    await shows('synced');

    expect(reads.link).toBe(linkReads + 1);

    const before = reads.sync;

    await tick(SYNC_POLL_ACTIVE_MS);
    await tick(SYNC_POLL_ACTIVE_MS);
    expect(reads.sync).toBe(before);

    await tick(SYNC_POLL_IDLE_MS);
    expect(reads.sync).toBe(before + 1);
  });

  it('never polls a project with no repository', async () => {
    fakeIntervals();
    const reads = handlers(null, () => []);

    renderScreen(<Probe />);
    await shows('not-linked');

    await tick(SYNC_POLL_IDLE_MS * 2);

    expect(reads.link).toBe(1);
    expect(reads.sync).toBe(0);
  });
});

describe('invalidateGitSync', () => {
  it('moves the status straight away, as a checkpoint event does', async () => {
    let position: RepoLink['position'] = 'level';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    server.use(
      http.get(`${API}/orgs/${ORG}/connectors`, () =>
        HttpResponse.json({ connections: [aConnection] }),
      ),
      http.get(`${BASE}/repo-link`, () => HttpResponse.json({ ...aLink, position })),
      http.get(`${BASE}/sync`, () => HttpResponse.json({ operations: [] })),
    );

    renderScreen(<Probe />, { client });

    expect(await screen.findByText('synced')).toBeInTheDocument();

    position = 'ahead';
    await invalidateGitSync(client, ORG, PROJECT);

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('ahead');
    });
  });
});

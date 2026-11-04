import type { RepoLink, SyncOperation } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ProjectTopbar } from './project-topbar';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const PROJECT_URL = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const ACTOR = { id: ORG, name: 'Ada' };

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

const anOperation: SyncOperation = {
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
};

function renderTopbar(
  permissions: readonly string[],
  path = '/',
  routes: Record<string, React.ReactNode> = {},
  onOpenGitHub: () => void = () => undefined,
): void {
  renderScreen(
    <ProjectTopbar
      account={{ email: 'ada@example.com', name: 'Ada' }}
      changedFileCount={0}
      isChatOpen
      mobilePane="chat"
      onChangeMobilePane={() => undefined}
      onChangeStage={() => undefined}
      onOpenGitHub={onOpenGitHub}
      onToggleChat={() => undefined}
      orgId={ORG}
      permissions={permissions}
      phase="ready"
      projectId={PROJECT}
      projectName="Launch site"
      stage="preview"
    />,
    { path, routes },
  );
}

beforeEach(() => {
  server.use(
    http.get(`${API}/orgs/${ORG}/projects/${PROJECT}/access`, () =>
      HttpResponse.json({
        grants: [{ email: 'ada@example.com', role: 'owner', userId: ORG }],
        invitations: [],
      }),
    ),
    http.get(`${API}/orgs/${ORG}/connectors`, () => HttpResponse.json({ connections: [] })),
    http.get(`${PROJECT_URL}/repo-link`, () => HttpResponse.json(null)),
  );
});

/** Spec 031 T053/T054 (FR-022). */
describe('ProjectTopbar sharing', () => {
  it('offers no Share control without project:share.external', () => {
    renderTopbar(['project:read', 'project:agent.run']);

    expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
  });

  it('opens the share panel from the Share button', async () => {
    renderTopbar(['project:read', 'project:share.external']);

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
  });

  it('opens the share panel from ?panel=share', async () => {
    renderTopbar(['project:read', 'project:share.external'], '/?panel=share');

    expect(await screen.findByText('Share this project')).toBeInTheDocument();
  });
});

/** Spec 036: rename and delete from the project name menu. */
describe('ProjectTopbar project management', () => {
  const WORKSPACE = 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c';
  const WORKSPACE_PROJECT = `${API}/orgs/${ORG}/workspaces/${WORKSPACE}/projects/${PROJECT}`;

  beforeEach(() => {
    server.use(
      http.get(`${API}/orgs/${ORG}/workspaces`, () =>
        HttpResponse.json({
          workspaces: [
            {
              createdAt: '2026-09-20T10:00:00.000Z',
              id: WORKSPACE,
              name: 'Default',
              role: 'admin',
            },
          ],
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renames the project in its workspace', async () => {
    let body: unknown;

    server.use(
      http.patch(WORKSPACE_PROJECT, async ({ request }) => {
        body = await request.json();

        return new HttpResponse(null, { status: 204 });
      }),
    );
    vi.spyOn(window, 'prompt').mockReturnValue('Relaunch site');

    renderTopbar(['project:read']);
    await userEvent.click(screen.getByRole('button', { name: /switch project/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename project' }));

    await waitFor(() => {
      expect(body).toEqual({ name: 'Relaunch site' });
    });
  });

  it('deletes after a confirm and leaves the project page', async () => {
    let deleted = false;

    server.use(
      http.delete(WORKSPACE_PROJECT, () => {
        deleted = true;

        return new HttpResponse(null, { status: 204 });
      }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderTopbar(['project:read'], `/projects/${PROJECT}`, { '/': <p>Home screen</p> });
    await userEvent.click(screen.getByRole('button', { name: /switch project/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete project' }));

    expect(await screen.findByText('Home screen')).toBeInTheDocument();
    expect(deleted).toBe(true);
  });

  it('does nothing when the delete is not confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderTopbar(['project:read']);
    await userEvent.click(screen.getByRole('button', { name: /switch project/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete project' }));

    // msw's `onUnhandledRequest: 'error'` would fail a DELETE nobody handled.
    expect(screen.getByText('Launch site')).toBeInTheDocument();
  });
});

/** Spec 044: the bar's view of GitHub. */
describe('ProjectTopbar sync chip', () => {
  const syncChip = async (name: string) => {
    const status = (await screen.findByText(name)).closest('[role="status"]');

    expect(status).not.toBeNull();
  };

  function linked(over: Partial<RepoLink> = {}, operations: Partial<SyncOperation>[] = []): void {
    server.use(
      http.get(`${PROJECT_URL}/repo-link`, () => HttpResponse.json({ ...aLink, ...over })),
      http.get(`${PROJECT_URL}/sync`, () =>
        HttpResponse.json({ operations: operations.map((op) => ({ ...anOperation, ...op })) }),
      ),
    );
  }

  it('links the icon to the real repository and says Synced in a status region', async () => {
    linked();

    renderTopbar(['project:read']);

    await syncChip('Synced');

    const icon = screen.getByRole('link', { name: 'Open the repository on GitHub' });

    expect(icon).toHaveAttribute('href', 'https://github.com/blinto-co/forge');
    expect(icon).toHaveAttribute('target', '_blank');
    expect(icon).toHaveAttribute('rel', 'noreferrer');
  });

  it('says Syncing… while an operation runs', async () => {
    linked({}, [{ state: 'running' }]);

    renderTopbar(['project:read']);

    await syncChip('Syncing…');
  });

  it('says Needs attention on a side branch, and opens the panel from the chip', async () => {
    const onOpenGitHub = vi.fn();

    linked({ sideBranch: 'kido-sync' });

    renderTopbar(['project:read'], '/', {}, onOpenGitHub);

    await syncChip('Needs attention');
    await userEvent.click(screen.getByRole('button', { name: /needs attention/iu }));

    expect(onOpenGitHub).toHaveBeenCalledOnce();
  });

  it('opens the GitHub panel from the icon while nothing is linked, with no status claimed', async () => {
    const onOpenGitHub = vi.fn();

    renderTopbar(['project:read'], '/', {}, onOpenGitHub);

    const button = await screen.findByRole('button', { name: 'Set up GitHub for this project' });

    expect(screen.queryByRole('link', { name: /repository on github/iu })).not.toBeInTheDocument();
    await userEvent.click(button);

    expect(onOpenGitHub).toHaveBeenCalledOnce();
  });
});

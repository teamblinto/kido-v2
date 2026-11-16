import type { Connection, SyncOperation } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { ProjectNewImportPage } from './project-new-import';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const WORKSPACE_ID = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const PROJECT_ID = '7b1c0a2e-6f2b-4a1e-9c3d-1a2b3c4d5e6f';
const HEAD = 'a'.repeat(40);

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

const aConnection: Connection = {
  account: { id: 9001, login: 'blinto-co', type: 'organization' },
  canCreateRepositories: true,
  circuitOpenUntil: null,
  connectedAt: '2026-09-20T10:00:00.000Z',
  connectedBy: { id: ORG_ID, name: 'Rakibul' },
  credentialFingerprint: 'a1b2c3d4',
  health: 'healthy',
  id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
  lastVerifiedAt: '2026-09-20T10:00:00.000Z',
  provider: 'github',
};

const aRepository = {
  defaultBranch: 'main',
  fullName: 'blinto-co/site',
  id: 940,
  name: 'site',
  owner: 'blinto-co',
  private: true,
};

const anotherRepository = { ...aRepository, fullName: 'blinto-co/docs', id: 941, name: 'docs' };

const queued: SyncOperation = {
  commits: 0,
  createdAt: '2026-09-22T10:00:00.000Z',
  finishedAt: null,
  fromSha: null,
  id: '1f0c8f2e-1111-4111-8111-111111111111',
  kind: 'import',
  projectId: PROJECT_ID,
  reason: null,
  requestedBy: { id: ORG_ID, name: 'Rakibul' },
  startedAt: null,
  state: 'queued',
  targetBranch: null,
  toSha: HEAD,
  trigger: 'manual',
};

const importsPath = `${API}/orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/imports`;

beforeEach(() => {
  server.use(
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })),
    http.get(`${API}/orgs/${ORG_ID}/workspaces`, () =>
      HttpResponse.json({
        workspaces: [
          {
            createdAt: '2026-08-01T09:00:00.000Z',
            id: WORKSPACE_ID,
            name: 'Default',
            role: 'admin',
          },
        ],
      }),
    ),
    http.get(`${API}/orgs/${ORG_ID}/connectors`, () =>
      HttpResponse.json({ connections: [aConnection] }),
    ),
    http.get(`${API}/orgs/${ORG_ID}/connectors/${aConnection.id}/repositories`, () =>
      HttpResponse.json({ repositories: [aRepository, anotherRepository] }),
    ),
  );
});

/**
 * Spec 047's surface (over spec 026's wire). Every body MSW answers is a contract-valid one, so
 * the page is proved against the wire the API actually serves rather than a convenient shape.
 */
describe('ProjectNewImportPage', () => {
  it('lists the installation’s repositories and filters them by name', async () => {
    renderScreen(<ProjectNewImportPage />);

    expect(await screen.findByText('blinto-co/site')).toBeInTheDocument();
    expect(screen.getByText('blinto-co/docs')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Filter repositories'), 'doc');

    await waitFor(() => {
      expect(screen.queryByText('blinto-co/site')).not.toBeInTheDocument();
    });
    expect(screen.getByText('blinto-co/docs')).toBeInTheDocument();
  });

  it('imports with one click: the repository alone, no template, branch or name (spec 047)', async () => {
    let sent: unknown;
    server.use(
      http.post(importsPath, async ({ request }) => {
        sent = await request.json();

        return HttpResponse.json(queued, { status: 202 });
      }),
    );

    renderScreen(<ProjectNewImportPage />, {
      path: '/import',
      routes: { [`/projects/${PROJECT_ID}`]: <p>Project page</p> },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Import blinto-co/site' }));

    await waitFor(() => {
      expect(sent).toEqual({ repoId: 940 });
    });
    expect(await screen.findByText('Project page')).toBeInTheDocument();
  });

  it('a refusal is shown as its sentence, not as a slug', async () => {
    server.use(http.post(importsPath, () => problemResponse('import-repo-too-large', 409)));

    renderScreen(<ProjectNewImportPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Import blinto-co/site' }));

    expect(await screen.findByText('That repository is too large to import.')).toBeInTheDocument();
  });

  it('asks for a GitHub connection when there is none', async () => {
    server.use(
      http.get(`${API}/orgs/${ORG_ID}/connectors`, () => HttpResponse.json({ connections: [] })),
    );

    renderScreen(<ProjectNewImportPage />);

    expect(await screen.findByRole('link', { name: 'Connect GitHub' })).toBeInTheDocument();
  });
});

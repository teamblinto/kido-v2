import type { Connection, InspectImportResponse, SyncOperation } from '@repo/contracts';
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

const proposed: InspectImportResponse = {
  branch: 'main',
  candidates: [{ evidence: ['vite.config.ts', 'dependency: react'], template: 'vite-react' }],
  empty: false,
  headSha: HEAD,
  outcome: 'proposed',
  repo: { id: 940, name: 'site', owner: 'blinto-co' },
  sizeKib: 1200,
};

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

const inspectPath = `${API}/orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/imports/inspect`;
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
 * Spec 026 US1's surface. Every body MSW answers is a contract-valid one, so the page is proved
 * against the wire the API actually serves rather than against a convenient shape.
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

  it('a proposal shows its evidence, pre-selects the one template, and imports on confirm', async () => {
    let sent: unknown;
    server.use(
      http.post(inspectPath, () => HttpResponse.json(proposed)),
      http.post(importsPath, async ({ request }) => {
        sent = await request.json();

        return HttpResponse.json(queued, { status: 202 });
      }),
    );

    renderScreen(<ProjectNewImportPage />, {
      path: '/import',
      routes: { [`/projects/${PROJECT_ID}`]: <p>Project page</p> },
    });

    await userEvent.click((await screen.findAllByRole('button', { name: 'Inspect' }))[0]!);

    // The user can check the reasoning: the signals are rendered, not just the answer.
    expect(await screen.findByText('vite.config.ts')).toBeInTheDocument();
    expect(screen.getByText('dependency: react')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Vite \+ React/ })).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Import repository' }));

    // FR-011: the confirmed template is on the wire, not inferred by the server.
    await waitFor(() => {
      expect(sent).toEqual({
        branch: 'main',
        name: 'site',
        repoId: 940,
        template: 'vite-react',
      });
    });
    expect(await screen.findByText('Project page')).toBeInTheDocument();
  });

  it('a proposal can be overridden with any of the four, and the override is what is sent (FR-013)', async () => {
    let sent: unknown;
    server.use(
      http.post(inspectPath, () => HttpResponse.json(proposed)),
      http.post(importsPath, async ({ request }) => {
        sent = await request.json();

        return HttpResponse.json(queued, { status: 202 });
      }),
    );

    renderScreen(<ProjectNewImportPage />, {
      path: '/import',
      routes: { [`/projects/${PROJECT_ID}`]: <p>Project page</p> },
    });

    await userEvent.click((await screen.findAllByRole('button', { name: 'Inspect' }))[0]!);

    // All four are offered even when one is proposed: an override you cannot make is not one.
    expect(await screen.findByText('vite.config.ts')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);

    await userEvent.click(screen.getByRole('radio', { name: /Python/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Import repository' }));

    await waitFor(() => {
      expect(sent).toMatchObject({ template: 'python' });
    });
  });

  it('an ambiguous repository selects nothing and will not import until a person picks (FR-012)', async () => {
    server.use(
      http.post(inspectPath, () =>
        HttpResponse.json({
          ...proposed,
          candidates: [
            { evidence: ['next.config.mjs', 'dependency: next'], template: 'nextjs' },
            { evidence: ['pyproject.toml'], template: 'python' },
          ],
          outcome: 'ambiguous',
        } satisfies InspectImportResponse),
      ),
    );

    renderScreen(<ProjectNewImportPage />);

    await userEvent.click((await screen.findAllByRole('button', { name: 'Inspect' }))[0]!);

    expect(await screen.findByText(/matches more than one template/i)).toBeInTheDocument();
    for (const name of [/Next\.js/, /Python/]) {
      expect(screen.getByRole('radio', { name })).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Import repository' })).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: /Python/ }));

    expect(screen.getByRole('button', { name: 'Import repository' })).toBeEnabled();
  });

  it('an unrecognised repository offers every template and none of them by default (FR-011)', async () => {
    server.use(
      http.post(inspectPath, () =>
        HttpResponse.json({
          ...proposed,
          candidates: [],
          outcome: 'unrecognised',
        } satisfies InspectImportResponse),
      ),
    );

    renderScreen(<ProjectNewImportPage />);

    await userEvent.click((await screen.findAllByRole('button', { name: 'Inspect' }))[0]!);

    expect(await screen.findByText(/couldn’t tell how this repository runs/i)).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Import repository' })).toBeDisabled();
  });

  it('an empty branch says so and cannot be imported', async () => {
    server.use(
      http.post(inspectPath, () =>
        HttpResponse.json({
          ...proposed,
          candidates: [],
          empty: true,
          headSha: null,
          outcome: 'unrecognised',
        } satisfies InspectImportResponse),
      ),
    );

    renderScreen(<ProjectNewImportPage />);

    await userEvent.click((await screen.findAllByRole('button', { name: 'Inspect' }))[0]!);

    expect(await screen.findByText(/no commits yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import repository' })).toBeDisabled();
  });

  it('a refusal is shown as its sentence, not as a slug', async () => {
    server.use(
      http.post(inspectPath, () => HttpResponse.json(proposed)),
      http.post(importsPath, () => problemResponse('import-repo-too-large', 409)),
    );

    renderScreen(<ProjectNewImportPage />);

    await userEvent.click((await screen.findAllByRole('button', { name: 'Inspect' }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Import repository' }));

    expect(await screen.findByText('That repository is too large to import.')).toBeInTheDocument();
  });
});

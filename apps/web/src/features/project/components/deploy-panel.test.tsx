import {
  type Binding,
  type Checkpoint,
  type Connection,
  DEPLOYMENT_FAILURE_REASONS,
  type Deployment,
  type Operation,
  type Site,
} from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { aUser, problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { REASON_COPY } from '../lib/deploy-reasons';
import { DeployPanel } from './deploy-panel';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const HEAD = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const OLDER = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const D3 = '33333333-3333-4333-8333-333333333333';
const D4 = '44444444-4444-4444-8444-444444444444';

const BASE = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const URL_LIVE = 'https://abc123.sites.example.test/';
const DEPLOYER = ['project:read', 'project:deploy'];
const READER = ['project:read'];

function aCheckpoint(id: string, label: string): Checkpoint {
  return {
    actorId: null,
    createdAt: '2026-09-22T10:00:00.000Z',
    files: [],
    gitSha: 'a'.repeat(40),
    id,
    kind: 'turn',
    label,
    mirroredAt: null,
    parentId: null,
    revertsId: null,
    runId: null,
    turn: 1,
  };
}

function aDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    artifactSha: null,
    attempts: 0,
    checkpointId: HEAD,
    createdAt: '2026-09-22T10:00:00.000Z',
    current: false,
    failureReason: null,
    fileCount: null,
    finishedAt: null,
    id: D1,
    requestedBy: aUser.id,
    startedAt: null,
    state: 'queued',
    totalBytes: null,
    ...overrides,
  };
}

function succeeded(id: string, current: boolean, checkpointId = HEAD): Deployment {
  return aDeployment({
    artifactSha: 'b'.repeat(64),
    checkpointId,
    current,
    fileCount: 3,
    finishedAt: '2026-09-22T10:02:00.000Z',
    id,
    startedAt: '2026-09-22T10:00:05.000Z',
    state: 'succeeded',
    totalBytes: 2048,
  });
}

const neverDeployed: Site = {
  currentDeploymentId: null,
  deployable: true,
  offline: false,
  url: null,
};

const live: Site = { currentDeploymentId: D1, deployable: true, offline: false, url: URL_LIVE };

const NETLIFY_CONNECTION: Connection = {
  account: { name: 'Acme', ref: 'acme' },
  authType: 'token',
  connectedAt: '2026-09-20T10:00:00.000Z',
  connectedBy: { id: aUser.id, name: 'Rakibul' },
  credentialFingerprint: 'a1b2c3d4',
  failedResources: [],
  health: 'healthy',
  id: '55555555-5555-4555-8555-555555555555',
  lastVerifiedAt: '2026-09-20T10:00:00.000Z',
  provider: 'netlify',
  removalRequestedAt: null,
  scopes: ['account'],
};

function handlers({
  connections = [],
  deployments = [],
  role = 'owner',
  site = neverDeployed,
}: {
  connections?: readonly Connection[];
  deployments?: readonly Deployment[];
  role?: string;
  site?: Site;
} = {}) {
  return [
    http.get(`${API}/orgs`, () =>
      HttpResponse.json({
        orgs: [
          {
            access: 'member',
            createdAt: '2026-08-01T09:00:00.000Z',
            id: ORG,
            name: 'Blinto',
            plan: 'free',
            role,
            slug: 'blinto',
          },
        ],
      }),
    ),
    // The organisation's connections: none unless a test says so.
    http.get(`${API}/orgs/${ORG}/connectors`, () => HttpResponse.json({ connections })),
    http.get(`${BASE}/checkpoints`, () =>
      HttpResponse.json({
        items: [aCheckpoint(HEAD, 'Add the pricing page'), aCheckpoint(OLDER, 'First draft')],
        nextCursor: null,
      }),
    ),
    http.get(`${BASE}/deployments`, () =>
      HttpResponse.json({ items: deployments, nextCursor: null }),
    ),
    http.get(`${BASE}/site`, () => HttpResponse.json({ site })),
    // Not bound to Netlify unless a test says so (spec 030 US4).
    http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [] })),
  ];
}

function render(permissions: readonly string[] = DEPLOYER) {
  return renderScreen(<DeployPanel orgId={ORG} permissions={permissions} projectId={PROJECT} />);
}

describe('DeployPanel', () => {
  it('names the checkpoint in a confirmation before anything is requested', async () => {
    const posted: unknown[] = [];

    server.use(
      ...handlers(),
      http.post(`${BASE}/deployments`, async ({ request }) => {
        posted.push(await request.json());

        return HttpResponse.json({ deployment: aDeployment() }, { status: 202 });
      }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));

    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByRole('heading', { name: /Add the pricing page/u }),
    ).toBeInTheDocument();
    expect(posted).toEqual([]);

    await userEvent.click(within(dialog).getByRole('button', { name: /Deploy “Add the pricing/u }));

    await waitFor(() => expect(posted).toEqual([{ checkpointId: HEAD }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('polls while a row is in flight, shows the change without a reload, and then stops', async () => {
    let calls = 0;

    server.use(
      // First, so it answers before `handlers()`'s own list.
      http.get(`${BASE}/deployments`, () => {
        calls += 1;

        return HttpResponse.json({
          items: [calls === 1 ? aDeployment({ state: 'building' }) : succeeded(D1, true)],
          nextCursor: null,
        });
      }),
      ...handlers(),
    );

    render();

    expect(await screen.findByText('Building')).toBeInTheDocument();

    // The next poll lands inside the 2 s interval — well inside the spec's 5 s.
    expect(await screen.findByText('Succeeded', {}, { timeout: 4000 })).toBeInTheDocument();

    const settled = calls;

    await new Promise((resolve) => {
      setTimeout(resolve, 2600);
    });

    expect(calls).toBe(settled);
  }, 15_000);

  it('offers Roll back only on succeeded rows that are not current', async () => {
    const puts: unknown[] = [];

    server.use(
      ...handlers({
        deployments: [
          succeeded(D1, true),
          succeeded(D2, false, OLDER),
          aDeployment({ failureReason: 'build-failed', id: D3, state: 'failed' }),
          aDeployment({ id: D4, state: 'cancelled' }),
        ],
        site: live,
      }),
      http.put(`${BASE}/site`, async ({ request }) => {
        puts.push(await request.json());

        return HttpResponse.json({ site: { ...live, currentDeploymentId: D2 } });
      }),
    );

    render();

    const rollBack = await screen.findAllByRole('button', { name: /Roll back/u });

    expect(rollBack).toHaveLength(1);

    await userEvent.click(rollBack[0]!);

    await waitFor(() => expect(puts).toEqual([{ action: 'release', deploymentId: D2 }]));
  });

  it('shows a failed row its reason and opens its log', async () => {
    server.use(
      ...handlers({
        deployments: [aDeployment({ failureReason: 'build-failed', id: D3, state: 'failed' })],
      }),
      http.get(`${BASE}/deployments/${D3}/log`, () =>
        HttpResponse.json({ log: 'npm run build\nerror TS2322', truncated: false }),
      ),
    );

    render();

    expect(await screen.findByText(REASON_COPY['build-failed'])).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /View log/u }));

    expect(await screen.findByText(/error TS2322/u)).toBeInTheDocument();
  });

  it('shows a member without project:deploy the address and the history but no actions', async () => {
    server.use(
      ...handlers({
        deployments: [succeeded(D1, true), succeeded(D2, false, OLDER)],
        site: live,
      }),
    );

    render(READER);

    expect(await screen.findByRole('link', { name: URL_LIVE })).toHaveAttribute('href', URL_LIVE);
    expect(await screen.findAllByText('Succeeded')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Roll back/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Take offline/u })).not.toBeInTheDocument();
  });

  it('points a non-deployable project at the GitHub export and offers no deploy', async () => {
    server.use(...handlers({ site: { ...neverDeployed, deployable: false } }));

    render();

    expect(await screen.findByText(/GitHub/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
  });

  it('puts the refusal reason’s copy on a refused deploy', async () => {
    server.use(
      ...handlers(),
      http.post(`${BASE}/deployments`, () =>
        problemResponse('conflict', 409, { deploymentId: D1, reason: 'deploy-active' }),
      ),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: /Deploy “/u }),
    );

    expect(await screen.findByText(REASON_COPY['deploy-active'])).toBeInTheDocument();
  });

  it('has copy for every reason the contract names', () => {
    const reasons = [
      ...DEPLOYMENT_FAILURE_REASONS,
      'not-deployable',
      'deploy-active',
      'project-archived',
      'not-releasable',
      'never-deployed',
    ];

    for (const reason of reasons) {
      expect(REASON_COPY[reason as keyof typeof REASON_COPY]).toMatch(/\S/u);
    }

    expect(Object.keys(REASON_COPY).sort()).toEqual([...reasons].sort());
  });
});

const NETLIFY_BINDING: Binding = {
  boundBy: { id: aUser.id, name: 'Rakibul' },
  config: { siteId: 'site-1', siteName: 'acme-site', siteUrl: 'https://acme-site.netlify.app' },
  connectionId: '55555555-5555-4555-8555-555555555555',
  createdAt: '2026-09-22T09:00:00.000Z',
  id: '66666666-6666-4666-8666-666666666666',
  latestOperation: null,
  projectId: PROJECT,
  provider: 'netlify',
  resources: [],
  state: 'bound',
  updatedAt: '2026-09-22T09:00:00.000Z',
};

function aPublish(overrides: Partial<Operation> = {}): Operation {
  return {
    bindingId: NETLIFY_BINDING.id,
    createdAt: '2026-09-22T10:05:00.000Z',
    deploymentId: D1,
    finishedAt: null,
    id: '77777777-7777-4777-8777-777777777777',
    kind: 'netlify_publish',
    projectId: PROJECT,
    providerState: null,
    reason: null,
    requestedBy: aUser.id,
    startedAt: null,
    state: 'queued',
    ...overrides,
  };
}

/** Spec 030 T086: "Publish to Netlify" on a release, with Netlify's states as they arrive. */
describe('DeployPanel — Netlify', () => {
  it('publishes a succeeded release and shows Netlify’s state until it is ready', async () => {
    const posted: unknown[] = [];
    let polls = 0;
    let publishes: Operation[] = [];

    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () => {
        if (publishes.length > 0) {
          polls += 1;
          publishes = [
            polls === 1
              ? aPublish({ providerState: 'uploading', state: 'running' })
              : aPublish({ providerState: 'ready', state: 'succeeded' }),
          ];
        }
        return HttpResponse.json({ items: publishes });
      }),
      http.post(`${BASE}/connectors/netlify/publish`, async ({ request }) => {
        posted.push(await request.json());
        publishes = [aPublish()];
        return HttpResponse.json(aPublish(), { status: 202 });
      }),
      ...handlers({
        connections: [NETLIFY_CONNECTION],
        deployments: [succeeded(D1, true)],
        site: live,
      }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Publish to Netlify' }));

    await waitFor(() => expect(posted).toEqual([{ deploymentId: D1 }]));
    expect(await screen.findByText('Uploading to Netlify…')).toBeInTheDocument();
    expect(
      await screen.findByText('Published to Netlify', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('says why a publish failed, and offers nothing without project:deploy', async () => {
    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () =>
        HttpResponse.json({
          items: [aPublish({ providerState: 'error', reason: 'site-gone', state: 'failed' })],
        }),
      ),
      ...handlers({ deployments: [succeeded(D1, true)], site: live }),
    );

    render(READER);

    expect(await screen.findByText(/site no longer exists/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish to Netlify' })).not.toBeInTheDocument();
  });

  it('shows no Netlify action when the project is not bound', async () => {
    server.use(...handlers({ deployments: [succeeded(D1, true)], site: live }));

    render();

    await screen.findByRole('list', { name: 'Deploy history' });
    expect(screen.queryByRole('button', { name: 'Publish to Netlify' })).not.toBeInTheDocument();
  });
});

/** "Deploy to Netlify": the site choice, one button, and the publish's lifecycle with its links. */
describe('DeployPanel — Deploy to Netlify', () => {
  it('without a Netlify connection, says where an admin connects it and offers no deploy', async () => {
    server.use(...handlers());

    render();

    const section = await screen.findByTestId('netlify-deploy');

    expect(await within(section).findByText(/No Netlify connection/u)).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'settings' })).toHaveAttribute(
      'href',
      '/settings/connectors',
    );
    expect(screen.queryByRole('button', { name: 'Deploy to Netlify' })).not.toBeInTheDocument();
  });

  it('connected but unbound, an admin chooses an existing site', async () => {
    const bound: unknown[] = [];

    server.use(
      ...handlers({ connections: [NETLIFY_CONNECTION] }),
      http.get(`${API}/orgs/${ORG}/connectors/${NETLIFY_CONNECTION.id}/netlify/sites`, () =>
        HttpResponse.json({
          items: [{ id: 'site-1', name: 'acme-site', url: 'https://acme-site.netlify.app' }],
        }),
      ),
      http.put(`${BASE}/connectors/netlify`, async ({ request }) => {
        bound.push(await request.json());
        return HttpResponse.json(NETLIFY_BINDING);
      }),
    );

    render();

    await screen.findByRole('option', { name: 'acme-site' });
    await userEvent.selectOptions(screen.getByLabelText('Netlify site'), 'site-1');
    await userEvent.click(screen.getByRole('button', { name: 'Use this site' }));

    await waitFor(() => expect(bound).toEqual([{ siteId: 'site-1' }]));
  });

  it('builds and publishes in one request, then shows each stage to a live link', async () => {
    const posted: unknown[] = [];
    let publishes: Operation[] = [];
    const stages = [
      aPublish({ providerState: 'building', state: 'running' }),
      aPublish({ providerState: 'uploading', state: 'running' }),
      aPublish({
        finishedAt: '2026-09-22T10:09:00.000Z',
        providerState: 'ready',
        state: 'succeeded',
      }),
    ];

    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () => {
        if (publishes.length > 0) publishes = [stages.shift() ?? publishes[0]!];
        return HttpResponse.json({ items: publishes });
      }),
      http.post(`${BASE}/connectors/netlify/publish`, async ({ request }) => {
        posted.push(await request.json());
        publishes = [aPublish()];
        return HttpResponse.json(aPublish(), { status: 202 });
      }),
      ...handlers({ connections: [NETLIFY_CONNECTION] }),
    );

    render();

    expect(
      await screen.findByText(/Builds the latest checkpoint .* publishes the output to acme-site/u),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Deploy to Netlify' }));

    // Nothing built for the head yet: no release named, the API builds it first.
    await waitFor(() => expect(posted).toEqual([{}]));
    expect(await screen.findByText('Building on Kido…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy to Netlify' })).toBeDisabled();
    expect(
      await screen.findByText('Published to Netlify', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open live site/u })).toHaveAttribute(
      'href',
      'https://acme-site.netlify.app',
    );
    expect(screen.getByRole('link', { name: /Deploys on Netlify/u })).toHaveAttribute(
      'href',
      'https://app.netlify.com/sites/acme-site/deploys',
    );
  }, 15_000);

  it('publishes the head’s succeeded build as it is, without building again', async () => {
    const posted: unknown[] = [];

    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () => HttpResponse.json({ items: [] })),
      http.post(`${BASE}/connectors/netlify/publish`, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json(aPublish(), { status: 202 });
      }),
      ...handlers({
        connections: [NETLIFY_CONNECTION],
        deployments: [succeeded(D1, true)],
        site: live,
      }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy to Netlify' }));

    await waitFor(() => expect(posted).toEqual([{ deploymentId: D1 }]));
  });

  it('says why a deploy failed, with the build’s failure in its own words', async () => {
    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () =>
        HttpResponse.json({
          items: [aPublish({ reason: 'build-failed', state: 'failed' })],
        }),
      ),
      ...handlers({ connections: [NETLIFY_CONNECTION] }),
    );

    render();

    expect(await screen.findByText(/The build failed, so nothing was sent/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Deploys on Netlify/u })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open live site/u })).not.toBeInTheDocument();
  });

  it('puts a refused deploy’s reason on screen', async () => {
    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () => HttpResponse.json({ items: [] })),
      http.post(`${BASE}/connectors/netlify/publish`, () =>
        problemResponse('conflict', 409, { reason: 'in-flight' }),
      ),
      ...handlers({ connections: [NETLIFY_CONNECTION] }),
    );

    render();

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy to Netlify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already running/u);
  });

  it('locks the deploy while the Netlify connection needs reconnecting', async () => {
    server.use(
      http.get(`${BASE}/connectors`, () => HttpResponse.json({ items: [NETLIFY_BINDING] })),
      http.get(`${BASE}/connectors/operations`, () => HttpResponse.json({ items: [] })),
      ...handlers({ connections: [{ ...NETLIFY_CONNECTION, health: 'needs_reauth' }] }),
    );

    render();

    expect(await screen.findByText(/needs to be reconnected/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy to Netlify' })).toBeDisabled();
  });

  it('offers nothing Netlify on a project whose template has no build', async () => {
    server.use(...handlers({ site: { ...neverDeployed, deployable: false } }));

    render();

    await screen.findByTestId('not-deployable');
    expect(screen.queryByTestId('netlify-deploy')).not.toBeInTheDocument();
  });
});

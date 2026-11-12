import type { Binding, Connection, NeonProjectPage, Operation } from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { DISCLOSURE, IntegrationsPanel, RESEND_WAITING, RESET_NOTICE } from './integrations-panel';
import { MIGRATIONS_ASLEEP, NO_MIGRATIONS } from './migrations-section';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CONNECTORS = `${API}/orgs/${ORG_ID}/connectors`;
const BINDINGS = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}/connectors`;
const FILES = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}/files`;
const ACTOR = { id: ORG_ID, name: 'Rakibul' };
const NEON_CONNECTION_ID = 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c';
const NETLIFY_CONNECTION_ID = 'e7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c';
const RESEND_CONNECTION_ID = 'f7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c';

function aConnection(provider: 'neon' | 'netlify' | 'resend' | 'supabase'): Connection {
  return {
    account: { name: 'Acme', ref: 'org-1' },
    authType: provider === 'supabase' ? 'oauth' : 'token',
    connectedAt: '2026-09-20T10:00:00.000Z',
    connectedBy: ACTOR,
    credentialFingerprint: 'a1b2c3d4',
    failedResources: [],
    health: 'healthy',
    id:
      provider === 'neon'
        ? NEON_CONNECTION_ID
        : provider === 'netlify'
          ? NETLIFY_CONNECTION_ID
          : provider === 'resend'
            ? RESEND_CONNECTION_ID
            : 'd7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
    lastVerifiedAt: '2026-09-20T10:00:00.000Z',
    provider,
    removalRequestedAt: null,
    scopes: [],
  };
}

const anOperation: Operation = {
  bindingId: '9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e',
  createdAt: '2026-09-21T09:00:00.000Z',
  deploymentId: null,
  finishedAt: null,
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'neon_branch_reset',
  projectId: PROJECT_ID,
  providerState: null,
  reason: null,
  requestedBy: ORG_ID,
  startedAt: null,
  state: 'queued',
};

const NEON_CONFIG = {
  databaseName: 'neondb',
  parentBranchId: 'br-main',
  projectId: 'proj-1',
  roleName: 'neondb_owner',
};

function aNeonBinding(state: 'live' | 'provisioning' = 'live'): Binding {
  return {
    boundBy: ACTOR,
    config: NEON_CONFIG,
    connectionId: NEON_CONNECTION_ID,
    createdAt: '2026-09-21T08:00:00.000Z',
    id: anOperation.bindingId!,
    latestOperation: { ...anOperation, kind: 'neon_branch_create', state: 'succeeded' },
    projectId: PROJECT_ID,
    provider: 'neon',
    resources: [{ kind: 'neon_branch', name: `forge-preview-${PROJECT_ID}`, state }],
    state: 'bound',
    updatedAt: '2026-09-21T08:00:00.000Z',
  };
}

const NEON_PROJECTS: NeonProjectPage = {
  items: [
    {
      branches: [{ default: true, id: 'br-main', name: 'main' }],
      databases: ['neondb'],
      id: 'proj-1',
      name: 'acme-db',
      roles: ['neondb_owner'],
    },
  ],
};

function world({
  bindings = [],
  connections = [aConnection('neon')],
  role = 'owner',
}: { bindings?: Binding[]; connections?: Connection[]; role?: string } = {}) {
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
            role,
            slug: 'blinto',
          },
        ],
      }),
    ),
    // A live database lists its migrations; by default none applied and no directory yet.
    http.get(`${BINDINGS}/:provider/migrations`, () =>
      HttpResponse.json({ applied: [], directory: 'db/migrations' }),
    ),
    http.get(FILES, () => problemResponse('not-found', 404)),
    http.get(CONNECTORS, () => HttpResponse.json({ connections })),
    http.get(BINDINGS, () => HttpResponse.json({ items: bindings })),
    http.get(`${CONNECTORS}/${NEON_CONNECTION_ID}/neon/projects`, () =>
      HttpResponse.json(NEON_PROJECTS),
    ),
  );
}

function render(permissions: readonly string[] = ['project:read', 'project:files.write']) {
  return renderScreen(
    <IntegrationsPanel orgId={ORG_ID} permissions={permissions} projectId={PROJECT_ID} />,
  );
}

/** Spec 030 T077: the project's Neon and Supabase integrations, values never shown. */
describe('IntegrationsPanel', () => {
  it('says there is nothing to bind through when the organisation has no connection', async () => {
    world({ connections: [] });
    render();

    expect(await screen.findByText(/No Neon connection/u)).toBeInTheDocument();
    expect(screen.getByText(/No Supabase connection/u)).toBeInTheDocument();
  });

  it('binds Neon from the pickers, sending the project, parent branch, database and role', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    let bound: Binding[] = [];

    world();
    server.use(
      http.get(BINDINGS, () => HttpResponse.json({ items: bound })),
      http.put(`${BINDINGS}/neon`, async ({ request }) => {
        sent = await request.json();
        bound = [aNeonBinding('provisioning')];

        return HttpResponse.json(bound[0]);
      }),
    );
    render();

    await screen.findByRole('option', { name: 'acme-db' });
    await user.selectOptions(screen.getByLabelText('Neon project'), 'proj-1');
    expect(screen.getByLabelText('Parent branch')).toHaveValue('br-main');
    await user.click(screen.getByRole('button', { name: 'Create preview database' }));

    await waitFor(() => {
      expect(sent).toEqual(NEON_CONFIG);
    });
    expect(await screen.findByText('Creating…')).toBeInTheDocument();
  });

  it('a live branch shows its state and the disclosure; reset says when it takes effect', async () => {
    const user = userEvent.setup();

    world({ bindings: [aNeonBinding()] });
    server.use(
      http.post(`${BINDINGS}/neon/reset`, () => HttpResponse.json(anOperation, { status: 202 })),
    );
    render();

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset preview database' }));
    expect(await screen.findByText(RESET_NOTICE)).toBeInTheDocument();
  });

  it('offers no reset to a reader without project:files.write', async () => {
    world({ bindings: [aNeonBinding()] });
    render(['project:read']);

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset preview database' })).toBeNull();
  });

  it('a refused bind names the reason', async () => {
    const user = userEvent.setup();

    world();
    server.use(
      http.put(`${BINDINGS}/neon`, () =>
        problemResponse('conflict', 409, { reason: 'needs-reauth' }),
      ),
    );
    render();

    await screen.findByRole('option', { name: 'acme-db' });
    await user.selectOptions(screen.getByLabelText('Neon project'), 'proj-1');
    await user.click(screen.getByRole('button', { name: 'Create preview database' }));

    expect(
      await screen.findByText('The connection needs to be reconnected in organisation settings.'),
    ).toBeInTheDocument();
  });

  it('binds Supabase from its project list', async () => {
    const user = userEvent.setup();
    let sent: unknown;
    const supabase = aConnection('supabase');

    world({ connections: [supabase] });
    server.use(
      http.get(`${CONNECTORS}/${supabase.id}/supabase/projects`, () =>
        HttpResponse.json({
          items: [{ name: 'Shop', ref: 'abcref', region: 'eu-west-1', status: 'ACTIVE_HEALTHY' }],
        }),
      ),
      http.put(`${BINDINGS}/supabase`, async ({ request }) => {
        sent = await request.json();

        return HttpResponse.json({
          ...aNeonBinding('provisioning'),
          config: { projectRef: 'abcref' },
          provider: 'supabase',
          resources: [],
        });
      }),
    );
    render();

    await screen.findByRole('option', { name: 'Shop (eu-west-1)' });
    await user.selectOptions(screen.getByLabelText('Supabase project'), 'abcref');
    await user.click(screen.getByRole('button', { name: 'Use this project' }));

    await waitFor(() => {
      expect(sent).toEqual({ projectRef: 'abcref' });
    });
  });

  describe('connection health (spec 030 US6)', () => {
    it('shows the needs-reauth banner on the provider whose connection needs it, and only there', async () => {
      world({
        connections: [{ ...aConnection('neon'), health: 'needs_reauth' }, aConnection('supabase')],
      });
      render();

      expect(
        await screen.findByText(/The Neon connection needs to be reconnected/u),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Supabase connection needs to be reconnected/u)).toBeNull();
      expect(screen.getByRole('button', { name: 'Create preview database' })).toBeDisabled();
      expect(screen.getByLabelText('Neon project')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Reconnect Supabase' })).toBeNull();
    });

    it('shows the unavailable banner while a provider circuit is open', async () => {
      world({
        connections: [aConnection('neon'), { ...aConnection('supabase'), health: 'unavailable' }],
      });
      render();

      expect(await screen.findByText(/Supabase is not answering right now/u)).toBeInTheDocument();
      expect(screen.queryByText(/Neon is not answering/u)).toBeNull();
    });

    it('shows no banner for a healthy connection', async () => {
      world({ connections: [aConnection('neon'), aConnection('supabase')] });
      render();

      await screen.findByText('Neon preview database');
      expect(screen.queryAllByRole('alert')).toEqual([]);
    });
  });
});

function aNetlifyBinding(state: 'bound' | 'disconnected' = 'bound'): Binding {
  return {
    boundBy: ACTOR,
    config: { siteId: 'site-new', siteName: 'my-site', siteUrl: 'https://my-site.netlify.app' },
    connectionId: NETLIFY_CONNECTION_ID,
    createdAt: '2026-09-21T08:00:00.000Z',
    id: '8b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5e',
    latestOperation: null,
    projectId: PROJECT_ID,
    provider: 'netlify',
    resources: [],
    state,
    updatedAt: '2026-09-21T08:00:00.000Z',
  };
}

/** Spec 030 T086: the Netlify site a project publishes to — picked, or created now. */
describe('IntegrationsPanel — Netlify', () => {
  function netlifyWorld(bindings: Binding[] = []) {
    world({ bindings, connections: [aConnection('netlify')] });
    server.use(
      http.get(`${CONNECTORS}/${NETLIFY_CONNECTION_ID}/netlify/sites`, () =>
        HttpResponse.json({
          items: [{ id: 'site-1', name: 'acme-site', url: 'https://acme-site.netlify.app' }],
        }),
      ),
    );
  }

  it('binds to an existing site from the picker', async () => {
    const user = userEvent.setup();
    let sent: unknown;

    netlifyWorld();
    server.use(
      http.put(`${BINDINGS}/netlify`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(aNetlifyBinding());
      }),
    );
    render();

    await screen.findByRole('option', { name: 'acme-site' });
    await user.selectOptions(screen.getByLabelText('Netlify site'), 'site-1');
    await user.click(screen.getByRole('button', { name: 'Use this site' }));

    await waitFor(() => {
      expect(sent).toEqual({ siteId: 'site-1' });
    });
  });

  it('creates a new site by a valid name, and says when the name is taken', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];

    netlifyWorld();
    server.use(
      http.put(`${BINDINGS}/netlify`, async ({ request }) => {
        sent.push(await request.json());
        return problemResponse('conflict', 409, { reason: 'provider-refused' });
      }),
    );
    render();

    const name = await screen.findByLabelText('New site name');
    await user.type(name, 'Bad Name');
    expect(screen.getByRole('button', { name: 'Create site' })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'my-site');
    await user.click(screen.getByRole('button', { name: 'Create site' }));

    await waitFor(() => {
      expect(sent).toEqual([{ createSite: { name: 'my-site' } }]);
    });
    expect(await screen.findByText('The provider refused the request.')).toBeInTheDocument();
  });

  it('shows the bound site, and a site gone at Netlify as disconnected', async () => {
    netlifyWorld([aNetlifyBinding('disconnected')]);
    render();

    expect(await screen.findByRole('link', { name: 'my-site' })).toHaveAttribute(
      'href',
      'https://my-site.netlify.app',
    );
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText(/site no longer exists/u)).toBeInTheDocument();
  });

  describe('Resend (US5)', () => {
    function aResendBinding(
      domainStatus: string | null,
      key: 'live' | 'provisioning' | undefined,
    ): Binding {
      return {
        boundBy: ACTOR,
        config: { domainId: 'dom-1', domainName: 'mail.acme.test' },
        connectionId: RESEND_CONNECTION_ID,
        createdAt: '2026-09-21T08:00:00.000Z',
        domainStatus,
        id: anOperation.bindingId!,
        latestOperation: null,
        projectId: PROJECT_ID,
        provider: 'resend',
        resources:
          key === undefined
            ? []
            : [{ kind: 'resend_sending_key', name: `forge-${PROJECT_ID}`, state: key }],
        state: 'bound',
        updatedAt: '2026-09-21T08:00:00.000Z',
      };
    }

    function resendWorld(bindings: Binding[] = []) {
      world({ bindings, connections: [aConnection('resend')] });
      server.use(
        http.get(`${CONNECTORS}/${RESEND_CONNECTION_ID}/resend/domains`, () =>
          HttpResponse.json({
            items: [
              { id: 'dom-1', name: 'mail.acme.test', status: 'verified' },
              { id: 'dom-2', name: 'news.acme.test', status: 'pending' },
            ],
          }),
        ),
      );
    }

    it('says there is nothing to bind through without a Resend connection', async () => {
      world({ connections: [] });
      render();

      expect(await screen.findByText(/No Resend connection/u)).toBeInTheDocument();
    });

    it("binds a domain from the picker, which shows each domain's verification state", async () => {
      const user = userEvent.setup();
      let sent: unknown;
      let bound: Binding[] = [];

      resendWorld();
      server.use(
        http.get(BINDINGS, () => HttpResponse.json({ items: bound })),
        http.put(`${BINDINGS}/resend`, async ({ request }) => {
          sent = await request.json();
          bound = [aResendBinding(null, 'provisioning')];

          return HttpResponse.json(bound[0]);
        }),
      );
      render();

      expect(
        await screen.findByRole('option', { name: 'news.acme.test (Verifying…)' }),
      ).toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText('Sending domain'), 'dom-1');
      await user.click(screen.getByRole('button', { name: 'Use this domain' }));

      await waitFor(() => {
        expect(sent).toEqual({ domainId: 'dom-1' });
      });
      expect(await screen.findByText('Creating…')).toBeInTheDocument();
    });

    it('a pending domain shows its state and that no key exists yet', async () => {
      resendWorld([aResendBinding('pending', undefined)]);
      render();

      expect(await screen.findByText('mail.acme.test')).toBeInTheDocument();
      expect(screen.getByText('Verifying…')).toBeInTheDocument();
      expect(screen.getByText(RESEND_WAITING)).toBeInTheDocument();
      expect(screen.queryByText(DISCLOSURE)).toBeNull();
    });

    it('a live sending key shows verified, ready and the disclosure — never the key', async () => {
      resendWorld([aResendBinding(null, 'live')]);
      render();

      expect(await screen.findByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
      expect(screen.queryByText(/re_/u)).toBeNull();
    });

    it('unbind asks for the release', async () => {
      const user = userEvent.setup();
      let released = false;

      resendWorld([aResendBinding(null, 'live')]);
      server.use(
        http.delete(`${BINDINGS}/resend`, () => {
          released = true;
          return HttpResponse.json({ ...anOperation, kind: 'resource_release' }, { status: 202 });
        }),
      );
      render();

      await screen.findByText('Verified');
      const section = screen.getByRole('heading', { name: 'Resend' }).parentElement!;
      await user.click(within(section).getByRole('button', { name: 'Unbind' }));

      // Nothing is sent until the dialog, which says what goes, is confirmed.
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/sending key is deleted at Resend/u)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(released).toBe(false);

      await user.click(within(section).getByRole('button', { name: 'Unbind' }));
      await user.click(await screen.findByRole('button', { name: 'Unbind Resend' }));

      await waitFor(() => {
        expect(released).toBe(true);
      });
    });
  });
});

/** The bound database's SQL migrations: listed from the files, applied in version order. */
describe('IntegrationsPanel — migrations', () => {
  const INIT = '20260101000000';
  const TODOS = '20260201000000';
  const USERS = '20260301000000';

  function migrationsWorld(role = 'owner') {
    world({ bindings: [aNeonBinding()], role });
    server.use(
      http.get(`${BINDINGS}/neon/migrations`, () =>
        HttpResponse.json({ applied: [INIT], directory: 'db/migrations' }),
      ),
      http.get(FILES, () =>
        HttpResponse.json({
          entries: [
            { kind: 'file', name: `${USERS}_users.sql`, size: 10 },
            { kind: 'file', name: `${INIT}_init.sql`, size: 10 },
            { kind: 'file', name: 'README.md', size: 10 },
            { kind: 'file', name: `${TODOS}_todos.sql`, size: 10 },
          ],
          path: 'db/migrations',
        }),
      ),
      http.get(`${FILES}/content`, ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';

        return HttpResponse.json({
          baseCheckpointId: '22222222-2222-4222-8222-222222222222',
          bytes: 10,
          content: `-- ${path}`,
          path,
          renderable: true,
        });
      }),
    );
  }

  it('lists each file applied or pending, applies the pending in order, and names a failure', async () => {
    const user = userEvent.setup();
    let sent: unknown;

    migrationsWorld();
    server.use(
      http.post(`${BINDINGS}/neon/migrations`, async ({ request }) => {
        sent = await request.json();

        return HttpResponse.json({
          applied: [TODOS],
          failed: { message: 'relation "users" already exists', version: USERS },
          skipped: [],
        });
      }),
    );
    render();

    const list = await screen.findByRole('list', { name: 'Migrations' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      `Applied${INIT}_init.sql`,
      `Pending${TODOS}_todos.sql`,
      `Pending${USERS}_users.sql`,
    ]);
    expect(screen.getByText(/apply to the preview database/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply 2 pending' }));

    expect(
      await screen.findByText(`${USERS} failed: relation "users" already exists`),
    ).toBeInTheDocument();
    expect(sent).toEqual({
      migrations: [
        { name: 'todos', sql: `-- db/migrations/${TODOS}_todos.sql`, version: TODOS },
        { name: 'users', sql: `-- db/migrations/${USERS}_users.sql`, version: USERS },
      ],
    });
  });

  it('asks for the preview while the sandbox is asleep', async () => {
    world({ bindings: [aNeonBinding()] });
    server.use(
      http.get(FILES, () =>
        problemResponse('conflict', 409, { extensions: { kind: 'sandbox-not-ready' } }),
      ),
    );
    render();

    expect(await screen.findByText(MIGRATIONS_ASLEEP)).toBeInTheDocument();
  });

  it('says when the database is not ready yet (409 not-ready)', async () => {
    world({ bindings: [aNeonBinding()] });
    server.use(
      http.get(`${BINDINGS}/neon/migrations`, () =>
        problemResponse('conflict', 409, { reason: 'not-ready' }),
      ),
    );
    render();

    expect(
      await screen.findByText('The database is not ready yet; try again once it is.'),
    ).toBeInTheDocument();
  });

  it('links a missing permission (422 missing-scope) to settings', async () => {
    world({ bindings: [aNeonBinding()] });
    server.use(
      http.get(`${BINDINGS}/neon/migrations`, () =>
        problemResponse('validation-failed', 422, { reason: 'missing-scope' }),
      ),
    );
    render();

    expect(await screen.findByText(/missing a permission/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open settings' })).toHaveAttribute(
      'href',
      '/settings/connectors',
    );
  });

  it('says there are none while the directory does not exist', async () => {
    world({ bindings: [aNeonBinding()] });
    render();

    expect(await screen.findByText(NO_MIGRATIONS)).toBeInTheDocument();
  });

  it('shows a member the list but no apply, unbind or bind controls', async () => {
    migrationsWorld('member');
    render();

    await screen.findByRole('list', { name: 'Migrations' });
    expect(screen.queryByRole('button', { name: /Apply/u })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unbind' })).toBeNull();
    expect(screen.getByText(/Only organisation owners and admins/u)).toBeInTheDocument();
  });

  it('hides the bind form from a member', async () => {
    world({ role: 'member' });
    render();

    await screen.findByText('Neon preview database');
    expect(screen.queryByLabelText('Neon project')).toBeNull();
  });
});

/** The resource pickers' loading, error, empty and paged states. */
describe('IntegrationsPanel — pickers', () => {
  it('offers a retry when the list fails, and fills it in once it answers', async () => {
    const user = userEvent.setup();
    let fail = true;

    world();
    server.use(
      http.get(`${CONNECTORS}/${NEON_CONNECTION_ID}/neon/projects`, () =>
        fail ? problemResponse('provider-unavailable', 503) : HttpResponse.json(NEON_PROJECTS),
      ),
    );
    render();

    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    await user.click(retry);

    expect(await screen.findByRole('option', { name: 'acme-db' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says when the account has nothing to pick', async () => {
    world({ connections: [aConnection('netlify')] });
    server.use(
      http.get(`${CONNECTORS}/${NETLIFY_CONNECTION_ID}/netlify/sites`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    render();

    expect(await screen.findByText('This Netlify account has no sites yet.')).toBeInTheDocument();
  });

  it('loads the next page by its cursor', async () => {
    const user = userEvent.setup();

    world();
    server.use(
      http.get(`${CONNECTORS}/${NEON_CONNECTION_ID}/neon/projects`, ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'page-2'
          ? HttpResponse.json({
              items: [{ ...NEON_PROJECTS.items[0]!, id: 'proj-2', name: 'second-db' }],
            })
          : HttpResponse.json({ ...NEON_PROJECTS, nextCursor: 'page-2' }),
      ),
    );
    render();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('option', { name: 'second-db' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'acme-db' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

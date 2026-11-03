import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, modelCatalogue, server, subscriptionHandler } from '@/test/server';
import { WorkspaceHomePage } from './workspace-home-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

const WORKSPACE_ID = '5b1c9e3a-7d2f-4a6b-9c8d-1e2f3a4b5c6d';
const NEW_PROJECT_ID = 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c';

const aProject = {
  createdAt: '2026-08-18T10:00:00.000Z',
  id: '8f14e45f-ceea-4b73-a5f1-0d1a4e2f9c11',
  name: 'On-call rota dashboard',
  permissions: [],
};

function tenancy(options: { members?: number; orgs?: unknown[]; projects?: unknown[] } = {}) {
  const { members = 1, orgs = [anOrg], projects = [aProject] } = options;

  return [
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs })),
    http.get(`${API}/orgs/:orgId/projects`, () => HttpResponse.json({ projects })),
    http.get(`${API}/orgs/:orgId/workspaces`, () =>
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
    http.get(`${API}/orgs/:orgId/members`, () =>
      HttpResponse.json({
        members: Array.from({ length: members }, (_, index) => ({
          acceptedAt: '2026-08-01T09:00:00.000Z',
          email: `person${String(index)}@blinto.co`,
          invitedAt: '2026-08-01T09:00:00.000Z',
          role: 'member',
          userId: `00000000-0000-4000-8000-00000000000${String(index)}`,
        })),
      }),
    ),
  ];
}

/** Stands in for the project page: says where it is, and what rode in with it (spec 011 US6). */
function ProjectPageStub(): React.JSX.Element {
  const state: unknown = useLocation().state;

  return (
    <p>
      Project page for {NEW_PROJECT_ID}
      <output data-testid="handoff">{JSON.stringify(state)}</output>
    </p>
  );
}

function renderPage(): void {
  renderScreen(<WorkspaceHomePage />, {
    routes: { '/projects/:projectId': <ProjectPageStub /> },
  });
}

/** The create handler every navigation test needs. */
function projectCreated() {
  return http.post(`${API}/orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/projects`, () =>
    HttpResponse.json(
      {
        project: {
          createdAt: '2026-08-18T10:00:00.000Z',
          id: NEW_PROJECT_ID,
          name: 'A weekly on-call rota board',
          permissions: [],
        },
      },
      { status: 201 },
    ),
  );
}

describe('WorkspaceHomePage', () => {
  beforeEach(() => {
    server.use(...tenancy());
  });

  it('lists the projects the API returned', async () => {
    renderPage();

    const shelf = await screen.findByRole('region', { name: 'Projects' });

    expect(
      await within(shelf).findByRole('heading', { name: 'On-call rota dashboard' }),
    ).toBeVisible();
  });

  it('names the active organisation in the sidebar, with its seat count', async () => {
    server.use(...tenancy({ members: 3 }));
    renderPage();

    expect(await screen.findByText('Blinto')).toBeVisible();
    expect(await screen.findByText(/3 members/)).toBeVisible();
  });

  it('falls back to the caller’s role when the member list is refused', async () => {
    // `org:members.read` is not held by every role. A plain member should read as restricted, not
    // as an organisation with no people in it.
    // The override goes first: within one `server.use` call msw checks handlers in order and the
    // first match wins, so a general handler listed ahead of a specific one shadows it.
    server.use(
      http.get(`${API}/orgs/:orgId/members`, () => problemResponse('permission-denied', 403)),
      ...tenancy(),
    );
    renderPage();

    expect(await screen.findByText(/You are an owner/)).toBeVisible();
  });

  it('shows the create-organisation screen to an account in none', async () => {
    // `GET /orgs` answers 200 with an empty array rather than a 404 precisely so this exists.
    server.use(...tenancy({ orgs: [] }));
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Create your organisation' }),
    ).toBeInTheDocument();
  });

  /** Spec 031 FR-035: a guest's home is the projects shared with them and nothing of the org. */
  it('shows a guest the projects shared with them and nothing else of the org', async () => {
    const asked: string[] = [];

    server.use(
      http.get(`${API}/orgs/:orgId/members`, () => {
        asked.push('members');

        return problemResponse('permission-denied', 403);
      }),
      http.get(`${API}/orgs/:orgId/workspaces`, () => {
        asked.push('workspaces');

        return problemResponse('permission-denied', 403);
      }),
      ...tenancy({ orgs: [{ ...anOrg, access: 'guest', role: null }] }),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: 'On-call rota dashboard' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Shared with you' })).toBeVisible();
    expect(screen.queryByText(/members?$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new project/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/describe the internal tool/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Create your organisation' }),
    ).not.toBeInTheDocument();
    expect(asked).toEqual([]);
  });

  it('still shows create-an-org to someone with neither membership nor grant', async () => {
    server.use(...tenancy({ orgs: [] }));
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Create your organisation' }),
    ).toBeInTheDocument();
  });

  it('offers a retry when the project listing fails', async () => {
    server.use(
      http.get(`${API}/orgs/:orgId/projects`, () => problemResponse('service-unavailable', 503)),
      ...tenancy(),
    );
    renderPage();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(/temporarily unavailable/i);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('shows the model picker at rest and the starter prompts once the composer is engaged', async () => {
    const user = userEvent.setup();

    renderPage();

    // The picker is who pays, so it is always there; the starter prompts wait to be wanted.
    expect(await screen.findByRole('button', { name: /Sonnet 5.*change model/ })).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Starter prompts' })).not.toBeInTheDocument();

    await user.click(await screen.findByLabelText(/describe the internal tool/i));

    expect(screen.getByRole('list', { name: 'Starter prompts' })).toBeVisible();
  });

  /** Spec 007: the composer creates a project in the first workspace and lands on it. */
  it('submitting a prompt creates a project named by its first line and opens it', async () => {
    const user = userEvent.setup();
    let sent: unknown;

    server.use(
      http.post(
        `${API}/orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/projects`,
        async ({ request }) => {
          sent = await request.json();

          return HttpResponse.json(
            {
              project: {
                createdAt: '2026-08-18T10:00:00.000Z',
                id: NEW_PROJECT_ID,
                name: 'A weekly on-call rota board',
                permissions: [],
              },
            },
            { status: 201 },
          );
        },
      ),
    );
    renderPage();

    await user.type(
      await screen.findByLabelText(/describe the internal tool/i),
      'A weekly on-call rota board{Shift>}{Enter}{/Shift}for the platform team{Enter}',
    );

    expect(await screen.findByText(`Project page for ${NEW_PROJECT_ID}`)).toBeVisible();
    expect(sent).toEqual({ name: 'A weekly on-call rota board', template: 'vite-react' });
  });

  it('creates with the template chosen in the picker rather than the catalogue default', async () => {
    const user = userEvent.setup();
    let sent: unknown;

    server.use(
      http.post(
        `${API}/orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/projects`,
        async ({ request }) => {
          sent = await request.json();

          return HttpResponse.json(
            {
              project: {
                createdAt: '2026-08-18T10:00:00.000Z',
                id: NEW_PROJECT_ID,
                name: 'A weekly on-call rota board',
                permissions: [],
              },
            },
            { status: 201 },
          );
        },
      ),
    );
    renderPage();

    // Typed first: the picker lives in the engaged composer, and a prompt keeps it engaged after
    // the menu closes on the pick.
    const composer = await screen.findByLabelText(/describe the internal tool/i);
    await user.type(composer, 'A weekly on-call rota board');
    await user.click(await screen.findByRole('button', { name: /Vite \+ React/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Next\.js/ }));

    expect(screen.getByRole('button', { name: /Next\.js/ })).toBeVisible();

    await user.type(composer, '{Enter}');

    expect(await screen.findByText(`Project page for ${NEW_PROJECT_ID}`)).toBeVisible();
    expect(sent).toEqual({ name: 'A weekly on-call rota board', template: 'nextjs' });
  });

  it('shows the refusal under the composer and stays put when creation is refused', async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${API}/orgs/:orgId/workspaces/:workspaceId/projects`, () =>
        problemResponse('permission-denied', 403),
      ),
    );
    renderPage();

    await user.type(
      await screen.findByLabelText(/describe the internal tool/i),
      'A weekly on-call rota board{Enter}',
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not have permission/i);
    expect(screen.queryByText(/Project page for/)).not.toBeInTheDocument();
  });

  it('offers the models the API reports and defaults to its default', async () => {
    // Spec 011 US6 / 020 § 2: the list is `GET /orgs/:orgId/models`'s, not a file in this app.
    // Nothing here names a model the handler did not.
    const user = userEvent.setup();

    server.use(
      http.get(`${API}/orgs/:orgId/models`, () =>
        HttpResponse.json({
          default: 'claude-haiku-4-5',
          models: modelCatalogue.models.filter((model) => model.id !== 'claude-opus-5'),
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Haiku 4\.5.*change model/ }));

    const list = await screen.findByRole('listbox', { name: 'Models' });

    expect(within(list).getByRole('option', { name: 'Claude Sonnet 5' })).toBeVisible();
    expect(within(list).getByRole('option', { name: 'Claude Haiku 4.5' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(list).queryByRole('option', { name: /Opus/ })).not.toBeInTheDocument();
  });

  it('lists every key under API keys and keeps a stale key listed but not pickable', async () => {
    // 020 US2: an OpenAI key makes that provider's models appear; a `needs_reauth` key leaves the
    // entry listed but not pickable, with the reason in place of the description.
    const user = userEvent.setup();

    server.use(
      http.get(`${API}/orgs/:orgId/models`, () =>
        HttpResponse.json({
          default: 'claude-sonnet-5',
          models: [
            ...modelCatalogue.models,
            {
              available: false,
              credentialMode: 'BYOK',
              description: "Balanced — OpenAI's default for building",
              id: 'gpt-5.2',
              name: 'GPT-5.2',
              provider: 'openai',
              shortName: 'GPT-5.2',
            },
            {
              available: true,
              credentialMode: 'BYOK',
              description: 'Fastest · good for small edits',
              id: 'gpt-5-mini',
              name: 'GPT-5 mini',
              provider: 'openai',
              shortName: 'GPT-5 mini',
            },
          ],
        }),
      ),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Sonnet 5.*change model/ }));

    const keys = within(await screen.findByRole('listbox', { name: 'Models' })).getByRole('group', {
      name: 'API keys',
    });

    expect(within(keys).getByRole('option', { name: 'GPT-5 mini' })).toBeVisible();

    const stale = within(keys).getByRole('option', { name: 'GPT-5.2' });

    expect(stale).toHaveAttribute('aria-disabled', 'true');
    expect(stale).toHaveAccessibleDescription("The organisation's key needs replacing in Settings");

    await user.click(stale);
    expect(within(keys).getByRole('option', { name: 'GPT-5.2' })).toBeVisible();

    await user.click(within(keys).getByRole('option', { name: 'GPT-5 mini' }));

    expect(screen.getByRole('button', { name: /GPT-5 mini.*change model/ })).toBeVisible();
  });

  it("FR-014: names the organisation's credential, and why, when personal subscriptions are off", async () => {
    // Spec 032 US7: the caller linked a Claude subscription, but the organisation forbids them, so
    // the catalogue answers BYOK and the composer says so before anything runs.
    server.use(
      http.get(`${API}/orgs/:orgId/settings/personal-accounts`, () =>
        HttpResponse.json({ allowed: false }),
      ),
      http.get(`${API}/me/linked-accounts`, () =>
        HttpResponse.json({
          accounts: [
            {
              accountLabel: 'ada@example.com',
              health: 'healthy',
              lastCheckedAt: '2026-09-24T09:00:00.000Z',
              limitedUntil: null,
              linkedAt: '2026-09-24T09:00:00.000Z',
              provider: 'anthropic',
            },
          ],
          offered: ['anthropic'],
        }),
      ),
      http.get(`${API}/orgs/:orgId/models`, () =>
        HttpResponse.json({
          ...modelCatalogue,
          models: modelCatalogue.models.map((model) => ({ ...model, credentialMode: 'BYOK' })),
        }),
      ),
    );
    renderPage();

    expect(
      await screen.findByText('Personal subscriptions are turned off in this organisation.'),
    ).toBeVisible();
    expect(screen.getByTestId('credential-preflight')).toHaveTextContent(
      "Runs on the organisation's key",
    );
  });

  it('navigates with the chosen model and the prompt', async () => {
    const user = userEvent.setup();

    server.use(projectCreated());
    renderPage();

    const composer = await screen.findByLabelText(/describe the internal tool/i);
    await user.type(composer, 'A rota board');
    await user.click(await screen.findByRole('button', { name: /Sonnet 5.*change model/ }));
    await user.click(await screen.findByRole('option', { name: 'Claude Opus 5' }));

    expect(screen.getByRole('button', { name: /Opus 5.*change model/ })).toBeVisible();

    await user.type(composer, '{Enter}');

    expect(await screen.findByText(`Project page for ${NEW_PROJECT_ID}`)).toBeVisible();
    expect(JSON.parse(screen.getByTestId('handoff').textContent ?? '')).toEqual({
      choice: { model: 'claude-opus-5', source: 'catalogue' },
      prompt: 'A rota board',
    });
  });

  it("hands over the person's own Claude subscription when it is connected", async () => {
    const user = userEvent.setup();

    server.use(
      projectCreated(),
      subscriptionHandler({
        models: [{ description: null, id: 'opus', label: 'Opus' }],
        plan: 'Max',
        state: 'connected',
      }),
    );
    renderPage();

    expect(await screen.findByTestId('credential-preflight')).toHaveTextContent(
      'Runs on your Claude subscription',
    );
    await user.type(
      await screen.findByLabelText(/describe the internal tool/i),
      'A rota board{Enter}',
    );

    expect(await screen.findByText(`Project page for ${NEW_PROJECT_ID}`)).toBeVisible();
    expect(JSON.parse(screen.getByTestId('handoff').textContent ?? '')).toEqual({
      choice: { model: 'opus', source: 'subscription' },
      prompt: 'A rota board',
    });
  });

  it('offers to connect, and creates nothing, when nothing can pay for a run', async () => {
    // Spec 043: no connected subscription and an empty catalogue. A project created now would
    // only open on a refusal, so the composer says how to fix it instead — and is not an error.
    const user = userEvent.setup();
    let created = 0;

    server.use(
      http.get(`${API}/orgs/:orgId/models`, () => HttpResponse.json({ default: null, models: [] })),
      http.post(`${API}/orgs/:orgId/workspaces/:workspaceId/projects`, () => {
        created += 1;

        return problemResponse('internal', 500);
      }),
    );
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Connect your Claude subscription' }),
    ).toBeVisible();
    await user.type(
      await screen.findByLabelText(/describe the internal tool/i),
      'A rota board{Enter}',
    );

    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
    expect(created).toBe(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the command palette from the keyboard and filters as you type', async () => {
    const user = userEvent.setup();

    renderPage();
    await screen.findByRole('heading', { name: 'On-call rota dashboard' });

    await user.keyboard('{Control>}k{/Control}');

    const search = await screen.findByRole('combobox');

    await user.type(search, 'rota');

    const results = screen.getByRole('listbox');

    expect(within(results).getByRole('option', { name: /On-call rota dashboard/ })).toBeVisible();
    expect(within(results).queryByRole('option', { name: /Expense/ })).not.toBeInTheDocument();
  });
});

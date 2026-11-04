import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GITHUB_AUTHORIZE_KEY } from '@/features/project/lib/github-sync';
import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { GithubAuthorizedPage } from './github-authorized-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const AUTHORIZED = `${API}/orgs/${ORG_ID}/projects/${PROJECT_ID}/repo-link/authorized`;
const RETURN_TO = `/projects/${PROJECT_ID}?panel=github`;
const PATH = `${routes.githubAuthorized}?code=c0de&state=st4te`;

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

function remember(): void {
  window.sessionStorage.setItem(
    GITHUB_AUTHORIZE_KEY,
    JSON.stringify({ projectId: PROJECT_ID, returnTo: RETURN_TO }),
  );
}

function renderPage(path = PATH) {
  return renderScreen(
    <StrictMode>
      <GithubAuthorizedPage />
    </StrictMode>,
    {
      path,
      routes: {
        [routes.home]: <p>Home</p>,
        [routes.project]: <p>The project</p>,
      },
    },
  );
}

beforeEach(() => {
  server.use(http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })));
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('GithubAuthorizedPage', () => {
  it('hands over the code exactly once under a double effect, then returns to the project', async () => {
    const bodies: unknown[] = [];

    remember();
    server.use(
      http.post(AUTHORIZED, async ({ request }) => {
        bodies.push(await request.json());

        return HttpResponse.json({});
      }),
    );

    renderPage();

    expect(await screen.findByText('The project')).toBeInTheDocument();
    expect(bodies).toEqual([{ code: 'c0de', state: 'st4te' }]);
    expect(window.sessionStorage.getItem(GITHUB_AUTHORIZE_KEY)).toBeNull();
  });

  it('says so when the tab no longer knows the project, and spends nothing', async () => {
    let called = false;

    server.use(
      http.post(AUTHORIZED, () => {
        called = true;

        return HttpResponse.json({});
      }),
    );

    renderPage();

    expect(await screen.findByText(/no longer knows which project/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to your projects' })).toHaveAttribute(
      'href',
      routes.home,
    );
    await waitFor(() => {
      expect(called).toBe(false);
    });
  });

  it('treats storage that was not written by the panel as missing', async () => {
    window.sessionStorage.setItem(GITHUB_AUTHORIZE_KEY, '{not json');

    renderPage();

    expect(await screen.findByText(/no longer knows which project/u)).toBeInTheDocument();
  });

  it('never follows a stored return path off this origin', async () => {
    window.sessionStorage.setItem(
      GITHUB_AUTHORIZE_KEY,
      JSON.stringify({ projectId: PROJECT_ID, returnTo: '//evil.com' }),
    );
    server.use(http.post(AUTHORIZED, () => HttpResponse.json({})));

    renderPage();

    expect(await screen.findByText('The project')).toBeInTheDocument();
  });

  it('shows a refused state with a way back to the project', async () => {
    remember();
    server.use(http.post(AUTHORIZED, () => problemResponse('oauth-state-invalid', 400)));

    renderPage();

    expect(
      await screen.findByText('That sign-in took too long. Please start again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the project' })).toHaveAttribute(
      'href',
      RETURN_TO,
    );
  });

  it('words a refusal that carries a sync reason', async () => {
    remember();
    server.use(
      http.post(AUTHORIZED, () => problemResponse('conflict', 409, { reason: 'account-mismatch' })),
    );

    renderPage();

    expect(await screen.findByText(/not the one connected here/u)).toBeInTheDocument();
  });

  it('says nothing was created when GitHub came back without a code', async () => {
    remember();

    renderPage(`${routes.githubAuthorized}?error=access_denied`);

    expect(await screen.findByText(/Nothing was created/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the project' })).toBeInTheDocument();
  });
});

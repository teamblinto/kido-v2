import { mcpAuthorizationPreviewSchema, mcpAuthorizationRedirectSchema } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { OauthAuthorizePage } from './oauth-authorize-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const CLIENT_ID = '7d9f2c1e-4b3a-4c5d-8e6f-1a2b3c4d5e6f';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://localhost:33418/callback';
const PATH =
  `/oauth/authorize?response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}` +
  `&code_challenge_method=S256&state=xyz&scope=projects%3Aread&unknown=dropped`;

const REQUEST = {
  clientId: CLIENT_ID,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: 'S256',
  redirectUri: REDIRECT,
  responseType: 'code',
  scope: 'projects:read',
  state: 'xyz',
};

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

const preview = mcpAuthorizationPreviewSchema.parse({
  clientName: 'Claude Code',
  clientUri: null,
  redirectHost: 'localhost:33418',
  scopes: ['projects:read', 'projects:deploy'],
});

const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, assign },
  });
  server.use(
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })),
    http.post(`${API}/oauth/authorize/preview`, () => HttpResponse.json(preview)),
  );
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  assign.mockReset();
});

function decisionHandler(): { readonly bodies: unknown[] } {
  const bodies: unknown[] = [];

  server.use(
    http.post(`${API}/oauth/authorize`, async ({ request }) => {
      const body = (await request.json()) as { decision: string };
      bodies.push(body);

      return HttpResponse.json(
        mcpAuthorizationRedirectSchema.parse({
          redirectUrl:
            body.decision === 'allow'
              ? `${REDIRECT}?code=abc&state=xyz`
              : `${REDIRECT}?error=access_denied&state=xyz`,
        }),
      );
    }),
  );

  return { bodies };
}

describe('OauthAuthorizePage', () => {
  it('sends a signed-out visitor to sign in', async () => {
    renderScreen(<OauthAuthorizePage />, {
      path: PATH,
      routes: { '/sign-in': <p>Sign in</p> },
      user: null,
    });

    expect(await screen.findByText('Sign in')).toBeInTheDocument();
  });

  it('refuses a malformed request without calling the API', async () => {
    const previewed = vi.fn();

    server.use(
      http.post(`${API}/oauth/authorize/preview`, () => {
        previewed();

        return HttpResponse.json(preview);
      }),
    );
    renderScreen(<OauthAuthorizePage />, { path: '/oauth/authorize?client_id=nope' });

    expect(screen.getByText('This authorization request cannot be used')).toBeInTheDocument();
    // Let the session and organisations settle, so a late preview call would have been made.
    await screen.findByText('This authorization request cannot be used');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(previewed).not.toHaveBeenCalled();
  });

  it('shows the client, where it redirects, the scopes and the organization', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${API}/oauth/authorize/preview`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json(preview);
      }),
    );
    renderScreen(<OauthAuthorizePage />, { path: PATH });

    expect(await screen.findByText('Claude Code wants to access your account')).toBeInTheDocument();
    expect(body).toEqual(REQUEST);
    expect(screen.getByText('localhost:33418')).toBeInTheDocument();
    expect(
      screen.getByText('See your projects, files, conversations, previews and deployments'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Deploy your projects and publish them to connected hosts'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Blinto')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('allows for the chosen organization and follows the redirect', async () => {
    const { bodies } = decisionHandler();
    renderScreen(<OauthAuthorizePage />, { path: PATH });

    await screen.findByText('Blinto');
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`${REDIRECT}?code=abc&state=xyz`);
    });
    expect(bodies).toEqual([{ decision: 'allow', orgId: ORG_ID, request: REQUEST }]);
  });

  it('denies and follows the redirect', async () => {
    const { bodies } = decisionHandler();
    renderScreen(<OauthAuthorizePage />, { path: PATH });

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=xyz`);
    });
    expect(bodies).toEqual([{ decision: 'deny', request: REQUEST }]);
  });
});

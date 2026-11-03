import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { destinationAfterSignIn } from '@/features/auth/session/route-guards';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { PreviewAuthorizePage } from './preview-authorize-page';

const LABEL = 'a3f9c2d1e8b7a6f5c4d3b2a1';
const RETURN_HOST = `${LABEL}-3000.forge-preview.localhost:3200`;
const PATH = `/preview-authorize?label=${LABEL}&return=${RETURN_HOST}`;
const NOT_FOUND = 'There is no preview here';

const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  assign.mockReset();
});

function renderAuthorize(user?: null): void {
  renderScreen(<PreviewAuthorizePage />, {
    path: PATH,
    routes: { '/sign-in': <p>Sign in</p> },
    ...(user === null ? { user } : {}),
  });
}

describe('PreviewAuthorizePage', () => {
  it('posts the label and return host, then navigates to the url it is given', async () => {
    let body: unknown = null;

    server.use(
      http.post(`${API}/preview/authorize`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json({ url: `https://${RETURN_HOST}/?code=grant-code` });
      }),
    );

    renderAuthorize();

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`https://${RETURN_HOST}/?code=grant-code`);
    });
    expect(body).toEqual({ label: LABEL, returnHost: RETURN_HOST });
  });

  it('sends a signed-out visitor to sign in, carrying this page as the return', async () => {
    renderAuthorize(null);

    expect(await screen.findByText('Sign in')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('renders the same message for an unknown label and a non-member', async () => {
    server.use(http.post(`${API}/preview/authorize`, () => problemResponse('not-found', 404)));

    renderAuthorize();

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('never calls the API for an address missing its label', () => {
    renderScreen(<PreviewAuthorizePage />, { path: '/preview-authorize' });

    expect(screen.getByText(NOT_FOUND)).toBeInTheDocument();
  });
});

describe('destinationAfterSignIn', () => {
  it('keeps the query, so the exchange resumes with its label and return host', () => {
    expect(
      destinationAfterSignIn({ from: { pathname: '/preview-authorize', search: '?label=x' } }),
    ).toBe('/preview-authorize?label=x');
  });
});

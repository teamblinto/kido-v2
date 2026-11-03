import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { CreateOrgScreen, slugify } from './create-org-screen';

describe('slugify', () => {
  it.each([
    ['Blinto', 'blinto'],
    ['Blinto Workspace', 'blinto-workspace'],
    ['  Acme  &  Co.  ', 'acme-co'],
    ['Ünïcödé', 'n-c-d'],
    ['---', ''],
  ])('turns %o into %o', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('stays inside the 63-character ceiling the contract sets', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(63);
  });
});

describe('CreateOrgScreen', () => {
  it('suggests a handle from the name, and sends both', async () => {
    const user = userEvent.setup();
    let body: unknown = null;

    server.use(
      http.post(`${API}/orgs`, async ({ request }) => {
        body = await request.json();

        return HttpResponse.json(
          {
            org: {
              createdAt: '2026-08-18T10:00:00.000Z',
              id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
              name: 'Blinto Workspace',
              plan: 'free',
              slug: 'blinto-workspace',
            },
          },
          { status: 201 },
        );
      }),
      http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [] })),
    );

    renderScreen(<CreateOrgScreen />);

    await user.type(await screen.findByLabelText('Organisation name'), 'Blinto Workspace');
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));

    // `createOrgRequestSchema` is a strict object — the API refuses anything else with a 422.
    await waitFor(() => {
      expect(body).toEqual({ name: 'Blinto Workspace', slug: 'blinto-workspace' });
    });
  });

  it('keeps a handle the user typed over the one derived from the name', async () => {
    const user = userEvent.setup();

    renderScreen(<CreateOrgScreen />);

    const slug = await screen.findByLabelText('Handle');

    await user.type(slug, 'chosen-by-hand');
    await user.type(screen.getByLabelText('Organisation name'), 'Something Else Entirely');

    expect(slug).toHaveValue('chosen-by-hand');
  });

  it('says a handle is taken rather than reporting a generic conflict', async () => {
    // The slug is globally unique and client-supplied, so the collision is a 409 the caller
    // resolves — which is the whole reason `org.ts` refused to derive it server-side.
    const user = userEvent.setup();

    server.use(http.post(`${API}/orgs`, () => problemResponse('conflict', 409)));

    renderScreen(<CreateOrgScreen />);

    await user.type(await screen.findByLabelText('Organisation name'), 'Blinto');
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/handle is already taken/i);
  });

  it('refuses to submit a name the contract would reject', async () => {
    const user = userEvent.setup();
    let called = false;

    server.use(
      http.post(`${API}/orgs`, () => {
        called = true;

        return problemResponse('validation-failed', 422);
      }),
    );

    renderScreen(<CreateOrgScreen />);

    // A name of only punctuation derives an empty slug, which `orgSlugSchema` rejects at two
    // characters. Catching it here saves a round trip and says so beside the field.
    await user.type(await screen.findByLabelText('Organisation name'), '...');
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(called).toBe(false);
  });
});

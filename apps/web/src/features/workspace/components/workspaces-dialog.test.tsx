import type { WorkspaceSummary } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { WorkspacesDialog } from './workspaces-dialog';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const WORKSPACES = `${API}/orgs/${ORG_ID}/workspaces`;

function workspace(id: string, name: string): WorkspaceSummary {
  return { createdAt: '2026-09-20T10:00:00.000Z', id, name, role: 'admin' };
}

const DEFAULT = workspace('c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c', 'Default');

function listing(rows: () => WorkspaceSummary[]) {
  return http.get(WORKSPACES, () => HttpResponse.json({ workspaces: rows() }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspacesDialog', () => {
  it('creates a workspace and refetches the list', async () => {
    const rows = [DEFAULT];
    let body: unknown;

    server.use(
      listing(() => rows),
      http.post(WORKSPACES, async ({ request }) => {
        body = await request.json();
        const created = workspace('d7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c', 'Marketing');
        rows.push(created);

        return HttpResponse.json({ workspace: created }, { status: 201 });
      }),
    );

    renderScreen(<WorkspacesDialog open orgId={ORG_ID} onOpenChange={() => undefined} />);

    expect(await screen.findByText('Default')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('New workspace'), '  Marketing ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Marketing')).toBeInTheDocument();
    expect(body).toEqual({ name: 'Marketing' });
  });

  it('renames through a prompt', async () => {
    let body: unknown;

    server.use(
      listing(() => [DEFAULT]),
      http.patch(`${WORKSPACES}/${DEFAULT.id}`, async ({ request }) => {
        body = await request.json();

        return new HttpResponse(null, { status: 204 });
      }),
    );
    vi.spyOn(window, 'prompt').mockReturnValue('Renamed');

    renderScreen(<WorkspacesDialog open orgId={ORG_ID} onOpenChange={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Rename Default' }));

    await waitFor(() => {
      expect(body).toEqual({ name: 'Renamed' });
    });
  });

  it('deletes only after a confirm, and shows a refusal', async () => {
    let deletes = 0;

    server.use(
      listing(() => [DEFAULT]),
      http.delete(`${WORKSPACES}/${DEFAULT.id}`, () => {
        deletes += 1;

        return problemResponse('permission-denied', 403);
      }),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);

    renderScreen(<WorkspacesDialog open orgId={ORG_ID} onOpenChange={() => undefined} />);

    const button = await screen.findByRole('button', { name: 'Delete Default' });
    await userEvent.click(button);
    expect(deletes).toBe(0);

    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(deletes).toBe(1);
    expect(confirm.mock.calls[0]?.[0]).toContain('archived');
  });
});

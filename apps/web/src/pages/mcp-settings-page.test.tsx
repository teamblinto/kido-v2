import { type McpGrant, mcpGrantListSchema } from '@repo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { McpSettingsPage } from './mcp-settings-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const GRANT_ID = 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c';
const GRANTS = `${API}/orgs/${ORG_ID}/mcp/grants`;

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

const grant: McpGrant = mcpGrantListSchema.parse({
  items: [
    {
      clientName: 'Cursor',
      clientUri: 'https://cursor.com/home',
      createdAt: '2026-11-01T10:00:00.000Z',
      id: GRANT_ID,
      lastUsedAt: null,
      scopes: ['projects:read', 'projects:write'],
    },
  ],
}).items[0]!;

beforeEach(() => {
  server.use(http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })));
});

describe('McpSettingsPage', () => {
  it('shows the server URL with a copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    server.use(http.get(GRANTS, () => HttpResponse.json({ items: [] })));
    renderScreen(<McpSettingsPage />, { path: '/settings/mcp' });

    const url = `${window.location.origin}/api/v1/mcp`;
    expect(screen.getByText(url)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy server URL' }));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(
      await screen.findByText('No AI agents are connected to this organization yet.'),
    ).toBeInTheDocument();
  });

  it('lists connected agents and revokes one after a confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let items = [grant];
    let deleted = false;

    server.use(
      http.get(GRANTS, () => HttpResponse.json({ items })),
      http.delete(`${GRANTS}/${GRANT_ID}`, () => {
        deleted = true;
        items = [];

        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderScreen(<McpSettingsPage />, { path: '/settings/mcp' });

    // "Cursor" is also a setup tab, so the grant is found by its host.
    expect(await screen.findByText('cursor.com')).toBeInTheDocument();
    expect(screen.getByText('projects:write')).toBeInTheDocument();
    expect(screen.getByText(/Never used/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(deleted).toBe(true);
    });
    expect(confirm.mock.calls[0]?.[0]).toContain('Cursor');
    expect(
      await screen.findByText('No AI agents are connected to this organization yet.'),
    ).toBeInTheDocument();
    confirm.mockRestore();
  });
});

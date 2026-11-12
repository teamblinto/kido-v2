import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routes } from '@/lib/routes';
import { renderScreen } from '@/test/render';
import { WorkspaceSwitcher } from './workspace-switcher';

const workspaces = [{ id: 'org-1', name: 'Blinto', plan: 'Free', seats: '1 member' }];

function renderSwitcher(): void {
  renderScreen(
    <WorkspaceSwitcher
      activeWorkspaceId="org-1"
      onSelectWorkspace={() => undefined}
      workspaces={workspaces}
    />,
    {
      routes: {
        [routes.settings]: <p>Settings page</p>,
        [routes.newOrg]: <p>New organisation page</p>,
      },
    },
  );
}

describe('WorkspaceSwitcher', () => {
  it('opens the organisation settings', async () => {
    renderSwitcher();

    await userEvent.click(screen.getByRole('button', { name: /Switch workspace/u }));
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));

    expect(await screen.findByText('Settings page')).toBeInTheDocument();
  });

  it('opens the create-an-organisation form', async () => {
    renderSwitcher();

    await userEvent.click(screen.getByRole('button', { name: /Switch workspace/u }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Create new workspace' }));

    expect(await screen.findByText('New organisation page')).toBeInTheDocument();
  });
});

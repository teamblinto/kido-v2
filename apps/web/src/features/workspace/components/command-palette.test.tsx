import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { projectPath, routes } from '@/lib/routes';
import { renderScreen } from '@/test/render';
import { CommandPalette } from './command-palette';

const project = { activity: 'Created just now', id: 'p-1', name: 'Invoice tool' };

function renderPalette(): void {
  renderScreen(
    <CommandPalette
      open
      projects={[project]}
      onNewProject={() => undefined}
      onOpenChange={() => undefined}
    />,
    {
      routes: {
        [projectPath('p-1')]: <p>Project page</p>,
        [routes.membersSettings]: <p>Members page</p>,
        [routes.accountSettings]: <p>Account page</p>,
      },
    },
  );
}

describe('CommandPalette', () => {
  it.each([
    ['Invoice tool', 'Project page'],
    ['Invite a teammate', 'Members page'],
    ['Account settings', 'Account page'],
  ])('"%s" navigates to the %s', async (item, destination) => {
    renderPalette();

    await userEvent.click(await screen.findByText(item));

    expect(await screen.findByText(destination)).toBeInTheDocument();
  });
});

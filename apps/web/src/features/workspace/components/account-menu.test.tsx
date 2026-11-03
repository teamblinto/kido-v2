import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routes } from '@/lib/routes';
import { renderScreen } from '@/test/render';
import { AccountMenu } from './account-menu';

const noop = () => undefined;

describe('AccountMenu', () => {
  it('opens the connected accounts page (spec 032 US2)', async () => {
    renderScreen(
      <AccountMenu
        account={{ email: 'rakibul@blinto.co', name: 'Rakibul' }}
        onOpenCommandPalette={noop}
        onOpenSessions={noop}
        onOpenTwoFactor={noop}
      />,
      { routes: { [routes.accountSettings]: <p>Account settings</p> } },
    );

    await userEvent.click(screen.getByRole('button', { name: /Open account menu/u }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Connected accounts' }));

    expect(await screen.findByText('Account settings')).toBeInTheDocument();
  });
});

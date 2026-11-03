import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Link } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routes } from '@/lib/routes';
import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { AccountSettingsPage } from './account-settings-page';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountSettingsPage', () => {
  it('scrolls the subscription card into view on an in-app link to its anchor', async () => {
    // The sections' own reads are not under test here.
    server.use(http.get(`${API}/*`, () => problemResponse('not-found', 404)));
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');

    renderScreen(<Link to={`${routes.accountSettings}#claude-subscription`}>Reconnect</Link>, {
      routes: { [routes.accountSettings]: <AccountSettingsPage /> },
    });
    await userEvent.click(screen.getByRole('link', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(scroll).toHaveBeenCalled();
    });
    expect(scroll.mock.contexts[0]).toHaveProperty('id', 'claude-subscription');
  });
});

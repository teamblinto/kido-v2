import {
  type SubscriptionStatus,
  type UsageRun,
  subscriptionListSchema,
  usageRunListResponseSchema,
} from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { UsageSettingsPage } from './usage-settings-page';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const RUNS = `${API}/orgs/${ORG_ID}/usage/runs`;
const MINUTE = 60_000;

const anOrg = {
  access: 'member',
  createdAt: '2026-08-01T09:00:00.000Z',
  id: ORG_ID,
  name: 'Blinto',
  plan: 'free',
  role: 'owner',
  slug: 'blinto',
};

function subscription(overrides: Partial<SubscriptionStatus> = {}) {
  return http.get(`${API}/me/subscriptions`, () =>
    HttpResponse.json(
      subscriptionListSchema.parse({
        claude: {
          message: null,
          models: null,
          plan: 'Max',
          provider: 'claude',
          signIn: null,
          state: 'connected',
          updatedAt: '2026-11-03T10:00:00.000Z',
          usage: null,
          ...overrides,
        },
      }),
    ),
  );
}

let runCount = 0;

function aRun(overrides: Partial<UsageRun> = {}): UsageRun {
  runCount += 1;

  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 12_300,
    createdAt: '2026-11-02T09:30:00.000Z',
    finishedAt: '2026-11-02T09:31:00.000Z',
    id: `00000000-0000-4000-8000-${String(runCount).padStart(12, '0')}`,
    inputTokens: 1200,
    model: 'claude-sonnet-5',
    outputTokens: 340,
    paidWith: 'subscription',
    projectId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    projectName: 'Landing page',
    status: 'succeeded',
    ...overrides,
  };
}

function page(runs: UsageRun[], nextCursor: string | null = null) {
  return HttpResponse.json(usageRunListResponseSchema.parse({ nextCursor, runs }));
}

function renderPage() {
  return renderScreen(<UsageSettingsPage />, { path: '/settings/usage' });
}

beforeEach(() => {
  runCount = 0;
  server.use(
    http.get(`${API}/orgs`, () => HttpResponse.json({ orgs: [anOrg] })),
    http.get(RUNS, () => page([])),
  );
});

describe('Settings → Usage: subscription limits', () => {
  it('draws one meter per window with its percentage, reset countdown and freshness', async () => {
    const now = Date.now();

    server.use(
      subscription({
        usage: {
          checkedAt: new Date(now - 3 * MINUTE - 1_000).toISOString(),
          windows: [
            {
              kind: 'session',
              resetsAt: new Date(now + 130 * MINUTE).toISOString(),
              utilization: 42,
            },
            { kind: 'weekly', resetsAt: null, utilization: 85.4 },
            { kind: 'weekly-opus', resetsAt: null, utilization: 10 },
          ],
        },
      }),
    );
    renderPage();

    const session = await screen.findByRole('progressbar', { name: 'Current session' });

    expect(session).toHaveAttribute('aria-valuenow', '42');
    expect(session).toHaveAttribute('aria-valuemax', '100');
    expect(session).toHaveAttribute('aria-valuetext', '42% used, Resets in 2 h 10 min');
    expect(screen.getByText('Resets in 2 h 10 min')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'This week' })).toHaveAttribute(
      'aria-valuetext',
      '85% used',
    );
    expect(screen.getByRole('progressbar', { name: 'This week · Opus' })).toBeInTheDocument();
    expect(screen.getByText('Updated 3 min ago')).toBeInTheDocument();
    expect(screen.getByText(/Claude Max/u)).toBeInTheDocument();
  });

  it('links to connecting a subscription when none is connected', async () => {
    // The shared handler answers `disconnected`.
    renderPage();

    const link = await screen.findByRole('link', { name: 'Connect your subscription' });

    expect(link).toHaveAttribute('href', '/settings/account#claude-subscription');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says so when the subscription has reported no usage yet', async () => {
    server.use(subscription({ usage: null }));
    renderPage();

    expect(await screen.findByText(/No usage reported yet/u)).toBeInTheDocument();
  });

  it('offers a retry when the limits cannot be read', async () => {
    let calls = 0;

    server.use(
      http.get(`${API}/me/subscriptions`, () => {
        calls += 1;
        return calls === 1
          ? problemResponse('internal', 500)
          : HttpResponse.json(
              subscriptionListSchema.parse({
                claude: {
                  message: null,
                  models: null,
                  plan: null,
                  provider: 'claude',
                  signIn: null,
                  state: 'connected',
                  updatedAt: '2026-11-03T10:00:00.000Z',
                  usage: { checkedAt: new Date().toISOString(), windows: [] },
                },
              }),
            );
      }),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/No usage reported yet/u)).toBeInTheDocument();
  });

  it('explains that API-key runs are billed by the key’s provider', async () => {
    renderPage();

    expect(
      await screen.findByText(/billed by that key's provider/u, { selector: 'p' }),
    ).toBeInTheDocument();
  });
});

describe('Settings → Usage: run history', () => {
  it('lists runs in an accessible table and pages with Load more', async () => {
    const cursors: (string | null)[] = [];

    server.use(
      http.get(RUNS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');

        cursors.push(cursor);

        return cursor === null
          ? page(
              [
                aRun({ cacheReadTokens: 5000, cacheWriteTokens: 200 }),
                aRun({ costMicros: null, paidWith: 'api-key', projectName: 'Shop' }),
              ],
              'next-page_1',
            )
          : page([aRun({ paidWith: 'platform-credits', projectName: 'Old blog' })]);
      }),
    );
    renderPage();

    const table = await screen.findByRole('table', { name: /Your runs in this organisation/u });

    expect(within(table).getByRole('columnheader', { name: 'Paid with' })).toHaveAttribute(
      'scope',
      'col',
    );
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('$0.0123')).toBeInTheDocument();
    expect(within(table).getByText('—')).toBeInTheDocument();
    expect(within(table).getByText('API key')).toBeInTheDocument();
    expect(within(table).getByText(/Cache 5,000 read/u)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await within(table).findByText('Platform credits (retired)')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(cursors).toEqual([null, 'next-page_1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says when there are no runs yet', async () => {
    renderPage();

    expect(await screen.findByText(/No runs yet/u)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers a retry when the history cannot be read', async () => {
    let calls = 0;

    server.use(
      http.get(RUNS, () => {
        calls += 1;
        return calls === 1 ? problemResponse('internal', 500) : page([aRun()]);
      }),
    );
    renderPage();

    const section = within(await screen.findByRole('region', { name: 'Run history' }));

    await userEvent.click(await section.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('is linked from the settings navigation', async () => {
    renderPage();

    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));

    await waitFor(() =>
      expect(nav.getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page'),
    );
    expect(nav.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/settings/usage');
  });
});

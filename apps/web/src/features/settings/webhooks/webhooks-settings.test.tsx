import {
  type WebhookDelivery,
  type WebhookDeliverySummary,
  type WebhookEndpoint,
  type WebhookSecretResponse,
  webhookDeliverySchema,
  webhookDeliverySummarySchema,
  webhookEndpointSchema,
  webhookSecretResponseSchema,
} from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { DeliveryLog } from './delivery-log';
import { EndpointsSection } from './endpoints-section';
import { ReceiverGuidance } from './receiver-guidance';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT_ID = '9b2f1c3e-7d4a-4e8b-9c1d-2e3f4a5b6c7d';
const ENDPOINTS = `${API}/orgs/${ORG_ID}/webhooks/endpoints`;

// Every body is parsed by its contract schema, so a fixture that drifts from the API fails here.
function anEndpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return webhookEndpointSchema.parse({
    createdAt: '2026-09-20T10:00:00.000Z',
    description: '',
    eventTypes: ['deploy.succeeded'],
    id: 'c7e1b2a3-4d5f-4e6a-8b9c-0d1e2f3a4b5c',
    lastFailure: null,
    lastSuccessAt: null,
    pausedAt: null,
    projectIds: [],
    secretRotation: null,
    state: 'enabled',
    url: 'https://hooks.example.com/forge',
    ...overrides,
  });
}

const SECRET = 'whsec_c2VjcmV0LXNob3duLW9uY2UtaW4tdGhlLWRpYWxvZw';

const created: WebhookSecretResponse = webhookSecretResponseSchema.parse({
  endpoint: anEndpoint({ id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }),
  secret: SECRET,
});

const pendingPing: WebhookDeliverySummary = webhookDeliverySummarySchema.parse({
  attempts: 0,
  createdAt: '2026-09-23T12:00:00.000Z',
  eventId: 'd4c3b2a1-f6e5-4b7a-9c8d-5d4c3b2a1f0e',
  eventType: 'ping',
  id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b',
  lastFailure: null,
  nextAttemptAt: '2026-09-23T12:00:00.000Z',
  projectId: null,
  state: 'pending',
});

function listing(items: () => WebhookEndpoint[]) {
  return http.get(ENDPOINTS, () => HttpResponse.json({ items: items() }));
}

beforeEach(() => {
  server.use(
    http.get(`${API}/orgs/${ORG_ID}/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            createdAt: '2026-09-01T10:00:00.000Z',
            id: PROJECT_ID,
            name: 'Marketing site',
            permissions: [],
          },
        ],
      }),
    ),
  );
});

async function fillForm(url: string, events: readonly string[]): Promise<void> {
  const form = await screen.findByRole('form', { name: 'Add endpoint' });

  await userEvent.type(within(form).getByLabelText('Endpoint URL'), url);
  for (const event of events) {
    await userEvent.click(within(form).getByRole('checkbox', { name: event }));
  }
  await userEvent.click(within(form).getByRole('button', { name: 'Add endpoint' }));
}

describe('Webhooks settings (US1)', () => {
  it('lists endpoints with their state badges', async () => {
    server.use(
      listing(() => [
        anEndpoint(),
        anEndpoint({
          id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
          state: 'disabled',
          url: 'https://two.example.com/hook',
        }),
        anEndpoint({
          id: 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f',
          pausedAt: '2026-09-22T10:00:00.000Z',
          state: 'paused',
          url: 'https://three.example.com/hook',
        }),
      ]),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    const items = await screen.findAllByRole('listitem');

    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('https://hooks.example.com/forge')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Enabled')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Disabled')).toBeInTheDocument();
    expect(within(items[2]!).getByText('Paused')).toBeInTheDocument();
  });

  it('refuses to create an endpoint with no events selected', async () => {
    let posted = false;

    server.use(
      listing(() => []),
      http.post(ENDPOINTS, () => {
        posted = true;

        return HttpResponse.json(created, { status: 201 });
      }),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    await fillForm('https://hooks.example.com/forge', []);

    expect(await screen.findByText('Choose at least one event.')).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it('shows the secret once after a create, and never again after closing', async () => {
    const items: WebhookEndpoint[] = [];
    let body: unknown;

    server.use(
      listing(() => items),
      http.post(ENDPOINTS, async ({ request }) => {
        body = await request.json();
        items.push(created.endpoint);

        return HttpResponse.json(created, { status: 201 });
      }),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    await fillForm('https://hooks.example.com/forge', ['deploy.succeeded']);

    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(SECRET)).toBeInTheDocument();
    expect(within(dialog).getByText(/you will not see this again/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(body).toEqual({
      description: '',
      eventTypes: ['deploy.succeeded'],
      projectIds: [],
      url: 'https://hooks.example.com/forge',
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findAllByRole('listitem')).toHaveLength(1);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it.each([
    ['invalid-url', /not a valid https URL/i],
    ['destination-not-allowed', /private or reserved address/i],
    ['endpoint-limit', /at most 20 endpoints/i],
    ['project-not-in-org', /project is not in this organisation/i],
  ])('renders the copy for a 409 %s', async (reason, copy) => {
    server.use(
      listing(() => []),
      http.post(ENDPOINTS, () => problemResponse('conflict', 409, { reason })),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    await fillForm('https://hooks.example.com/forge', ['deploy.succeeded']);

    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });

  it('sends a test and shows the pending delivery', async () => {
    let tested = false;

    server.use(
      listing(() => [anEndpoint()]),
      http.post(`${ENDPOINTS}/${anEndpoint().id}/test`, () => {
        tested = true;

        return HttpResponse.json(pendingPing, { status: 202 });
      }),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    const [item] = await screen.findAllByRole('listitem');

    await userEvent.click(within(item!).getByRole('button', { name: 'Send test' }));

    expect(await within(item!).findByText(/ping.*pending/i)).toBeInTheDocument();
    expect(tested).toBe(true);
  });

  it('shows a paused endpoint with when it paused and why, and enables it again (US3)', async () => {
    const PAUSED_AT = '2026-09-22T10:00:00.000Z';
    let state: WebhookEndpoint['state'] = 'paused';
    let patched: unknown = null;

    server.use(
      listing(() => [
        anEndpoint(
          state === 'paused'
            ? { lastFailure: 'timeout', pausedAt: PAUSED_AT, state }
            : { lastFailure: null, pausedAt: null, state },
        ),
      ]),
      http.patch(`${ENDPOINTS}/${anEndpoint().id}`, async ({ request }) => {
        patched = await request.json();
        state = 'enabled';

        return HttpResponse.json(anEndpoint());
      }),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    const [item] = await screen.findAllByRole('listitem');

    expect(within(item!).getByText('Paused')).toBeInTheDocument();
    expect(
      within(item!).getByText(new RegExp(`Paused since ${new Date(PAUSED_AT).toLocaleString()}`)),
    ).toBeInTheDocument();
    expect(
      within(item!).getByText(/The receiver did not answer within 10 seconds\./),
    ).toBeInTheDocument();

    await userEvent.click(within(item!).getByRole('button', { name: 'Enable' }));

    expect(patched).toEqual({ enabled: true });
    expect(await within(item!).findByText('Enabled')).toBeInTheDocument();
    expect(within(item!).queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });

  it('publishes the receiver guidance with the pinned test vector', () => {
    renderScreen(<ReceiverGuidance />);

    const steps = within(screen.getByRole('list', { name: 'Verifying a request' })).getAllByRole(
      'listitem',
    );

    expect(steps).toHaveLength(6);
    expect(screen.getByText('whsec_dGVzdC1zZWNyZXQtZm9yLWRvY3M')).toBeInTheDocument();
    expect(screen.getByText('1790000000')).toBeInTheDocument();
    expect(
      screen.getByText('{"id":"00000000-0000-0000-0000-000000000000","type":"ping"}'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('f2e4f1f25d93fe6ef14e719bdfba115887323d2217a282dadcb8dfc158463d27'),
    ).toBeInTheDocument();
  });
});

describe('Webhooks settings: secret rotation (US5)', () => {
  const ROTATED = 'whsec_cm90YXRlZC1zZWNyZXQtc2hvd24tb25jZS1vbmx5LWhlcmU';
  const UNTIL = '2026-09-24T12:00:00.000Z';

  async function rotate(expireOld: boolean) {
    let current = anEndpoint();
    let body: unknown;

    server.use(
      listing(() => [current]),
      http.post(`${ENDPOINTS}/${anEndpoint().id}/rotate-secret`, async ({ request }) => {
        body = await request.json();
        current = anEndpoint({
          secretRotation: expireOld ? null : { previousExpiresAt: UNTIL },
        });

        return HttpResponse.json(
          webhookSecretResponseSchema.parse({ endpoint: current, secret: ROTATED }),
        );
      }),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    const [item] = await screen.findAllByRole('listitem');

    if (expireOld) {
      await userEvent.click(
        within(item!).getByRole('checkbox', { name: /expire the old secret now/i }),
      );
    }
    await userEvent.click(within(item!).getByRole('button', { name: 'Rotate secret' }));

    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(ROTATED)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain(ROTATED);

    return { body, item: item! };
  }

  it('rotates, shows the new secret once, and shows when the old one stops signing', async () => {
    const { body, item } = await rotate(false);

    expect(body).toEqual({ expireOld: false });
    expect(
      await within(item).findByText(
        new RegExp(`old secret also signs until ${new Date(UNTIL).toLocaleString()}`, 'i'),
      ),
    ).toBeInTheDocument();
  });

  it('with "expire the old secret now" sends expireOld and shows no overlap', async () => {
    const { body, item } = await rotate(true);

    expect(body).toEqual({ expireOld: true });
    expect(within(item).queryByText(/old secret also signs/i)).not.toBeInTheDocument();
  });

  it('shows an overlap that is already under way', async () => {
    server.use(listing(() => [anEndpoint({ secretRotation: { previousExpiresAt: UNTIL } })]));

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    expect(await screen.findByText(/old secret also signs until/i)).toBeInTheDocument();
  });
});

describe('Webhooks settings: the delivery log (US4)', () => {
  const ENDPOINT_ID = anEndpoint().id;
  const DELIVERIES = `${ENDPOINTS}/${ENDPOINT_ID}/deliveries`;

  const failed: WebhookDeliverySummary = webhookDeliverySummarySchema.parse({
    ...pendingPing,
    attempts: 1,
    eventType: 'deploy.succeeded',
    id: 'f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b',
    lastFailure: 'http-error',
    nextAttemptAt: null,
    state: 'failed',
  });

  function detail(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
    return webhookDeliverySchema.parse({
      ...failed,
      attemptLog: [
        {
          address: '203.0.113.9',
          attemptedAt: '2026-09-23T12:00:05.000Z',
          durationMs: 42,
          failure: 'http-error',
          manual: false,
          responseBody: 'upstream exploded',
          responseHeaders: { 'x-trace': 'trace-1' },
          status: 500,
        },
      ],
      body: '{"type":"deploy.succeeded"}',
      ...overrides,
    });
  }

  it('renders the log, and the filters change the query', async () => {
    const queries: string[] = [];

    server.use(
      http.get(DELIVERIES, ({ request }) => {
        queries.push(new URL(request.url).search);

        return HttpResponse.json({ items: [failed], nextCursor: null });
      }),
    );

    renderScreen(<DeliveryLog orgId={ORG_ID} endpointId={ENDPOINT_ID} />);

    const list = await screen.findByRole('list', { name: 'Deliveries' });
    const [row] = within(list).getAllByRole('listitem');

    expect(within(row!).getByText('deploy.succeeded')).toBeInTheDocument();
    expect(within(row!).getByText('Failed')).toBeInTheDocument();
    expect(queries).toEqual(['']);

    await userEvent.selectOptions(screen.getByLabelText('State'), 'failed');
    await waitFor(() => {
      expect(queries.at(-1)).toBe('?state=failed');
    });

    await userEvent.selectOptions(screen.getByLabelText('Event type'), 'deploy.succeeded');
    await waitFor(() => {
      expect(new URLSearchParams(queries.at(-1))).toEqual(
        new URLSearchParams({ eventType: 'deploy.succeeded', state: 'failed' }),
      );
    });
  });

  it('expands a delivery to show each attempt with its headers and body', async () => {
    server.use(
      http.get(DELIVERIES, () => HttpResponse.json({ items: [failed], nextCursor: null })),
      http.get(`${DELIVERIES}/${failed.id}`, () => HttpResponse.json(detail())),
    );

    renderScreen(<DeliveryLog orgId={ORG_ID} endpointId={ENDPOINT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: /deploy\.succeeded/ }));

    const attempts = await screen.findByRole('list', { name: 'Attempts' });

    expect(within(attempts).getByText(/500/)).toBeInTheDocument();
    expect(within(attempts).getByText(/x-trace: trace-1/)).toBeInTheDocument();
    expect(within(attempts).getByText('upstream exploded').tagName).toBe('PRE');
    expect(screen.getByText('{"type":"deploy.succeeded"}').tagName).toBe('PRE');
  });

  it('replays a delivery through the route and refreshes the list', async () => {
    let listed = 0;
    let replayed = false;

    server.use(
      http.get(DELIVERIES, () => {
        listed += 1;

        return HttpResponse.json({
          items: [replayed ? { ...failed, state: 'pending' } : failed],
          nextCursor: null,
        });
      }),
      http.get(`${DELIVERIES}/${failed.id}`, () => HttpResponse.json(detail())),
      http.post(`${DELIVERIES}/${failed.id}/replay`, () => {
        replayed = true;

        return HttpResponse.json({ ...failed, state: 'pending' }, { status: 202 });
      }),
    );

    renderScreen(<DeliveryLog orgId={ORG_ID} endpointId={ENDPOINT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: /deploy\.succeeded/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Replay' }));

    const list = screen.getByRole('list', { name: 'Deliveries' });

    expect(await within(list).findByText('Pending')).toBeInTheDocument();
    expect(replayed).toBe(true);
    expect(listed).toBeGreaterThanOrEqual(2);
  });

  it('shows an expired body as expired and disables replay', async () => {
    server.use(
      http.get(DELIVERIES, () => HttpResponse.json({ items: [failed], nextCursor: null })),
      http.get(`${DELIVERIES}/${failed.id}`, () => HttpResponse.json(detail({ body: null }))),
    );

    renderScreen(<DeliveryLog orgId={ORG_ID} endpointId={ENDPOINT_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: /deploy\.succeeded/ }));

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay' })).toBeDisabled();
  });

  it('is mounted per endpoint behind a Deliveries toggle', async () => {
    server.use(
      listing(() => [anEndpoint()]),
      http.get(DELIVERIES, () => HttpResponse.json({ items: [], nextCursor: null })),
    );

    renderScreen(<EndpointsSection orgId={ORG_ID} />);

    const [item] = await screen.findAllByRole('listitem');

    await userEvent.click(within(item!).getByRole('button', { name: 'Deliveries' }));

    expect(
      await within(item!).findByText('No deliveries in the last 30 days.'),
    ).toBeInTheDocument();
  });
});

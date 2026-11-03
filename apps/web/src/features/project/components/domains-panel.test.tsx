import {
  type CloudflareOffer,
  DOMAIN_CONFLICT_REASONS,
  MFA_STEPPED_UP,
  DOMAIN_FAILURE_REASONS,
  DOMAIN_STATES,
  type Domain,
  type DomainFailureReason,
  type DomainListResponse,
} from '@repo/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import {
  DOMAIN_CONFLICT_COPY,
  DOMAIN_FAILURE_COPY,
  DOMAIN_LIMIT_COPY,
  DOMAIN_STATE_COPY,
  checkLimitedCopy,
} from '../lib/domain-reasons';
import { CLOUDFLARE_UNAVAILABLE_COPY, DomainsPanel } from './domains-panel';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DOMAIN = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

const BASE = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const HOST = 'app.acme.com';
const TOKEN_VALUE = 'forge-verify=4f3c2b1a';
const TARGET = 'domains.forge.test';

/** An id per row, valid for `z.uuid()`, so every fixture passes the strict contract parse. */
function idFor(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function aDomain(overrides: Partial<Domain> = {}): Domain {
  const hostname = overrides.hostname ?? HOST;

  return {
    activatedAt: null,
    addedBy: ORG,
    check: null,
    checkAvailableAt: null,
    createdAt: '2026-09-23T10:00:00.000Z',
    displayHostname: hostname,
    driftedAt: null,
    failureReason: null,
    hostname,
    id: DOMAIN,
    records: [
      {
        name: `_forge-challenge.${hostname}`,
        purpose: 'ownership',
        status: 'unchecked',
        type: 'TXT',
        value: TOKEN_VALUE,
      },
      { name: hostname, purpose: 'routing', status: 'unchecked', type: 'CNAME', value: TARGET },
    ],
    releaseAt: null,
    state: 'pending',
    windowEndsAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

function listed(items: readonly Domain[], canManage = true): DomainListResponse {
  return { canManage, items: [...items] };
}

function listHandler(body: DomainListResponse | (() => DomainListResponse)) {
  return http.get(`${BASE}/domains`, () =>
    HttpResponse.json(typeof body === 'function' ? body() : body),
  );
}

function render() {
  return renderScreen(<DomainsPanel orgId={ORG} projectId={PROJECT} />);
}

const CLOUDFLARE = `${API}/orgs/${ORG}/domains/:domainId/cloudflare`;

function offerHandler(offer: CloudflareOffer | (() => CloudflareOffer)) {
  return http.get(CLOUDFLARE, () =>
    HttpResponse.json(typeof offer === 'function' ? offer() : offer),
  );
}

const RECORDS: CloudflareOffer['records'] = [
  { content: TOKEN_VALUE, name: `_forge-challenge.${HOST}`, type: 'TXT' },
  { content: TARGET, name: HOST, type: 'CNAME' },
];

describe('DomainsPanel', () => {
  // Spec 030: a manager's pending domain asks for the Cloudflare offer; without a connection there
  // is none, which is what the 028 cases below were written against.
  beforeEach(() => {
    server.use(offerHandler({ records: RECORDS, status: 'not-connected' }));
  });

  it('renders each state and each failure reason in the copy from domain-reasons', async () => {
    const byState = DOMAIN_STATES.filter((state) => state !== 'failed').map((state, index) =>
      aDomain({
        driftedAt: state === 'drifted' ? '2026-09-23T11:00:00.000Z' : null,
        hostname: `${state}.acme.com`,
        id: idFor(index + 1),
        releaseAt: state === 'drifted' ? '2026-10-23T11:00:00.000Z' : null,
        state,
        windowEndsAt: state === 'pending' ? '2026-09-26T10:00:00.000Z' : null,
      }),
    );
    const failed = DOMAIN_FAILURE_REASONS.map((reason: DomainFailureReason, index) =>
      aDomain({
        failureReason: reason,
        hostname: `${reason}.acme.com`,
        id: idFor(index + 20),
        state: 'failed',
        windowEndsAt: null,
      }),
    );

    server.use(listHandler(listed([...byState, ...failed])));

    render();

    for (const domain of byState) {
      const row = await screen.findByRole('listitem', { name: domain.displayHostname });

      expect(within(row).getByText(DOMAIN_STATE_COPY[domain.state].label)).toBeInTheDocument();
      expect(
        within(row).getByText(DOMAIN_STATE_COPY[domain.state].description),
      ).toBeInTheDocument();
    }

    for (const domain of failed) {
      const row = screen.getByRole('listitem', { name: domain.displayHostname });

      expect(within(row).getByText(DOMAIN_STATE_COPY.failed.label)).toBeInTheDocument();
      expect(within(row).getByText(DOMAIN_FAILURE_COPY[domain.failureReason!])).toBeInTheDocument();
    }
  });

  it('shows the edge’s own words and the blocking CAA record when the check carries them', async () => {
    server.use(
      listHandler(
        listed([
          aDomain({
            check: {
              at: '2026-09-23T11:00:00.000Z',
              caa: { record: '0 issue "other-ca.example"', verdict: 'blocked', zone: 'acme.com' },
              certificateActive: false,
              conclusive: true,
              hostnameActive: null,
              message: null,
            },
            failureReason: 'caa-blocked',
            id: idFor(1),
            state: 'failed',
          }),
          aDomain({
            check: {
              at: '2026-09-23T11:00:00.000Z',
              caa: { verdict: 'permitted' },
              certificateActive: null,
              conclusive: true,
              hostnameActive: null,
              message: 'Hostname is prohibited by the provider.',
            },
            failureReason: 'provider-refused',
            hostname: 'shop.acme.com',
            id: idFor(2),
            state: 'failed',
          }),
        ]),
      ),
    );

    render();

    expect(await screen.findByText(/0 issue "other-ca\.example"/u)).toBeInTheDocument();
    expect(screen.getByText('acme.com', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText(/Hostname is prohibited by the provider\./u)).toBeInTheDocument();
  });

  it('offers a member without org:domains.manage no add, check, retry or remove control', async () => {
    server.use(
      listHandler(
        listed(
          [
            aDomain({ id: idFor(1), state: 'pending' }),
            aDomain({ hostname: 'www.acme.com', id: idFor(2), state: 'drifted' }),
            aDomain({
              failureReason: 'verification-timeout',
              hostname: 'shop.acme.com',
              id: idFor(3),
              state: 'failed',
            }),
          ],
          false,
        ),
      ),
    );

    render();

    expect(await screen.findByRole('listitem', { name: HOST })).toBeInTheDocument();
    // The records are still readable: they are the member's own instructions.
    expect(screen.getAllByText(TOKEN_VALUE).length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add domain/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/u })).not.toBeInTheDocument();
  });

  it('adds a domain and shows its two records, each with a working copy button', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    let added = false;

    server.use(
      listHandler(() => listed(added ? [aDomain()] : [])),
      http.post(`${BASE}/domains`, async ({ request }) => {
        posted.push(await request.json());
        added = true;

        return HttpResponse.json({ domain: aDomain() }, { status: 201 });
      }),
    );

    render();

    expect(await screen.findByText(/No custom domains yet/u)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Hostname/u }), HOST);
    await user.click(screen.getByRole('button', { name: 'Add domain' }));

    await waitFor(() => expect(posted).toEqual([{ hostname: HOST }]));

    const row = await screen.findByRole('listitem', { name: HOST });
    const records = within(row).getByRole('table', { name: /DNS records/u });

    expect(within(records).getByText(`_forge-challenge.${HOST}`)).toBeInTheDocument();
    expect(within(records).getByText(TOKEN_VALUE)).toBeInTheDocument();
    expect(within(records).getByText('TXT')).toBeInTheDocument();
    expect(within(records).getByText('CNAME')).toBeInTheDocument();
    expect(within(records).getByText(TARGET)).toBeInTheDocument();

    await user.click(within(records).getByRole('button', { name: 'Copy the ownership value' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(TOKEN_VALUE);

    await user.click(within(records).getByRole('button', { name: 'Copy the ownership name' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(`_forge-challenge.${HOST}`);

    await user.click(within(records).getByRole('button', { name: 'Copy the routing value' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(TARGET);

    // The form is cleared for the next one.
    expect(screen.getByRole('textbox', { name: /Hostname/u })).toHaveValue('');
  });

  it('polls a pending row and shows its change within 5 s, without a reload', async () => {
    let calls = 0;

    server.use(
      listHandler(() => {
        calls += 1;

        return listed([
          calls === 1
            ? aDomain()
            : aDomain({
                activatedAt: '2026-09-23T10:05:00.000Z',
                state: 'active',
                windowEndsAt: null,
              }),
        ]);
      }),
    );

    render();

    const row = await screen.findByRole('listitem', { name: HOST });

    expect(within(row).getByText(DOMAIN_STATE_COPY.pending.label)).toBeInTheDocument();
    expect(
      await within(row).findByText(DOMAIN_STATE_COPY.active.label, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 15_000);

  it('asks for the hostname to be typed before removing, then lists the records to delete', async () => {
    const user = userEvent.setup();
    let deleted = 0;
    const removing = aDomain({ state: 'removing', windowEndsAt: null });

    server.use(
      listHandler(() => listed([deleted === 0 ? aDomain({ state: 'active' }) : removing])),
      http.delete(`${BASE}/domains/${DOMAIN}`, () => {
        deleted += 1;

        return HttpResponse.json(
          {
            deletableRecords: removing.records.map(({ name, type, value }) => ({
              name,
              type,
              value,
            })),
            domain: removing,
          },
          { status: 202 },
        );
      }),
    );

    render();

    await user.click(await screen.findByRole('button', { name: `Remove ${HOST}` }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Remove domain' });
    const input = within(dialog).getByRole('textbox');

    expect(confirm).toBeDisabled();

    await user.type(input, 'app.acme.co');
    expect(confirm).toBeDisabled();

    await user.type(input, 'm');
    expect(confirm).toBeEnabled();

    await user.click(confirm);

    await waitFor(() => expect(deleted).toBe(1));
    expect(await within(dialog).findByText(/can now delete/u)).toBeInTheDocument();
    expect(within(dialog).getByText(`_forge-challenge.${HOST}`)).toBeInTheDocument();
    expect(within(dialog).getByText(TOKEN_VALUE)).toBeInTheDocument();
    expect(within(dialog).getByText(TARGET)).toBeInTheDocument();
  });

  it('shows when a check can be asked for again after a 429', async () => {
    const user = userEvent.setup();

    server.use(
      listHandler(listed([aDomain()])),
      http.post(`${BASE}/domains/${DOMAIN}/check`, () =>
        problemResponse('rate-limited', 429, { retryAfter: 42 }),
      ),
    );

    render();

    await user.click(await screen.findByRole('button', { name: `Check ${HOST} now` }));

    expect(await screen.findByText(checkLimitedCopy(42))).toBeInTheDocument();
  });

  it('retries a failed domain', async () => {
    const user = userEvent.setup();
    let retried = 0;

    server.use(
      listHandler(() =>
        listed([
          retried === 0
            ? aDomain({ failureReason: 'ownership-not-found', state: 'failed', windowEndsAt: null })
            : aDomain(),
        ]),
      ),
      http.post(`${BASE}/domains/${DOMAIN}/retry`, () => {
        retried += 1;

        return HttpResponse.json({ domain: aDomain() });
      }),
    );

    render();

    await user.click(await screen.findByRole('button', { name: `Retry ${HOST}` }));

    await waitFor(() => expect(retried).toBe(1));
    expect(await screen.findByText(DOMAIN_STATE_COPY.pending.label)).toBeInTheDocument();
  });

  it('puts each 409 reason’s sentence on a refused add', async () => {
    const user = userEvent.setup();
    let answer: Record<string, unknown> = {};

    server.use(
      listHandler(listed([])),
      http.post(`${BASE}/domains`, () => problemResponse('conflict', 409, answer)),
    );

    render();

    const input = await screen.findByRole('textbox', { name: /Hostname/u });

    await user.type(input, HOST);

    const cases: { extra: Record<string, unknown>; sentence: string }[] = [
      ...DOMAIN_CONFLICT_REASONS.filter((reason) => reason !== 'domain-limit').map((reason) => ({
        extra: { reason },
        sentence: DOMAIN_CONFLICT_COPY[reason],
      })),
      { extra: { limit: 10, reason: 'domain-limit' }, sentence: DOMAIN_LIMIT_COPY[10] },
      { extra: { limit: 50, reason: 'domain-limit' }, sentence: DOMAIN_LIMIT_COPY[50] },
    ];

    for (const { extra, sentence } of cases) {
      answer = extra;

      await user.click(screen.getByRole('button', { name: 'Add domain' }));

      expect(await screen.findByText(sentence)).toBeInTheDocument();
    }
  });

  it('has copy for every reason and state the contract names', () => {
    expect(Object.keys(DOMAIN_FAILURE_COPY).sort()).toEqual([...DOMAIN_FAILURE_REASONS].sort());
    expect(Object.keys(DOMAIN_STATE_COPY).sort()).toEqual([...DOMAIN_STATES].sort());
    expect(Object.keys(DOMAIN_CONFLICT_COPY).sort()).toEqual([...DOMAIN_CONFLICT_REASONS].sort());

    for (const copy of [
      ...Object.values(DOMAIN_FAILURE_COPY),
      ...Object.values(DOMAIN_CONFLICT_COPY),
      ...Object.values(DOMAIN_LIMIT_COPY),
    ]) {
      expect(copy).toMatch(/\S/u);
    }
  });

  describe('with Cloudflare (spec 030 US2)', () => {
    const OPERATION = {
      bindingId: null,
      createdAt: '2026-09-23T10:00:00.000Z',
      deploymentId: null,
      finishedAt: null,
      id: idFor(90),
      kind: 'dns_write',
      projectId: PROJECT,
      providerState: null,
      reason: null,
      requestedBy: ORG,
      startedAt: null,
      state: 'queued',
    };

    async function row() {
      return within(await screen.findByRole('listitem', { name: HOST }));
    }

    it('offers the write for a pending domain in a connected zone; through step-up, then shows the records written', async () => {
      let steppedUp = false;
      let written = false;
      let stepUpBody: unknown;

      server.use(
        listHandler(listed([aDomain()])),
        offerHandler(() =>
          written
            ? { records: RECORDS, status: 'written' }
            : { records: RECORDS, status: 'writable', zone: { id: 'zone-1', name: 'acme.com' } },
        ),
        http.post(`${CLOUDFLARE}/write`, () => {
          if (!steppedUp) return problemResponse('step-up-required', 403);
          written = true;

          return HttpResponse.json(OPERATION, { status: 202 });
        }),
        http.post(`${API}/auth/mfa/step-up`, async ({ request }) => {
          stepUpBody = await request.json();
          steppedUp = true;

          return HttpResponse.json({ status: MFA_STEPPED_UP });
        }),
      );

      render();

      const domain = await row();
      expect(await domain.findByText('acme.com')).toBeInTheDocument();
      await userEvent.click(
        domain.getByRole('button', { name: `Write ${HOST} records with Cloudflare` }),
      );

      const dialog = within(await screen.findByRole('dialog'));
      expect(
        dialog.getByText(/Writing DNS records needs a recent second factor/u),
      ).toBeInTheDocument();
      await userEvent.type(dialog.getByLabelText('Authenticator code'), '123456');
      await userEvent.click(dialog.getByRole('button', { name: 'Confirm' }));

      expect(
        await domain.findByText('Records written by Cloudflare.', {}, { timeout: 5000 }),
      ).toBeInTheDocument();
      expect(stepUpBody).toEqual({ code: '123456' });
      // The manual step stays beside it.
      expect(domain.getByRole('table', { name: 'DNS records' })).toBeInTheDocument();
    });

    it('names a conflicting record and offers no write', async () => {
      server.use(
        listHandler(listed([aDomain()])),
        offerHandler({
          conflict: { content: 'elsewhere.example', name: HOST, type: 'CNAME' },
          records: RECORDS,
          status: 'writable',
          zone: { id: 'zone-1', name: 'acme.com' },
        }),
      );

      render();

      const domain = await row();
      expect(await domain.findByText('elsewhere.example')).toBeInTheDocument();
      expect(domain.getByText(/It is not overwritten/u)).toBeInTheDocument();
      expect(domain.queryByRole('button', { name: /with Cloudflare/u })).not.toBeInTheDocument();
    });

    it('a record-conflict found at write is named the same way', async () => {
      server.use(
        listHandler(listed([aDomain()])),
        offerHandler({
          records: RECORDS,
          status: 'writable',
          zone: { id: 'zone-1', name: 'acme.com' },
        }),
        http.post(`${CLOUDFLARE}/write`, () =>
          problemResponse('conflict', 409, {
            reason: 'record-conflict',
            record: { content: 'late.example', name: HOST, type: 'CNAME' },
          }),
        ),
      );

      render();

      const domain = await row();
      await userEvent.click(
        await domain.findByRole('button', { name: `Write ${HOST} records with Cloudflare` }),
      );

      expect(await domain.findByText('late.example')).toBeInTheDocument();
    });

    it('explains the fallbacks beside the manual step', async () => {
      server.use(
        listHandler(listed([aDomain()])),
        offerHandler({ records: RECORDS, status: 'zone-not-found' }),
      );

      render();

      expect(
        await (await row()).findByText(/No zone your Cloudflare token can see holds this domain/u),
      ).toBeInTheDocument();
    });

    it('says Cloudflare is unavailable beside the manual step while its circuit is open (US6)', async () => {
      server.use(
        listHandler(listed([aDomain()])),
        http.get(CLOUDFLARE, () =>
          problemResponse('service-unavailable', 503, { reason: 'provider-unavailable' }),
        ),
      );

      render();

      expect(await (await row()).findByText(CLOUDFLARE_UNAVAILABLE_COPY)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /with Cloudflare/u })).toBeNull();
    });

    it('asks nothing of Cloudflare for a member without org:domains.manage', async () => {
      let asked = false;

      server.use(
        listHandler(listed([aDomain()], false)),
        http.get(CLOUDFLARE, () => {
          asked = true;

          return HttpResponse.json({ records: RECORDS, status: 'writable' });
        }),
      );

      render();

      await row();
      expect(asked).toBe(false);
    });
  });
});

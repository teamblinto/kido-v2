import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import {
  domainListResponseSchema,
  domainSchema,
  removeDomainResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import { FakeDns } from '../../../../test/support/fake-dns';
import { AppModule } from '../../../app.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import { NotFoundError, RateLimitedError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import type { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { scoped } from '../../rbac/permissions';
import { TemplateCatalogue } from '../../sandbox/template-catalogue';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import type { DnsPort } from './dns.port';
import {
  CHECK_NOW_MIN_INTERVAL_MS,
  DOMAINS_PER_ORG,
  DOMAINS_PER_PROJECT,
  RELEASE_AFTER_MS,
  WINDOW_MS,
} from './domain.constants';
import { HostnameHeld } from './domain.errors';
import { type Domain, type DomainCheck, DomainRepository } from './domain.repository';
import { ADD_SOA_BUDGET_MS, DomainService } from './domain.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DOMAIN = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';
const TARGET = 'edge.forge-customers.test';
const NOW = new Date('2026-09-23T12:00:00.000Z');

const ref = { orgId: ORG, projectId: PROJECT };

/** The environment the service reads; `CUSTOM_HOSTNAME_TARGET` absent means the group is absent. */
function configOf(overrides: Partial<Environment> = {}): ConfigService<Environment, true> {
  const values: Partial<Environment> = {
    APP_URL: 'https://app.forge.test',
    CUSTOM_HOSTNAME_TARGET: TARGET,
    PREVIEW_DOMAIN: 'forge-preview.test',
    RESERVED_DOMAINS: ['forge.io'],
    SITE_DOMAIN: 'forge-site.test',
    ...overrides,
  };
  return { get: (key: keyof Environment) => values[key] } as unknown as ConfigService<
    Environment,
    true
  >;
}

function row(overrides: Partial<Domain> = {}): Domain {
  return {
    activatedAt: null,
    addedBy: USER,
    certificateActiveAt: null,
    checkRequestedAt: null,
    claimedAt: null,
    createdAt: NOW,
    driftedAt: null,
    edgeId: null,
    failureCount: 0,
    failureReason: null,
    hostname: 'app.acme.com',
    id: DOMAIN,
    lastCheck: null,
    nextCheckAt: NOW,
    orgId: ORG,
    ownershipToken: TOKEN,
    ownershipVerifiedAt: null,
    projectId: PROJECT,
    releaseWarnedAt: null,
    removalRequestedAt: null,
    state: 'pending',
    updatedAt: NOW,
    windowStartedAt: NOW,
    ...overrides,
  };
}

/**
 * Spec 028 T031 — `add`, `list` and `get` (contracts/domains.md). Every refusal is decided before
 * anything is written; what passes writes the row, `domain.added` and its audit row on the
 * caller's one transaction handle. Collaborators are doubles here; the block at the end runs the
 * same service against Postgres for the held hostname and the one-transaction guarantee.
 */
describe('DomainService', () => {
  const tx = { marker: 'the-request-transaction' } as unknown as TenantTransaction;

  let domains: {
    countLive: ReturnType<typeof vi.fn>;
    findForProject: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    listForProject: ReturnType<typeof vi.fn>;
    markRemoving: ReturnType<typeof vi.fn>;
    releaseFailed: ReturnType<typeof vi.fn>;
    requestCheck: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
  let projects: { deployTarget: ReturnType<typeof vi.fn> };
  let catalogue: { get: ReturnType<typeof vi.fn> };
  let permissions: { for: ReturnType<typeof vi.fn> };
  let dns: FakeDns;
  let outbox: { append: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let clock: FakeClock;

  function build(config = configOf(), resolver: DnsPort = dns): DomainService {
    return new DomainService(
      domains as unknown as DomainRepository,
      projects as unknown as ProjectService,
      catalogue as unknown as TemplateCatalogue,
      permissions as unknown as PermissionResolutionService,
      resolver,
      outbox as unknown as OutboxWriter,
      audit as unknown as AuditService,
      clock,
      config,
    );
  }

  beforeEach(() => {
    domains = {
      countLive: vi.fn().mockResolvedValue({ org: 0, project: 0 }),
      findForProject: vi.fn().mockResolvedValue(undefined),
      insert: vi
        .fn()
        .mockImplementation((_tx, draft: { hostname: string; now: Date; ownershipToken: string }) =>
          Promise.resolve(
            row({
              hostname: draft.hostname,
              nextCheckAt: draft.now,
              ownershipToken: draft.ownershipToken,
              windowStartedAt: draft.now,
            }),
          ),
        ),
      listForProject: vi.fn().mockResolvedValue([]),
      markRemoving: vi
        .fn()
        .mockImplementation((_tx, _orgId: string, _target, now: Date) =>
          Promise.resolve([row({ nextCheckAt: now, removalRequestedAt: now, state: 'removing' })]),
        ),
      releaseFailed: vi
        .fn()
        .mockImplementation(() => Promise.resolve(row({ failureReason: null, state: 'removed' }))),
      requestCheck: vi
        .fn()
        .mockImplementation((_tx, _id: string, now: Date) =>
          Promise.resolve(row({ checkRequestedAt: now, nextCheckAt: now })),
        ),
      retry: vi
        .fn()
        .mockImplementation((_tx, _id: string, draft: { now: Date; ownershipToken: string }) =>
          Promise.resolve(
            row({
              nextCheckAt: draft.now,
              ownershipToken: draft.ownershipToken,
              windowStartedAt: draft.now,
            }),
          ),
        ),
    };
    projects = {
      deployTarget: vi.fn().mockResolvedValue({
        archived: false,
        name: 'Shop',
        previewLabel: 'a'.repeat(32),
        template: 'vite-react',
      }),
    };
    catalogue = {
      get: vi.fn().mockImplementation((id: string) => ({
        id,
        manifest: id === 'node-api' ? {} : { build: { command: 'npm run build', output: 'dist' } },
      })),
    };
    permissions = { for: vi.fn().mockResolvedValue(new Set(['org:domains.manage'])) };
    dns = new FakeDns();
    outbox = { append: vi.fn().mockResolvedValue({ eventId: 'e' }) };
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    clock = new FakeClock(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function nothingWritten(): void {
    expect(domains.insert).not.toHaveBeenCalled();
    expect(domains.markRemoving).not.toHaveBeenCalled();
    expect(domains.releaseFailed).not.toHaveBeenCalled();
    expect(domains.requestCheck).not.toHaveBeenCalled();
    expect(domains.retry).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  }

  function refusal(reason: string) {
    return { extensions: { reason }, type: 'conflict' };
  }

  describe('add', () => {
    it('inserts a pending domain with a fresh token, and writes domain.added and its audit row on the one transaction', async () => {
      const domain = await build().add(tx, ref, USER, { hostname: '  App.Acme.COM. ' });

      expect(domains.insert).toHaveBeenCalledTimes(1);
      const [insertTx, draft] = domains.insert.mock.calls[0] as [
        TenantTransaction,
        { ownershipToken: string },
      ];
      expect(insertTx).toBe(tx);
      expect(draft).toEqual({
        addedBy: USER,
        hostname: 'app.acme.com',
        now: NOW,
        orgId: ORG,
        ownershipToken: expect.stringMatching(/^[a-z2-7]{32}$/) as string,
        projectId: PROJECT,
      });

      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: DOMAIN,
        orgId: ORG,
        payload: { domainId: DOMAIN, orgId: ORG, projectId: PROJECT },
        type: 'domain.added',
      });
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'domain.added',
        actorId: USER,
        metadata: { hostname: 'app.acme.com', projectId: PROJECT },
        orgId: ORG,
        target: DOMAIN,
      });

      expect(domainSchema.parse(domain)).toEqual(domain);
      expect(domain).toMatchObject({
        addedBy: USER,
        check: null,
        displayHostname: 'app.acme.com',
        failureReason: null,
        hostname: 'app.acme.com',
        id: DOMAIN,
        state: 'pending',
        windowEndsAt: new Date(NOW.getTime() + WINDOW_MS).toISOString(),
      });
    });

    it('two tokens are never the same', async () => {
      await build().add(tx, ref, USER, { hostname: 'a.acme.com' });
      await build().add(tx, ref, USER, { hostname: 'b.acme.com' });

      const tokens = domains.insert.mock.calls.map(
        (call) => (call[1] as { ownershipToken: string }).ownershipToken,
      );
      expect(tokens[0]).not.toBe(tokens[1]);
    });

    it('records are the ownership TXT and the routing CNAME, with their values', async () => {
      const domain = await build().add(tx, ref, USER, { hostname: 'app.acme.com' });
      const [draft] = domains.insert.mock.calls.map(
        (call) => call[1] as { ownershipToken: string },
      );

      expect(domain.records).toEqual([
        {
          name: '_forge-challenge.app.acme.com',
          purpose: 'ownership',
          status: 'unchecked',
          type: 'TXT',
          value: `forge-verify=${draft!.ownershipToken}`,
        },
        {
          name: 'app.acme.com',
          purpose: 'routing',
          status: 'unchecked',
          type: 'CNAME',
          value: TARGET,
        },
      ]);
    });

    it('an IDN is stored in ASCII and displayed in Unicode', async () => {
      const domain = await build().add(tx, ref, USER, { hostname: 'shop.bücher.de' });

      expect(domain.hostname).toBe('shop.xn--bcher-kva.de');
      expect(domain.displayHostname).toBe('shop.bücher.de');
    });

    it.each([
      ['invalid-hostname', 'not a host'],
      ['invalid-hostname', '*.acme.com'],
      ['invalid-hostname', '10.0.0.1'],
      ['apex-not-supported', 'acme.com'],
      ['reserved-hostname', 'shop.forge-site.test'],
      ['reserved-hostname', 'x.forge-preview.test'],
      ['reserved-hostname', 'app.forge.test'],
      ['reserved-hostname', 'a.forge-customers.test'],
      ['reserved-hostname', 'status.forge.io'],
    ])('refuses %s for %j, and writes nothing', async (reason, hostname) => {
      await expect(build().add(tx, ref, USER, { hostname })).rejects.toMatchObject(refusal(reason));
      nothingWritten();
    });

    it('an SOA owned by the name itself is apex-not-supported', async () => {
      dns.set('shop.acme.co.uk', 'SOA', 'shop.acme.co.uk');

      await expect(
        build().add(tx, ref, USER, { hostname: 'shop.acme.co.uk' }),
      ).rejects.toMatchObject(refusal('apex-not-supported'));
      nothingWritten();
    });

    it('an SOA owned by a parent zone is accepted', async () => {
      dns.set('app.acme.co.uk', 'SOA', 'acme.co.uk');

      await expect(
        build().add(tx, ref, USER, { hostname: 'app.acme.co.uk' }),
      ).resolves.toMatchObject({ state: 'pending' });
      expect(dns.queries).toContainEqual({ name: 'app.acme.co.uk', type: 'SOA' });
    });

    it('an unavailable resolver at add is accepted; the first check catches an apex', async () => {
      dns.unavailable('app.acme.com');

      await expect(build().add(tx, ref, USER, { hostname: 'app.acme.com' })).resolves.toMatchObject(
        { state: 'pending' },
      );
    });

    it(`a SOA probe over its ${ADD_SOA_BUDGET_MS} ms budget is accepted`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const hanging: DnsPort = {
        resolveCaa: (name) => dns.resolveCaa(name),
        resolveCnameChain: (name) => dns.resolveCnameChain(name),
        resolveSoaOwner: () => new Promise(() => undefined),
        resolveTxt: (name) => dns.resolveTxt(name),
      };

      const added = build(configOf(), hanging).add(tx, ref, USER, { hostname: 'app.acme.com' });
      await vi.advanceTimersByTimeAsync(ADD_SOA_BUDGET_MS - 1);
      expect(domains.insert).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(added).resolves.toMatchObject({ state: 'pending' });
      expect(domains.insert).toHaveBeenCalledTimes(1);
    });

    it('a held hostname is hostname-unavailable with the fixed detail and nothing else', async () => {
      domains.insert.mockRejectedValue(new HostnameHeld());

      const error = await build()
        .add(tx, ref, USER, { hostname: 'app.acme.com' })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        detail: 'That hostname is not available.',
        extensions: { reason: 'hostname-unavailable' },
        type: 'conflict',
      });
      expect(Object.keys((error as { extensions: object }).extensions)).toEqual(['reason']);
      expect(outbox.append).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an unknown project, or one of another org, is not-found', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(build().add(tx, ref, USER, { hostname: 'app.acme.com' })).rejects.toMatchObject({
        type: 'not-found',
      });
      expect(projects.deployTarget).toHaveBeenCalledWith(tx, ref);
      nothingWritten();
    });

    it('an archived project is project-archived', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: true,
        name: 'Shop',
        previewLabel: 'a'.repeat(32),
        template: 'vite-react',
      });

      await expect(build().add(tx, ref, USER, { hostname: 'app.acme.com' })).rejects.toMatchObject(
        refusal('project-archived'),
      );
      nothingWritten();
    });

    it('a template without build is not-deployable', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: false,
        name: 'Api',
        previewLabel: 'a'.repeat(32),
        template: 'node-api',
      });

      await expect(build().add(tx, ref, USER, { hostname: 'app.acme.com' })).rejects.toMatchObject(
        refusal('not-deployable'),
      );
      nothingWritten();
    });

    it('with the edge group absent, is domains-unavailable before any DNS question', async () => {
      const service = build(configOf({ CUSTOM_HOSTNAME_TARGET: undefined }));

      await expect(service.add(tx, ref, USER, { hostname: 'app.acme.com' })).rejects.toMatchObject(
        refusal('domains-unavailable'),
      );
      expect(dns.queries).toEqual([]);
      nothingWritten();
    });

    describe('limits (FR-004, T072)', () => {
      it(`the ${DOMAINS_PER_PROJECT + 1}th live domain on a project is domain-limit with limit ${DOMAINS_PER_PROJECT}`, async () => {
        domains.countLive.mockResolvedValue({
          org: DOMAINS_PER_PROJECT,
          project: DOMAINS_PER_PROJECT,
        });

        const error = await build()
          .add(tx, ref, USER, { hostname: 'app.acme.com' })
          .catch((caught: unknown) => caught);

        expect(error).toMatchObject({
          extensions: { limit: DOMAINS_PER_PROJECT, reason: 'domain-limit' },
          type: 'conflict',
        });
        expect(Object.keys((error as { extensions: object }).extensions).sort()).toEqual([
          'limit',
          'reason',
        ]);
        expect(domains.countLive).toHaveBeenCalledWith(tx, ORG, PROJECT);
        nothingWritten();
      });

      it(`the ${DOMAINS_PER_ORG + 1}st live domain in an org is domain-limit with limit ${DOMAINS_PER_ORG}`, async () => {
        domains.countLive.mockResolvedValue({ org: DOMAINS_PER_ORG, project: 0 });

        await expect(
          build().add(tx, ref, USER, { hostname: 'app.acme.com' }),
        ).rejects.toMatchObject({
          extensions: { limit: DOMAINS_PER_ORG, reason: 'domain-limit' },
          type: 'conflict',
        });
        nothingWritten();
      });

      it('one below both limits is accepted, counted on the one transaction before the insert', async () => {
        domains.countLive.mockResolvedValue({
          org: DOMAINS_PER_ORG - 1,
          project: DOMAINS_PER_PROJECT - 1,
        });

        await expect(
          build().add(tx, ref, USER, { hostname: 'app.acme.com' }),
        ).resolves.toMatchObject({ state: 'pending' });
        expect(domains.countLive).toHaveBeenCalledWith(tx, ORG, PROJECT);
        expect(domains.countLive.mock.invocationCallOrder[0]).toBeLessThan(
          domains.insert.mock.invocationCallOrder[0]!,
        );
      });

      it('a refusal decided earlier does not take the org lock', async () => {
        await expect(build().add(tx, ref, USER, { hostname: 'acme.com' })).rejects.toMatchObject(
          refusal('apex-not-supported'),
        );
        expect(domains.countLive).not.toHaveBeenCalled();
      });
    });
  });

  describe('list', () => {
    it('maps the project’s rows newest first, and canManage reflects org:domains.manage', async () => {
      domains.listForProject.mockResolvedValue([
        row({ hostname: 'b.acme.com', id: '55555555-5555-4555-8555-555555555555' }),
        row(),
      ]);

      const page = await build().list(tx, ref, USER);

      expect(domainListResponseSchema.parse(page)).toEqual(page);
      expect(page.canManage).toBe(true);
      expect(page.items.map((item) => item.hostname)).toEqual(['b.acme.com', 'app.acme.com']);
      expect(domains.listForProject).toHaveBeenCalledWith(tx, ORG, PROJECT);
      expect(permissions.for).toHaveBeenCalledWith(ORG, USER);
    });

    it('a project:read holder without org:domains.manage lists with canManage false', async () => {
      permissions.for.mockResolvedValue(new Set([scoped('project:read', PROJECT), 'org:read']));

      await expect(build().list(tx, ref, USER)).resolves.toEqual({ canManage: false, items: [] });
    });

    it('an unknown project, or one of another org, is not-found', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));

      await expect(build().list(tx, ref, USER)).rejects.toMatchObject({ type: 'not-found' });
      expect(domains.listForProject).not.toHaveBeenCalled();
    });

    it('an archived project stays readable', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: true,
        name: 'Shop',
        previewLabel: 'a'.repeat(32),
        template: 'vite-react',
      });

      await expect(build().list(tx, ref, USER)).resolves.toMatchObject({ items: [] });
    });
  });

  describe('get', () => {
    it('answers the project’s domain', async () => {
      domains.findForProject.mockResolvedValue(row());

      await expect(build().get(tx, ref, DOMAIN)).resolves.toMatchObject({
        hostname: 'app.acme.com',
        id: DOMAIN,
      });
      expect(domains.findForProject).toHaveBeenCalledWith(tx, ORG, PROJECT, DOMAIN);
    });

    it('a domain of another project or org, or a removed one, is not-found', async () => {
      await expect(build().get(tx, ref, DOMAIN)).rejects.toMatchObject({ type: 'not-found' });
    });

    it('maps the last check, the drift release and the check-now limit', async () => {
      const check: DomainCheck = {
        at: NOW.toISOString(),
        caa: { verdict: 'blocked', record: '0 issue "other.ca"', zone: 'acme.com' },
        certificateRecords: [{ name: '_acme-challenge.app.acme.com', value: 'cert-token' }],
        conclusive: true,
        edge: { certificate: 'pending', hostname: 'active' },
        edgeMessage: null,
        records: [
          { purpose: 'ownership', status: 'found' },
          { purpose: 'routing', status: 'mismatch' },
          { purpose: 'certificate', status: 'missing' },
        ],
      };
      const driftedAt = new Date(NOW.getTime() - 60_000);
      const checkRequestedAt = new Date(NOW.getTime() - 20_000);
      domains.findForProject.mockResolvedValue(
        row({
          activatedAt: driftedAt,
          certificateActiveAt: driftedAt,
          checkRequestedAt,
          driftedAt,
          edgeId: 'edge-1',
          lastCheck: check,
          ownershipVerifiedAt: driftedAt,
          state: 'drifted',
        }),
      );

      const domain = await build().get(tx, ref, DOMAIN);

      expect(domainSchema.parse(domain)).toEqual(domain);
      expect(domain).toMatchObject({
        activatedAt: driftedAt.toISOString(),
        check: {
          at: NOW.toISOString(),
          caa: check.caa,
          certificateActive: false,
          conclusive: true,
          hostnameActive: true,
          message: null,
        },
        checkAvailableAt: new Date(
          checkRequestedAt.getTime() + CHECK_NOW_MIN_INTERVAL_MS,
        ).toISOString(),
        driftedAt: driftedAt.toISOString(),
        releaseAt: new Date(driftedAt.getTime() + RELEASE_AFTER_MS).toISOString(),
        windowEndsAt: null,
      });
      expect(
        domain.records.map(({ purpose, status, type }) => ({ purpose, status, type })),
      ).toEqual([
        { purpose: 'ownership', status: 'found', type: 'TXT' },
        { purpose: 'routing', status: 'mismatch', type: 'CNAME' },
        { purpose: 'certificate', status: 'missing', type: 'TXT' },
      ]);
      expect(domain.records[2]).toMatchObject({
        name: '_acme-challenge.app.acme.com',
        value: 'cert-token',
      });
    });

    it('a check-now request over 60 s ago leaves checkAvailableAt null; unregistered edge is null', async () => {
      domains.findForProject.mockResolvedValue(
        row({
          checkRequestedAt: new Date(NOW.getTime() - CHECK_NOW_MIN_INTERVAL_MS),
          lastCheck: {
            at: NOW.toISOString(),
            caa: { verdict: 'permitted' },
            certificateRecords: [],
            conclusive: false,
            edge: null,
            edgeMessage: null,
            records: [
              { purpose: 'ownership', status: 'missing' },
              { purpose: 'routing', status: 'unchecked' },
            ],
          },
        }),
      );

      await expect(build().get(tx, ref, DOMAIN)).resolves.toMatchObject({
        check: { certificateActive: null, conclusive: false, hostnameActive: null },
        checkAvailableAt: null,
        releaseAt: null,
      });
    });
  });

  /**
   * Spec 028 T049 (contracts/domains.md § Remove, research R10): any live state goes to
   * `removing` with `domain.removal-requested` and `domain.removing` on the caller's transaction;
   * the checker deregisters it. Idempotent by target state.
   */
  describe('remove', () => {
    const edgeCheck: DomainCheck = {
      at: NOW.toISOString(),
      caa: { verdict: 'permitted' },
      certificateRecords: [{ name: '_acme-challenge.app.acme.com', value: 'cert-token' }],
      conclusive: true,
      edge: { certificate: 'pending', hostname: 'active' },
      edgeMessage: null,
      records: [
        { purpose: 'ownership', status: 'found' },
        { purpose: 'routing', status: 'found' },
        { purpose: 'certificate', status: 'missing' },
      ],
    };
    const registered = {
      activatedAt: NOW,
      certificateActiveAt: NOW,
      edgeId: 'edge-1',
      ownershipVerifiedAt: NOW,
    };
    const live: Record<'active' | 'drifted' | 'pending', Partial<Domain>> = {
      active: { ...registered, state: 'active' },
      drifted: { ...registered, driftedAt: NOW, failureCount: 3, state: 'drifted' },
      pending: { state: 'pending' },
    };

    for (const [state, overrides] of Object.entries(live)) {
      it(`${state} → removing, with removal_requested_at, its audit row and domain.removing (reason null) on the one transaction`, async () => {
        domains.findForProject.mockResolvedValue(row(overrides));

        const removed = await build().remove(tx, ref, USER, DOMAIN);

        expect(domains.findForProject).toHaveBeenCalledWith(tx, ORG, PROJECT, DOMAIN);
        expect(domains.markRemoving).toHaveBeenCalledTimes(1);
        expect(domains.markRemoving).toHaveBeenCalledWith(tx, ORG, { ids: [DOMAIN] }, NOW);
        expect(removeDomainResponseSchema.parse(removed)).toEqual(removed);
        expect(removed.domain).toMatchObject({ id: DOMAIN, state: 'removing' });

        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledWith(tx, {
          action: 'domain.removal-requested',
          actorId: USER,
          metadata: { hostname: 'app.acme.com', projectId: PROJECT },
          orgId: ORG,
          target: DOMAIN,
        });
        expect(outbox.append).toHaveBeenCalledTimes(1);
        expect(outbox.append).toHaveBeenCalledWith(tx, {
          aggregateId: DOMAIN,
          orgId: ORG,
          payload: { domainId: DOMAIN, orgId: ORG, projectId: PROJECT, reason: null },
          type: 'domain.removing',
        });
        expect(domains.releaseFailed).not.toHaveBeenCalled();
      });
    }

    it('lists the ownership, routing and certificate records as deletable', async () => {
      domains.findForProject.mockResolvedValue(row({ ...live.active, lastCheck: edgeCheck }));
      domains.markRemoving.mockResolvedValue([
        row({ lastCheck: edgeCheck, removalRequestedAt: NOW, state: 'removing' }),
      ]);

      const { deletableRecords } = await build().remove(tx, ref, USER, DOMAIN);

      expect(deletableRecords).toEqual([
        {
          name: '_forge-challenge.app.acme.com',
          type: 'TXT',
          value: `forge-verify=${TOKEN}`,
        },
        { name: 'app.acme.com', type: 'CNAME', value: TARGET },
        { name: '_acme-challenge.app.acme.com', type: 'TXT', value: 'cert-token' },
      ]);
    });

    it('lists only ownership and routing when the edge asked for no certificate record', async () => {
      domains.findForProject.mockResolvedValue(row());

      const { deletableRecords } = await build().remove(tx, ref, USER, DOMAIN);

      expect(deletableRecords.map((record) => record.type)).toEqual(['TXT', 'CNAME']);
    });

    it('a domain already removing is answered unchanged, with the same records, and nothing written', async () => {
      const removing = row({
        ...live.active,
        lastCheck: edgeCheck,
        removalRequestedAt: NOW,
        state: 'removing',
      });
      domains.findForProject.mockResolvedValue(removing);
      clock.advance(60_000);

      const first = await build().remove(tx, ref, USER, DOMAIN);
      const second = await build().remove(tx, ref, USER, DOMAIN);

      expect(first).toEqual(second);
      expect(first.domain.state).toBe('removing');
      expect(first.deletableRecords).toHaveLength(3);
      nothingWritten();
    });

    it('an unknown domain, another project’s, or a removed one is not-found, and nothing is written', async () => {
      await expect(build().remove(tx, ref, USER, DOMAIN)).rejects.toBeInstanceOf(NotFoundError);
      nothingWritten();
    });

    it('a failed domain, holding nothing at the edge, is removed at once with domain.removed', async () => {
      const failed = row({ failureReason: 'verification-timeout', state: 'failed' });
      domains.findForProject.mockResolvedValue(failed);

      const removed = await build().remove(tx, ref, USER, DOMAIN);

      expect(domains.releaseFailed).toHaveBeenCalledWith(tx, DOMAIN);
      expect(domains.markRemoving).not.toHaveBeenCalled();
      // The last view of it: a removed domain is never reported (R9).
      expect(removed.domain).toMatchObject({
        failureReason: 'verification-timeout',
        state: 'failed',
      });
      expect(removed.deletableRecords).toHaveLength(2);
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'domain.removed',
        actorId: USER,
        metadata: { hostname: 'app.acme.com', projectId: PROJECT },
        orgId: ORG,
        target: DOMAIN,
      });
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: DOMAIN,
        orgId: ORG,
        payload: { domainId: DOMAIN, orgId: ORG, projectId: PROJECT },
        type: 'domain.removed',
      });
    });

    it('a domain the checker failed between the read and the write is removed as a failed one', async () => {
      domains.findForProject
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ failureReason: 'provider-refused', state: 'failed' }));
      domains.markRemoving.mockResolvedValueOnce([]);

      const removed = await build().remove(tx, ref, USER, DOMAIN);

      expect(domains.markRemoving).toHaveBeenCalledTimes(1);
      expect(domains.releaseFailed).toHaveBeenCalledWith(tx, DOMAIN);
      expect(removed.domain.state).toBe('failed');
      expect(outbox.append).toHaveBeenCalledTimes(1);
      expect(outbox.append.mock.calls[0]![1]).toMatchObject({ type: 'domain.removed' });
    });
  });

  describe('retry (T066)', () => {
    const failed = row({
      failureCount: 2,
      failureReason: 'verification-timeout',
      lastCheck: null,
      nextCheckAt: new Date(NOW.getTime() - WINDOW_MS),
      state: 'failed',
      windowStartedAt: new Date(NOW.getTime() - WINDOW_MS),
    });

    it('failed → pending with a new token and a new window, its audit row and domain.retried on the one transaction', async () => {
      domains.findForProject.mockResolvedValue(failed);

      const domain = await build().retry(tx, ref, USER, DOMAIN);

      expect(domains.findForProject).toHaveBeenCalledWith(tx, ORG, PROJECT, DOMAIN);
      expect(domains.retry).toHaveBeenCalledTimes(1);
      const [retryTx, id, draft] = domains.retry.mock.calls[0] as [
        TenantTransaction,
        string,
        { now: Date; ownershipToken: string },
      ];
      expect(retryTx).toBe(tx);
      expect(id).toBe(DOMAIN);
      expect(draft).toEqual({
        now: NOW,
        ownershipToken: expect.stringMatching(/^[a-z2-7]{32}$/) as string,
      });
      expect(draft.ownershipToken).not.toBe(TOKEN);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'domain.retried',
        actorId: USER,
        metadata: { hostname: 'app.acme.com', projectId: PROJECT },
        orgId: ORG,
        target: DOMAIN,
      });
      expect(outbox.append).toHaveBeenCalledTimes(1);
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: DOMAIN,
        orgId: ORG,
        payload: { domainId: DOMAIN, orgId: ORG, projectId: PROJECT },
        type: 'domain.retried',
      });

      expect(domainSchema.parse(domain)).toEqual(domain);
      expect(domain).toMatchObject({
        failureReason: null,
        state: 'pending',
        windowEndsAt: new Date(NOW.getTime() + WINDOW_MS).toISOString(),
      });
      expect(domain.records[0]).toMatchObject({
        purpose: 'ownership',
        value: `forge-verify=${draft.ownershipToken}`,
      });
    });

    for (const state of ['pending', 'active', 'drifted', 'removing'] as const) {
      it(`a ${state} domain is not-retryable, and nothing is written`, async () => {
        const registered =
          state === 'pending'
            ? {}
            : {
                activatedAt: NOW,
                certificateActiveAt: NOW,
                edgeId: 'edge-1',
                ownershipVerifiedAt: NOW,
              };
        domains.findForProject.mockResolvedValue(
          row({
            ...registered,
            driftedAt: state === 'drifted' ? NOW : null,
            removalRequestedAt: state === 'removing' ? NOW : null,
            state,
          }),
        );

        await expect(build().retry(tx, ref, USER, DOMAIN)).rejects.toMatchObject(
          refusal('not-retryable'),
        );
        nothingWritten();
      });
    }

    it('a domain the checker or a removal moved between the read and the write is not-retryable', async () => {
      domains.findForProject.mockResolvedValue(failed);
      domains.retry.mockResolvedValueOnce(undefined);

      await expect(build().retry(tx, ref, USER, DOMAIN)).rejects.toMatchObject(
        refusal('not-retryable'),
      );
      expect(outbox.append).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a hostname another row now holds is hostname-unavailable with the fixed detail, and no trail', async () => {
      domains.findForProject.mockResolvedValue(failed);
      domains.retry.mockRejectedValueOnce(new HostnameHeld());

      const refused = await build()
        .retry(tx, ref, USER, DOMAIN)
        .catch((caught: unknown) => caught);

      expect(refused).toMatchObject({
        detail: 'That hostname is not available.',
        extensions: { reason: 'hostname-unavailable' },
        type: 'conflict',
      });
      expect(Object.keys((refused as { extensions: object }).extensions)).toEqual(['reason']);
      expect(outbox.append).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an unknown domain, another project’s, or a removed one is not-found', async () => {
      await expect(build().retry(tx, ref, USER, DOMAIN)).rejects.toBeInstanceOf(NotFoundError);
      nothingWritten();
    });

    it('an unknown project, or one of another org, is not-found', async () => {
      projects.deployTarget.mockRejectedValue(new NotFoundError('No such project.'));
      domains.findForProject.mockResolvedValue(failed);

      await expect(build().retry(tx, ref, USER, DOMAIN)).rejects.toBeInstanceOf(NotFoundError);
      nothingWritten();
    });

    it('an archived project is project-archived', async () => {
      projects.deployTarget.mockResolvedValue({
        archived: true,
        name: 'Shop',
        previewLabel: 'a'.repeat(32),
        template: 'vite-react',
      });
      domains.findForProject.mockResolvedValue(failed);

      await expect(build().retry(tx, ref, USER, DOMAIN)).rejects.toMatchObject(
        refusal('project-archived'),
      );
      nothingWritten();
    });

    it('with the edge group absent, is domains-unavailable', async () => {
      domains.findForProject.mockResolvedValue(failed);

      await expect(
        build(configOf({ CUSTOM_HOSTNAME_TARGET: undefined })).retry(tx, ref, USER, DOMAIN),
      ).rejects.toMatchObject(refusal('domains-unavailable'));
      nothingWritten();
    });

    it(`a retry that would make the ${DOMAINS_PER_PROJECT + 1}th live domain on the project is domain-limit`, async () => {
      domains.findForProject.mockResolvedValue(failed);
      domains.countLive.mockResolvedValue({
        org: DOMAINS_PER_PROJECT,
        project: DOMAINS_PER_PROJECT,
      });

      await expect(build().retry(tx, ref, USER, DOMAIN)).rejects.toMatchObject({
        extensions: { limit: DOMAINS_PER_PROJECT, reason: 'domain-limit' },
        type: 'conflict',
      });
      expect(domains.countLive).toHaveBeenCalledWith(tx, ORG, PROJECT);
      nothingWritten();
    });
  });

  describe('checkNow (T066)', () => {
    const registered = {
      activatedAt: NOW,
      certificateActiveAt: NOW,
      edgeId: 'edge-1',
      ownershipVerifiedAt: NOW,
    };
    const checkable: Record<'drifted' | 'pending', Partial<Domain>> = {
      drifted: { ...registered, driftedAt: NOW, failureCount: 3, state: 'drifted' },
      pending: { state: 'pending' },
    };

    for (const [state, overrides] of Object.entries(checkable)) {
      it(`${state}: sets check_requested_at and next_check_at and appends domain.check-requested`, async () => {
        domains.findForProject.mockResolvedValue(row(overrides));
        domains.requestCheck.mockImplementation((_tx, _id: string, now: Date) =>
          Promise.resolve(row({ ...overrides, checkRequestedAt: now, nextCheckAt: now })),
        );

        const domain = await build().checkNow(tx, ref, DOMAIN);

        expect(domains.findForProject).toHaveBeenCalledWith(tx, ORG, PROJECT, DOMAIN);
        expect(domains.requestCheck).toHaveBeenCalledWith(tx, DOMAIN, NOW);
        expect(outbox.append).toHaveBeenCalledTimes(1);
        expect(outbox.append).toHaveBeenCalledWith(tx, {
          aggregateId: DOMAIN,
          orgId: ORG,
          payload: { domainId: DOMAIN, orgId: ORG, projectId: PROJECT },
          type: 'domain.check-requested',
        });
        expect(domainSchema.parse(domain)).toEqual(domain);
        expect(domain).toMatchObject({
          checkAvailableAt: new Date(NOW.getTime() + CHECK_NOW_MIN_INTERVAL_MS).toISOString(),
          state,
        });
      });
    }

    it('a second request within 60 s is 429 rate-limited with retryAfter in seconds, and nothing is written', async () => {
      domains.findForProject.mockResolvedValue(
        row({ checkRequestedAt: new Date(NOW.getTime() - 20_500) }),
      );

      const refused = await build()
        .checkNow(tx, ref, DOMAIN)
        .catch((caught: unknown) => caught);

      expect(refused).toBeInstanceOf(RateLimitedError);
      expect(refused).toMatchObject({
        extensions: { retryAfter: 40 },
        status: 429,
        type: 'rate-limited',
      });
      nothingWritten();
    });

    it('a request exactly 60 s after the last one is accepted', async () => {
      domains.findForProject.mockResolvedValue(
        row({ checkRequestedAt: new Date(NOW.getTime() - CHECK_NOW_MIN_INTERVAL_MS) }),
      );

      await build().checkNow(tx, ref, DOMAIN);

      expect(domains.requestCheck).toHaveBeenCalledWith(tx, DOMAIN, NOW);
      expect(outbox.append).toHaveBeenCalledTimes(1);
    });

    it('a request that lost the race to another one is rate-limited by the winner’s time', async () => {
      domains.findForProject
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(row({ checkRequestedAt: NOW }));
      domains.requestCheck.mockResolvedValueOnce(undefined);

      await expect(build().checkNow(tx, ref, DOMAIN)).rejects.toMatchObject({
        extensions: { retryAfter: 60 },
        type: 'rate-limited',
      });
      expect(outbox.append).not.toHaveBeenCalled();
    });

    const unchecked: Record<'active' | 'failed' | 'removing', Partial<Domain>> = {
      active: { ...registered, state: 'active' },
      failed: { failureReason: 'verification-timeout', state: 'failed' },
      removing: { removalRequestedAt: NOW, state: 'removing' },
    };

    for (const [state, overrides] of Object.entries(unchecked)) {
      it(`${state} is answered unchanged, with no event`, async () => {
        const current = row(overrides);
        domains.findForProject.mockResolvedValue(current);

        const domain = await build().checkNow(tx, ref, DOMAIN);

        expect(domain).toEqual(await build().get(tx, ref, DOMAIN));
        expect(domain).toMatchObject({ checkAvailableAt: null, state });
        nothingWritten();
      });
    }

    it('an unknown domain, another project’s, or a removed one is not-found', async () => {
      await expect(build().checkNow(tx, ref, DOMAIN)).rejects.toBeInstanceOf(NotFoundError);
      nothingWritten();
    });
  });

  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let service: DomainService;
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    /** Another project in the tenant's org, for spreading domains past the per-project limit. */
    async function projectIn(orgId: string, userId: string): Promise<string> {
      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: `Domains ${randomUUID().slice(0, 8)}`,
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      return project.id;
    }

    /** Seeds `count` rows of one state straight into the table (the limits count rows, not adds). */
    async function seed(
      orgId: string,
      projectId: string,
      count: number,
      state: 'failed' | 'pending' | 'removed' | 'removing' = 'pending',
    ): Promise<void> {
      if (count === 0) return;
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.insert(schema.domains).values(
          Array.from({ length: count }, () => ({
            failureReason: state === 'failed' ? ('verification-timeout' as const) : null,
            hostname: `seed-${randomUUID().slice(0, 12)}.acme.test`,
            nextCheckAt: NOW,
            orgId,
            ownershipToken: TOKEN,
            projectId,
            removalRequestedAt: state === 'removing' ? NOW : null,
            state,
            windowStartedAt: NOW,
          })),
        ),
      );
    }

    function addTo(who: { orgId: string; userId: string }, projectId: string) {
      return transactions.runInTenantTransaction(who.orgId, (tx) =>
        service.add(tx, { orgId: who.orgId, projectId }, who.userId, {
          hostname: `app-${randomUUID().slice(0, 8)}.acme.test`,
        }),
      );
    }

    async function tenant(): Promise<{ orgId: string; projectId: string; userId: string }> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `028s-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      const userId = user!.id;
      created.users.push(userId);
      const orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Domain service fixture',
          slug: `028s-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Domains',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      return { orgId, projectId: project.id, userId };
    }

    function trail(orgId: string, hostname: string) {
      return transactions.runInTenantTransaction(orgId, async (tx) => {
        const rows = await tx
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(eq(schema.domains.hostname, hostname));
        const ids = rows.map((entry) => entry.id);
        const audits =
          ids.length === 0
            ? []
            : await tx
                .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
                .from(schema.auditLog)
                .where(eq(schema.auditLog.target, ids[0]!));
        const events =
          ids.length === 0
            ? []
            : await database
                .select({ payload: schema.outbox.payload, type: schema.outbox.type })
                .from(schema.outbox)
                .where(eq(schema.outbox.aggregateId, ids[0]!));
        return { audits, events, rows };
      });
    }

    function problem(error: unknown): string {
      const { detail, extensions, type } = error as {
        detail: string;
        extensions: object;
        type: string;
      };
      return JSON.stringify({ detail, extensions, type });
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      service = new DomainService(
        new DomainRepository(),
        moduleRef.get(ProjectService),
        moduleRef.get(TemplateCatalogue),
        { for: () => Promise.resolve(new Set(['org:domains.manage'])) } as never,
        new FakeDns(),
        moduleRef.get(OutboxWriter),
        moduleRef.get(AuditService),
        new FakeClock(NOW),
        configOf(),
      );
    }, 60_000);

    afterAll(async () => {
      for (const orgId of created.orgs) {
        await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      }
      for (const userId of created.users) {
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      }
      await moduleRef?.close();
    });

    it('writes exactly one row, one domain.added and one audit row', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;

      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, { hostname }),
      );

      const { audits, events, rows } = await trail(orgId, hostname);
      expect(rows).toEqual([{ id: domain.id }]);
      expect(events).toEqual([
        { payload: { domainId: domain.id, orgId, projectId }, type: 'domain.added' },
      ]);
      expect(audits).toEqual([{ action: 'domain.added', metadata: { hostname, projectId } }]);
    });

    it('a transaction that fails after the add leaves no row, no event and no audit row', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;

      await expect(
        transactions.runInTenantTransaction(orgId, async (tx) => {
          await service.add(tx, { orgId, projectId }, userId, { hostname });
          throw new Error('after the add');
        }),
      ).rejects.toThrow('after the add');

      expect(await trail(orgId, hostname)).toEqual({ audits: [], events: [], rows: [] });
    });

    it('hostname-unavailable is byte-identical whether this org or another holds it', async () => {
      const holder = await tenant();
      const other = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      await transactions.runInTenantTransaction(holder.orgId, (tx) =>
        service.add(tx, holder, holder.userId, { hostname }),
      );

      const refuse = (who: typeof holder) =>
        transactions
          .runInTenantTransaction(who.orgId, (tx) => service.add(tx, who, who.userId, { hostname }))
          .catch((caught: unknown) => caught);
      const sameOrg = await refuse(holder);
      const otherOrg = await refuse(other);

      expect(sameOrg).toMatchObject(refusal('hostname-unavailable'));
      expect(problem(sameOrg)).toBe(problem(otherOrg));
      expect((await trail(other.orgId, hostname)).rows).toEqual([]);
    });

    it('remove writes removing, removal_requested_at, one audit row and one domain.removing on the transaction', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, { hostname }),
      );

      const removed = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.remove(tx, { orgId, projectId }, userId, domain.id),
      );

      expect(removed.domain.state).toBe('removing');
      const [stored] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, domain.id)),
      );
      expect(stored).toMatchObject({
        failureReason: null,
        nextCheckAt: NOW,
        removalRequestedAt: NOW,
        state: 'removing',
      });
      const { audits, events } = await trail(orgId, hostname);
      expect(audits).toContainEqual({
        action: 'domain.removal-requested',
        metadata: { hostname, projectId },
      });
      expect(events.filter((event) => event.type === 'domain.removing')).toEqual([
        {
          payload: { domainId: domain.id, orgId, projectId, reason: null },
          type: 'domain.removing',
        },
      ]);

      // Removing again answers the same, and writes nothing more.
      const again = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.remove(tx, { orgId, projectId }, userId, domain.id),
      );
      expect(again).toEqual(removed);
      expect((await trail(orgId, hostname)).events).toHaveLength(events.length);

      // The hostname is still held while removing (FR-025).
      const refused = await transactions
        .runInTenantTransaction(orgId, (tx) =>
          service.add(tx, { orgId, projectId }, userId, { hostname }),
        )
        .catch((caught: unknown) => caught);
      expect(refused).toMatchObject(refusal('hostname-unavailable'));
    });

    it('a transaction that fails after the remove leaves the domain as it was, with no trail', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, { hostname }),
      );
      const before = await trail(orgId, hostname);

      await expect(
        transactions.runInTenantTransaction(orgId, async (tx) => {
          await service.remove(tx, { orgId, projectId }, userId, domain.id);
          throw new Error('after the remove');
        }),
      ).rejects.toThrow('after the remove');

      const [stored] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, domain.id)),
      );
      expect(stored).toMatchObject({ removalRequestedAt: null, state: 'pending' });
      expect(await trail(orgId, hostname)).toEqual(before);
    });

    it('a removed domain is not-found; a failed one is removed at once and its hostname released', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, { hostname }),
      );
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.domains)
          .set({ failureReason: 'verification-timeout', state: 'failed' })
          .where(eq(schema.domains.id, domain.id)),
      );

      const removed = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.remove(tx, { orgId, projectId }, userId, domain.id),
      );
      expect(removed.domain.state).toBe('failed');

      const [stored] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, domain.id)),
      );
      expect(stored).toMatchObject({ edgeId: null, failureReason: null, state: 'removed' });
      await expect(
        transactions.runInTenantTransaction(orgId, (tx) =>
          service.remove(tx, { orgId, projectId }, userId, domain.id),
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it(`the ${DOMAINS_PER_PROJECT + 1}th live domain on a project is refused with limit ${DOMAINS_PER_PROJECT}; failed and removed do not count`, async () => {
      const who = await tenant();
      await seed(who.orgId, who.projectId, DOMAINS_PER_PROJECT - 2, 'pending');
      await seed(who.orgId, who.projectId, 1, 'removing');
      await seed(who.orgId, who.projectId, 3, 'failed');
      await seed(who.orgId, who.projectId, 2, 'removed');

      // Nine live: the tenth is accepted.
      await expect(addTo(who, who.projectId)).resolves.toMatchObject({ state: 'pending' });

      const refused = await addTo(who, who.projectId).catch((caught: unknown) => caught);
      expect(refused).toMatchObject({
        extensions: { limit: DOMAINS_PER_PROJECT, reason: 'domain-limit' },
        type: 'conflict',
      });

      // Another project in the same org is not held back by this one.
      await expect(addTo(who, await projectIn(who.orgId, who.userId))).resolves.toMatchObject({
        state: 'pending',
      });
    });

    it(`the ${DOMAINS_PER_ORG + 1}st live domain in an org is refused with limit ${DOMAINS_PER_ORG}; failed and removed do not count`, async () => {
      const who = await tenant();
      const filled = [who.projectId];
      for (let index = 1; index < 5; index += 1)
        filled.push(await projectIn(who.orgId, who.userId));
      for (const [index, projectId] of filled.entries()) {
        // 10 + 10 + 10 + 10 + 9 = 49 live.
        await seed(
          who.orgId,
          projectId,
          index === 4 ? DOMAINS_PER_PROJECT - 1 : DOMAINS_PER_PROJECT,
        );
      }
      const fresh = await projectIn(who.orgId, who.userId);
      await seed(who.orgId, fresh, 4, 'failed');
      await seed(who.orgId, fresh, 4, 'removed');

      await expect(addTo(who, fresh)).resolves.toMatchObject({ state: 'pending' });

      const refused = await addTo(who, fresh).catch((caught: unknown) => caught);
      expect(refused).toMatchObject({
        extensions: { limit: DOMAINS_PER_ORG, reason: 'domain-limit' },
        type: 'conflict',
      });

      // Another org is not held back by this one.
      const other = await tenant();
      await expect(addTo(other, other.projectId)).resolves.toMatchObject({ state: 'pending' });
    });

    it(`two concurrent adds at ${DOMAINS_PER_ORG - 1} live in the org: exactly one succeeds`, async () => {
      const who = await tenant();
      const filled = [who.projectId];
      for (let index = 1; index < 5; index += 1)
        filled.push(await projectIn(who.orgId, who.userId));
      for (const [index, projectId] of filled.entries()) {
        await seed(
          who.orgId,
          projectId,
          index === 4 ? DOMAINS_PER_PROJECT - 1 : DOMAINS_PER_PROJECT,
        );
      }
      const first = await projectIn(who.orgId, who.userId);
      const second = await projectIn(who.orgId, who.userId);

      const results = await Promise.allSettled([addTo(who, first), addTo(who, second)]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        extensions: { limit: DOMAINS_PER_ORG, reason: 'domain-limit' },
        type: 'conflict',
      });
      const live = await transactions.runInTenantTransaction(who.orgId, (tx) =>
        tx
          .select({ id: schema.domains.id })
          .from(schema.domains)
          .where(eq(schema.domains.state, 'pending')),
      );
      expect(live).toHaveLength(DOMAINS_PER_ORG);
    });

    /** Settles a domain `failed` straight in the table, as the checker would at the window's end. */
    function fail(orgId: string, domainId: string) {
      return transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.domains)
          .set({
            checkRequestedAt: NOW,
            failureCount: 3,
            failureReason: 'verification-timeout',
            lastCheck: {
              at: NOW.toISOString(),
              caa: { verdict: 'permitted' },
              certificateRecords: [],
              conclusive: true,
              edge: null,
              edgeMessage: null,
              records: [
                { purpose: 'ownership', status: 'found' },
                { purpose: 'routing', status: 'missing' },
              ],
            },
            nextCheckAt: new Date(NOW.getTime() + WINDOW_MS),
            ownershipVerifiedAt: NOW,
            state: 'failed',
            windowStartedAt: new Date(NOW.getTime() - WINDOW_MS),
          })
          .where(eq(schema.domains.id, domainId)),
      );
    }

    it('retry moves a failed domain back to pending with a new token and window, one audit row and one domain.retried', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, { hostname }),
      );
      const [{ ownershipToken: before }] = (await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ ownershipToken: schema.domains.ownershipToken })
          .from(schema.domains)
          .where(eq(schema.domains.id, domain.id)),
      )) as [{ ownershipToken: string }];
      await fail(orgId, domain.id);

      const retried = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.retry(tx, { orgId, projectId }, userId, domain.id),
      );

      expect(retried).toMatchObject({ check: null, failureReason: null, state: 'pending' });
      const [stored] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, domain.id)),
      );
      expect(stored).toMatchObject({
        checkRequestedAt: null,
        failureCount: 0,
        failureReason: null,
        lastCheck: null,
        nextCheckAt: NOW,
        ownershipVerifiedAt: null,
        state: 'pending',
        windowStartedAt: NOW,
      });
      expect(stored!.ownershipToken).toMatch(/^[a-z2-7]{32}$/);
      expect(stored!.ownershipToken).not.toBe(before);
      const { audits, events } = await trail(orgId, hostname);
      expect(audits).toContainEqual({
        action: 'domain.retried',
        metadata: { hostname, projectId },
      });
      expect(events.filter((event) => event.type === 'domain.retried')).toEqual([
        { payload: { domainId: domain.id, orgId, projectId }, type: 'domain.retried' },
      ]);

      // Now pending, a second retry is refused.
      await expect(
        transactions.runInTenantTransaction(orgId, (tx) =>
          service.retry(tx, { orgId, projectId }, userId, domain.id),
        ),
      ).rejects.toMatchObject(refusal('not-retryable'));
    });

    it('retry when another org now holds the hostname is hostname-unavailable, and the domain stays failed', async () => {
      const mine = await tenant();
      const theirs = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      const domain = await transactions.runInTenantTransaction(mine.orgId, (tx) =>
        service.add(tx, mine, mine.userId, { hostname }),
      );
      await fail(mine.orgId, domain.id);
      // Failed holds nothing, so another org may take the hostname.
      await transactions.runInTenantTransaction(theirs.orgId, (tx) =>
        service.add(tx, theirs, theirs.userId, { hostname }),
      );
      const before = await trail(mine.orgId, hostname);

      const refused = await transactions
        .runInTenantTransaction(mine.orgId, (tx) => service.retry(tx, mine, mine.userId, domain.id))
        .catch((caught: unknown) => caught);

      expect(refused).toMatchObject(refusal('hostname-unavailable'));
      const [stored] = await transactions.runInTenantTransaction(mine.orgId, (tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, domain.id)),
      );
      expect(stored).toMatchObject({ failureReason: 'verification-timeout', state: 'failed' });
      expect(await trail(mine.orgId, hostname)).toEqual(before);
    });

    it('a failed domain that was removed cannot be retried: not-found', async () => {
      const { orgId, projectId, userId } = await tenant();
      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, {
          hostname: `app-${randomUUID().slice(0, 8)}.acme.test`,
        }),
      );
      await fail(orgId, domain.id);
      await transactions.runInTenantTransaction(orgId, (tx) =>
        service.remove(tx, { orgId, projectId }, userId, domain.id),
      );

      await expect(
        transactions.runInTenantTransaction(orgId, (tx) =>
          service.retry(tx, { orgId, projectId }, userId, domain.id),
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it('check now stamps check_requested_at and next_check_at with one domain.check-requested; a second is 429', async () => {
      const { orgId, projectId, userId } = await tenant();
      const hostname = `app-${randomUUID().slice(0, 8)}.acme.test`;
      const domain = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.add(tx, { orgId, projectId }, userId, { hostname }),
      );
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .update(schema.domains)
          .set({ nextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000) })
          .where(eq(schema.domains.id, domain.id)),
      );

      const checked = await transactions.runInTenantTransaction(orgId, (tx) =>
        service.checkNow(tx, { orgId, projectId }, domain.id),
      );

      expect(checked.checkAvailableAt).toBe(
        new Date(NOW.getTime() + CHECK_NOW_MIN_INTERVAL_MS).toISOString(),
      );
      const [stored] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, domain.id)),
      );
      expect(stored).toMatchObject({ checkRequestedAt: NOW, nextCheckAt: NOW, state: 'pending' });
      const requested = (await trail(orgId, hostname)).events.filter(
        (event) => event.type === 'domain.check-requested',
      );
      expect(requested).toEqual([
        { payload: { domainId: domain.id, orgId, projectId }, type: 'domain.check-requested' },
      ]);

      const refused = await transactions
        .runInTenantTransaction(orgId, (tx) =>
          service.checkNow(tx, { orgId, projectId }, domain.id),
        )
        .catch((caught: unknown) => caught);
      expect(refused).toMatchObject({ extensions: { retryAfter: 60 }, type: 'rate-limited' });
      expect(
        (await trail(orgId, hostname)).events.filter(
          (event) => event.type === 'domain.check-requested',
        ),
      ).toHaveLength(1);
    });

    it('a project of another org is not-found for add, list and get', async () => {
      const mine = await tenant();
      const theirs = await tenant();
      const foreign = { orgId: mine.orgId, projectId: theirs.projectId };

      await transactions.runInTenantTransaction(mine.orgId, async (tx) => {
        await expect(
          service.add(tx, foreign, mine.userId, { hostname: 'x.acme.test' }),
        ).rejects.toMatchObject({ type: 'not-found' });
        await expect(service.list(tx, foreign, mine.userId)).rejects.toMatchObject({
          type: 'not-found',
        });
        await expect(service.get(tx, foreign, randomUUID())).rejects.toMatchObject({
          type: 'not-found',
        });
      });
    });
  });
});

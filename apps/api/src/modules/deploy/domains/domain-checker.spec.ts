import type { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { FakeDns } from '../../../../test/support/fake-dns';
import { type FakeCloudflare, startFakeCloudflare } from '../../../../test/support/fake-cloudflare';
import { AppModule } from '../../../app.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { CloudflareForSaasAdapter } from './cloudflare-for-saas.adapter';
import { CHALLENGE_PREFIX, CLAIM_LEASE_MS } from './domain.constants';
import { HostnameHeld } from './domain.errors';
import { type Domain, DomainRepository } from './domain.repository';
import { type CheckRun, DomainChecker } from './domain-checker';
import { DomainNotices } from './domain-notices';
import { ownershipToken, ownershipTxtValue } from './ownership-token';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TARGET = 'edge.forge-domains.test';

/**
 * Spec 028 T042 (research R6, R7): one domain's check is claim (tenant transaction) → observe (no
 * transaction) → settle (tenant transaction), against the test database, `FakeDns` and the real
 * `CloudflareForSaasAdapter` pointed at `startFakeCloudflare`. Every transition writes its audit
 * row and outbox event in the settle transaction, or nothing does (SC-013, FR-027).
 */
describe('DomainChecker', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let outbox: OutboxWriter;
    let edgeFake: FakeCloudflare;
    const repository = new DomainRepository();
    const dns = new FakeDns();
    const clock = new FakeClock('2026-09-23T12:00:00.000Z');
    let checker: DomainChecker;
    let orgId: string;
    let userId: string;
    let projectId: string;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function config<T extends Record<string, unknown>>(values: T) {
      return { get: (key: keyof T) => values[key] } as unknown as ConfigService<Environment, true>;
    }

    async function added(): Promise<Domain> {
      return inTenant((tx) =>
        repository.insert(tx, {
          addedBy: userId,
          hostname: `app-${randomUUID().slice(0, 8)}.example.test`,
          now: clock.now(),
          orgId,
          ownershipToken: ownershipToken(),
          projectId,
        }),
      );
    }

    function publishOwnership(domain: Domain): void {
      dns.set(`${CHALLENGE_PREFIX}${domain.hostname}`, 'TXT', [
        ownershipTxtValue(domain.ownershipToken),
      ]);
    }

    function publishRouting(domain: Domain): void {
      dns.set(domain.hostname, 'CNAME', TARGET);
    }

    async function row(id: string): Promise<Domain> {
      const [found] = await inTenant((tx) =>
        tx.select().from(schema.domains).where(eq(schema.domains.id, id)),
      );
      return { ...found!, lastCheck: found!.lastCheck as Domain['lastCheck'] };
    }

    /** The audit rows and events written about `domainId` (target / aggregate id). */
    async function trail(domainId: string) {
      const audits = await inTenant((tx) =>
        tx
          .select({
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            metadata: schema.auditLog.metadata,
          })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, domainId)),
      );
      const events = await database
        .select({ payload: schema.outbox.payload, type: schema.outbox.type })
        .from(schema.outbox)
        .where(and(eq(schema.outbox.aggregateId, domainId), eq(schema.outbox.aggregate, 'domain')));
      return { audits, events };
    }

    /** Moves the clock past the domain's due time (the claim lease or the next check). */
    async function whenDue(domainId: string): Promise<void> {
      const due = (await row(domainId)).nextCheckAt.getTime();
      if (due > clock.now().getTime()) clock.set(due);
    }

    /** A domain whose 72 h window has just ended (US4), due now; `values` register it and so on. */
    async function atWindowEnd(
      values: Partial<typeof schema.domains.$inferInsert> = {},
    ): Promise<Domain> {
      const domain = await added();
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({
            nextCheckAt: clock.now(),
            windowStartedAt: new Date(clock.now().getTime() - 72 * HOUR),
            ...values,
          })
          .where(eq(schema.domains.id, domain.id)),
      );
      return row(domain.id);
    }

    function posts(): number {
      return edgeFake.requests.filter((request) => request.method === 'POST').length;
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      outbox = moduleRef.get(OutboxWriter, { strict: false });
      edgeFake = await startFakeCloudflare();

      checker = new DomainChecker(
        transactions,
        repository,
        moduleRef.get(AuditService, { strict: false }),
        outbox,
        clock,
        dns,
        new CloudflareForSaasAdapter(
          config({
            CLOUDFLARE_API_TOKEN: edgeFake.apiToken,
            CLOUDFLARE_API_URL: edgeFake.apiUrl,
            CLOUDFLARE_ZONE_ID: edgeFake.zoneId,
            CUSTOM_HOSTNAME_CA: 'lets_encrypt',
          }),
          2_000,
        ),
        config({ CUSTOM_HOSTNAME_CA: 'lets_encrypt', CUSTOM_HOSTNAME_TARGET: TARGET }),
        moduleRef.get(DomainNotices, { strict: false }),
      );

      const [user] = await database
        .insert(schema.users)
        .values({ email: `028c-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Domain checker fixture',
          slug: `028c-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      projectId = (
        await transactions.runInTenantScope({ orgId, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: 'Domains',
            orgId,
            ownerId: userId,
            workspaceId: workspace!.id,
          }),
        )
      ).id;
    }, 60_000);

    afterEach(() => {
      dns.reset();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await edgeFake?.close();
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('checks nothing when the row is not due', async () => {
      const domain = await added();
      await inTenant((tx) => repository.claim(tx, domain.id, clock.now()));

      await expect(checker.checkOne(orgId, domain.id)).resolves.toEqual({ kind: 'not-due' });
      expect(dns.queries).toEqual([]);
    });

    it('with nothing published: still pending, no registration, and the pending cadence', async () => {
      const domain = await added();
      const posts = () => edgeFake.requests.filter((request) => request.method === 'POST').length;
      const before = posts();

      const run = await checker.checkOne(orgId, domain.id);

      expect(run).toMatchObject({ kind: 'settled', transition: null });
      const after = await row(domain.id);
      expect(after).toMatchObject({
        edgeId: null,
        nextCheckAt: new Date(clock.now().getTime() + MINUTE),
        ownershipVerifiedAt: null,
        state: 'pending',
      });
      expect(after.lastCheck).toMatchObject({
        conclusive: true,
        edge: null,
        records: [
          { purpose: 'ownership', status: 'missing' },
          { purpose: 'routing', status: 'missing' },
        ],
      });
      expect(posts()).toBe(before);
      // The CAA chain: the hostname and its parent above the top-level label (R5).
      expect(dns.queries.map((query) => query.type).sort()).toEqual([
        'CAA',
        'CAA',
        'CNAME',
        'SOA',
        'TXT',
      ]);
      expect(await trail(domain.id)).toEqual({ audits: [], events: [] });
    });

    it('changes nothing on an inconclusive check but the next time, 5 minutes away', async () => {
      const domain = await added();
      dns.unavailable(domain.hostname);

      await checker.checkOne(orgId, domain.id);

      const after = await row(domain.id);
      expect(after).toMatchObject({
        failureCount: 0,
        nextCheckAt: new Date(clock.now().getTime() + 5 * MINUTE),
        state: 'pending',
      });
      expect(after.lastCheck?.conclusive).toBe(false);
    });

    it('registers once ownership is proved, audits it without an event, then activates on an active edge', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);

      await checker.checkOne(orgId, domain.id);

      const registered = await row(domain.id);
      const edgeRecord = edgeFake.find(domain.hostname);
      expect(edgeRecord).toBeDefined();
      expect(registered).toMatchObject({
        edgeId: edgeRecord!.id,
        ownershipVerifiedAt: clock.now(),
        state: 'pending',
      });
      expect(await trail(domain.id)).toEqual({
        audits: [
          {
            action: 'domain.ownership-verified',
            actorId: null,
            metadata: { hostname: domain.hostname, projectId },
          },
        ],
        events: [],
      });

      // The hostname goes active at the edge before its certificate: still pending (FR-009).
      edgeFake.scriptStatus(domain.hostname, [
        { ssl: 'pending_validation', status: 'active' },
        { ssl: 'active', status: 'active' },
      ]);
      await whenDue(domain.id);
      await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
        transition: null,
      });
      expect(await row(domain.id)).toMatchObject({ certificateActiveAt: null, state: 'pending' });

      await whenDue(domain.id);
      await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
        transition: { failureReason: null, from: 'pending', to: 'active' },
      });
      expect(await row(domain.id)).toMatchObject({
        activatedAt: clock.now(),
        certificateActiveAt: clock.now(),
        state: 'active',
      });

      const { audits, events } = await trail(domain.id);
      expect(audits.filter((audit) => audit.action === 'domain.activated')).toEqual([
        {
          action: 'domain.activated',
          actorId: null,
          metadata: { hostname: domain.hostname, projectId },
        },
      ]);
      expect(events).toEqual([
        { payload: { domainId: domain.id, orgId, projectId }, type: 'domain.activated' },
      ]);
    });

    it('ends the domain failed / provider-refused at once when the edge refuses the registration', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);
      edgeFake.refuseNext(400, 'Custom hostname is not allowed on this zone.');

      await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
        transition: { failureReason: 'provider-refused', from: 'pending', to: 'failed' },
      });

      const after = await row(domain.id);
      expect(after).toMatchObject({
        edgeId: null,
        failureReason: 'provider-refused',
        state: 'failed',
      });
      expect(after.lastCheck?.edgeMessage).toBe('Custom hostname is not allowed on this zone.');
      expect(edgeFake.find(domain.hostname)).toBeUndefined();

      const { audits, events } = await trail(domain.id);
      expect(audits.filter((audit) => audit.action === 'domain.failed')).toEqual([
        {
          action: 'domain.failed',
          actorId: null,
          metadata: { hostname: domain.hostname, projectId, reason: 'provider-refused' },
        },
      ]);
      // Well before the window's end, with its domain-failed mail to the one owner who added it.
      expect(after.windowStartedAt.getTime() + 72 * HOUR).toBeGreaterThan(clock.now().getTime());
      expect(events).toEqual([
        {
          payload: { domainId: domain.id, orgId, projectId, reason: 'provider-refused' },
          type: 'domain.failed',
        },
        {
          payload: { domainId: domain.id, notice: 'failed', recipient: userId },
          type: 'mail.domain',
        },
      ]);

      // Released at once: the hostname can be added again.
      await expect(
        inTenant((tx) =>
          repository.insert(tx, {
            addedBy: userId,
            hostname: domain.hostname,
            now: clock.now(),
            orgId,
            ownershipToken: ownershipToken(),
            projectId,
          }),
        ),
      ).resolves.toMatchObject({ state: 'pending' });
    });

    it('leaves the domain unregistered and pending when the edge is unavailable at registration', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);
      edgeFake.failNext(503);

      await checker.checkOne(orgId, domain.id);

      expect(await row(domain.id)).toMatchObject({
        edgeId: null,
        ownershipVerifiedAt: clock.now(),
        state: 'pending',
      });
      expect(edgeFake.find(domain.hostname)).toBeUndefined();

      // The next check registers.
      await whenDue(domain.id);
      await checker.checkOne(orgId, domain.id);
      expect((await row(domain.id)).edgeId).toBe(edgeFake.find(domain.hostname)?.id);
    });

    it('treats an edge status it cannot get as inconclusive', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);
      await checker.checkOne(orgId, domain.id);
      await whenDue(domain.id);
      edgeFake.failNext(503);

      await checker.checkOne(orgId, domain.id);

      const after = await row(domain.id);
      expect(after.lastCheck?.conclusive).toBe(false);
      expect(after.nextCheckAt).toEqual(new Date(clock.now().getTime() + 5 * MINUTE));
    });

    it('writes nothing, and deregisters what it registered, when the row moved during the check', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);
      const resolveTxt = dns.resolveTxt.bind(dns);
      vi.spyOn(dns, 'resolveTxt').mockImplementation(async (name) => {
        // A removal (US2) settling the row while this check observes.
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({ failureReason: 'verification-timeout', state: 'failed' })
            .where(eq(schema.domains.id, domain.id)),
        );
        return resolveTxt(name);
      });

      await expect(checker.checkOne(orgId, domain.id)).resolves.toEqual({ kind: 'moved' });

      expect(await row(domain.id)).toMatchObject({
        edgeId: null,
        lastCheck: null,
        state: 'failed',
      });
      expect(edgeFake.find(domain.hostname)).toBeUndefined();
      expect(await trail(domain.id)).toEqual({ audits: [], events: [] });
    });

    /**
     * The removal race (research R10): a removal committed while a check is in flight must not
     * let the `domain.removing` check claim the row and settle it `removed` — releasing the
     * hostname — while the in-flight check is registering it at the edge. The removal leaves the
     * lease alone; the in-flight check hands what it registered to the removing row, and the row
     * is deregistered before it is released.
     */
    it('never releases a hostname removed mid-check before the edge lets go of what the check registered', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);
      const resolveTxt = dns.resolveTxt.bind(dns);
      const concurrent: CheckRun[] = [];
      let heldWhileInFlight: Domain['state'] | undefined;
      vi.spyOn(dns, 'resolveTxt').mockImplementationOnce(async (name) => {
        // Mid-observe: a member removes it, and the `domain.removing` consumer runs at once.
        await inTenant(async (tx) => {
          const [moved] = await repository.markRemoving(
            tx,
            orgId,
            { ids: [domain.id] },
            clock.now(),
          );
          expect(moved).toMatchObject({ state: 'removing' });
        });
        concurrent.push(await checker.checkOne(orgId, domain.id));
        heldWhileInFlight = (await row(domain.id)).state;
        return resolveTxt(name);
      });

      await expect(checker.checkOne(orgId, domain.id)).resolves.toEqual({ kind: 'moved' });

      expect(concurrent).toEqual([{ kind: 'not-due' }]);
      expect(heldWhileInFlight).toBe('removing');
      // What the in-flight check registered was handed over, deregistered, then released.
      expect(edgeFake.find(domain.hostname)).toBeUndefined();
      expect(await row(domain.id)).toMatchObject({
        claimedAt: null,
        edgeId: null,
        state: 'removed',
      });
      const { audits } = await trail(domain.id);
      expect(audits.map((audit) => audit.action)).toEqual(['domain.removed']);
    });

    /**
     * The check-now race (research R7, FR-012): a check-now arriving while a check is in flight
     * must not cut its claim lease short, or a second check claims the row and both register the
     * hostname at the edge. The request is served by a follow-up check straight after instead.
     */
    it('never claims a row twice when a check-now arrives mid-check, and checks it again straight after', async () => {
      const domain = await added();
      publishOwnership(domain);
      publishRouting(domain);
      const before = posts();
      const claim = vi.spyOn(repository, 'claim');
      const resolveTxt = dns.resolveTxt.bind(dns);
      const concurrent: CheckRun[] = [];
      vi.spyOn(dns, 'resolveTxt').mockImplementationOnce(async (name) => {
        // Mid-observe: the member asks for a check, and the check-now consumer runs at once.
        await expect(
          inTenant((tx) => repository.requestCheck(tx, domain.id, clock.now())),
        ).resolves.toBeDefined();
        concurrent.push(await checker.checkOne(orgId, domain.id));
        return resolveTxt(name);
      });

      await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
        kind: 'settled',
      });

      expect(concurrent).toEqual([{ kind: 'not-due' }]);
      // One registration: the second check never claimed the row.
      expect(posts() - before).toBe(1);
      // The claim, the concurrent miss, then the follow-up that served the request.
      expect(claim).toHaveBeenCalledTimes(3);
      await expect(claim.mock.results[2]!.value).resolves.toMatchObject({ id: domain.id });
      const after = await row(domain.id);
      expect(after).toMatchObject({ claimedAt: null, edgeId: edgeFake.find(domain.hostname)?.id });
      // The follow-up settled to the pending cadence, not due at once again.
      expect(after.nextCheckAt).toEqual(new Date(clock.now().getTime() + MINUTE));
      const { audits } = await trail(domain.id);
      expect(audits.map((audit) => audit.action)).toEqual(['domain.ownership-verified']);
    });

    /**
     * Spec 028 T068 (research R6, US4): at the end of the 72 h window an unregistered domain ends
     * `failed` directly; a registered one goes `removing` with its reason, is deregistered, and
     * then ends `failed` with that reason. Either way one `domain-failed` mail per recipient.
     */
    describe('the end of the window (US4)', () => {
      it('ends an unregistered domain failed / verification-timeout, with no registration and its mail', async () => {
        const domain = await atWindowEnd();
        const before = posts();

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: 'verification-timeout', from: 'pending', to: 'failed' },
        });

        expect(posts()).toBe(before);
        expect(await row(domain.id)).toMatchObject({
          claimedAt: null,
          edgeId: null,
          failureReason: 'verification-timeout',
          state: 'failed',
        });
        expect(await trail(domain.id)).toEqual({
          audits: [
            {
              action: 'domain.failed',
              actorId: null,
              metadata: { hostname: domain.hostname, projectId, reason: 'verification-timeout' },
            },
          ],
          events: [
            {
              payload: { domainId: domain.id, orgId, projectId, reason: 'verification-timeout' },
              type: 'domain.failed',
            },
            {
              payload: { domainId: domain.id, notice: 'failed', recipient: userId },
              type: 'mail.domain',
            },
          ],
        });

        // Ended: never checked again.
        clock.advance(CLAIM_LEASE_MS);
        await expect(checker.checkOne(orgId, domain.id)).resolves.toEqual({ kind: 'not-due' });
      });

      it('deregisters a registered domain without its certificate, then ends it failed / certificate-failed', async () => {
        const hostname = `app-${randomUUID().slice(0, 8)}.example.test`;
        const edgeId = edgeFake.seed(hostname, { ssl: 'pending', status: 'active' });
        const domain = await atWindowEnd({
          edgeId,
          hostname,
          ownershipVerifiedAt: new Date(clock.now().getTime() - 71 * HOUR),
        });
        publishRouting(domain);

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: 'certificate-failed', from: 'pending', to: 'removing' },
        });
        expect(await row(domain.id)).toMatchObject({
          edgeId,
          failureReason: 'certificate-failed',
          nextCheckAt: clock.now(),
          removalRequestedAt: clock.now(),
          state: 'removing',
        });
        expect(await trail(domain.id)).toEqual({
          audits: [
            {
              action: 'domain.removal-requested',
              actorId: null,
              metadata: { hostname, projectId, reason: 'certificate-failed' },
            },
          ],
          events: [
            {
              payload: { domainId: domain.id, orgId, projectId, reason: 'certificate-failed' },
              type: 'domain.removing',
            },
          ],
        });

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: 'certificate-failed', from: 'removing', to: 'failed' },
        });
        expect(
          edgeFake.requests.filter(
            (request) => request.method === 'DELETE' && request.path.endsWith(`/${edgeId}`),
          ),
        ).toHaveLength(1);
        expect(await row(domain.id)).toMatchObject({
          edgeId: null,
          failureReason: 'certificate-failed',
          state: 'failed',
        });
        const { audits, events } = await trail(domain.id);
        expect(audits.map((audit) => audit.action).sort()).toEqual([
          'domain.failed',
          'domain.removal-requested',
        ]);
        expect(events.map((event) => event.type).sort()).toEqual([
          'domain.failed',
          'domain.removing',
          'mail.domain',
        ]);
      });
    });

    /**
     * Spec 028 T050 (research R10): a `removing` row is deregistered at the edge by the same
     * claim → settle, and only the edge's confirmation lets the hostname go. It settles `failed`
     * when a failure reason rides on it and `removed` otherwise, with `edge_id` cleared.
     */
    describe('deregistration (R10)', () => {
      /** A domain sent to removal with its registration at the edge (or none), due now. */
      async function removing(
        options: { failureReason?: Domain['failureReason']; registered?: boolean } = {},
      ): Promise<Domain> {
        const domain = await added();
        const edgeId =
          options.registered === false
            ? null
            : edgeFake.seed(domain.hostname, { status: 'active' });
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({
              edgeId,
              failureReason: options.failureReason ?? null,
              nextCheckAt: clock.now(),
              removalRequestedAt: clock.now(),
              state: 'removing',
            })
            .where(eq(schema.domains.id, domain.id)),
        );
        return row(domain.id);
      }

      function deletes(edgeId: string) {
        return edgeFake.requests.filter(
          (request) => request.method === 'DELETE' && request.path.endsWith(`/${edgeId}`),
        );
      }

      function addAgain(hostname: string): Promise<Domain> {
        return inTenant((tx) =>
          repository.insert(tx, {
            addedBy: userId,
            hostname,
            now: clock.now(),
            orgId,
            ownershipToken: ownershipToken(),
            projectId,
          }),
        );
      }

      it('deregisters a removing row and settles it removed, edge_id cleared, with domain.removed', async () => {
        const domain = await removing();
        const edgeId = domain.edgeId!;

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          kind: 'settled',
          transition: { failureReason: null, from: 'removing', to: 'removed' },
        });

        expect(deletes(edgeId)).toHaveLength(1);
        expect(edgeFake.find(domain.hostname)).toBeUndefined();
        expect(await row(domain.id)).toMatchObject({
          edgeId: null,
          failureReason: null,
          state: 'removed',
        });
        // Deregistration asks the edge, never DNS.
        expect(dns.queries).toEqual([]);
        expect(await trail(domain.id)).toEqual({
          audits: [
            {
              action: 'domain.removed',
              actorId: null,
              metadata: { hostname: domain.hostname, projectId },
            },
          ],
          events: [{ payload: { domainId: domain.id, orgId, projectId }, type: 'domain.removed' }],
        });

        // Released: the hostname can be added again, and the removed row is checked no more.
        await expect(addAgain(domain.hostname)).resolves.toMatchObject({ state: 'pending' });
        clock.advance(CLAIM_LEASE_MS);
        await expect(checker.checkOne(orgId, domain.id)).resolves.toEqual({ kind: 'not-due' });
      });

      it('settles failed with the reason it carried when heading for failed', async () => {
        const domain = await removing({ failureReason: 'verification-timeout' });

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: 'verification-timeout', from: 'removing', to: 'failed' },
        });

        expect(await row(domain.id)).toMatchObject({
          edgeId: null,
          failureReason: 'verification-timeout',
          state: 'failed',
        });
        expect(edgeFake.find(domain.hostname)).toBeUndefined();
        expect(await trail(domain.id)).toEqual({
          audits: [
            {
              action: 'domain.failed',
              actorId: null,
              metadata: {
                hostname: domain.hostname,
                projectId,
                reason: 'verification-timeout',
              },
            },
          ],
          events: [
            {
              payload: { domainId: domain.id, orgId, projectId, reason: 'verification-timeout' },
              type: 'domain.failed',
            },
            {
              payload: { domainId: domain.id, notice: 'failed', recipient: userId },
              type: 'mail.domain',
            },
          ],
        });
      });

      it('counts an edge that no longer knows the registration (404) as done', async () => {
        const domain = await removing();
        edgeFake.hostnames.delete(domain.edgeId!);

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { from: 'removing', to: 'removed' },
        });
        expect(deletes(domain.edgeId!)).toHaveLength(1);
        expect(await row(domain.id)).toMatchObject({ edgeId: null, state: 'removed' });
      });

      it('keeps a row removing, rescheduled by the backoff, while the edge fails retryably; the hostname stays held', async () => {
        const domain = await removing({ failureReason: 'routing-not-found' });
        const requestedAt = clock.now().getTime();
        edgeFake.failNext(503);

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          kind: 'settled',
          transition: null,
        });

        const held = await row(domain.id);
        expect(held).toMatchObject({
          edgeId: domain.edgeId,
          failureReason: 'routing-not-found',
          nextCheckAt: new Date(requestedAt + MINUTE),
          state: 'removing',
        });
        expect(edgeFake.find(domain.hostname)).toBeDefined();
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });
        await expect(addAgain(domain.hostname)).rejects.toThrow(HostnameHeld);

        // Two minutes into the removal, a second failure waits two minutes (T048's backoff).
        clock.set(requestedAt + 2 * MINUTE);
        edgeFake.failNext(429);
        await checker.checkOne(orgId, domain.id);
        expect((await row(domain.id)).nextCheckAt).toEqual(new Date(requestedAt + 4 * MINUTE));
        await expect(addAgain(domain.hostname)).rejects.toThrow(HostnameHeld);

        // The edge answers: failed, as it was heading, and the hostname is free.
        await whenDue(domain.id);
        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: 'routing-not-found', from: 'removing', to: 'failed' },
        });
        expect(edgeFake.find(domain.hostname)).toBeUndefined();
        await expect(addAgain(domain.hostname)).resolves.toMatchObject({ state: 'pending' });
      });

      it('settles a removing row with no edge_id at once, asking the edge nothing', async () => {
        const domain = await removing({ registered: false });
        const before = edgeFake.requests.length;

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: null, from: 'removing', to: 'removed' },
        });

        expect(edgeFake.requests).toHaveLength(before);
        expect(await row(domain.id)).toMatchObject({ edgeId: null, state: 'removed' });
        expect((await trail(domain.id)).events.map((event) => event.type)).toEqual([
          'domain.removed',
        ]);
      });
    });

    /**
     * Spec 028 US3 (T061, T063; research R6, R7, R14): an `active` or `drifted` row observes the
     * CNAME chain, the CAA chain and the edge status, and no TXT or SOA. Drift, recovery, the
     * release warning and the 30-day release write their trail, and their notices, in the settle.
     */
    describe('active and drifted (US3)', () => {
      /** An `active` row registered at the fake edge (hostname and certificate active), due now. */
      async function activated(): Promise<Domain> {
        const domain = await added();
        const edgeId = edgeFake.seed(domain.hostname, { ssl: 'active', status: 'active' });
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({
              activatedAt: clock.now(),
              certificateActiveAt: clock.now(),
              edgeId,
              nextCheckAt: clock.now(),
              ownershipVerifiedAt: clock.now(),
              state: 'active',
            })
            .where(eq(schema.domains.id, domain.id)),
        );
        publishRouting(domain);
        return row(domain.id);
      }

      /** The CNAME deleted, and the edge reporting the hostname moved, as the vendor does. */
      function breakRouting(domain: Domain): void {
        dns.delete(domain.hostname, 'CNAME');
        edgeFake.scriptStatus(domain.hostname, [{ status: 'moved' }]);
      }

      /** The `mail.domain` payloads, by notice (the trail's query has no order). */
      function mails(events: { payload: unknown; type: string }[]) {
        return events
          .filter((event) => event.type === 'mail.domain')
          .map((event) => event.payload as { notice: string })
          .sort((a, b) => a.notice.localeCompare(b.notice));
      }

      it('asks the CNAME chain, the CAA chain and the edge, and no TXT or SOA; a pass is due in 24 h', async () => {
        const domain = await activated();

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          kind: 'settled',
          transition: null,
        });

        // Two CAA levels, and the chain's hops (the target's own CNAME answers empty).
        expect(new Set(dns.queries.map((query) => query.type))).toEqual(new Set(['CAA', 'CNAME']));
        expect(dns.queries.filter((query) => query.type === 'CAA')).toHaveLength(2);
        const after = await row(domain.id);
        expect(after).toMatchObject({ failureCount: 0, state: 'active' });
        expect(after.nextCheckAt).toEqual(new Date(clock.now().getTime() + DAY));
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });
      });

      it('drifts on the third consecutive failure, an hour apart, with domain.drifted and one drifted mail per recipient', async () => {
        const domain = await activated();
        breakRouting(domain);

        for (const failureCount of [1, 2]) {
          await whenDue(domain.id);
          await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
            transition: null,
          });
          const after = await row(domain.id);
          expect(after).toMatchObject({ failureCount, state: 'active' });
          expect(after.nextCheckAt).toEqual(new Date(clock.now().getTime() + HOUR));
        }
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });

        await whenDue(domain.id);
        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: null, from: 'active', to: 'drifted' },
        });
        expect(await row(domain.id)).toMatchObject({
          driftedAt: clock.now(),
          failureCount: 3,
          state: 'drifted',
        });

        const { audits, events } = await trail(domain.id);
        expect(audits).toEqual([
          {
            action: 'domain.drifted',
            actorId: null,
            metadata: { hostname: domain.hostname, projectId },
          },
        ]);
        // The fixture's only owner is also `added_by`: one recipient.
        expect(events).toHaveLength(2);
        expect(events).toEqual(
          expect.arrayContaining([
            { payload: { domainId: domain.id, orgId, projectId }, type: 'domain.drifted' },
            {
              payload: { domainId: domain.id, notice: 'drifted', recipient: userId },
              type: 'mail.domain',
            },
          ]),
        );

        // Further failures keep the count at 3 and write nothing more.
        await whenDue(domain.id);
        await checker.checkOne(orgId, domain.id);
        expect(await row(domain.id)).toMatchObject({ failureCount: 3, state: 'drifted' });
        expect((await trail(domain.id)).events).toHaveLength(2);

        // Restored: one pass recovers it.
        publishRouting(domain);
        edgeFake.scriptStatus(domain.hostname, [{ status: 'active' }]);
        await whenDue(domain.id);
        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: null, from: 'drifted', to: 'active' },
        });
        expect(await row(domain.id)).toMatchObject({
          driftedAt: null,
          failureCount: 0,
          releaseWarnedAt: null,
          state: 'active',
        });
        const recovered = await trail(domain.id);
        expect(recovered.audits.map((audit) => audit.action)).toEqual([
          'domain.drifted',
          'domain.recovered',
        ]);
        expect(recovered.events.map((event) => event.type).sort()).toEqual([
          'domain.drifted',
          'domain.recovered',
          'mail.domain',
        ]);
      });

      it('counts nothing while the edge is unavailable (FR-021)', async () => {
        const domain = await activated();
        breakRouting(domain);

        for (let check = 0; check < 3; check++) {
          await whenDue(domain.id);
          edgeFake.failNext(503);
          await checker.checkOne(orgId, domain.id);
        }

        expect(await row(domain.id)).toMatchObject({ failureCount: 0, state: 'active' });
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });
      });

      it('counts CAA blocking the pinned CA as a failure', async () => {
        const domain = await activated();
        dns.set(domain.hostname.split('.').slice(1).join('.'), 'CAA', [
          { critical: false, tag: 'issue', value: 'sectigo.com' },
        ]);

        await checker.checkOne(orgId, domain.id);

        const after = await row(domain.id);
        expect(after).toMatchObject({ failureCount: 1, state: 'active' });
        expect(after.lastCheck?.caa).toEqual({
          record: '0 issue "letsencrypt.org"',
          verdict: 'blocked',
          zone: domain.hostname.split('.').slice(1).join('.'),
        });
      });

      it('warns once at 23 days drifted, releases at 30, and mails domain-released when the edge lets it go', async () => {
        const domain = await activated();
        breakRouting(domain);
        const driftedAt = new Date(clock.now().getTime() - 23 * DAY);
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({ driftedAt, failureCount: 3, state: 'drifted' })
            .where(eq(schema.domains.id, domain.id)),
        );

        await checker.checkOne(orgId, domain.id);
        expect(await row(domain.id)).toMatchObject({
          releaseWarnedAt: clock.now(),
          state: 'drifted',
        });
        expect(mails((await trail(domain.id)).events)).toEqual([
          { domainId: domain.id, notice: 'release-warning', recipient: userId },
        ]);

        // The next hourly check warns no more.
        await whenDue(domain.id);
        await checker.checkOne(orgId, domain.id);
        expect(mails((await trail(domain.id)).events)).toHaveLength(1);

        // 30 days drifted: removing, with no reason and no author, due at once.
        clock.set(driftedAt.getTime() + 30 * DAY);
        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: null, from: 'drifted', to: 'removing' },
        });
        expect(await row(domain.id)).toMatchObject({
          driftedAt: null,
          failureReason: null,
          nextCheckAt: clock.now(),
          removalRequestedAt: clock.now(),
          state: 'removing',
        });
        const released = await trail(domain.id);
        expect(released.audits.filter((a) => a.action === 'domain.removal-requested')).toEqual([
          {
            action: 'domain.removal-requested',
            actorId: null,
            metadata: { hostname: domain.hostname, projectId },
          },
        ]);
        expect(released.events.filter((event) => event.type === 'domain.removing')).toEqual([
          {
            payload: { domainId: domain.id, orgId, projectId, reason: null },
            type: 'domain.removing',
          },
        ]);

        // Deregistered (the US2 path): removed, and one domain-released mail.
        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { failureReason: null, from: 'removing', to: 'removed' },
        });
        expect(edgeFake.find(domain.hostname)).toBeUndefined();
        expect(mails((await trail(domain.id)).events)).toEqual([
          { domainId: domain.id, notice: 'release-warning', recipient: userId },
          { domainId: domain.id, notice: 'released', recipient: userId },
        ]);
      });

      it('mails nothing when a member removes a warned drifted domain', async () => {
        const domain = await activated();
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({
              driftedAt: clock.now(),
              failureCount: 3,
              releaseWarnedAt: clock.now(),
              state: 'drifted',
            })
            .where(eq(schema.domains.id, domain.id)),
        );
        await inTenant((tx) =>
          repository.markRemoving(tx, orgId, { ids: [domain.id] }, clock.now()),
        );

        await expect(checker.checkOne(orgId, domain.id)).resolves.toMatchObject({
          transition: { to: 'removed' },
        });
        expect(mails((await trail(domain.id)).events)).toEqual([]);
      });
    });

    /**
     * SC-013, FR-027: the state write, its audit row and its event commit together or not at all.
     * The settle is forced to throw after the state write; afterwards the row is as the claim left
     * it and neither an audit row nor an event exists. The retried check then writes one of each.
     * US4 (T068) adds the window end's transitions and the mail on every `→ failed`.
     */
    describe('atomicity of a transition (SC-013)', () => {
      async function readyToActivate(): Promise<Domain> {
        const domain = await added();
        publishOwnership(domain);
        publishRouting(domain);
        edgeFake.scriptStatus(domain.hostname, [{ ssl: 'active', status: 'active' }]);
        await checker.checkOne(orgId, domain.id);
        await whenDue(domain.id);
        return domain;
      }

      it('pending → active', async () => {
        const domain = await readyToActivate();
        const before = await trail(domain.id);
        const settleSpy = vi.spyOn(repository, 'settle');
        const append = vi
          .spyOn(outbox, 'append')
          .mockRejectedValueOnce(new Error('forced after the state write'));

        await expect(checker.checkOne(orgId, domain.id)).rejects.toThrow(
          'forced after the state write',
        );

        // The state write happened inside the transaction before the throw, and rolled back.
        expect(settleSpy).toHaveBeenCalledTimes(1);
        await expect(settleSpy.mock.results[0]!.value).resolves.toMatchObject({ state: 'active' });
        const after = await row(domain.id);
        expect(after).toMatchObject({ activatedAt: null, state: 'pending' });
        expect(after.nextCheckAt).toEqual(new Date(clock.now().getTime() + CLAIM_LEASE_MS));
        expect(await trail(domain.id)).toEqual(before);

        append.mockRestore();
        await whenDue(domain.id);
        await checker.checkOne(orgId, domain.id);

        const { audits, events } = await trail(domain.id);
        expect(audits.filter((audit) => audit.action === 'domain.activated')).toHaveLength(1);
        expect(events.map((event) => event.type)).toEqual(['domain.activated']);
      });

      it('removing → removed', async () => {
        const domain = await added();
        const edgeId = edgeFake.seed(domain.hostname, { status: 'active' });
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({
              edgeId,
              nextCheckAt: clock.now(),
              removalRequestedAt: clock.now(),
              state: 'removing',
            })
            .where(eq(schema.domains.id, domain.id)),
        );
        const append = vi
          .spyOn(outbox, 'append')
          .mockRejectedValueOnce(new Error('forced after the state write'));

        await expect(checker.checkOne(orgId, domain.id)).rejects.toThrow(
          'forced after the state write',
        );

        // The edge deregistered it, but the row is as the claim left it: still removing, still
        // naming the registration, and the hostname still held.
        expect(await row(domain.id)).toMatchObject({ edgeId, state: 'removing' });
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });

        // The retry meets the edge's 404, which counts as done.
        append.mockRestore();
        await whenDue(domain.id);
        await checker.checkOne(orgId, domain.id);

        expect(await row(domain.id)).toMatchObject({ edgeId: null, state: 'removed' });
        const { audits, events } = await trail(domain.id);
        expect(audits.map((audit) => audit.action)).toEqual(['domain.removed']);
        expect(events.map((event) => event.type)).toEqual(['domain.removed']);
      });

      it('pending → failed / provider-refused', async () => {
        const domain = await added();
        publishOwnership(domain);
        publishRouting(domain);
        edgeFake.refuseNext(422, 'refused');
        const append = vi
          .spyOn(outbox, 'append')
          .mockRejectedValueOnce(new Error('forced after the state write'));

        await expect(checker.checkOne(orgId, domain.id)).rejects.toThrow(
          'forced after the state write',
        );

        expect(await row(domain.id)).toMatchObject({ failureReason: null, state: 'pending' });
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });

        append.mockRestore();
        edgeFake.refuseNext(422, 'refused');
        await whenDue(domain.id);
        await checker.checkOne(orgId, domain.id);

        const { audits, events } = await trail(domain.id);
        expect(audits.filter((audit) => audit.action === 'domain.failed')).toHaveLength(1);
        expect(events.map((event) => event.type)).toEqual(['domain.failed', 'mail.domain']);
      });

      /** A row in `state`, registered at the fake edge with routing broken, due now. */
      async function liveBroken(
        values: Partial<typeof schema.domains.$inferInsert>,
      ): Promise<Domain> {
        const domain = await added();
        const edgeId = edgeFake.seed(domain.hostname, { ssl: 'active', status: 'moved' });
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({
              activatedAt: clock.now(),
              certificateActiveAt: clock.now(),
              edgeId,
              nextCheckAt: clock.now(),
              ownershipVerifiedAt: clock.now(),
              state: 'active',
              ...values,
            })
            .where(eq(schema.domains.id, domain.id)),
        );
        return row(domain.id);
      }

      /**
       * Forces the settle to throw after the state write, on the `nth` outbox append, and proves
       * the row, its audit rows and its events are as before; then retries and returns the trail.
       */
      async function forcedThenRetried(domain: Domain, nth = 1) {
        const before = await row(domain.id);
        const original = outbox.append.bind(outbox);
        let calls = 0;
        const append = vi.spyOn(outbox, 'append').mockImplementation((...args) => {
          calls += 1;
          return calls === nth
            ? Promise.reject(new Error('forced after the state write'))
            : original(...args);
        });

        await expect(checker.checkOne(orgId, domain.id)).rejects.toThrow(
          'forced after the state write',
        );

        // As the claim left it: only its lease (`next_check_at`, `claimed_at`) moved.
        const after = await row(domain.id);
        expect({ ...after, claimedAt: null, nextCheckAt: null, updatedAt: null }).toEqual({
          ...before,
          claimedAt: null,
          nextCheckAt: null,
          updatedAt: null,
        });
        expect(await trail(domain.id)).toEqual({ audits: [], events: [] });

        append.mockRestore();
        await whenDue(domain.id);
        await checker.checkOne(orgId, domain.id);
        return trail(domain.id);
      }

      it('active → drifted, with its drifted mail', async () => {
        const domain = await liveBroken({ failureCount: 2 });

        // The drifted mail is the second append: the event and the mail roll back together.
        const { audits, events } = await forcedThenRetried(domain, 2);

        expect(await row(domain.id)).toMatchObject({ failureCount: 3, state: 'drifted' });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.drifted']);
        expect(events.map((event) => event.type).sort()).toEqual(['domain.drifted', 'mail.domain']);
      });

      it('drifted → active', async () => {
        const domain = await liveBroken({
          driftedAt: clock.now(),
          failureCount: 3,
          state: 'drifted',
        });
        publishRouting(domain);
        edgeFake.scriptStatus(domain.hostname, [{ status: 'active' }]);

        const { audits, events } = await forcedThenRetried(domain);

        expect(await row(domain.id)).toMatchObject({ driftedAt: null, state: 'active' });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.recovered']);
        expect(events.map((event) => event.type)).toEqual(['domain.recovered']);
      });

      it('drifted → drifted with the release warning', async () => {
        const domain = await liveBroken({
          driftedAt: new Date(clock.now().getTime() - 23 * DAY),
          failureCount: 3,
          state: 'drifted',
        });

        const { audits, events } = await forcedThenRetried(domain);

        expect(await row(domain.id)).toMatchObject({ releaseWarnedAt: clock.now() });
        expect(audits).toEqual([]);
        expect(events.map((event) => event.type)).toEqual(['mail.domain']);
      });

      it('drifted → removing (the 30-day release)', async () => {
        const domain = await liveBroken({
          driftedAt: new Date(clock.now().getTime() - 30 * DAY),
          failureCount: 3,
          releaseWarnedAt: new Date(clock.now().getTime() - 7 * DAY),
          state: 'drifted',
        });

        const { audits, events } = await forcedThenRetried(domain);

        expect(await row(domain.id)).toMatchObject({ state: 'removing' });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.removal-requested']);
        expect(events.map((event) => event.type)).toEqual(['domain.removing']);
      });

      it('removing → removed after a drift release, with its released mail', async () => {
        const domain = await liveBroken({
          nextCheckAt: clock.now(),
          releaseWarnedAt: clock.now(),
          removalRequestedAt: clock.now(),
          state: 'removing',
        });

        const { audits, events } = await forcedThenRetried(domain, 2);

        expect(await row(domain.id)).toMatchObject({ edgeId: null, state: 'removed' });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.removed']);
        expect(events.map((event) => event.type).sort()).toEqual(['domain.removed', 'mail.domain']);
      });
      it('pending → failed / verification-timeout at the window end, with its failed mail', async () => {
        const domain = await atWindowEnd();

        const { audits, events } = await forcedThenRetried(domain, 2);

        expect(await row(domain.id)).toMatchObject({
          failureReason: 'verification-timeout',
          state: 'failed',
        });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.failed']);
        expect(events.map((event) => event.type).sort()).toEqual(['domain.failed', 'mail.domain']);
      });

      it('pending → removing at the window end, registered', async () => {
        const hostname = `app-${randomUUID().slice(0, 8)}.example.test`;
        const domain = await atWindowEnd({
          edgeId: edgeFake.seed(hostname, { ssl: 'pending', status: 'active' }),
          hostname,
          ownershipVerifiedAt: clock.now(),
        });
        publishRouting(domain);

        const { audits, events } = await forcedThenRetried(domain);

        expect(await row(domain.id)).toMatchObject({
          failureReason: 'certificate-failed',
          state: 'removing',
        });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.removal-requested']);
        expect(events.map((event) => event.type)).toEqual(['domain.removing']);
      });

      it('removing → failed after deregistration, with its failed mail', async () => {
        const domain = await liveBroken({
          activatedAt: null,
          certificateActiveAt: null,
          failureReason: 'certificate-failed',
          nextCheckAt: clock.now(),
          removalRequestedAt: clock.now(),
          state: 'removing',
        });

        const { audits, events } = await forcedThenRetried(domain, 2);

        expect(await row(domain.id)).toMatchObject({
          edgeId: null,
          failureReason: 'certificate-failed',
          state: 'failed',
        });
        expect(audits.map((audit) => audit.action)).toEqual(['domain.failed']);
        expect(events.map((event) => event.type).sort()).toEqual(['domain.failed', 'mail.domain']);
      });
    });
  });
});

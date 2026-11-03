import type { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { FakeDns } from '../../../../test/support/fake-dns';
import { AppModule } from '../../../app.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE, BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import type { Envelope } from '../../outbox/envelope';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { type CustomHostnamePort, EdgeNotConfigured } from './custom-hostname.port';
import {
  CHECK_CONCURRENCY,
  DOMAIN_CHECK_QUEUE,
  DOMAIN_SWEEP_QUEUE,
  SWEEP_BATCH,
} from './domain.constants';
import { type DueDomain, DomainRepository } from './domain.repository';
import { DomainCheckConsumer } from './domain-check.consumer';
import { DomainCheckSweepConsumer } from './domain-check-sweep.consumer';
import { type CheckRun, DomainChecker } from './domain-checker';
import { DomainNotices } from './domain-notices';
import { ownershipToken } from './ownership-token';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

function due(job: Envelope<'maintenance.due'>['payload']['job']): Envelope<'maintenance.due'> {
  const periodStart = new Date().toISOString();

  return {
    aggregate: 'maintenance',
    aggregateId: `${job}:${periodStart}`,
    eventId: randomUUID(),
    occurredAt: periodStart,
    orgId: null,
    payload: { job, periodStart },
    traceId: null,
    type: 'maintenance.due',
  };
}

const settled: CheckRun = { kind: 'not-due' };

/** A sweep over stand-ins: `probeDue` answers `rows`, and `checkOne` is the given function. */
function sweepOver(
  rows: DueDomain[],
  checkOne: (orgId: string, domainId: string) => Promise<CheckRun>,
) {
  const clock = new FakeClock('2026-09-23T12:00:00.000Z');
  const repository = new DomainRepository();
  const probeDue = vi.spyOn(repository, 'probeDue').mockResolvedValue(rows);
  const check = vi.fn(checkOne);
  const checker = { checkOne: check } as unknown as DomainChecker;
  const bypass = {} as ForgeDatabase;
  const consumer = new DomainCheckSweepConsumer(
    bypass,
    repository,
    checker,
    clock,
    {} as TenantTransactionRunner,
    {} as AuditService,
    {} as OutboxWriter,
  );
  return { bypass, check, clock, consumer, probeDue };
}

function dueRows(count: number): DueDomain[] {
  return Array.from({ length: count }, () => ({
    id: randomUUID(),
    orgDeleted: false,
    orgId: randomUUID(),
  }));
}

/**
 * Spec 028 T043 (research R7): the `domain.check` arm of `maintenance.due`. One bypass probe of
 * at most `SWEEP_BATCH` due rows, then `checkOne` for each with at most `CHECK_CONCURRENCY` in
 * flight; one failing domain is logged and skipped.
 */
describe('DomainCheckSweepConsumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('declares its own queue on the events profile, the DeploySweepConsumer shape', () => {
    const { consumer } = sweepOver([], () => Promise.resolve(settled));

    expect(consumer).toMatchObject({
      name: 'domain-check-sweep',
      profile: 'events',
      queue: DOMAIN_SWEEP_QUEUE,
      types: ['maintenance.due'],
    });
    expect(DOMAIN_SWEEP_QUEUE).toBe('domain.sweep');
    const event = due('domain.check');
    expect(consumer.jobId(event)).toBe(
      `domain.check.${String(Date.parse(event.payload.periodStart))}.domains`,
    );
  });

  it('takes domain.check and leaves every other maintenance job to its owner', async () => {
    const { consumer, probeDue } = sweepOver(dueRows(1), () => Promise.resolve(settled));

    await expect(consumer.handle(due('domain.check'))).resolves.toBe(true);
    for (const job of ['deploy.sweep', 'connector.verify', 'sandbox.sweep'] as const) {
      const event = due(job);
      const owned = await consumer.handle(event);
      expect(owned).toBe(false);
      await consumer.effect(event, owned);
    }
    expect(probeDue).not.toHaveBeenCalled();
  });

  it('probes at most SWEEP_BATCH rows due by the injected clock, and checks each', async () => {
    const rows = dueRows(3);
    const { bypass, check, clock, consumer, probeDue } = sweepOver(rows, () =>
      Promise.resolve(settled),
    );

    const event = due('domain.check');
    await consumer.effect(event, await consumer.handle(event));

    expect(SWEEP_BATCH).toBe(200);
    expect(probeDue).toHaveBeenCalledExactlyOnceWith(bypass, clock.now(), SWEEP_BATCH);
    expect(check.mock.calls).toEqual(rows.map((row) => [row.orgId, row.id]));
  });

  it(`runs at most ${String(CHECK_CONCURRENCY)} checks at once, and every one`, async () => {
    const rows = dueRows(3 * CHECK_CONCURRENCY + 1);
    let inFlight = 0;
    let peak = 0;
    const { consumer } = sweepOver(rows, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return settled;
    });

    await expect(consumer.sweep()).resolves.toEqual({
      checked: rows.length,
      due: rows.length,
      failed: 0,
    });
    expect(CHECK_CONCURRENCY).toBe(8);
    expect(peak).toBe(CHECK_CONCURRENCY);
  });

  it('logs and skips a failing domain, and checks the rest', async () => {
    const rows = dueRows(5);
    const broken = rows[1]!.id;
    const { check, consumer } = sweepOver(rows, (_orgId, domainId) =>
      domainId === broken
        ? Promise.reject(new Error('evaluateCheck: not implemented for active'))
        : Promise.resolve(settled),
    );

    await expect(consumer.sweep()).resolves.toEqual({ checked: 4, due: 5, failed: 1 });
    expect(check).toHaveBeenCalledTimes(5);
  });

  describe('DomainCheckConsumer', () => {
    it('declares domain.check for domain.check-requested and domain.removing, and checks that one domain', async () => {
      const checkOne = vi.fn(() => Promise.resolve(settled));
      const consumer = new DomainCheckConsumer({ checkOne } as unknown as DomainChecker);
      const ids = { domainId: randomUUID(), orgId: randomUUID(), projectId: randomUUID() };

      expect(consumer).toMatchObject({
        name: 'domain-check',
        profile: 'events',
        queue: DOMAIN_CHECK_QUEUE,
        types: ['domain.check-requested', 'domain.removing'],
      });
      expect(DOMAIN_CHECK_QUEUE).toBe('domain.check');

      const event: Envelope<'domain.check-requested'> = {
        aggregate: 'domain',
        aggregateId: ids.domainId,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId: ids.orgId,
        payload: ids,
        traceId: null,
        type: 'domain.check-requested',
      };
      await consumer.effect(event);
      expect(checkOne).toHaveBeenCalledExactlyOnceWith(ids.orgId, ids.domainId);

      // A removal is deregistered at once rather than at the next tick (R10, T053).
      checkOne.mockClear();
      const removing: Envelope<'domain.removing'> = {
        ...event,
        eventId: randomUUID(),
        payload: { ...ids, reason: null },
        type: 'domain.removing',
      };
      await consumer.effect(removing);
      expect(checkOne).toHaveBeenCalledExactlyOnceWith(ids.orgId, ids.domainId);
    });
  });

  /**
   * Against the database with the real checker: an `active` row, whose evaluation US3 (T061) has
   * not written yet, throws; the sweep logs it and still settles the `pending` row beside it.
   */
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let orgId: string;
    let userId: string;
    const clock = new FakeClock(new Date());
    const otherOrgs: string[] = [];

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `028w-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Domain sweep fixture',
          slug: `028w-${randomUUID().slice(0, 8)}`,
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      for (const other of otherOrgs) {
        await database.delete(schema.orgs).where(eq(schema.orgs.id, other));
      }
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('settles the pending row although the active row beside it throws', async () => {
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const projectId = (
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
      const repository = new DomainRepository();
      const add = () =>
        inTenant((tx) =>
          repository.insert(tx, {
            addedBy: userId,
            hostname: `app-${randomUUID().slice(0, 8)}.example.test`,
            now: clock.now(),
            orgId,
            ownershipToken: ownershipToken(),
            projectId,
          }),
        );
      const active = await add();
      const pending = await add();
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({
            activatedAt: clock.now(),
            certificateActiveAt: clock.now(),
            edgeId: 'edge-active',
            ownershipVerifiedAt: clock.now(),
            state: 'active',
          })
          .where(eq(schema.domains.id, active.id)),
      );

      // The probe is fleet-wide; only this suite's rows reach the real checker.
      const probeDue = repository.probeDue.bind(repository);
      vi.spyOn(repository, 'probeDue').mockImplementation(async (...args) =>
        (await probeDue(...args)).filter((row) => row.orgId === orgId),
      );
      const edge: CustomHostnamePort = {
        deregister: () => Promise.reject(new EdgeNotConfigured()),
        findByHostname: () => Promise.reject(new EdgeNotConfigured()),
        register: () => Promise.reject(new EdgeNotConfigured()),
        status: () => Promise.reject(new EdgeNotConfigured()),
      };
      // The active row's check throws: its resolver fails in a way no answer maps (a bug, not
      // an outage), which the sweep must contain.
      const dns = new FakeDns();
      const resolveCnameChain = dns.resolveCnameChain.bind(dns);
      vi.spyOn(dns, 'resolveCnameChain').mockImplementation((name) =>
        name === active.hostname
          ? Promise.reject(new Error('resolver bug'))
          : resolveCnameChain(name),
      );
      const settings: Partial<Environment> = {
        CUSTOM_HOSTNAME_CA: 'lets_encrypt',
        CUSTOM_HOSTNAME_TARGET: 'edge.forge-domains.test',
      };
      const checker = new DomainChecker(
        transactions,
        repository,
        moduleRef.get(AuditService, { strict: false }),
        moduleRef.get(OutboxWriter, { strict: false }),
        clock,
        dns,
        edge,
        {
          get: (key: keyof Environment) => settings[key],
        } as unknown as ConfigService<Environment, true>,
        moduleRef.get(DomainNotices, { strict: false }),
      );
      const consumer = new DomainCheckSweepConsumer(
        moduleRef.get<ForgeDatabase>(BYPASS_DATABASE),
        repository,
        checker,
        clock,
        transactions,
        moduleRef.get(AuditService, { strict: false }),
        moduleRef.get(OutboxWriter, { strict: false }),
      );

      await expect(consumer.sweep()).resolves.toEqual({ checked: 1, due: 2, failed: 1 });

      const rows = await inTenant((tx) =>
        tx
          .select({
            id: schema.domains.id,
            lastCheck: schema.domains.lastCheck,
            state: schema.domains.state,
          })
          .from(schema.domains)
          .where(eq(schema.domains.projectId, projectId)),
      );
      expect(rows.find((row) => row.id === pending.id)).toMatchObject({
        lastCheck: { conclusive: true },
        state: 'pending',
      });
      // Untouched but for its claim lease: tried again when the lease runs out.
      expect(rows.find((row) => row.id === active.id)).toMatchObject({
        lastCheck: null,
        state: 'active',
      });
    });

    /**
     * Spec 028 T074 (FR-026, research R10): an organisation whose `deleted_at` is set has its live
     * domains returned by the probe whatever their `next_check_at`, and the sweep sends them to
     * `removing` with no author. Its `removing` rows keep their own schedule, and a live org's
     * domains that are not due stay out of the probe.
     */
    it('sends the live domains of a deleted organisation to removing, whenever they are due', async () => {
      async function orgWithProject(name: string): Promise<{ org: string; project: string }> {
        const org = (
          await moduleRef.get(OrgService).create(userId, {
            name,
            slug: `028d-${randomUUID().slice(0, 8)}`,
          })
        ).id;
        otherOrgs.push(org);
        const [workspace] = await transactions.runInTenantTransaction(org, (tx) =>
          tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
        );
        const project = (
          await transactions.runInTenantScope({ orgId: org, userId }, () =>
            moduleRef.get(ProjectService).create({
              actorId: userId,
              name: 'Domains',
              orgId: org,
              ownerId: userId,
              workspaceId: workspace!.id,
            }),
          )
        ).id;
        return { org, project };
      }

      const repository = new DomainRepository();
      const later = new Date(clock.now().getTime() + 86_400_000);
      /** A domain in `state`, not due for a day, with the columns its CHECKs ask for (0036). */
      async function domainIn(
        where: { org: string; project: string },
        state: 'pending' | 'active' | 'drifted' | 'removing' | 'failed',
      ): Promise<string> {
        const at = clock.now();
        return transactions.runInTenantTransaction(where.org, async (tx) => {
          const inserted = await repository.insert(tx, {
            addedBy: userId,
            hostname: `d-${randomUUID().slice(0, 8)}.example.test`,
            now: at,
            orgId: where.org,
            ownershipToken: ownershipToken(),
            projectId: where.project,
          });
          const registered = {
            activatedAt: at,
            certificateActiveAt: at,
            edgeId: `edge-${inserted.id}`,
            ownershipVerifiedAt: at,
          };
          const columns = {
            active: registered,
            drifted: { ...registered, driftedAt: at },
            failed: { failureReason: 'verification-timeout' as const },
            pending: {},
            removing: { ...registered, removalRequestedAt: at },
          }[state];
          await tx
            .update(schema.domains)
            .set({ ...columns, nextCheckAt: later, state })
            .where(eq(schema.domains.id, inserted.id));
          return inserted.id;
        });
      }

      const deleted = await orgWithProject('Deleted domains fixture');
      const kept = await orgWithProject('Kept domains fixture');
      const live = {
        active: await domainIn(deleted, 'active'),
        drifted: await domainIn(deleted, 'drifted'),
        pending: await domainIn(deleted, 'pending'),
      };
      const already = await domainIn(deleted, 'removing');
      const failed = await domainIn(deleted, 'failed');
      const keptActive = await domainIn(kept, 'active');
      await transactions.runInTenantTransaction(deleted.org, (tx) =>
        tx
          .update(schema.orgs)
          .set({ deletedAt: clock.now() })
          .where(eq(schema.orgs.id, deleted.org)),
      );

      const bypass = moduleRef.get<ForgeDatabase>(BYPASS_DATABASE);
      const ours = (rows: DueDomain[]) =>
        rows.filter((row) => row.orgId === deleted.org || row.orgId === kept.org);

      // The probe: a deleted org's live, not-yet-removing rows, whatever their next_check_at.
      const probed = ours(await repository.probeDue(bypass, clock.now(), SWEEP_BATCH));
      expect(probed).toHaveLength(3);
      expect(probed).toEqual(
        expect.arrayContaining(
          Object.values(live).map((id) => ({ id, orgDeleted: true, orgId: deleted.org })),
        ),
      );

      const probeDue = repository.probeDue.bind(repository);
      vi.spyOn(repository, 'probeDue').mockImplementation(async (...args) =>
        ours(await probeDue(...args)),
      );
      const checkOne = vi.fn(() => Promise.resolve(settled));
      const consumer = new DomainCheckSweepConsumer(
        bypass,
        repository,
        { checkOne } as unknown as DomainChecker,
        clock,
        transactions,
        moduleRef.get(AuditService, { strict: false }),
        moduleRef.get(OutboxWriter, { strict: false }),
      );

      clock.advance(1_000);
      await expect(consumer.sweep()).resolves.toEqual({ checked: 3, due: 3, failed: 0 });
      // Sent to removal, not checked: deregistration is the check routine's, on `domain.removing`.
      expect(checkOne).not.toHaveBeenCalled();

      const all = [...Object.values(live), already, failed, keptActive];
      const rows = await Promise.all(
        [deleted.org, kept.org].map((org) =>
          transactions.runInTenantTransaction(org, (tx) =>
            tx
              .select({
                id: schema.domains.id,
                hostname: schema.domains.hostname,
                nextCheckAt: schema.domains.nextCheckAt,
                projectId: schema.domains.projectId,
                removalRequestedAt: schema.domains.removalRequestedAt,
                state: schema.domains.state,
              })
              .from(schema.domains)
              .where(inArray(schema.domains.id, all)),
          ),
        ),
      ).then((found) => new Map(found.flat().map((row) => [row.id, row])));
      for (const id of Object.values(live)) {
        expect(rows.get(id)).toMatchObject({
          nextCheckAt: clock.now(),
          removalRequestedAt: clock.now(),
          state: 'removing',
        });
      }
      expect(rows.get(already)).toMatchObject({ nextCheckAt: later, state: 'removing' });
      expect(rows.get(failed)).toMatchObject({ state: 'failed' });
      expect(rows.get(keptActive)).toMatchObject({ nextCheckAt: later, state: 'active' });

      const audits = await transactions.runInTenantTransaction(deleted.org, (tx) =>
        tx
          .select({
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            metadata: schema.auditLog.metadata,
            target: schema.auditLog.target,
          })
          .from(schema.auditLog)
          .where(
            and(
              inArray(schema.auditLog.target, all),
              eq(schema.auditLog.action, 'domain.removal-requested'),
            ),
          ),
      );
      expect(audits).toHaveLength(3);
      expect(audits).toEqual(
        expect.arrayContaining(
          Object.values(live).map((id) => ({
            action: 'domain.removal-requested',
            actorId: null,
            metadata: { hostname: rows.get(id)!.hostname, projectId: deleted.project },
            target: id,
          })),
        ),
      );
      const events = await database
        .select({ payload: schema.outbox.payload, type: schema.outbox.type })
        .from(schema.outbox)
        .where(inArray(schema.outbox.aggregateId, all));
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining(
          Object.values(live).map((domainId) => ({
            payload: { domainId, orgId: deleted.org, projectId: deleted.project, reason: null },
            type: 'domain.removing',
          })),
        ),
      );

      // Once removing, the rows are due by their own schedule and go to the check routine.
      await expect(consumer.sweep()).resolves.toEqual({ checked: 3, due: 3, failed: 0 });
      expect(checkOne).toHaveBeenCalledTimes(3);
      expect(
        await transactions.runInTenantTransaction(deleted.org, (tx) =>
          tx
            .select({ id: schema.auditLog.id })
            .from(schema.auditLog)
            .where(inArray(schema.auditLog.target, all)),
        ),
      ).toHaveLength(3);
    });
  });
});

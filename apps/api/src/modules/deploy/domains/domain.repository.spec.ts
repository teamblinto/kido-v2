import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import { APP_DATABASE, BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { CHECK_NOW_MIN_INTERVAL_MS, CLAIM_LEASE_MS, WINDOW_MS } from './domain.constants';
import { HostnameHeld } from './domain.errors';
import {
  DOMAIN_CHECK_MAX_BYTES,
  type DomainCheck,
  DomainRepository,
  decodeDomainCheck,
  encodeDomainCheck,
} from './domain.repository';
import { ownershipToken } from './ownership-token';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const CHECK: DomainCheck = {
  at: '2026-09-23T12:00:00.000Z',
  caa: { verdict: 'permitted' },
  certificateRecords: [],
  conclusive: true,
  edge: null,
  edgeMessage: null,
  records: [
    { purpose: 'ownership', status: 'missing' },
    { purpose: 'routing', status: 'unchecked' },
  ],
};

/** Spec 028 T025: `last_check` is parsed and size-checked in both directions, with no database. */
describe('DomainRepository last_check', () => {
  it('round-trips a DomainCheck through encode and decode', () => {
    expect(decodeDomainCheck(encodeDomainCheck(CHECK))).toEqual(CHECK);
    expect(decodeDomainCheck(null)).toBeNull();
  });

  it('refuses a malformed check on write and on read', () => {
    const extraKey = { ...CHECK, secret: 'x' } as unknown as DomainCheck;
    expect(() => encodeDomainCheck(extraKey)).toThrow();
    expect(() => decodeDomainCheck({ ...CHECK, caa: { verdict: 'blocked' } })).toThrow();
  });

  it('refuses a check over 4 KiB on write and on read', () => {
    const big = { ...CHECK, edgeMessage: 'x'.repeat(DOMAIN_CHECK_MAX_BYTES) };
    expect(() => encodeDomainCheck(big)).toThrow(/4096 bytes/);
    expect(() => decodeDomainCheck(big)).toThrow(/4096 bytes/);
  });
});

/** Spec 028 T025 against real Postgres: insert, the live list, the org lock and the held hostname. */
describe('DomainRepository', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    const domains = new DomainRepository();
    let orgId: string;
    let userId: string;
    const now = new Date('2026-09-23T12:00:00.000Z');

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function newProject(): Promise<string> {
      const [workspace] = await inTenant((tx) =>
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

      return project.id;
    }

    function hostname(): string {
      return `app-${randomUUID().slice(0, 8)}.example.test`;
    }

    function insert(tx: TenantTransaction, projectId: string, name = hostname(), at = now) {
      return domains.insert(tx, {
        addedBy: userId,
        hostname: name,
        now: at,
        orgId,
        ownershipToken: ownershipToken(),
        projectId,
      });
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `028d-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
      orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Domain repository fixture',
          slug: `028d-${randomUUID().slice(0, 8)}`,
        })
      ).id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      if (userId !== undefined)
        await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('inserts a pending domain whose window and first check start now', async () => {
      const projectId = await newProject();
      const name = hostname();

      const row = await inTenant((tx) => insert(tx, projectId, name));

      expect(row).toMatchObject({
        addedBy: userId,
        edgeId: null,
        failureCount: 0,
        failureReason: null,
        hostname: name,
        lastCheck: null,
        nextCheckAt: now,
        orgId,
        projectId,
        state: 'pending',
        windowStartedAt: now,
      });
      expect(await inTenant((tx) => domains.findForProject(tx, orgId, projectId, row.id))).toEqual(
        row,
      );
      expect(
        await inTenant((tx) => domains.findForProject(tx, orgId, randomUUID(), row.id)),
      ).toBeUndefined();
    });

    it('lists newest first and leaves removed rows out of the list and the find', async () => {
      const projectId = await newProject();
      const older = await inTenant((tx) => insert(tx, projectId));
      const newer = await inTenant((tx) => insert(tx, projectId));
      const removed = await inTenant((tx) => insert(tx, projectId));
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ state: 'removed' })
          .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, removed.id))),
      );

      const listed = await inTenant((tx) => domains.listForProject(tx, orgId, projectId));

      expect(listed.map((row) => row.id)).toEqual([newer.id, older.id]);
      expect(
        await inTenant((tx) => domains.findForProject(tx, orgId, projectId, removed.id)),
      ).toBeUndefined();
    });

    it('parses last_check on read', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId));
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ lastCheck: encodeDomainCheck(CHECK) })
          .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, row.id))),
      );

      const [listed] = await inTenant((tx) => domains.listForProject(tx, orgId, projectId));
      expect(listed?.lastCheck).toEqual(CHECK);
    });

    it('counts live rows per project and per org, not failed or removed', async () => {
      const projectId = await newProject();
      const before = await inTenant((tx) => domains.countLive(tx, orgId, projectId));
      expect(before.project).toBe(0);

      await inTenant((tx) => insert(tx, projectId));
      const ended = await inTenant((tx) => insert(tx, projectId));
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ failureReason: 'ownership-not-found', state: 'failed' })
          .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, ended.id))),
      );

      expect(await inTenant((tx) => domains.countLive(tx, orgId, projectId))).toEqual({
        org: before.org + 1,
        project: 1,
      });
    });

    /**
     * FR-004 (research R9 § Limits): the second count waits on the org lock until the first
     * transaction commits, so it sees the row the first one added instead of the same count.
     */
    it('serialises two concurrent counts in one org under the advisory lock', async () => {
      const projectId = await newProject();
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstCounted!: () => void;
      const firstHoldsLock = new Promise<void>((resolve) => (firstCounted = resolve));

      const first = inTenant(async (tx) => {
        const counted = await domains.countLive(tx, orgId, projectId);
        firstCounted();
        await firstMayCommit;
        await insert(tx, projectId);
        return counted;
      });
      await firstHoldsLock;

      let secondDone = false;
      const second = inTenant((tx) => domains.countLive(tx, orgId, projectId)).finally(() => {
        secondDone = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondDone).toBe(false);

      releaseFirst();
      const [a, b] = await Promise.all([first, second]);

      expect(a.project).toBe(0);
      expect(b.project).toBe(1);
      expect(b.org).toBe(a.org + 1);
    });

    it('surfaces a live hostname held elsewhere as HostnameHeld, and leaves the transaction usable', async () => {
      const projectId = await newProject();
      const otherProjectId = await newProject();
      const name = hostname();
      await inTenant((tx) => insert(tx, projectId, name));

      await inTenant(async (tx) => {
        await expect(insert(tx, otherProjectId, name)).rejects.toBeInstanceOf(HostnameHeld);
        // The savepoint rolled back alone: the same transaction still reads.
        expect(await domains.listForProject(tx, orgId, otherProjectId)).toEqual([]);
      });
    });

    it('lets a hostname go once its row is failed', async () => {
      const projectId = await newProject();
      const name = hostname();
      const first = await inTenant((tx) => insert(tx, projectId, name));
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ failureReason: 'verification-timeout', state: 'failed' })
          .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, first.id))),
      );

      await expect(inTenant((tx) => insert(tx, projectId, name))).resolves.toMatchObject({
        hostname: name,
        state: 'pending',
      });
    });

    /** Spec 028 T069 (FR-013): retry takes a failed row back to pending, or reports why not. */
    it('retries only a failed row, clearing what the last attempt proved; a held hostname is HostnameHeld', async () => {
      const projectId = await newProject();
      const name = hostname();
      const row = await inTenant((tx) => insert(tx, projectId, name));
      const later = new Date(now.getTime() + WINDOW_MS);
      const token = ownershipToken();

      expect(
        await inTenant((tx) => domains.retry(tx, row.id, { now: later, ownershipToken: token })),
      ).toBeUndefined();

      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({
            failureCount: 3,
            failureReason: 'verification-timeout',
            lastCheck: CHECK,
            ownershipVerifiedAt: now,
            state: 'failed',
          })
          .where(eq(schema.domains.id, row.id)),
      );
      const other = await inTenant((tx) => insert(tx, projectId, name));

      await inTenant(async (tx) => {
        await expect(
          domains.retry(tx, row.id, { now: later, ownershipToken: token }),
        ).rejects.toBeInstanceOf(HostnameHeld);
        // The savepoint rolled back alone: the same transaction still reads.
        expect(await domains.findForProject(tx, orgId, projectId, row.id)).toMatchObject({
          state: 'failed',
        });
      });

      await inTenant((tx) => domains.releaseFailed(tx, row.id).then(() => undefined));
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ failureReason: 'verification-timeout', state: 'failed' })
          .where(eq(schema.domains.id, other.id)),
      );
      // A removed row is not failed: nothing to retry.
      expect(
        await inTenant((tx) => domains.retry(tx, row.id, { now: later, ownershipToken: token })),
      ).toBeUndefined();

      const retried = await inTenant((tx) =>
        domains.retry(tx, other.id, { now: later, ownershipToken: token }),
      );
      expect(retried).toMatchObject({
        failureCount: 0,
        failureReason: null,
        lastCheck: null,
        nextCheckAt: later,
        ownershipToken: token,
        ownershipVerifiedAt: null,
        state: 'pending',
        windowStartedAt: later,
      });
    });

    /** Spec 028 T069 (FR-012): check now moves a pending or drifted row once a minute at most. */
    it('requests a check of a pending row at most once per interval, and never of an ended one', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId, hostname(), new Date(0)));

      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, now))).toMatchObject({
        checkRequestedAt: now,
        nextCheckAt: now,
      });
      const soon = new Date(now.getTime() + CHECK_NOW_MIN_INTERVAL_MS - 1);
      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, soon))).toBeUndefined();
      const due = new Date(now.getTime() + CHECK_NOW_MIN_INTERVAL_MS);
      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, due))).toMatchObject({
        checkRequestedAt: due,
      });

      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ failureReason: 'verification-timeout', state: 'failed' })
          .where(eq(schema.domains.id, row.id)),
      );
      const much = new Date(now.getTime() + 10 * CHECK_NOW_MIN_INTERVAL_MS);
      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, much))).toBeUndefined();
    });

    /** Spec 028 T040 (research R7): the claim leases a due row once; a second claim misses. */
    it('claims a due row once, moving next_check_at a lease ahead, and never a row not yet due', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId));

      const early = new Date(now.getTime() - 1);
      expect(await inTenant((tx) => domains.claim(tx, row.id, early))).toBeUndefined();

      const claimed = await inTenant((tx) => domains.claim(tx, row.id, now));
      expect(claimed).toMatchObject({
        id: row.id,
        nextCheckAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        state: 'pending',
      });
      expect(await inTenant((tx) => domains.claim(tx, row.id, now))).toBeUndefined();
    });

    it('settles the state columns, last_check and next_check_at, guarded on the state read', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId));
      const next = new Date(now.getTime() + 60_000);

      // The row is `pending`: a settle that read `active` matches nothing and writes nothing.
      await expect(
        inTenant((tx) =>
          domains.settle(tx, row.id, {
            claim: row,
            changes: { failureCount: 1 },
            failureReason: null,
            from: 'active',
            lastCheck: CHECK,
            nextCheckAt: next,
            state: 'active',
          }),
        ),
      ).resolves.toBeUndefined();
      expect(await inTenant((tx) => domains.findForProject(tx, orgId, projectId, row.id))).toEqual(
        row,
      );

      const settled = await inTenant((tx) =>
        domains.settle(tx, row.id, {
          claim: row,
          changes: { edgeId: 'edge-1', ownershipVerifiedAt: now },
          failureReason: null,
          from: 'pending',
          lastCheck: CHECK,
          nextCheckAt: next,
          state: 'pending',
        }),
      );
      expect(settled).toMatchObject({
        edgeId: 'edge-1',
        lastCheck: CHECK,
        nextCheckAt: next,
        ownershipVerifiedAt: now,
        state: 'pending',
      });

      const failed = await inTenant((tx) =>
        domains.settle(tx, row.id, {
          claim: row,
          changes: { edgeId: null },
          failureReason: 'provider-refused',
          from: 'pending',
          lastCheck: { ...CHECK, edgeMessage: 'refused' },
          nextCheckAt: next,
          state: 'failed',
        }),
      );
      expect(failed).toMatchObject({
        edgeId: null,
        failureReason: 'provider-refused',
        lastCheck: { edgeMessage: 'refused' },
        state: 'failed',
      });
    });

    /**
     * The check-now race (research R7, FR-012): a check-now must not cut a claim lease short, or a
     * second check claims the row while the first is in flight. The settle sees the request and
     * makes the row due at once instead.
     */
    it('keeps a claim lease in force through a check-now, and the settle makes the row due at once', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId, hostname(), now));
      const lease = new Date(now.getTime() + CLAIM_LEASE_MS);

      const claimed = (await inTenant((tx) => domains.claim(tx, row.id, now)))!;
      expect(claimed).toMatchObject({ claimedAt: now, nextCheckAt: lease });

      const asked = new Date(now.getTime() + 1_000);
      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, asked))).toMatchObject({
        checkRequestedAt: asked,
        nextCheckAt: lease,
      });
      // Not claimable twice: the lease stands.
      expect(await inTenant((tx) => domains.claim(tx, row.id, asked))).toBeUndefined();

      const next = new Date(now.getTime() + 60 * 60_000);
      const settled = await inTenant((tx) =>
        domains.settle(tx, row.id, {
          changes: {},
          claim: claimed,
          failureReason: null,
          from: 'pending',
          lastCheck: CHECK,
          nextCheckAt: next,
          state: 'pending',
        }),
      );
      // The request came in flight: due at once (the claim's now), and the claim cleared.
      expect(settled).toMatchObject({ checkRequestedAt: asked, claimedAt: null, nextCheckAt: now });
      expect(await inTenant((tx) => domains.claim(tx, row.id, asked))).toMatchObject({
        checkRequestedAt: asked,
        claimedAt: asked,
      });
    });

    it('settles to the schedule when no check-now came in flight, and moves a row not claimed at once', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId, hostname(), now));
      const claimed = (await inTenant((tx) => domains.claim(tx, row.id, now)))!;
      const next = new Date(now.getTime() + 60_000);

      const settled = await inTenant((tx) =>
        domains.settle(tx, row.id, {
          changes: {},
          claim: claimed,
          failureReason: null,
          from: 'pending',
          lastCheck: CHECK,
          nextCheckAt: next,
          state: 'pending',
        }),
      );
      expect(settled).toMatchObject({ claimedAt: null, nextCheckAt: next });

      // No lease in force: a check-now makes the row due at once.
      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, now))).toMatchObject({
        nextCheckAt: now,
      });
    });

    it('lets a check-now through once a lease has run out, and refuses the stale settle', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId, hostname(), now));
      const stale = (await inTenant((tx) => domains.claim(tx, row.id, now)))!;

      const expired = new Date(now.getTime() + CLAIM_LEASE_MS);
      expect(await inTenant((tx) => domains.requestCheck(tx, row.id, expired))).toMatchObject({
        nextCheckAt: expired,
      });
      const taken = (await inTenant((tx) => domains.claim(tx, row.id, expired)))!;
      expect(taken.claimedAt).toEqual(expired);

      // The first check, back after its lease ran out, writes nothing over the second's claim.
      await expect(
        inTenant((tx) =>
          domains.settle(tx, row.id, {
            changes: { failureCount: 1 },
            claim: stale,
            failureReason: null,
            from: 'pending',
            lastCheck: CHECK,
            nextCheckAt: expired,
            state: 'pending',
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it('refuses to settle a malformed last_check', async () => {
      const projectId = await newProject();
      const row = await inTenant((tx) => insert(tx, projectId));

      await expect(
        inTenant((tx) =>
          domains.settle(tx, row.id, {
            claim: row,
            changes: {},
            failureReason: null,
            from: 'pending',
            lastCheck: { ...CHECK, edgeMessage: 'x'.repeat(DOMAIN_CHECK_MAX_BYTES) },
            nextCheckAt: now,
            state: 'pending',
          }),
        ),
      ).rejects.toThrow(/4096 bytes/);
    });

    /**
     * Research R7: every scheduling time is the injected clock's. The database's clock does not
     * move; the `FakeClock` does, 72 h, and the row becomes due and claimable. A query on SQL
     * `now()` would still see it 72 h away.
     */
    it('makes a row due by the injected clock alone: a FakeClock 72 h ahead finds it', async () => {
      const bypass = moduleRef.get<ForgeDatabase>(BYPASS_DATABASE);
      const clock = new FakeClock(new Date());
      const projectId = await newProject();
      const row = await inTenant((tx) =>
        insert(tx, projectId, hostname(), new Date(clock.now().getTime() + WINDOW_MS)),
      );
      const dueIds = async () =>
        (await domains.probeDue(bypass, clock.now(), 100_000)).map((hit) => hit.id);

      expect(await dueIds()).not.toContain(row.id);
      expect(await inTenant((tx) => domains.claim(tx, row.id, clock.now()))).toBeUndefined();

      clock.advance(WINDOW_MS);

      const hits = await domains.probeDue(bypass, clock.now(), 100_000);
      expect(hits).toContainEqual({ id: row.id, orgDeleted: false, orgId });
      expect(await inTenant((tx) => domains.claim(tx, row.id, clock.now()))).toMatchObject({
        id: row.id,
      });
      // Claimed: leased ahead, so the next probe at the same instant no longer lists it.
      expect(await dueIds()).not.toContain(row.id);
    });

    it('probes due rows oldest first within the limit, and only in the live states', async () => {
      const bypass = moduleRef.get<ForgeDatabase>(BYPASS_DATABASE);
      const projectId = await newProject();
      // Far in the past, so no other suite's due row sorts ahead of these three.
      const epoch = new Date('2000-01-01T00:00:00.000Z');
      const older = await inTenant((tx) => insert(tx, projectId, hostname(), epoch));
      const newer = await inTenant((tx) =>
        insert(tx, projectId, hostname(), new Date(epoch.getTime() + 1)),
      );
      const ended = await inTenant((tx) => insert(tx, projectId, hostname(), epoch));
      await inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ failureReason: 'verification-timeout', state: 'failed' })
          .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, ended.id))),
      );

      const hits = await domains.probeDue(bypass, new Date(epoch.getTime() + 1), 100_000);
      const ids = hits.map((hit) => hit.id);
      expect(ids).toContain(older.id);
      expect(ids).toContain(newer.id);
      expect(ids).not.toContain(ended.id);
      expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));

      const first = await domains.probeDue(bypass, new Date(epoch.getTime() + 1), 1);
      expect(first).toHaveLength(1);

      // Leave nothing due for the other suites' sweeps.
      for (const id of [older.id, newer.id]) {
        await inTenant((tx) =>
          tx
            .update(schema.domains)
            .set({ failureReason: 'verification-timeout', state: 'failed' })
            .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, id))),
        );
      }
    });
  });
});

import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { Envelope } from '../outbox/envelope';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { SANDBOX_OPS_QUEUE } from './sandbox.constants';
import { SandboxProjectConsumer } from './sandbox-project.consumer';

const postgres = inject('postgresReachable');

const START = '2026-09-16T10:00:00.000Z';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * Contract § 4 `project.archived`: the archived project's row goes `releasing` with a `release` op
 * in the same transaction (data-model, "any → releasing"); a project with no row is a no-op.
 * `handle` is called directly on a tenant transaction, as the base would call it.
 */
describe('SandboxProjectConsumer', () => {
  describe.skipIf(!postgres)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: SandboxProjectConsumer;
    let clock: FakeClock;
    let orgId: string;
    let projectId: string;
    let userId: string;
    let workspaceId: string;
    let suiteLock: { release: () => Promise<void> } | undefined;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function envelope(project = projectId): Envelope<'project.archived'> {
      return {
        aggregateId: project,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { actorId: userId, orgId, projectId: project, workspaceId },
        traceId: null,
        type: 'project.archived',
      } as Envelope<'project.archived'>;
    }

    async function opsFor(aggregateId: string) {
      const rows = await database
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'sandbox.op.requested'),
            eq(schema.outbox.aggregateId, aggregateId),
          ),
        );
      return rows.map((row) => row.payload);
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      clock = new FakeClock(START);
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(SandboxProjectConsumer, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `014p-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;
      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Archive fixture',
        slug: `014p-${randomUUID().slice(0, 8)}`,
      });
      orgId = org.id;
      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      workspaceId = workspace!.id;
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Archived',
          orgId,
          ownerId: userId,
          template: 'python',
          workspaceId,
        }),
      );
      projectId = project.id;
    }, LOCKED_BOOT_TIMEOUT_MS);

    beforeEach(async () => {
      await inTenant((tx) => tx.delete(schema.sandboxes).where(eq(schema.sandboxes.orgId, orgId)));
    });

    afterAll(async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(inArray(schema.users.id, [userId]));
      await moduleRef?.close();
      await suiteLock?.release();
    });

    it('rides the sandbox ops queue on the events profile with no effect', () => {
      expect(consumer.queue).toBe(SANDBOX_OPS_QUEUE);
      expect(consumer.profile).toBe('events');
      expect(consumer.types).toEqual(['project.archived', 'project.env.changed']);
      expect('effect' in consumer).toBe(false);
    });

    it("marks the project's row releasing and appends the release op in the same transaction", async () => {
      const [row] = await inTenant((tx) =>
        tx
          .insert(schema.sandboxes)
          .values({
            daytonaId: `proj-${randomUUID()}`,
            orgId,
            projectId,
            state: 'idle',
            workspaceRoot: '/home/daytona',
          })
          .returning({ id: schema.sandboxes.id }),
      );

      // The base hands a platform transaction; the consumer scopes it itself.
      await database.transaction((tx) => consumer.handle(envelope(), tx));

      expect(
        await inTenant((tx) =>
          tx.query.sandboxes.findFirst({ where: eq(schema.sandboxes.id, row!.id) }),
        ),
      ).toMatchObject({ transition: 'releasing', transitionSince: clock.now() });
      expect(await opsFor(row!.id)).toEqual([{ op: 'release', orgId, sandboxId: row!.id }]);
    });

    function envChanged(): Envelope<'project.env.changed'> {
      return {
        aggregateId: projectId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { orgId, projectId },
        traceId: null,
        type: 'project.env.changed',
      } as Envelope<'project.env.changed'>;
    }

    async function sandboxIn(state: 'active' | 'hibernated', transition: 'resuming' | null = null) {
      const [row] = await inTenant((tx) =>
        tx
          .insert(schema.sandboxes)
          .values({
            daytonaId: `proj-${randomUUID()}`,
            orgId,
            projectId,
            state,
            transition,
            hibernatedAt: state === 'hibernated' ? clock.now() : null,
            transitionSince: transition === null ? null : clock.now(),
            workspaceRoot: '/home/daytona',
          })
          .returning({ id: schema.sandboxes.id }),
      );
      return row!.id;
    }

    it('a changed env asks a running sandbox for an env op, its own job per change', async () => {
      const id = await sandboxIn('active');

      await database.transaction((tx) => consumer.handle(envChanged(), tx));

      expect(await opsFor(id)).toEqual([
        { op: 'env', orgId, sandboxId: id, since: clock.now().toISOString() },
      ]);
    });

    it('a changed env leaves a hibernated or transitioning sandbox to its next start', async () => {
      const asleep = await sandboxIn('hibernated');
      await database.transaction((tx) => consumer.handle(envChanged(), tx));
      expect(await opsFor(asleep)).toEqual([]);

      await inTenant((tx) => tx.delete(schema.sandboxes).where(eq(schema.sandboxes.orgId, orgId)));
      const waking = await sandboxIn('hibernated', 'resuming');
      await database.transaction((tx) => consumer.handle(envChanged(), tx));
      expect(await opsFor(waking)).toEqual([]);
    });

    it('does nothing for a project with no sandbox row', async () => {
      await database.transaction((tx) => consumer.handle(envelope(randomUUID()), tx));

      expect(await inTenant((tx) => tx.select().from(schema.sandboxes))).toEqual([]);
    });
  });
});

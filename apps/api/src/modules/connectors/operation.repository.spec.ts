import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import { DatabaseModule } from '../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { FakeClock } from '../../common/clock/fake-clock';
import { OutboxWriter } from '../outbox/outbox-writer';
import { OperationRepository } from './operation.repository';
import { OperationService } from './operation.service';
import { ResourceRepository } from './resource.repository';

const postgres = inject('postgresReachable');

if (!postgres) {
  console.warn('SKIPPING operation.repository.spec.ts: Postgres is not reachable');
}

/**
 * Spec 030 data-model §§ 4–5 against Postgres: the forward-only moves of an operation and a
 * resource, and the two partial uniques surfaced as `in-flight` without spoiling the transaction.
 */
describe('OperationRepository and ResourceRepository', () => {
  describe.skipIf(!postgres)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    const operations = new OperationRepository();
    const resources = new ResourceRepository();
    let orgId: string;
    let userId: string;
    let projectId: string;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    function bind(): Promise<string> {
      return inTenant(async (tx) => {
        const [row] = await tx
          .insert(schema.connectorBindings)
          .values({
            boundBy: userId,
            config: {},
            orgId,
            projectId: randomProject(),
            provider: 'neon',
            state: 'disconnected',
          })
          .returning({ id: schema.connectorBindings.id });

        return row!.id;
      });
    }

    let projects: string[] = [];
    const randomProject = () => projects.shift() ?? projectId;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          RunProfilesModule,
          DatabaseModule,
        ],
      }).compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `030r-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;

      const [org] = await database
        .insert(schema.orgs)
        .values({ name: 'Ops', slug: `030r-${randomUUID().slice(0, 8)}` })
        .returning({ id: schema.orgs.id });
      orgId = org!.id;

      projects = await inTenant(async (tx) => {
        const [workspace] = await tx
          .insert(schema.workspaces)
          .values({ name: 'w', orgId })
          .returning({ id: schema.workspaces.id });
        const rows = await tx
          .insert(schema.projects)
          .values(
            [1, 2, 3, 4].map((n) => ({
              name: `p${String(n)}`,
              orgId,
              previewLabel: `030r-${randomUUID()}`,
              workspaceId: workspace!.id,
            })),
          )
          .returning({ id: schema.projects.id });

        return rows.map((row) => row.id);
      });
      projectId = projects[0]!;
    }, 60_000);

    afterAll(async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    it('moves an operation forward only, and a second branch change in flight is in-flight', async () => {
      const bindingId = await bind();

      await inTenant(async (tx) => {
        const first = await operations.insertQueued(tx, {
          bindingId,
          kind: 'neon_branch_create',
          orgId,
          projectId,
          requestedBy: userId,
        });

        await expect(
          operations.insertQueued(tx, {
            bindingId,
            kind: 'neon_branch_reset',
            orgId,
            projectId,
            requestedBy: userId,
          }),
        ).rejects.toMatchObject({ extensions: { reason: 'in-flight' }, type: 'conflict' });

        // The savepoint kept the transaction usable: a release is not in the in-flight group.
        await expect(
          operations.insertQueued(tx, { bindingId, kind: 'resource_release', orgId, projectId }),
        ).resolves.toMatchObject({ state: 'queued' });

        const now = new Date();

        expect(await operations.markRunning(tx, orgId, first.id, now)).toBe(true);
        expect(await operations.markRunning(tx, orgId, first.id, now)).toBe(false);
        expect(
          await operations.markDone(tx, orgId, first.id, {
            finishedAt: now,
            reason: 'quota-exceeded',
            state: 'failed',
          }),
        ).toBe(true);
        expect(
          await operations.markDone(tx, orgId, first.id, { finishedAt: now, state: 'succeeded' }),
        ).toBe(false);
        expect(await operations.byId(tx, orgId, first.id)).toMatchObject({
          reason: 'quota-exceeded',
          state: 'failed',
        });

        const page = await operations.listForProject(tx, orgId, projectId, { limit: 1 });

        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).not.toBeNull();

        const latest = await operations.latestForBindings(tx, orgId, [bindingId]);

        expect(latest.get(bindingId)?.kind).toBe('resource_release');
      });
    });

    it('moves a resource by data-model § 4 only, and a second live one per binding is in-flight', async () => {
      const bindingId = await bind();

      await inTenant(async (tx) => {
        const branch = await resources.insert(tx, {
          bindingId,
          kind: 'neon_branch',
          name: 'forge-preview-x',
          orgId,
        });

        await expect(
          resources.insert(tx, { bindingId, kind: 'neon_branch', name: 'forge-preview-x', orgId }),
        ).rejects.toMatchObject({ extensions: { reason: 'in-flight' } });

        expect(await resources.transition(tx, orgId, branch.id, 'released')).toBe(false);
        expect(
          await resources.transition(tx, orgId, branch.id, 'live', { externalId: 'br-1' }),
        ).toBe(true);
        expect(await resources.transition(tx, orgId, branch.id, 'releasing')).toBe(true);
        // A Neon reset: the same row goes back to provisioning.
        expect(await resources.transition(tx, orgId, branch.id, 'provisioning')).toBe(true);
        expect(await resources.transition(tx, orgId, branch.id, 'live')).toBe(true);
        expect(await resources.listLive(tx, orgId)).toHaveLength(1);
        expect(await resources.transition(tx, orgId, branch.id, 'releasing')).toBe(true);
        expect(
          await resources.transition(tx, orgId, branch.id, 'released', { releasedAt: new Date() }),
        ).toBe(true);
        expect(await resources.transition(tx, orgId, branch.id, 'live')).toBe(false);
        expect(await resources.listForBinding(tx, orgId, bindingId, { liveOnly: true })).toEqual(
          [],
        );
        expect(await resources.byId(tx, orgId, branch.id)).toMatchObject({
          externalId: 'br-1',
          state: 'released',
        });
      });
    });

    it('OperationService.request writes the row and its connector.op.requested in the same transaction', async () => {
      const bindingId = await bind();
      const service = new OperationService(operations, new OutboxWriter(new FakeClock(new Date())));
      const rolledBack = new Error('roll back');

      await expect(
        inTenant(async (tx) => {
          const row = await service.request(tx, orgId, {
            bindingId,
            kind: 'neon_branch_create',
            projectId,
            requestedBy: userId,
          });
          const events = await tx
            .select({ payload: schema.outbox.payload, type: schema.outbox.type })
            .from(schema.outbox)
            .where(eq(schema.outbox.aggregateId, row.id));

          expect(events).toEqual([
            { payload: { operationId: row.id, orgId }, type: 'connector.op.requested' },
          ]);
          await expect(service.get(tx, orgId, projectId, row.id)).resolves.toMatchObject({
            kind: 'neon_branch_create',
            reason: null,
            state: 'queued',
          });
          await expect(service.get(tx, orgId, randomUUID(), row.id)).rejects.toMatchObject({
            type: 'not-found',
          });

          // Rolled back, so no event is left for another suite's relay to find.
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
    });
  });
});

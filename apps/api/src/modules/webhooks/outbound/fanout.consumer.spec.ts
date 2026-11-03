import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { holdOutboxSuiteLock } from '../../../../test/support/outbox-suite-lock';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { Envelope } from '../../outbox/envelope';
import type { EventType } from '../../outbox/events';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { DISPATCH_PER_ORG, WEBHOOK_FANOUT_QUEUE } from '../webhooks.constants';
import { EndpointRepository } from './endpoint.repository';
import { EndpointService } from './endpoint.service';
import { WebhookFanoutConsumer } from './fanout.consumer';
import { INTERNAL_SOURCES, serialiseEnvelope, toPublicEvent } from './public-event';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The suite lock may wait out a relaying suite before the module boots. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const SITE_DOMAIN = 'forge-site.localhost';

interface Fixture {
  readonly orgId: string;
  readonly projectId: string;
  readonly userId: string;
}

/**
 * Spec 029 T035 — `WebhookFanoutConsumer.handle` against Postgres: one send per matching endpoint
 * and one `webhook.attempt-due` per pending send, on the consumer's transaction; subscription,
 * scope, state, org and redelivery all decide who gets nothing.
 */
describe('WebhookFanoutConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let endpoints: EndpointService;
    let consumer: WebhookFanoutConsumer;
    const clock = new FakeClock(NOW);
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function tenant(): Promise<Fixture> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `029f-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      const userId = user!.id;
      created.users.push(userId);
      const orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Webhook fan-out fixture',
          slug: `029f-${randomUUID().slice(0, 8)}`,
        })
      ).id;
      created.orgs.push(orgId);
      return { orgId, projectId: await project(orgId, userId), userId };
    }

    async function project(orgId: string, userId: string): Promise<string> {
      const [workspace] = await inTenant(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const made = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: `Fan-out ${randomUUID().slice(0, 8)}`,
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      return made.id;
    }

    async function endpoint(
      who: Fixture,
      body: { eventTypes?: string[]; projectIds?: string[] } = {},
    ): Promise<string> {
      const response = await inTenant(who.orgId, (tx) =>
        endpoints.create(tx, who.orgId, who.userId, {
          description: '',
          eventTypes: (body.eventTypes ?? ['deploy.succeeded']) as never,
          projectIds: body.projectIds ?? [],
          url: 'https://hooks.example.com/in',
        }),
      );
      return response.endpoint.id;
    }

    function deploySucceeded(
      who: Fixture,
      projectId = who.projectId,
    ): Envelope<'deploy.succeeded'> {
      const deploymentId = randomUUID();
      return {
        aggregate: 'deployment',
        aggregateId: deploymentId,
        eventId: randomUUID(),
        occurredAt: '2026-09-23T11:59:00.000Z',
        orgId: who.orgId,
        payload: { deploymentId, orgId: who.orgId, projectId, siteLabel: 'a'.repeat(32) },
        traceId: null,
        type: 'deploy.succeeded',
      };
    }

    /** As the consumer base runs `handle`: one transaction on the app pool, no tenant set. */
    function handle(event: Envelope<EventType>): Promise<void> {
      return database.transaction((tx) => consumer.handle(event, tx));
    }

    function sendsFor(orgId: string, eventId: string) {
      return inTenant(orgId, (tx) =>
        tx
          .select()
          .from(schema.webhookSends)
          .where(eq(schema.webhookSends.eventId, eventId))
          .orderBy(schema.webhookSends.endpointId),
      );
    }

    function attemptDue(sendIds: readonly string[]) {
      if (sendIds.length === 0) return Promise.resolve([]);
      return database
        .select({ aggregateId: schema.outbox.aggregateId, payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'webhook.attempt-due'),
            inArray(schema.outbox.aggregateId, [...sendIds]),
          ),
        );
    }

    beforeAll(async () => {
      // This suite's sends are pending and their `webhook.attempt-due` rows unpublished: a suite
      // that relays (the webhooks e2e) would otherwise claim and settle them in its own consumer,
      // racing the assertions here and the org delete below, whose cascade then waits on an
      // endpoint that settle holds while settle waits on the org row (both foreign keys).
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await moduleRef.init();
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      endpoints = moduleRef.get(EndpointService);
      consumer = moduleRef.get(WebhookFanoutConsumer);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      if (created.orgs.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, created.orgs));
      }
      if (created.users.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created.users));
      }
      await moduleRef?.close();
      await suiteLock?.release();
    });

    it('drains webhook.fanout from every published internal source, 5 attempts, concurrency 8', () => {
      expect(consumer).toMatchObject({
        attempts: 5,
        concurrency: 8,
        profile: 'events',
        queue: WEBHOOK_FANOUT_QUEUE,
      });
      expect([...consumer.types].sort()).toEqual([...INTERNAL_SOURCES].sort());
    });

    it('an event matching two endpoints gives two sends and two webhook.attempt-due', async () => {
      const who = await tenant();
      const first = await endpoint(who);
      const second = await endpoint(who, { eventTypes: ['deploy.failed', 'deploy.succeeded'] });
      const event = deploySucceeded(who);

      await handle(event);

      const sends = await sendsFor(who.orgId, event.eventId);
      expect(sends.map((send) => send.endpointId).sort()).toEqual([first, second].sort());
      for (const send of sends) {
        expect(send).toMatchObject({
          attempts: 0,
          eventType: 'deploy.succeeded',
          nextAttemptAt: NOW,
          occurredAt: new Date(event.occurredAt),
          projectId: who.projectId,
          state: 'pending',
        });
      }
      const due = await attemptDue(sends.map((send) => send.id));
      expect(due.map((row) => row.payload)).toEqual(
        expect.arrayContaining(sends.map((send) => ({ orgId: who.orgId, sendId: send.id }))),
      );
      expect(due).toHaveLength(2);
    });

    it('writes on the handling transaction: a rollback leaves no send and no attempt-due', async () => {
      const who = await tenant();
      await endpoint(who);
      const event = deploySucceeded(who);

      await expect(
        database.transaction(async (tx) => {
          await consumer.handle(event, tx);
          throw new Error('after the fan-out');
        }),
      ).rejects.toThrow('after the fan-out');

      expect(await sendsFor(who.orgId, event.eventId)).toEqual([]);
    });

    it('stores exactly serialiseEnvelope(toPublicEvent(event)) as the body', async () => {
      const who = await tenant();
      await endpoint(who);
      const event = deploySucceeded(who);

      await handle(event);

      const [send] = await sendsFor(who.orgId, event.eventId);
      expect(send!.body).toBe(
        serialiseEnvelope(toPublicEvent(event, { siteDomain: SITE_DOMAIN })!),
      );
    });

    it('a type that is not subscribed gives no send', async () => {
      const who = await tenant();
      await endpoint(who, { eventTypes: ['deploy.failed'] });
      const event = deploySucceeded(who);

      await handle(event);

      expect(await sendsFor(who.orgId, event.eventId)).toEqual([]);
    });

    it('a project outside the scope gives no send, and an empty scope matches every project', async () => {
      const who = await tenant();
      const elsewhere = await project(who.orgId, who.userId);
      const scoped = await endpoint(who, { projectIds: [who.projectId] });
      const everywhere = await endpoint(who);
      const event = deploySucceeded(who, elsewhere);

      await handle(event);

      const sends = await sendsFor(who.orgId, event.eventId);
      expect(sends.map((send) => send.endpointId)).toEqual([everywhere]);
      expect(scoped).not.toBe(everywhere);

      const inScope = deploySucceeded(who);
      await handle(inScope);
      expect(
        (await sendsFor(who.orgId, inScope.eventId)).map((send) => send.endpointId).sort(),
      ).toEqual([everywhere, scoped].sort());
    });

    it('a member.joined (no project) reaches a subscribed endpoint whatever its scope', async () => {
      const who = await tenant();
      const scoped = await endpoint(who, {
        eventTypes: ['member.joined'],
        projectIds: [who.projectId],
      });
      const event: Envelope<'member.joined'> = {
        aggregate: 'membership',
        aggregateId: who.userId,
        eventId: randomUUID(),
        occurredAt: NOW.toISOString(),
        orgId: who.orgId,
        payload: { orgId: who.orgId, role: 'member', userId: who.userId },
        traceId: null,
        type: 'member.joined',
      };

      await handle(event);

      const sends = await sendsFor(who.orgId, event.eventId);
      expect(sends.map((send) => [send.endpointId, send.projectId])).toEqual([[scoped, null]]);
    });

    it.each(['disabled', 'paused'] as const)(
      'a %s endpoint gives not_sent and no attempt event',
      async (state) => {
        const who = await tenant();
        const id = await endpoint(who);
        await inTenant(who.orgId, (tx) =>
          tx
            .update(schema.webhookEndpoints)
            .set({ pausedAt: state === 'paused' ? NOW : null, state })
            .where(eq(schema.webhookEndpoints.id, id)),
        );
        const event = deploySucceeded(who);

        await handle(event);

        const sends = await sendsFor(who.orgId, event.eventId);
        expect(sends.map((send) => [send.state, send.nextAttemptAt])).toEqual([['not_sent', null]]);
        expect(await attemptDue(sends.map((send) => send.id))).toEqual([]);
      },
    );

    it('handling the same event twice gives one send per endpoint (SC-003)', async () => {
      const who = await tenant();
      await endpoint(who);
      await endpoint(who);
      const event = deploySucceeded(who);

      await handle(event);
      await handle(event);

      const sends = await sendsFor(who.orgId, event.eventId);
      expect(sends).toHaveLength(2);
      expect(await attemptDue(sends.map((send) => send.id))).toHaveLength(2);
    });

    it('past the org’s dispatch budget, pending sends get no attempt-due and wait for the chain or the sweep (SC-006)', async () => {
      const who = await tenant();
      const endpointIds: string[] = [];
      for (let index = 0; index < 20; index += 1) endpointIds.push(await endpoint(who));

      const first = deploySucceeded(who);
      const second = deploySucceeded(who);
      await handle(first);
      await handle(second);

      const firstSends = await sendsFor(who.orgId, first.eventId);
      const secondSends = await sendsFor(who.orgId, second.eventId);
      expect(firstSends).toHaveLength(20);
      expect(secondSends).toHaveLength(20);
      expect(await attemptDue(firstSends.map((send) => send.id))).toHaveLength(20);
      // 20 already waiting: only DISPATCH_PER_ORG − 20 of the next 20 are dispatched now.
      expect(await attemptDue(secondSends.map((send) => send.id))).toHaveLength(
        DISPATCH_PER_ORG - 20,
      );
      for (const send of secondSends) {
        expect(send).toMatchObject({ nextAttemptAt: NOW, state: 'pending' });
      }
    });

    it('an endpoint deleted between the match and the insert is skipped, not a failed job', async () => {
      const who = await tenant();
      const live = await endpoint(who);
      const gone = await endpoint(who);
      const repository = moduleRef.get(EndpointRepository);
      // The match read both, then a delete committed before the insert (a stale snapshot).
      const matching = vi.spyOn(repository, 'matching').mockResolvedValueOnce([
        { id: gone, state: 'enabled' },
        { id: live, state: 'enabled' },
      ]);
      await inTenant(who.orgId, (tx) => endpoints.delete(tx, who.orgId, who.userId, gone));
      const event = deploySucceeded(who);

      try {
        await expect(handle(event)).resolves.toBeUndefined();
      } finally {
        matching.mockRestore();
      }

      const sends = await sendsFor(who.orgId, event.eventId);
      expect(sends.map((send) => send.endpointId)).toEqual([live]);
      expect(await attemptDue(sends.map((send) => send.id))).toHaveLength(1);
    });

    it('never matches another org’s endpoint', async () => {
      const who = await tenant();
      const other = await tenant();
      await endpoint(other);
      const event = deploySucceeded(who);

      await handle(event);

      expect(await sendsFor(who.orgId, event.eventId)).toEqual([]);
      expect(await sendsFor(other.orgId, event.eventId)).toEqual([]);
    });
  });
});

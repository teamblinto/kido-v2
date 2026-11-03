import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import {
  webhookDeliverySummarySchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookSecretResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { holdOutboxSuiteLock } from '../../../../test/support/outbox-suite-lock';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { revealPlaintext } from '../../../common/crypto/branded';
import { DekService } from '../../../common/crypto/dek.service';
import { NotFoundError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { OrgService } from '../../tenancy/services/org.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { SECRET_PURPOSE, WEBHOOK_ENDPOINTS_PER_ORG } from '../webhooks.constants';
import { EndpointService } from './endpoint.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** The suite lock may wait out a relaying suite before the module boots. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const URL_OK = 'https://hooks.example.com/forge';

interface Fixture {
  readonly orgId: string;
  readonly projectId: string;
  readonly userId: string;
}

function refusal(reason: string) {
  return { extensions: expect.objectContaining({ reason }) as unknown };
}

/**
 * Spec 029 T034 — `EndpointService` against Postgres: the secret sealed and shown once, the
 * per-org limit under the advisory lock, the project scope, the URL refusals, enable/disable,
 * the cascading delete, send test, and an audit row per mutation that never carries a secret.
 */
describe('EndpointService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let service: EndpointService;
    const clock = new FakeClock(NOW);
    const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

    function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function tenant(): Promise<Fixture> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `029e-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      const userId = user!.id;
      created.users.push(userId);
      const orgId = (
        await moduleRef.get(OrgService).create(userId, {
          name: 'Webhook endpoint fixture',
          slug: `029e-${randomUUID().slice(0, 8)}`,
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
          name: `Hooks ${randomUUID().slice(0, 8)}`,
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      return made.id;
    }

    function create(
      who: Fixture,
      body: { eventTypes?: string[]; projectIds?: string[]; url?: string } = {},
    ) {
      return inTenant(who.orgId, (tx) =>
        service.create(tx, who.orgId, who.userId, {
          description: '',
          eventTypes: (body.eventTypes ?? ['deploy.succeeded']) as never,
          projectIds: body.projectIds ?? [],
          url: body.url ?? URL_OK,
        }),
      );
    }

    function refused(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => expect.unreachable('expected a refusal'),
        (error: unknown) => error,
      );
    }

    function endpointCount(orgId: string) {
      return inTenant(orgId, async (tx) => {
        const rows = await tx
          .select({ id: schema.webhookEndpoints.id })
          .from(schema.webhookEndpoints)
          .where(eq(schema.webhookEndpoints.orgId, orgId));
        return rows.length;
      });
    }

    function audits(orgId: string) {
      return inTenant(orgId, (tx) =>
        tx
          .select({
            action: schema.auditLog.action,
            metadata: schema.auditLog.metadata,
            target: schema.auditLog.target,
          })
          .from(schema.auditLog),
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
      service = moduleRef.get(EndpointService);
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

    describe('create', () => {
      it('seals the secret under SECRET_PURPOSE and returns it once', async () => {
        const who = await tenant();

        const response = webhookSecretResponseSchema.parse(await create(who));

        expect(response.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
        expect(response.endpoint).toMatchObject({
          description: '',
          eventTypes: ['deploy.succeeded'],
          lastSuccessAt: null,
          pausedAt: null,
          projectIds: [],
          secretRotation: null,
          state: 'enabled',
          url: URL_OK,
        });

        const opened = await inTenant(who.orgId, async (tx) => {
          const [endpoint] = await tx
            .select({ secretId: schema.webhookEndpoints.secretId })
            .from(schema.webhookEndpoints)
            .where(eq(schema.webhookEndpoints.id, response.endpoint.id));
          const [row] = await tx
            .select()
            .from(schema.secrets)
            .where(eq(schema.secrets.id, endpoint!.secretId));
          expect(row!.purpose).toBe(SECRET_PURPOSE);
          expect(row!.ciphertext.toString('utf8')).not.toContain(response.secret);
          return moduleRef.get(DekService).openSecret(tx, who.orgId, SECRET_PURPOSE, row!);
        });
        expect(revealPlaintext(opened).toString('utf8')).toBe(response.secret);
      });

      it('a later get and list carry no secret', async () => {
        const who = await tenant();
        const { endpoint, secret } = await create(who);

        const got = await inTenant(who.orgId, (tx) => service.get(tx, who.orgId, endpoint.id));
        const listed = await inTenant(who.orgId, (tx) => service.list(tx, who.orgId));

        expect(webhookEndpointSchema.parse(got)).toEqual(endpoint);
        expect(webhookEndpointListSchema.parse(listed)).toEqual({ items: [endpoint] });
        expect(JSON.stringify([got, listed])).not.toContain(secret);
        expect(JSON.stringify([got, listed])).not.toContain('whsec_');
      });

      it('lists newest first', async () => {
        const who = await tenant();
        const first = await create(who);
        clock.advance(1_000);
        const second = await create(who);

        const listed = await inTenant(who.orgId, (tx) => service.list(tx, who.orgId));

        expect(listed.items.map((item) => item.id)).toEqual([
          second.endpoint.id,
          first.endpoint.id,
        ]);
      });

      it('refuses the 21st create with endpoint-limit', async () => {
        const who = await tenant();
        for (let index = 0; index < WEBHOOK_ENDPOINTS_PER_ORG; index += 1) await create(who);

        const error = await refused(create(who));

        expect(error).toMatchObject(refusal('endpoint-limit'));
        expect(await endpointCount(who.orgId)).toBe(WEBHOOK_ENDPOINTS_PER_ORG);
      });

      it('two concurrent creates at 19 leave exactly 20, because of the advisory lock', async () => {
        const who = await tenant();
        for (let index = 0; index < WEBHOOK_ENDPOINTS_PER_ORG - 1; index += 1) await create(who);

        const outcomes = await Promise.allSettled([create(who), create(who)]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
        expect(rejected?.reason).toMatchObject(refusal('endpoint-limit'));
        expect(await endpointCount(who.orgId)).toBe(WEBHOOK_ENDPOINTS_PER_ORG);
      });

      it('keeps a project scope of its own org', async () => {
        const who = await tenant();

        const { endpoint } = await create(who, { projectIds: [who.projectId] });

        expect(endpoint.projectIds).toEqual([who.projectId]);
      });

      it('refuses a project of another org with project-not-in-org', async () => {
        const who = await tenant();
        const other = await tenant();

        const error = await refused(create(who, { projectIds: [other.projectId] }));

        expect(error).toMatchObject(refusal('project-not-in-org'));
        expect(await endpointCount(who.orgId)).toBe(0);
      });

      it('refuses an archived project with project-not-in-org', async () => {
        const who = await tenant();
        await inTenant(who.orgId, (tx) =>
          tx
            .update(schema.projects)
            .set({ deletedAt: NOW })
            .where(eq(schema.projects.id, who.projectId)),
        );

        const error = await refused(create(who, { projectIds: [who.projectId] }));

        expect(error).toMatchObject(refusal('project-not-in-org'));
      });

      it.each([
        ['not a url', 'invalid-url'],
        ['ftp://hooks.example.com/x', 'invalid-url'],
        ['https://user:pass@hooks.example.com/x', 'invalid-url'],
        [`https://hooks.example.com/${'a'.repeat(2048)}`, 'invalid-url'],
        ['https://127.0.0.1/x', 'destination-not-allowed'],
        ['https://[::1]/x', 'destination-not-allowed'],
        ['https://169.254.169.254/latest', 'destination-not-allowed'],
      ])('maps parseEndpointUrl: %s is %s', async (url, reason) => {
        const who = await tenant();

        const error = await refused(create(who, { url }));

        expect(error).toMatchObject(refusal(reason));
        expect(await endpointCount(who.orgId)).toBe(0);
      });
    });

    describe('get', () => {
      it('is 404 for an unknown id and for another org’s endpoint', async () => {
        const who = await tenant();
        const other = await tenant();
        const { endpoint } = await create(other);

        for (const id of [randomUUID(), endpoint.id]) {
          const error = await refused(inTenant(who.orgId, (tx) => service.get(tx, who.orgId, id)));
          expect(error).toBeInstanceOf(NotFoundError);
        }
      });
    });

    describe('update', () => {
      it('enabled: false gives disabled, and enabled: true enables it again', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);

        const disabled = await inTenant(who.orgId, (tx) =>
          service.update(tx, who.orgId, who.userId, endpoint.id, { enabled: false }),
        );
        expect(disabled.state).toBe('disabled');

        const enabled = await inTenant(who.orgId, (tx) =>
          service.update(tx, who.orgId, who.userId, endpoint.id, { enabled: true }),
        );
        expect(enabled.state).toBe('enabled');
      });

      it.each(['paused', 'disabled'] as const)(
        'enabled: true from %s clears the circuit and the pause, and leaves not_sent sends as they are',
        async (from) => {
          const who = await tenant();
          const { endpoint } = await create(who);
          const ping = await inTenant(who.orgId, (tx) =>
            service.test(tx, who.orgId, who.userId, endpoint.id),
          );
          const past = new Date(clock.now().getTime() - 25 * 3_600_000);
          await inTenant(who.orgId, async (tx) => {
            await tx
              .update(schema.webhookSends)
              .set({ nextAttemptAt: null, state: 'not_sent' })
              .where(eq(schema.webhookSends.id, ping.id));
            await tx
              .update(schema.webhookEndpoints)
              .set({
                circuitOpenUntil: new Date(clock.now().getTime() + 60_000),
                failingSince: past,
                failureCount: 7,
                pausedAt: from === 'paused' ? past : null,
                state: from,
              })
              .where(eq(schema.webhookEndpoints.id, endpoint.id));
          });

          const enabled = await inTenant(who.orgId, (tx) =>
            service.update(tx, who.orgId, who.userId, endpoint.id, { enabled: true }),
          );

          expect(enabled.state).toBe('enabled');
          const [row] = await inTenant(who.orgId, (tx) =>
            tx
              .select()
              .from(schema.webhookEndpoints)
              .where(eq(schema.webhookEndpoints.id, endpoint.id)),
          );
          expect(row).toMatchObject({
            circuitOpenUntil: null,
            failingSince: null,
            failureCount: 0,
            pausedAt: null,
            state: 'enabled',
          });
          const [send] = await inTenant(who.orgId, (tx) =>
            tx.select().from(schema.webhookSends).where(eq(schema.webhookSends.id, ping.id)),
          );
          expect(send).toMatchObject({ nextAttemptAt: null, state: 'not_sent' });
        },
      );

      it('changes the url, events, description and scope, and re-checks the url', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);

        const updated = await inTenant(who.orgId, (tx) =>
          service.update(tx, who.orgId, who.userId, endpoint.id, {
            description: 'Ops',
            eventTypes: ['deploy.failed', 'member.joined'],
            projectIds: [who.projectId],
            url: 'https://other.example.com/in',
          }),
        );

        expect(updated).toMatchObject({
          description: 'Ops',
          eventTypes: ['deploy.failed', 'member.joined'],
          projectIds: [who.projectId],
          url: 'https://other.example.com/in',
        });

        const error = await refused(
          inTenant(who.orgId, (tx) =>
            service.update(tx, who.orgId, who.userId, endpoint.id, { url: 'https://10.0.0.1/' }),
          ),
        );
        expect(error).toMatchObject(refusal('destination-not-allowed'));
      });
    });

    describe('delete', () => {
      it('removes the row, its scope, its sends and its secrets rows', async () => {
        const who = await tenant();
        const { endpoint } = await create(who, { projectIds: [who.projectId] });
        await inTenant(who.orgId, (tx) => service.test(tx, who.orgId, who.userId, endpoint.id));
        const secretId = await inTenant(who.orgId, async (tx) => {
          const [row] = await tx
            .select({ secretId: schema.webhookEndpoints.secretId })
            .from(schema.webhookEndpoints)
            .where(eq(schema.webhookEndpoints.id, endpoint.id));
          return row!.secretId;
        });

        await inTenant(who.orgId, (tx) => service.delete(tx, who.orgId, who.userId, endpoint.id));

        const left = await inTenant(who.orgId, async (tx) => ({
          endpoints: await tx
            .select()
            .from(schema.webhookEndpoints)
            .where(eq(schema.webhookEndpoints.id, endpoint.id)),
          scope: await tx
            .select()
            .from(schema.webhookEndpointProjects)
            .where(eq(schema.webhookEndpointProjects.endpointId, endpoint.id)),
          secrets: await tx.select().from(schema.secrets).where(eq(schema.secrets.id, secretId)),
          sends: await tx
            .select()
            .from(schema.webhookSends)
            .where(eq(schema.webhookSends.endpointId, endpoint.id)),
        }));
        expect(left).toEqual({ endpoints: [], scope: [], secrets: [], sends: [] });

        const again = await refused(
          inTenant(who.orgId, (tx) => service.delete(tx, who.orgId, who.userId, endpoint.id)),
        );
        expect(again).toBeInstanceOf(NotFoundError);
      });
    });

    describe('test', () => {
      it('creates a ping send with a fresh event id and appends webhook.attempt-due', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);

        const summary = webhookDeliverySummarySchema.parse(
          await inTenant(who.orgId, (tx) => service.test(tx, who.orgId, who.userId, endpoint.id)),
        );

        expect(summary).toMatchObject({
          attempts: 0,
          eventType: 'ping',
          lastFailure: null,
          projectId: null,
          state: 'pending',
        });
        const [send] = await inTenant(who.orgId, (tx) =>
          tx.select().from(schema.webhookSends).where(eq(schema.webhookSends.id, summary.id)),
        );
        expect(JSON.parse(send!.body!)).toMatchObject({
          data: {},
          id: summary.eventId,
          orgId: who.orgId,
          projectId: null,
          type: 'ping',
        });
        const due = await database
          .select({ payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'webhook.attempt-due'),
              eq(schema.outbox.aggregateId, summary.id),
            ),
          );
        expect(due).toEqual([{ payload: { orgId: who.orgId, sendId: summary.id } }]);
      });

      it('is refused with endpoint-not-enabled unless the endpoint is enabled', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);
        await inTenant(who.orgId, (tx) =>
          service.update(tx, who.orgId, who.userId, endpoint.id, { enabled: false }),
        );

        const error = await refused(
          inTenant(who.orgId, (tx) => service.test(tx, who.orgId, who.userId, endpoint.id)),
        );

        expect(error).toMatchObject(refusal('endpoint-not-enabled'));
      });
    });

    describe('rotateSecret', () => {
      function endpointRow(orgId: string, id: string) {
        return inTenant(orgId, async (tx) => {
          const [row] = await tx
            .select()
            .from(schema.webhookEndpoints)
            .where(eq(schema.webhookEndpoints.id, id));
          return row!;
        });
      }

      function secretRows(orgId: string, ids: readonly string[]) {
        return inTenant(orgId, (tx) =>
          tx
            .select()
            .from(schema.secrets)
            .where(inArray(schema.secrets.id, [...ids])),
        );
      }

      function openSecret(orgId: string, id: string) {
        return inTenant(orgId, async (tx) => {
          const [row] = await tx.select().from(schema.secrets).where(eq(schema.secrets.id, id));
          const opened = await moduleRef
            .get(DekService)
            .openSecret(tx, orgId, SECRET_PURPOSE, row!);
          return revealPlaintext(opened).toString('utf8');
        });
      }

      it('seals a new secret, keeps the old one for 24 h, returns the new one once and audits', async () => {
        const who = await tenant();
        const { endpoint, secret: oldSecret } = await create(who);
        const before = await endpointRow(who.orgId, endpoint.id);

        const response = webhookSecretResponseSchema.parse(
          await inTenant(who.orgId, (tx) =>
            service.rotateSecret(tx, who.orgId, who.userId, endpoint.id, { expireOld: false }),
          ),
        );

        const expiresAt = new Date(clock.now().getTime() + 86_400_000);
        expect(response.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
        expect(response.secret).not.toBe(oldSecret);
        expect(response.endpoint.secretRotation).toEqual({
          previousExpiresAt: expiresAt.toISOString(),
        });

        const after = await endpointRow(who.orgId, endpoint.id);
        expect(after.secretId).not.toBe(before.secretId);
        expect(after.previousSecretId).toBe(before.secretId);
        expect(after.previousSecretExpiresAt).toEqual(expiresAt);
        expect(await openSecret(who.orgId, after.secretId)).toBe(response.secret);
        expect(await openSecret(who.orgId, after.previousSecretId!)).toBe(oldSecret);

        const got = await inTenant(who.orgId, (tx) => service.get(tx, who.orgId, endpoint.id));
        expect(JSON.stringify(got)).not.toContain('whsec_');

        const trail = (await audits(who.orgId)).filter(
          (row) => row.action === 'webhook.endpoint-secret-rotated',
        );
        expect(trail).toHaveLength(1);
        expect(trail[0]!.target).toBe(endpoint.id);
        expect(JSON.stringify(trail)).not.toContain('whsec_');
      });

      it('with expireOld deletes the old secrets row at once and leaves no previous', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);
        const before = await endpointRow(who.orgId, endpoint.id);

        const response = await inTenant(who.orgId, (tx) =>
          service.rotateSecret(tx, who.orgId, who.userId, endpoint.id, { expireOld: true }),
        );

        expect(response.endpoint.secretRotation).toBeNull();
        const after = await endpointRow(who.orgId, endpoint.id);
        expect(after).toMatchObject({ previousSecretExpiresAt: null, previousSecretId: null });
        expect(after.secretId).not.toBe(before.secretId);
        expect(await secretRows(who.orgId, [before.secretId])).toEqual([]);
        expect(await openSecret(who.orgId, after.secretId)).toBe(response.secret);
      });

      it('a second rotation during the overlap deletes the oldest secret first: never more than two live', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);
        const first = await endpointRow(who.orgId, endpoint.id);
        await inTenant(who.orgId, (tx) =>
          service.rotateSecret(tx, who.orgId, who.userId, endpoint.id, { expireOld: false }),
        );
        const second = await endpointRow(who.orgId, endpoint.id);
        clock.advance(3_600_000);

        await inTenant(who.orgId, (tx) =>
          service.rotateSecret(tx, who.orgId, who.userId, endpoint.id, { expireOld: false }),
        );

        const third = await endpointRow(who.orgId, endpoint.id);
        expect(third.previousSecretId).toBe(second.secretId);
        expect(third.previousSecretExpiresAt).toEqual(new Date(clock.now().getTime() + 86_400_000));
        expect(await secretRows(who.orgId, [first.secretId])).toEqual([]);
        const live = await inTenant(who.orgId, (tx) =>
          tx
            .select({ id: schema.secrets.id })
            .from(schema.secrets)
            .where(
              and(eq(schema.secrets.orgId, who.orgId), eq(schema.secrets.purpose, SECRET_PURPOSE)),
            ),
        );
        expect(live.map((row) => row.id).sort()).toEqual([third.secretId, second.secretId].sort());
      });

      it('is 404 for an unknown id and for another org’s endpoint', async () => {
        const who = await tenant();
        const other = await tenant();
        const { endpoint } = await create(other);

        for (const id of [randomUUID(), endpoint.id, 'not-a-uuid']) {
          const error = await refused(
            inTenant(who.orgId, (tx) =>
              service.rotateSecret(tx, who.orgId, who.userId, id, { expireOld: false }),
            ),
          );
          expect(error).toBeInstanceOf(NotFoundError);
        }
      });
    });

    describe('audit', () => {
      it('writes an audit action per mutation, and no metadata contains whsec_', async () => {
        const who = await tenant();
        const { endpoint } = await create(who);
        await inTenant(who.orgId, (tx) =>
          service.update(tx, who.orgId, who.userId, endpoint.id, { description: 'x' }),
        );
        await inTenant(who.orgId, (tx) => service.delete(tx, who.orgId, who.userId, endpoint.id));

        const trail = (await audits(who.orgId)).filter((row) => row.target === endpoint.id);

        expect(trail.map((row) => row.action).sort()).toEqual([
          'webhook.endpoint-created',
          'webhook.endpoint-deleted',
          'webhook.endpoint-updated',
        ]);
        expect(JSON.stringify(trail)).not.toContain('whsec_');
      });
    });
  });
});

import type { ConfigService } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema, type TemplateVersion } from '@repo/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import type { Redis } from 'ioredis';
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

import { type FakeDaytona, startFakeDaytona } from '../../../test/support/fake-daytona';
import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { DaytonaAdapter } from './daytona.adapter';
import { DEFAULT_DAYTONA_TIMINGS, poolFrontKey } from './sandbox.constants';
import { SandboxGuardError } from './sandbox.errors';
import type { MutationContext } from './sandbox.port';
import { ClaimRaced, SandboxClaim } from './sandbox-claim';
import { TemplateVersions } from './template-versions';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-16T10:00:00.000Z';
/** `python`, so the front list this suite wipes is not the one the refill suites fill. */
const TEMPLATE = 'python' as const;
const SNAPSHOT = 'forge/python:test';
const CTX: MutationContext = { leaseEpoch: 2, operationId: 'run-1/step-1' };
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * Contract § 3 against the real `queue` Redis and real Postgres: the front is a hint, the delete
 * is the claim, and the tenant transaction is the truth (research R4). The Daytona side is the
 * loopback fake, reached through the real adapter, so the cold path is a real `POST /sandbox`
 * from the template's current version — `versions.current` is stubbed here (spec 015, R8).
 */
describe('SandboxClaim', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the queue Redis', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let queue: Redis;
    let claim: SandboxClaim;
    let versions: TemplateVersions;
    let currentSpy: ReturnType<typeof vi.spyOn>;
    let clock: FakeClock;
    let fake: FakeDaytona;
    let orgId: string;
    let projectId: string;
    let userId: string;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const FRONT = poolFrontKey(TEMPLATE);

    const ref = () => ({ orgId, projectId });

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    /** A pool row as the ops consumer leaves it once the sandbox answered `started`. */
    async function poolRow(
      entry: {
        state?: 'creating' | 'ready' | 'releasing';
        readyAt?: string;
        snapshot?: string;
      } = {},
    ): Promise<string> {
      const daytonaId = `pool-${randomUUID()}`;
      const [row] = await database
        .insert(schema.sandboxPool)
        .values({
          daytonaId,
          node: 'runner-pool',
          readyAt: new Date(entry.readyAt ?? START),
          snapshot: entry.snapshot ?? SNAPSHOT,
          state: entry.state ?? 'ready',
          template: TEMPLATE,
          workspaceRoot: `/home/daytona/${daytonaId}`,
        })
        .returning({ id: schema.sandboxPool.id });
      return row!.id;
    }

    /** The pool rows of this template only: the refill suites fill the same table. */
    function pool() {
      return database
        .select()
        .from(schema.sandboxPool)
        .where(eq(schema.sandboxPool.template, TEMPLATE));
    }

    async function sandboxRow() {
      return inTenant((tx) =>
        tx.query.sandboxes.findFirst({
          where: and(eq(schema.sandboxes.orgId, orgId), eq(schema.sandboxes.projectId, projectId)),
        }),
      );
    }

    async function opsFor(sandboxId: string) {
      const rows = await database
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'sandbox.op.requested'),
            eq(schema.outbox.aggregateId, sandboxId),
          ),
        );
      return rows.map((row) => row.payload);
    }

    async function auditsFor(target: string) {
      return inTenant((tx) =>
        tx
          .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, target)),
      );
    }

    /** What the template's current version answers: a snapshot name, or none published. */
    function setSnapshot(snapshot: string | null): void {
      currentSpy = vi
        .spyOn(versions, 'current')
        .mockResolvedValue(snapshot === null ? null : ({ snapshot } as TemplateVersion));
    }

    beforeAll(async () => {
      // `AppModule` boots a relay against the shared outbox table: one relay-running suite at a time.
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      clock = new FakeClock(START);
      fake = await startFakeDaytona();
      const env = { DAYTONA_API_KEY: fake.apiKey, DAYTONA_API_URL: fake.apiUrl };
      const adapter = new DaytonaAdapter(
        { get: (key: keyof typeof env) => env[key] } as unknown as ConfigService<Environment, true>,
        DEFAULT_DAYTONA_TIMINGS,
        clock,
      );
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(DaytonaAdapter)
        .useValue(adapter)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      queue = moduleRef.get<Redis>(QUEUE_REDIS);
      claim = moduleRef.get(SandboxClaim, { strict: false });
      versions = moduleRef.get(TemplateVersions, { strict: false });

      const [user] = await database
        .insert(schema.users)
        .values({ email: `014c-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;

      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Claim fixture',
        slug: `014c-${randomUUID().slice(0, 8)}`,
      });
      orgId = org.id;

      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Claimed',
          orgId,
          ownerId: userId,
          template: TEMPLATE,
          workspaceId: workspace!.id,
        }),
      );
      projectId = project.id;
    }, LOCKED_BOOT_TIMEOUT_MS);

    beforeEach(async () => {
      await queue.del(FRONT);
      await database.delete(schema.sandboxPool).where(eq(schema.sandboxPool.template, TEMPLATE));
      await inTenant((tx) => tx.delete(schema.sandboxes).where(eq(schema.sandboxes.orgId, orgId)));
      setSnapshot(SNAPSHOT);
      fake.requests.length = 0;
    });

    afterEach(async () => {
      await queue.del(FRONT);
    });

    afterAll(async () => {
      await database.delete(schema.sandboxPool).where(like(schema.sandboxPool.daytonaId, 'pool-%'));
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(inArray(schema.users.id, [userId]));
      await moduleRef?.close();
      await fake.close();
      await suiteLock?.release();
    });

    it('pops the front, deletes the ready pool row and inserts the project row from it', async () => {
      const first = await poolRow();
      const second = await poolRow();
      await queue.rpush(FRONT, first, second);

      const readiness = await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX));

      expect(readiness).toEqual({ ready: true });
      expect(await queue.lrange(FRONT, 0, -1)).toEqual([second]);
      const rows = await pool();
      expect(rows.map((row) => row.id)).not.toContain(first);
      expect(rows.map((row) => row.id)).toContain(second);

      const row = await sandboxRow();
      expect(row).toMatchObject({
        lastSeenAt: new Date(START),
        node: 'runner-pool',
        state: 'active',
        stateEnteredAt: new Date(START),
        templateSnapshot: SNAPSHOT,
        transition: null,
        transitionSince: null,
      });
      expect(row!.daytonaId).toMatch(/^pool-/);
      expect(row!.workspaceRoot).toBe(`/home/daytona/${row!.daytonaId}`);

      expect(await opsFor(row!.id)).toEqual([
        expect.objectContaining({ op: 'label', orgId, sandboxId: row!.id }),
      ]);
      expect(await auditsFor(row!.id)).toEqual([
        {
          action: 'sandbox.claimed',
          metadata: {
            daytonaId: row!.daytonaId,
            poolId: first,
            snapshot: SNAPSHOT,
            template: TEMPLATE,
          },
        },
      ]);
      // The pool was warm: no Daytona call in the transaction (the label rides the op).
      expect(fake.requests).toEqual([]);
    });

    it('discards a front id whose row is not ready and pops the next', async () => {
      const creating = await poolRow({ state: 'creating' });
      const stranger = randomUUID();
      const ready = await poolRow();
      await queue.rpush(FRONT, creating, stranger, ready);

      expect(await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX))).toEqual({
        ready: true,
      });

      expect(await queue.lrange(FRONT, 0, -1)).toEqual([]);
      const rows = await pool();
      expect(rows.map((row) => row.id)).toEqual([creating]);
      expect((await auditsFor((await sandboxRow())!.id))[0]!.metadata).toMatchObject({
        poolId: ready,
      });
    });

    it('falls back to the oldest ready row under SKIP LOCKED when the front is empty', async () => {
      const newer = await poolRow({ readyAt: '2026-09-16T09:30:00.000Z' });
      const oldest = await poolRow({ readyAt: '2026-09-16T09:00:00.000Z' });
      await poolRow({ readyAt: '2026-09-16T08:00:00.000Z', state: 'releasing' });

      expect(await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX))).toEqual({
        ready: true,
      });

      const remaining = (await pool()).map((row) => row.id);
      expect(remaining).toContain(newer);
      expect(remaining).not.toContain(oldest);
      expect((await auditsFor((await sandboxRow())!.id))[0]!.metadata).toMatchObject({
        poolId: oldest,
      });
    });

    it('prefers a ready row on the current snapshot over an older one on a superseded snapshot', async () => {
      const superseded = await poolRow({
        readyAt: '2026-09-16T08:00:00.000Z',
        snapshot: 'forge/python:old',
      });
      const current = await poolRow({ readyAt: '2026-09-16T09:30:00.000Z' });

      expect(await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX))).toEqual({
        ready: true,
      });

      expect((await pool()).map((row) => row.id)).toEqual([superseded]);
      const row = await sandboxRow();
      expect(row!.templateSnapshot).toBe(SNAPSHOT);
      expect((await auditsFor(row!.id))[0]!.metadata).toMatchObject({
        poolId: current,
        snapshot: SNAPSHOT,
      });
      expect(currentSpy).toHaveBeenCalledTimes(1);
    });

    it('takes the oldest ready row and carries its snapshot when the template has no current version', async () => {
      setSnapshot(null);
      const newer = await poolRow({ readyAt: '2026-09-16T09:30:00.000Z' });
      const oldest = await poolRow({
        readyAt: '2026-09-16T09:00:00.000Z',
        snapshot: 'forge/python:old',
      });

      expect(await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX))).toEqual({
        ready: true,
      });

      expect((await pool()).map((row) => row.id)).toEqual([newer]);
      const row = await sandboxRow();
      expect(row!.templateSnapshot).toBe('forge/python:old');
      expect((await auditsFor(row!.id))[0]!.metadata).toMatchObject({
        poolId: oldest,
        snapshot: 'forge/python:old',
      });
    });

    it('pushes the popped id back and throws ClaimRaced on a unique violation', async () => {
      await inTenant((tx) =>
        tx.insert(schema.sandboxes).values({
          daytonaId: `pool-existing-${randomUUID()}`,
          orgId,
          projectId,
          workspaceRoot: '/home/daytona',
        }),
      );
      const id = await poolRow();
      await queue.rpush(FRONT, id);

      await expect(inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX))).rejects.toBeInstanceOf(
        ClaimRaced,
      );

      expect(await queue.lrange(FRONT, 0, -1)).toEqual([id]);
      // The caller's transaction rolled back: the pool row is still there, ready.
      expect(await pool()).toMatchObject([{ id, state: 'ready' }]);
      expect((await sandboxRow())!.daytonaId).toMatch(/^pool-existing-/);
    });

    it('deletes a lost row first and replaces it (FR-026)', async () => {
      const lostDaytonaId = `pool-lost-${randomUUID()}`;
      await inTenant((tx) =>
        tx.insert(schema.sandboxes).values({
          daytonaId: lostDaytonaId,
          lostAt: clock.now(),
          orgId,
          projectId,
          workspaceRoot: '/home/daytona',
        }),
      );
      const id = await poolRow();
      await queue.rpush(FRONT, id);

      expect(await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX))).toEqual({
        ready: true,
      });

      const row = await sandboxRow();
      expect(row).toMatchObject({ lostAt: null, state: 'active' });
      expect(row!.daytonaId).not.toBe(lostDaytonaId);
      const all = await inTenant((tx) => tx.select().from(schema.sandboxes));
      expect(all).toHaveLength(1);
    });

    it('creates cold when the pool is empty: POST /sandbox, then a creating row and the create op', async () => {
      const readiness = await inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX));

      expect(readiness).toEqual({ because: 'creating', ready: false });

      const create = fake.requests.find(
        (request) => request.method === 'POST' && request.path === '/api/sandbox',
      );
      expect(create).toBeDefined();
      expect(JSON.parse(create!.body)).toMatchObject({
        labels: {
          'forge.kind': 'project',
          'forge.owner': 'forge-test',
          'forge.template': TEMPLATE,
        },
        snapshot: SNAPSHOT,
      });

      const row = await sandboxRow();
      expect(row).toMatchObject({
        lastSeenAt: new Date(START),
        state: 'active',
        templateSnapshot: SNAPSHOT,
        transition: 'creating',
        transitionSince: new Date(START),
        workspaceRoot: null,
      });
      expect(fake.sandboxes.has(row!.daytonaId)).toBe(true);

      const ops = await opsFor(row!.id);
      expect(ops).toHaveLength(2);
      expect(ops).toContainEqual(expect.objectContaining({ op: 'create', sandboxId: row!.id }));
      expect(ops).toContainEqual(expect.objectContaining({ op: 'label', sandboxId: row!.id }));
      expect(await auditsFor(row!.id)).toEqual([
        {
          action: 'sandbox.claimed',
          metadata: { daytonaId: row!.daytonaId, snapshot: SNAPSHOT, template: TEMPLATE },
        },
      ]);
    });

    it('throws no-sandbox when the pool is empty and the template has no published version', async () => {
      setSnapshot(null);

      const attempt = inTenant((tx) => claim.claim(tx, ref(), TEMPLATE, CTX));

      await expect(attempt).rejects.toMatchObject({
        kind: 'no-sandbox',
        message: 'The pool is empty and the template has no published version.',
      });
      await expect(attempt).rejects.toBeInstanceOf(SandboxGuardError);
      expect(fake.requests).toEqual([]);
      expect(await sandboxRow()).toBeUndefined();
    });
  });
});

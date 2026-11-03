import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import {
  DEFAULT_DAYTONA_TIMINGS,
  DEFAULT_SANDBOX_TIMINGS,
  SANDBOX_TIMINGS,
  poolFrontKey,
} from './sandbox.constants';
import { SandboxReconciler } from './sandbox-reconciler';
import { TemplateVersions } from './template-versions';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-16T10:00:00.000Z';
/** Every id this suite seeds, at the fake and in both tables, starts with this. */
const PREFIX = 'recon-';
const TEMPLATE = 'python' as const;
const SNAPSHOT = 'forge/python:recon';
const { buildTimeoutMs, orphanGraceMs, staleTransitionMs } = DEFAULT_SANDBOX_TIMINGS;
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

interface Tenant {
  readonly orgId: string;
  readonly projectId: string;
  readonly userId: string;
}

const ago = (ms: number): string => new Date(new Date(START).getTime() - ms).toISOString();

/**
 * Research R9 against real Postgres, the real `queue` Redis and the loopback Daytona: the
 * inventory is read by label, every row is checked under its own tenant, orphans are released
 * after the grace, and the front is rebuilt from the durable record (spec 014 US4, FR-025/027).
 */
describe('SandboxReconciler', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue Redis and a fake Daytona',
    () => {
      let moduleRef: TestingModule;
      let database: ForgeDatabase;
      let transactions: TenantTransactionRunner;
      let queue: Redis;
      let reconciler: SandboxReconciler;
      let clock: FakeClock;
      let fake: FakeDaytona;
      let owner: string;
      let alpha: Tenant;
      let beta: Tenant;
      let warnings: string[];
      /** What the stubbed `versions.current(TEMPLATE)` answers: a snapshot name, or nothing. */
      let current: string | null;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const FRONT = poolFrontKey(TEMPLATE);

      const ours = (extra: Record<string, string> = {}) => ({
        'forge.kind': 'project',
        'forge.owner': owner,
        'forge.template': TEMPLATE,
        ...extra,
      });

      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      async function tenant(label: string): Promise<Tenant> {
        const [user] = await database
          .insert(schema.users)
          .values({ email: `014r-${label}-${randomUUID()}@example.test`, passwordHash: 'x' })
          .returning({ id: schema.users.id });
        const userId = user!.id;
        const org = await moduleRef.get(OrgService).create(userId, {
          name: `Reconcile ${label}`,
          slug: `014r-${label}-${randomUUID().slice(0, 8)}`,
        });
        const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
          tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
        );
        const project = await transactions.runInTenantScope({ orgId: org.id, userId }, () =>
          moduleRef.get(ProjectService).create({
            actorId: userId,
            name: `Reconciled ${label}`,
            orgId: org.id,
            ownerId: userId,
            template: TEMPLATE,
            workspaceId: workspace!.id,
          }),
        );
        return { orgId: org.id, projectId: project.id, userId };
      }

      /** A project row as the claim leaves it, with whatever the case needs overridden. */
      async function sandboxRow(
        who: Tenant,
        row: Partial<typeof schema.sandboxes.$inferInsert> = {},
      ): Promise<{ id: string; daytonaId: string }> {
        const daytonaId = `${PREFIX}${randomUUID()}`;
        const [inserted] = await inTenant(who.orgId, (tx) =>
          tx
            .insert(schema.sandboxes)
            .values({
              daytonaId,
              lastSeenAt: clock.now(),
              orgId: who.orgId,
              projectId: who.projectId,
              state: 'active',
              stateEnteredAt: clock.now(),
              workspaceRoot: '/home/daytona',
              ...row,
            })
            .returning({ daytonaId: schema.sandboxes.daytonaId, id: schema.sandboxes.id }),
        );
        return inserted!;
      }

      async function poolRow(
        row: Partial<typeof schema.sandboxPool.$inferInsert> = {},
      ): Promise<{ id: string; daytonaId: string }> {
        const [inserted] = await database
          .insert(schema.sandboxPool)
          .values({
            daytonaId: `${PREFIX}${randomUUID()}`,
            readyAt: clock.now(),
            snapshot: SNAPSHOT,
            state: 'ready',
            template: TEMPLATE,
            ...row,
          })
          .returning({ daytonaId: schema.sandboxPool.daytonaId, id: schema.sandboxPool.id });
        return inserted!;
      }

      function readRow(who: Tenant, id: string) {
        return inTenant(who.orgId, (tx) =>
          tx.query.sandboxes.findFirst({ where: eq(schema.sandboxes.id, id) }),
        );
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

      function auditsFor(who: Tenant, target: string) {
        return inTenant(who.orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(eq(schema.auditLog.target, target), eq(schema.auditLog.action, 'sandbox.lost')),
            ),
        );
      }

      const removed = () =>
        fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path.split('/').at(-1));

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        clock = new FakeClock(START);
        fake = await startFakeDaytona();
        const env = { DAYTONA_API_KEY: fake.apiKey, DAYTONA_API_URL: fake.apiUrl };
        const adapter = new DaytonaAdapter(
          { get: (key: keyof typeof env) => env[key] } as unknown as ConfigService<
            Environment,
            true
          >,
          DEFAULT_DAYTONA_TIMINGS,
          clock,
        );
        moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(DaytonaAdapter)
          .useValue(adapter)
          .overrideProvider(SANDBOX_TIMINGS)
          .useValue(DEFAULT_SANDBOX_TIMINGS)
          .compile();
        await moduleRef.init();

        database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
        transactions = moduleRef.get(TenantTransactionRunner);
        queue = moduleRef.get<Redis>(QUEUE_REDIS);
        reconciler = moduleRef.get(SandboxReconciler, { strict: false });
        owner = moduleRef
          .get<ConfigService<Environment, true>>(ConfigService)
          .get('SANDBOX_OWNER', { infer: true });
        alpha = await tenant('alpha');
        beta = await tenant('beta');
      }, LOCKED_BOOT_TIMEOUT_MS);

      beforeEach(async () => {
        clock.set(START);
        await queue.del(FRONT);
        await database
          .delete(schema.sandboxPool)
          .where(like(schema.sandboxPool.daytonaId, `${PREFIX}%`));
        for (const who of [alpha, beta]) {
          await inTenant(who.orgId, (tx) =>
            tx.delete(schema.sandboxes).where(eq(schema.sandboxes.orgId, who.orgId)),
          );
        }
        for (const id of [...fake.sandboxes.keys()])
          if (id.startsWith(PREFIX)) fake.sandboxes.delete(id);
        fake.requests.length = 0;
        warnings = [];
        current = null;
        vi.spyOn(moduleRef.get(TemplateVersions), 'current').mockImplementation(() =>
          Promise.resolve(current === null ? null : ({ snapshot: current } as TemplateVersion)),
        );
        vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
          warnings.push(String(message));
        });
      });

      afterEach(async () => {
        vi.restoreAllMocks();
        await queue.del(FRONT);
      });

      afterAll(async () => {
        await database
          .delete(schema.sandboxPool)
          .where(like(schema.sandboxPool.daytonaId, `${PREFIX}%`));
        await database
          .delete(schema.orgs)
          .where(inArray(schema.orgs.id, [alpha.orgId, beta.orgId]));
        await database
          .delete(schema.users)
          .where(inArray(schema.users.id, [alpha.userId, beta.userId]));
        await moduleRef?.close();
        await fake.close();
        await suiteLock?.release();
      });

      it('releases an owner-labelled sandbox no row claims once it is older than the grace, and warns', async () => {
        const old = fake.seedSandbox({
          createdAt: ago(orphanGraceMs + 1_000),
          id: `${PREFIX}orphan-old`,
          labels: ours(),
        });
        const young = fake.seedSandbox({
          createdAt: ago(orphanGraceMs - 1_000),
          id: `${PREFIX}orphan-young`,
          labels: ours(),
        });

        await reconciler.reconcile();

        expect(removed()).toEqual([old]);
        expect(fake.sandboxes.has(old)).toBe(false);
        expect(fake.sandboxes.has(young)).toBe(true);
        expect(warnings.filter((w) => w.includes(old))).toHaveLength(1);
        expect(warnings.some((w) => w.includes(young))).toBe(false);
      });

      it('reaps a build sandbox only after the build timeout on top of the grace (015 R11)', async () => {
        const build = (extra: Record<string, string>) => ours({ 'forge.kind': 'build', ...extra });
        const running = fake.seedSandbox({
          createdAt: ago(buildTimeoutMs + orphanGraceMs - 1_000),
          id: `${PREFIX}build-running`,
          labels: build({}),
        });
        const abandoned = fake.seedSandbox({
          createdAt: ago(buildTimeoutMs + orphanGraceMs + 1_000),
          id: `${PREFIX}build-abandoned`,
          labels: build({}),
        });

        await reconciler.reconcile();

        expect(removed()).toEqual([abandoned]);
        expect(fake.sandboxes.has(running)).toBe(true);
      });

      it('marks a project row lost with an audit entry, and deletes a pool row, when Daytona has no such id', async () => {
        const gone = await sandboxRow(alpha);
        const kept = await sandboxRow(beta);
        fake.seedSandbox({ id: kept.daytonaId, labels: ours() });
        const pool = await poolRow();

        await reconciler.reconcile();

        expect(await readRow(alpha, gone.id)).toMatchObject({ lostAt: clock.now() });
        expect(await auditsFor(alpha, gone.id)).toEqual([
          { action: 'sandbox.lost', metadata: { daytonaId: gone.daytonaId } },
        ]);
        expect(await readRow(beta, kept.id)).toMatchObject({ lostAt: null });
        expect(await auditsFor(beta, kept.id)).toEqual([]);
        expect(
          await database
            .select()
            .from(schema.sandboxPool)
            .where(eq(schema.sandboxPool.id, pool.id)),
        ).toEqual([]);
        expect(removed()).toEqual([]);
      });

      it('does not audit a row already marked lost twice', async () => {
        const lost = await sandboxRow(alpha, { lostAt: new Date(ago(60_000)) });

        await reconciler.reconcile();

        expect(await readRow(alpha, lost.id)).toMatchObject({ lostAt: new Date(ago(60_000)) });
        expect(await auditsFor(alpha, lost.id)).toEqual([]);
      });

      it('records hibernated when Daytona says stopped for an active or idle row with no transition', async () => {
        const active = await sandboxRow(alpha);
        const idle = await sandboxRow(beta, { state: 'idle' });
        fake.seedSandbox({ id: active.daytonaId, labels: ours(), state: 'stopped' });
        fake.seedSandbox({ id: idle.daytonaId, labels: ours(), state: 'stopped' });

        await reconciler.reconcile();

        for (const [who, row] of [
          [alpha, active],
          [beta, idle],
        ] as const) {
          expect(await readRow(who, row.id)).toMatchObject({
            hibernatedAt: clock.now(),
            state: 'hibernated',
            stateEnteredAt: clock.now(),
            transition: null,
          });
        }
      });

      it('leaves a stopped row alone while its own hibernate op is in flight', async () => {
        const row = await sandboxRow(alpha, {
          state: 'idle',
          transition: 'hibernating',
          transitionSince: clock.now(),
        });
        fake.seedSandbox({ id: row.daytonaId, labels: ours(), state: 'stopped' });

        await reconciler.reconcile();

        expect(await readRow(alpha, row.id)).toMatchObject({
          state: 'idle',
          transition: 'hibernating',
        });
        expect(await opsFor(row.id)).toEqual([]);
      });

      it('re-appends the op of a transition older than the stale window and refreshes its clock', async () => {
        const stale = await sandboxRow(alpha, {
          state: 'hibernated',
          hibernatedAt: clock.now(),
          transition: 'resuming',
          transitionSince: new Date(ago(staleTransitionMs + 1_000)),
        });
        const fresh = await sandboxRow(beta, {
          transition: 'creating',
          transitionSince: new Date(ago(staleTransitionMs - 1_000)),
          workspaceRoot: null,
        });
        fake.seedSandbox({ id: stale.daytonaId, labels: ours(), state: 'stopped' });
        fake.seedSandbox({ id: fresh.daytonaId, labels: ours(), state: 'creating' });

        await reconciler.reconcile();

        expect(await opsFor(stale.id)).toEqual([
          { op: 'resume', orgId: alpha.orgId, sandboxId: stale.id },
        ]);
        expect(await readRow(alpha, stale.id)).toMatchObject({
          transition: 'resuming',
          transitionSince: clock.now(),
        });
        expect(await opsFor(fresh.id)).toEqual([]);
        expect(await readRow(beta, fresh.id)).toMatchObject({
          transitionSince: new Date(ago(staleTransitionMs - 1_000)),
        });
      });

      it('releases a pool row whose create dead-lettered', async () => {
        const failed = await poolRow({
          failureReason: 'upstream-5xx',
          readyAt: null,
          state: 'creating',
        });
        fake.seedSandbox({ id: failed.daytonaId, labels: ours({ 'forge.kind': 'pool' }) });

        await reconciler.reconcile();

        expect(
          await database
            .select()
            .from(schema.sandboxPool)
            .where(eq(schema.sandboxPool.id, failed.id)),
        ).toMatchObject([{ state: 'releasing' }]);
        expect(await opsFor(failed.id)).toEqual([{ op: 'release', poolId: failed.id }]);
        expect(removed()).toEqual([]);
      });

      it('rebuilds the front from the ready rows, oldest first, discarding what was there', async () => {
        const newer = await poolRow({ readyAt: new Date(ago(1_000)) });
        const older = await poolRow({ readyAt: new Date(ago(2_000)) });
        const creating = await poolRow({ readyAt: null, state: 'creating' });
        for (const row of [newer, older, creating])
          fake.seedSandbox({ id: row.daytonaId, labels: ours({ 'forge.kind': 'pool' }) });
        await queue.rpush(FRONT, 'stale-hint', newer.id);

        await reconciler.reconcile();

        const front = await queue.lrange(FRONT, 0, -1);
        expect(front).not.toContain('stale-hint');
        expect(front.filter((id) => [newer.id, older.id, creating.id].includes(id))).toEqual([
          older.id,
          newer.id,
        ]);
      });

      it('rebuilds the front current-version rows first, then the superseded, each oldest first', async () => {
        current = 'forge/python:new';
        const oldNewer = await poolRow({ readyAt: new Date(ago(1_000)) });
        const oldOlder = await poolRow({ readyAt: new Date(ago(4_000)) });
        const curNewer = await poolRow({ readyAt: new Date(ago(2_000)), snapshot: current });
        const curOlder = await poolRow({ readyAt: new Date(ago(3_000)), snapshot: current });
        for (const row of [oldNewer, oldOlder, curNewer, curOlder])
          fake.seedSandbox({ id: row.daytonaId, labels: ours({ 'forge.kind': 'pool' }) });

        await reconciler.reconcile();

        const mine = [oldNewer, oldOlder, curNewer, curOlder].map((r) => r.id);
        const front = (await queue.lrange(FRONT, 0, -1)).filter((id) => mine.includes(id));
        expect(front).toEqual([curOlder.id, curNewer.id, oldOlder.id, oldNewer.id]);
      });

      it('counts an unlabelled sandbox and one with another owner, and never removes them', async () => {
        const unlabelled = fake.seedSandbox({
          createdAt: ago(orphanGraceMs * 10),
          id: `${PREFIX}forge-local`,
        });
        const theirs = fake.seedSandbox({
          createdAt: ago(orphanGraceMs * 10),
          id: `${PREFIX}colleague`,
          labels: ours({ 'forge.owner': `${owner}-colleague` }),
        });
        const logs: string[] = [];
        vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
          logs.push(String(message));
        });

        const report = await reconciler.reconcile();

        expect(fake.sandboxes.has(unlabelled)).toBe(true);
        expect(fake.sandboxes.has(theirs)).toBe(true);
        expect(removed()).toEqual([]);
        // `sandbox-fake-0001` is the fake's own unlabelled default: three strangers in all.
        expect(report.foreign).toBe(3);
        expect(logs.some((line) => line.includes('foreign=3'))).toBe(true);
      });

      it('handles each organisation in its own tenant transaction', async () => {
        const a = await sandboxRow(alpha);
        const b = await sandboxRow(beta);

        await reconciler.reconcile();

        expect(await readRow(alpha, a.id)).toMatchObject({ lostAt: clock.now() });
        expect(await readRow(beta, b.id)).toMatchObject({ lostAt: clock.now() });
        expect(await auditsFor(alpha, a.id)).toHaveLength(1);
        expect(await auditsFor(beta, b.id)).toHaveLength(1);
      });
    },
  );
});

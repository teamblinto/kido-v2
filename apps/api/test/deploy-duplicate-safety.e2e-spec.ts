import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ProjectTemplate } from '@repo/contracts';
import { type Deployment, schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { mirrorKey } from '../src/modules/checkpoints/repo-bundler';
import { BuildDeployConsumer } from '../src/modules/deploy/build-deploy.consumer';
import { BuildRunner } from '../src/modules/deploy/build-runner';
import { ARTIFACT_STORE } from '../src/modules/deploy/deploy.constants';
import { DeploymentRepository } from '../src/modules/deploy/deployment.repository';
import { SiteRepository } from '../src/modules/deploy/site.repository';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { ConsumerBase } from '../src/modules/outbox/consumer-base';
import type { Envelope } from '../src/modules/outbox/envelope';
import { BUILD_SANDBOX, type BuildSandbox } from '../src/modules/sandbox/build-sandbox.service';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  type Tenant,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import (as `deploy.e2e-spec.ts`). */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `api` alone: no relay, no `build.deploy` worker, no sweep. Every delivery below is the
  // suite's own, through the real `ConsumerBase`, so it decides when a worker stalls and when the
  // queue re-delivers.
  process.env.RUN_PROFILES = 'api';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const TEMPLATE: ProjectTemplate = 'vite-react';
const SNAPSHOT = 'forge-tpl-vite-react-dup-e2e';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const CASE_TIMEOUT_MS = 30_000;

// ---- the build's output: a minimal ustar writer (tar-reader.spec.ts covers the format) ----

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function member(name: string, body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  const block = Buffer.alloc(BLOCK);
  const put = (offset: number, value: string): void => {
    Buffer.from(value, 'utf8').copy(block, offset);
  };
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(bytes.length, 12));
  put(136, octal(0, 12));
  put(156, '0');
  put(257, 'ustar\0');
  put(263, '00');
  put(148, '        ');
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, octal(sum, 7) + ' ');
  const rest = bytes.length % BLOCK;
  return Buffer.concat([block, bytes, Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)]);
}

function siteArchive(heading: string): Buffer {
  return Buffer.concat([
    member('./index.html', `<!doctype html><h1>${heading}</h1>`),
    member('./assets/app.js', `console.log(${JSON.stringify(heading)});`),
    Buffer.alloc(BLOCK * 2),
  ]);
}

// ---- doubles ----

/** A one-shot stall: the first matching call parks at `reached` until `release()`. */
class Stall {
  armed = false;
  private open: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  private hit: () => void = () => undefined;
  readonly reached = new Promise<void>((resolve) => (this.hit = resolve));

  /** Parks the caller if armed, once; a later call passes straight through. */
  async park(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.hit();
    await this.gate;
  }

  release(): void {
    this.open();
  }
}

/** The artifacts bucket, with a stall before the first PUT or after the manifest's. */
class StallingStore extends MemoryObjectStore {
  beforeFirstPut: Stall | undefined;
  afterManifest: Stall | undefined;

  override async put(key: string, body: Buffer, meta: Readonly<Record<string, string>>) {
    await this.beforeFirstPut?.park();
    await super.put(key, body, meta);
    if (key.endsWith('/manifest.json')) await this.afterManifest?.park();
  }
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface Seeded {
  readonly checkpointId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly userId: string;
}

/** One fenced write the stale worker made after it woke, and whether it touched a row. */
interface LateWrite {
  readonly method: 'fail' | 'markUploading' | 'succeed' | 'upsertOnGoLive';
  readonly wrote: boolean;
}

/**
 * Spec 027 SC-005 (T075, research R8, FR-015, FR-017): a worker stalled or killed at each of the
 * five boundaries, the job re-delivered, and then the stale worker let go. Whatever the point,
 * there is exactly one `deployments` row and at most one `project_sites` change; a kill before the
 * upload boundary is retried to `succeeded`, one after it is settled `failed / platform`; and
 * every write the stale worker makes once it wakes matches zero rows.
 *
 * Real API, Postgres, `ConsumerBase` and `BuildDeployConsumer`, the real `BuildRunner` against the
 * fake Daytona; the buckets are in memory. The stall is the only double in the worker's path.
 *
 * A worker killed mid-go-live cannot be killed in-process; the fifth case throws inside the
 * go-live transaction before it commits, which rolls it back as a dropped connection would. The
 * consumer's own catch then tries to settle the row: that attempt is the stale write under test.
 */
describe('Deploy duplicate safety (e2e, SC-005)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, a fake Daytona and in-memory buckets',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let db: ForgeDatabase;
      let consumer: BuildDeployConsumer;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const repos = new MemoryObjectStore();
      const artifacts = new StallingStore();

      /** Set while only the stale worker is running: its fenced writes are recorded here. */
      let late: LateWrite[] | undefined;

      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      async function seed(tenant: Tenant, name: string): Promise<Seeded> {
        const { orgId, owner, workspaceId } = tenant;
        const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app.get(ProjectService).create({
            actorId: owner.userId,
            name,
            orgId,
            ownerId: owner.userId,
            template: TEMPLATE,
            workspaceId,
          }),
        );
        const gitSha = randomBytes(20).toString('hex');
        const [checkpoint] = await inTenant(orgId, (tx) =>
          tx
            .insert(schema.checkpoints)
            .values({
              files: [],
              gitSha,
              kind: 'baseline',
              label: 'Baseline: e2e',
              orgId,
              projectId: project.id,
            })
            .returning({ id: schema.checkpoints.id }),
        );
        await repos.put(mirrorKey(orgId, project.id), Buffer.from(`bundle of ${gitSha}`), {
          head: gitSha,
        });
        return {
          checkpointId: checkpoint!.id,
          orgId,
          projectId: project.id,
          userId: owner.userId,
        };
      }

      async function queue(seeded: Seeded): Promise<Deployment> {
        return (await inTenant(seeded.orgId, (tx) =>
          app.get(DeploymentRepository).insertQueued(tx, {
            checkpointId: seeded.checkpointId,
            orgId: seeded.orgId,
            projectId: seeded.projectId,
            requestedBy: seeded.userId,
            template: TEMPLATE,
          }),
        ))!;
      }

      function envelope(seeded: Seeded, deploymentId: string): Envelope<'deploy.requested'> {
        return {
          aggregate: 'deployment',
          aggregateId: deploymentId,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          orgId: seeded.orgId,
          payload: { deploymentId, orgId: seeded.orgId, projectId: seeded.projectId },
          traceId: null,
          type: 'deploy.requested',
        };
      }

      /** One delivery of the job, as the `build.deploy` worker makes it. */
      function deliver(event: Envelope<'deploy.requested'>): Promise<void> {
        return app.get(ConsumerBase).processJob(consumer, {
          attemptsMade: 0,
          data: event,
          log: () => Promise.resolve(0),
        });
      }

      /** Everything SC-005 counts, for one project. */
      async function counts(seeded: Seeded, deploymentId: string) {
        const { orgId, projectId } = seeded;
        return {
          audits: await inTenant(orgId, (tx) =>
            tx
              .select({ action: schema.auditLog.action })
              .from(schema.auditLog)
              .where(
                and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.target, deploymentId)),
              ),
          ).then((rows) => rows.map((row) => row.action).sort()),
          events: await db
            .select({ type: schema.outbox.type })
            .from(schema.outbox)
            .where(eq(schema.outbox.aggregateId, deploymentId))
            .then((rows) => rows.map((row) => row.type).sort()),
          rows: await inTenant(orgId, (tx) =>
            tx.select().from(schema.deployments).where(eq(schema.deployments.projectId, projectId)),
          ),
          sites: await inTenant(orgId, (tx) =>
            tx
              .select()
              .from(schema.projectSites)
              .where(eq(schema.projectSites.projectId, projectId)),
          ),
        };
      }

      /**
       * The whole scenario: deliver, stall at `stall`, re-deliver to completion, then wake the stale
       * worker and let it finish. Returns the counts before and after the wake, and its late writes.
       */
      async function killAndRedeliver(seeded: Seeded, stall: Stall, heading: string) {
        fake.resetBuild();
        fake.buildArchive(siteArchive(heading));
        const deployment = await queue(seeded);
        const event = envelope(seeded, deployment.id);

        stall.armed = true;
        const stale = deliver(event);
        await stall.reached;

        // BullMQ's stalled-job check hands the same job to another worker.
        await deliver(event);
        const redelivered = await counts(seeded, deployment.id);

        late = [];
        stall.release();
        await stale;
        const writes = late;
        late = undefined;

        return { after: await counts(seeded, deployment.id), deployment, redelivered, writes };
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(DAYTONA_TIMINGS)
          .useValue({ ...DEFAULT_DAYTONA_TIMINGS, lookupTtlMs: 0 })
          .overrideProvider(OBJECT_STORE)
          .useValue(repos)
          .overrideProvider(ARTIFACT_STORE)
          .useValue(artifacts)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        transactions = app.get(TenantTransactionRunner);
        db = app.get<ForgeDatabase>(APP_DATABASE);
        consumer = app.get(BuildDeployConsumer, { strict: false });
        await publishFakeVersion(db, TEMPLATE, SNAPSHOT);
        world = await createTwoTenantWorld(app);
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        if (db) await dropFakeVersions(db, TEMPLATE);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      beforeEach(() => {
        artifacts.beforeFirstPut = undefined;
        artifacts.afterManifest = undefined;

        // Record the stale worker's fenced writes once it wakes; the calls themselves are real.
        const deployments = app.get(DeploymentRepository, { strict: false });
        const sites = app.get(SiteRepository, { strict: false });
        for (const method of ['fail', 'markUploading', 'succeed'] as const) {
          const real = DeploymentRepository.prototype[method].bind(deployments) as (
            ...a: unknown[]
          ) => Promise<boolean>;
          vi.spyOn(deployments, method).mockImplementation(async (...args: unknown[]) => {
            const wrote = await real(...args);
            late?.push({ method, wrote });
            return wrote;
          });
        }
        vi.spyOn(sites, 'upsertOnGoLive').mockImplementation(async (...args) => {
          const pointer = await SiteRepository.prototype.upsertOnGoLive.apply(sites, args);
          late?.push({ method: 'upsertOnGoLive', wrote: pointer !== undefined });
          return pointer;
        });
      });

      // ---- before the upload boundary: retried to one go-live ----

      /** Stall the n-th delivery's worker at the point: `stalls[0]` the first, `stalls[1]` the next. */
      const PRE_UPLOAD = [
        {
          point: 'before the build',
          arm: (stalls: Stall[]) => {
            const runner = app.get(BuildRunner, { strict: false });
            const real = BuildRunner.prototype.run.bind(runner);
            let calls = 0;
            vi.spyOn(runner, 'run').mockImplementation(async (input) => {
              await stalls[calls++]?.park();
              return real(input);
            });
          },
        },
        {
          point: 'during the build',
          arm: (stalls: Stall[]) => {
            const sandbox = app.get<BuildSandbox>(BUILD_SANDBOX, { strict: false });
            const real = sandbox.run.bind(sandbox);
            let calls = 0;
            vi.spyOn(sandbox, 'run').mockImplementation(async (handle, command, timeoutMs) => {
              if (command === 'npm ci') await stalls[calls++]?.park();
              return real(handle, command, timeoutMs);
            });
          },
        },
      ];

      it.each(PRE_UPLOAD)(
        'a worker stalled $point: the re-delivery goes live once, the stale worker writes nothing',
        async ({ arm, point }) => {
          const seeded = await seed(world.alpha, `Dup ${point}`);
          const stall = new Stall();
          arm([stall]);

          const { after, deployment, redelivered, writes } = await killAndRedeliver(
            seeded,
            stall,
            point,
          );

          // The re-delivery re-claimed the row (a second attempt) and went live.
          expect(redelivered.rows).toHaveLength(1);
          expect(redelivered.rows[0]).toMatchObject({
            attempts: 2,
            failureReason: null,
            id: deployment.id,
            leaseEpoch: 2,
            state: 'succeeded',
          });
          expect(redelivered.sites).toEqual([
            expect.objectContaining({ currentDeploymentId: deployment.id }),
          ]);
          expect(redelivered.events).toEqual(['deploy.succeeded']);
          expect(redelivered.audits).toEqual(['deploy.succeeded']);

          // The stale worker woke on epoch 1: its one fenced write matched nothing.
          expect(writes).toEqual([{ method: 'markUploading', wrote: false }]);
          expect(after).toEqual(redelivered);
        },
        CASE_TIMEOUT_MS,
      );

      it.each(PRE_UPLOAD)(
        'a worker stalled $point that wakes while the re-delivery is still building is fenced out by the epoch',
        async ({ arm, point }) => {
          const seeded = await seed(world.alpha, `Dup overlap ${point}`);
          const stale = new Stall();
          const second = new Stall();
          arm([stale, second]);
          fake.resetBuild();
          fake.buildArchive(siteArchive(`overlap ${point}`));
          const deployment = await queue(seeded);
          const event = envelope(seeded, deployment.id);

          stale.armed = true;
          const first = deliver(event);
          await stale.reached;
          second.armed = true;
          const redelivery = deliver(event);
          await second.reached;

          // Both hold the row in `building`; only the epoch tells them apart.
          const [claimed] = (await counts(seeded, deployment.id)).rows;
          expect(claimed).toMatchObject({ leaseEpoch: 2, state: 'building' });

          late = [];
          stale.release();
          await first;
          const writes = late;
          late = undefined;
          expect(writes).toEqual([{ method: 'markUploading', wrote: false }]);
          expect((await counts(seeded, deployment.id)).rows).toEqual([claimed]);

          second.release();
          await redelivery;

          const after = await counts(seeded, deployment.id);
          expect(after.rows).toHaveLength(1);
          expect(after.rows[0]).toMatchObject({ attempts: 2, leaseEpoch: 2, state: 'succeeded' });
          expect(after.sites).toEqual([
            expect.objectContaining({ currentDeploymentId: deployment.id }),
          ]);
          expect(after.events).toEqual(['deploy.succeeded']);
          expect(after.audits).toEqual(['deploy.succeeded']);
        },
        CASE_TIMEOUT_MS,
      );

      // ---- past the upload boundary: settled platform, never rebuilt ----

      it.each([
        {
          point: 'during the upload',
          arm: (stall: Stall) => (artifacts.beforeFirstPut = stall),
        },
        {
          point: 'after the upload',
          arm: (stall: Stall) => (artifacts.afterManifest = stall),
        },
      ])(
        'a worker stalled $point: the re-delivery settles platform, the stale go-live matches nothing',
        async ({ arm, point }) => {
          const seeded = await seed(world.alpha, `Dup ${point}`);
          const stall = new Stall();
          arm(stall);
          const runs = vi.spyOn(app.get(BuildRunner, { strict: false }), 'run');

          const { after, deployment, redelivered, writes } = await killAndRedeliver(
            seeded,
            stall,
            point,
          );

          expect(runs).toHaveBeenCalledTimes(1);
          expect(redelivered.rows).toHaveLength(1);
          expect(redelivered.rows[0]).toMatchObject({
            artifactSha: null,
            attempts: 1,
            failureReason: 'platform',
            id: deployment.id,
            leaseEpoch: 2,
            state: 'failed',
          });
          expect(redelivered.rows[0]!.uploadStartedAt).toBeInstanceOf(Date);
          expect(redelivered.sites).toEqual([]);
          expect(redelivered.events).toEqual(['deploy.failed']);
          expect(redelivered.audits).toEqual(['deploy.failed']);

          expect(writes).toEqual([{ method: 'succeed', wrote: false }]);
          expect(after).toEqual(redelivered);
        },
        CASE_TIMEOUT_MS,
      );

      it(
        'a worker killed before the go-live commit: nothing of its transaction lands, the re-delivery settles platform',
        async () => {
          const seeded = await seed(world.alpha, 'Dup before commit');
          const stall = new Stall();
          const sites = app.get(SiteRepository, { strict: false });
          const recorded = vi.mocked(sites).upsertOnGoLive.getMockImplementation()!;
          // Inside the go-live transaction, after the fenced `succeeded` flip, before the commit.
          vi.spyOn(sites, 'upsertOnGoLive').mockImplementation(async (...args) => {
            if (stall.armed) {
              await stall.park();
              throw new Error('the worker died before commit');
            }
            return recorded(...args);
          });

          fake.resetBuild();
          fake.buildArchive(siteArchive('before commit'));
          const deployment = await queue(seeded);
          const event = envelope(seeded, deployment.id);

          stall.armed = true;
          const stale = deliver(event);
          await stall.reached;

          // The re-delivery finds the row `uploading` and waits on the dying transaction's row lock.
          let redeliveredDone = false;
          const redelivery = deliver(event).then(() => (redeliveredDone = true));
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(redeliveredDone).toBe(false);

          late = [];
          stall.release();
          await redelivery;
          await stale;
          const writes = late;
          late = undefined;

          const after = await counts(seeded, deployment.id);
          expect(after.rows).toHaveLength(1);
          expect(after.rows[0]).toMatchObject({
            artifactSha: null,
            attempts: 1,
            failureReason: 'platform',
            leaseEpoch: 2,
            state: 'failed',
          });
          expect(after.sites).toEqual([]);
          expect(after.events).toEqual(['deploy.failed']);
          expect(after.audits).toEqual(['deploy.failed']);
          // The dying worker's own settle, on epoch 1, came after the re-delivery's.
          expect(writes).toEqual([{ method: 'fail', wrote: false }]);
        },
        CASE_TIMEOUT_MS,
      );
    },
  );
});

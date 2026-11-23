import { Test, type TestingModule } from '@nestjs/testing';
import { type Deployment, schema } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { AppModule } from '../../app.module';
import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import type { RepoBundler } from '../checkpoints/repo-bundler';
import { RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import {
  type BuildSandbox,
  BuildSandboxError,
  type BuildSandboxHandle,
} from '../sandbox/build-sandbox.service';
import type { ExecuteOutcome } from '../sandbox/daytona.adapter';
import { DaytonaError } from '../sandbox/sandbox.errors';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { manifestKey } from './artifact';
import { BuildDeployConsumer, type BuildDeployJob } from './build-deploy.consumer';
import { type BuildInput, type BuildOutcome, BuildRunner } from './build-runner';
import { ARTIFACT_STORE, BUILD_DEPLOY_QUEUE } from './deploy.constants';
import { DeploymentRepository } from './deployment.repository';
import { SiteRepository } from './site.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const SITE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Spec 027 US1 (T035): `BuildDeployConsumer` driven by hand against Postgres, as the pull consumer
 * spec drives `SyncConsumer` — `handle` on a transaction, then `effect` with none held. The build
 * itself is `BuildRunner`'s (its own spec, T034), so it is a stub here that can look at the row
 * while it "builds"; the artifacts bucket is a `MemoryObjectStore` that can look at the row before
 * its first PUT. Everything the go-live transaction does — the lock, the re-check, the fenced
 * flip, the pointer, the trail — is the real code on real rows.
 */
describe('BuildDeployConsumer', () => {
  it('declares the build.deploy queue on the agent profile (research R15)', () => {
    const declared = new (
      BuildDeployConsumer as unknown as new (...args: unknown[]) => BuildDeployConsumer
    )();

    expect(declared).toMatchObject({
      attempts: 3,
      concurrency: 4,
      maxStalledCount: 1,
      name: 'deploy-build',
      profile: 'agent',
      queue: BUILD_DEPLOY_QUEUE,
      types: ['deploy.requested'],
    });
    const deploymentId = randomUUID();
    expect(
      declared.jobId({
        payload: { deploymentId, orgId: randomUUID(), projectId: randomUUID() },
      } as Envelope<'deploy.requested'>),
    ).toBe(deploymentId);
  });

  describe.skipIf(!postgres || !redis)('against Postgres', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let consumer: BuildDeployConsumer;
    let repository: DeploymentRepository;
    let orgId: string;
    let userId: string;
    let strangerId: string;
    let projectId: string;
    let checkpointId: string;
    const store = new MemoryObjectStore();
    /** Re-spied per case: the config's `restoreMocks` detaches a spy made once. */
    let put: MockInstance<MemoryObjectStore['put']>;
    const run = vi.fn<(input: BuildInput) => Promise<BuildOutcome>>();
    const files = [
      { body: Buffer.from('<!doctype html><div id="root"></div>'), path: 'index.html' },
      { body: Buffer.from('console.log(1)'), path: 'assets/index-3f2a.js' },
    ];
    const built = (): Promise<BuildOutcome> =>
      Promise.resolve({ dropped: 0, files, kind: 'built', log: '$ npm ci\nok\n', totalBytes: 50 });

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    async function row(id: string): Promise<Deployment> {
      return (await inTenant((tx) => repository.byId(tx, orgId, projectId, id)))!;
    }

    function site() {
      return inTenant((tx) =>
        tx
          .select()
          .from(schema.projectSites)
          .where(eq(schema.projectSites.projectId, projectId))
          .then((rows) => rows[0]),
      );
    }

    function trail(deploymentId: string) {
      return inTenant(async (tx) => ({
        audits: await tx
          .select({
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            metadata: schema.auditLog.metadata,
          })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, deploymentId)),
        events: await database
          .select({ payload: schema.outbox.payload, type: schema.outbox.type })
          .from(schema.outbox)
          .where(eq(schema.outbox.aggregateId, deploymentId)),
      }));
    }

    async function queue(requestedBy = userId): Promise<Deployment> {
      return (await inTenant((tx) =>
        repository.insertQueued(tx, {
          checkpointId,
          orgId,
          projectId,
          requestedBy,
          template: 'vite-react',
        }),
      ))!;
    }

    function envelope(deploymentId: string): Envelope<'deploy.requested'> {
      return {
        aggregate: 'deployment',
        aggregateId: deploymentId,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId,
        payload: { deploymentId, orgId, projectId },
        traceId: null,
        type: 'deploy.requested',
      };
    }

    /** One delivery as the base runs it: `handle` on a transaction that commits, then `effect`. */
    async function deliver(
      event: Envelope<'deploy.requested'>,
      attempt = 1,
    ): Promise<BuildDeployJob> {
      const job = await database.transaction((tx) => consumer.handle(event, tx));
      await consumer.effect(event, job, attempt);
      return job;
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BuildRunner)
        .useValue({ run })
        .overrideProvider(ARTIFACT_STORE)
        .useValue(store)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      consumer = moduleRef.get(BuildDeployConsumer, { strict: false });
      repository = moduleRef.get(DeploymentRepository, { strict: false });

      const users = await database
        .insert(schema.users)
        .values([
          { email: `027c-${randomUUID()}@example.test`, passwordHash: 'x' },
          { email: `027c-${randomUUID()}@example.test`, passwordHash: 'x' },
        ])
        .returning({ id: schema.users.id });
      userId = users[0]!.id;
      // Never a member: the requester who has lost `project:deploy` by go-live.
      strangerId = users[1]!.id;

      const org = await moduleRef.get(OrgService).create(userId, {
        name: 'Build deploy consumer fixture',
        slug: `027c-${randomUUID().slice(0, 8)}`,
      });
      orgId = org.id;
    }, 60_000);

    afterAll(async () => {
      if (orgId !== undefined) await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      for (const id of [userId, strangerId]) {
        if (id !== undefined) await database.delete(schema.users).where(eq(schema.users.id, id));
      }
      await moduleRef?.close();
    });

    beforeEach(async () => {
      run.mockReset();
      put = vi.spyOn(store, 'put');
      store.objects.clear();

      const [workspace] = await inTenant((tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        moduleRef.get(ProjectService).create({
          actorId: userId,
          name: 'Marketing Site',
          orgId,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );
      projectId = project.id;

      const [checkpoint] = await inTenant((tx) =>
        tx
          .insert(schema.checkpoints)
          .values({
            files: [],
            gitSha: 'b'.repeat(40),
            kind: 'baseline',
            label: 'Baseline: workspace as found',
            orgId,
            projectId,
          })
          .returning({ id: schema.checkpoints.id }),
      );
      checkpointId = checkpoint!.id;
    });

    it('claims into building, marks uploading before the first PUT, then goes live', async () => {
      const deployment = await queue();
      const seen: { building?: Deployment; uploading?: Deployment } = {};
      run.mockImplementation(async (input) => {
        seen.building = await row(deployment.id);
        expect(input).toEqual({
          deploymentId: deployment.id,
          gitSha: 'b'.repeat(40),
          orgId,
          projectId,
          template: 'vite-react',
        });
        return built();
      });
      put.mockImplementationOnce(async (key, body, meta) => {
        seen.uploading ??= await row(deployment.id);
        return MemoryObjectStore.prototype.put.call(store, key, body, meta);
      });

      await deliver(envelope(deployment.id));

      expect(seen.building).toMatchObject({ attempts: 1, leaseEpoch: 1, state: 'building' });
      expect(seen.building?.startedAt).toBeInstanceOf(Date);
      expect(seen.building?.templateDigest).toEqual(expect.any(String));
      expect(seen.building?.templateSnapshot).toEqual(expect.any(String));
      expect(seen.uploading).toMatchObject({ leaseEpoch: 1, state: 'uploading' });
      expect(seen.uploading?.uploadStartedAt).toBeInstanceOf(Date);

      const done = await row(deployment.id);
      expect(done).toMatchObject({
        failureReason: null,
        fileCount: 2,
        logTail: '$ npm ci\nok\n',
        state: 'succeeded',
        totalBytes: 50,
      });
      expect(done.artifactSha).toMatch(/^[0-9a-f]{64}$/);
      expect(done.finishedAt).toBeInstanceOf(Date);
      expect(store.objects.has(manifestKey(orgId, projectId, done.artifactSha!))).toBe(true);

      const pointer = await site();
      expect(pointer).toMatchObject({
        currentDeploymentId: deployment.id,
        offlineAt: null,
      });
      expect(pointer!.siteLabel).toMatch(SITE_LABEL);
      expect(pointer!.siteLabel.startsWith('marketing-site-')).toBe(true);

      const { audits, events } = await trail(deployment.id);
      expect(audits).toEqual([
        {
          action: 'deploy.succeeded',
          actorId: null,
          metadata: { checkpointId, deploymentId: deployment.id, projectId },
        },
      ]);
      expect(events).toEqual([
        {
          payload: {
            deploymentId: deployment.id,
            orgId,
            projectId,
            siteLabel: pointer!.siteLabel,
          },
          type: 'deploy.succeeded',
        },
      ]);
    });

    it('keeps the stored site label on a later go-live and moves the pointer', async () => {
      const first = await queue();
      run.mockImplementation(built);
      await deliver(envelope(first.id));
      const label = (await site())!.siteLabel;

      const second = await queue();
      await deliver(envelope(second.id));

      expect(await site()).toMatchObject({ currentDeploymentId: second.id, siteLabel: label });
      expect((await row(second.id)).state).toBe('succeeded');
    });

    /** Takes the site offline as `SiteService.offline` does: `offline_at` only, pointer kept. */
    async function takeOffline(): Promise<Date> {
      const row = await inTenant((tx) =>
        new SiteRepository().setOffline(tx, { orgId, projectId, updatedBy: null }),
      );
      return row!.offlineAt!;
    }

    it('a deployment requested before the site went offline goes live but leaves it offline', async () => {
      const first = await queue();
      run.mockImplementation(built);
      await deliver(envelope(first.id));

      const second = await queue();
      const offlineAt = await takeOffline();
      await deliver(envelope(second.id));

      expect((await row(second.id)).state).toBe('succeeded');
      expect(await site()).toMatchObject({ currentDeploymentId: second.id, offlineAt });
    });

    it('a deployment requested after the site went offline brings it back online', async () => {
      const first = await queue();
      run.mockImplementation(built);
      await deliver(envelope(first.id));

      await takeOffline();
      const second = await queue();
      await deliver(envelope(second.id));

      expect((await row(second.id)).state).toBe('succeeded');
      expect(await site()).toMatchObject({ currentDeploymentId: second.id, offlineAt: null });
    });

    it('takes the project writer lock for go-live', async () => {
      const deployment = await queue();
      run.mockImplementation(built);
      const job = await database.transaction((tx) => consumer.handle(envelope(deployment.id), tx));

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = inTenant(async (tx) => {
        await moduleRef.get(CheckpointService).lockProject(tx, { orgId, projectId });
        locked();
        await held;
      });
      await lockTaken;

      const effect = consumer.effect(envelope(deployment.id), job, 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await row(deployment.id)).state).toBe('uploading');

      release();
      await holder;
      await effect;
      expect((await row(deployment.id)).state).toBe('succeeded');
    });

    it('fails not-authorised when the requester lost project:deploy, keeping the artifact and the pointer', async () => {
      run.mockImplementation(built);
      const live = await queue();
      await deliver(envelope(live.id));
      const before = await site();

      const deployment = await queue(strangerId);
      await deliver(envelope(deployment.id));

      const done = await row(deployment.id);
      expect(done).toMatchObject({
        artifactSha: null,
        failureReason: 'not-authorised',
        state: 'failed',
      });
      expect(done.finishedAt).toBeInstanceOf(Date);
      // The artifact stays in the bucket: a member with the permission can make it current later.
      expect([...store.objects.keys()].some((key) => key.endsWith('/manifest.json'))).toBe(true);
      expect(await site()).toEqual(before);

      const { audits, events } = await trail(deployment.id);
      expect(audits).toEqual([
        {
          action: 'deploy.failed',
          actorId: null,
          metadata: {
            checkpointId,
            deploymentId: deployment.id,
            projectId,
            reason: 'not-authorised',
          },
        },
      ]);
      expect(events).toEqual([
        {
          payload: { deploymentId: deployment.id, orgId, projectId, reason: 'not-authorised' },
          type: 'deploy.failed',
        },
      ]);
    });

    it('settles a build failure at once, with its log', async () => {
      const deployment = await queue();
      run.mockResolvedValue({
        kind: 'failed',
        log: 'npm ERR! missing script\n',
        reason: 'build-failed',
      });

      await deliver(envelope(deployment.id));

      expect(await row(deployment.id)).toMatchObject({
        failureReason: 'build-failed',
        logTail: 'npm ERR! missing script\n',
        state: 'failed',
        uploadStartedAt: null,
      });
      expect(put).not.toHaveBeenCalled();
      expect((await trail(deployment.id)).events).toEqual([
        {
          payload: { deploymentId: deployment.id, orgId, projectId, reason: 'build-failed' },
          type: 'deploy.failed',
        },
      ]);
    });

    it('retries a transient failure before upload, and settles platform on the last attempt', async () => {
      const deployment = await queue();
      run.mockRejectedValue(new RetryableFailure('timeout'));
      const event = envelope(deployment.id);

      await expect(deliver(event, 1)).rejects.toBeInstanceOf(RetryableFailure);
      expect((await row(deployment.id)).state).toBe('building');
      await expect(deliver(event, 2)).rejects.toBeInstanceOf(RetryableFailure);
      await deliver(event, 3);

      expect(await row(deployment.id)).toMatchObject({
        attempts: 3,
        failureReason: 'platform',
        leaseEpoch: 3,
        state: 'failed',
      });
    });

    it('settles a re-delivery past the upload boundary as platform, without building', async () => {
      const deployment = await queue();
      run.mockImplementation(built);
      put.mockRejectedValueOnce(new Error('bucket unreachable'));

      await deliver(envelope(deployment.id));
      // The upload failed after the boundary: surfaced, not retried.
      expect(await row(deployment.id)).toMatchObject({
        failureReason: 'platform',
        state: 'failed',
      });

      // A stalled job whose row is `uploading` comes back: settled, never rebuilt.
      const other = await queue();
      await inTenant(async (tx) => {
        const claimed = await repository.claim(tx, orgId, other.id, new Date());
        await repository.markUploading(tx, orgId, other.id, claimed!.leaseEpoch, new Date());
      });
      run.mockClear();

      const job = await deliver(envelope(other.id));

      expect(job).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      expect(await row(other.id)).toMatchObject({ failureReason: 'platform', state: 'failed' });
      expect((await trail(other.id)).events.map((event) => event.type)).toEqual(['deploy.failed']);
    });

    it('writes nothing once fenced out by a newer claim', async () => {
      const deployment = await queue();
      const event = envelope(deployment.id);
      run.mockImplementation(async () => {
        // A re-delivery claims the row while this worker is still building.
        await inTenant((tx) => repository.claim(tx, orgId, deployment.id, new Date()));
        return built();
      });

      await deliver(event);

      expect(await row(deployment.id)).toMatchObject({
        leaseEpoch: 2,
        state: 'building',
        uploadStartedAt: null,
      });
      expect(put).not.toHaveBeenCalled();
      expect(await site()).toBeUndefined();
      expect((await trail(deployment.id)).events).toEqual([]);
    });

    it('does nothing for a deployment that is already settled', async () => {
      const deployment = await queue();
      run.mockImplementation(built);
      await deliver(envelope(deployment.id));
      run.mockClear();

      expect(await deliver(envelope(deployment.id))).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      const events = await database
        .select({ type: schema.outbox.type })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.aggregateId, deployment.id),
            eq(schema.outbox.type, 'deploy.succeeded'),
          ),
        );
      expect(events).toHaveLength(1);
    });

    /**
     * `handle` throwing is terminal (the base dead-letters it on that attempt), and the claim
     * rolls back with it, so the row would sit `queued` holding the one in-flight slot. It is
     * settled `failed / platform` on the same transaction instead — including after a statement
     * that aborted it, which is why the claim runs in a savepoint.
     */
    it.each([
      [
        'the checkpoint read throws',
        () =>
          vi
            .spyOn(moduleRef.get(CheckpointService, { strict: false }), 'byId')
            .mockRejectedValueOnce(new Error('connection reset')),
      ],
      [
        'a statement aborts the transaction',
        () =>
          vi
            .spyOn(repository, 'recordToolchain')
            .mockImplementationOnce(async (tx) => tx.execute(sql`select 1 / 0`).then(() => true)),
      ],
    ])('settles the row as platform when %s inside handle', async (_label, fault) => {
      const deployment = await queue();
      fault();

      const job = await deliver(envelope(deployment.id));

      expect(job).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
      const done = await row(deployment.id);
      expect(done).toMatchObject({ failureReason: 'platform', state: 'failed' });
      expect(done.leaseEpoch).toBeGreaterThan(deployment.leaseEpoch);
      expect(done.finishedAt).toBeInstanceOf(Date);
      const { audits, events } = await trail(deployment.id);
      expect(audits.map((a) => a.action)).toEqual(['deploy.failed']);
      expect(events.map((e) => e.type)).toEqual(['deploy.failed']);
      expect(await inTenant((tx) => repository.inFlight(tx, orgId, projectId))).toBeUndefined();
    });

    it('writes nothing once fenced out between the upload and go-live', async () => {
      const deployment = await queue();
      run.mockImplementation(built);
      put.mockImplementationOnce(async (key, body, meta) => {
        // A cancel lands while the artifact is going up: go-live's fenced flip must miss.
        await inTenant((tx) => repository.cancelInFlight(tx, orgId, projectId, new Date()));
        return MemoryObjectStore.prototype.put.call(store, key, body, meta);
      });

      await deliver(envelope(deployment.id));

      expect(await row(deployment.id)).toMatchObject({ artifactSha: null, state: 'cancelled' });
      expect(await site()).toBeUndefined();
      expect(await trail(deployment.id)).toEqual({ audits: [], events: [] });
    });

    /**
     * T072 (spec 027 US4, FR-013, FR-015): the whole classification, with the real `BuildRunner`
     * over a scripted build sandbox and repo bundle — so a failing `npm ci` is a failing command,
     * not a stubbed verdict — and the consumer's own retry rule around it.
     */
    describe('classification', () => {
      const HANDLE: BuildSandboxHandle = { id: 'build-t072', snapshot: 'snap', workDir: '/w' };
      const S3_UNAVAILABLE = Object.assign(new Error('Service Unavailable'), {
        $metadata: { httpStatusCode: 503 },
        name: 'ServiceUnavailable',
      });
      const S3_UNREACHABLE = Object.assign(new Error('socket hang up'), {
        $metadata: {},
        name: 'TimeoutError',
      });
      /** Answers by command prefix; an unmatched command exits 0. */
      const answers = new Map<string, () => Promise<ExecuteOutcome>>();
      let archive: () => Promise<Buffer>;
      let bundle: () => Promise<{ body: Buffer; head: string }>;
      let create: () => Promise<BuildSandboxHandle>;
      let removed: number;
      let buildCommand: string;

      const exit = (exitCode: number, result: string) => () =>
        Promise.resolve<ExecuteOutcome>({ exitCode, result, timedOut: false });
      const siteTar = (): Buffer => {
        const header = Buffer.alloc(512);
        const put = (offset: number, value: string) => header.write(value, offset, 'utf8');
        put(0, 'index.html');
        put(100, '0000644\0');
        put(108, '0000000\0');
        put(116, '0000000\0');
        put(124, '00000000013\0');
        put(136, '00000000000\0');
        put(156, '0');
        put(257, 'ustar\0');
        put(263, '00');
        put(148, '        ');
        let sum = 0;
        for (const byte of header) sum += byte;
        put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
        const body = Buffer.alloc(512);
        body.write('<h1>hi</h1>', 0, 'utf8');
        return Buffer.concat([header, body, Buffer.alloc(1024)]);
      };

      beforeAll(() => {
        const sandbox: BuildSandbox = {
          create: () => create(),
          get: () => archive(),
          put: () => Promise.resolve(),
          remove: () => {
            removed += 1;
            return Promise.resolve();
          },
          run: (_handle, command) => {
            for (const [prefix, answer] of answers) {
              if (command.startsWith(prefix)) return answer();
            }
            return Promise.resolve({ exitCode: 0, result: '', timedOut: false });
          },
        };
        const bundler = { current: () => bundle() } as unknown as RepoBundler;
        const catalogue = moduleRef.get(TemplateCatalogue, { strict: false });
        buildCommand = catalogue.get('vite-react').manifest.build!.command;
        const runner = new BuildRunner(
          sandbox,
          bundler,
          transactions,
          catalogue,
          moduleRef.get<ClockPort>(CLOCK, { strict: false }),
        );
        realRun = (input) => runner.run(input);
      });

      let realRun: (input: BuildInput) => Promise<BuildOutcome>;

      beforeEach(() => {
        answers.clear();
        archive = () => Promise.resolve(siteTar());
        bundle = () => Promise.resolve({ body: Buffer.from('bundle'), head: 'b'.repeat(40) });
        create = () => Promise.resolve(HANDLE);
        removed = 0;
        run.mockImplementation((input) => realRun(input));
      });

      it('builds and goes live through the real runner when every command succeeds', async () => {
        const deployment = await queue();

        await deliver(envelope(deployment.id));

        expect(await row(deployment.id)).toMatchObject({ fileCount: 1, state: 'succeeded' });
        expect(removed).toBe(1);
      });

      it.each([
        {
          case: 'a non-zero npm ci',
          log: 'npm ERR! ERESOLVE could not resolve',
          reason: 'install-failed',
          script: () => answers.set('npm ci', exit(1, 'npm ERR! ERESOLVE could not resolve')),
        },
        {
          case: 'a non-zero build',
          log: 'error TS2304: Cannot find name',
          reason: 'build-failed',
          script: () => answers.set(buildCommand, exit(2, 'error TS2304: Cannot find name')),
        },
        {
          case: 'a missing output directory',
          log: 'tar: dist: Cannot open',
          reason: 'no-output',
          script: () => answers.set('tar ', exit(2, 'tar: dist: Cannot open')),
        },
        {
          case: 'an empty output',
          log: 'the build output has no files',
          reason: 'no-output',
          script: () => (archive = () => Promise.resolve(Buffer.alloc(1024))),
        },
        {
          case: 'an output over the caps',
          log: 'output archive refused',
          reason: 'output-too-large',
          script: () =>
            (archive = () => Promise.reject(new BuildSandboxError('too-large', 'over the cap'))),
        },
        {
          case: 'the 15-minute abort',
          log: 'timed out',
          reason: 'timeout',
          script: () =>
            answers.set(buildCommand, () => Promise.resolve<ExecuteOutcome>({ timedOut: true })),
        },
      ])('settles $case as $reason at once, never retried', async (row_) => {
        const deployment = await queue();
        row_.script();

        await expect(deliver(envelope(deployment.id), 1)).resolves.toBeDefined();

        const done = await row(deployment.id);
        expect(done).toMatchObject({
          attempts: 1,
          failureReason: row_.reason,
          state: 'failed',
          uploadStartedAt: null,
        });
        expect(done.logTail).toContain(row_.log);
        expect(run).toHaveBeenCalledTimes(1);
        expect(put).not.toHaveBeenCalled();
        expect(removed).toBe(1);
        expect((await trail(deployment.id)).events).toEqual([
          {
            payload: { deploymentId: deployment.id, orgId, projectId, reason: row_.reason },
            type: 'deploy.failed',
          },
        ]);
      });

      it.each([
        {
          case: 'a provider 5xx',
          fault: () =>
            answers.set('npm ci', () =>
              Promise.reject(new DaytonaError('upstream', 'Daytona answered 503', 503)),
            ),
          reason: 'upstream-5xx',
        },
        {
          case: 'a provider 429',
          fault: () =>
            answers.set('npm ci', () =>
              Promise.reject(new DaytonaError('upstream', 'Daytona answered 429', 429)),
            ),
          reason: 'throttled',
        },
        {
          case: 'a provider timeout',
          fault: () =>
            answers.set('npm ci', () =>
              Promise.reject(new DaytonaError('unreachable', 'Daytona did not answer')),
            ),
          reason: 'timeout',
        },
        {
          case: 'a build sandbox that never started',
          fault: () => {
            create = () => Promise.reject(new BuildSandboxError('not-started', 'never started'));
          },
          reason: 'timeout',
        },
        {
          case: 'an unavailable object store',
          fault: () => {
            bundle = () => Promise.reject(S3_UNAVAILABLE);
          },
          reason: 'upstream-5xx',
        },
        {
          case: 'an unreachable object store',
          fault: () => {
            bundle = () => Promise.reject(S3_UNREACHABLE);
          },
          reason: 'timeout',
        },
      ])(
        'retries $case before upload, then settles platform on the last attempt',
        async ({ fault, reason }) => {
          const deployment = await queue();
          fault();
          const event = envelope(deployment.id);

          for (const attempt of [1, 2]) {
            const thrown = await deliver(event, attempt).catch((error: unknown) => error);
            expect(thrown).toBeInstanceOf(RetryableFailure);
            expect((thrown as RetryableFailure).reason).toBe(reason);
            expect(await row(deployment.id)).toMatchObject({
              attempts: attempt,
              state: 'building',
            });
          }
          await expect(deliver(event, 3)).resolves.toBeDefined();

          expect(await row(deployment.id)).toMatchObject({
            attempts: 3,
            failureReason: 'platform',
            state: 'failed',
            uploadStartedAt: null,
          });
          expect(put).not.toHaveBeenCalled();
          expect((await trail(deployment.id)).events.map((e) => e.type)).toEqual(['deploy.failed']);
        },
      );

      it('settles a bundle fault that no retry fixes as platform on the first attempt', async () => {
        const deployment = await queue();
        bundle = () =>
          Promise.reject(
            Object.assign(new Error('Access Denied'), { $metadata: { httpStatusCode: 403 } }),
          );

        await deliver(envelope(deployment.id), 1);

        expect(await row(deployment.id)).toMatchObject({
          attempts: 1,
          failureReason: 'platform',
          state: 'failed',
        });
      });

      it.each([
        ['an unavailable object store', () => S3_UNAVAILABLE],
        ['a retryable failure', () => new RetryableFailure('timeout')],
      ])('settles %s during upload as platform, not thrown as retryable', async (_label, error) => {
        const deployment = await queue();
        put.mockRejectedValueOnce(error());

        await expect(deliver(envelope(deployment.id), 1)).resolves.toBeDefined();

        const done = await row(deployment.id);
        expect(done).toMatchObject({ failureReason: 'platform', state: 'failed' });
        expect(done.uploadStartedAt).toBeInstanceOf(Date);
        // Which failure it was, by class name: the deploy log says why, never a credential.
        expect(done.logTail).toMatch(/upload failed: (ServiceUnavailable|RetryableFailure)\n$/u);
        expect(await site()).toBeUndefined();
      });

      it.each([
        ['an error', () => new Error('connection reset')],
        ['a retryable failure', () => new RetryableFailure('upstream-5xx')],
      ])(
        'settles %s at go-live as platform, keeping the pointer, not thrown as retryable',
        async (_label, error) => {
          const live = await queue();
          await deliver(envelope(live.id));
          const before = await site();

          const deployment = await queue();
          const sites = moduleRef.get(SiteRepository, { strict: false });
          vi.spyOn(sites, 'upsertOnGoLive').mockRejectedValueOnce(error());

          await expect(deliver(envelope(deployment.id), 1)).resolves.toBeDefined();

          const done = await row(deployment.id);
          expect(done).toMatchObject({ failureReason: 'platform', state: 'failed' });
          expect(done.uploadStartedAt).toBeInstanceOf(Date);
          expect(await site()).toEqual(before);
          const { audits, events } = await trail(deployment.id);
          expect(audits.map((a) => a.action)).toEqual(['deploy.failed']);
          expect(events.map((e) => e.type)).toEqual(['deploy.failed']);
        },
      );

      it('increments attempts on every claim', async () => {
        const deployment = await queue();
        answers.set('npm ci', () => Promise.reject(new DaytonaError('upstream', '502', 502)));
        const event = envelope(deployment.id);
        const seen: number[] = [];
        run.mockImplementation(async (input) => {
          seen.push((await row(deployment.id)).attempts);
          return realRun(input);
        });

        await deliver(event, 1).catch(() => undefined);
        await deliver(event, 2).catch(() => undefined);
        await deliver(event, 3);

        expect(seen).toEqual([1, 2, 3]);
        expect(await row(deployment.id)).toMatchObject({ attempts: 3, leaseEpoch: 3 });
      });
    });
  });
});

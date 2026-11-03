import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  type Deployment,
  deploymentListResponseSchema,
  deploymentResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type ProjectTemplate,
  siteResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, gt } from 'drizzle-orm';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import type { Environment } from '../src/config/environment';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { mirrorKey } from '../src/modules/checkpoints/repo-bundler';
import { BuildDeployConsumer } from '../src/modules/deploy/build-deploy.consumer';
import { BUILD_BUNDLE_PATH } from '../src/modules/deploy/build-runner';
import { ARTIFACT_STORE } from '../src/modules/deploy/deploy.constants';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { ConsumerBase } from '../src/modules/outbox/consumer-base';
import type { Envelope } from '../src/modules/outbox/envelope';
import { BrokerListener, PlainBrokerTransport } from '../src/modules/preview/broker-listener';
import { BROKER_TRANSPORT } from '../src/modules/preview/preview.constants';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Tenant,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import (as `checkpoints.e2e-spec.ts`): the relay and the build worker run in-process. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `events` relays the outbox; `agent` drains `build.deploy`. No `cron`: no sweep or reconciler
  // runs behind the cases' backs.
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.BROKER_TRANSPORT = 'plain';
  process.env.BROKER_SHARED_SECRET = 'e2e-broker-secret';
  process.env.PREVIEW_DOMAIN = 'forge-preview.localhost';
  process.env.SITE_DOMAIN = 'forge-site.localhost';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const SECRET = 'e2e-broker-secret';
const SITE_DOMAIN = 'forge-site.localhost';
const TEMPLATE: ProjectTemplate = 'vite-react';
const SNAPSHOT = 'forge-tpl-vite-react-deploy-e2e';
const BUCKET = 'forge-artifacts-e2e';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const DEPLOY_TIMEOUT_MS = 20_000;
const GATEWAY_DIR = join(__dirname, '../../gateway');

// ---- the build's output: a minimal ustar writer (tar-reader.spec.ts covers the format) ----

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function member(name: string, body: string, type = '0'): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  const block = Buffer.alloc(BLOCK);
  const put = (offset: number, value: string): void => {
    Buffer.from(value, 'utf8').copy(block, offset);
  };
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(type === '0' ? bytes.length : 0, 12));
  put(136, octal(0, 12));
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  put(148, '        ');
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, octal(sum, 7) + ' ');
  if (type !== '0') return block;
  const rest = bytes.length % BLOCK;
  return Buffer.concat([block, bytes, Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)]);
}

/** A built site: `index.html` referencing one asset, as a Vite build leaves `dist/`. */
function siteArchive(heading: string, asset: string): { archive: Buffer; index: string } {
  const index = `<!doctype html><h1>${heading}</h1><script src="/assets/${asset}"></script>`;
  const archive = Buffer.concat([
    member('./', '', '5'),
    member('./index.html', index),
    member('./assets/', '', '5'),
    member(`./assets/${asset}`, `console.log(${JSON.stringify(heading)});`),
    Buffer.alloc(BLOCK * 2),
  ]);
  return { archive, index };
}

// ---- doubles ----

/**
 * The repos bucket: the project's mirror is what the bundler reads first (`RepoBundler.current`),
 * so a seeded mirror whose `head` is the checkpoint's sha means no project sandbox is needed to
 * build. `hold()` parks the next mirror read until `release()` — a build held in `building`.
 */
class GatedObjectStore extends MemoryObjectStore {
  private gate: Promise<void> | undefined;
  private open: () => void = () => undefined;

  hold(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.gate = undefined;
    this.open();
  }

  override async get(key: string) {
    await this.gate;
    return super.get(key);
  }
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** A project the suite made, with one baseline checkpoint and its mirror. */
interface Seeded {
  readonly checkpointId: string;
  readonly gitSha: string;
  readonly orgId: string;
  readonly owner: Tenant['owner'];
  readonly projectId: string;
}

/**
 * Spec 027 over the real API, Postgres, the queue and stream Redis roles and the in-process relay
 * and `build.deploy` worker; the build sandbox is the fake Daytona's (T041), the repos and
 * artifacts buckets are `MemoryObjectStore`s, and the site is served by the **real gateway**
 * (`apps/gateway/src/main.ts`, spawned as its own process as `pnpm dev:gateway` runs it — an app may
 * not import another) against this API's broker listener and a plain loopback S3 over the
 * artifacts store. SigV4 and the serving rules are `apps/gateway/test/site-serving.e2e-spec.ts`'s
 * proof; this suite proves the whole path from a request to bytes on a site host.
 *
 * Each section makes its own project, so a section can be added (T060's rollback, T090's offline
 * and archive) without touching the others' state.
 */
describe('Deploys (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue, a fake Daytona, in-memory buckets and the gateway',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      /** The app role: the outbox and the template versions (platform tables). */
      let db: ForgeDatabase;
      let suiteLock: { release: () => Promise<void> } | undefined;
      let gateway: ChildProcess | undefined;
      let gatewayPort: number;
      let s3: Server | undefined;
      const repos = new GatedObjectStore();
      const artifacts = new MemoryObjectStore();
      /** Every key the loopback S3 was asked for, in order. */
      const s3Reads: string[] = [];

      // ---- helpers ----

      const deploymentsPath = (ref: { orgId: string; projectId: string }) =>
        `${ORGS}/${ref.orgId}/projects/${ref.projectId}/deployments`;

      function requestDeploy(
        ref: { orgId: string; projectId: string },
        cookie: string,
        key: string | null = randomUUID(),
        body: Record<string, unknown> = {},
      ) {
        const test = unsafe(http(app).post(deploymentsPath(ref)), [cookie]);
        return (key === null ? test : test.set(IDEMPOTENCY_KEY_HEADER, key)).send(body);
      }

      async function readDeployment(
        ref: { orgId: string; projectId: string },
        cookie: string,
        id: string,
      ): Promise<Deployment> {
        const response = await http(app)
          .get(`${deploymentsPath(ref)}/${id}`)
          .set('Cookie', cookie)
          .expect(200);
        return deploymentResponseSchema.parse(response.body).deployment;
      }

      /** Polls the read route until the deployment is terminal. */
      async function settled(seeded: Seeded, id: string): Promise<Deployment> {
        let last: Deployment | undefined;
        const done = await until(async () => {
          last = await readDeployment(seeded, seeded.owner.cookie, id);
          return ['succeeded', 'failed', 'cancelled'].includes(last.state);
        }, DEPLOY_TIMEOUT_MS);
        if (!done) throw new Error(`deployment ${id} is still ${last?.state ?? '?'}`);
        return last!;
      }

      /** Request and wait: the product's own path, to `succeeded`. */
      async function deployLive(seeded: Seeded): Promise<Deployment> {
        const response = await requestDeploy(seeded, seeded.owner.cookie).expect(202);
        const { deployment } = deploymentResponseSchema.parse(response.body);
        const done = await settled(seeded, deployment.id);
        expect(done.state).toBe('succeeded');
        return done;
      }

      /**
       * A project of `tenant`'s, created the product's way, with one baseline checkpoint and a
       * mirror of it in the repos bucket (so the bundler reads the mirror, never a sandbox).
       */
      async function seedProject(
        tenant: Tenant,
        name: string,
        template: ProjectTemplate = TEMPLATE,
      ): Promise<Seeded> {
        const { orgId, owner, workspaceId } = tenant;
        const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app.get(ProjectService).create({
            actorId: owner.userId,
            name,
            orgId,
            ownerId: owner.userId,
            template,
            workspaceId,
          }),
        );
        const gitSha = randomBytes(20).toString('hex');
        const [checkpoint] = await transactions.runInTenantTransaction(orgId, (tx) =>
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
        return { checkpointId: checkpoint!.id, gitSha, orgId, owner, projectId: project.id };
      }

      async function siteLabelOf(seeded: Seeded): Promise<string> {
        const [row] = await inTenant(seeded.orgId, (tx) =>
          tx
            .select({ label: schema.projectSites.siteLabel })
            .from(schema.projectSites)
            .where(eq(schema.projectSites.projectId, seeded.projectId)),
        );
        return row?.label ?? expect.unreachable('no project_sites row');
      }

      /** Tenant-owned rows are read the way the product reads them: under the org's RLS scope. */
      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      function deploymentRows(ref: { orgId: string; projectId: string }) {
        return inTenant(ref.orgId, (tx) =>
          tx
            .select()
            .from(schema.deployments)
            .where(eq(schema.deployments.projectId, ref.projectId)),
        );
      }

      function outboxRows(type: string, aggregateId?: string) {
        return db
          .select()
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, type),
              aggregateId === undefined ? undefined : eq(schema.outbox.aggregateId, aggregateId),
            ),
          );
      }

      function auditRows(orgId: string, action: string, target: string) {
        return inTenant(orgId, (tx) =>
          tx
            .select()
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.orgId, orgId),
                eq(schema.auditLog.action, action),
                eq(schema.auditLog.target, target),
              ),
            ),
        );
      }

      /** A GET to the gateway as a browser on `<label>.<SITE_DOMAIN>` sends it. */
      function fromSite(
        label: string,
        path: string,
      ): Promise<{ body: string; headers: Record<string, unknown>; status: number }> {
        return new Promise((resolve, reject) => {
          const outgoing = httpRequest(
            {
              headers: { host: `${label}.${SITE_DOMAIN}` },
              host: '127.0.0.1',
              method: 'GET',
              path,
              port: gatewayPort,
            },
            (incoming) => {
              const chunks: Buffer[] = [];
              incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
              incoming.on('end', () =>
                resolve({
                  body: Buffer.concat(chunks).toString('utf8'),
                  headers: incoming.headers,
                  status: incoming.statusCode ?? 0,
                }),
              );
              incoming.on('error', reject);
            },
          );
          outgoing.on('error', reject);
          outgoing.end();
        });
      }

      /** `PUT …/site` as the project's owner. */
      function putSite(seeded: Seeded, body: Record<string, unknown>) {
        return unsafe(http(app).put(`${ORGS}/${seeded.orgId}/projects/${seeded.projectId}/site`), [
          seeded.owner.cookie,
        ]).send(body);
      }

      /** SC-003/SC-010's bound: the site host answers `status` (and `body`) within 10 s. */
      async function servesWithin(
        label: string,
        path: string,
        status: number,
        body?: string,
      ): Promise<void> {
        let last: { body: string; status: number } | undefined;
        const seen = await until(async () => {
          last = await fromSite(label, path);
          return last.status === status && (body === undefined || last.body === body);
        }, 10_000);
        expect(seen, `${label}${path} answered ${String(last?.status)} ${last?.body ?? ''}`).toBe(
          true,
        );
      }

      function buildJobs(seeded: Seeded) {
        return db
          .select({ id: schema.outbox.id })
          .from(schema.outbox)
          .where(
            and(
              eq(schema.outbox.type, 'deploy.requested'),
              eq(schema.outbox.originOrgId, seeded.orgId),
            ),
          );
      }

      /** A plain loopback S3 (path-style GET) over the artifacts store the worker uploads to. */
      async function startLoopbackS3(): Promise<number> {
        s3 = createServer((req, res) => {
          const prefix = `/${BUCKET}/`;
          const path = decodeURIComponent(new URL(req.url ?? '/', 'http://s3').pathname);
          const key = path.startsWith(prefix) ? path.slice(prefix.length) : '';
          s3Reads.push(key);
          const object = artifacts.objects.get(key);
          if (req.method !== 'GET' || object === undefined) {
            res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error/>');
            return;
          }
          res
            .writeHead(200, {
              'content-length': String(object.body.length),
              'content-type': 'application/octet-stream',
            })
            .end(object.body);
        });
        return new Promise((resolve) =>
          s3!.listen(0, '127.0.0.1', () => resolve((s3!.address() as AddressInfo).port)),
        );
      }

      /** `node src/main.ts` in apps/gateway, as `pnpm dev:gateway` runs it; resolves once listening. */
      async function startGateway(brokerPort: number, s3Port: number): Promise<void> {
        const config = app.get<ConfigService<Environment, true>>(ConfigService);
        // A port the kernel just handed out and took back: free, barring a race in the gap.
        gatewayPort = await new Promise<number>((resolve) => {
          const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as AddressInfo;
            probe.close(() => resolve(port));
          });
        });
        gateway = spawn(process.execPath, ['src/main.ts'], {
          cwd: GATEWAY_DIR,
          env: {
            ARTIFACT_STORE_ACCESS_KEY_ID: 'AKIDDEPLOYE2E',
            ARTIFACT_STORE_BUCKET: BUCKET,
            ARTIFACT_STORE_ENDPOINT: `http://127.0.0.1:${String(s3Port)}`,
            ARTIFACT_STORE_SECRET_ACCESS_KEY: 'deploy-e2e-read-only',
            BROKER_HOST: '127.0.0.1',
            BROKER_PORT: String(brokerPort),
            BROKER_SHARED_SECRET: SECRET,
            BROKER_TRANSPORT: 'plain',
            DEPLOY_ENV: 'local',
            PATH: process.env.PATH,
            PORT: String(gatewayPort),
            PREVIEW_DOMAIN: 'forge-preview.localhost',
            PREVIEW_PUBLIC_JWKS: JSON.stringify(config.get('PREVIEW_PUBLIC_JWKS', { infer: true })),
            // Short, so a pointer change is seen by the next request rather than in 5 s.
            ROUTE_CACHE_TTL_MS: '50',
            SITE_DOMAIN,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`the gateway did not start:\n${output}`)),
            30_000,
          );
          const onData = (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (output.includes('gateway listening')) {
              clearTimeout(timer);
              resolve();
            }
          };
          gateway!.stdout!.on('data', onData);
          gateway!.stderr!.on('data', onData);
          gateway!.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`the gateway exited ${String(code)}:\n${output}`));
          });
        });
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(DAYTONA_TIMINGS)
          .useValue({ ...DEFAULT_DAYTONA_TIMINGS, lookupTtlMs: 0 })
          .overrideProvider(BROKER_TRANSPORT)
          .useValue(new PlainBrokerTransport({ port: 0, secret: SECRET }, 'local'))
          .overrideProvider(OBJECT_STORE)
          .useValue(repos)
          .overrideProvider(ARTIFACT_STORE)
          .useValue(artifacts)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
        await app.get(BrokerListener).listen();

        transactions = app.get(TenantTransactionRunner);
        db = app.get<ForgeDatabase>(APP_DATABASE);
        // The build sandbox starts from the template's current version (T033).
        await publishFakeVersion(db, TEMPLATE, SNAPSHOT);
        world = await createTwoTenantWorld(app);

        await startGateway(app.get(BrokerListener).port!, await startLoopbackS3());
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        gateway?.kill('SIGTERM');
        await new Promise<void>((resolve) =>
          s3 === undefined ? resolve() : s3.close(() => resolve()),
        );
        if (world) await destroyTwoTenantWorld(app, world);
        if (db) await dropFakeVersions(db, TEMPLATE);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      // ---- US1 (T040, T100's e2e half) ----

      describe('deploys a checkpoint and serves it', () => {
        let seeded: Seeded;
        let deployment: Deployment;
        const site = siteArchive('Hello from A', 'app-a1.js');

        beforeAll(async () => {
          seeded = await seedProject(world.alpha, 'Deploy Me');
        });

        it(
          'a request with an idempotency key goes through the queue to succeeded, once for ten replays (SC-004)',
          async () => {
            fake.resetBuild();
            fake.buildArchive(site.archive);
            fake.requests.length = 0;
            const key = randomUUID();

            // Held in `building` at the bundler, so the replays and the second key meet it in flight.
            repos.hold();
            const replies = await Promise.all(
              Array.from({ length: 10 }, () =>
                requestDeploy(seeded, seeded.owner.cookie, key, {
                  checkpointId: seeded.checkpointId,
                }),
              ),
            );
            expect(replies.map((reply) => reply.status)).toEqual(Array(10).fill(202));
            const bodies = replies.map((reply) => deploymentResponseSchema.parse(reply.body));
            deployment = bodies[0]!.deployment;
            expect(new Set(bodies.map((body) => body.deployment.id)).size).toBe(1);
            expect(deployment).toMatchObject({
              checkpointId: seeded.checkpointId,
              current: false,
              failureReason: null,
              requestedBy: seeded.owner.userId,
              state: 'queued',
            });

            // A second key while one is in flight: refused, naming the one to follow (FR-004).
            const second = await requestDeploy(seeded, seeded.owner.cookie).expect(409);
            expect(second.body).toMatchObject({
              deploymentId: deployment.id,
              reason: 'deploy-active',
            });

            repos.release();
            const done = await settled(seeded, deployment.id);
            expect(done).toMatchObject({
              attempts: 1,
              current: true,
              failureReason: null,
              fileCount: 2,
              id: deployment.id,
              state: 'succeeded',
              totalBytes: expect.any(Number) as number,
            });
            expect(done.artifactSha).toMatch(/^[0-9a-f]{64}$/);
            deployment = done;

            // One row, one build (SC-004).
            const rows = await deploymentRows(seeded);
            expect(rows.map((row) => row.id)).toEqual([deployment.id]);
            expect(fake.builds).toHaveLength(1);
            expect(fake.builds[0]).toMatchObject({
              labels: { 'forge.deployment': deployment.id, 'forge.kind': 'build' },
              removed: true,
            });

            const list = deploymentListResponseSchema.parse(
              (
                await http(app)
                  .get(deploymentsPath(seeded))
                  .set('Cookie', seeded.owner.cookie)
                  .expect(200)
              ).body,
            );
            expect(list).toEqual({ items: [deployment], nextCursor: null });
          },
          DEPLOY_TIMEOUT_MS + 10_000,
        );

        it('leaves one event and one audit row per step, and a site URL', async () => {
          const label = await siteLabelOf(seeded);
          expect(label).toMatch(/^deploy-me-[a-z2-7]{8}$/);
          const site = await http(app)
            .get(`${ORGS}/${seeded.orgId}/projects/${seeded.projectId}/site`)
            .set('Cookie', seeded.owner.cookie)
            .expect(200);
          expect(siteResponseSchema.parse(site.body)).toEqual({
            site: {
              currentDeploymentId: deployment.id,
              deployable: true,
              offline: false,
              url: `https://${label}.${SITE_DOMAIN}`,
            },
          });

          expect(await outboxRows('deploy.requested', deployment.id)).toEqual([
            expect.objectContaining({
              originOrgId: seeded.orgId,
              payload: {
                deploymentId: deployment.id,
                orgId: seeded.orgId,
                projectId: seeded.projectId,
              },
            }),
          ]);
          expect(await outboxRows('deploy.succeeded', deployment.id)).toEqual([
            expect.objectContaining({
              payload: {
                deploymentId: deployment.id,
                orgId: seeded.orgId,
                projectId: seeded.projectId,
                siteLabel: label,
              },
            }),
          ]);
          expect(await outboxRows('deploy.failed', deployment.id)).toEqual([]);

          expect(await auditRows(seeded.orgId, 'deploy.requested', deployment.id)).toEqual([
            expect.objectContaining({
              actorId: seeded.owner.userId,
              metadata: { checkpointId: seeded.checkpointId, projectId: seeded.projectId },
            }),
          ]);
          expect(await auditRows(seeded.orgId, 'deploy.succeeded', deployment.id)).toHaveLength(1);

          const log = await http(app)
            .get(`${deploymentsPath(seeded)}/${deployment.id}/log`)
            .set('Cookie', seeded.owner.cookie)
            .expect(200);
          expect(log.body).toMatchObject({ truncated: false });
          expect((log.body as { log: string }).log).toContain('$ npm ci');
        });

        it('the gateway serves the site from the artifacts bucket, no cookie needed', async () => {
          const label = await siteLabelOf(seeded);

          const index = await fromSite(label, '/');
          expect(index.status).toBe(200);
          expect(index.body).toBe(site.index);
          expect(index.headers['content-type']).toMatch(/^text\/html/);
          expect(index.headers['set-cookie']).toBeUndefined();

          const asset = await fromSite(label, '/assets/app-a1.js');
          expect(asset.status).toBe(200);
          expect(asset.body).toBe('console.log("Hello from A");');

          // Read from the artifact the row names, under this tenant's prefix.
          expect(s3Reads).toContain(
            `${seeded.orgId}/${seeded.projectId}/${deployment.artifactSha!}/manifest.json`,
          );

          const unknown = await fromSite(`nothing-here-${randomBytes(4).toString('hex')}`, '/');
          expect(unknown.status).toBe(404);
        });

        /**
         * SC-012, the e2e half (T100): what reached the build sandbox, from the fake's recording of
         * the whole deploy above. The create body carries no env; every execute carries `LC_ALL`
         * and nothing else; the one upload is the checkpoint's bundle, byte for byte.
         */
        it('passes nothing beyond LC_ALL into the build sandbox and uploads only the bundle (SC-012)', () => {
          const build = fake.builds[0]!;
          const creates = fake.requests.filter(
            (r) => r.method === 'POST' && r.path === '/api/sandbox',
          );
          expect(creates).toHaveLength(1);
          expect(JSON.parse(creates[0]!.body)).toEqual({
            autoArchiveInterval: 0,
            autoStopInterval: 0,
            labels: {
              'forge.deployment': deployment.id,
              'forge.kind': 'build',
              'forge.owner': expect.any(String) as string,
              'forge.template': TEMPLATE,
            },
            snapshot: SNAPSHOT,
          });

          const toBuild = fake.requests.filter((r) => r.path.startsWith(`/toolbox/${build.id}/`));
          const executes = toBuild.filter((r) => r.path.endsWith('/process/execute'));
          expect(executes.length).toBe(build.commands.length);
          expect(build.commands).toEqual([
            'git init -q',
            `git fetch -q ${BUILD_BUNDLE_PATH} ${seeded.gitSha}`,
            `git checkout -q -f --detach ${seeded.gitSha}`,
            'git clean -q -f -d -x',
            'npm ci',
            expect.any(String) as string,
            expect.stringMatching(/^tar -cf \/tmp\/forge-out\.tar -C \S+ \.$/) as string,
          ]);
          for (const execute of executes) {
            const body = JSON.parse(execute.body) as Record<string, unknown>;
            expect(Object.keys(body).sort()).toEqual(['command', 'cwd', 'envs', 'timeout']);
            expect(body.envs).toEqual({ LC_ALL: 'C' });
          }

          const uploads = toBuild.filter((r) => r.path.endsWith('/files/upload'));
          expect(uploads.map((r) => r.query.path)).toEqual([
            `${fake.workDir}/${BUILD_BUNDLE_PATH}`,
          ]);
          expect(uploads[0]!.body).toContain(`bundle of ${seeded.gitSha}`);
          // Nothing else was written into it: every other call is a read, an exec or the remove.
          expect(
            toBuild
              .filter((r) => r.method !== 'GET')
              .every(
                (r) => r.path.endsWith('/process/execute') || r.path.endsWith('/files/upload'),
              ),
          ).toBe(true);
        });

        it('refuses a template without a build as not-deployable, writing nothing', async () => {
          const api = await seedProject(world.alpha, 'An API', 'node-api');
          const refused = await requestDeploy(api, api.owner.cookie).expect(409);
          expect(refused.body).toMatchObject({ reason: 'not-deployable' });
          expect(await deploymentRows(api)).toEqual([]);
        });

        it("answers 404 for another project's checkpoint, writing nothing", async () => {
          const other = await seedProject(world.alpha, 'Another One');
          const refused = await requestDeploy(other, other.owner.cookie, randomUUID(), {
            checkpointId: seeded.checkpointId,
          }).expect(404);
          expect(JSON.stringify(refused.body)).not.toContain(seeded.checkpointId);
          expect(await deploymentRows(other)).toEqual([]);
        });

        it('refuses a request without an idempotency key', async () => {
          const refused = await requestDeploy(seeded, seeded.owner.cookie, null).expect(422);
          expect(JSON.stringify(refused.body)).toContain('idempotency_key_required');
        });
      });

      // ---- US2 (T060) ----

      describe('rolls back and forward without a build', () => {
        let label: string;

        it(
          "switches between A and B with no build, serving each one's entry page (SC-003)",
          async () => {
            const seeded = await seedProject(world.alpha, 'Roll Back');
            const siteA = siteArchive('Release A', 'only-in-a.js');
            const siteB = siteArchive('Release B', 'only-in-b.js');

            fake.resetBuild();
            fake.buildArchive(siteA.archive);
            const a = await deployLive(seeded);
            fake.buildArchive(siteB.archive);
            const b = await deployLive(seeded);
            label = await siteLabelOf(seeded);
            await servesWithin(label, '/', 200, siteB.index);

            const builds = fake.builds.length;
            const jobs = (await buildJobs(seeded)).length;
            expect(builds).toBe(2);

            const currentOnList = async () => {
              const list = deploymentListResponseSchema.parse(
                (
                  await http(app)
                    .get(deploymentsPath(seeded))
                    .set('Cookie', seeded.owner.cookie)
                    .expect(200)
                ).body,
              );
              return Object.fromEntries(list.items.map((item) => [item.id, item.current]));
            };
            /**
             * Both releases' hashed assets resolve whichever is current (FR-025): the current one
             * through its manifest, the other through the project's asset index.
             */
            const bothAssetsResolve = async () => {
              for (const path of ['/assets/only-in-a.js', '/assets/only-in-b.js']) {
                const res = await fromSite(label, path);
                expect(res.status, path).toBe(200);
                expect(res.headers['cache-control'], path).toBe(
                  'public, max-age=31536000, immutable',
                );
              }
            };

            expect(await currentOnList()).toEqual({ [a.id]: false, [b.id]: true });
            await bothAssetsResolve();

            // Roll back to A.
            const back = await putSite(seeded, { action: 'release', deploymentId: a.id }).expect(
              200,
            );
            expect(siteResponseSchema.parse(back.body).site).toMatchObject({
              currentDeploymentId: a.id,
              offline: false,
            });
            await servesWithin(label, '/', 200, siteA.index);
            expect(await currentOnList()).toEqual({ [a.id]: true, [b.id]: false });
            await bothAssetsResolve();

            // Roll forward to B: the same switch the other way.
            await putSite(seeded, { action: 'release', deploymentId: b.id }).expect(200);
            await servesWithin(label, '/', 200, siteB.index);
            expect(await currentOnList()).toEqual({ [a.id]: false, [b.id]: true });
            await bothAssetsResolve();

            // No build and no build job for either switch; one audit row and one event each.
            expect(fake.builds).toHaveLength(builds);
            expect(await buildJobs(seeded)).toHaveLength(jobs);
            const released = await inTenant(seeded.orgId, (tx) =>
              tx
                .select({ actorId: schema.auditLog.actorId, metadata: schema.auditLog.metadata })
                .from(schema.auditLog)
                .where(
                  and(
                    eq(schema.auditLog.action, 'site.released'),
                    eq(schema.auditLog.target, seeded.projectId),
                  ),
                ),
            );
            expect(released).toEqual([
              {
                actorId: seeded.owner.userId,
                metadata: { deploymentId: a.id, projectId: seeded.projectId },
              },
              {
                actorId: seeded.owner.userId,
                metadata: { deploymentId: b.id, projectId: seeded.projectId },
              },
            ]);
            expect(await outboxRows('site.released', seeded.projectId)).toHaveLength(2);
          },
          2 * DEPLOY_TIMEOUT_MS + 30_000,
        );

        /**
         * FR-025, SC-003's no-mismatch half: with B current, A's hashed asset still resolves (via
         * the asset index, research R11 amendment), so a page of A loaded just before the switch
         * keeps its script. A path in neither release is still the uniform 404.
         */
        it('an asset only in the release that is not current still resolves (FR-025)', async () => {
          expect((await fromSite(label, '/assets/only-in-a.js')).status).toBe(200);
          expect((await fromSite(label, '/assets/only-in-neither.js')).status).toBe(404);
        });
      });

      // ---- US3 (T068) ----

      describe('serves with the sandbox gone', () => {
        it(
          'serves after the sandbox is hibernated and after its row is deleted, with no sandbox op (SC-008)',
          async () => {
            const seeded = await seedProject(world.alpha, 'Sandbox Gone');
            await transactions.runInTenantScope({ orgId: seeded.orgId, userId: null }, (tx) =>
              app.get(SandboxService).register(tx, {
                daytonaId: fake.sandboxId,
                orgId: seeded.orgId,
                projectId: seeded.projectId,
              }),
            );
            fake.resetBuild();
            const site = siteArchive('Still here', 'app-sg.js');
            fake.buildArchive(site.archive);
            await deployLive(seeded);
            const label = await siteLabelOf(seeded);

            const sandboxRows = () =>
              inTenant(seeded.orgId, (tx) =>
                tx
                  .select()
                  .from(schema.sandboxes)
                  .where(eq(schema.sandboxes.projectId, seeded.projectId)),
              );
            const sandboxOpsSince = (since: Date) =>
              db
                .select({ id: schema.outbox.id })
                .from(schema.outbox)
                .where(
                  and(
                    eq(schema.outbox.type, 'sandbox.op.requested'),
                    eq(schema.outbox.originOrgId, seeded.orgId),
                    gt(schema.outbox.createdAt, since),
                  ),
                );

            // Hibernated: the row says so, the fake's sandbox is stopped.
            const now = new Date();
            await inTenant(seeded.orgId, (tx) =>
              tx
                .update(schema.sandboxes)
                .set({ hibernatedAt: now, state: 'hibernated', stateEnteredAt: now })
                .where(eq(schema.sandboxes.projectId, seeded.projectId)),
            );
            fake.sandboxState('stopped');
            expect(await sandboxRows()).toEqual([expect.objectContaining({ state: 'hibernated' })]);

            const hibernatedAt = new Date(Date.now() - 1_000);
            fake.requests.length = 0;
            for (const path of ['/', '/assets/app-sg.js', '/']) {
              const served = await fromSite(label, path);
              expect(served.status).toBe(200);
            }
            expect((await fromSite(label, '/')).body).toBe(site.index);

            // Destroyed: no row at all.
            await inTenant(seeded.orgId, (tx) =>
              tx.delete(schema.sandboxes).where(eq(schema.sandboxes.projectId, seeded.projectId)),
            );
            expect(await sandboxRows()).toEqual([]);
            for (const path of ['/', '/assets/app-sg.js']) {
              const served = await fromSite(label, path);
              expect(served.status).toBe(200);
            }
            expect((await fromSite(label, '/')).body).toBe(site.index);

            // No request woke, resumed or even asked about a sandbox.
            expect(await sandboxOpsSince(hibernatedAt)).toEqual([]);
            expect(fake.requests).toEqual([]);
            fake.sandboxState('started');
          },
          DEPLOY_TIMEOUT_MS + 10_000,
        );
      });

      // ---- US4 (T076) ----

      describe('a failing build leaves the previous release serving', () => {
        it(
          'ends failed / build-failed with a readable log tail, and the gateway still serves A (SC-006)',
          async () => {
            const seeded = await seedProject(world.alpha, 'Build Breaks');
            const siteA = siteArchive('Release A stays', 'app-stays.js');
            fake.resetBuild();
            fake.buildArchive(siteA.archive);
            const a = await deployLive(seeded);
            const label = await siteLabelOf(seeded);
            await servesWithin(label, '/', 200, siteA.index);

            // The template's build command exits 1 with a compiler error on its output.
            const error = 'src/App.tsx(3,7): error TS2322: e2e build breaks here';
            fake.buildArchive(siteArchive('Never served', 'app-broken.js').archive);
            fake.scriptBuild('build', { exitCode: 1, result: `${error}\n` });
            try {
              const response = await requestDeploy(seeded, seeded.owner.cookie).expect(202);
              const { deployment } = deploymentResponseSchema.parse(response.body);
              const failed = await settled(seeded, deployment.id);
              expect(failed).toMatchObject({
                artifactSha: null,
                current: false,
                failureReason: 'build-failed',
                state: 'failed',
              });

              // The tail names the failing step and carries its output.
              const log = await http(app)
                .get(`${deploymentsPath(seeded)}/${deployment.id}/log`)
                .set('Cookie', seeded.owner.cookie)
                .expect(200);
              expect(log.body).toMatchObject({ truncated: false });
              const tail = (log.body as { log: string }).log;
              expect(tail).toContain('$ npm ci');
              expect(tail).toContain(error);

              // The pointer never moved; one `deploy.failed`, no `deploy.succeeded`.
              const [pointer] = await inTenant(seeded.orgId, (tx) =>
                tx
                  .select()
                  .from(schema.projectSites)
                  .where(eq(schema.projectSites.projectId, seeded.projectId)),
              );
              expect(pointer).toMatchObject({ currentDeploymentId: a.id, offlineAt: null });
              expect(await outboxRows('deploy.failed', deployment.id)).toEqual([
                expect.objectContaining({
                  payload: expect.objectContaining({
                    deploymentId: deployment.id,
                    reason: 'build-failed',
                  }) as unknown,
                }),
              ]);
              expect(await outboxRows('deploy.succeeded', deployment.id)).toEqual([]);
              expect(fake.builds.at(-1)).toMatchObject({ removed: true });

              // The gateway still serves A, entry page and asset; nothing of the broken build.
              await servesWithin(label, '/', 200, siteA.index);
              expect((await fromSite(label, '/assets/app-stays.js')).status).toBe(200);
              expect((await fromSite(label, '/assets/app-broken.js')).status).toBe(404);
              const site = await http(app)
                .get(`${ORGS}/${seeded.orgId}/projects/${seeded.projectId}/site`)
                .set('Cookie', seeded.owner.cookie)
                .expect(200);
              expect(siteResponseSchema.parse(site.body).site).toMatchObject({
                currentDeploymentId: a.id,
                offline: false,
              });
            } finally {
              fake.resetBuild();
            }
          },
          2 * DEPLOY_TIMEOUT_MS + 30_000,
        );
      });

      // ---- US5 (T090) ----

      describe('offline and archive', () => {
        it(
          'offline answers the uniform 404; the next deploy serves on the same label (SC-010)',
          async () => {
            const seeded = await seedProject(world.alpha, 'Take Down');
            const site = siteArchive('Up', 'app-up.js');
            fake.resetBuild();
            fake.buildArchive(site.archive);
            await deployLive(seeded);
            const label = await siteLabelOf(seeded);
            await servesWithin(label, '/', 200, site.index);

            const offline = await putSite(seeded, { action: 'offline' }).expect(200);
            expect(siteResponseSchema.parse(offline.body).site).toMatchObject({ offline: true });
            await servesWithin(label, '/', 404);

            // The same bytes as a label that never existed (FR-030).
            const down = await fromSite(label, '/assets/app-up.js');
            const never = await fromSite(`never-${randomBytes(4).toString('hex')}`, '/');
            expect({ body: down.body, status: down.status }).toEqual({
              body: never.body,
              status: never.status,
            });

            const again = siteArchive('Up again', 'app-up2.js');
            fake.buildArchive(again.archive);
            await deployLive(seeded);
            expect(await siteLabelOf(seeded)).toBe(label);
            await servesWithin(label, '/', 200, again.index);
          },
          2 * DEPLOY_TIMEOUT_MS + 30_000,
        );

        it(
          'offline beats a build already in flight: it goes live, and the site stays offline',
          async () => {
            const seeded = await seedProject(world.alpha, 'Leak Stop');
            const live = siteArchive('Leaking', 'app-leak.js');
            fake.resetBuild();
            fake.buildArchive(live.archive);
            await deployLive(seeded);
            const label = await siteLabelOf(seeded);
            await servesWithin(label, '/', 200, live.index);

            // A second build, held in `building` at the bundler, then the site taken offline.
            const next = siteArchive('Requested before offline', 'app-next.js');
            fake.buildArchive(next.archive);
            repos.hold();
            let inFlight: Deployment;
            try {
              const response = await requestDeploy(seeded, seeded.owner.cookie).expect(202);
              inFlight = deploymentResponseSchema.parse(response.body).deployment;
              expect(
                await until(
                  async () =>
                    (await readDeployment(seeded, seeded.owner.cookie, inFlight.id)).state ===
                    'building',
                  DEPLOY_TIMEOUT_MS,
                ),
              ).toBe(true);

              await putSite(seeded, { action: 'offline' }).expect(200);
              await servesWithin(label, '/', 404);
            } finally {
              repos.release();
            }

            // The held build settles `succeeded` and moves the pointer; `offline_at` stays.
            expect((await settled(seeded, inFlight!.id)).state).toBe('succeeded');
            const read = await http(app)
              .get(`${ORGS}/${seeded.orgId}/projects/${seeded.projectId}/site`)
              .set('Cookie', seeded.owner.cookie)
              .expect(200);
            expect(siteResponseSchema.parse(read.body).site).toMatchObject({
              currentDeploymentId: inFlight!.id,
              offline: true,
            });

            // Past the gateway's 50 ms route cache, so this reads the settled pointer: the uniform
            // not-found, the same bytes as a label that never existed (FR-030).
            await new Promise((resolve) => setTimeout(resolve, 250));
            expect((await fromSite(label, '/')).status).toBe(404);
            const down = await fromSite(label, '/assets/app-next.js');
            const never = await fromSite(`never-${randomBytes(4).toString('hex')}`, '/');
            expect({ body: down.body, status: down.status }).toEqual({
              body: never.body,
              status: never.status,
            });
          },
          2 * DEPLOY_TIMEOUT_MS + 30_000,
        );

        it(
          'archiving with a build in flight cancels it and takes the site offline; a new deploy is refused',
          async () => {
            const seeded = await seedProject(world.alpha, 'Archive Me');
            const live = siteArchive('Before archive', 'app-live.js');
            fake.resetBuild();
            fake.buildArchive(live.archive);
            const first = await deployLive(seeded);
            const label = await siteLabelOf(seeded);
            await servesWithin(label, '/', 200, live.index);

            // A second build, held in `building` at the bundler.
            fake.buildArchive(siteArchive('Never live', 'app-never.js').archive);
            repos.hold();
            let inFlight: Deployment;
            try {
              const response = await requestDeploy(seeded, seeded.owner.cookie).expect(202);
              inFlight = deploymentResponseSchema.parse(response.body).deployment;
              expect(
                await until(
                  async () =>
                    (await readDeployment(seeded, seeded.owner.cookie, inFlight.id)).state ===
                    'building',
                  DEPLOY_TIMEOUT_MS,
                ),
              ).toBe(true);

              await unsafe(
                http(app).delete(
                  `${ORGS}/${seeded.orgId}/workspaces/${world.alpha.workspaceId}/projects/${seeded.projectId}`,
                ),
                [seeded.owner.cookie],
              ).expect(204);

              // The archive consumer: cancelled, and the site offline, both within the bound.
              expect(
                await until(async () => {
                  const rows = await deploymentRows(seeded);
                  return rows.find((row) => row.id === inFlight.id)?.state === 'cancelled';
                }, DEPLOY_TIMEOUT_MS),
              ).toBe(true);
              await servesWithin(label, '/', 404);
            } finally {
              repos.release();
            }

            // The held build resumes, is fenced out at the upload boundary, and writes nothing.
            expect(
              await until(
                () => fake.builds.length === 2 && fake.builds[1]!.removed,
                DEPLOY_TIMEOUT_MS,
              ),
            ).toBe(true);
            const rows = await deploymentRows(seeded);
            expect(rows.find((row) => row.id === inFlight!.id)).toMatchObject({
              artifactSha: null,
              state: 'cancelled',
            });
            const [pointer] = await inTenant(seeded.orgId, (tx) =>
              tx
                .select()
                .from(schema.projectSites)
                .where(eq(schema.projectSites.projectId, seeded.projectId)),
            );
            expect(pointer).toMatchObject({ currentDeploymentId: first.id, updatedBy: null });
            expect(pointer!.offlineAt).not.toBeNull();
            expect(await outboxRows('deploy.succeeded', inFlight!.id)).toEqual([]);
            await servesWithin(label, '/', 404);

            // An archived project drops every grant (spec 007 R5), so the guard's uniform 403
            // answers before the service's `project-archived` 409 can (as agent-run.e2e-spec.ts's
            // archived-project run does). Either way nothing is written.
            await requestDeploy(seeded, seeded.owner.cookie).expect(403);
            expect(await deploymentRows(seeded)).toHaveLength(2);
          },
          3 * DEPLOY_TIMEOUT_MS + 30_000,
        );
      });

      // ---- T099 (SC-009) ----

      describe('tenancy', () => {
        let alpha: Seeded;
        let beta: Seeded;
        let alphaDeployment: Deployment;

        beforeAll(async () => {
          alpha = await seedProject(world.alpha, 'Tenancy Alpha');
          beta = await seedProject(world.beta, 'Tenancy Beta');
          fake.resetBuild();
          fake.buildArchive(siteArchive('Alpha only', 'app-t.js').archive);
          alphaDeployment = await deployLive(alpha);
        }, DEPLOY_TIMEOUT_MS + 10_000);

        /**
         * Nothing about alpha's project in a refusal's body. `instance` is the request's own URL
         * and `requestId` is per request, so both are stripped as `tenant-isolation.e2e-spec.ts`
         * strips them: they carry only the ids the probe itself chose.
         */
        function leaksNothing(body: unknown): void {
          const text = JSON.stringify(
            Object.entries(body as Record<string, unknown>).filter(
              ([member]) => member !== 'requestId' && member !== 'instance',
            ),
          );
          for (const secret of [
            alpha.projectId,
            alpha.checkpointId,
            alphaDeployment.id,
            alphaDeployment.artifactSha!,
          ]) {
            expect(text).not.toContain(secret);
          }
        }

        async function alphaDeploymentIds(): Promise<string[]> {
          return (await deploymentRows(alpha)).map((row) => row.id);
        }

        it("a member of another organisation cannot list or read alpha's deployments, or a log", async () => {
          const cookie = world.beta.owner.cookie;
          for (const path of [
            deploymentsPath(alpha),
            `${deploymentsPath(alpha)}/${alphaDeployment.id}`,
            `${deploymentsPath(alpha)}/${alphaDeployment.id}/log`,
            // Beta's own org in the path, alpha's project or deployment under it.
            deploymentsPath({ orgId: beta.orgId, projectId: alpha.projectId }),
            `${deploymentsPath(beta)}/${alphaDeployment.id}`,
            `${deploymentsPath(beta)}/${alphaDeployment.id}/log`,
          ]) {
            const response = await http(app).get(path).set('Cookie', cookie);
            expect([403, 404], path).toContain(response.status);
            leaksNothing(response.body);
          }
        });

        it("a member of another organisation cannot deploy alpha's project, or name its checkpoint", async () => {
          const before = await alphaDeploymentIds();
          const cookie = world.beta.owner.cookie;

          for (const [ref, body] of [
            [alpha, {}],
            [alpha, { checkpointId: alpha.checkpointId }],
            [{ orgId: beta.orgId, projectId: alpha.projectId }, {}],
            // Beta's own project, alpha's checkpoint: as absent as no checkpoint.
            [beta, { checkpointId: alpha.checkpointId }],
          ] as const) {
            const response = await requestDeploy(ref, cookie, randomUUID(), body);
            expect([403, 404]).toContain(response.status);
            leaksNothing(response.body);
          }

          expect(await alphaDeploymentIds()).toEqual(before);
          expect(await deploymentRows(beta)).toEqual([]);
        });

        /**
         * The job path: alpha's `deploy.requested`, replayed through the real consumer base with
         * beta's id in place of alpha's. The row is a fresh `queued` one so a claim would succeed
         * if the tenant were not part of it — the control case at the end proves it would.
         */
        it(
          "a deploy.requested replayed with another organisation's id writes nothing",
          async () => {
            const [queued] = await inTenant(alpha.orgId, (tx) =>
              tx
                .insert(schema.deployments)
                .values({
                  checkpointId: alpha.checkpointId,
                  orgId: alpha.orgId,
                  projectId: alpha.projectId,
                  requestedBy: alpha.owner.userId,
                  template: TEMPLATE,
                })
                .returning(),
            );
            const envelope = (orgId: string, projectId: string): Envelope<'deploy.requested'> => ({
              aggregate: 'deployment',
              aggregateId: queued!.id,
              eventId: randomUUID(),
              occurredAt: new Date().toISOString(),
              orgId,
              payload: { deploymentId: queued!.id, orgId, projectId },
              traceId: null,
              type: 'deploy.requested',
            });
            const replay = (event: Envelope<'deploy.requested'>) =>
              app.get(ConsumerBase).processJob(app.get(BuildDeployConsumer), {
                attemptsMade: 0,
                data: event,
                log: () => Promise.resolve(0),
              });
            const auditCount = (orgId: string) =>
              inTenant(orgId, (tx) =>
                tx
                  .select({ id: schema.auditLog.id })
                  .from(schema.auditLog)
                  .where(eq(schema.auditLog.orgId, orgId)),
              ).then((rows) => rows.length);
            const trail = async () => ({
              alphaAudit: await auditCount(alpha.orgId),
              betaAudit: await auditCount(beta.orgId),
              outbox: await db
                .select({ id: schema.outbox.id })
                .from(schema.outbox)
                .where(eq(schema.outbox.aggregateId, queued!.id))
                .then((rows) => rows.length),
            });

            fake.resetBuild();
            fake.buildArchive(siteArchive('Replayed', 'app-r.js').archive);
            const before = await trail();

            await replay(envelope(beta.orgId, alpha.projectId));
            await replay(envelope(beta.orgId, beta.projectId));

            const untouched = (await deploymentRows(alpha)).find((row) => row.id === queued!.id);
            expect(untouched).toEqual(queued);
            expect(await trail()).toEqual(before);
            expect(fake.builds).toEqual([]);
            expect(await deploymentRows(beta)).toEqual([]);

            // Control: the same envelope with alpha's own id is claimed and built.
            await replay(envelope(alpha.orgId, alpha.projectId));
            const built = (await deploymentRows(alpha)).find((row) => row.id === queued!.id);
            expect(built?.state).toBe('succeeded');
            expect(fake.builds).toHaveLength(1);
          },
          DEPLOY_TIMEOUT_MS,
        );

        it(
          "a member of another organisation cannot read alpha's site, release or take it offline",
          async () => {
            const cookie = world.beta.owner.cookie;
            const label = await siteLabelOf(alpha);
            const pointer = () =>
              inTenant(alpha.orgId, (tx) =>
                tx
                  .select()
                  .from(schema.projectSites)
                  .where(eq(schema.projectSites.projectId, alpha.projectId)),
              );
            const before = await pointer();
            expect(before).toEqual([expect.objectContaining({ offlineAt: null })]);
            const sitePaths = [
              `${ORGS}/${alpha.orgId}/projects/${alpha.projectId}/site`,
              `${ORGS}/${beta.orgId}/projects/${alpha.projectId}/site`,
            ];

            for (const path of sitePaths) {
              const read = await http(app).get(path).set('Cookie', cookie);
              expect([403, 404], path).toContain(read.status);
              leaksNothing(read.body);

              for (const body of [
                { action: 'offline' },
                { action: 'release', deploymentId: alphaDeployment.id },
              ]) {
                const response = await unsafe(http(app).put(path), [cookie]).send(body);
                expect([403, 404], `${path} ${body.action}`).toContain(response.status);
                leaksNothing(response.body);
              }
            }

            // Beta's own site route, naming alpha's deployment: as absent as no deployment.
            const own = await unsafe(
              http(app).put(`${ORGS}/${beta.orgId}/projects/${beta.projectId}/site`),
              [cookie],
            ).send({ action: 'release', deploymentId: alphaDeployment.id });
            expect(own.status).toBe(404);
            leaksNothing(own.body);

            // Alpha's pointer and its serving are untouched.
            expect(await pointer()).toEqual(before);
            expect((await fromSite(label, '/')).status).toBe(200);
          },
          DEPLOY_TIMEOUT_MS,
        );
      });
    },
  );
});

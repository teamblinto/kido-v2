import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  type Deployment,
  type Domain,
  deploymentResponseSchema,
  domainListResponseSchema,
  domainResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type ProjectTemplate,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK } from '../src/common/clock/clock.port';
import { FakeClock } from '../src/common/clock/fake-clock';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { OBJECT_STORE } from '../src/common/object-store/object-store.port';
import type { Environment } from '../src/config/environment';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { mirrorKey } from '../src/modules/checkpoints/repo-bundler';
import { ARTIFACT_STORE } from '../src/modules/deploy/deploy.constants';
import { DNS } from '../src/modules/deploy/domains/dns.port';
import { CHALLENGE_PREFIX } from '../src/modules/deploy/domains/domain.constants';
import { DomainRepository } from '../src/modules/deploy/domains/domain.repository';
import { DomainCheckConsumer } from '../src/modules/deploy/domains/domain-check.consumer';
import { DomainCheckSweepConsumer } from '../src/modules/deploy/domains/domain-check-sweep.consumer';
import { type CheckRun, DomainChecker } from '../src/modules/deploy/domains/domain-checker';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER, type MailMessage } from '../src/modules/mail/mailer.port';
import { BrokerListener, PlainBrokerTransport } from '../src/modules/preview/broker-listener';
import { BROKER_TRANSPORT } from '../src/modules/preview/preview.constants';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { type FakeCloudflare, startFakeCloudflare } from './support/fake-cloudflare';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { FakeDns } from './support/fake-dns';
import { awaitMail } from './support/mail';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type Tenant,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import (as `deploy.e2e-spec.ts`): the relay and the build worker run in-process, and
 * the `CLOUDFLARE_*` group points the real adapter at the fake edge, whose port is fixed here.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `events` relays the outbox; `agent` drains `build.deploy`. No `cron`: no `maintenance.due`
  // fires, so a domain is checked only when a case asks.
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

  const edgePort = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.CLOUDFLARE_API_TOKEN = 'cf_domains_e2e_token';
  process.env.CLOUDFLARE_ZONE_ID = 'zone-domains-e2e';
  process.env.CLOUDFLARE_API_URL = `http://127.0.0.1:${edgePort}/client/v4`;
  process.env.CUSTOM_HOSTNAME_TARGET = 'customers.forge-edge.test';

  return { edgePort, port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const SECRET = 'e2e-broker-secret';
const EDGE_SECRET = 'e2e-edge-origin-secret-0123456789abcdef';
const SITE_DOMAIN = 'forge-site.localhost';
const TARGET = 'customers.forge-edge.test';
const TEMPLATE: ProjectTemplate = 'vite-react';
const SNAPSHOT = 'forge-tpl-vite-react-domains-e2e';
const BUCKET = 'forge-artifacts-domains-e2e';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const DEPLOY_TIMEOUT_MS = 20_000;
/** SC-009: the bound a pointer change is seen in on the platform address (`deploy.e2e-spec.ts`). */
const SERVING_BOUND_MS = 10_000;
/** The first check of a young domain comes a minute after the last (research R7). */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
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

interface Seeded {
  readonly checkpointId: string;
  readonly orgId: string;
  readonly owner: Tenant['owner'];
  readonly projectId: string;
}

interface Served {
  readonly body: string;
  readonly headers: Record<string, unknown>;
  readonly status: number;
}

/**
 * Spec 028 US1 over the real API, Postgres, the queue and stream Redis roles and the in-process
 * relay and `build.deploy` worker, with the edge as `startFakeCloudflare` behind the real
 * `CloudflareForSaasAdapter`, DNS as `FakeDns` and time as `FakeClock`. The site is served by the
 * **real gateway**, spawned with `EDGE_ORIGIN_SECRET` as `deploy.e2e-spec.ts` spawns it, so a
 * request that carries a custom `Host` and the edge header goes gateway → broker → domain route →
 * artifacts bucket, which is SC-001 against the fakes.
 *
 * A domain is checked the way the sweep checks each due row: `DomainChecker.checkOne`, claim →
 * observe → settle. The suite calls it for its own rows rather than running the sweep's global
 * probe, because other suites' domain rows share the table and a global sweep here would claim
 * them (and theirs would claim these). The clock stands a day ahead of the host's so no other
 * suite's sweep finds these rows due; each case advances it past the one-minute cadence (R7).
 *
 * US3's cases (SC-006, SC-007) drive drift, recovery, the release warning and the 30-day release
 * the same way, moving the clock to each row's `next_check_at`, and read the notices from
 * `InMemoryMailer` after the in-process relay and `DomainMailConsumer` have sent them.
 */
describe('Domains (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue, a fake edge, fake DNS, in-memory buckets and the gateway',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let edge: FakeCloudflare;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let db: ForgeDatabase;
      let suiteLock: { release: () => Promise<void> } | undefined;
      let gateway: ChildProcess | undefined;
      let gatewayPort: number;
      let s3: Server | undefined;
      const clock = new FakeClock(Date.now() + 24 * 60 * MINUTE);
      const dns = new FakeDns();
      const mailer = new InMemoryMailer();
      const repos = new MemoryObjectStore();
      const artifacts = new MemoryObjectStore();
      const extraEmails: string[] = [];

      // ---- helpers ----

      const projectPath = (ref: { orgId: string; projectId: string }) =>
        `${ORGS}/${ref.orgId}/projects/${ref.projectId}`;
      const domainsPath = (ref: { orgId: string; projectId: string }) =>
        `${projectPath(ref)}/domains`;

      function addDomain(
        ref: { orgId: string; projectId: string },
        cookie: string,
        hostname: string,
        key: string = randomUUID(),
      ) {
        return unsafe(http(app).post(domainsPath(ref)), [cookie])
          .set(IDEMPOTENCY_KEY_HEADER, key)
          .send({ hostname });
      }

      async function readDomain(seeded: Seeded, id: string): Promise<Domain> {
        const response = await http(app)
          .get(`${domainsPath(seeded)}/${id}`)
          .set('Cookie', seeded.owner.cookie)
          .expect(200);
        return domainResponseSchema.parse(response.body).domain;
      }

      /** One check, as the sweep runs it for a due row, after the cadence has passed. */
      function checkAfterCadence(seeded: Seeded, id: string): Promise<CheckRun> {
        clock.advance(MINUTE);
        return app.get(DomainChecker).checkOne(seeded.orgId, id);
      }

      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      function domainRows(orgId: string, hostname: string) {
        return inTenant(orgId, (tx) =>
          tx.select().from(schema.domains).where(eq(schema.domains.hostname, hostname)),
        );
      }

      function outboxRows(type: string, aggregateId: string) {
        return db
          .select()
          .from(schema.outbox)
          .where(and(eq(schema.outbox.type, type), eq(schema.outbox.aggregateId, aggregateId)));
      }

      function auditRows(orgId: string, action: string, target: string) {
        return inTenant(orgId, (tx) =>
          tx
            .select()
            .from(schema.auditLog)
            .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.target, target))),
        );
      }

      /** The registrations the fake edge was asked for, for `hostname`. */
      function edgePosts(hostname: string) {
        return edge.requests.filter(
          (request) =>
            request.method === 'POST' &&
            (JSON.parse(request.body) as { hostname?: string }).hostname === hostname,
        );
      }

      /** A hostname under a `.test` zone, unique per run. */
      function freshHostname(prefix: string): string {
        return `${prefix}-${randomBytes(4).toString('hex')}.shop.example.test`;
      }

      /** What the member publishes: the ownership TXT and the routing CNAME, as displayed. */
      function publishRecords(domain: Domain): void {
        const ownership = domain.records.find((record) => record.purpose === 'ownership')!;
        const routing = domain.records.find((record) => record.purpose === 'routing')!;
        dns.set(ownership.name, 'TXT', [ownership.value]);
        dns.set(routing.name, 'CNAME', routing.value);
      }

      /** A GET to the gateway with `host`, and the edge's header unless `edgeHeader` is false. */
      function fromGateway(host: string, path: string, edgeHeader = true): Promise<Served> {
        return new Promise((resolve, reject) => {
          const outgoing = httpRequest(
            {
              headers: edgeHeader ? { host, 'x-forge-edge': EDGE_SECRET } : { host },
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

      /** `host` answers `status` (and `body`) within SC-009's bound. */
      async function servesWithin(host: string, status: number, body?: string): Promise<void> {
        let last: Served | undefined;
        const seen = await until(async () => {
          last = await fromGateway(host, '/');
          return last.status === status && (body === undefined || last.body === body);
        }, SERVING_BOUND_MS);
        expect(seen, `${host} answered ${String(last?.status)} ${last?.body ?? ''}`).toBe(true);
      }

      async function settled(seeded: Seeded, id: string): Promise<Deployment> {
        let last: Deployment | undefined;
        const done = await until(async () => {
          const response = await http(app)
            .get(`${projectPath(seeded)}/deployments/${id}`)
            .set('Cookie', seeded.owner.cookie)
            .expect(200);
          last = deploymentResponseSchema.parse(response.body).deployment;
          return ['succeeded', 'failed', 'cancelled'].includes(last.state);
        }, DEPLOY_TIMEOUT_MS);
        if (!done) throw new Error(`deployment ${id} is still ${last?.state ?? '?'}`);
        return last!;
      }

      /** Build `archive` and make it current, the product's way. */
      async function deployLive(seeded: Seeded, archive: Buffer): Promise<Deployment> {
        fake.resetBuild();
        fake.buildArchive(archive);
        const response = await unsafe(http(app).post(`${projectPath(seeded)}/deployments`), [
          seeded.owner.cookie,
        ])
          .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
          .send({})
          .expect(202);
        const { deployment } = deploymentResponseSchema.parse(response.body);
        const done = await settled(seeded, deployment.id);
        expect(done.state).toBe('succeeded');
        return done;
      }

      function putSite(seeded: Seeded, body: Record<string, unknown>) {
        return unsafe(http(app).put(`${projectPath(seeded)}/site`), [seeded.owner.cookie]).send(
          body,
        );
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

      /** A deployable project of `tenant`'s with one baseline checkpoint and its mirror. */
      async function seedProject(tenant: Tenant, name: string): Promise<Seeded> {
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
        return { checkpointId: checkpoint!.id, orgId, owner, projectId: project.id };
      }

      /** A signed-in alpha member (or `orgRole`), optionally holding a role on `projectId`. */
      async function alphaMember(
        label: string,
        projectId: string,
        projectRole?: 'commenter' | 'editor',
        orgRole: 'admin' | 'member' = 'member',
      ): Promise<Principal> {
        const who = await signUpAndIn(app, label);
        extraEmails.push(who.email);
        const { orgId } = world.alpha;
        await inTenant(orgId, async (tx) => {
          await tx
            .insert(schema.memberships)
            .values({ acceptedAt: new Date(), orgId, role: orgRole, userId: who.userId });
          if (projectRole !== undefined) {
            await tx
              .insert(schema.projectGrants)
              .values({ orgId, projectId, role: projectRole, userId: who.userId });
          }
        });
        return who;
      }

      async function startLoopbackS3(): Promise<number> {
        s3 = createServer((req, res) => {
          const prefix = `/${BUCKET}/`;
          const path = decodeURIComponent(new URL(req.url ?? '/', 'http://s3').pathname);
          const key = path.startsWith(prefix) ? path.slice(prefix.length) : '';
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

      /** `node src/main.ts` in apps/gateway with custom domains on; resolves once listening. */
      async function startGateway(brokerPort: number, s3Port: number): Promise<void> {
        const config = app.get<ConfigService<Environment, true>>(ConfigService);
        gatewayPort = await new Promise<number>((resolve) => {
          const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as AddressInfo;
            probe.close(() => resolve(port));
          });
        });
        gateway = spawn(process.execPath, ['src/main.ts'], {
          cwd: GATEWAY_DIR,
          env: {
            ARTIFACT_STORE_ACCESS_KEY_ID: 'AKIDDOMAINSE2E',
            ARTIFACT_STORE_BUCKET: BUCKET,
            ARTIFACT_STORE_ENDPOINT: `http://127.0.0.1:${String(s3Port)}`,
            ARTIFACT_STORE_SECRET_ACCESS_KEY: 'domains-e2e-read-only',
            BROKER_HOST: '127.0.0.1',
            BROKER_PORT: String(brokerPort),
            BROKER_SHARED_SECRET: SECRET,
            BROKER_TRANSPORT: 'plain',
            DEPLOY_ENV: 'local',
            EDGE_ORIGIN_SECRET: EDGE_SECRET,
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
        expect(output).toContain('custom domains from the edge');
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });
        edge = await startFakeCloudflare({
          apiToken: 'cf_domains_e2e_token',
          port: FAKE.edgePort,
          zoneId: 'zone-domains-e2e',
        });

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
          .overrideProvider(DNS)
          .useValue(dns)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(MAILER)
          .useValue(mailer)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
        await app.get(BrokerListener).listen();

        transactions = app.get(TenantTransactionRunner);
        db = app.get<ForgeDatabase>(APP_DATABASE);
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
        if (db && extraEmails.length > 0) {
          await db.delete(schema.users).where(inArray(schema.users.email, extraEmails));
        }
        if (db) await dropFakeVersions(db, TEMPLATE);
        await app?.close();
        await edge?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      // ---- US1 (T034) ----

      describe('adds a domain, checks it to active and serves the current release', () => {
        let seeded: Seeded;
        let hostname: string;
        let domain: Domain;
        const releaseA = siteArchive('Release A', 'app-a.js');
        const releaseB = siteArchive('Release B', 'app-b.js');
        let deploymentA: Deployment;

        beforeAll(async () => {
          seeded = await seedProject(world.alpha, 'Custom Domain');
          deploymentA = await deployLive(seeded, releaseA.archive);
          hostname = freshHostname('www');
        }, DEPLOY_TIMEOUT_MS + 30_000);

        it('add answers 201 pending with the ownership TXT and the routing CNAME', async () => {
          const response = await addDomain(seeded, seeded.owner.cookie, hostname).expect(201);
          domain = domainResponseSchema.parse(response.body).domain;

          expect(domain).toMatchObject({
            activatedAt: null,
            addedBy: seeded.owner.userId,
            check: null,
            displayHostname: hostname,
            failureReason: null,
            hostname,
            state: 'pending',
          });
          expect(domain.windowEndsAt).toBe(
            new Date(clock.now().getTime() + 72 * 60 * MINUTE).toISOString(),
          );
          expect(domain.records).toEqual([
            {
              name: `${CHALLENGE_PREFIX}${hostname}`,
              purpose: 'ownership',
              status: 'unchecked',
              type: 'TXT',
              value: expect.stringMatching(/^forge-verify=\S+$/) as string,
            },
            {
              name: hostname,
              purpose: 'routing',
              status: 'unchecked',
              type: 'CNAME',
              value: TARGET,
            },
          ]);

          // One row, its event and its audit row (FR-027).
          expect(await domainRows(seeded.orgId, hostname)).toHaveLength(1);
          expect(await outboxRows('domain.added', domain.id)).toEqual([
            expect.objectContaining({
              payload: { domainId: domain.id, orgId: seeded.orgId, projectId: seeded.projectId },
            }),
          ]);
          expect(await auditRows(seeded.orgId, 'domain.added', domain.id)).toEqual([
            expect.objectContaining({
              actorId: seeded.owner.userId,
              metadata: { hostname, projectId: seeded.projectId },
            }),
          ]);

          const list = domainListResponseSchema.parse(
            (
              await http(app)
                .get(domainsPath(seeded))
                .set('Cookie', seeded.owner.cookie)
                .expect(200)
            ).body,
          );
          expect(list).toEqual({ canManage: true, items: [domain] });

          // Nothing serves yet: a pending domain is refused at the broker.
          expect((await fromGateway(hostname, '/')).status).toBe(404);
        });

        it('a check with nothing published leaves it pending and registers nothing at the edge', async () => {
          // Due at once: `next_check_at` is the add's `now`.
          const run = await app.get(DomainChecker).checkOne(seeded.orgId, domain.id);
          expect(run).toMatchObject({ kind: 'settled', transition: null });

          const read = await readDomain(seeded, domain.id);
          expect(read.state).toBe('pending');
          expect(read.check).toMatchObject({
            certificateActive: null,
            conclusive: true,
            hostnameActive: null,
          });
          expect(read.records.map((record) => [record.purpose, record.status])).toEqual([
            ['ownership', 'missing'],
            ['routing', 'missing'],
          ]);
          expect(edgePosts(hostname)).toEqual([]);
          expect(edge.find(hostname)).toBeUndefined();

          // A second check before the cadence has passed finds the row not due.
          expect(await app.get(DomainChecker).checkOne(seeded.orgId, domain.id)).toEqual({
            kind: 'not-due',
          });
        });

        it('with the TXT and the CNAME published, the next check registers it at the edge', async () => {
          publishRecords(domain);

          const run = await checkAfterCadence(seeded, domain.id);
          expect(run).toMatchObject({ kind: 'settled', transition: null });

          const registration = edge.find(hostname);
          expect(registration).toBeDefined();
          expect(edgePosts(hostname)).toHaveLength(1);
          const [row] = await domainRows(seeded.orgId, hostname);
          expect(row).toMatchObject({
            edgeId: registration!.id,
            ownershipVerifiedAt: clock.now(),
            state: 'pending',
          });

          const read = await readDomain(seeded, domain.id);
          expect(read.state).toBe('pending');
          expect(read.records.map((record) => [record.purpose, record.status])).toEqual([
            ['ownership', 'found'],
            ['routing', 'found'],
          ]);
          expect(
            await auditRows(seeded.orgId, 'domain.ownership-verified', domain.id),
          ).toHaveLength(1);
          expect((await fromGateway(hostname, '/')).status).toBe(404);
        });

        it('the edge hostname active with its certificate still pending leaves it pending (FR-009)', async () => {
          edge.scriptStatus(hostname, [{ ssl: 'pending_validation', status: 'active' }]);

          const run = await checkAfterCadence(seeded, domain.id);
          expect(run).toMatchObject({ kind: 'settled', transition: null });

          const read = await readDomain(seeded, domain.id);
          expect(read).toMatchObject({ activatedAt: null, state: 'pending' });
          expect(read.check).toMatchObject({
            certificateActive: false,
            conclusive: true,
            hostnameActive: true,
          });
          expect(await outboxRows('domain.activated', domain.id)).toEqual([]);
          expect((await fromGateway(hostname, '/')).status).toBe(404);
        });

        it('then the certificate active makes it active, with one event and one audit row', async () => {
          edge.scriptStatus(hostname, [{ ssl: 'active', status: 'active' }]);

          const run = await checkAfterCadence(seeded, domain.id);
          expect(run).toMatchObject({
            kind: 'settled',
            transition: { failureReason: null, from: 'pending', to: 'active' },
          });

          const read = await readDomain(seeded, domain.id);
          expect(read).toMatchObject({
            activatedAt: clock.now().toISOString(),
            check: { certificateActive: true, conclusive: true, hostnameActive: true },
            failureReason: null,
            state: 'active',
            windowEndsAt: null,
          });
          expect(await outboxRows('domain.activated', domain.id)).toEqual([
            expect.objectContaining({
              payload: { domainId: domain.id, orgId: seeded.orgId, projectId: seeded.projectId },
            }),
          ]);
          expect(await auditRows(seeded.orgId, 'domain.activated', domain.id)).toHaveLength(1);
          // Still one registration at the edge for the hostname.
          expect(edgePosts(hostname)).toHaveLength(1);
        });

        it("the gateway serves the current release's index.html on the hostname with the edge header, no session (SC-001)", async () => {
          await servesWithin(hostname, 200, releaseA.index);
          const index = await fromGateway(hostname, '/');
          expect(index.headers['content-type']).toMatch(/^text\/html/);
          expect(index.headers['set-cookie']).toBeUndefined();
          expect(index.headers['x-forge-edge']).toBeUndefined();

          const asset = await fromGateway(hostname, '/assets/app-a.js');
          expect(asset).toMatchObject({ body: 'console.log("Release A");', status: 200 });

          // Around the edge — no header, or a wrong one — the gateway serves nothing.
          expect((await fromGateway(hostname, '/', false)).status).not.toBe(200);
          const wrong = await new Promise<number>((resolve, reject) => {
            httpRequest(
              {
                headers: { host: hostname, 'x-forge-edge': `${EDGE_SECRET}x` },
                host: '127.0.0.1',
                path: '/',
                port: gatewayPort,
              },
              (incoming) => {
                incoming.resume();
                incoming.on('end', () => resolve(incoming.statusCode ?? 0));
              },
            )
              .on('error', reject)
              .end();
          });
          expect(wrong).not.toBe(200);
        });

        it(
          'a deploy, a rollback and offline each reach the domain within the platform address bound (SC-009)',
          async () => {
            const label = await siteLabelOf(seeded);
            const siteHost = `${label}.${SITE_DOMAIN}`;

            // A deploy: B is current on both.
            const deploymentB = await deployLive(seeded, releaseB.archive);
            await servesWithin(siteHost, 200, releaseB.index);
            await servesWithin(hostname, 200, releaseB.index);

            // A rollback to A, with no build.
            await putSite(seeded, { action: 'release', deploymentId: deploymentA.id }).expect(200);
            await servesWithin(siteHost, 200, releaseA.index);
            await servesWithin(hostname, 200, releaseA.index);

            // Offline: the domain answers what an unknown one does.
            await putSite(seeded, { action: 'offline' }).expect(200);
            await servesWithin(siteHost, 404);
            await servesWithin(hostname, 404);
            const unknown = await fromGateway(freshHostname('never'), '/');
            const down = await fromGateway(hostname, '/');
            expect({ body: down.body, status: down.status }).toEqual({
              body: unknown.body,
              status: unknown.status,
            });

            // Back online by releasing B: the domain follows the pointer again.
            await putSite(seeded, { action: 'release', deploymentId: deploymentB.id }).expect(200);
            await servesWithin(hostname, 200, releaseB.index);
          },
          2 * DEPLOY_TIMEOUT_MS + 30_000,
        );

        it('ten replays of an add with one Idempotency-Key make one row and one edge registration (SC-010)', async () => {
          const replayed = freshHostname('replay');
          const key = randomUUID();

          const replies = await Promise.all(
            Array.from({ length: 10 }, () => addDomain(seeded, seeded.owner.cookie, replayed, key)),
          );
          expect(replies.map((reply) => reply.status)).toEqual(Array(10).fill(201));
          const ids = new Set(
            replies.map((reply) => domainResponseSchema.parse(reply.body).domain.id),
          );
          expect(ids.size).toBe(1);
          const [id] = [...ids] as [string];
          expect(await domainRows(seeded.orgId, replayed)).toHaveLength(1);
          expect(await outboxRows('domain.added', id)).toHaveLength(1);

          // Its records published, checks racing for it: one claims it and registers it once.
          publishRecords(await readDomain(seeded, id));
          clock.advance(MINUTE);
          const runs = await Promise.all(
            Array.from({ length: 5 }, () => app.get(DomainChecker).checkOne(seeded.orgId, id)),
          );
          expect(runs.filter((run) => run.kind === 'settled')).toHaveLength(1);
          expect(runs.filter((run) => run.kind === 'not-due')).toHaveLength(4);

          // The next check reads the registration's status rather than registering again.
          expect(await checkAfterCadence(seeded, id)).toMatchObject({ kind: 'settled' });
          expect(edgePosts(replayed)).toHaveLength(1);
          const [row] = await domainRows(seeded.orgId, replayed);
          expect(row!.edgeId).toBe(edge.find(replayed)!.id);
        });

        it('a commenter and a member get 403 on add; a project:read holder lists with canManage false', async () => {
          const commenter = await alphaMember('domains-commenter', seeded.projectId, 'commenter');
          const editor = await alphaMember('domains-member', seeded.projectId, 'editor');
          const refused = freshHostname('refused');

          for (const who of [commenter, editor]) {
            const response = await addDomain(seeded, who.cookie, refused).expect(403);
            expect(JSON.stringify(response.body)).not.toContain(refused);
          }
          expect(await domainRows(seeded.orgId, refused)).toEqual([]);
          expect(edgePosts(refused)).toEqual([]);

          const list = domainListResponseSchema.parse(
            (await http(app).get(domainsPath(seeded)).set('Cookie', commenter.cookie).expect(200))
              .body,
          );
          expect(list.canManage).toBe(false);
          expect(list.items.map((item) => item.hostname)).toContain(hostname);

          // The same read of one domain is open to the reader too.
          const one = await http(app)
            .get(`${domainsPath(seeded)}/${domain.id}`)
            .set('Cookie', commenter.cookie)
            .expect(200);
          expect(domainResponseSchema.parse(one.body).domain.id).toBe(domain.id);
        });
      });

      // ---- US3 (T064): drift, recovery, CAA and the release ----

      describe('an active domain that stops working says why, before it lapses (SC-006, SC-007)', () => {
        let seeded: Seeded;
        let admin: Principal;
        /** The accepted owner and the admin who added the domains: R14's recipients. */
        let recipients: string[];

        /** One check once `id` is due: the clock moves to its `next_check_at` if that is ahead. */
        async function checkWhenDue(id: string): Promise<CheckRun> {
          const [row] = await inTenant(seeded.orgId, (tx) =>
            tx.select().from(schema.domains).where(eq(schema.domains.id, id)),
          );
          if (row!.nextCheckAt.getTime() > clock.now().getTime()) clock.set(row!.nextCheckAt);
          return app.get(DomainChecker).checkOne(seeded.orgId, id);
        }

        async function rowOf(id: string) {
          const [row] = await inTenant(seeded.orgId, (tx) =>
            tx.select().from(schema.domains).where(eq(schema.domains.id, id)),
          );
          return row!;
        }

        /** A domain the admin adds, published, registered and activated through the checker. */
        async function activeDomain(prefix: string): Promise<Domain> {
          const hostname = freshHostname(prefix);
          const response = await addDomain(seeded, admin.cookie, hostname).expect(201);
          const added = domainResponseSchema.parse(response.body).domain;
          publishRecords(added);
          edge.scriptStatus(hostname, [{ ssl: 'active', status: 'active' }]);
          await checkWhenDue(added.id);
          await expect(checkWhenDue(added.id)).resolves.toMatchObject({
            transition: { from: 'pending', to: 'active' },
          });
          return readDomain(seeded, added.id);
        }

        /** The member deletes the CNAME; the edge then reports the hostname moved, as it does. */
        function breakRouting(domain: Domain): void {
          dns.delete(domain.hostname, 'CNAME');
          edge.scriptStatus(domain.hostname, [{ status: 'moved' }]);
        }

        function restoreRouting(domain: Domain): void {
          dns.set(domain.hostname, 'CNAME', TARGET);
          edge.scriptStatus(domain.hostname, [{ status: 'active' }]);
        }

        /** The sent mails of `template` about `hostname`. */
        function sent(template: MailMessage['template'], hostname: string): MailMessage[] {
          return mailer.outbox.filter(
            (message) => message.template === template && message.text.includes(hostname),
          );
        }

        /** Waits for one `template` mail per recipient, then proves no second one follows. */
        async function onePerRecipient(
          template: MailMessage['template'],
          hostname: string,
        ): Promise<void> {
          const addresses = await addressesOf(recipients);
          for (const to of addresses) {
            await awaitMail(
              mailer,
              (message) =>
                message.template === template &&
                message.to === to &&
                message.text.includes(hostname),
            );
          }
          // Long enough for a duplicate append to have been relayed and sent.
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(
            sent(template, hostname)
              .map((message) => message.to)
              .sort(),
          ).toEqual([...addresses].sort());
        }

        async function addressesOf(userIds: string[]): Promise<string[]> {
          const users = await db
            .select({ email: schema.users.email })
            .from(schema.users)
            .where(inArray(schema.users.id, userIds));
          return users.map((user) => user.email);
        }

        beforeAll(async () => {
          seeded = await seedProject(world.alpha, 'Drifting Domains');
          admin = await alphaMember('domains-admin', seeded.projectId, 'editor', 'admin');
          recipients = [seeded.owner.userId, admin.userId];
        }, 30_000);

        describe('drift and recovery', () => {
          let domain: Domain;

          beforeAll(async () => {
            domain = await activeDomain('drift');
          }, 30_000);

          it('with its CNAME removed: active, active, then drifted on the third check at 1 h spacing', async () => {
            breakRouting(domain);
            const states: string[] = [];
            let previous: Date | undefined;

            for (let check = 0; check < 3; check++) {
              const run = await checkWhenDue(domain.id);
              expect(run.kind).toBe('settled');
              const now = clock.now();
              if (previous !== undefined) expect(now.getTime() - previous.getTime()).toBe(HOUR);
              previous = now;
              states.push((await readDomain(seeded, domain.id)).state);
            }

            expect(states).toEqual(['active', 'active', 'drifted']);
            const read = await readDomain(seeded, domain.id);
            expect(read).toMatchObject({
              driftedAt: clock.now().toISOString(),
              releaseAt: new Date(clock.now().getTime() + 30 * DAY).toISOString(),
            });
            expect(read.records.find((record) => record.purpose === 'routing')?.status).toBe(
              'missing',
            );
            expect(await outboxRows('domain.drifted', domain.id)).toHaveLength(1);
            expect(await auditRows(seeded.orgId, 'domain.drifted', domain.id)).toHaveLength(1);
            expect(await rowOf(domain.id)).toMatchObject({ failureCount: 3, state: 'drifted' });
          });

          it('InMemoryMailer receives exactly one domain-drifted per recipient', async () => {
            await onePerRecipient('domain-drifted', domain.hostname);
          });

          it('restoring the CNAME makes it active at the next check', async () => {
            restoreRouting(domain);

            await expect(checkWhenDue(domain.id)).resolves.toMatchObject({
              transition: { failureReason: null, from: 'drifted', to: 'active' },
            });

            expect(await readDomain(seeded, domain.id)).toMatchObject({
              driftedAt: null,
              releaseAt: null,
              state: 'active',
            });
            expect(await rowOf(domain.id)).toMatchObject({ failureCount: 0 });
            expect(await outboxRows('domain.recovered', domain.id)).toHaveLength(1);
            expect(await auditRows(seeded.orgId, 'domain.recovered', domain.id)).toHaveLength(1);
          });

          it('the fake edge answering 503 for 3 checks causes no drift (SC-007)', async () => {
            breakRouting(domain);

            for (let check = 0; check < 3; check++) {
              edge.failNext(503);
              await checkWhenDue(domain.id);
              const read = await readDomain(seeded, domain.id);
              expect(read.state).toBe('active');
              expect(read.check?.conclusive).toBe(false);
            }

            expect(await rowOf(domain.id)).toMatchObject({ failureCount: 0, state: 'active' });
            expect(await outboxRows('domain.drifted', domain.id)).toHaveLength(1);
            restoreRouting(domain);
          });
        });

        describe('the 30-day release', () => {
          let domain: Domain;
          let driftedAt: Date;

          beforeAll(async () => {
            domain = await activeDomain('release');
            breakRouting(domain);
            for (let check = 0; check < 3; check++) await checkWhenDue(domain.id);
            driftedAt = (await rowOf(domain.id)).driftedAt!;
          }, 30_000);

          it('23 days drifted sends one warning', async () => {
            clock.set(driftedAt.getTime() + 23 * DAY);
            await checkWhenDue(domain.id);
            expect(await rowOf(domain.id)).toMatchObject({
              releaseWarnedAt: clock.now(),
              state: 'drifted',
            });

            // The hourly checks after it warn no more.
            await checkWhenDue(domain.id);
            await checkWhenDue(domain.id);

            await onePerRecipient('domain-release-warning', domain.hostname);
          });

          it('30 days drifted: removing, then removed through deregistration, with one domain-released mail', async () => {
            clock.set(driftedAt.getTime() + 30 * DAY);

            await expect(checkWhenDue(domain.id)).resolves.toMatchObject({
              transition: { failureReason: null, from: 'drifted', to: 'removing' },
            });
            expect(await auditRows(seeded.orgId, 'domain.removal-requested', domain.id)).toEqual([
              expect.objectContaining({ actorId: null }),
            ]);
            expect(await outboxRows('domain.removing', domain.id)).toEqual([
              expect.objectContaining({
                payload: {
                  domainId: domain.id,
                  orgId: seeded.orgId,
                  projectId: seeded.projectId,
                  reason: null,
                },
              }),
            ]);

            // `domain.removing` reaches `DomainCheckConsumer` through the relay; the deregistration
            // is also due at once, so whichever claims it first settles it.
            await app.get(DomainChecker).checkOne(seeded.orgId, domain.id);
            expect(
              await until(async () => (await rowOf(domain.id)).state === 'removed', 5_000),
            ).toBe(true);
            expect(await rowOf(domain.id)).toMatchObject({ edgeId: null, failureReason: null });
            expect(edge.find(domain.hostname)).toBeUndefined();
            expect(await outboxRows('domain.removed', domain.id)).toHaveLength(1);

            // The API no longer reports it, and the hostname is free to add again.
            await http(app)
              .get(`${domainsPath(seeded)}/${domain.id}`)
              .set('Cookie', seeded.owner.cookie)
              .expect(404);

            await onePerRecipient('domain-released', domain.hostname);
            expect(sent('domain-release-warning', domain.hostname)).toHaveLength(recipients.length);
          });
        });

        it('a pending domain with issue "sectigo.com" on its parent shows caa blocked, naming the zone and record', async () => {
          const zone = `caa-${randomBytes(4).toString('hex')}.example.test`;
          const hostname = `shop.${zone}`;
          dns.set(zone, 'CAA', [{ critical: false, tag: 'issue', value: 'sectigo.com' }]);
          const response = await addDomain(seeded, seeded.owner.cookie, hostname).expect(201);
          const added = domainResponseSchema.parse(response.body).domain;

          await checkWhenDue(added.id);

          const read = await readDomain(seeded, added.id);
          expect(read.state).toBe('pending');
          expect(read.check?.caa).toEqual({
            record: '0 issue "letsencrypt.org"',
            verdict: 'blocked',
            zone,
          });
        });
      });

      // ---- shared by US4 and US5: checks of a tenant's own rows, as the sweep runs them ----

      async function rowIn(orgId: string, id: string) {
        const [row] = await inTenant(orgId, (tx) =>
          tx.select().from(schema.domains).where(eq(schema.domains.id, id)),
        );
        return row ?? expect.unreachable(`no domain ${id}`);
      }

      /** One check once `id` is due: the clock moves to its `next_check_at` if that is ahead. */
      async function checkDue(orgId: string, id: string): Promise<CheckRun> {
        const { nextCheckAt } = await rowIn(orgId, id);
        if (nextCheckAt.getTime() > clock.now().getTime()) clock.set(nextCheckAt);
        return app.get(DomainChecker).checkOne(orgId, id);
      }

      /** Adds `hostname`'s domain as `cookie`, publishes its records and checks it to `active`. */
      async function activated(
        ref: { orgId: string; projectId: string },
        cookie: string,
        hostname: string,
      ): Promise<Domain> {
        const response = await addDomain(ref, cookie, hostname).expect(201);
        const added = domainResponseSchema.parse(response.body).domain;
        publishRecords(added);
        edge.scriptStatus(hostname, [{ ssl: 'active', status: 'active' }]);
        await checkDue(ref.orgId, added.id);
        await expect(checkDue(ref.orgId, added.id)).resolves.toMatchObject({
          transition: { from: 'pending', to: 'active' },
        });
        return added;
      }

      function edgeDeletes(edgeId: string) {
        return edge.requests.filter(
          (request) => request.method === 'DELETE' && request.path.endsWith(`/${edgeId}`),
        );
      }

      // ---- US4 (T071): verification that never completes ends cleanly (SC-008) ----

      describe('verification that never completes ends cleanly (SC-008)', () => {
        let seeded: Seeded;

        function failedMails(hostname: string): MailMessage[] {
          return mailer.outbox.filter(
            (message) => message.template === 'domain-failed' && message.text.includes(hostname),
          );
        }

        /** Waits for the owner's `domain-failed` mail, then proves no second one follows. */
        async function oneFailedMail(hostname: string): Promise<void> {
          await awaitMail(
            mailer,
            (message) =>
              message.template === 'domain-failed' &&
              message.to === seeded.owner.email &&
              message.text.includes(hostname),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(failedMails(hostname).map((message) => message.to)).toEqual([seeded.owner.email]);
        }

        async function added(prefix: string): Promise<Domain> {
          const response = await addDomain(
            seeded,
            seeded.owner.cookie,
            freshHostname(prefix),
          ).expect(201);
          return domainResponseSchema.parse(response.body).domain;
        }

        beforeAll(async () => {
          seeded = await seedProject(world.alpha, 'Abandoned Domains');
        }, 30_000);

        describe('with no records created', () => {
          let domain: Domain;

          it("checks on T028's cadence and ends failed / verification-timeout at 72 h, never registered", async () => {
            domain = await added('never');
            const start = (await rowIn(seeded.orgId, domain.id)).windowStartedAt.getTime();
            const end = start + 72 * HOUR;
            /** R7's pending cadence by the window's age, for the check after one at `age`. */
            const cadence = (age: number) =>
              age < 10 * MINUTE ? MINUTE : age < HOUR ? 5 * MINUTE : age < DAY ? 15 * MINUTE : HOUR;

            const checkedAt: number[] = [];
            let run: CheckRun;
            do {
              run = await checkDue(seeded.orgId, domain.id);
              expect(run.kind).toBe('settled');
              checkedAt.push(clock.now().getTime());
              expect(checkedAt.length).toBeLessThan(500);
            } while (run.kind === 'settled' && run.transition === null);

            expect(checkedAt[0]).toBe(start);
            for (let check = 1; check < checkedAt.length; check++) {
              const previous = checkedAt[check - 1]!;
              expect(checkedAt[check]! - previous).toBe(
                Math.min(cadence(previous - start), end - previous),
              );
            }
            // 10 a minute apart, 10 five minutes apart, 92 every 15 minutes, then hourly to 72 h.
            expect(checkedAt).toHaveLength(10 + 10 + 92 + 49);
            expect(checkedAt.at(-1)).toBe(end);
            expect(run).toMatchObject({
              transition: { failureReason: 'verification-timeout', from: 'pending', to: 'failed' },
            });

            expect(await readDomain(seeded, domain.id)).toMatchObject({
              failureReason: 'verification-timeout',
              state: 'failed',
              windowEndsAt: null,
            });
            expect(await rowIn(seeded.orgId, domain.id)).toMatchObject({ edgeId: null });
            expect(edgePosts(domain.hostname)).toHaveLength(0);
            expect(await outboxRows('domain.failed', domain.id)).toHaveLength(1);
            expect(await auditRows(seeded.orgId, 'domain.failed', domain.id)).toHaveLength(1);
          });

          it('sends one domain-failed mail', async () => {
            await oneFailedMail(domain.hostname);
          });

          it('retry issues a new ownership value and a new window', async () => {
            const ownership = (of: Domain) =>
              of.records.find((record) => record.purpose === 'ownership')!.value;

            const response = await unsafe(
              http(app).post(`${domainsPath(seeded)}/${domain.id}/retry`),
              [seeded.owner.cookie],
            ).expect(200);
            const retried = domainResponseSchema.parse(response.body).domain;

            expect(retried).toMatchObject({
              failureReason: null,
              state: 'pending',
              windowEndsAt: new Date(clock.now().getTime() + 72 * HOUR).toISOString(),
            });
            expect(ownership(retried)).not.toBe(ownership(domain));
            expect(await auditRows(seeded.orgId, 'domain.retried', domain.id)).toHaveLength(1);
          });
        });

        it('a domain registered that never gets its certificate: removing, the edge DELETE, then failed / certificate-failed', async () => {
          const domain = await added('nocert');
          publishRecords(domain);
          edge.scriptStatus(domain.hostname, [{ ssl: 'pending_validation', status: 'active' }]);
          await checkDue(seeded.orgId, domain.id);
          const { edgeId, windowStartedAt } = await rowIn(seeded.orgId, domain.id);
          expect(edgeId).toBe(edge.find(domain.hostname)?.id);

          clock.set(windowStartedAt.getTime() + 72 * HOUR);
          await expect(checkDue(seeded.orgId, domain.id)).resolves.toMatchObject({
            transition: { failureReason: 'certificate-failed', from: 'pending', to: 'removing' },
          });
          expect(await outboxRows('domain.removing', domain.id)).toEqual([
            expect.objectContaining({
              payload: {
                domainId: domain.id,
                orgId: seeded.orgId,
                projectId: seeded.projectId,
                reason: 'certificate-failed',
              },
            }),
          ]);

          // `domain.removing` reaches `DomainCheckConsumer` through the relay; the deregistration
          // is also due at once, so whichever claims it first settles it.
          await app.get(DomainChecker).checkOne(seeded.orgId, domain.id);
          expect(
            await until(
              async () => (await rowIn(seeded.orgId, domain.id)).state === 'failed',
              5_000,
            ),
          ).toBe(true);
          expect(edgeDeletes(edgeId!)).toHaveLength(1);
          expect(edge.find(domain.hostname)).toBeUndefined();
          expect(await readDomain(seeded, domain.id)).toMatchObject({
            failureReason: 'certificate-failed',
            state: 'failed',
          });
          expect(await rowIn(seeded.orgId, domain.id)).toMatchObject({ edgeId: null });
          await oneFailedMail(domain.hostname);
        });

        it('check now runs within 30 s of the request, measured on the consumer; a second request is 429', async () => {
          const domain = await added('asked');
          await checkDue(seeded.orgId, domain.id);
          clock.advance(10_000);

          const consumer = app.get(DomainCheckConsumer);
          const effect = consumer.effect.bind(consumer);
          const ranAt: number[] = [];
          const spy = vi.spyOn(consumer, 'effect').mockImplementation(async (event) => {
            await effect(event);
            if (event.payload.domainId === domain.id) ranAt.push(Date.now());
          });
          try {
            const askedAt = Date.now();
            await unsafe(http(app).post(`${domainsPath(seeded)}/${domain.id}/check`), [
              seeded.owner.cookie,
            ]).expect(202);

            expect(await until(() => ranAt.length > 0, 30_000)).toBe(true);
            expect(ranAt[0]! - askedAt).toBeLessThan(30_000);
          } finally {
            spy.mockRestore();
          }
          // The consumer's check is the one that ran: at the request's time, not the schedule's.
          expect(await rowIn(seeded.orgId, domain.id)).toMatchObject({
            checkRequestedAt: clock.now(),
            claimedAt: null,
          });
          expect((await readDomain(seeded, domain.id)).check?.at).toBe(clock.now().toISOString());

          const again = await unsafe(http(app).post(`${domainsPath(seeded)}/${domain.id}/check`), [
            seeded.owner.cookie,
          ]).expect(429);
          expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
        });
      });

      // ---- US5 (T082): domains follow the project's lifecycle (SC-012) ----

      describe("domains follow the project's lifecycle (SC-012)", () => {
        /** Both rows `removed`, within the bound, through the relay and `DomainCheckConsumer`. */
        async function allRemoved(orgId: string, ids: string[]): Promise<void> {
          const removed = await until(async () => {
            for (const id of ids) if ((await rowIn(orgId, id)).state !== 'removed') return false;
            return true;
          }, SERVING_BOUND_MS);
          expect(removed).toBe(true);
          for (const id of ids) expect(await rowIn(orgId, id)).toMatchObject({ edgeId: null });
        }

        it(
          'archiving the project: the gateway serves neither domain, the edge DELETE for the registered one, both removed',
          async () => {
            const seeded = await seedProject(world.alpha, 'Archived Domains');
            const release = siteArchive('Before the archive', 'app-archived.js');
            await deployLive(seeded, release.archive);
            const active = await activated(seeded, seeded.owner.cookie, freshHostname('archived'));
            const { edgeId } = await rowIn(seeded.orgId, active.id);
            const pendingResponse = await addDomain(
              seeded,
              seeded.owner.cookie,
              freshHostname('archived-pending'),
            ).expect(201);
            const pending = domainResponseSchema.parse(pendingResponse.body).domain;
            await servesWithin(active.hostname, 200, release.index);

            await unsafe(
              http(app).delete(
                `${ORGS}/${seeded.orgId}/workspaces/${world.alpha.workspaceId}/projects/${seeded.projectId}`,
              ),
              [seeded.owner.cookie],
            ).expect(204);

            // The `project.archived` consumer moves both to `removing`; the gateway serves neither.
            await servesWithin(active.hostname, 404);
            await servesWithin(pending.hostname, 404);
            await allRemoved(seeded.orgId, [active.id, pending.id]);
            expect(edgeDeletes(edgeId!)).toHaveLength(1);
            expect(edge.find(active.hostname)).toBeUndefined();
            for (const id of [active.id, pending.id]) {
              expect(await auditRows(seeded.orgId, 'domain.removal-requested', id)).toEqual([
                expect.objectContaining({ actorId: null }),
              ]);
              expect(await outboxRows('domain.removed', id)).toHaveLength(1);
            }
          },
          2 * DEPLOY_TIMEOUT_MS + 30_000,
        );

        describe('deleting the organisation', () => {
          let orgId: string | undefined;

          afterAll(async () => {
            if (orgId !== undefined) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
          });

          it("the sweep sends the deleted org's domains to removing; the edge DELETE, both removed", async () => {
            const owner = await signUpAndIn(app, 'domains-deleted-org');
            extraEmails.push(owner.email);
            const created = await unsafe(http(app).post(ORGS), [owner.cookie])
              .send({ name: 'Deleted Domains', slug: `t82-${randomUUID().slice(0, 8)}` })
              .expect(201);
            orgId = (created.body as { org: { id: string } }).org.id;
            const deletedOrg = orgId;
            const [workspace] = await inTenant(deletedOrg, (tx) =>
              tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
            );
            const seeded = await seedProject(
              { orgId: deletedOrg, owner, workspaceId: workspace!.id } as Tenant,
              'Deleted Org Domains',
            );
            const active = await activated(seeded, owner.cookie, freshHostname('deleted-org'));
            const { edgeId } = await rowIn(deletedOrg, active.id);
            const pendingResponse = await addDomain(
              seeded,
              owner.cookie,
              freshHostname('deleted-org-pending'),
            ).expect(201);
            const pending = domainResponseSchema.parse(pendingResponse.body).domain;

            await inTenant(deletedOrg, (tx) =>
              tx
                .update(schema.orgs)
                .set({ deletedAt: clock.now() })
                .where(eq(schema.orgs.id, deletedOrg)),
            );

            // The sweep's own probe, narrowed to this org: other suites' rows share the table.
            const repository = app.get(DomainRepository);
            const probeDue = repository.probeDue.bind(repository);
            const probe = vi
              .spyOn(repository, 'probeDue')
              .mockImplementation(async (...args) =>
                (await probeDue(...args)).filter((row) => row.orgId === deletedOrg),
              );
            try {
              await expect(app.get(DomainCheckSweepConsumer).sweep()).resolves.toMatchObject({
                due: 2,
                failed: 0,
              });
            } finally {
              probe.mockRestore();
            }

            await allRemoved(deletedOrg, [active.id, pending.id]);
            expect(edgeDeletes(edgeId!)).toHaveLength(1);
            expect(edge.find(active.hostname)).toBeUndefined();
            for (const id of [active.id, pending.id]) {
              expect(await auditRows(deletedOrg, 'domain.removal-requested', id)).toEqual([
                expect.objectContaining({ actorId: null }),
              ]);
            }
          });
        });
      });
    },
  );
});

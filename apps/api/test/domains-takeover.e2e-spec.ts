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
  removeDomainResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
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
import { WINDOW_MS } from '../src/modules/deploy/domains/domain.constants';
import { type CheckRun, DomainChecker } from '../src/modules/deploy/domains/domain-checker';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { BrokerListener, PlainBrokerTransport } from '../src/modules/preview/broker-listener';
import { BROKER_TRANSPORT } from '../src/modules/preview/preview.constants';
import { DAYTONA_TIMINGS, DEFAULT_DAYTONA_TIMINGS } from '../src/modules/sandbox/sandbox.constants';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { type FakeCloudflare, startFakeCloudflare } from './support/fake-cloudflare';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { FakeDns } from './support/fake-dns';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Tenant,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Before any import (as `domains.e2e-spec.ts`): the relay and the build worker run in-process, and
 * the `CLOUDFLARE_*` group points the real adapter at the fake edge, whose port is fixed here.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // `events` relays the outbox, so `domain.removing` reaches `DomainCheckConsumer` as in
  // production; `agent` drains `build.deploy`. No `cron`: no sweep runs, so a domain is otherwise
  // checked only when a case asks.
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.BROKER_TRANSPORT = 'plain';
  process.env.BROKER_SHARED_SECRET = 'e2e-broker-secret';
  process.env.PREVIEW_DOMAIN = 'forge-preview.localhost';
  // Not under `.localhost`, which is refused `invalid-hostname` before the reserved-suffix test
  // could be reached: the SITE_DOMAIN case must meet `reserved-hostname` itself.
  process.env.SITE_DOMAIN = 'forge-sites.test';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  const edgePort = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.CLOUDFLARE_API_TOKEN = 'cf_takeover_e2e_token';
  process.env.CLOUDFLARE_ZONE_ID = 'zone-takeover-e2e';
  process.env.CLOUDFLARE_API_URL = `http://127.0.0.1:${edgePort}/client/v4`;
  process.env.CUSTOM_HOSTNAME_TARGET = 'customers.forge-edge.test';

  return { edgePort, port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const SECRET = 'e2e-broker-secret';
const EDGE_SECRET = 'e2e-edge-origin-secret-takeover-0123456789';
const SITE_DOMAIN = 'forge-sites.test';
const TEMPLATE: ProjectTemplate = 'vite-react';
const SNAPSHOT = 'forge-tpl-vite-react-takeover-e2e';
const BUCKET = 'forge-artifacts-takeover-e2e';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const DEPLOY_TIMEOUT_MS = 20_000;
/** SC-005: after removal, the hostname serves nothing within 10 s at the serving tier. */
const SERVING_BOUND_MS = 10_000;
const MINUTE = 60_000;
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

/** A built site: one `index.html`, as a Vite build leaves `dist/`. */
function siteArchive(heading: string): { archive: Buffer; index: string } {
  const index = `<!doctype html><h1>${heading}</h1>`;
  const archive = Buffer.concat([
    member('./', '', '5'),
    member('./index.html', index),
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
  readonly orgId: string;
  readonly owner: Tenant['owner'];
  readonly projectId: string;
}

interface Served {
  readonly body: string;
  readonly status: number;
}

/**
 * Spec 028 US2 (T051): a hostname can never be taken over — SC-004 and SC-011 against the fakes.
 * The same stack as `domains.e2e-spec.ts`: the real API, Postgres, the queue and stream Redis
 * roles, the in-process relay and `build.deploy` worker, the edge as `startFakeCloudflare` behind
 * the real `CloudflareForSaasAdapter`, DNS as `FakeDns`, time as `FakeClock`, and the **real
 * gateway** spawned with `EDGE_ORIGIN_SECRET`.
 *
 * The gateway reaches the broker through a loopback relay the suite controls, which forwards
 * every request unchanged except the ones it is told to replay: a request for host B's record is
 * answered with host A's signed record, which the gateway must refuse.
 *
 * As in `domains.e2e-spec.ts`, a domain is checked by `DomainChecker.checkOne` for this suite's
 * own rows, never by a global sweep: other suites' rows share the table. The clock stands ten
 * days ahead of the host's, so no other suite's sweep finds these rows due, and moves forward
 * only. "Sweeps across 72 h" are checks at each due time up to the window's end; the window-end
 * rules themselves are US4's (T068) and are not reached here.
 */
describe('Domains: takeover (e2e)', () => {
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
      let relay: Server | undefined;
      /** Host asked for → host whose record the relay answers with instead. */
      const replays = new Map<string, string>();
      let replayed = 0;
      const clock = new FakeClock(Date.now() + 10 * 24 * 60 * MINUTE);
      const dns = new FakeDns();
      const repos = new MemoryObjectStore();
      const artifacts = new MemoryObjectStore();

      // ---- helpers ----

      const projectPath = (ref: { orgId: string; projectId: string }) =>
        `${ORGS}/${ref.orgId}/projects/${ref.projectId}`;
      const domainsPath = (ref: { orgId: string; projectId: string }) =>
        `${projectPath(ref)}/domains`;

      function addDomain(seeded: Seeded, hostname: string) {
        return unsafe(http(app).post(domainsPath(seeded)), [seeded.owner.cookie])
          .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
          .send({ hostname });
      }

      function removeDomain(ref: { orgId: string; projectId: string }, cookie: string, id: string) {
        return unsafe(http(app).delete(`${domainsPath(ref)}/${id}`), [cookie]).send();
      }

      async function readDomain(seeded: Seeded, id: string): Promise<Domain> {
        const response = await http(app)
          .get(`${domainsPath(seeded)}/${id}`)
          .set('Cookie', seeded.owner.cookie)
          .expect(200);
        return domainResponseSchema.parse(response.body).domain;
      }

      function checkOne(seeded: Seeded, id: string): Promise<CheckRun> {
        return app.get(DomainChecker).checkOne(seeded.orgId, id);
      }

      function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
        return transactions.runInTenantTransaction(orgId, fn);
      }

      async function stored(orgId: string, id: string) {
        const [row] = await inTenant(orgId, (tx) =>
          tx.select().from(schema.domains).where(eq(schema.domains.id, id)),
        );
        return row ?? expect.unreachable(`no domains row ${id}`);
      }

      /** Moves the clock to the row's due time, if it is ahead, and checks it. */
      async function checkWhenDue(seeded: Seeded, id: string): Promise<CheckRun> {
        const due = (await stored(seeded.orgId, id)).nextCheckAt.getTime();
        if (due > clock.now().getTime()) clock.set(due);
        return checkOne(seeded, id);
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

      function edgeDeletes(edgeId: string) {
        return edge.requests.filter(
          (request) => request.method === 'DELETE' && request.path.endsWith(`/${edgeId}`),
        );
      }

      /** A hostname under a `.test` zone, unique per run. */
      function freshHostname(prefix: string): string {
        return `${prefix}-${randomBytes(4).toString('hex')}.takeover.example.test`;
      }

      function recordOf(domain: Domain, purpose: 'ownership' | 'routing') {
        return domain.records.find((record) => record.purpose === purpose)!;
      }

      /** What the member publishes: the ownership TXT and the routing CNAME, as displayed. */
      function publishRecords(domain: Domain): void {
        const ownership = recordOf(domain, 'ownership');
        const routing = recordOf(domain, 'routing');
        dns.set(ownership.name, 'TXT', [ownership.value]);
        dns.set(routing.name, 'CNAME', routing.value);
      }

      /**
       * A refusal body with the per-request fields taken out: `instance` names the caller's own
       * path and `requestId` is fresh per request. Everything else must match to the byte.
       */
      function refusalBytes(body: unknown): string {
        const { instance, requestId, ...rest } = body as Record<string, unknown>;
        void instance;
        void requestId;
        return JSON.stringify(rest);
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

      /** `host` answers `status` (and `body`) within `ms`. */
      async function servesWithin(
        host: string,
        status: number,
        body?: string,
        ms = SERVING_BOUND_MS,
      ): Promise<void> {
        let last: Served | undefined;
        const seen = await until(async () => {
          last = await fromGateway(host, '/');
          return last.status === status && (body === undefined || last.body === body);
        }, ms);
        expect(seen, `${host} answered ${String(last?.status)} ${last?.body ?? ''}`).toBe(true);
      }

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
        let last: Deployment | undefined;
        const done = await until(async () => {
          const read = await http(app)
            .get(`${projectPath(seeded)}/deployments/${deployment.id}`)
            .set('Cookie', seeded.owner.cookie)
            .expect(200);
          last = deploymentResponseSchema.parse(read.body).deployment;
          return ['succeeded', 'failed', 'cancelled'].includes(last.state);
        }, DEPLOY_TIMEOUT_MS);
        if (!done) throw new Error(`deployment ${deployment.id} is still ${last?.state ?? '?'}`);
        expect(last!.state).toBe('succeeded');
        return last!;
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
        await inTenant(orgId, (tx) =>
          tx.insert(schema.checkpoints).values({
            files: [],
            gitSha,
            kind: 'baseline',
            label: 'Baseline: e2e',
            orgId,
            projectId: project.id,
          }),
        );
        await repos.put(mirrorKey(orgId, project.id), Buffer.from(`bundle of ${gitSha}`), {
          head: gitSha,
        });
        return { orgId, owner, projectId: project.id };
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

      /**
       * The loopback relay between the gateway and the broker: every request goes through
       * unchanged, headers and body, except `GET /broker/domains/<B>` for a B in `replays`, which
       * is sent on as `GET /broker/domains/<A>` — so the gateway receives A's signed record for B.
       */
      async function startBrokerRelay(brokerPort: number): Promise<number> {
        const prefix = '/broker/domains/';
        relay = createServer((req, res) => {
          let path = req.url ?? '/';
          if (req.method === 'GET' && path.startsWith(prefix)) {
            const asked = decodeURIComponent(path.slice(prefix.length));
            const instead = replays.get(asked);
            if (instead !== undefined) {
              replayed += 1;
              path = `${prefix}${encodeURIComponent(instead)}`;
            }
          }
          const upstream = httpRequest(
            {
              headers: req.headers,
              host: '127.0.0.1',
              method: req.method,
              path,
              port: brokerPort,
            },
            (answer) => {
              res.writeHead(answer.statusCode ?? 502, answer.headers);
              answer.pipe(res);
            },
          );
          upstream.on('error', () => res.writeHead(502).end());
          req.pipe(upstream);
        });
        return new Promise((resolve) =>
          relay!.listen(0, '127.0.0.1', () => resolve((relay!.address() as AddressInfo).port)),
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
            ARTIFACT_STORE_ACCESS_KEY_ID: 'AKIDTAKEOVERE2E',
            ARTIFACT_STORE_BUCKET: BUCKET,
            ARTIFACT_STORE_ENDPOINT: `http://127.0.0.1:${String(s3Port)}`,
            ARTIFACT_STORE_SECRET_ACCESS_KEY: 'takeover-e2e-read-only',
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
            // Short, so a state change is seen by the next request; SC-005 allows the 5 s default.
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
          apiToken: 'cf_takeover_e2e_token',
          port: FAKE.edgePort,
          zoneId: 'zone-takeover-e2e',
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
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
        await app.get(BrokerListener).listen();

        transactions = app.get(TenantTransactionRunner);
        db = app.get<ForgeDatabase>(APP_DATABASE);
        await publishFakeVersion(db, TEMPLATE, SNAPSHOT);
        world = await createTwoTenantWorld(app);

        const relayPort = await startBrokerRelay(app.get(BrokerListener).port!);
        await startGateway(relayPort, await startLoopbackS3());
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        gateway?.kill('SIGTERM');
        for (const server of [s3, relay]) {
          await new Promise<void>((resolve) =>
            server === undefined ? resolve() : server.close(() => resolve()),
          );
        }
        if (world) await destroyTwoTenantWorld(app, world);
        if (db) await dropFakeVersions(db, TEMPLATE);
        await app?.close();
        await edge?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      describe('a live domain of org A, and org B trying to take its hostname', () => {
        let a: Seeded;
        let b: Seeded;
        let hostname: string;
        let domain: Domain;
        const release = siteArchive('Org A');

        beforeAll(async () => {
          a = await seedProject(world.alpha, 'Takeover A');
          b = await seedProject(world.beta, 'Takeover B');
          await deployLive(a, release.archive);
          hostname = freshHostname('www');
        }, DEPLOY_TIMEOUT_MS + 30_000);

        it('A adds it, publishes its records, and it goes active and serves', async () => {
          domain = domainResponseSchema.parse(
            (await addDomain(a, hostname).expect(201)).body,
          ).domain;
          publishRecords(domain);

          // Registered on the first check, active once the edge says so.
          await checkWhenDue(a, domain.id);
          edge.scriptStatus(hostname, [{ ssl: 'active', status: 'active' }]);
          await expect(checkWhenDue(a, domain.id)).resolves.toMatchObject({
            transition: { from: 'pending', to: 'active' },
          });
          await servesWithin(hostname, 200, release.index);
        });

        it('org B, and org A itself, adding the live hostname get 409 hostname-unavailable with identical bodies (SC-011)', async () => {
          const fromB = await addDomain(b, hostname).expect(409);
          const fromA = await addDomain(a, hostname).expect(409);

          expect(fromB.body).toMatchObject({
            reason: 'hostname-unavailable',
            type: expect.stringContaining('conflict') as string,
          });
          expect(refusalBytes(fromB.body)).toBe(refusalBytes(fromA.body));
          // Nothing in the refusal says who holds it, or that anyone does.
          for (const leak of [a.orgId, a.projectId, domain.id, 'Takeover A']) {
            expect(JSON.stringify(fromB.body)).not.toContain(leak);
          }
          expect(edgePosts(hostname)).toHaveLength(1);
        });

        it('org B cannot remove, or read, org A’s domain', async () => {
          const path = `${domainsPath(a)}/${domain.id}`;
          const removal = await removeDomain(a, b.owner.cookie, domain.id);
          expect([403, 404]).toContain(removal.status);
          const read = await http(app).get(path).set('Cookie', b.owner.cookie);
          expect(read.status).toBe(removal.status);
          expect((await stored(a.orgId, domain.id)).state).toBe('active');
          await servesWithin(hostname, 200, release.index);
        });

        it('a gateway request with no edge header is refused', async () => {
          const around = await fromGateway(hostname, '/', false);
          expect(around.status).not.toBe(200);
          expect(around.body).not.toContain('Org A');
        });

        it("A's signed domain record replayed for host B is refused by the gateway", async () => {
          const other = freshHostname('replay');
          replays.set(other, hostname);

          const answered = await fromGateway(other, '/');

          expect(replayed).toBeGreaterThan(0);
          expect(answered.status).toBe(404);
          expect(answered.body).not.toContain('Org A');
          const unknown = await fromGateway(freshHostname('unknown'), '/');
          expect(answered).toEqual(unknown);
          // The record itself is good: asked for its own host, it serves.
          await servesWithin(hostname, 200, release.index);
        });

        it('a CNAME to the platform with no TXT, checked at every due time across 72 h, never registers or activates (SC-004)', async () => {
          const dangling = freshHostname('dangling');
          const claim = domainResponseSchema.parse(
            (await addDomain(b, dangling).expect(201)).body,
          ).domain;
          dns.set(dangling, 'CNAME', recordOf(claim, 'routing').value);
          const windowEnd = (await stored(b.orgId, claim.id)).windowStartedAt.getTime() + WINDOW_MS;

          let checks = 0;
          while ((await stored(b.orgId, claim.id)).nextCheckAt.getTime() < windowEnd) {
            const run = await checkWhenDue(b, claim.id);
            expect(run).toMatchObject({ kind: 'settled', transition: null });
            checks += 1;
          }

          // FR-008's cadence over the window: every minute, then 5, 15 and 60 minutes.
          expect(checks).toBeGreaterThan(150);
          expect(clock.now().getTime()).toBeGreaterThan(windowEnd - 2 * 60 * MINUTE);
          expect(await stored(b.orgId, claim.id)).toMatchObject({
            activatedAt: null,
            edgeId: null,
            ownershipVerifiedAt: null,
            state: 'pending',
          });
          expect(edgePosts(dangling)).toEqual([]);
          expect(edge.find(dangling)).toBeUndefined();
          const read = await readDomain(b, claim.id);
          expect(read.records.map((record) => [record.purpose, record.status])).toEqual([
            ['ownership', 'missing'],
            ['routing', 'found'],
          ]);
          expect(await outboxRows('domain.activated', claim.id)).toEqual([]);
          expect((await fromGateway(dangling, '/')).status).toBe(404);
        });

        it("a TXT carrying another row's token never verifies", async () => {
          const target = freshHostname('stale');
          const claim = domainResponseSchema.parse(
            (await addDomain(b, target).expect(201)).body,
          ).domain;
          // A's ownership value, published at B's challenge name, with a correct CNAME.
          dns.set(recordOf(claim, 'ownership').name, 'TXT', [recordOf(domain, 'ownership').value]);
          dns.set(target, 'CNAME', recordOf(claim, 'routing').value);

          for (let check = 0; check < 5; check += 1) {
            await expect(checkWhenDue(b, claim.id)).resolves.toMatchObject({
              kind: 'settled',
              transition: null,
            });
          }

          expect(await stored(b.orgId, claim.id)).toMatchObject({
            edgeId: null,
            ownershipVerifiedAt: null,
            state: 'pending',
          });
          expect(recordOf(await readDomain(b, claim.id), 'ownership').status).toBe('mismatch');
          expect(edgePosts(target)).toEqual([]);
        });

        it('A removes it with its TXT and CNAME still published: it stops serving at once, and while the edge DELETE fails the hostname stays held', async () => {
          const edgeId = (await stored(a.orgId, domain.id)).edgeId!;
          expect(edgeId).toBe(edge.find(hostname)?.id);
          // The removal's own `domain.removing` reaches `DomainCheckConsumer` through the relay,
          // whose first edge request (the DELETE) fails.
          edge.failNext(503);

          const response = await removeDomain(a, a.owner.cookie, domain.id).expect(202);
          const removed = removeDomainResponseSchema.parse(response.body);

          expect(removed.domain).toMatchObject({ id: domain.id, state: 'removing' });
          expect(removed.deletableRecords).toEqual(
            domain.records.map(({ name, type, value }) => ({ name, type, value })),
          );
          expect(await outboxRows('domain.removing', domain.id)).toEqual([
            expect.objectContaining({
              payload: {
                domainId: domain.id,
                orgId: a.orgId,
                projectId: a.projectId,
                reason: null,
              },
            }),
          ]);
          expect(await auditRows(a.orgId, 'domain.removal-requested', domain.id)).toEqual([
            expect.objectContaining({ actorId: a.owner.userId }),
          ]);

          // SC-005: the serving tier answers nothing within the bound, records or not.
          await servesWithin(hostname, 404, undefined, SERVING_BOUND_MS);
          const unknown = await fromGateway(freshHostname('unknown'), '/');
          expect(await fromGateway(hostname, '/')).toEqual(unknown);

          // The consumer tried at once and met the failure: still removing and registered, and
          // rescheduled a minute on (the backoff's first step), which is its settle landing.
          expect(await until(() => edgeDeletes(edgeId).length > 0, 10_000)).toBe(true);
          const retryAt = clock.now().getTime() + MINUTE;
          expect(
            await until(
              async () => (await stored(a.orgId, domain.id)).nextCheckAt.getTime() === retryAt,
              10_000,
            ),
          ).toBe(true);
          expect(await stored(a.orgId, domain.id)).toMatchObject({ edgeId, state: 'removing' });
          expect(edge.find(hostname)).toBeDefined();

          const refused = await addDomain(b, hostname).expect(409);
          expect(refused.body).toMatchObject({ reason: 'hostname-unavailable' });

          // Removing again answers the same, and the next attempt fails too.
          const again = removeDomainResponseSchema.parse(
            (await removeDomain(a, a.owner.cookie, domain.id).expect(202)).body,
          );
          expect(again.deletableRecords).toEqual(removed.deletableRecords);
          edge.failNext(503);
          await expect(checkWhenDue(a, domain.id)).resolves.toMatchObject({
            kind: 'settled',
            transition: null,
          });
          expect(edgeDeletes(edgeId).length).toBeGreaterThanOrEqual(2);
          expect((await stored(a.orgId, domain.id)).state).toBe('removing');
          await addDomain(b, hostname).expect(409);
          expect((await fromGateway(hostname, '/')).status).toBe(404);
        });

        it("once the edge confirms, B's add succeeds with a new token, and A's old TXT does not verify B", async () => {
          await expect(checkWhenDue(a, domain.id)).resolves.toMatchObject({
            transition: { failureReason: null, from: 'removing', to: 'removed' },
          });
          expect(edge.find(hostname)).toBeUndefined();
          expect(await stored(a.orgId, domain.id)).toMatchObject({
            edgeId: null,
            state: 'removed',
          });
          expect(await outboxRows('domain.removed', domain.id)).toHaveLength(1);
          // Removed domains are not listed, and not found.
          const list = domainListResponseSchema.parse(
            (await http(app).get(domainsPath(a)).set('Cookie', a.owner.cookie).expect(200)).body,
          );
          expect(list.items.map((item) => item.id)).not.toContain(domain.id);
          await removeDomain(a, a.owner.cookie, domain.id).expect(404);

          const claim = domainResponseSchema.parse(
            (await addDomain(b, hostname).expect(201)).body,
          ).domain;
          expect(claim.id).not.toBe(domain.id);
          expect(recordOf(claim, 'ownership').name).toBe(recordOf(domain, 'ownership').name);
          expect(recordOf(claim, 'ownership').value).not.toBe(recordOf(domain, 'ownership').value);

          // A's TXT and CNAME are still published (dangling): B proves nothing with them.
          for (let check = 0; check < 3; check += 1) {
            await expect(checkWhenDue(b, claim.id)).resolves.toMatchObject({
              kind: 'settled',
              transition: null,
            });
          }
          expect(await stored(b.orgId, claim.id)).toMatchObject({
            edgeId: null,
            ownershipVerifiedAt: null,
            state: 'pending',
          });
          expect(recordOf(await readDomain(b, claim.id), 'ownership').status).toBe('mismatch');
          expect(edgePosts(hostname)).toHaveLength(1);
          expect((await fromGateway(hostname, '/')).status).toBe(404);
        });
      });

      it('a wildcard and a hostname under SITE_DOMAIN are refused', async () => {
        const seeded = await seedProject(world.alpha, 'Takeover reserved');

        const wildcard = await addDomain(seeded, '*.acme.com').expect(409);
        expect(wildcard.body).toMatchObject({ reason: 'invalid-hostname' });

        const site = await addDomain(seeded, `shop.${SITE_DOMAIN}`).expect(409);
        expect(site.body).toMatchObject({ reason: 'reserved-hostname' });

        const list = domainListResponseSchema.parse(
          (await http(app).get(domainsPath(seeded)).set('Cookie', seeded.owner.cookie).expect(200))
            .body,
        );
        expect(list.items).toEqual([]);
      });
    },
  );
});

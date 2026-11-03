import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  linkedAccountListSchema,
  linkedAccountSchema,
  modelCatalogueResponseSchema,
  type RunResponse,
  runResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { OutgoingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  ANTHROPIC_TRANSPORT,
  type AgentTimings,
  type AnthropicTransport,
} from '../src/modules/agent/agent.constants';
import { InMemoryMailer } from '../src/modules/mail/in-memory.mailer';
import { MAILER } from '../src/modules/mail/mailer.port';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { run as byosProvider } from '../src/scripts/byos-provider';
import { unsafe } from './support/csrf-client';
import {
  type FakeAnthropic,
  type ScriptedReply,
  startFakeAnthropic,
} from './support/fake-anthropic';
import { type FakeByosProvider, startFakeByosProvider } from './support/fake-byos-provider';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { enumerateRoutes, fillRoutePath } from './support/route-enumerator';
import { seedProviderKey } from './support/seed-provider-key';
import { stepUp } from './support/step-up';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  FIXTURE_PASSWORD,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * The environment is read when `AppModule` loads, so the provider double's address — and the
 * complete `BYOS_OPENAI_*` set pointing at it — is fixed first. Only the configuration is set:
 * whether OpenAI is *offered* is the `byos_providers` row the operator command writes (R12).
 */
const FAKE = vi.hoisted(() => {
  // T061: the redaction sweep reads every record the process writes, at the level that emits most.
  process.env.LOG_LEVEL = 'trace';
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // T039: runs go over the real queue, so the worker and the relay are on.
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const base = `http://127.0.0.1:${port}`;
  process.env.BYOS_OPENAI_CLIENT_ID = 'fake-byos-client';
  process.env.BYOS_OPENAI_AUTHORIZE_URL = `${base}/authorize`;
  process.env.BYOS_OPENAI_TOKEN_URL = `${base}/token`;
  process.env.BYOS_OPENAI_REVOKE_URL = `${base}/revoke`;
  process.env.BYOS_OPENAI_API_BASE_URL = `${base}/api`;
  process.env.BYOS_OPENAI_SCOPES = 'openid email';
  // T039: the same double also stands in for the Anthropic subscription, whose model calls the
  // real Anthropic adapter makes (the double speaks the Messages SSE wire format).
  process.env.BYOS_ANTHROPIC_CLIENT_ID = 'fake-byos-client';
  process.env.BYOS_ANTHROPIC_AUTHORIZE_URL = `${base}/authorize`;
  process.env.BYOS_ANTHROPIC_TOKEN_URL = `${base}/token`;
  process.env.BYOS_ANTHROPIC_REVOKE_URL = `${base}/revoke`;
  process.env.BYOS_ANTHROPIC_API_BASE_URL = `${base}/api`;
  process.env.BYOS_ANTHROPIC_SCOPES = 'user:inference';

  const daytonaPort = port === 39_999 ? 20_000 : port + 1;
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${daytonaPort}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { daytonaPort, port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ROOT = join(__dirname, '..', '..', '..');
const sheet = (provider: string) => join(ROOT, 'docs', 'byos', `${provider}.md`);
const ME = '/api/v1/me/linked-accounts';
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 15_000;
/** Short, as the other run suites have them, so polls and batches land in test time. */
const TIMINGS: AgentTimings = {
  batchMs: 10,
  batchSize: 32,
  cancelPollMs: 20,
  summaryMs: 30_000,
  heartbeatMs: 200,
  leaseTtlMs: 1_000,
  providerAttempts: 3,
  providerBackoffBaseMs: 10,
  providerBackoffCapMs: 50,
  reaperMs: 60_000,
  staleAfterMs: 60_000,
};

/** The RFC 9457 `type` of a problem body. */
function typeOf(body: unknown): string {
  return (body as { type?: string }).type ?? '';
}

/**
 * Spec 032 US1 (the gate) and US2 (linking) through HTTP against the real application and the
 * provider double. Nothing here reaches a real provider.
 */
describe('BYOS (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the provider double', () => {
    let app: INestApplication;
    let db: ForgeDatabase;
    let migrator: pg.Pool;
    let fake: FakeByosProvider;
    let daytona: FakeDaytona;
    let platform: FakeAnthropic;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const mailer = new InMemoryMailer();
    const principals: Principal[] = [];
    const quiet = { err: () => undefined, out: () => undefined };
    /**
     * T061 (SC-003): everything the process writes to stdout (pino, at trace) and every body the
     * application answers under `/api/v1/`, for the whole suite. Swallowed rather than forwarded,
     * so a leak is asserted against here and never printed into a CI log.
     */
    const written: string[] = [];
    const answered: string[] = [];
    const restore: (() => void)[] = [];

    function captureSinks(): void {
      // Patched by hand, not `vi.spyOn`: the config's `restoreMocks` would undo a spy after the
      // first test, and this capture has to span the suite.
      const stdoutWrite = Object.getOwnPropertyDescriptor(process.stdout, 'write');
      process.stdout.write = (chunk: Uint8Array | string): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      };
      restore.push(() => {
        if (stdoutWrite === undefined) Reflect.deleteProperty(process.stdout, 'write');
        else Object.defineProperty(process.stdout, 'write', stdoutWrite);
      });
      const { end, write } = Object.getOwnPropertyDescriptors(OutgoingMessage.prototype);
      if (end === undefined || write === undefined) throw new Error('ServerResponse changed');
      const keep = (response: ServerResponse, chunk: unknown) => {
        if (!response.req?.url?.startsWith('/api/v1/')) return;
        if (typeof chunk === 'string') answered.push(chunk);
        else if (chunk instanceof Uint8Array) answered.push(Buffer.from(chunk).toString('utf8'));
      };
      ServerResponse.prototype.write = function (this: ServerResponse, chunk: unknown, ...rest) {
        keep(this, chunk);
        return Reflect.apply(write.value as (...args: unknown[]) => boolean, this, [
          chunk,
          ...rest,
        ]);
      } as typeof ServerResponse.prototype.write;
      ServerResponse.prototype.end = function (this: ServerResponse, chunk?: unknown, ...rest) {
        if (typeof chunk !== 'function') keep(this, chunk);
        return Reflect.apply(end.value as (...args: unknown[]) => ServerResponse, this, [
          chunk,
          ...rest,
        ]);
      } as typeof ServerResponse.prototype.end;
      restore.push(() => {
        // The patch shadows `OutgoingMessage`'s methods; deleting it uncovers them again.
        Reflect.deleteProperty(ServerResponse.prototype, 'end');
        Reflect.deleteProperty(ServerResponse.prototype, 'write');
      });
    }

    /** `byos_providers` is platform state forge_app may not delete; the migrator resets it. */
    async function resetProviders(): Promise<void> {
      await migrator.query(`delete from byos_providers`);
    }

    async function operator(args: Parameters<typeof byosProvider>[1]): Promise<number> {
      const log = vi.spyOn(console, 'log').mockImplementation(quiet.out);
      const error = vi.spyOn(console, 'error').mockImplementation(quiet.err);
      try {
        return await byosProvider(app, args);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    }

    async function signUp(label: string): Promise<Principal> {
      const principal = await signUpAndIn(app, `byos-${label}`);
      principals.push(principal);
      return principal;
    }

    /** A second session for the same person, through the real login. */
    async function signInAgain(principal: Principal): Promise<string> {
      const response = await unsafe(http(app).post('/api/v1/auth/login'))
        .set(
          'X-Forwarded-For',
          `198.35.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
        )
        .send({ email: principal.email, password: FIXTURE_PASSWORD })
        .expect(200);
      const header = (response.headers as unknown as Record<string, string[]>)['set-cookie']![0]!;
      return header.split(';')[0]!;
    }

    async function list(cookie: string) {
      const response = await http(app).get(ME).set('Cookie', [cookie]).expect(200);
      return linkedAccountListSchema.parse(response.body);
    }

    async function begin(
      cookie: string,
      provider: 'anthropic' | 'openai' = 'openai',
    ): Promise<{ code: string; state: string }> {
      await stepUp(app, cookie);
      const started = await unsafe(http(app).post(`${ME}/${provider}/begin`), [cookie]).expect(200);
      const body = started.body as { kind: string; url: string };
      expect(body.kind).toBe('redirect');
      // The person's browser at the provider: the double answers with a redirect to our callback.
      const answer = await fetch(body.url, { redirect: 'manual' });
      const back = new URL(answer.headers.get('location')!);
      expect(back.pathname).toBe(`/account/connected-accounts/${provider}/callback`);
      return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
    }

    function complete(
      cookie: string,
      body: { code: string; state: string },
      provider: 'anthropic' | 'openai' = 'openai',
    ) {
      return unsafe(http(app).post(`${ME}/${provider}/complete`), [cookie]).send(body);
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      captureSinks();
      fake = startFakeByosProvider({ clientId: 'fake-byos-client', port: FAKE.port });
      await fake.start();
      daytona = await startFakeDaytona({ port: FAKE.daytonaPort });
      fakeGit(daytona, (request) => ({ exitCode: 0, result: `ran: ${request.command}\n` }));
      platform = startFakeAnthropic();
      await platform.start();
      migrator = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATION_URL, max: 1 });
      await resetProviders();

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        // Calls on the organisation's key go to a loopback fake (`platform`, as it served the
        // retired platform key), never to api.anthropic.com; BYOS calls take the subscription's
        // own base URL (the double) from the credential (R9).
        .overrideProvider(ANTHROPIC_TRANSPORT)
        .useValue({ baseURL: platform.baseURL } satisfies AnthropicTransport)
        .overrideProvider(AGENT_TIMINGS)
        .useValue(TIMINGS)
        .overrideProvider(MAILER)
        .useValue(mailer)
        .compile();
      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();
      db = app.get<ForgeDatabase>(APP_DATABASE);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      for (const undo of restore.reverse()) undo();
      if (principals.length > 0) {
        await db.delete(schema.users).where(
          inArray(
            schema.users.id,
            principals.map((principal) => principal.userId),
          ),
        );
      }
      if (migrator) {
        await resetProviders();
        await migrator.end();
      }
      await app?.close();
      await fake?.close();
      await daytona?.close();
      await platform?.close();
      await suiteLock?.release();
    });

    describe('gate (US1)', () => {
      it('a fresh database offers nothing, and begin is 404', async () => {
        const person = await signUp('gate');

        expect(await list(person.cookie)).toEqual({ accounts: [], offered: [] });
        await stepUp(app, person.cookie);
        const refused = await unsafe(http(app).post(`${ME}/openai/begin`), [person.cookie]).expect(
          404,
        );
        expect(typeOf(refused.body)).toMatch(/not-found$/);
      });

      it('in-force offers openai; withdrawn offers nothing and mails each link once', async () => {
        const person = await signUp('gate-in-force');

        expect(
          await operator({ provider: 'openai', record: sheet('openai'), status: 'in-force' }),
        ).toBe(0);
        expect((await list(person.cookie)).offered).toEqual(['openai']);

        const now = new Date();
        const [seeded] = await db
          .insert(schema.linkedAccounts)
          .values({
            accessExpiresAt: now,
            accountLabel: 'seeded@example.com',
            grantSealed: Buffer.from('not-a-real-seal'),
            health: 'healthy',
            lastCheckedAt: now,
            linkedAt: now,
            provider: 'openai',
            userId: person.userId,
          })
          .returning({ id: schema.linkedAccounts.id });

        expect(await operator({ provider: 'openai', status: 'withdrawn' })).toBe(0);
        expect((await list(person.cookie)).offered).toEqual([]);
        const mails = await db
          .select({ payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(eq(schema.outbox.aggregateId, seeded!.id));
        expect(mails).toEqual([
          {
            payload: {
              kind: 'provider-withdrawn',
              provider: 'openai',
              recipientUserId: person.userId,
            },
          },
        ]);
        await db.delete(schema.linkedAccounts).where(eq(schema.linkedAccounts.id, seeded!.id));
      });
    });

    describe('link (US2)', () => {
      let alice: Principal;
      let label: string;

      beforeAll(async () => {
        expect(
          await operator({ provider: 'openai', record: sheet('openai'), status: 'in-force' }),
        ).toBe(0);
        alice = await signUp('alice');
        label = `alice-${randomUUID()}@example.com`;
        fake.signInAs(label);
      });

      it('begin needs a recent step-up: 403 step-up-required', async () => {
        const fresh = await signUp('no-step-up');
        const refused = await unsafe(http(app).post(`${ME}/openai/begin`), [fresh.cookie]).expect(
          403,
        );
        expect(typeOf(refused.body)).toMatch(/step-up-required$/);
      });

      it('the full redirect round trip answers 200 with the label and no token; a replay is 400', async () => {
        const answer = await begin(alice.cookie);
        const linked = await complete(alice.cookie, answer).expect(200);

        expect(linkedAccountSchema.parse(linked.body)).toEqual(linked.body);
        expect(linked.body).toMatchObject({ accountLabel: label, provider: 'openai' });
        expect(JSON.stringify(linked.body)).not.toMatch(/fake_(?:at|rt|code)_/);

        const replayed = await complete(alice.cookie, answer).expect(400);
        expect(typeOf(replayed.body)).toMatch(/oauth-state-invalid$/);
        expect((await list(alice.cookie)).accounts.map((account) => account.accountLabel)).toEqual([
          label,
        ]);
      });

      it('a completion from a second session of the same person is 400', async () => {
        const other = await signInAgain(alice);
        const answer = await begin(alice.cookie);

        const refused = await complete(other, answer).expect(400);
        expect(typeOf(refused.body)).toMatch(/oauth-state-invalid$/);
      });

      it('another person and an org owner see only their own, and no org route returns the label', async () => {
        const bob = await signUp('bob');
        const owner = await signUp('owner');
        expect(await list(bob.cookie)).toEqual({ accounts: [], offered: ['openai'] });
        expect((await list(owner.cookie)).accounts).toEqual([]);

        const slug = `byos-${randomUUID().slice(0, 8)}`;
        const created = await unsafe(http(app).post('/api/v1/orgs'), [owner.cookie])
          .send({ name: 'BYOS org', slug })
          .expect(201);
        const orgId = (created.body as { org: { id: string } }).org.id;
        await app.get(TenantTransactionRunner).runInTenantTransaction(orgId, (tx) =>
          tx.insert(schema.memberships).values({
            acceptedAt: new Date(),
            orgId,
            role: 'member',
            userId: alice.userId,
          }),
        );

        try {
          const orgReads = enumerateRoutes(app).filter(
            (route) =>
              route.method.toUpperCase() === 'GET' &&
              route.parameters.length === 1 &&
              route.parameters[0] === 'orgId',
          );
          expect(orgReads.length).toBeGreaterThan(0);
          for (const route of orgReads) {
            const response = await http(app)
              .get(fillRoutePath(route.path, { orgId }))
              .set('Cookie', [owner.cookie]);
            expect(JSON.stringify(response.body)).not.toContain(label);
          }
        } finally {
          await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
        }
      });

      it('relink replaces the account and the double records one revoke', async () => {
        const before = fake.revocations().length;
        await complete(alice.cookie, await begin(alice.cookie)).expect(200);

        expect(fake.revocations().length).toBe(before + 1);
        expect((await list(alice.cookie)).accounts).toHaveLength(1);
      });

      it('unlink answers 204, revokes once, and a second unlink is 404', async () => {
        const before = fake.revocations().length;
        await unsafe(http(app).delete(`${ME}/openai`), [alice.cookie]).expect(204);

        expect(fake.revocations().length).toBe(before + 1);
        expect((await list(alice.cookie)).accounts).toEqual([]);
        await unsafe(http(app).delete(`${ME}/openai`), [alice.cookie]).expect(404);
      });
    });
    /**
     * T039 (US3): runs on a subscription, against the double and the fake sandbox. A is the
     * organisation's owner, B an admin of the same organisation, both starting runs in the same
     * project on the same model.
     */
    describe('runs (US3)', () => {
      const MODEL = 'claude-sonnet-5';
      let world: TwoTenantWorld;
      let a: Principal;
      let b: Principal;
      let transactions: TenantTransactionRunner;

      function runsPath(): string {
        return `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
      }

      async function start(who: Principal, prompt = 'build it'): Promise<RunResponse> {
        const created = await unsafe(http(app).post(runsPath()), [who.cookie])
          .send({ model: MODEL, prompt })
          .expect(201);
        return runResponseSchema.parse(created.body);
      }

      async function waitFor(runId: string, status: RunResponse['status']) {
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        for (;;) {
          const read = await http(app)
            .get(`${runsPath()}/${runId}`)
            .set('Cookie', [a.cookie])
            .expect(200);
          const run = runResponseSchema.parse(read.body);
          if (run.status === status) return run;
          if (Date.now() > deadline) throw new Error(`waited for ${status}; run is ${run.status}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      async function row(runId: string) {
        const [found] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)),
        );
        return found!;
      }

      async function eventTypes(runId: string): Promise<string[]> {
        const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ type: schema.runEvents.type })
            .from(schema.runEvents)
            .where(eq(schema.runEvents.runId, runId))
            .orderBy(asc(schema.runEvents.seq)),
        );
        return rows.map((event) => event.type);
      }

      async function catalogue(who: Principal) {
        const response = await http(app)
          .get(`/api/v1/orgs/${world.alpha.orgId}/models`)
          .set('Cookie', [who.cookie])
          .expect(200);
        return modelCatalogueResponseSchema.parse(response.body);
      }

      async function link(who: Principal, label: string): Promise<void> {
        fake.signInAs(label);
        await complete(who.cookie, await begin(who.cookie, 'anthropic'), 'anthropic').expect(200);
      }

      /** The bearer tokens the double saw since `from`. */
      const callsSince = (from: number) => fake.callLog().slice(from);

      beforeAll(async () => {
        expect(
          await operator({ provider: 'anthropic', record: sheet('anthropic'), status: 'in-force' }),
        ).toBe(0);
        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);
        // The organisation's order, behind a person's own subscription: its key (platform
        // credits, the old fallback, are retired).
        await seedProviderKey(app, world.alpha);
        const { orgId, projectId } = world.alpha;
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app.get(SandboxService).register(tx, { daytonaId: daytona.sandboxId, orgId, projectId }),
        );
        a = world.alpha.owner;
        b = await signUp('runs-b');
        await transactions.runInTenantTransaction(orgId, async (tx) => {
          await tx
            .insert(schema.memberships)
            .values({ acceptedAt: new Date(), orgId, role: 'member', userId: b.userId });
          await tx
            .insert(schema.projectGrants)
            .values({ orgId, projectId, role: 'editor', userId: b.userId });
        });
        await link(a, `a-${randomUUID()}@example.com`);
      });

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
      });

      it("A's run on a subscription-served model uses A's bearer and records BYOS for A", async () => {
        const from = fake.callLog().length;
        const run = await start(a);
        await waitFor(run.id, 'succeeded');

        const bearers = callsSince(from);
        expect(bearers.length).toBeGreaterThan(0);
        expect(new Set(bearers).size).toBe(1);
        expect(bearers[0]).toMatch(/^fake_at_/);
        expect(await row(run.id)).toMatchObject({ credentialMode: 'BYOS', userId: a.userId });
      });

      it("B's run on the same project and model never carries A's token", async () => {
        const aFrom = fake.callLog().length;
        await waitFor((await start(a)).id, 'succeeded');
        const aToken = callsSince(aFrom)[0];

        const platformFrom = platform.requests.length;
        platform.script({
          reply: { stopReason: 'end_turn', text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } },
        });
        const unlinked = await start(b);
        await waitFor(unlinked.id, 'succeeded');
        expect(await row(unlinked.id)).toMatchObject({
          credentialMode: 'BYOK',
          userId: b.userId,
        });
        expect(platform.requests.length).toBeGreaterThan(platformFrom);

        await link(b, `b-${randomUUID()}@example.com`);
        const bFrom = fake.callLog().length;
        const own = await start(b);
        await waitFor(own.id, 'succeeded');
        const bBearers = callsSince(bFrom);
        expect(bBearers.length).toBeGreaterThan(0);
        expect(bBearers).not.toContain(aToken);
        expect(await row(own.id)).toMatchObject({ credentialMode: 'BYOS', userId: b.userId });
        await unsafe(http(app).delete(`${ME}/anthropic`), [b.cookie]).expect(204);
      });

      it('the catalogue says BYOS for A and not for B', async () => {
        const forA = await catalogue(a);
        const forB = await catalogue(b);

        expect(forA.models.find((model) => model.id === MODEL)?.credentialMode).toBe('BYOS');
        expect(forB.models.find((model) => model.id === MODEL)?.credentialMode).toBe('BYOK');
      });

      it('FR-015: a tool-call run and a cancelled run emit the same events on BYOS as on BYOK', async () => {
        const toolTurn: ScriptedReply = {
          stopReason: 'tool_use',
          toolUse: [{ id: 'tu_1', input: { path: 'README.md' }, name: 'fs_read' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        const done: ScriptedReply = {
          stopReason: 'end_turn',
          text: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
        };

        async function toolRun(who: Principal, script: () => void) {
          script();
          const run = await start(who, 'read the readme');
          await waitFor(run.id, 'succeeded');
          return run.id;
        }
        async function cancelledRun(who: Principal, script: () => void) {
          script();
          const run = await start(who, 'take your time');
          await waitFor(run.id, 'running');
          await new Promise((resolve) => setTimeout(resolve, 100));
          await unsafe(http(app).post(`${runsPath()}/${run.id}/cancel`), [who.cookie]).expect(202);
          await waitFor(run.id, 'cancelled');
          return run.id;
        }

        const byosTool = await toolRun(a, () => fake.script(toolTurn, done));
        const platformTool = await toolRun(b, () => {
          platform.script({ reply: toolTurn });
          platform.script({ reply: done });
        });
        const byosCancel = await cancelledRun(a, () => fake.script({ hang: true }));
        const platformCancel = await cancelledRun(b, () => platform.script({ hang: true }));

        expect((await row(byosTool)).credentialMode).toBe('BYOS');
        expect((await row(platformTool)).credentialMode).toBe('BYOK');
        expect(await eventTypes(byosTool)).toContain('tool.end');
        expect(await eventTypes(byosTool)).toEqual(await eventTypes(platformTool));
        expect(await eventTypes(byosCancel)).toEqual(await eventTypes(platformCancel));
      });

      it("after A unlinks, A's run takes the organisation's order: its key, BYOK", async () => {
        await unsafe(http(app).delete(`${ME}/anthropic`), [a.cookie]).expect(204);
        const from = fake.callLog().length;
        platform.script({
          reply: { stopReason: 'end_turn', text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } },
        });

        const run = await start(a);
        await waitFor(run.id, 'succeeded');

        expect((await row(run.id)).credentialMode).toBe('BYOK');
        expect(callsSince(from)).toEqual([]);
      });

      /** Polls `check` until it holds or the run timeout passes. */
      async function until(check: () => Promise<boolean>): Promise<boolean> {
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (await check()) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return check();
      }

      async function account(who: Principal) {
        return (await list(who.cookie)).accounts.find((found) => found.provider === 'anthropic');
      }

      function refusedStart(who: Principal, body: Record<string, unknown> = {}) {
        return unsafe(http(app).post(runsPath()), [who.cookie]).send({
          model: MODEL,
          prompt: 'build it',
          ...body,
        });
      }

      function byosMails(): { to: string }[] {
        return mailer.outbox.filter((message) => message.template === 'byos-account');
      }

      /** The `data` of the run's last `state` event. */
      async function lastState(runId: string): Promise<Record<string, unknown>> {
        const [event] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ data: schema.runEvents.data })
            .from(schema.runEvents)
            .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.type, 'state')))
            .orderBy(desc(schema.runEvents.seq))
            .limit(1),
        );
        return event!.data;
      }

      /** T045 (US5): a grant revoked at the provider is found, marked, and only A is told. */
      describe('revocation (US5)', () => {
        let label: string;

        beforeAll(async () => {
          label = `a-revoked-${randomUUID()}@example.com`;
          await link(a, label);
        });

        it('verify after a revoke reads needs_reauth and mails A once; a second verify sends none', async () => {
          fake.revoke(label);
          const before = byosMails().length;

          const first = await unsafe(http(app).post(`${ME}/anthropic/verify`), [a.cookie]).expect(
            200,
          );
          expect(linkedAccountSchema.parse(first.body).health).toBe('needs_reauth');
          expect(await until(() => Promise.resolve(byosMails().length > before))).toBe(true);

          const second = await unsafe(http(app).post(`${ME}/anthropic/verify`), [a.cookie]).expect(
            200,
          );
          expect(linkedAccountSchema.parse(second.body).health).toBe('needs_reauth');
          await new Promise((resolve) => setTimeout(resolve, 300));
          const sent = byosMails().slice(before);
          expect(sent.map((message) => message.to)).toEqual([a.email]);
          // Nobody else in A's organisation (B is a member) hears of it.
          expect(sent.map((message) => message.to)).not.toContain(b.email);
        });

        it("A's next run is refused 409 subscription-needs-reauth", async () => {
          const refused = await refusedStart(a).expect(409);
          expect(refused.body).toMatchObject({ reason: 'subscription-needs-reauth' });
        });

        it('reconnecting reads healthy and runs proceed on BYOS', async () => {
          await link(a, `a-back-${randomUUID()}@example.com`);
          expect((await account(a))?.health).toBe('healthy');

          const run = await start(a);
          await waitFor(run.id, 'succeeded');
          expect((await row(run.id)).credentialMode).toBe('BYOS');
        });

        it('a maintenance.due byos.verify through the outbox reaches the consumer and flips a revoked account', async () => {
          const revoked = `a-sweep-${randomUUID()}@example.com`;
          await link(a, revoked);
          fake.revoke(revoked);
          // Out of the sweep's hour: last checked two hours ago.
          await db
            .update(schema.linkedAccounts)
            .set({ lastCheckedAt: new Date(Date.now() - 2 * 60 * 60_000) })
            .where(eq(schema.linkedAccounts.userId, a.userId));

          const periodStart = new Date(Date.now()).toISOString();
          await db.transaction((tx) =>
            app.get(OutboxWriter).append(tx, {
              aggregateId: `byos.verify:${periodStart}`,
              payload: { job: 'byos.verify', periodStart },
              type: 'maintenance.due',
            }),
          );

          expect(await until(async () => (await account(a))?.health === 'needs_reauth')).toBe(true);
          await link(a, `a-after-sweep-${randomUUID()}@example.com`);
        });
      });

      /** T049 (US6): a subscription's limit is recorded, surfaced with its reset, never rerouted. */
      describe('limits (US6)', () => {
        beforeAll(async () => {
          if ((await account(a)) === undefined)
            await link(a, `a-limits-${randomUUID()}@example.com`);
        });

        afterAll(async () => {
          fake.rateLimit(false);
          await db
            .update(schema.linkedAccounts)
            .set({ limitedUntil: null })
            .where(eq(schema.linkedAccounts.userId, a.userId));
        });

        it('a 429 with a 2-hour reset fails credential with resetsAt; the card shows limitedUntil; health stays healthy', async () => {
          fake.rateLimit({ resetInSeconds: 7_200 });
          const before = Date.now();

          const run = await start(a);
          const ended = await waitFor(run.id, 'failed');
          fake.rateLimit(false);

          expect(ended.failureClass).toBe('credential');
          const state = await lastState(run.id);
          const resetsAt = Date.parse(state.resetsAt as string);
          expect(resetsAt).toBeGreaterThanOrEqual(before + 7_200_000 - 1_000);
          expect(resetsAt).toBeLessThanOrEqual(Date.now() + 7_200_000 + 1_000);
          const card = await account(a);
          expect(card?.health).toBe('healthy');
          expect(card?.limitedUntil).toBe(new Date(resetsAt).toISOString());
        });

        it("the next create is 409 subscription-limited with alternativeMode; credential: 'organisation' runs on the organisation's", async () => {
          const refused = await refusedStart(a).expect(409);
          expect(refused.body).toMatchObject({ reason: 'subscription-limited' });
          const alternative = (refused.body as { alternativeMode: string | null }).alternativeMode;
          expect(alternative).toBe('BYOK');

          platform.script({
            reply: {
              stopReason: 'end_turn',
              text: 'ok',
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          });
          const created = await refusedStart(a, { credential: 'organisation' }).expect(201);
          const run = runResponseSchema.parse(created.body);
          await waitFor(run.id, 'succeeded');
          expect((await row(run.id)).credentialMode).toBe(alternative);
        });

        it('a 429 without a reset gives no limitedUntil and no time', async () => {
          await db
            .update(schema.linkedAccounts)
            .set({ limitedUntil: null })
            .where(eq(schema.linkedAccounts.userId, a.userId));
          fake.rateLimit({});

          const run = await start(a);
          const ended = await waitFor(run.id, 'failed');
          fake.rateLimit(false);

          expect(ended.failureClass).toBe('credential');
          expect((await lastState(run.id)).resetsAt).toBeUndefined();
          const card = await account(a);
          expect(card?.limitedUntil).toBeNull();
          expect(card?.health).toBe('healthy');
        });
      });

      /** T052 (US7): the organisation decides whether personal subscriptions may be used. */
      describe('policy (US7)', () => {
        const policyPath = () => `/api/v1/orgs/${world.alpha.orgId}/settings/personal-accounts`;

        function setPolicy(allowed: boolean) {
          return unsafe(http(app).put(policyPath()), [a.cookie]).send({ allowed }).expect(200);
        }

        beforeAll(async () => {
          if ((await account(a)) === undefined)
            await link(a, `a-policy-${randomUUID()}@example.com`);
        });

        afterAll(async () => {
          await setPolicy(true);
        });

        it("off: A's next run is not BYOS, the catalogue shows no BYOS, and the change is audited", async () => {
          await setPolicy(false);

          platform.script({
            reply: {
              stopReason: 'end_turn',
              text: 'ok',
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          });
          const run = await start(a);
          await waitFor(run.id, 'succeeded');
          expect((await row(run.id)).credentialMode).toBe('BYOK');

          const models = (await catalogue(a)).models;
          expect(models.some((model) => model.credentialMode === 'BYOS')).toBe(false);

          const audits = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ actorId: schema.auditLog.actorId, metadata: schema.auditLog.metadata })
              .from(schema.auditLog)
              .where(
                and(
                  eq(schema.auditLog.orgId, world.alpha.orgId),
                  eq(schema.auditLog.action, 'org.personal-accounts-changed'),
                ),
              ),
          );
          expect(audits).toContainEqual({
            actorId: a.userId,
            metadata: expect.objectContaining({ from: true, to: false }) as unknown,
          });
        });

        it('on again: BYOS', async () => {
          await setPolicy(true);

          const run = await start(a);
          await waitFor(run.id, 'succeeded');
          expect((await row(run.id)).credentialMode).toBe('BYOS');
        });

        it('a run in progress when the setting changes finishes its attempt on its credential', async () => {
          let release!: () => void;
          fake.script({ wait: new Promise<void>((resolve) => (release = resolve)) });
          const from = fake.callLog().length;

          const run = await start(a);
          // The model call is in flight at the double, held there until `release`.
          expect(await until(() => Promise.resolve(fake.callLog().length > from))).toBe(true);
          expect((await row(run.id)).status).toBe('running');
          await setPolicy(false);
          release();

          await waitFor(run.id, 'succeeded');
          expect((await row(run.id)).credentialMode).toBe('BYOS');
          await setPolicy(true);
        });
      });

      /**
       * T061 · SC-003. Last, so it sees every path above: link (codes, verifiers, the first grant),
       * relink and unlink (revoke), runs (bearer on every model call), refresh, the 401 that reads
       * `needs_reauth`, the 429, the `maintenance.due` sweep and the mail. No byte string the double
       * issued or was shown, and no sealed grant, appears in any sink.
       */
      describe('redaction sweep (SC-003)', () => {
        it('no code, verifier, access token, refresh token or sealed grant reaches a log line, audit row, outbox payload, run event, mail or response body', async () => {
          // A refresh, so rotated refresh tokens are in the set too: expire A's token at the double
          // and at the row, then run once.
          const before = fake.refreshCount();
          fake.setAccessLifetime(3600);
          await migrator.query(
            `update linked_accounts set access_expires_at = now() - interval '1 minute' where user_id = $1`,
            [a.userId],
          );
          const run = await start(a);
          await waitFor(run.id, 'succeeded');
          expect(fake.refreshCount()).toBeGreaterThan(before);

          const sealed = await migrator.query<{ grant: Buffer }>(
            `select grant_sealed as grant from linked_accounts`,
          );
          const forbidden = [
            ...fake.secrets(),
            ...sealed.rows.flatMap(({ grant }) => [
              grant.toString('base64'),
              grant.toString('hex'),
            ]),
          ];
          // The vacuous pass this sweep must not be: something was issued, something was written.
          expect(fake.secrets().some((value) => value.startsWith('fake_code_'))).toBe(true);
          expect(fake.secrets().some((value) => value.startsWith('fake_rt_'))).toBe(true);
          expect(fake.secrets().some((value) => value.startsWith('fake_at_'))).toBe(true);
          expect(written.join('').length).toBeGreaterThan(0);
          expect(answered.length).toBeGreaterThan(0);

          const rows = async (table: string) =>
            (await migrator.query<{ row: string }>(`select t::text as row from ${table} t`)).rows
              .map(({ row }) => row)
              .join('\n');
          const sinks: Record<string, string> = {
            audit_log: await rows('audit_log'),
            'log lines': written.join(''),
            mail: JSON.stringify(mailer.deliveries),
            outbox: await rows('outbox'),
            'response bodies': answered.join('\n'),
            run_events: await rows('run_events'),
          };
          const leaks = Object.entries(sinks).flatMap(([sink, text]) =>
            forbidden
              .filter((value) => text.includes(value))
              .map((value) => `${sink}: ${value.slice(0, 12)}…`),
          );
          expect(leaks).toEqual([]);
        });
      });
    });
  });
});

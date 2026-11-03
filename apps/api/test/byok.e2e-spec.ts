import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  modelCatalogueResponseSchema,
  providerKeyListSchema,
  providerKeySchema,
  type RunResponse,
  runResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  LLM_PROVIDER,
} from '../src/modules/agent/agent.constants';
import { KEY_VERIFIERS, type KeyVerifiers } from '../src/modules/agent/byok/provider-key.service';
import type { KeyCheck } from '../src/modules/agent/llm-provider.port';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { ScriptedProvider } from './support/scripted-provider';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * As `agent-core.e2e-spec.ts`: the environment is read when `AppModule` loads, so the fake
 * Daytona's address and the platform key (a fake `sk-ant-…` the scripted provider receives and
 * nothing ever sends) are set first. US2–US4 run real runs over the real queue.
 */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.LOG_LEVEL = 'trace';
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-byok-e2e';

  return { key: process.env.ANTHROPIC_API_KEY, port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ANTHROPIC_KEY = `sk-ant-api03-${'a'.repeat(40)}wxyz`;
const ANTHROPIC_KEY_2 = `sk-ant-api03-${'b'.repeat(40)}1234`;
const OPENAI_KEY = `sk-proj-${'c'.repeat(40)}5678`;
const PROBLEM = 'https://forge.dev/problems/';
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** The relay ticks at 50 ms in tests and the provider answers at once; a scripted run is seconds. */
const RUN_TIMEOUT_MS = 15_000;
/** Short, so a `rate-limited` × budget run ends in test time (US3). */
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

/** Polls `predicate` until it holds or `ms` elapse. */
async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return predicate();
}

/**
 * Spec 020 US1 through HTTP against the real application with the two adapters' `verify` doubled:
 * the admin stores a key and gets back the two §05 derivatives, the member reads and is refused
 * at the door, the refusals carry their `reason`, the request log never carries the key (SC-002),
 * the audit trail has every step, and removal empties the list.
 */
describe('BYOK (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let world: TwoTenantWorld;
    let member: Principal;
    let admin: Principal;
    let transactions: TenantTransactionRunner;
    let logger: PinoLogger;
    let db: ForgeDatabase;
    let fake: FakeDaytona;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const provider = new ScriptedProvider();
    const verify = vi.fn<(apiKey: string) => Promise<KeyCheck>>();
    /** Every response body this suite received, for the SC-002 scan. */
    const bodies: unknown[] = [];
    /** Everything the process wrote to stdout while the key was in play. */
    const stdout: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);

    const keysOf = (orgId: string) => `/api/v1/orgs/${orgId}/provider-keys`;
    const runsOf = (tenant = world.alpha) =>
      `/api/v1/orgs/${tenant.orgId}/projects/${tenant.projectId}/runs`;

    /** A key stored the product's way, by the admin, with the verifier answering `ok`. */
    async function store(provider: 'anthropic' | 'openai', apiKey: string): Promise<void> {
      verify.mockResolvedValue('ok');
      await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/${provider}`), [admin.cookie])
        .send({ apiKey })
        .expect(200);
    }

    /** A run created by alpha's owner; the relay and the worker do the rest. */
    async function createRun(body: { prompt: string; model?: string }): Promise<RunResponse> {
      const response = await unsafe(http(app).post(runsOf()), [world.alpha.owner.cookie])
        .send(body)
        .expect(201);

      return runResponseSchema.parse(response.body);
    }

    /** Polls the `agent_runs` row until it reports `status`; resolves with the row. */
    async function waitFor(runId: string, status: RunResponse['status']) {
      const row = async () => {
        const [found] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)),
        );

        return found!;
      };

      expect(await until(async () => (await row()).status === status, RUN_TIMEOUT_MS)).toBe(true);

      return row();
    }

    /** The last `state` event's data: where the run ended and why. */
    async function ending(runId: string) {
      const events = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select({ data: schema.runEvents.data, type: schema.runEvents.type })
          .from(schema.runEvents)
          .where(eq(schema.runEvents.runId, runId))
          .orderBy(asc(schema.runEvents.seq)),
      );

      return events.filter((event) => event.type === 'state').at(-1)!.data as { reason?: string };
    }

    async function keyRow(provider: 'anthropic' | 'openai') {
      const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select()
          .from(schema.providerKeys)
          .where(
            and(
              eq(schema.providerKeys.orgId, world.alpha.orgId),
              eq(schema.providerKeys.provider, provider),
            ),
          ),
      );

      return row;
    }

    async function healthChanges() {
      return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select({ metadata: schema.auditLog.metadata })
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.orgId, world.alpha.orgId),
              eq(schema.auditLog.action, 'provider-key.health-changed'),
            ),
          )
          // Postgres row order is unspecified without this, and every caller asserts on
          // `.at(-1)`: without an ORDER BY the "last" row is whichever one came back last.
          .orderBy(asc(schema.auditLog.at), asc(schema.auditLog.id)),
      );
    }

    async function sandboxUpdatedAt(): Promise<number> {
      const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select({ updatedAt: schema.sandboxes.updatedAt })
          .from(schema.sandboxes)
          .where(eq(schema.sandboxes.projectId, world.alpha.projectId)),
      );

      return row!.updatedAt.getTime();
    }

    async function settled(): Promise<void> {
      // pino-http logs on response finish, one turn after supertest resolves.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      fake = await startFakeDaytona({ port: FAKE.port });
      fakeGit(fake, (request) => ({ exitCode: 0, result: `ran: ${request.command}\n` }));

      const verifiers: KeyVerifiers = { anthropic: { verify }, openai: { verify } };
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(KEY_VERIFIERS)
        .useValue(verifiers)
        .overrideProvider(LLM_PROVIDER)
        .useValue(provider)
        .overrideProvider(AGENT_TIMINGS)
        .useValue(TIMINGS)
        .compile();
      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      db = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      logger = await app.resolve(PinoLogger);
      world = await createTwoTenantWorld(app);
      // Alpha's project has the fake's sandbox; a run can reach the model.
      const { orgId, projectId } = world.alpha;
      await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
        app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
      );
      member = await signUpAndIn(app, 'member');
      admin = await signUpAndIn(app, 'admin');
      await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx.insert(schema.memberships).values([
          {
            acceptedAt: new Date(),
            orgId: world.alpha.orgId,
            role: 'member',
            userId: member.userId,
          },
          { acceptedAt: new Date(), orgId: world.alpha.orgId, role: 'admin', userId: admin.userId },
        ]),
      );

      // Wrapped by hand, not `vi.spyOn`: `restoreMocks: true` would undo a spy between tests, and
      // the capture has to span every test the key is alive in. Not forwarded: a failing redaction
      // test must not itself become the leak.
      process.stdout.write = (chunk: Uint8Array | string): boolean => {
        stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));

        return true;
      };
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      process.stdout.write = realWrite;
      if (world) await destroyTwoTenantWorld(app, world);
      const extras = [member, admin].filter(Boolean).map((principal) => principal.email);
      if (extras.length > 0) {
        await db.delete(schema.users).where(inArray(schema.users.email, extras));
      }
      await app?.close();
      await fake?.close();
      await suiteLock?.release();
    });

    it('admin PUT stores a verified key: 200 with lastFour and fingerprint only; the member GET sees it', async () => {
      verify.mockResolvedValue('ok');

      const stored = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/anthropic`), [
        admin.cookie,
      ])
        .send({ apiKey: ANTHROPIC_KEY })
        .expect(200);
      bodies.push(stored.body);

      expect(verify).toHaveBeenCalledWith(ANTHROPIC_KEY);
      const key = providerKeySchema.parse(stored.body);
      expect(key).toMatchObject({
        addedBy: { id: admin.userId },
        health: 'healthy',
        lastFour: 'wxyz',
        provider: 'anthropic',
      });
      expect(key.fingerprint).toMatch(/^sha256:[0-9a-f]{32}$/);
      expect(Object.keys(stored.body as object)).not.toContain('apiKey');

      const listed = await http(app)
        .get(keysOf(world.alpha.orgId))
        .set('Cookie', member.cookie)
        .expect(200);
      bodies.push(listed.body);
      expect(providerKeyListSchema.parse(listed.body).keys).toEqual([key]);
    });

    it('a member may read but not store or remove: permission-denied', async () => {
      const put = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/anthropic`), [
        member.cookie,
      ])
        .send({ apiKey: ANTHROPIC_KEY })
        .expect(403);
      bodies.push(put.body);
      expect(put.body).toMatchObject({ type: `${PROBLEM}permission-denied` });

      const removed = await unsafe(http(app).delete(`${keysOf(world.alpha.orgId)}/anthropic`), [
        member.cookie,
      ]).expect(403);
      bodies.push(removed.body);
      expect(removed.body).toMatchObject({ type: `${PROBLEM}permission-denied` });
    });

    it('the other organisation sees an empty list', async () => {
      const listed = await http(app)
        .get(keysOf(world.beta.orgId))
        .set('Cookie', world.beta.owner.cookie)
        .expect(200);
      bodies.push(listed.body);
      expect(listed.body).toEqual({ keys: [] });
    });

    it('a wrong-shape key is 422 wrong-shape before any provider call; a rejected one is 422 key-rejected; an unknown provider is 404', async () => {
      verify.mockClear();

      const shape = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/openai`), [
        admin.cookie,
      ])
        .send({ apiKey: 'not-a-key-but-long-enough-to-pass' })
        .expect(422);
      bodies.push(shape.body);
      expect(shape.body).toMatchObject({
        reason: 'wrong-shape',
        type: `${PROBLEM}validation-failed`,
      });
      expect(verify).not.toHaveBeenCalled();

      verify.mockResolvedValue('rejected');
      const rejected = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/openai`), [
        admin.cookie,
      ])
        .send({ apiKey: `sk-proj-${'c'.repeat(40)}5678` })
        .expect(422);
      bodies.push(rejected.body);
      expect(rejected.body).toMatchObject({
        reason: 'key-rejected',
        type: `${PROBLEM}validation-failed`,
      });

      verify.mockResolvedValue('unreachable');
      const unreachable = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/openai`), [
        admin.cookie,
      ])
        .send({ apiKey: `sk-proj-${'c'.repeat(40)}5678` })
        .expect(503);
      bodies.push(unreachable.body);
      expect(unreachable.body).toMatchObject({
        reason: 'could-not-verify',
        type: `${PROBLEM}service-unavailable`,
      });
      expect(unreachable.headers['retry-after']).toBe('30');

      const unknown = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/github`), [
        admin.cookie,
      ])
        .send({ apiKey: ANTHROPIC_KEY })
        .expect(404);
      bodies.push(unknown.body);
      expect(unknown.body).toMatchObject({ type: `${PROBLEM}not-found` });

      const listed = await http(app)
        .get(keysOf(world.alpha.orgId))
        .set('Cookie', admin.cookie)
        .expect(200);
      bodies.push(listed.body);
      expect(providerKeyListSchema.parse(listed.body).keys.map((k) => k.provider)).toEqual([
        'anthropic',
      ]);
    });

    it('a second PUT replaces the key: the new last four, still one row', async () => {
      verify.mockResolvedValue('ok');

      const replaced = await unsafe(http(app).put(`${keysOf(world.alpha.orgId)}/anthropic`), [
        admin.cookie,
      ])
        .send({ apiKey: ANTHROPIC_KEY_2 })
        .expect(200);
      bodies.push(replaced.body);
      expect(providerKeySchema.parse(replaced.body).lastFour).toBe('1234');

      const listed = await http(app)
        .get(keysOf(world.alpha.orgId))
        .set('Cookie', admin.cookie)
        .expect(200);
      bodies.push(listed.body);
      expect(providerKeyListSchema.parse(listed.body).keys.map((k) => k.lastFour)).toEqual([
        '1234',
      ]);
    });

    it('SC-002: no response, request log line or audit row carries either key; the sink censors apiKey', async () => {
      await settled();
      // The scrubber's own sink, driven with the key under the name the body carries: the censor
      // marker is the positive half of the proof, the absence below is the other.
      logger.info({ apiKey: ANTHROPIC_KEY }, 'provider-keys probe');
      await settled();

      const audit = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select()
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.orgId, world.alpha.orgId),
              like(schema.auditLog.action, 'provider-key.%'),
            ),
          ),
      );
      expect(audit.map((row) => row.action)).toEqual([
        'provider-key.added',
        'provider-key.replaced',
      ]);
      expect(audit[1]!.metadata).toMatchObject({ lastFour: '1234', provider: 'anthropic' });
      expect(audit[1]!.metadata).toHaveProperty('previousFingerprint');

      const responses = JSON.stringify(bodies);
      const logs = stdout.join('');
      const rows = JSON.stringify(audit);
      // An empty capture would pass every `not.toContain`; the vacuous pass is refused first.
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).toContain('provider-keys');
      expect(logs).toContain('[Redacted');

      for (const key of [ANTHROPIC_KEY, ANTHROPIC_KEY_2]) {
        expect(responses).not.toContain(key);
        expect(logs).not.toContain(key);
        expect(rows).not.toContain(key);
      }
    });

    it('admin DELETE is 204 and the list is empty; a second DELETE is not-found', async () => {
      await unsafe(http(app).delete(`${keysOf(world.alpha.orgId)}/anthropic`), [
        admin.cookie,
      ]).expect(204);

      const listed = await http(app)
        .get(keysOf(world.alpha.orgId))
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);
      bodies.push(listed.body);
      expect(listed.body).toEqual({ keys: [] });

      const again = await unsafe(http(app).delete(`${keysOf(world.alpha.orgId)}/anthropic`), [
        admin.cookie,
      ]).expect(404);
      bodies.push(again.body);
      expect(again.body).toMatchObject({ type: `${PROBLEM}not-found` });

      const audit = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, 'provider-key.removed')),
      );
      expect(audit).toHaveLength(1);
    });

    /** Spec 020 US2 (quickstart § 3): the organisation's key is what the run is made with, and the row says so. */
    describe('US2 — runs on the organisation’s key', () => {
      it('a run on an Anthropic model with a stored key is BYOK and the provider receives that key', async () => {
        await store('anthropic', ANTHROPIC_KEY);
        provider.script({ text: 'done' });

        const created = await createRun({ prompt: 'hello' });
        const run = await waitFor(created.id, 'succeeded');

        expect(run.credentialMode).toBe('BYOK');
        expect(provider.calls.at(-1)!.credential).toEqual({
          apiKey: ANTHROPIC_KEY,
          keyLastFour: 'wxyz',
          mode: 'BYOK',
          provider: 'anthropic',
        });
      });

      it('with the key removed the next run is PLATFORM on the platform key', async () => {
        await unsafe(http(app).delete(`${keysOf(world.alpha.orgId)}/anthropic`), [
          admin.cookie,
        ]).expect(204);
        provider.script({ text: 'done' });

        const created = await createRun({ prompt: 'hello again' });
        const run = await waitFor(created.id, 'succeeded');

        expect(run.credentialMode).toBe('PLATFORM');
        expect(provider.calls.at(-1)!.credential).toEqual({
          apiKey: FAKE.key,
          mode: 'PLATFORM',
          provider: 'anthropic',
        });
      });

      it('an OpenAI key puts gpt-5.2 in the catalogue and a run on it is BYOK with provider openai', async () => {
        await store('openai', OPENAI_KEY);

        const listed = await http(app)
          .get(`/api/v1/orgs/${world.alpha.orgId}/models`)
          .set('Cookie', member.cookie)
          .expect(200);
        bodies.push(listed.body);
        const catalogue = modelCatalogueResponseSchema.parse(listed.body);
        expect(catalogue.models.find((model) => model.id === 'gpt-5.2')).toMatchObject({
          available: true,
          credentialMode: 'BYOK',
          provider: 'openai',
        });

        provider.script({ text: 'done' });
        const created = await createRun({ model: 'gpt-5.2', prompt: 'hello openai' });
        const run = await waitFor(created.id, 'succeeded');

        expect(run.credentialMode).toBe('BYOK');
        expect(provider.calls.at(-1)!.model).toBe('gpt-5.2');
        expect(provider.calls.at(-1)!.credential).toEqual({
          apiKey: OPENAI_KEY,
          keyLastFour: '5678',
          mode: 'BYOK',
          provider: 'openai',
        });
      });

      it('a run on gpt-5.2 with no OpenAI key is 422', async () => {
        const listed = await http(app)
          .get(`/api/v1/orgs/${world.beta.orgId}/models`)
          .set('Cookie', world.beta.owner.cookie)
          .expect(200);
        expect(
          modelCatalogueResponseSchema.parse(listed.body).models.map((model) => model.id),
        ).not.toContain('gpt-5.2');

        const refused = await unsafe(http(app).post(runsOf(world.beta)), [world.beta.owner.cookie])
          .send({ model: 'gpt-5.2', prompt: 'hello' })
          .expect(422);
        bodies.push(refused.body);
        expect(refused.body).toMatchObject({ type: `${PROBLEM}validation-failed` });
      });
    });

    /** Spec 020 US3 (quickstart § 4): the provider's 401 is a `credential` failure, a marked key and a fast refusal. */
    describe('US3 — the provider says no', () => {
      it('a 401 on a BYOK run fails with class credential naming the last four, marks the key needs_reauth and audits it once', async () => {
        await store('anthropic', ANTHROPIC_KEY);
        provider.script({ fail: 'unauthorised' });
        const before = provider.calls.length;

        const created = await createRun({ prompt: 'try the bad key' });
        const run = await waitFor(created.id, 'failed');

        expect(run.failureClass).toBe('credential');
        expect(provider.calls.length - before).toBe(1);
        expect((await ending(created.id)).reason).toContain('wxyz');
        expect((await keyRow('anthropic'))!.health).toBe('needs_reauth');
        const changes = await healthChanges();
        expect(changes).toHaveLength(1);
        expect(changes[0]!.metadata).toMatchObject({ cause: 'run', runId: created.id });
      });

      it('SC-007: a second run on an Anthropic model is 409 needs-reauth with the last four, and the sandbox row is untouched', async () => {
        const updatedAt = await sandboxUpdatedAt();
        const before = provider.calls.length;

        const refused = await unsafe(http(app).post(runsOf()), [world.alpha.owner.cookie])
          .send({ prompt: 'again' })
          .expect(409);
        bodies.push(refused.body);
        expect(refused.body).toMatchObject({
          keyLastFour: 'wxyz',
          provider: 'anthropic',
          reason: 'needs-reauth',
          type: `${PROBLEM}conflict`,
        });
        expect(await sandboxUpdatedAt()).toBe(updatedAt);
        expect(provider.calls.length).toBe(before);
      });

      it('a run on an OpenAI model still succeeds on the healthy OpenAI key', async () => {
        provider.script({ text: 'done' });

        const created = await createRun({ model: 'gpt-5.2', prompt: 'hello openai' });
        const run = await waitFor(created.id, 'succeeded');

        expect(run.credentialMode).toBe('BYOK');
        expect(provider.calls.at(-1)!.credential.provider).toBe('openai');
      });

      it('rate-limited for the whole budget is a credential failure that leaves the key healthy; the next run is allowed', async () => {
        await store('anthropic', ANTHROPIC_KEY_2);
        provider.script(
          ...Array.from({ length: TIMINGS.providerAttempts }, () => ({
            fail: 'rate-limited' as const,
          })),
        );
        const before = provider.calls.length;

        const created = await createRun({ prompt: 'slow down' });
        const run = await waitFor(created.id, 'failed');

        expect(run.failureClass).toBe('credential');
        expect(provider.calls.length - before).toBe(TIMINGS.providerAttempts);
        expect((await ending(created.id)).reason).toContain('1234');
        expect((await keyRow('anthropic'))!.health).toBe('healthy');
        expect(await healthChanges()).toHaveLength(1);

        provider.script({ text: 'done' });
        const next = await createRun({ prompt: 'and again' });
        expect((await waitFor(next.id, 'succeeded')).credentialMode).toBe('BYOK');
      });
    });

    /** Spec 020 US4 (quickstart § 5): on-demand and scheduled verification, each transition audited once. */
    describe('US4 — health before a run', () => {
      const verifyPath = () => `${keysOf(world.alpha.orgId)}/anthropic/verify`;

      it('POST verify with the provider rejecting flips the key to needs_reauth with one audit row; a second verify adds none', async () => {
        verify.mockResolvedValue('rejected');

        const first = await unsafe(http(app).post(verifyPath()), [admin.cookie]).expect(200);
        bodies.push(first.body);
        expect(providerKeySchema.parse(first.body).health).toBe('needs_reauth');
        expect(await healthChanges()).toHaveLength(2);

        const second = await unsafe(http(app).post(verifyPath()), [admin.cookie]).expect(200);
        bodies.push(second.body);
        expect(providerKeySchema.parse(second.body).health).toBe('needs_reauth');
        expect(await healthChanges()).toHaveLength(2);
      });

      it('POST verify with the provider accepting flips it back to healthy', async () => {
        verify.mockResolvedValue('ok');

        const response = await unsafe(http(app).post(verifyPath()), [admin.cookie]).expect(200);
        bodies.push(response.body);
        expect(providerKeySchema.parse(response.body).health).toBe('healthy');
        expect(await healthChanges()).toHaveLength(3);
        expect((await healthChanges()).at(-1)!.metadata).toMatchObject({ cause: 'verify' });
      });

      it('a maintenance.due byok.verify through the outbox reaches the consumer and verifies every key not checked within the hour', async () => {
        const stale = new Date(Date.now() - 2 * 60 * 60_000);
        await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .update(schema.providerKeys)
            .set({ lastVerifiedAt: stale })
            .where(eq(schema.providerKeys.orgId, world.alpha.orgId)),
        );
        verify.mockClear();
        verify.mockResolvedValue('ok');

        // A period of this suite's own, so the consumer's job id collides with no scheduler's.
        const periodStart = new Date(Date.now()).toISOString();
        await db.transaction((tx) =>
          app.get(OutboxWriter).append(tx, {
            aggregateId: `byok.verify:${periodStart}`,
            payload: { job: 'byok.verify', periodStart },
            type: 'maintenance.due',
          }),
        );

        expect(
          await until(
            async () =>
              ((await keyRow('anthropic'))!.lastVerifiedAt?.getTime() ?? 0) > stale.getTime() &&
              ((await keyRow('openai'))!.lastVerifiedAt?.getTime() ?? 0) > stale.getTime(),
            RUN_TIMEOUT_MS,
          ),
        ).toBe(true);
        expect(verify.mock.calls.map(([apiKey]) => apiKey).sort()).toEqual(
          [ANTHROPIC_KEY_2, OPENAI_KEY].sort(),
        );
        expect(await healthChanges()).toHaveLength(3);
      });
    });
  });
});

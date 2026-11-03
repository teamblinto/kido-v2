import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type CompanionCommand,
  type CompanionRunEvent,
  runEventsResponseSchema,
  runResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { STREAM_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { AGENT_TIMINGS, type AgentTimings } from '../src/modules/agent/agent.constants';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { AgentHomeRepository } from '../src/modules/local-agent/agent-home.repository';
import {
  DEFAULT_LOCAL_AGENT_TIMINGS,
  LOCAL_AGENT_TIMINGS,
  type LocalAgentTimings,
} from '../src/modules/local-agent/local-agent.constants';
import { mintDeviceToken, sha256 } from '../src/modules/local-agent/secrets';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { type Frame, type OpenStream, openStream } from './support/sse';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import: the worker claims runs, homes are on, the Daytona is the fake's. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // The worker and the relay are on: a run goes through the real queue to the local executor.
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.LOCAL_AGENT_ENABLED = 'true';
  process.env.AGENT_HOME_ENABLED = 'true';
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

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const WAIT_MS = 20_000;
const COMPANION = '/api/v1/local-agent';

/**
 * Fast enough for test time. The start acknowledgement is 3 s (every case that starts a turn
 * answers it at once) and a turn's budget 64 KiB, which one full-size delta passes.
 */
const TIMINGS: LocalAgentTimings = {
  ...DEFAULT_LOCAL_AGENT_TIMINGS,
  cancelPollMs: 50,
  heartbeatMs: 1_000,
  interruptWaitMs: 1_000,
  offlineGraceMs: 1_000,
  readBlockMs: 100,
  runEventBudgetBytes: 64 * 1_024,
  startAckMs: 3_000,
};

const AGENT: AgentTimings = {
  batchMs: 10,
  batchSize: 32,
  cancelPollMs: 20,
  heartbeatMs: 200,
  leaseTtlMs: 1_000,
  providerAttempts: 3,
  providerBackoffBaseMs: 10,
  providerBackoffCapMs: 50,
  reaperMs: 60_000,
  staleAfterMs: 60_000,
  summaryMs: 30_000,
};

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function typeOf(body: unknown): string {
  return (body as { type?: string }).type ?? '';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The runner bridge (spec 040's wire, which spec 041's agent homes run on) through HTTP against
 * Postgres, Redis, the relay and the worker: the device token, the command stream and uplink,
 * ingest dedupe, turns, cross-person refusal and revocation, for subscription runs. An agent home
 * is seeded directly (its own lifecycle is `agent-home.e2e-spec.ts`'s) and this suite plays its
 * hosted runner. A person's own paired computer (spec 040) is retired: its token is refused.
 */
describe('Runner bridge (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, Redis, the worker and a fake Daytona',
    () => {
      let app: INestApplication;
      let port: number;
      let stream: Redis;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const open: OpenStream[] = [];
      const extraEmails: string[] = [];
      const homes = new Map<string, { deviceId: string; token: string }>();

      const db = () => app.get<ForgeDatabase>(APP_DATABASE);
      const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

      /**
       * The person's agent home as a started one would be: its `cloud` device holding a token we
       * know, the home `running`. One per person, as the product has it.
       */
      async function home(userId: string) {
        const known = homes.get(userId);
        if (known !== undefined) return known;
        const token = mintDeviceToken();
        const row = await app
          .get(AgentHomeRepository)
          .findOrCreate(userId, 'claude', sha256(token));
        await db()
          .update(schema.agentHomes)
          .set({ state: 'running' })
          .where(eq(schema.agentHomes.id, row.id));
        const seeded = { deviceId: row.deviceId, token };
        homes.set(userId, seeded);
        return seeded;
      }

      /** The runner's report: Claude Code signed in, which is what admits a subscription run. */
      async function report(token: string) {
        await http(app)
          .post(`${COMPANION}/status`)
          .set(bearer(token))
          .send({
            companionVersion: 'hosted',
            providers: [
              {
                auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
                checkedAt: new Date().toISOString(),
                installed: true,
                message: null,
                models: [{ id: 'sonnet', label: 'Sonnet' }],
                // A lie the server must not believe; it is recomputed.
                policy: { allowed: false, reason: 'stale' },
                provider: 'claude',
                version: '2.0.0',
              },
            ],
          })
          .expect(204);
      }

      async function connect(token: string) {
        const opened = await openStream(port, `${COMPANION}/connect`, { headers: bearer(token) });
        open.push(opened);
        const iterator = opened.frames[Symbol.asyncIterator]();

        /** The next frame of `type`, skipping heartbeats and anything else. */
        const next = async (type: string): Promise<Frame> => {
          const deadline = Date.now() + WAIT_MS;
          for (;;) {
            const result = await Promise.race([
              iterator.next(),
              sleep(Math.max(1, deadline - Date.now())).then(() => 'timeout' as const),
            ]);
            if (result === 'timeout') throw new Error(`timed out waiting for ${type}`);
            if (result.done === true) throw new Error(`stream ended waiting for ${type}`);
            if (result.value.event === type) return result.value;
          }
        };

        return { next, opened };
      }

      function post(token: string, runId: string, events: CompanionRunEvent[], turn = 1) {
        return http(app)
          .post(`${COMPANION}/runs/${runId}/events`)
          .set(bearer(token))
          .send({ events, turn });
      }

      function runsPath(): string {
        return `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
      }

      async function until(check: () => Promise<boolean>, what: string): Promise<void> {
        const deadline = Date.now() + WAIT_MS;
        while (!(await check())) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await sleep(50);
        }
      }

      async function statusOf(runId: string): Promise<string | undefined> {
        const read = await http(app)
          .get(`${runsPath()}/${runId}`)
          .set('Cookie', world.alpha.owner.cookie);
        return (read.body as { status?: string }).status;
      }

      async function reaches(runId: string, status: string): Promise<void> {
        await until(async () => (await statusOf(runId)) === status, `the run to be ${status}`);
      }

      async function eventsOf(runId: string) {
        return runEventsResponseSchema.parse(
          (
            await http(app)
              .get(`${runsPath()}/${runId}/events?after=0&limit=500`)
              .set('Cookie', world.alpha.owner.cookie)
              .expect(200)
          ).body,
        ).events;
      }

      /** The `state` event that failed the run. */
      async function failureOf(runId: string) {
        const failed = (await eventsOf(runId)).find(
          (event) => event.type === 'state' && event.data.to === 'failed',
        );
        return failed?.type === 'state' ? failed.data : undefined;
      }

      /** Another alpha member, who also holds `project:agent.run` (project editor). */
      async function member(label: string): Promise<Principal> {
        const who = await signUpAndIn(app, label);
        extraEmails.push(who.email);
        const { orgId, projectId } = world.alpha;
        await app.get(TenantTransactionRunner).runInTenantTransaction(orgId, async (tx) => {
          await tx
            .insert(schema.memberships)
            .values({ acceptedAt: new Date(), orgId, role: 'member', userId: who.userId });
          await tx
            .insert(schema.projectGrants)
            .values({ orgId, projectId, role: 'editor', userId: who.userId });
        });
        return who;
      }

      /** The owner's home, reporting and connected, with a run started on it and its `run.start` read. */
      async function started() {
        const runner = await home(world.alpha.owner.userId);
        await report(runner.token);
        const companion = await connect(runner.token);
        await companion.next('hello');
        const created = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
          .send({ prompt: 'say hello', subscription: { provider: 'claude' } })
          .expect(201);
        const run = runResponseSchema.parse(created.body);
        const start = JSON.parse((await companion.next('run.start')).data!) as CompanionCommand;

        return { companion, run, runner, start };
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });
        fakeGit(fake);
        fake.workspace.set(`${fake.workDir}/README.md`, {
          content: Buffer.from('# Demo\n'),
          kind: 'file',
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(LOCAL_AGENT_TIMINGS)
          .useValue(TIMINGS)
          .overrideProvider(AGENT_TIMINGS)
          .useValue(AGENT)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
        await app.listen(0);
        port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
        stream = app.get<Redis>(STREAM_REDIS);
        world = await createTwoTenantWorld(app);

        // A subscription run works on the project's sandbox, as a cloud run does.
        const { orgId, projectId } = world.alpha;
        await app
          .get(TenantTransactionRunner)
          .runInTenantScope({ orgId, userId: null }, (tx) =>
            app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
          );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterEach(async () => {
        for (const each of open.splice(0)) each.close();
        // 031: one holder per project; a case that leaves a run live would hold it for the next.
        await app.get(TenantTransactionRunner).runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .update(schema.agentRuns)
            .set({ endedAt: new Date(), leaseUntil: null, status: 'cancelled' })
            .where(notInArray(schema.agentRuns.status, ['succeeded', 'failed', 'cancelled'])),
        );
      });

      afterAll(async () => {
        // Devices and homes go with their people (`on delete cascade`).
        if (world) await destroyTwoTenantWorld(app, world);
        if (extraEmails.length > 0) {
          await db().delete(schema.users).where(inArray(schema.users.email, extraEmails));
        }
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      it('takes a bearer token with no cookie or CSRF token, and refuses an unknown or retired one', async () => {
        const runner = await home(world.alpha.owner.userId);
        await report(runner.token);
        const companion = await connect(runner.token);
        const hello = JSON.parse((await companion.next('hello')).data!) as CompanionCommand;
        expect(hello).toMatchObject({
          deviceId: runner.deviceId,
          policy: { claude: { allowedAuthMethods: ['subscription', 'api_key', 'cloud_provider'] } },
          type: 'hello',
        });

        const unknown = await http(app)
          .post(`${COMPANION}/status`)
          .set(bearer(`bld_${'A'.repeat(43)}`))
          .send({ companionVersion: '0.1.0', providers: [] })
          .expect(401);
        expect(typeOf(unknown.body)).toMatch(/local-agent-revoked$/);

        // A person's own computer paired under spec 040, even one migration 0056 somehow missed.
        const retired = mintDeviceToken();
        await db()
          .insert(schema.localAgentDevices)
          .values({
            companionVersion: '0.2.0',
            kind: 'local',
            name: 'Old laptop',
            platform: 'linux',
            tokenHash: sha256(retired),
            userId: world.alpha.owner.userId,
          });
        const refused = await http(app)
          .post(`${COMPANION}/status`)
          .set(bearer(retired))
          .send({ companionVersion: '0.2.0', providers: [] })
          .expect(401);
        expect(typeOf(refused.body)).toMatch(/local-agent-revoked$/);
        await http(app).get(`${COMPANION}/connect`).set(bearer(retired)).expect(401);
      });

      it('runs a turn in the home: run.start with the toolset, dedupe, awaiting input', async () => {
        const { run, runner, start } = await started();

        expect(start).toEqual({
          conversationKey: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
          model: null,
          prompt: 'say hello',
          provider: 'claude',
          resume: null,
          runId: run.id,
          toolset: expect.any(Array) as unknown,
          turn: 1,
          type: 'run.start',
        });

        const first: CompanionRunEvent[] = [
          { data: { providerSessionId: 'sess-e2e' }, seq: 1, type: 'session' },
          { data: { text: 'Hello' }, seq: 2, type: 'text.delta' },
        ];
        await post(runner.token, run.id, first).expect(204);
        // A retried batch after a reconnect: nothing is added twice.
        await post(runner.token, run.id, first).expect(204);
        expect(await stream.xlen(`local-agent:run:${run.id}:events:1`)).toBe(2);

        await post(runner.token, run.id, [
          { data: { costMicros: 41_250, inputTokens: 3, outputTokens: 2 }, seq: 3, type: 'usage' },
          { data: { status: 'completed' }, seq: 4, type: 'terminal' },
        ]).expect(204);
        await reaches(run.id, 'awaiting_input');

        const [row] = await app
          .get(TenantTransactionRunner)
          .runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx.execute<{
              content: string;
              provider_session_id: string | null;
              tool_mode: string;
              workspace_id: string | null;
            }>(
              sql`select r.provider_session_id, r.tool_mode, r.workspace_id, m.content
                  from local_agent_runs r
                  join run_messages m on m.org_id = r.org_id and m.run_id = r.run_id and m.role = 'assistant'
                  where r.run_id = ${run.id}`,
            ),
          )
          .then((result) => result.rows);
        expect(row).toEqual({
          content: 'Hello',
          provider_session_id: 'sess-e2e',
          tool_mode: 'sandbox',
          workspace_id: null,
        });
        // The CLI's own estimate of the turn is the run's cost.
        const [cost] = await app
          .get(TenantTransactionRunner)
          .runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ costMicros: schema.agentRuns.costMicros })
              .from(schema.agentRuns)
              .where(eq(schema.agentRuns.id, run.id)),
          );
        expect(cost).toEqual({ costMicros: 41_250 });
      });

      it('refuses another person’s runner posting for a run it does not own', async () => {
        const { run } = await started();
        const other = await home(world.beta.owner.userId);

        await post(other.token, run.id, [
          { data: { text: 'x' }, seq: 1, type: 'text.delta' },
        ]).expect(404);
      });

      it('lets only the starter answer a subscription run; another member may still cancel it', async () => {
        const other = await member('runner-other');
        const { companion, run, runner } = await started();

        await post(runner.token, run.id, [
          { data: { status: 'completed' }, seq: 1, type: 'terminal' },
        ]).expect(204);
        await reaches(run.id, 'awaiting_input');

        const input = await unsafe(http(app).post(`${runsPath()}/${run.id}/input`), [other.cookie])
          .send({ message: 'rm -rf /' })
          .expect(403);
        expect(typeOf(input.body)).toMatch(/forbidden$/);

        await unsafe(http(app).post(`${runsPath()}/${run.id}/input`), [world.alpha.owner.cookie])
          .send({ message: 'go on' })
          .expect(202);
        await companion.next('run.start');

        // Stopping is safe: any member with project:agent.run may cancel.
        await unsafe(http(app).post(`${runsPath()}/${run.id}/cancel`), [other.cookie]).expect(202);
        await reaches(run.id, 'cancelled');
      });

      it('ends a run cancelled while it waits for input, clears its state, and frees the project', async () => {
        const { run, runner } = await started();
        await post(runner.token, run.id, [
          { data: { status: 'completed' }, seq: 1, type: 'terminal' },
        ]).expect(204);
        await reaches(run.id, 'awaiting_input');

        await unsafe(http(app).post(`${runsPath()}/${run.id}/cancel`), [
          world.alpha.owner.cookie,
        ]).expect(202);
        expect(await statusOf(run.id)).toBe('cancelled');

        const events = await eventsOf(run.id);
        expect(events.at(-1)).toMatchObject({
          data: { from: 'awaiting_input', reason: 'cancelled-waiting', to: 'cancelled' },
          type: 'state',
        });
        const keys = ['turn', 'control', 'cursor'].map((key) => `local-agent:run:${run.id}:${key}`);
        await until(async () => (await stream.exists(...keys)) === 0, 'the run’s keys to go');

        // The run no longer holds the project: the next one reaches the runner.
        const next = await started();
        expect(next.start).toMatchObject({ runId: next.run.id, type: 'run.start' });
      });

      it('runs a follow-up turn as turn 2, refusing a late retry of turn 1', async () => {
        const { companion, run, runner } = await started();
        await post(runner.token, run.id, [
          { data: { text: 'Hello' }, seq: 1, type: 'text.delta' },
          { data: { status: 'completed' }, seq: 2, type: 'terminal' },
        ]).expect(204);
        await reaches(run.id, 'awaiting_input');

        // The turn is over: its events are refused, not filed into the next.
        await post(runner.token, run.id, [
          { data: { text: 'late' }, seq: 3, type: 'text.delta' },
        ]).expect(409);

        await unsafe(http(app).post(`${runsPath()}/${run.id}/input`), [world.alpha.owner.cookie])
          .send({ message: 'and again' })
          .expect(202);
        const second = JSON.parse((await companion.next('run.start')).data!) as CompanionCommand;
        expect(second).toMatchObject({
          prompt: 'and again',
          resume: null,
          runId: run.id,
          turn: 2,
        });

        // A late retry of turn 1, after turn 2 started: refused.
        await post(runner.token, run.id, [
          { data: { text: 'Hello' }, seq: 1, type: 'text.delta' },
        ]).expect(409);
        // Turn 2 numbers its events from 1 again, in a stream of its own.
        await post(
          runner.token,
          run.id,
          [
            { data: { text: 'Again' }, seq: 1, type: 'text.delta' },
            { data: { status: 'completed' }, seq: 2, type: 'terminal' },
          ],
          2,
        ).expect(204);
        await reaches(run.id, 'awaiting_input');
        expect(await stream.xlen(`local-agent:run:${run.id}:events:2`)).toBe(2);
      });

      it('refuses a subscription model that is not a plain token', async () => {
        const refused = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
          .send({
            model: '--dangerously-skip-permissions',
            prompt: 'hi',
            subscription: { provider: 'claude' },
          })
          .expect(422);
        expect(typeOf(refused.body)).toMatch(/validation-failed$/);
      });

      it('fails a run past its turn’s event budget, with the structured failure', async () => {
        const { run, runner } = await started();

        await post(runner.token, run.id, [
          { data: { text: 'x'.repeat(65_536) }, seq: 1, type: 'text.delta' },
        ]).expect(413);
        await reaches(run.id, 'failed');

        const failure = await failureOf(run.id);
        expect(failure?.reason).toContain('local-agent budget');
        expect(failure?.localAgentFailure).toEqual({
          class: 'provider',
          origin: 'subscription',
          provider: 'claude',
        });
      });

      it('fails a run the runner never picks up, though it stays online, in Settings words', async () => {
        const { run } = await started();

        await reaches(run.id, 'failed');
        const failure = await failureOf(run.id);
        expect(failure?.reason).toBe(
          'Your cloud workspace could not be reached — try again in a minute.',
        );
        expect(failure?.localAgentFailure).toEqual({
          class: 'transport',
          origin: 'subscription',
          provider: 'claude',
        });
      });

      // Last: it revokes the owner's home device.
      it('closes a stream at its next heartbeat once the device is revoked behind its back', async () => {
        const runner = await home(world.alpha.owner.userId);
        const companion = await connect(runner.token);
        await companion.next('hello');

        // No publish: as if the revocation's command were lost, or the account were deleted.
        await db()
          .update(schema.localAgentDevices)
          .set({ revokedAt: new Date() })
          .where(eq(schema.localAgentDevices.id, runner.deviceId));

        await companion.next('device.revoked');
      });
    },
  );
});

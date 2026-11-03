import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type CompanionCommand,
  type CompanionRunEvent,
  localAgentDeviceListSchema,
  pairingPreviewSchema,
  pairingTokenResponseSchema,
  runEventsResponseSchema,
  runResponseSchema,
  startPairingResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
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
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import {
  DEFAULT_LOCAL_AGENT_TIMINGS,
  LOCAL_AGENT_TIMINGS,
  type LocalAgentTimings,
} from '../src/modules/local-agent/local-agent.constants';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { type Frame, type OpenStream, openStream } from './support/sse';
import { stepUp } from './support/step-up';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // The worker and the relay are on: a run goes through the real queue to the local executor.
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.LOCAL_AGENT_ENABLED = 'true';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const WAIT_MS = 20_000;
const ME = '/api/v1/me/local-agents';
const COMPANION = '/api/v1/local-agent';

/**
 * Fast enough for test time; the pairing interval stays 1 s so the too-soon rule is visible. The
 * start acknowledgement is 3 s (every case that starts a turn answers it at once) and a turn's
 * budget 64 KiB, which one full-size delta passes.
 */
const TIMINGS: LocalAgentTimings = {
  ...DEFAULT_LOCAL_AGENT_TIMINGS,
  cancelPollMs: 50,
  heartbeatMs: 1_000,
  interruptWaitMs: 1_000,
  offlineGraceMs: 1_000,
  pairingIntervalSeconds: 1,
  readBlockMs: 100,
  runEventBudgetBytes: 64 * 1_024,
  startAckMs: 3_000,
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
 * Spec 040 through HTTP against Postgres, Redis, the relay and the worker: pairing with a device
 * token, the companion's command stream and uplink, run admission, one local run end to end with
 * an approval, ingest dedupe, cross-person refusal and revocation. This suite plays the companion.
 */
describe('Local agent bridge (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the worker', () => {
    let app: INestApplication;
    let port: number;
    let stream: Redis;
    let world: TwoTenantWorld;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const open: OpenStream[] = [];
    const extraEmails: string[] = [];

    async function pair(cookie: string, name = 'Test laptop') {
      const started = await http(app)
        .post(`${COMPANION}/pairings`)
        .send({ companionVersion: '0.1.0', name, platform: 'linux' })
        .expect(201);
      const { deviceCode, userCode } = startPairingResponseSchema.parse(started.body);

      await stepUp(app, cookie);
      await unsafe(http(app).post(`${ME}/pairings/approve`), [cookie])
        .send({ userCode })
        .expect(204);
      const token = await http(app)
        .post(`${COMPANION}/pairings/token`)
        .send({ deviceCode })
        .expect(200);
      const answer = pairingTokenResponseSchema.parse(token.body);

      if (answer.status !== 'approved') throw new Error(`pairing ${answer.status}`);

      return { deviceCode, deviceId: answer.deviceId, token: answer.deviceToken, userCode };
    }

    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

    async function report(token: string) {
      await http(app)
        .post(`${COMPANION}/status`)
        .set(bearer(token))
        .send({
          companionVersion: '0.1.1',
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
            {
              auth: { method: 'subscription', plan: 'Plus', status: 'authenticated' },
              checkedAt: new Date().toISOString(),
              installed: true,
              message: null,
              models: [],
              policy: { allowed: true, reason: null },
              provider: 'codex',
              version: '0.9.0',
            },
          ],
          workspaces: [{ id: 'ws1', label: 'app' }],
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

    /**
     * One device the later cases share: pairing is throttled per address (10 a minute), and this
     * suite would otherwise pair more than that.
     */
    let shared: Awaited<ReturnType<typeof pair>> | undefined;

    /**
     * A device (the shared one unless given), reporting and connected, with a run started on it
     * and its `run.start` read.
     */
    async function started(own?: Awaited<ReturnType<typeof pair>>) {
      shared ??= await pair(world.alpha.owner.cookie, 'Shared laptop');
      const device = own ?? shared;
      await report(device.token);
      const companion = await connect(device.token);
      await companion.next('hello');
      const created = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
        .send({
          localAgent: { deviceId: device.deviceId, provider: 'claude', workspaceId: 'ws1' },
          prompt: 'say hello',
        })
        .expect(201);
      const run = runResponseSchema.parse(created.body);
      const start = JSON.parse((await companion.next('run.start')).data!) as CompanionCommand;

      return { companion, device, run, start };
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(LOCAL_AGENT_TIMINGS)
        .useValue(TIMINGS)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();
      await app.listen(0);
      port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
      stream = app.get<Redis>(STREAM_REDIS);
      world = await createTwoTenantWorld(app);
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
      // Devices go with their people (`on delete cascade`).
      await destroyTwoTenantWorld(app, world);
      if (extraEmails.length > 0) {
        await app
          .get<ForgeDatabase>(APP_DATABASE)
          .delete(schema.users)
          .where(inArray(schema.users.email, extraEmails));
      }
      await app?.close();
      await suiteLock?.release();
    });

    it('pairs a companion: preview, step-up approval, the token exactly once', async () => {
      const cookie = world.alpha.owner.cookie;
      const started = await http(app)
        .post(`${COMPANION}/pairings`)
        .send({ companionVersion: '0.1.0', name: 'Pairing laptop', platform: 'macos' })
        .expect(201);
      const { deviceCode, userCode, verificationUri } = startPairingResponseSchema.parse(
        started.body,
      );

      expect(verificationUri).toContain(`/settings/local-agents?code=${userCode}`);

      const preview = await http(app)
        .get(`${ME}/pairings/${userCode}`)
        .set('Cookie', cookie)
        .expect(200);
      const shown = pairingPreviewSchema.parse(preview.body);
      expect(shown).toMatchObject({ name: 'Pairing laptop', platform: 'macos' });
      // When and from where, so a code someone else sent is recognisable as such.
      expect(Date.now() - Date.parse(shown.requestedAt)).toBeLessThan(WAIT_MS);
      expect(shown.requesterIp).toMatch(/(\.0\/24|::\/48)$/);

      await expect(
        http(app).post(`${COMPANION}/pairings/token`).send({ deviceCode }),
      ).resolves.toMatchObject({ body: { status: 'pending' }, status: 200 });

      const refused = await unsafe(http(app).post(`${ME}/pairings/approve`), [cookie])
        .send({ userCode })
        .expect(403);
      expect(typeOf(refused.body)).toMatch(/step-up-required$/);

      await stepUp(app, cookie);
      await unsafe(http(app).post(`${ME}/pairings/approve`), [cookie])
        .send({ userCode })
        .expect(204);

      // Inside the poll interval: still pending.
      await http(app)
        .post(`${COMPANION}/pairings/token`)
        .send({ deviceCode })
        .expect(200, { status: 'pending' });
      await sleep(TIMINGS.pairingIntervalSeconds * 1_000);

      const delivered = await http(app)
        .post(`${COMPANION}/pairings/token`)
        .send({ deviceCode })
        .expect(200);
      const answer = pairingTokenResponseSchema.parse(delivered.body);
      expect(answer.status).toBe('approved');

      await sleep(TIMINGS.pairingIntervalSeconds * 1_000);
      const spent = await http(app)
        .post(`${COMPANION}/pairings/token`)
        .send({ deviceCode })
        .expect(400);
      expect(typeOf(spent.body)).toMatch(/local-agent-pairing-invalid$/);

      const listed = await http(app).get(ME).set('Cookie', cookie).expect(200);
      expect(localAgentDeviceListSchema.parse(listed.body).devices).toContainEqual(
        expect.objectContaining({ name: 'Pairing laptop', online: false }),
      );

      // The person is told a computer was paired: one outbox row, ids only.
      if (answer.status !== 'approved') throw new Error('not approved');
      const notices = await app
        .get<ForgeDatabase>(APP_DATABASE)
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.type, 'mail.local-agent-paired'),
            eq(schema.outbox.aggregateId, answer.deviceId),
          ),
        );
      expect(notices).toEqual([
        {
          payload: { deviceId: answer.deviceId, recipientUserId: world.alpha.owner.userId },
        },
      ]);
    });

    it('answers pairing-invalid for an unknown user code', async () => {
      const refused = await http(app)
        .get(`${ME}/pairings/BCDF-GHJK`)
        .set('Cookie', world.alpha.owner.cookie)
        .expect(400);
      expect(typeOf(refused.body)).toMatch(/local-agent-pairing-invalid$/);
    });

    it('takes a bearer token with no cookie or CSRF token, and refuses an unknown one', async () => {
      const device = await pair(world.alpha.owner.cookie);

      await report(device.token);

      const listed = await http(app).get(ME).set('Cookie', world.alpha.owner.cookie).expect(200);
      const shown = localAgentDeviceListSchema
        .parse(listed.body)
        .devices.find((each) => each.id === device.deviceId)!;

      expect(shown.companionVersion).toBe('0.1.1');
      expect(shown.workspaces).toEqual([{ id: 'ws1', label: 'app' }]);
      // Recomputed: Claude Code on a subscription is allowed, Codex on a ChatGPT plan is not.
      expect(shown.providers.map((each) => [each.provider, each.policy.allowed])).toEqual([
        ['claude', true],
        ['codex', false],
      ]);

      const refused = await http(app)
        .post(`${COMPANION}/status`)
        .set(bearer(`bld_${'A'.repeat(43)}`))
        .send({ companionVersion: '0.1.0', providers: [], workspaces: [] })
        .expect(401);
      expect(typeOf(refused.body)).toMatch(/local-agent-revoked$/);
    });

    it('runs a turn on the device: run.start, an approval round trip, dedupe, awaiting input', async () => {
      const device = await pair(world.alpha.owner.cookie);
      await report(device.token);
      const companion = await connect(device.token);
      const hello = JSON.parse((await companion.next('hello')).data!) as CompanionCommand;

      expect(hello).toMatchObject({ deviceId: device.deviceId, type: 'hello' });

      const created = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
        .send({
          localAgent: {
            deviceId: device.deviceId,
            permissionMode: 'acceptEdits',
            provider: 'claude',
            workspaceId: 'ws1',
          },
          prompt: 'say hello',
        })
        .expect(201);
      const run = runResponseSchema.parse(created.body);

      const start = JSON.parse((await companion.next('run.start')).data!) as CompanionCommand;
      expect(start).toEqual({
        conversationKey: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
        model: null,
        permissionMode: 'acceptEdits',
        prompt: 'say hello',
        provider: 'claude',
        resume: null,
        runId: run.id,
        toolMode: 'workspace',
        turn: 1,
        type: 'run.start',
        workspaceId: 'ws1',
      });

      const first: CompanionRunEvent[] = [
        { data: { providerSessionId: 'sess-e2e' }, seq: 1, type: 'session' },
        { data: { text: 'Hello' }, seq: 2, type: 'text.delta' },
        {
          data: { detail: 'echo hi', kind: 'command', requestId: 'req-1', title: 'Run echo' },
          seq: 3,
          type: 'approval.request',
        },
      ];
      await post(device.token, run.id, first).expect(204);
      // A retried batch after a reconnect: nothing is added twice.
      await post(device.token, run.id, first).expect(204);
      expect(await stream.xlen(`local-agent:run:${run.id}:events:1`)).toBe(3);

      const approvals = `${runsPath()}/${run.id}/approvals/req-1`;
      await until(async () => {
        const answer = await unsafe(http(app).post(approvals), [world.alpha.owner.cookie]).send({
          decision: 'allow',
        });
        return answer.status === 204;
      }, 'the approval to be pending');

      const respond = JSON.parse(
        (await companion.next('approval.respond')).data!,
      ) as CompanionCommand;
      expect(respond).toEqual({
        decision: 'allow',
        requestId: 'req-1',
        runId: run.id,
        type: 'approval.respond',
      });

      // Answered once already: nothing is pending now.
      await unsafe(http(app).post(approvals), [world.alpha.owner.cookie])
        .send({ decision: 'deny' })
        .expect(409);

      await post(device.token, run.id, [
        { data: { inputTokens: 3, outputTokens: 2 }, seq: 4, type: 'usage' },
        { data: { status: 'completed' }, seq: 5, type: 'terminal' },
      ]).expect(204);

      await until(async () => {
        const read = await http(app)
          .get(`${runsPath()}/${run.id}`)
          .set('Cookie', world.alpha.owner.cookie);
        return (read.body as { status?: string }).status === 'awaiting_input';
      }, 'the run to await input');

      const events = runEventsResponseSchema.parse(
        (
          await http(app)
            .get(`${runsPath()}/${run.id}/events?after=0&limit=500`)
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200)
        ).body,
      ).events;
      expect(events.filter((event) => event.type.startsWith('approval.'))).toEqual([
        expect.objectContaining({
          data: { detail: 'echo hi', kind: 'command', requestId: 'req-1', title: 'Run echo' },
          type: 'approval.request',
        }),
        expect.objectContaining({
          data: { by: 'user', decision: 'allow', requestId: 'req-1' },
          type: 'approval.resolved',
        }),
      ]);

      const [row] = await app
        .get(TenantTransactionRunner)
        .runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx.execute<{ provider_session_id: string | null; content: string }>(
            sql`select r.provider_session_id, m.content from local_agent_runs r
                join run_messages m on m.org_id = r.org_id and m.run_id = r.run_id and m.role = 'assistant'
                where r.run_id = ${run.id}`,
          ),
        )
        .then((result) => result.rows);
      expect(row).toEqual({ content: 'Hello', provider_session_id: 'sess-e2e' });
    });

    it('refuses a run on an offline device, and a run on another person’s device', async () => {
      const device = await pair(world.alpha.owner.cookie);
      await report(device.token);
      const target = { deviceId: device.deviceId, provider: 'claude', workspaceId: 'ws1' };

      const offline = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
        .send({ localAgent: target, prompt: 'hi' })
        .expect(409);
      expect(typeOf(offline.body)).toMatch(/local-agent-offline$/);

      const companion = await connect(device.token);
      await companion.next('hello');

      const unknownWorkspace = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
        .send({ localAgent: { ...target, workspaceId: 'nope' }, prompt: 'hi' })
        .expect(404);
      expect(typeOf(unknownWorkspace.body)).toMatch(/local-agent-workspace-unknown$/);

      const beta = `/api/v1/orgs/${world.beta.orgId}/projects/${world.beta.projectId}/runs`;
      const foreign = await unsafe(http(app).post(beta), [world.beta.owner.cookie])
        .send({ localAgent: target, prompt: 'hi' })
        .expect(404);
      expect(typeOf(foreign.body)).toMatch(/not-found$/);

      // Nor can another person post events for a run they do not own.
      const other = await pair(world.beta.owner.cookie, 'Beta laptop');
      await post(other.token, '00000000-0000-4000-8000-000000000000', [
        { data: { text: 'x' }, seq: 1, type: 'text.delta' },
      ]).expect(404);
    });

    it('revokes a device: the stream says so and closes, and the token is refused', async () => {
      const device = await pair(world.alpha.owner.cookie);
      const companion = await connect(device.token);
      await companion.next('hello');

      await stepUp(app, world.alpha.owner.cookie);
      await unsafe(http(app).delete(`${ME}/${device.deviceId}`), [world.alpha.owner.cookie]).expect(
        204,
      );

      await companion.next('device.revoked');

      const refused = await http(app)
        .post(`${COMPANION}/status`)
        .set(bearer(device.token))
        .send({ companionVersion: '0.1.0', providers: [], workspaces: [] })
        .expect(401);
      expect(typeOf(refused.body)).toMatch(/local-agent-revoked$/);

      // Another person cannot revoke it either (it is gone from their view and from its owner's).
      await stepUp(app, world.beta.owner.cookie);
      await unsafe(http(app).delete(`${ME}/${device.deviceId}`), [world.beta.owner.cookie]).expect(
        404,
      );
    });

    it('lets only the starter answer a local run; another member may still cancel it', async () => {
      const other = await member('local-other');
      const { companion, device, run } = await started();
      await post(device.token, run.id, [
        {
          data: { detail: 'echo hi', kind: 'command', requestId: 'req-x', title: 'Run echo' },
          seq: 1,
          type: 'approval.request',
        },
      ]).expect(204);

      const approval = await unsafe(http(app).post(`${runsPath()}/${run.id}/approvals/req-x`), [
        other.cookie,
      ])
        .send({ decision: 'allow' })
        .expect(403);
      expect(typeOf(approval.body)).toMatch(/forbidden$/);

      await post(device.token, run.id, [
        { data: { status: 'completed' }, seq: 2, type: 'terminal' },
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

    it('ends a local run cancelled while it waits for input, clears its state, and frees the project', async () => {
      const { device, run } = await started();
      await post(device.token, run.id, [
        {
          data: { detail: 'echo hi', kind: 'command', requestId: 'req-c', title: 'Run echo' },
          seq: 1,
          type: 'approval.request',
        },
        { data: { status: 'completed' }, seq: 2, type: 'terminal' },
      ]).expect(204);
      await reaches(run.id, 'awaiting_input');

      await unsafe(http(app).post(`${runsPath()}/${run.id}/cancel`), [
        world.alpha.owner.cookie,
      ]).expect(202);
      expect(await statusOf(run.id)).toBe('cancelled');

      const events = await eventsOf(run.id);
      // Closed once, when the turn ended: the cancel finds nothing left open.
      expect(events.filter((event) => event.type === 'approval.resolved')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        data: { from: 'awaiting_input', reason: 'cancelled-waiting', to: 'cancelled' },
        type: 'state',
      });
      const keys = ['turn', 'control', 'approvals', 'cursor'].map(
        (key) => `local-agent:run:${run.id}:${key}`,
      );
      await until(async () => (await stream.exists(...keys)) === 0, 'the run’s keys to go');

      // The run no longer holds the project: the next one reaches the device.
      const next = await started();
      expect(next.start).toMatchObject({ runId: next.run.id, type: 'run.start' });
    });

    it('runs a follow-up turn as turn 2, refusing a late retry of turn 1', async () => {
      const { companion, device, run } = await started();
      await post(device.token, run.id, [
        { data: { text: 'Hello' }, seq: 1, type: 'text.delta' },
        { data: { status: 'completed' }, seq: 2, type: 'terminal' },
      ]).expect(204);
      await reaches(run.id, 'awaiting_input');

      // The turn is over: its events are refused, not filed into the next.
      await post(device.token, run.id, [
        { data: { text: 'late' }, seq: 3, type: 'text.delta' },
      ]).expect(409);

      await unsafe(http(app).post(`${runsPath()}/${run.id}/input`), [world.alpha.owner.cookie])
        .send({ message: 'and again' })
        .expect(202);
      const second = JSON.parse((await companion.next('run.start')).data!) as CompanionCommand;
      expect(second).toMatchObject({ prompt: 'and again', runId: run.id, turn: 2 });

      // A late retry of turn 1, after turn 2 started: refused.
      await post(device.token, run.id, [
        { data: { text: 'Hello' }, seq: 1, type: 'text.delta' },
      ]).expect(409);
      // Turn 2 numbers its events from 1 again, in a stream of its own.
      await post(
        device.token,
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

    it('refuses a local model that is not a plain token', async () => {
      const refused = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
        .send({
          localAgent: {
            deviceId: '00000000-0000-4000-8000-000000000000',
            provider: 'claude',
            workspaceId: 'ws1',
          },
          model: '--dangerously-skip-permissions',
          prompt: 'hi',
        })
        .expect(422);
      expect(typeOf(refused.body)).toMatch(/validation-failed$/);
    });

    it('fails a run past its turn’s event budget, with the structured failure', async () => {
      const { device, run } = await started();

      await post(device.token, run.id, [
        { data: { text: 'x'.repeat(65_536) }, seq: 1, type: 'text.delta' },
      ]).expect(413);
      await reaches(run.id, 'failed');

      const failure = await failureOf(run.id);
      expect(failure?.reason).toContain('local-agent budget');
      expect(failure?.localAgentFailure).toEqual({
        class: 'provider',
        origin: 'device',
        provider: 'claude',
      });
    });

    it('fails a run the companion never picks up, though it stays online', async () => {
      const { run } = await started();

      await reaches(run.id, 'failed');
      const failure = await failureOf(run.id);
      expect(failure?.reason).toContain('did not pick the run up');
      expect(failure?.localAgentFailure).toEqual({
        class: 'transport',
        origin: 'device',
        provider: 'claude',
      });
    });

    it('revoking a device fails its open run at once', async () => {
      const { device, run } = await started(await pair(world.alpha.owner.cookie, 'Revoked laptop'));
      await post(device.token, run.id, [
        { data: { text: 'working' }, seq: 1, type: 'text.delta' },
      ]).expect(204);

      await stepUp(app, world.alpha.owner.cookie);
      await unsafe(http(app).delete(`${ME}/${device.deviceId}`), [world.alpha.owner.cookie]).expect(
        204,
      );

      await reaches(run.id, 'failed');
      expect((await failureOf(run.id))?.reason).toContain('local-agent revoked');
    });

    // Last: it revokes the shared device.
    it('closes a stream at its next heartbeat once the device is revoked behind its back', async () => {
      shared ??= await pair(world.alpha.owner.cookie, 'Shared laptop');
      const device = shared;
      const companion = await connect(device.token);
      await companion.next('hello');

      // No publish: as if the revocation's command were lost, or the account were deleted.
      await app
        .get<ForgeDatabase>(APP_DATABASE)
        .update(schema.localAgentDevices)
        .set({ revokedAt: new Date() })
        .where(eq(schema.localAgentDevices.id, device.deviceId));

      await companion.next('device.revoked');
    });
  });
});

import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  problemDetailSchema,
  type RunEvent,
  runEventsResponseSchema,
  runResponseSchema,
  STREAM_RETRY_MS,
  streamEventSchema,
  streamResetEventSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { inArray, notInArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { AGENT_QUEUE, RUN_EXECUTOR } from '../src/modules/agent/agent.constants';
import { ScriptedExecutor } from '../src/modules/agent/scripted-executor';
import {
  DEFAULT_STREAM_TIMINGS,
  STREAM_TIMINGS,
  type StreamTimings,
  streamKey,
} from '../src/modules/agent/stream.constants';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import { collect, type Frame, openStream, type OpenStream } from './support/sse';
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
  process.env.RUN_PROFILES = 'api,agent,events,cron';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 20_000;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Six tool steps, a token after each, a breath between — quickstart step 1. */
const SIX_TOOLS = {
  script: Array.from({ length: 6 }, () => [
    { kind: 'tool' },
    { kind: 'token' },
    { kind: 'sleep', ms: 200 },
  ]).flat(),
};

type Knobs = { -readonly [K in keyof StreamTimings]: StreamTimings[K] };

function ids(frames: readonly Frame[]): number[] {
  return frames.filter((frame) => frame.id !== undefined).map((frame) => Number(frame.id));
}

function parsed(frame: Frame): RunEvent | ReturnType<typeof streamResetEventSchema.parse> {
  return streamEventSchema.parse(JSON.parse(frame.data ?? 'null'));
}

function isTerminalState(frame: Frame): boolean {
  if (frame.event !== 'state') {
    return false;
  }

  const event = parsed(frame) as Extract<RunEvent, { type: 'state' }>;

  return ['cancelled', 'failed', 'succeeded'].includes(event.data.to);
}

/**
 * Spec 009 US1 (SC-001, SC-002, SC-005, SC-006 e2e half, SC-008): two applications over one
 * Redis and one Postgres; a viewer tails a run on one, drops, and resumes from its last `id` on
 * the other with every durable seq exactly once. Frames are read as bytes over `node:http`.
 */
describe('Run event stream (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and every Redis role', () => {
    let appA: INestApplication;
    let appB: INestApplication;
    let portA: number;
    let portB: number;
    let world: TwoTenantWorld;
    let stream: Redis;
    /** Each application's knobs, kept so a case can lower the cap and put it back. */
    const timingsA: Knobs = { ...DEFAULT_STREAM_TIMINGS };
    const timingsB: Knobs = { ...DEFAULT_STREAM_TIMINGS, blockMs: 200, heartbeatMs: 200 };
    let suiteLock: { release: () => Promise<void> } | undefined;
    const extraEmails: string[] = [];

    function runsPath(projectId = world.alpha.projectId): string {
      return `${ORGS}/${world.alpha.orgId}/projects/${projectId}/runs`;
    }

    async function created(
      who: Principal,
      script: object | string,
      app: INestApplication = appA,
      projectId?: string,
    ): Promise<string> {
      const response = await unsafe(http(app).post(runsPath(projectId)), [who.cookie])
        .send({ prompt: typeof script === 'string' ? script : JSON.stringify(script) })
        .expect(201);

      return runResponseSchema.parse(response.body).id;
    }

    function open(
      port: number,
      runId: string,
      lastEventId?: number | string,
      who: Principal = world.alpha.owner,
    ): Promise<OpenStream> {
      return openStream(port, `${runsPath()}/${runId}/stream`, { cookie: who.cookie, lastEventId });
    }

    async function eventsOf(runId: string, after = 0) {
      const response = await http(appA)
        .get(`${runsPath()}/${runId}/events?after=${after}&limit=500`)
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);

      return runEventsResponseSchema.parse(response.body);
    }

    async function boot(timings: StreamTimings, streamClient?: Redis): Promise<INestApplication> {
      let builder = Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(RUN_EXECUTOR)
        .useClass(ScriptedExecutor)
        .overrideProvider(STREAM_TIMINGS)
        .useValue(timings);

      if (streamClient !== undefined) {
        builder = builder.overrideProvider(STREAM_REDIS).useValue(streamClient);
      }

      const moduleRef = await builder.compile();
      const app = moduleRef.createNestApplication();

      configureApplication(app);
      await app.init();
      await app.listen(0);

      return app;
    }

    function portOf(app: INestApplication): number {
      return ((app.getHttpServer() as Server).address() as AddressInfo).port;
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      appA = await boot(timingsA);
      // B heartbeats fast: the cadence case reads three of them in under a second (research R9).
      appB = await boot(timingsB);
      portA = portOf(appA);
      portB = portOf(appB);
      stream = appA.get<Redis>(STREAM_REDIS);
      world = await createTwoTenantWorld(appA);
      // Run create resolves a credential: the organisation's own key (platform credits are
      // retired), which the scripted executor never reads.
      await seedProviderKey(appA, world.alpha);
    }, LOCKED_BOOT_TIMEOUT_MS);

    /**
     * 031: a project has one holder. A case that leaves a run live would hold the shared fixture
     * project for every case after it, so each case ends with the fixture's runs ended —
     * directly, as a fixture reset, not through the product.
     */
    afterEach(async () => {
      for (const tenant of [world.alpha, world.beta]) {
        await appA.get(TenantTransactionRunner).runInTenantTransaction(tenant.orgId, (tx) =>
          tx
            .update(schema.agentRuns)
            .set({ endedAt: new Date(), leaseUntil: null, status: 'cancelled' })
            .where(notInArray(schema.agentRuns.status, ['succeeded', 'failed', 'cancelled'])),
        );
      }
    });

    afterAll(async () => {
      await destroyTwoTenantWorld(appA, world);

      if (extraEmails.length > 0) {
        await appA
          .get<ForgeDatabase>(APP_DATABASE)
          .delete(schema.users)
          .where(inArray(schema.users.email, extraEmails));
      }

      await appB?.close();
      await appA?.close();
      await suiteLock?.release();
    });

    async function until(check: () => Promise<boolean>, what: string): Promise<void> {
      const deadline = Date.now() + RUN_TIMEOUT_MS;

      while (!(await check())) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    async function statusOf(runId: string, app: INestApplication = appA): Promise<string> {
      const response = await http(app)
        .get(`${runsPath()}/${runId}`)
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);

      return runResponseSchema.parse(response.body).status;
    }

    /** Shared by the cases below: the six-tool run once it has finished, and its last seq. */
    let finished: { lastSeq: number; runId: string };

    it(
      'tails a live run and resumes from Last-Event-ID on another node with every durable seq exactly once',
      async () => {
        const runId = await created(world.alpha.owner, SIX_TOOLS);
        const first = await open(portA, runId);

        // SC-005: the headers and the opening bytes.
        expect(first.res.statusCode).toBe(200);
        expect(first.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        expect(first.res.headers['cache-control']).toBe('no-cache, no-transform');
        expect(first.res.headers['x-accel-buffering']).toBe('no');
        expect(first.res.headers['content-encoding']).toBeUndefined();
        expect(first.res.headers['content-length']).toBeUndefined();

        const before = await collect(
          first,
          (frame, seen) => seen.filter((f) => f.event === 'tool.end').length === 2,
        );

        first.close();

        expect(before[0]).toEqual({ retry: STREAM_RETRY_MS });
        expect(before.at(-1)?.event).toBe('tool.end');

        const last = ids(before).at(-1)!;

        // SC-002: the other application, from the last id seen, to the terminal frame and the close.
        const second = await open(portB, runId, last);
        const after = await collect(second);

        expect(after[0]).toEqual({ retry: STREAM_RETRY_MS });
        expect(isTerminalState(after.at(-1)!)).toBe(true);

        const page = await eventsOf(runId);
        const delivered = [...ids(before), ...ids(after)];

        // SC-001 / FR-009: every durable seq once, ascending, across the two connections.
        expect(delivered).toEqual(
          Array.from({ length: page.lastSeq }, (_unused, index) => index + 1),
        );

        // SC-006: durable frames are the 008 envelopes under the same seq; non-durable ones are on
        // the stream only, and a delta never precedes its tool.start.
        const frames = [...before, ...after].filter((frame) => frame.event !== undefined);
        const durable = frames.filter((frame) => frame.id !== undefined).map(parsed);

        expect(durable).toEqual(page.events);
        expect(page.events.map((event) => event.type)).not.toContain('token');
        expect(page.events.map((event) => event.type)).not.toContain('tool.delta');

        const tokens = frames.filter((frame) => frame.event === 'token');
        const deltas = frames.filter((frame) => frame.event === 'tool.delta');

        expect(tokens.length).toBeGreaterThanOrEqual(6);
        expect(tokens.every((frame) => frame.id === undefined)).toBe(true);
        expect(
          new Set(
            deltas.map((frame) => (parsed(frame) as { data: { stepId: string } }).data.stepId),
          ).size,
        ).toBe(6);

        for (const [index, frame] of frames.entries()) {
          if (frame.event !== 'tool.delta') {
            continue;
          }

          const { stepId } = (parsed(frame) as { data: { stepId: string } }).data;
          const start = frames.findIndex(
            (candidate) =>
              candidate.event === 'tool.start' &&
              (parsed(candidate) as { data: { stepId: string } }).data.stepId === stepId,
          );

          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThan(index);
        }

        finished = { lastSeq: page.lastSeq, runId };
      },
      RUN_TIMEOUT_MS,
    );

    it(
      'heartbeats with a comment frame, carrying no id, at the configured cadence',
      async () => {
        const runId = await created(world.alpha.owner, { script: [{ kind: 'await-input' }] });
        const viewer = await open(portB, runId);
        const startedAt = Date.now();
        const frames = await collect(
          viewer,
          (_frame, seen) => seen.filter((f) => f.comment === 'heartbeat').length === 3,
        );
        const elapsed = Date.now() - startedAt;

        viewer.close();

        const heartbeats = frames.filter((frame) => frame.comment === 'heartbeat');

        expect(heartbeats).toEqual([
          { comment: 'heartbeat' },
          { comment: 'heartbeat' },
          { comment: 'heartbeat' },
        ]);
        expect(elapsed).toBeLessThan(3_000);
      },
      RUN_TIMEOUT_MS,
    );

    describe('on a finished run (SC-008)', () => {
      it('answers 204 to a reconnect at its last seq', async () => {
        const viewer = await open(portA, finished.runId, finished.lastSeq);

        expect(viewer.res.statusCode).toBe(204);
        expect(await collect(viewer)).toEqual([]);
      });

      it('replays from 0 and closes after the terminal state frame', async () => {
        const viewer = await open(portB, finished.runId, 0);
        const frames = await collect(viewer);

        expect(ids(frames)).toEqual(
          Array.from({ length: finished.lastSeq }, (_unused, index) => index + 1),
        );
        expect(isTerminalState(frames.at(-1)!)).toBe(true);
      });

      it('answers one stream.reset from Postgres, then closes, once its key is gone', async () => {
        await stream.del(streamKey(finished.runId));

        const viewer = await open(portA, finished.runId, finished.lastSeq - 1);
        const frames = await collect(viewer);

        expect(frames.map((frame) => frame.event ?? 'retry')).toEqual(['retry', 'stream.reset']);
        expect(frames[1]?.id).toBe(String(finished.lastSeq));

        const reset = streamResetEventSchema.parse(JSON.parse(frames[1]?.data ?? 'null'));
        const page = await eventsOf(finished.runId);

        expect(reset.seq).toBe(finished.lastSeq);
        expect(reset.data.events).toEqual(page.events.slice(-1));
        expect(reset.data.run).toMatchObject({ id: finished.runId, status: 'succeeded' });
      });
    });

    /** US2 / SC-003: a seq the stream no longer holds is answered with one `stream.reset`. */
    describe('aged out', () => {
      /** The run that crossed the cap, the seq its first `stream.reset` carried, and its end. */
      let aged: { lastSeq: number; resetSeq: number; runId: string };

      function seqsAfter(after: number, to: number): number[] {
        return Array.from({ length: to - after }, (_unused, index) => after + index + 1);
      }

      async function firstSeqOnStream(runId: string): Promise<number | undefined> {
        const [entry] = await stream.xrange(streamKey(runId), '-', '+', 'COUNT', 1);

        return entry === undefined ? undefined : Number(entry[0].split('-')[0]);
      }

      /** `retry`, then exactly one `stream.reset` whose `id` is its snapshot's last seq. */
      function resetIn(frames: readonly Frame[]) {
        expect(frames.map((frame) => frame.event ?? 'retry').slice(0, 2)).toEqual([
          'retry',
          'stream.reset',
        ]);
        expect(frames.filter((frame) => frame.event === 'stream.reset')).toHaveLength(1);

        const reset = streamResetEventSchema.parse(JSON.parse(frames[1]?.data ?? 'null'));

        expect(frames[1]?.id).toBe(String(reset.seq));
        expect(reset.data.events.at(-1)?.seq).toBe(reset.seq);

        return reset;
      }

      /**
       * The cap is lowered for these runs only: at 8, with the instance's 4 KiB
       * `stream-node-max-bytes`, the `~` trim frees a node every dozen entries, and the six-tool
       * runs above would age out too. Both applications carry it because either consumer may
       * claim the run.
       */
      describe('past the cap', () => {
        const THIRTY_TOOLS = {
          script: Array.from({ length: 30 }, () => [
            { kind: 'tool' },
            { kind: 'sleep', ms: 50 },
          ]).flat(),
        };

        beforeAll(() => {
          timingsA.maxLen = 8;
          timingsB.maxLen = 8;
        });

        afterAll(() => {
          timingsA.maxLen = DEFAULT_STREAM_TIMINGS.maxLen;
          timingsB.maxLen = DEFAULT_STREAM_TIMINGS.maxLen;
        });

        it(
          "sends one stream.reset with the Postgres snapshot, then tails from the snapshot's last seq",
          async () => {
            const runId = await created(world.alpha.owner, THIRTY_TOOLS);
            const first = await open(portA, runId);
            const before = await collect(first, (_frame, seen) => ids(seen).length === 3);

            first.close();

            expect(ids(before)).toEqual([1, 2, 3]);

            await until(
              async () => ((await firstSeqOnStream(runId)) ?? 0) > 4,
              'the stream to trim past seq 4',
            );

            const second = await open(portB, runId, 3);
            const frames = await collect(second);
            const page = await eventsOf(runId, 3);
            const reset = resetIn(frames);

            // The snapshot is exactly Postgres past the requested seq, then only higher seqs, once.
            expect(reset.data.events).toEqual(
              page.events.filter((event) => event.seq <= reset.seq),
            );
            expect(reset.data.run).toMatchObject({ id: runId });
            expect(ids(frames.slice(2))).toEqual(seqsAfter(reset.seq, page.lastSeq));
            expect(isTerminalState(frames.at(-1)!)).toBe(true);

            aged = { lastSeq: page.lastSeq, resetSeq: reset.seq, runId };
          },
          RUN_TIMEOUT_MS,
        );

        it("sends a second stream.reset when the first one's seq has aged out too", async () => {
          expect(await firstSeqOnStream(aged.runId)).toBeGreaterThan(aged.resetSeq + 1);

          const viewer = await open(portA, aged.runId, aged.resetSeq);
          const frames = await collect(viewer);
          const reset = resetIn(frames);

          expect(frames).toHaveLength(2);
          expect(reset.seq).toBe(aged.lastSeq);
          expect(reset.data.events.map((event) => event.seq)).toEqual(
            seqsAfter(aged.resetSeq, aged.lastSeq),
          );
        });

        /** US3 / SC-009: the key expires, and `MAXLEN ~` overshoots by at most one radix node. */
        it('carries a TTL of at most 6 h and stays within one node of the cap', async () => {
          const key = streamKey(aged.runId);
          const [, nodeEntries] = await stream.config('GET', 'stream-node-max-entries');
          const ttl = await stream.ttl(key);
          const length = await stream.xlen(key);

          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(DEFAULT_STREAM_TIMINGS.ttlSeconds);
          expect(length).toBeLessThan(aged.lastSeq);
          expect(length).toBeLessThanOrEqual(timingsA.maxLen + Number(nodeEntries));
        });
      });

      it(
        'sends one stream.reset when the stream key is gone and the run is still live',
        async () => {
          const runId = await created(world.alpha.owner, {
            script: [
              { kind: 'tool' },
              { kind: 'tool' },
              { kind: 'await-input' },
              { kind: 'tool' },
              { kind: 'tool' },
            ],
          });
          const first = await open(portA, runId);
          const before = await collect(
            first,
            (_frame, seen) => seen.filter((f) => f.event === 'tool.end').length === 1,
          );

          first.close();

          const last = ids(before).at(-1)!;

          await until(async () => (await statusOf(runId)) === 'awaiting_input', 'awaiting_input');
          await stream.del(streamKey(runId));

          const second = await open(portB, runId, last);
          const head = await collect(second, (frame) => frame.event === 'stream.reset');
          const parked = await eventsOf(runId, last);
          const reset = resetIn(head);

          expect(reset.seq).toBe(parked.lastSeq);
          expect(reset.data.events).toEqual(parked.events);
          expect(reset.data.run).toMatchObject({ id: runId, status: 'awaiting_input' });

          // The tail is whatever the executor appends from now on — no second reset, nothing twice.
          await unsafe(http(appA).post(`${runsPath()}/${runId}/input`), [world.alpha.owner.cookie])
            .send({ message: 'go on' })
            .expect(202);

          const tail = await collect(second);
          const page = await eventsOf(runId, last);

          expect(tail.some((frame) => frame.event === 'stream.reset')).toBe(false);
          expect(ids(tail)).toEqual(seqsAfter(parked.lastSeq, page.lastSeq));
          expect(isTerminalState(tail.at(-1)!)).toBe(true);

          // US2 #5: a reconnect at the reset's own id is an ordinary resume while the stream holds it.
          const again = await collect(await open(portA, runId, reset.seq));

          expect(again.some((frame) => frame.event === 'stream.reset')).toBe(false);
          expect(ids(again)).toEqual(seqsAfter(reset.seq, page.lastSeq));
        },
        RUN_TIMEOUT_MS,
      );

      it.each([
        ["past the run's last seq", () => aged.lastSeq + 1],
        ['not an integer', () => 'abc'],
      ])('refuses a Last-Event-ID %s with validation-failed', async (_label, header) => {
        const response = await http(appA)
          .get(`${runsPath()}/${aged.runId}/stream`)
          .set('Cookie', world.alpha.owner.cookie)
          .set('Last-Event-ID', String(header()))
          .expect(422);

        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(problemDetailSchema.parse(response.body).type).toContain('validation-failed');
      });
    });

    /**
     * US4 / SC-004: the same cells `agent-run.e2e-spec.ts` proves for the run reads, against the
     * stream. A refusal is a problem document with none of the FR-012 headers — the guard answers
     * before the handler, and the handler writes nothing before its last throw.
     */
    describe('authorisation', () => {
      /** A signed-in account, optionally an alpha member, optionally holding a project role. */
      async function principal(
        label: string,
        access: { member?: boolean; projectRole?: 'commenter' | 'editor' | 'owner' | 'viewer' },
      ): Promise<Principal> {
        const who = await signUpAndIn(appA, label);

        extraEmails.push(who.email);

        const { orgId, projectId } = world.alpha;

        await appA.get(TenantTransactionRunner).runInTenantTransaction(orgId, async (tx) => {
          if (access.member) {
            await tx
              .insert(schema.memberships)
              .values({ acceptedAt: new Date(), orgId, role: 'member', userId: who.userId });
          }

          if (access.projectRole !== undefined) {
            await tx
              .insert(schema.projectGrants)
              .values({ orgId, projectId, role: access.projectRole, userId: who.userId });
          }
        });

        return who;
      }

      async function anotherProject(name: string): Promise<string> {
        const { orgId, owner, workspaceId } = world.alpha;
        const projects = appA.get(ProjectService);
        const project = await appA
          .get(TenantTransactionRunner)
          .runInTenantScope({ orgId, userId: owner.userId }, () =>
            projects.create({
              actorId: owner.userId,
              name,
              orgId,
              ownerId: owner.userId,
              workspaceId,
            }),
          );

        return project.id;
      }

      function attempt(who: Principal, path = `${runsPath()}/${finished.runId}/stream`) {
        return http(appA).get(path).set('Cookie', who.cookie).set('Last-Event-ID', '0');
      }

      it.each([
        ['a project owner', () => Promise.resolve(world.alpha.owner)],
        ['a project editor', () => principal('editor', { member: true, projectRole: 'editor' })],
        [
          'a project commenter',
          () => principal('commenter', { member: true, projectRole: 'commenter' }),
        ],
        ['a project viewer', () => principal('viewer', { member: true, projectRole: 'viewer' })],
      ])('lets %s open the stream', async (_label, who) => {
        const viewer = await open(portB, finished.runId, 0, await who());
        const frames = await collect(viewer);

        expect(viewer.res.statusCode).toBe(200);
        expect(viewer.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        expect(ids(frames).at(-1)).toBe(finished.lastSeq);
      });

      it.each([
        ['a member with no grant', () => principal('member', { member: true })],
        ['a signed-in outsider', () => Promise.resolve(world.outsider)],
        ['the other tenant’s owner', () => Promise.resolve(world.beta.owner)],
      ])('refuses %s with permission-denied and no stream headers', async (_label, who) => {
        const response = await attempt(await who()).expect(403);

        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.headers['x-accel-buffering']).toBeUndefined();
        expect(response.headers['cache-control'] ?? '').not.toContain('no-transform');
        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
      });

      it('answers the session guard’s uniform refusal to an unauthenticated open', async () => {
        const response = await http(appA).get(`${runsPath()}/${finished.runId}/stream`).expect(401);

        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.headers['x-accel-buffering']).toBeUndefined();
      });

      it('answers not-found for an unknown run and a run under another project', async () => {
        const { owner } = world.alpha;
        const otherProject = await anotherProject('Other');

        await attempt(owner, `${runsPath()}/${randomUUID()}/stream`).expect(404);

        const response = await attempt(
          owner,
          `${runsPath(otherProject)}/${finished.runId}/stream`,
        ).expect(404);

        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.headers['x-accel-buffering']).toBeUndefined();
        expect(problemDetailSchema.parse(response.body).type).toContain('not-found');
      });

      /**
       * An archived project drops every grant (spec 007 R5), so the guard's uniform `403` answers
       * before the read could say `404` — for the stream exactly as for `GET …/runs/:runId`
       * (US4 #3: "the same answer"). `agent-run.e2e-spec.ts` records the same for the create.
       */
      it('answers a run in an archived project as the run read does', async () => {
        const { orgId, owner, workspaceId } = world.alpha;
        const projectId = await anotherProject('Archived');
        const runId = await created(owner, { script: [{ kind: 'tool' }] }, appA, projectId);

        await appA
          .get(TenantTransactionRunner)
          .runInTenantScope({ orgId, userId: owner.userId }, () =>
            appA
              .get(ProjectService)
              .archive({ actorId: owner.userId, orgId, projectId, workspaceId }),
          );

        const read = await http(appA)
          .get(`${runsPath(projectId)}/${runId}`)
          .set('Cookie', owner.cookie);
        const response = await attempt(owner, `${runsPath(projectId)}/${runId}/stream`);

        expect(read.status).toBe(403);
        expect(response.status).toBe(read.status);
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.headers['x-accel-buffering']).toBeUndefined();
      });
    });

    /**
     * US3 / SC-007: a third application whose stream Redis is a closed port. Its runs finish with
     * 008's rows and one warning per dropped write; its stream route refuses before any byte.
     * A's and B's agent workers are paused for the block so C is the one that claims the run.
     */
    describe('with the stream Redis unreachable', () => {
      let appC: INestApplication;
      let paused: { pause(): Promise<void>; resume(): void }[];

      beforeAll(async () => {
        const closedPort = new Redis('redis://127.0.0.1:1', {
          connectTimeout: 2_000,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          // The module's client backs off towards 2 s between attempts; here every write fails
          // inside ~100 ms so the run is over inside the case timeout. Same code path either way.
          retryStrategy: () => 50,
        });

        closedPort.on('error', () => undefined);
        appC = await boot({ ...DEFAULT_STREAM_TIMINGS }, closedPort);
        paused = [appA, appB].flatMap((app) =>
          app.get(QueueRegistry).workers.filter((worker) => worker.name === AGENT_QUEUE),
        );
        await Promise.all(paused.map((worker) => worker.pause()));
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        for (const worker of paused) {
          worker.resume();
        }

        await appC.close();
      });

      it('reports the stream indicator down', async () => {
        const response = await http(appC).get('/api/v1/health').expect(503);

        expect(response.body).toMatchObject({ indicators: { redis_stream: 'down' } });
      });

      it(
        'completes a run with the stream Redis unreachable and answers service-unavailable to a viewer',
        async () => {
          // In the case, not beforeAll: `restoreMocks` clears a spy before every test.
          const warnings: string[] = [];

          vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
            warnings.push(String(message));
          });

          const runId = await created(world.alpha.owner, 'build me a todo app', appC);

          await until(async () => (await statusOf(runId, appC)) === 'succeeded', 'succeeded');

          const page = await eventsOf(runId);

          expect(page.lastSeq).toBe(12);
          expect(page.events.map((event) => event.type)).toEqual([
            'state',
            'state',
            'state',
            'tool.start',
            'tool.end',
            'tool.start',
            'tool.end',
            'tool.start',
            'tool.end',
            'file.patch',
            'usage',
            'state',
          ]);
          expect(await stream.exists(streamKey(runId))).toBe(0);

          const dropped = warnings.filter((message) => message.includes(`for run ${runId}`));

          expect(dropped.length).toBeGreaterThan(0);
          expect(dropped.every((message) => /^(append|sync) dropped/.test(message))).toBe(true);

          const response = await http(appC)
            .get(`${runsPath()}/${runId}/stream`)
            .set('Cookie', world.alpha.owner.cookie)
            .set('Last-Event-ID', '0')
            .expect(503);

          expect(response.headers['content-type']).toContain('application/problem+json');
          expect(response.headers['x-accel-buffering']).toBeUndefined();
          expect(problemDetailSchema.parse(response.body).type).toContain('service-unavailable');
        },
        RUN_TIMEOUT_MS,
      );
    });
  });
});

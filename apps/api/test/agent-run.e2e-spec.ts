import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  problemDetailSchema,
  type RunEvent,
  runEventsResponseSchema,
  runListResponseSchema,
  runResponseSchema,
  type RunStatus,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { RUN_EXECUTOR } from '../src/modules/agent/agent.constants';
import { RunService } from '../src/modules/agent/run.service';
import { RunStore } from '../src/modules/agent/run-store';
import { ScriptedExecutor } from '../src/modules/agent/scripted-executor';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
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
  // The happy path goes over the real queue: the app relays and its worker drains `agent.run`.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  // 020: run create resolves a credential; a fake platform key the scripted executor never reads.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-agent-run-e2e';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** Quickstart step 2: the relay ticks at 50 ms in tests, so a scripted run is over in well under this. */
const RUN_TIMEOUT_MS = 10_000;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Spec 008 US1/US3/US4: a run is created durably and answered before any worker runs, the outbox
 * dispatches it, the scripted fake drives it to a terminal state, every read is guarded, and a
 * cancel is recorded at once and honoured at the worker's next boundary, and every non-terminal
 * state is reached, left and read back.
 */
describe('Agent runs (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let world: TwoTenantWorld;
    let transactions: TenantTransactionRunner;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const extraEmails: string[] = [];

    function runsPath(projectId = world.alpha.projectId): string {
      return `${ORGS}/${world.alpha.orgId}/projects/${projectId}/runs`;
    }

    function create(
      who: Principal,
      body: object,
      options: { key?: string; projectId?: string } = {},
    ): request.Test {
      const test = unsafe(http(app).post(runsPath(options.projectId)), [who.cookie]);

      return (options.key === undefined ? test : test.set('Idempotency-Key', options.key)).send(
        body,
      );
    }

    async function created(who: Principal, prompt: string): Promise<string> {
      const response = await create(who, { prompt }).expect(201);

      return runResponseSchema.parse(response.body).id;
    }

    function read(who: Principal, runId: string, projectId?: string): request.Test {
      return http(app)
        .get(`${runsPath(projectId)}/${runId}`)
        .set('Cookie', who.cookie);
    }

    function events(who: Principal, runId: string, query = ''): request.Test {
      return http(app).get(`${runsPath()}/${runId}/events${query}`).set('Cookie', who.cookie);
    }

    function cancel(who: Principal, runId: string): request.Test {
      return unsafe(http(app).post(`${runsPath()}/${runId}/cancel`), [who.cookie]).send();
    }

    async function eventsOf(who: Principal, runId: string): Promise<RunEvent[]> {
      return runEventsResponseSchema.parse((await events(who, runId).expect(200)).body).events;
    }

    /** Polls the events until one of `type` is on disk — the boundary a cancel is aimed after. */
    async function untilEvent(who: Principal, runId: string, type: RunEvent['type']) {
      const deadline = Date.now() + RUN_TIMEOUT_MS;

      for (;;) {
        const page = await eventsOf(who, runId);

        if (page.some((event) => event.type === type)) {
          return page;
        }

        if (Date.now() > deadline) {
          throw new Error(`run ${runId} has no ${type} event after ${RUN_TIMEOUT_MS} ms`);
        }

        await sleep(20);
      }
    }

    async function untilStatus(who: Principal, runId: string, status: RunStatus) {
      const deadline = Date.now() + RUN_TIMEOUT_MS;

      for (;;) {
        const response = await read(who, runId).expect(200);
        const run = runResponseSchema.parse(response.body);

        if (run.status === status) {
          return run;
        }

        if (Date.now() > deadline) {
          throw new Error(
            `run ${runId} is ${run.status}, not ${status}, after ${RUN_TIMEOUT_MS} ms`,
          );
        }

        await sleep(50);
      }
    }

    /** A signed-in account, optionally an alpha member, optionally holding a project role. */
    async function principal(
      label: string,
      access: { member?: boolean; projectRole?: 'commenter' | 'editor' | 'owner' | 'viewer' } = {},
    ): Promise<Principal> {
      const who = await signUpAndIn(app, label);

      extraEmails.push(who.email);

      const { orgId, projectId } = world.alpha;

      await transactions.runInTenantTransaction(orgId, async (tx) => {
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

    async function runCount(): Promise<number> {
      const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx.select({ id: schema.agentRuns.id }).from(schema.agentRuns),
      );

      return rows.length;
    }

    async function outboxRowsFor(runId: string) {
      return app
        .get<ForgeDatabase>(APP_DATABASE)
        .select({ type: schema.outbox.type })
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.type, 'agent-run.requested'), eq(schema.outbox.aggregateId, runId)),
        );
    }

    async function auditFor(runId: string): Promise<string[]> {
      const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx
          .select({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, runId)),
      );

      return rows.map((row) => row.action).sort();
    }

    /** A second live project in alpha, owned by alpha's owner. */
    async function anotherProject(name: string): Promise<string> {
      const { orgId, owner, workspaceId } = world.alpha;
      const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
        app
          .get(ProjectService)
          .create({ actorId: owner.userId, name, orgId, ownerId: owner.userId, workspaceId }),
      );

      return project.id;
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .overrideProvider(RUN_EXECUTOR)
        .useClass(ScriptedExecutor)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);
    }, LOCKED_BOOT_TIMEOUT_MS);

    /**
     * 031: a project has one holder. A case that leaves a run waiting on a person would hold the
     * shared fixture project for every case after it, so each case ends with the fixture's runs
     * ended — directly, as a fixture reset, not through the product.
     */
    afterEach(async () => {
      for (const tenant of [world.alpha, world.beta]) {
        await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
          tx
            .update(schema.agentRuns)
            .set({ endedAt: new Date(), leaseUntil: null, status: 'cancelled' })
            .where(notInArray(schema.agentRuns.status, ['succeeded', 'failed', 'cancelled'])),
        );
      }
    });

    afterAll(async () => {
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

    describe('POST /orgs/:orgId/projects/:projectId/runs', () => {
      /** SC-001: the response is the durable row, before any worker has touched it. */
      it('creates a queued run with the prompt as message 1 and seq 1 taken, before any worker runs', async () => {
        const { orgId, owner, projectId } = world.alpha;
        const response = await create(owner, { prompt: 'build me a todo app' }).expect(201);
        const run = runResponseSchema.parse(response.body);

        expect(run).toMatchObject({
          cancelRequestedAt: null,
          endedAt: null,
          failureClass: null,
          lastSeq: 1,
          projectId,
          startedAt: null,
          status: 'queued',
          userId: owner.userId,
        });

        const messages = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ content: schema.runMessages.content, role: schema.runMessages.role })
            .from(schema.runMessages)
            .where(eq(schema.runMessages.runId, run.id)),
        );

        expect(messages).toEqual([{ content: 'build me a todo app', role: 'user' }]);
        expect(await outboxRowsFor(run.id)).toHaveLength(1);
        expect(await auditFor(run.id)).toEqual(['agent-run.created']);
      });

      /** SC-001 / SC-007, quickstart steps 2–3: the run reaches `succeeded` with every milestone on disk. */
      it('is dispatched through the outbox and reaches succeeded with contiguous events', async () => {
        const { owner } = world.alpha;
        const runId = await created(owner, 'build me a todo app');
        const run = await untilStatus(owner, runId, 'succeeded');

        expect(run.startedAt).not.toBeNull();
        expect(run.endedAt).not.toBeNull();
        expect(run.lastSeq).toBe(12);

        const response = await events(owner, runId).expect(200);
        const page = runEventsResponseSchema.parse(response.body);

        expect(page.lastSeq).toBe(12);
        expect(page.events.map((event) => event.seq)).toEqual(
          Array.from({ length: 12 }, (_unused, index) => index + 1),
        );
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

        const states = page.events
          .filter((event): event is Extract<RunEvent, { type: 'state' }> => event.type === 'state')
          .map((event) => [event.data.from, event.data.to]);

        expect(states).toEqual([
          [null, 'queued'],
          ['queued', 'starting'],
          ['starting', 'running'],
          ['running', 'succeeded'],
        ]);
        expect(page.events.every((event) => event.run === runId)).toBe(true);
      });

      it.each([
        ['an empty prompt', { prompt: '' }],
        ['a whitespace-only prompt', { prompt: '   ' }],
        ['a 32 001-character prompt', { prompt: 'a'.repeat(32_001) }],
        ['an undeclared field', { model: 'gpt', prompt: 'x' }],
      ])('refuses %s with validation-failed', async (_label, body) => {
        const response = await create(world.alpha.owner, body).expect(422);

        expect(problemDetailSchema.parse(response.body).type).toContain('validation-failed');
      });

      /** SC-002: one `it` per authorisation cell, the count bracketed around each refusal. */
      it.each([
        ['a project editor', () => principal('editor', { member: true, projectRole: 'editor' })],
      ])('lets %s start a run', async (_label, who) => {
        await create(await who(), { prompt: 'go' }).expect(201);
      });

      it.each([
        [
          'a project commenter',
          () => principal('commenter', { member: true, projectRole: 'commenter' }),
        ],
        ['a project viewer', () => principal('viewer', { member: true, projectRole: 'viewer' })],
        ['a member with no grant', () => principal('member', { member: true })],
        ['a guest with a viewer grant', () => principal('guest', { projectRole: 'viewer' })],
        ['a signed-in outsider', () => Promise.resolve(world.outsider)],
        ['the other tenant’s owner', () => Promise.resolve(world.beta.owner)],
      ])('refuses %s with permission-denied and writes nothing', async (_label, who) => {
        const before = await runCount();
        const response = await create(await who(), { prompt: 'go' }).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
        expect(await runCount()).toBe(before);
      });

      /**
       * An archived project: the resolver drops every grant on an archived container (spec 007
       * R5), so the guard's uniform `403` answers before `ProjectService.read` could say `404`.
       * Either way nothing is written (contracts/http.md § Refusal collapse).
       */
      it('refuses a run in an archived project and writes nothing', async () => {
        const { orgId, owner, workspaceId } = world.alpha;
        const projectId = await anotherProject('Archived');

        await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
          app.get(ProjectService).archive({ actorId: owner.userId, orgId, projectId, workspaceId }),
        );

        const before = await runCount();

        await create(owner, { prompt: 'go' }, { projectId }).expect(403);

        expect(await runCount()).toBe(before);
      });

      /** SC-001's replay half: one row, one outbox row, the same body. */
      it('replays an Idempotency-Key with the original body, one row and one outbox row', async () => {
        const key = randomUUID();
        const before = await runCount();

        const first = await create(world.alpha.owner, { prompt: 'once' }, { key }).expect(201);
        const replay = await create(world.alpha.owner, { prompt: 'once' }, { key }).expect(201);

        expect(replay.body).toStrictEqual(first.body);
        expect(await runCount()).toBe(before + 1);
        expect(await outboxRowsFor(runResponseSchema.parse(first.body).id)).toHaveLength(1);
      });
    });

    describe('reads', () => {
      it('lets a project viewer read, list newest first, and page events', async () => {
        const { owner } = world.alpha;
        const viewer = await principal('reader', { member: true, projectRole: 'viewer' });
        const first = await created(owner, 'first');
        const second = await created(owner, 'second');

        await untilStatus(owner, second, 'succeeded');

        const one = await read(viewer, first).expect(200);

        expect(runResponseSchema.parse(one.body).id).toBe(first);

        const listed = await http(app)
          .get(`${runsPath()}?limit=2`)
          .set('Cookie', viewer.cookie)
          .expect(200);
        const { runs } = runListResponseSchema.parse(listed.body);

        expect(runs.map((run) => run.id)).toEqual([second, first]);

        const page = runEventsResponseSchema.parse(
          (await events(viewer, second, '?after=10&limit=1').expect(200)).body,
        );

        expect(page.events.map((event) => event.seq)).toEqual([11]);
        expect(page.lastSeq).toBe(12);

        const rest = runEventsResponseSchema.parse(
          (await events(viewer, second, '?after=10').expect(200)).body,
        );

        expect(rest.events.map((event) => event.seq)).toEqual([11, 12]);
      });

      it.each([
        ['a bad after', '?after=-1'],
        ['a limit over 500', '?limit=501'],
        ['an undeclared query field', '?since=1'],
      ])('refuses events with %s', async (_label, query) => {
        const runId = await created(world.alpha.owner, 'q');

        await events(world.alpha.owner, runId, query).expect(422);
      });

      it('answers not-found for an unknown run and for a run under another project', async () => {
        const { owner } = world.alpha;
        const runId = await created(owner, 'misfiled');
        const otherProject = await anotherProject('Other');

        await read(owner, randomUUID()).expect(404);

        const response = await read(owner, runId, otherProject).expect(404);

        expect(problemDetailSchema.parse(response.body).type).toContain('not-found');
        await http(app)
          .get(`${runsPath(otherProject)}/${runId}/events`)
          .set('Cookie', owner.cookie)
          .expect(404);
      });

      it.each([
        ['a member with no grant', () => principal('member-2', { member: true })],
        ['a signed-in outsider', () => Promise.resolve(world.outsider)],
        ['the other tenant’s owner', () => Promise.resolve(world.beta.owner)],
      ])('refuses every read to %s with permission-denied', async (_label, who) => {
        const runId = await created(world.alpha.owner, 'private');
        const caller = await who();

        await read(caller, runId).expect(403);
        await http(app).get(runsPath()).set('Cookie', caller.cookie).expect(403);
        await events(caller, runId).expect(403);
      });
    });

    /** SC-005, quickstart step 6: recorded at once, honoured within one milestone, refused once over. */
    describe('POST /orgs/:orgId/projects/:projectId/runs/:runId/cancel', () => {
      /** Ten tool milestones with a 300 ms boundary between each — a run that outlives the cancel. */
      const SLOW = JSON.stringify({
        script: Array.from({ length: 10 }, () => [
          { kind: 'tool' },
          { kind: 'sleep', ms: 300 },
        ]).flat(),
      });

      it('records the ask at once, stops the worker at its next boundary, and ends the run cancelled', async () => {
        const { owner } = world.alpha;
        const runId = await created(owner, SLOW);

        await untilEvent(owner, runId, 'tool.end');
        await cancel(owner, runId).expect(202);

        const asked = runResponseSchema.parse((await read(owner, runId).expect(200)).body);

        expect(asked.cancelRequestedAt).not.toBeNull();

        const run = await untilStatus(owner, runId, 'cancelled');

        expect(run.endedAt).not.toBeNull();
        expect(run.failureClass).toBeNull();

        const page = await eventsOf(owner, runId);
        const last = page.at(-1)!;

        expect(last.type).toBe('state');
        expect(last.data).toEqual({ from: 'running', reason: 'cancel requested', to: 'cancelled' });
        expect(page.map((event) => event.seq)).toEqual(page.map((_unused, index) => index + 1));

        // `at` is the flush instant: the step in flight when the ask landed may commit after it,
        // and that is the one milestone FR-022 allows. The next boundary sees the flag.
        const afterAsk = page.filter(
          (event) => event.type === 'tool.end' && event.at > asked.cancelRequestedAt!,
        );

        expect(afterAsk.length).toBeLessThanOrEqual(1);
        expect(page.filter((event) => event.type === 'tool.end').length).toBeLessThan(10);
        expect(await auditFor(runId)).toEqual(['agent-run.cancel-requested', 'agent-run.created']);
      });

      /**
       * Acceptance 3: a run nobody has claimed. Seeded without its outbox row so the relay cannot
       * race the cancel; dispatched by hand after, the worker sees the flag before it starts.
       */
      it('cancels a run nobody has claimed in the request, with reason cancelled-waiting (031)', async () => {
        const { orgId, owner, projectId } = world.alpha;
        const store = app.get(RunStore);
        const runId = await transactions.runInTenantTransaction(orgId, async (tx) => {
          const run = await store.insertRun(tx, {
            model: 'fake',
            orgId,
            projectId,
            userId: owner.userId,
          });
          const seq = await store.allocateSeq(tx, { orgId, runId: run.id }, 1);

          await store.appendEvents(tx, { orgId, runId: run.id }, [
            { at: new Date(), data: { from: null, to: 'queued' }, seq, type: 'state' },
          ]);

          return run.id;
        });

        await cancel(owner, runId).expect(202);

        const cancelled = runResponseSchema.parse((await read(owner, runId).expect(200)).body);

        expect(cancelled).toMatchObject({ status: 'cancelled' });
        expect(cancelled.endedAt).not.toBeNull();
        expect(await auditFor(runId)).toEqual(['agent-run.cancel-requested']);
        expect((await eventsOf(owner, runId)).map((event) => event.data)).toEqual([
          { from: null, to: 'queued' },
          { from: 'queued', reason: 'cancelled-waiting', to: 'cancelled' },
        ]);

        // The run has ended: a repeat is the ended-run conflict, and writes nothing.
        await cancel(owner, runId).expect(409);
        expect(await auditFor(runId)).toEqual(['agent-run.cancel-requested']);
      });

      /**
       * No worker holds a run waiting for input, so none hears the channel: the request ends it,
       * and its `agent-run.finished` lets the run queued behind it start.
       */
      it('ends a run waiting for input in the request, and the next run in the project starts', async () => {
        const { owner } = world.alpha;
        const first = await created(owner, JSON.stringify({ script: [{ kind: 'await-input' }] }));

        await untilStatus(owner, first, 'awaiting_input');

        const second = await created(owner, 'done');

        expect(runResponseSchema.parse((await read(owner, second).expect(200)).body).status).toBe(
          'queued',
        );

        // An approval left open (as a local run's lost attempt could): the cancel closes it.
        const store = app.get(RunStore);

        await transactions.runInTenantTransaction(world.alpha.orgId, async (tx) => {
          const fence = { orgId: world.alpha.orgId, runId: first };
          const seq = await store.allocateSeq(tx, fence, 1);

          await store.appendEvents(tx, fence, [
            {
              at: new Date(),
              data: { detail: 'd', kind: 'command', requestId: 'req-open', title: 't' },
              seq,
              type: 'approval.request',
            },
          ]);
        });

        await cancel(owner, first).expect(202);

        const ended = runResponseSchema.parse((await read(owner, first).expect(200)).body);

        expect(ended.status).toBe('cancelled');
        expect(ended.endedAt).not.toBeNull();

        const page = await eventsOf(owner, first);

        expect(page.slice(-2).map((event) => [event.type, event.data])).toEqual([
          ['approval.resolved', { by: 'run-ended', decision: 'deny', requestId: 'req-open' }],
          ['state', { from: 'awaiting_input', reason: 'cancelled-waiting', to: 'cancelled' }],
        ]);
        expect(page.map((event) => event.seq)).toEqual(page.map((_unused, index) => index + 1));
        expect(await auditFor(first)).toEqual(['agent-run.cancel-requested', 'agent-run.created']);

        await untilStatus(owner, second, 'succeeded');
        await cancel(owner, first).expect(409);
      });

      it('answers conflict naming the state for a run that has ended, and changes nothing', async () => {
        const { owner } = world.alpha;
        const runId = await created(owner, 'done');
        const before = await untilStatus(owner, runId, 'succeeded');
        const response = await cancel(owner, runId).expect(409);
        const problem = problemDetailSchema.parse(response.body);

        expect(problem.type).toContain('conflict');
        expect(problem.detail).toBe('Run is succeeded.');

        const after = runResponseSchema.parse((await read(owner, runId).expect(200)).body);

        expect(after).toStrictEqual(before);
        expect(await auditFor(runId)).toEqual(['agent-run.created']);
      });

      it('answers not-found for an unknown run', async () => {
        await cancel(world.alpha.owner, randomUUID()).expect(404);
      });

      it.each([
        [
          'a project viewer',
          () => principal('viewer-cancel', { member: true, projectRole: 'viewer' }),
        ],
        ['a member with no grant', () => principal('member-cancel', { member: true })],
        ['the other tenant’s owner', () => Promise.resolve(world.beta.owner)],
      ])('refuses %s with permission-denied and leaves the run running', async (_label, who) => {
        const { owner } = world.alpha;
        const runId = await created(owner, SLOW);
        const response = await cancel(await who(), runId).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');

        const run = runResponseSchema.parse((await read(owner, runId).expect(200)).body);

        expect(run.cancelRequestedAt).toBeNull();

        // Not left to run out the suite's clock.
        await cancel(owner, runId).expect(202);
      });
    });

    /** SC-006's e2e half (US4): every non-terminal state reached, left, and read back. */
    describe('every state', () => {
      function script(...steps: object[]): string {
        return JSON.stringify({ script: steps });
      }

      function statesOf(page: RunEvent[]): ([string | null, string] | undefined)[] {
        return page
          .filter((event) => event.type === 'state')
          .map((event) => (event.type === 'state' ? [event.data.from, event.data.to] : undefined));
      }

      async function rowOf(runId: string) {
        const [row] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({
              leaseEpoch: schema.agentRuns.leaseEpoch,
              leaseUntil: schema.agentRuns.leaseUntil,
            })
            .from(schema.agentRuns)
            .where(eq(schema.agentRuns.id, runId)),
        );

        return row!;
      }

      function input(who: Principal, runId: string, message = 'go on'): request.Test {
        return unsafe(http(app).post(`${runsPath()}/${runId}/input`), [who.cookie]).send({
          message,
        });
      }

      describe('POST /orgs/:orgId/projects/:projectId/runs/:runId/input', () => {
        /** Quickstart step 7: the run waits with no lease, the answer re-queues it, it finishes. */
        it('resumes a run waiting for input: message 2, an audit row, a new dispatch, then succeeded', async () => {
          const { orgId, owner } = world.alpha;
          const runId = await created(
            owner,
            script({ kind: 'tool' }, { kind: 'await-input' }, { kind: 'tool' }),
          );

          await untilStatus(owner, runId, 'awaiting_input');

          expect(await rowOf(runId)).toMatchObject({ leaseEpoch: 1, leaseUntil: null });

          // 031: a late `agent-run.finished` from an earlier case may have released this run as the
          // head of its line before it was claimed — a spare dispatch the gate absorbs. What the
          // input adds is exactly one.
          const dispatchedBefore = (await outboxRowsFor(runId)).length;

          await input(owner, runId).expect(202);

          const run = await untilStatus(owner, runId, 'succeeded');

          expect(run.endedAt).not.toBeNull();
          expect(await rowOf(runId)).toMatchObject({ leaseEpoch: 2, leaseUntil: null });

          const messages = await transactions.runInTenantTransaction(orgId, (tx) =>
            tx
              .select({ content: schema.runMessages.content, role: schema.runMessages.role })
              .from(schema.runMessages)
              .where(eq(schema.runMessages.runId, runId))
              .orderBy(schema.runMessages.at),
          );

          expect(messages.map((message) => message.role)).toEqual(['user', 'user']);
          expect(messages[1]!.content).toBe('go on');
          expect(await auditFor(runId)).toEqual(['agent-run.created', 'agent-run.input']);
          expect(await outboxRowsFor(runId)).toHaveLength(dispatchedBefore + 1);

          const page = await eventsOf(owner, runId);

          expect(page.map((event) => event.seq)).toEqual(page.map((_unused, index) => index + 1));
          expect(statesOf(page)).toEqual([
            [null, 'queued'],
            ['queued', 'starting'],
            ['starting', 'running'],
            ['running', 'awaiting_input'],
            ['awaiting_input', 'queued'],
            ['queued', 'starting'],
            ['starting', 'running'],
            ['running', 'succeeded'],
          ]);
          // The tool before the input ran once; only the tool after it ran on the resumed attempt.
          expect(page.filter((event) => event.type === 'tool.end')).toHaveLength(2);
        });

        it('answers conflict naming the state for a run that is not waiting, and writes nothing', async () => {
          const { owner } = world.alpha;
          const runId = await created(
            owner,
            script(...Array.from({ length: 10 }, () => ({ kind: 'sleep', ms: 300 }))),
          );

          await untilStatus(owner, runId, 'running');

          const dispatchedBefore = (await outboxRowsFor(runId)).length;
          const response = await input(owner, runId).expect(409);
          const problem = problemDetailSchema.parse(response.body);

          expect(problem.type).toContain('conflict');
          expect(problem.detail).toBe('Run is running.');
          expect(await auditFor(runId)).toEqual(['agent-run.created']);
          expect(await outboxRowsFor(runId)).toHaveLength(dispatchedBefore);

          await cancel(owner, runId).expect(202);
        });

        it.each([
          ['an empty message', { message: '' }],
          ['an undeclared field', { message: 'x', role: 'assistant' }],
        ])('refuses %s with validation-failed', async (_label, body) => {
          const { owner } = world.alpha;
          const runId = await created(owner, script({ kind: 'await-input' }));

          await untilStatus(owner, runId, 'awaiting_input');

          const response = await unsafe(http(app).post(`${runsPath()}/${runId}/input`), [
            owner.cookie,
          ])
            .send(body)
            .expect(422);

          expect(problemDetailSchema.parse(response.body).type).toContain('validation-failed');
        });

        it.each([
          [
            'a project viewer',
            () => principal('viewer-input', { member: true, projectRole: 'viewer' }),
          ],
          ['a member with no grant', () => principal('member-input', { member: true })],
          ['the other tenant’s owner', () => Promise.resolve(world.beta.owner)],
        ])('refuses %s with permission-denied and leaves the run waiting', async (_label, who) => {
          const { owner } = world.alpha;
          const runId = await created(owner, script({ kind: 'await-input' }));

          await untilStatus(owner, runId, 'awaiting_input');

          const response = await input(await who(), runId).expect(403);

          expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
          expect(runResponseSchema.parse((await read(owner, runId).expect(200)).body).status).toBe(
            'awaiting_input',
          );
          expect(await outboxRowsFor(runId)).toHaveLength(1);
        });
      });

      /** FR-008: a failed tool is `tool_error`, the next milestone heals it, the third in a row ends it. */
      describe('tool_error', () => {
        it('heals from two failed tools and succeeds on the third', async () => {
          const { owner } = world.alpha;
          const runId = await created(
            owner,
            script({ kind: 'tool', ok: false }, { kind: 'tool', ok: false }, { kind: 'tool' }),
          );
          const run = await untilStatus(owner, runId, 'succeeded');

          expect(run.failureClass).toBeNull();

          const page = await eventsOf(owner, runId);

          expect(page.map((event) => event.seq)).toEqual(page.map((_unused, index) => index + 1));
          expect(page.map((event) => event.type)).toEqual([
            'state',
            'state',
            'state',
            'tool.start',
            'tool.end',
            'state',
            'state',
            'tool.start',
            'tool.end',
            'state',
            'state',
            'tool.start',
            'tool.end',
            'state',
          ]);
          expect(statesOf(page)).toEqual([
            [null, 'queued'],
            ['queued', 'starting'],
            ['starting', 'running'],
            ['running', 'tool_error'],
            ['tool_error', 'running'],
            ['running', 'tool_error'],
            ['tool_error', 'running'],
            ['running', 'succeeded'],
          ]);
        });

        it('fails with class tool_error on the third consecutive failed tool', async () => {
          const { owner } = world.alpha;
          const runId = await created(
            owner,
            script(
              { kind: 'tool', ok: false },
              { kind: 'tool', ok: false },
              { kind: 'tool', ok: false },
              { kind: 'tool' },
            ),
          );
          const run = await untilStatus(owner, runId, 'failed');

          expect(run.failureClass).toBe('tool_error');
          expect(run.endedAt).not.toBeNull();
          expect(await rowOf(runId)).toMatchObject({ leaseUntil: null });

          const page = await eventsOf(owner, runId);

          expect(page.filter((event) => event.type === 'tool.end')).toHaveLength(3);
          expect(statesOf(page).slice(-2)).toEqual([
            ['running', 'tool_error'],
            ['tool_error', 'failed'],
          ]);
          expect(page.at(-1)!.data).toMatchObject({ reason: 'three consecutive tool failures' });
        });
      });

      describe('paused', () => {
        it('pauses with the reason on the state event and no lease, and resumes through the queue', async () => {
          const { orgId, owner, projectId } = world.alpha;
          const runId = await created(
            owner,
            script({ kind: 'tool' }, { kind: 'pause', reason: 'quota' }, { kind: 'tool' }),
          );

          await untilStatus(owner, runId, 'paused');

          expect(await rowOf(runId)).toMatchObject({ leaseEpoch: 1, leaseUntil: null });

          const paused = (await eventsOf(owner, runId)).at(-1)!;

          expect(paused.type).toBe('state');
          expect(paused.data).toEqual({ from: 'running', reason: 'quota', to: 'paused' });

          // 031: spare dispatches before the claim are absorbed by the gate; resume adds one.
          const dispatchedBefore = (await outboxRowsFor(runId)).length;

          // No route until 019: the service is the caller.
          await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
            app.get(RunService).resume(orgId, projectId, runId),
          );

          const run = await untilStatus(owner, runId, 'succeeded');

          expect(run.endedAt).not.toBeNull();
          expect(await rowOf(runId)).toMatchObject({ leaseEpoch: 2, leaseUntil: null });
          expect(await outboxRowsFor(runId)).toHaveLength(dispatchedBefore + 1);

          const page = await eventsOf(owner, runId);

          expect(page.map((event) => event.seq)).toEqual(page.map((_unused, index) => index + 1));
          expect(statesOf(page)).toEqual([
            [null, 'queued'],
            ['queued', 'starting'],
            ['starting', 'running'],
            ['running', 'paused'],
            ['paused', 'queued'],
            ['queued', 'starting'],
            ['starting', 'running'],
            ['running', 'succeeded'],
          ]);
          expect(page.filter((event) => event.type === 'tool.end')).toHaveLength(2);
        });
      });

      describe('failed', () => {
        it('fails with the executor’s class and reason, and ends the run', async () => {
          const { owner } = world.alpha;
          const runId = await created(
            owner,
            script({ kind: 'tool' }, { failureClass: 'executor', kind: 'fail', reason: 'gave up' }),
          );
          const run = await untilStatus(owner, runId, 'failed');

          expect(run.failureClass).toBe('executor');
          expect(run.endedAt).not.toBeNull();

          const last = (await eventsOf(owner, runId)).at(-1)!;

          expect(last.data).toEqual({ from: 'running', reason: 'gave up', to: 'failed' });
          await cancel(owner, runId).expect(409);
        });
      });
    });

    /** Constitution V at the boundary: the row a worker wrote is invisible outside its tenant. */
    it('keeps a run’s events inside its tenant', async () => {
      const runId = await created(world.alpha.owner, 'isolated');

      await untilStatus(world.alpha.owner, runId, 'succeeded');

      const seen = await transactions.runInTenantTransaction(world.beta.orgId, (tx) =>
        tx
          .select({ seq: schema.runEvents.seq })
          .from(schema.runEvents)
          .where(sql`${schema.runEvents.runId} = ${runId}`),
      );

      expect(seen).toEqual([]);
    });
  });
});

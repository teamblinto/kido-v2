import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import { DomainError } from '../../common/errors/domain-error';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OrgService } from '../tenancy/services/org.service';
import { ProjectService } from '../tenancy/services/project.service';
import { FencedError, RunStore } from './run-store';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * The fixture's frozen instant is the real one: the reaper of any suite booted alongside this one
 * sweeps every tenant, and a lease dated in the past would be a stale lease to it.
 */
const START = new Date().toISOString();
const TTL = 45_000;

/**
 * Spec 008 research R4: every worker-side statement carries the lease epoch, and a stale one is
 * refused with `FencedError` and changes nothing. Against real Postgres, because the fence is a
 * `where` clause and a fake would only prove the fake.
 */
describe('RunStore', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let store: RunStore;
    let transactions: TenantTransactionRunner;
    let clock: FakeClock;
    let orgId: string;
    let projectId: string;
    let projectService: ProjectService;
    let userId: string;
    let workspaceId: string;

    function inTenant<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(orgId, fn);
    }

    /**
     * A run in `queued`, as `RunService.create` leaves it: `seq` 1 taken by the first state event.
     * On a project of its own unless one is named (031): a project has one holder, so runs that
     * are each claimed must not share one.
     */
    async function seedRun(
      seed: { project?: string; prompt?: string; user?: string } = {},
    ): Promise<string> {
      const project = seed.project ?? (await seedProject());

      return inTenant(async (tx) => {
        const run = await store.insertRun(tx, {
          model: 'fake',
          orgId,
          projectId: project,
          userId: seed.user ?? userId,
        });
        const seq = await store.allocateSeq(tx, { orgId, runId: run.id }, 1);

        await store.appendEvents(tx, { orgId, runId: run.id }, [
          { at: clock.now(), data: { from: null, to: 'queued' }, seq, type: 'state' },
        ]);

        if (seed.prompt !== undefined) {
          await store.insertMessage(tx, {
            content: seed.prompt,
            orgId,
            role: 'user',
            runId: run.id,
          });
        }

        return run.id;
      });
    }

    /** A project of its own, so a pagination case sees exactly the runs it seeded. */
    async function seedProject(): Promise<string> {
      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        projectService.create({
          actorId: userId,
          name: `Runs ${randomUUID().slice(0, 8)}`,
          orgId,
          ownerId: userId,
          workspaceId,
        }),
      );

      return project.id;
    }

    /** A run a worker holds: claimed once, so its epoch is 1 and its status `starting`. */
    async function seedClaimed(): Promise<string> {
      const runId = await seedRun();
      const claim = await inTenant((tx) =>
        store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec', runId }),
      );

      expect(claim).toMatchObject({ epoch: 1 });

      return runId;
    }

    async function row(runId: string) {
      const [found] = await inTenant((tx) =>
        tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)),
      );

      return found!;
    }

    async function events(runId: string) {
      return inTenant((tx) => store.readEvents(tx, orgId, runId, 0, 500));
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      store = moduleRef.get(RunStore, { strict: false });
      transactions = moduleRef.get(TenantTransactionRunner);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `008s-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;

      const orgs = moduleRef.get(OrgService);
      const org = await orgs.create(userId, {
        name: 'Run store fixture',
        slug: `008s-${randomUUID().slice(0, 8)}`,
      });

      orgId = org.id;

      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      workspaceId = workspace!.id;
      projectService = moduleRef.get(ProjectService);

      const project = await transactions.runInTenantScope({ orgId, userId }, () =>
        projectService.create({
          actorId: userId,
          name: 'Runs',
          orgId,
          ownerId: userId,
          workspaceId,
        }),
      );

      projectId = project.id;
    }, 60_000);

    afterAll(async () => {
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.users).where(inArray(schema.users.id, [userId]));
      await moduleRef?.close();
    });

    describe('the fence', () => {
      it('refuses allocateSeq with a stale epoch and leaves next_seq alone', async () => {
        const runId = await seedClaimed();
        const before = (await row(runId)).nextSeq;

        await expect(
          inTenant((tx) => store.allocateSeq(tx, { epoch: 0, orgId, runId }, 3)),
        ).rejects.toThrow(FencedError);

        expect((await row(runId)).nextSeq).toBe(before);
      });

      it('refuses appendEvents with a stale epoch and writes no row', async () => {
        const runId = await seedClaimed();
        const before = (await events(runId)).length;

        await expect(
          inTenant((tx) =>
            store.appendEvents(tx, { epoch: 0, orgId, runId }, [
              {
                at: clock.now(),
                data: { checkpointId: 'c1' },
                seq: 99,
                type: 'checkpoint',
              },
            ]),
          ),
        ).rejects.toThrow(FencedError);

        expect(await events(runId)).toHaveLength(before);
      });

      it('refuses transition with a stale epoch and leaves status and events alone', async () => {
        const runId = await seedClaimed();
        const before = await events(runId);

        await expect(
          inTenant((tx) =>
            store.transition(tx, { epoch: 0, from: 'starting', orgId, runId, to: 'running' }),
          ),
        ).rejects.toThrow(FencedError);

        expect((await row(runId)).status).toBe('starting');
        expect(await events(runId)).toEqual(before);
      });

      it('refuses transition from a status the row is not in', async () => {
        const runId = await seedClaimed();

        await expect(
          inTenant((tx) =>
            store.transition(tx, { epoch: 1, from: 'running', orgId, runId, to: 'succeeded' }),
          ),
        ).rejects.toThrow(FencedError);

        expect((await row(runId)).status).toBe('starting');
      });

      it('refuses heartbeat with a stale epoch and leaves lease_until alone', async () => {
        const runId = await seedClaimed();
        const before = (await row(runId)).leaseUntil;

        clock.advance(10_000);

        await expect(
          inTenant((tx) => store.heartbeat(tx, { epoch: 0, orgId, runId }, TTL)),
        ).rejects.toThrow(FencedError);

        expect((await row(runId)).leaseUntil).toEqual(before);
      });

      it('refuses addUsage with a stale epoch and leaves the counters alone', async () => {
        const runId = await seedClaimed();

        await expect(
          inTenant((tx) =>
            store.addUsage(
              tx,
              { epoch: 0, orgId, runId },
              {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costMicros: 1,
                inputTokens: 1,
                outputTokens: 1,
              },
            ),
          ),
        ).rejects.toThrow(FencedError);

        expect(await row(runId)).toMatchObject({ costMicros: 0, inputTokens: 0, outputTokens: 0 });
      });

      it('refuses setCredentialMode with a stale epoch and leaves credential_mode alone', async () => {
        const runId = await seedClaimed();

        await expect(
          inTenant((tx) => store.setCredentialMode(tx, { epoch: 0, orgId, runId }, 'BYOK')),
        ).rejects.toThrow(FencedError);

        expect((await row(runId)).credentialMode).toBe('PLATFORM');
      });

      it('sets credential_mode under the live epoch', async () => {
        const runId = await seedClaimed();

        await inTenant((tx) => store.setCredentialMode(tx, { epoch: 1, orgId, runId }, 'BYOK'));

        expect((await row(runId)).credentialMode).toBe('BYOK');
      });

      it('accepts every statement with the live epoch', async () => {
        const runId = await seedClaimed();

        await inTenant(async (tx) => {
          const fence = { epoch: 1, orgId, runId };
          const seq = await store.allocateSeq(tx, fence, 1);

          await store.appendEvents(tx, fence, [
            { at: clock.now(), data: { checkpointId: 'c1' }, seq, type: 'checkpoint' },
          ]);
          await store.transition(tx, { ...fence, from: 'starting', to: 'running' });
          await store.heartbeat(tx, fence, TTL);
          await store.addUsage(tx, fence, {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costMicros: 3,
            inputTokens: 2,
            outputTokens: 1,
          });
        });

        const after = await row(runId);

        expect(after).toMatchObject({
          costMicros: 3,
          inputTokens: 2,
          outputTokens: 1,
          status: 'running',
        });
        expect((await events(runId)).map((event) => event.type)).toEqual([
          'state',
          'state',
          'checkpoint',
          'state',
        ]);
      });
    });

    describe('021 context assembly', () => {
      it('addUsage adds cache read and write tokens to their own columns and to input_tokens', async () => {
        const runId = await seedClaimed();

        await inTenant((tx) =>
          store.addUsage(
            tx,
            { epoch: 1, orgId, runId },
            {
              cacheReadTokens: 30,
              cacheWriteTokens: 5,
              costMicros: 7,
              inputTokens: 10,
              outputTokens: 2,
            },
          ),
        );

        expect(await row(runId)).toMatchObject({
          cacheReadTokens: 30,
          cacheWriteTokens: 5,
          costMicros: 7,
          inputTokens: 45,
          outputTokens: 2,
        });
      });

      it('setSummary writes summary, through id and tokens under the fence and refuses a stale epoch', async () => {
        const runId = await seedClaimed();
        const { id: throughMessageId } = await inTenant((tx) =>
          store.insertMessage(tx, { content: 'hi', orgId, role: 'user', runId }),
        );

        await expect(
          inTenant((tx) =>
            store.setSummary(
              tx,
              { epoch: 0, orgId, runId },
              { summary: 'stale', throughMessageId, tokens: 1 },
            ),
          ),
        ).rejects.toThrow(FencedError);
        expect(await row(runId)).toMatchObject({
          summary: null,
          summaryThroughMessageId: null,
          summaryTokens: 0,
        });

        await inTenant((tx) =>
          store.setSummary(
            tx,
            { epoch: 1, orgId, runId },
            { summary: 'so far', throughMessageId, tokens: 12 },
          ),
        );

        expect(await row(runId)).toMatchObject({
          summary: 'so far',
          summaryThroughMessageId: throughMessageId,
          summaryTokens: 12,
        });
      });

      it('appendContextSkip appends one entry under the fence', async () => {
        const runId = await seedClaimed();
        const first = { kind: 'summary' as const, reason: 'timeout', turn: 3 };
        const second = { kind: 'summary' as const, reason: 'provider', turn: 5 };

        await inTenant((tx) => store.appendContextSkip(tx, { epoch: 1, orgId, runId }, first));
        await inTenant((tx) => store.appendContextSkip(tx, { epoch: 1, orgId, runId }, second));
        await expect(
          inTenant((tx) => store.appendContextSkip(tx, { epoch: 0, orgId, runId }, first)),
        ).rejects.toThrow(FencedError);

        expect((await row(runId)).contextSkips).toEqual([first, second]);
      });

      it('getProjectContext and upsertProjectContext round-trip the tree state and map inside the tenant transaction', async () => {
        expect(
          await inTenant((tx) => store.getProjectContext(tx, orgId, projectId)),
        ).toBeUndefined();

        await inTenant((tx) =>
          store.upsertProjectContext(tx, {
            dirtyDigest: 'd1',
            headSha: 'a'.repeat(40),
            orgId,
            projectId,
            repoMap: 'src/\n  a.ts',
          }),
        );
        await inTenant((tx) =>
          store.upsertProjectContext(tx, {
            dirtyDigest: 'd2',
            headSha: 'b'.repeat(40),
            orgId,
            projectId,
            repoMap: 'src/\n  b.ts',
          }),
        );

        expect(await inTenant((tx) => store.getProjectContext(tx, orgId, projectId))).toMatchObject(
          {
            dirtyDigest: 'd2',
            headSha: 'b'.repeat(40),
            orgId,
            projectId,
            repoMap: 'src/\n  b.ts',
          },
        );
      });
    });

    describe('appendEvents', () => {
      /** SC-008: a month nobody declared lands in `run_events_default` instead of raising. */
      it('stores an event dated in an undeclared month, in the default partition', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };
        const at = new Date(Date.UTC(2099, 0, 1));

        await inTenant(async (tx) => {
          const seq = await store.allocateSeq(tx, fence, 1);

          await store.appendEvents(tx, fence, [
            { at, data: { checkpointId: 'late' }, seq, type: 'checkpoint' },
          ]);
        });

        const { rows } = await inTenant((tx) =>
          tx.execute<{ partition: string }>(
            sql`select tableoid::regclass::text as partition from run_events where run_id = ${runId} and at = ${at}`,
          ),
        );

        expect(rows).toEqual([{ partition: 'run_events_default' }]);
        expect((await events(runId)).at(-1)).toMatchObject({ at, type: 'checkpoint' });
      });
    });

    describe('allocateSeq', () => {
      it('hands out contiguous ranges', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };

        const first = await inTenant((tx) => store.allocateSeq(tx, fence, 3));
        const second = await inTenant((tx) => store.allocateSeq(tx, fence, 2));
        const third = await inTenant((tx) => store.allocateSeq(tx, fence, 1));

        // 1 was the `queued` state event and 2 the claim's `starting` one.
        expect([first, second, third]).toEqual([3, 6, 8]);
        expect((await row(runId)).nextSeq).toBe(9);
      });
    });

    describe('transition', () => {
      it('applies the effects: ended_at and a released lease on a terminal state', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };

        await inTenant((tx) => store.transition(tx, { ...fence, from: 'starting', to: 'running' }));
        await inTenant((tx) =>
          store.transition(tx, {
            ...fence,
            failureClass: 'executor',
            from: 'running',
            reason: 'scripted',
            to: 'failed',
          }),
        );

        const after = await row(runId);

        expect(after.status).toBe('failed');
        expect(after.failureClass).toBe('executor');
        expect(after.endedAt).toEqual(clock.now());
        expect(after.leaseUntil).toBeNull();

        const last = (await events(runId)).at(-1);

        expect(last).toMatchObject({
          data: { from: 'running', reason: 'scripted', to: 'failed' },
          type: 'state',
        });
      });

      it('releases the lease on awaiting_input without ending the run', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };

        await inTenant((tx) => store.transition(tx, { ...fence, from: 'starting', to: 'running' }));
        await inTenant((tx) =>
          store.transition(tx, { ...fence, from: 'running', to: 'awaiting_input' }),
        );

        const after = await row(runId);

        expect(after).toMatchObject({ endedAt: null, leaseUntil: null, status: 'awaiting_input' });

        // Nothing to claim while a person holds the run: input re-queues it first (US4).
        await expect(
          inTenant((tx) => store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec', runId })),
        ).resolves.toBeUndefined();
      });
    });

    /**
     * Spec 029 T037: a terminal transition appends one `agent-run.finished` on the caller's
     * transaction, so the webhook fan-out has a source for `run.completed`.
     */
    describe('agent-run.finished (spec 029)', () => {
      async function finished(runId: string) {
        return database
          .select({ orgId: schema.outbox.originOrgId, payload: schema.outbox.payload })
          .from(schema.outbox)
          .where(
            and(eq(schema.outbox.type, 'agent-run.finished'), eq(schema.outbox.aggregateId, runId)),
          );
      }

      it.each(['succeeded', 'failed', 'cancelled'] as const)(
        'a transition to %s appends one agent-run.finished with that outcome',
        async (to) => {
          const runId = await seedClaimed();
          const fence = { epoch: 1, orgId, runId };

          await inTenant((tx) =>
            store.transition(tx, { ...fence, from: 'starting', to: 'running' }),
          );
          await inTenant((tx) => store.transition(tx, { ...fence, from: 'running', to }));

          const { projectId: own } = await row(runId);

          expect(await finished(runId)).toEqual([
            { orgId, payload: { orgId, outcome: to, projectId: own, runId } },
          ]);
        },
      );

      it('a non-terminal transition appends none', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };

        await inTenant((tx) => store.transition(tx, { ...fence, from: 'starting', to: 'running' }));
        await inTenant((tx) =>
          store.transition(tx, { ...fence, from: 'running', to: 'awaiting_input' }),
        );

        expect(await finished(runId)).toEqual([]);
      });

      it('appends on the caller transaction: a rollback leaves no event', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };

        await inTenant((tx) => store.transition(tx, { ...fence, from: 'starting', to: 'running' }));
        await expect(
          inTenant(async (tx) => {
            await store.transition(tx, { ...fence, from: 'running', to: 'succeeded' });
            throw new Error('after the transition');
          }),
        ).rejects.toThrow('after the transition');

        expect(await finished(runId)).toEqual([]);
      });
    });

    describe('claim', () => {
      it('moves a queued run to starting with epoch 1, a lease and a state event', async () => {
        const runId = await seedRun();

        const claim = await inTenant((tx) =>
          store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec:1', runId }),
        );

        const after = await row(runId);

        expect(claim).toMatchObject({
          epoch: 1,
          orgId,
          projectId: after.projectId,
          runId,
          status: 'starting',
        });

        expect(after).toMatchObject({ leaseEpoch: 1, leaseOwner: 'spec:1', status: 'starting' });
        expect(after.startedAt).toEqual(clock.now());
        expect(after.leaseUntil).toEqual(new Date(clock.now().getTime() + TTL));
        expect((await events(runId)).at(-1)).toMatchObject({
          data: { from: 'queued', to: 'starting' },
          seq: 2,
          type: 'state',
        });
      });

      it('answers with the lease’s end while a live lease is held, so the caller can wait it out', async () => {
        const runId = await seedClaimed();

        const second = await inTenant((tx) =>
          store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec:2', runId }),
        );

        expect(second).toEqual({ heldUntil: new Date(clock.now().getTime() + TTL) });
        expect((await row(runId)).leaseEpoch).toBe(1);
      });

      it('re-claims an expired lease with the next epoch and the status kept', async () => {
        const runId = await seedClaimed();

        await inTenant((tx) =>
          store.transition(tx, { epoch: 1, from: 'starting', orgId, runId, to: 'running' }),
        );
        clock.advance(TTL + 1);

        const second = await inTenant((tx) =>
          store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec:2', runId }),
        );

        expect(second).toMatchObject({ epoch: 2, status: 'running' });
        expect((await events(runId)).filter((event) => event.type === 'state')).toHaveLength(3);
      });

      it.each(['awaiting_input', 'paused', 'succeeded'] as const)(
        'returns undefined for a run in %s',
        async (status) => {
          const runId = await seedRun();

          await inTenant((tx) =>
            tx.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, runId)),
          );

          expect(
            await inTenant((tx) =>
              store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec', runId }),
            ),
          ).toBeUndefined();
        },
      );

      /** Two workers race for one run: the row lock serialises them and the second sees a live lease. */
      it('wins exactly once under two concurrent callers', async () => {
        const runId = await seedRun();

        const claims = await Promise.all(
          ['a', 'b'].map((owner) =>
            inTenant((tx) => store.claim(tx, { leaseTtlMs: TTL, orgId, owner, runId })),
          ),
        );

        expect(claims.filter((claim) => claim !== undefined && 'epoch' in claim)).toHaveLength(1);
        expect((await row(runId)).leaseEpoch).toBe(1);
        expect((await events(runId)).filter((event) => event.type === 'state')).toHaveLength(2);
      });
    });

    /** Spec 031 research R1: the gate in the claim — one holder per project, a line behind it. */
    describe('the line (031)', () => {
      const claim = (runId: string) =>
        inTenant((tx) => store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec:line', runId }));

      it('claims the head of an unheld line and sets started_at', async () => {
        const project = await seedProject();
        const head = await seedRun({ project });

        clock.advance(10);
        await seedRun({ project });

        expect(await claim(head)).toMatchObject({ epoch: 1, status: 'starting' });
        expect((await row(head)).startedAt).toEqual(clock.now());
      });

      it('returns undefined and writes nothing for a run that is not the head', async () => {
        const project = await seedProject();

        await seedRun({ project });
        clock.advance(10);

        const second = await seedRun({ project });
        const before = await row(second);

        expect(await claim(second)).toBeUndefined();
        expect(await row(second)).toEqual(before);
        expect(await events(second)).toHaveLength(1);
      });

      it('returns undefined and writes nothing while another run holds the project', async () => {
        const project = await seedProject();
        const holder = await seedRun({ project });

        await claim(holder);
        clock.advance(10);

        const waiting = await seedRun({ project });
        const before = await row(waiting);

        expect(await claim(waiting)).toBeUndefined();
        expect(await row(waiting)).toEqual(before);
        expect(await events(waiting)).toHaveLength(1);
      });

      it('re-claims a started run without consulting the line (resume, redelivery)', async () => {
        const project = await seedProject();
        const holder = await seedRun({ project });

        await claim(holder);
        clock.advance(10);
        await seedRun({ project });
        await inTenant(async (tx) => {
          await store.transition(tx, {
            epoch: 1,
            from: 'starting',
            orgId,
            runId: holder,
            to: 'running',
          });
          await store.transition(tx, {
            epoch: 1,
            from: 'running',
            orgId,
            runId: holder,
            to: 'awaiting_input',
          });
          await store.transition(tx, {
            from: 'awaiting_input',
            orgId,
            runId: holder,
            to: 'queued',
          });
        });

        const line = vi.spyOn(store, 'line');

        try {
          expect(await claim(holder)).toMatchObject({ epoch: 2, status: 'starting' });
          expect(line).not.toHaveBeenCalled();
        } finally {
          line.mockRestore();
        }
      });

      it('cancels a head whose starter lost project:agent.run, with reason access-lost', async () => {
        const [stranger] = await database
          .insert(schema.users)
          .values({ email: `031s-${randomUUID()}@example.test`, passwordHash: 'x' })
          .returning({ id: schema.users.id });
        const head = await seedRun({ user: stranger!.id });

        try {
          expect(await claim(head)).toBeUndefined();
          expect(await row(head)).toMatchObject({ startedAt: null, status: 'cancelled' });
          expect((await events(head)).at(-1)).toMatchObject({
            data: { from: 'queued', reason: 'access-lost', to: 'cancelled' },
            type: 'state',
          });
        } finally {
          await database.delete(schema.users).where(eq(schema.users.id, stranger!.id));
        }
      });

      it('staleHeads finds the head of an unheld line older than the cut-off, and no other', async () => {
        const unheld = await seedProject();
        const held = await seedProject();

        // Seeded and read in one transaction, so no other suite's reaper or line consumer (they
        // sweep every tenant) can see these runs, dispatch the head and claim it in between —
        // which made this case flaky in a full `src` run. `created_at` is explicit and distinct:
        // inside one transaction `now()` would give every row the same instant.
        await inTenant(async (tx) => {
          const base = Date.now() - 1_000;
          const insert = async (project: string, offsetMs: number) => {
            const [inserted] = await tx
              .insert(schema.agentRuns)
              .values({
                createdAt: new Date(base + offsetMs),
                model: 'fake',
                orgId,
                projectId: project,
                userId,
              })
              .returning({ createdAt: schema.agentRuns.createdAt, id: schema.agentRuns.id });

            return inserted!;
          };

          const head = await insert(unheld, 0);

          await insert(unheld, 10);
          const holder = await insert(held, 0);

          expect(
            await store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec', runId: holder.id }),
          ).toMatchObject({ epoch: 1 });
          await insert(held, 10);

          const found = async (before: Date) =>
            (await store.staleHeads(tx, before)).filter((row) =>
              [unheld, held].includes(row.projectId),
            );
          const createdAt = head.createdAt.getTime();

          // Younger than the cut-off: nothing.
          expect(await found(new Date(createdAt - 1_000))).toEqual([]);
          expect(await found(new Date(createdAt + 60_000))).toEqual([
            { id: head.id, projectId: unheld },
          ]);
        });
      });

      it('takes the project writer lock before it reads the holder', async () => {
        const trace: string[] = [];
        const checkpoints = moduleRef.get(CheckpointService, { strict: false });
        const lock = vi.spyOn(checkpoints, 'lockProject').mockImplementation(async (tx, ref) => {
          trace.push('lock:project');
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ref.projectId}))`);
        });
        const holder = vi.spyOn(store, 'holder').mockImplementation(async (...args) => {
          trace.push('holder');
          holder.mockRestore();

          return store.holder(...args);
        });

        try {
          await claim(await seedRun());
          expect(trace.slice(0, 2)).toEqual(['lock:project', 'holder']);
        } finally {
          lock.mockRestore();
          holder.mockRestore();
        }
      });

      it('a second delivery waits on a live attempt’s dispatch instead of deadlocking with it', async () => {
        const runId = await seedClaimed();
        const ref = { orgId, projectId: (await row(runId)).projectId };
        const checkpoints = moduleRef.get(CheckpointService, { strict: false });
        let beaten!: () => void;
        let release!: () => void;
        const heartbeat = new Promise<void>((resolve) => (beaten = resolve));
        const go = new Promise<void>((resolve) => (release = resolve));

        // As `AgentRunConsumer`'s dispatch: the heartbeat holds the row, then the baseline locks the project.
        const attempt = inTenant(async (tx) => {
          await store.heartbeat(tx, { epoch: 1, orgId, runId }, TTL);
          beaten();
          await go;
          await checkpoints.lockProject(tx, ref);
        });
        await heartbeat;
        const second = inTenant((tx) =>
          store.claim(tx, { leaseTtlMs: TTL, orgId, owner: 'spec', runId }),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();

        await expect(attempt).resolves.toBeUndefined();
        expect(await second).toHaveProperty('heldUntil');
      });
    });

    describe('the reaper’s statements (US2)', () => {
      it('finds a leased run only once its lease is older than the cut-off', async () => {
        const runId = await seedClaimed();
        const staleBefore = (leadMs: number) =>
          inTenant((tx) => store.staleRuns(tx, new Date(clock.now().getTime() - leadMs)));

        // The lease runs to now + TTL; two TTLs ago is before it, a moment ago is not.
        expect((await staleBefore(TTL * 2)).map((run) => run.id)).not.toContain(runId);

        clock.advance(TTL * 3);

        expect(await staleBefore(TTL)).toContainEqual({
          id: runId,
          leaseEpoch: 1,
          status: 'starting',
        });
      });

      it('never finds a run that holds no lease, whatever its status', async () => {
        const runId = await seedRun();

        clock.advance(TTL * 3);

        expect(
          (await inTenant((tx) => store.staleRuns(tx, clock.now()))).map((run) => run.id),
        ).not.toContain(runId);
      });

      it('expireLease bumps the epoch under the one it read, and refuses a stale one', async () => {
        const runId = await seedClaimed();

        await inTenant((tx) => store.expireLease(tx, { epoch: 1, orgId, runId }));

        expect((await row(runId)).leaseEpoch).toBe(2);
        await expect(
          inTenant((tx) => store.expireLease(tx, { epoch: 1, orgId, runId })),
        ).rejects.toThrow(FencedError);
        expect((await row(runId)).leaseEpoch).toBe(2);
      });
    });

    describe('snapshot', () => {
      it('counts committed tool.end rows and paused states, and names an open step', async () => {
        const runId = await seedClaimed();
        const fence = { epoch: 1, orgId, runId };

        await inTenant(async (tx) => {
          await store.insertMessage(tx, { content: 'hello', orgId, role: 'user', runId });

          const seq = await store.allocateSeq(tx, fence, 4);
          const at = clock.now();

          await store.appendEvents(tx, fence, [
            { at, data: { input: {}, stepId: `${runId}/0`, tool: 't' }, seq, type: 'tool.start' },
            { at, data: { ok: true, stepId: `${runId}/0` }, seq: seq + 1, type: 'tool.end' },
            { at, data: { from: 'running', to: 'paused' }, seq: seq + 2, type: 'state' },
            {
              at,
              data: { input: {}, stepId: `${runId}/1`, tool: 't' },
              seq: seq + 3,
              type: 'tool.start',
            },
          ]);
        });

        const snapshot = await inTenant((tx) => store.snapshot(tx, orgId, runId));

        expect(snapshot.messages.map((message) => message.content)).toEqual(['hello']);
        expect(snapshot.committed).toEqual({ openStepId: `${runId}/1`, pauses: 1, toolEnds: 1 });
        expect(snapshot.lastSeq).toBe(6);
      });
    });

    describe('insertMessage', () => {
      it('stores tool calls on the row when given and [] otherwise', async () => {
        const runId = await seedClaimed();
        const calls = [{ id: 'c1', input: { path: 'a.txt' }, name: 'fs_read' }];

        await inTenant(async (tx) => {
          await store.insertMessage(tx, { content: 'plan', orgId, role: 'assistant', runId });
          clock.advance(1);
          await store.insertMessage(tx, {
            content: 'read',
            orgId,
            role: 'assistant',
            runId,
            toolCalls: calls,
          });
        });

        const snapshot = await inTenant((tx) => store.snapshot(tx, orgId, runId));

        expect(snapshot.messages.map((message) => message.toolCalls)).toEqual([[], calls]);
      });
    });

    describe('reads', () => {
      it('reads a run by project, lists newest first, and pages events after a seq', async () => {
        const first = await seedRun({ project: projectId });

        clock.advance(1_000);

        const second = await seedRun({ project: projectId });

        expect((await inTenant((tx) => store.readRun(tx, orgId, projectId, first)))?.id).toBe(
          first,
        );
        expect(
          await inTenant((tx) => store.readRun(tx, orgId, randomUUID(), first)),
        ).toBeUndefined();

        const listed = await inTenant((tx) => store.listRuns(tx, orgId, projectId, { limit: 2 }));

        expect(listed.runs.map((run) => run.id)).toEqual([second, first]);

        const page = await inTenant((tx) => store.readEvents(tx, orgId, first, 1, 10));

        expect(page).toEqual([]);
      });

      it('reads the project’s conversation across its runs, without its tool rows', async () => {
        const project = await seedProject();
        const first = await seedRun({ project, prompt: 'first' });

        await inTenant(async (tx) => {
          clock.advance(1_000);
          await store.insertMessage(tx, {
            content: 'reply',
            orgId,
            role: 'assistant',
            runId: first,
          });
          clock.advance(1_000);
          await store.insertMessage(tx, { content: 'tool out', orgId, role: 'tool', runId: first });
          clock.advance(1_000);
          await store.insertMessage(tx, { content: '', orgId, role: 'assistant', runId: first });
        });
        clock.advance(1_000);
        await seedRun({ project, prompt: 'second' });
        await seedRun({ project: await seedProject(), prompt: 'another project' });

        const page = await inTenant((tx) =>
          store.listProjectMessages(tx, orgId, project, { limit: 2 }),
        );

        expect(page.messages.map(({ content }) => content)).toEqual(['second', 'reply']);
        expect(page.nextCursor).toEqual(expect.any(String));

        const rest = await inTenant((tx) =>
          store.listProjectMessages(tx, orgId, project, { cursor: page.nextCursor!, limit: 2 }),
        );

        expect(rest.messages.map(({ content }) => content)).toEqual(['first']);
        expect(rest.nextCursor).toBeNull();
      });

      it('pages the run list by cursor and carries the prompt’s first line', async () => {
        const project = await seedProject();
        const first = await seedRun({ project, prompt: 'Build the landing page\nand ship it' });

        clock.advance(1_000);

        const second = await seedRun({ project, prompt: 'Second' });

        clock.advance(1_000);

        const third = await seedRun({ project });

        const page = await inTenant((tx) => store.listRuns(tx, orgId, project, { limit: 2 }));

        expect(page.runs.map((run) => run.id)).toEqual([third, second]);
        expect(page.nextCursor).toEqual(expect.any(String));
        expect(page.runs.map((run) => run.promptExcerpt)).toEqual(['', 'Second']);

        const rest = await inTenant((tx) =>
          store.listRuns(tx, orgId, project, { cursor: page.nextCursor!, limit: 2 }),
        );

        expect(rest.runs.map((run) => run.id)).toEqual([first]);
        expect(rest.nextCursor).toBeNull();
        expect(rest.runs[0]!.promptExcerpt).toBe('Build the landing page');
      });

      it('refuses a cursor it did not issue', async () => {
        await expect(
          inTenant((tx) => store.listRuns(tx, orgId, projectId, { cursor: 'bm90', limit: 2 })),
        ).rejects.toThrow(DomainError);
      });

      it('answers whether a cancel was requested', async () => {
        const runId = await seedRun();

        expect(await inTenant((tx) => store.cancelRequested(tx, orgId, runId))).toBe(false);

        await inTenant((tx) =>
          tx
            .update(schema.agentRuns)
            .set({ cancelRequestedAt: clock.now() })
            .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.orgId, orgId))),
        );

        expect(await inTenant((tx) => store.cancelRequested(tx, orgId, runId))).toBe(true);
      });
    });
  });
});

import { Inject, Injectable } from '@nestjs/common';
import type { DurableRunEventType, RunEvent, RunFailureClass, RunStatus } from '@repo/contracts';
import {
  type AgentRun,
  agentRuns,
  type ContextSkip,
  type NewProjectContext,
  type ProjectContext,
  projectContext,
  projects,
  type RunEventRow,
  runEvents,
  type RunMessage,
  runMessages,
} from '@repo/db';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { PermissionResolutionService } from '../rbac/permission-resolution.service';
import { scoped } from '../rbac/permissions';
import { transition as effectsOf, TERMINAL } from './run-state-machine';

/**
 * The one thing that touches the three run tables (spec 008 research R4). Every method takes the
 * transaction it runs in — the request's `tenant.tx` or one the worker opened through
 * `TenantTransactionRunner` — so a caller decides what commits together, and every statement
 * carries the caller's lease epoch when it has one: `and lease_epoch = $epoch` on an update,
 * `where exists (… lease_epoch = $epoch)` on an insert. Zero affected rows is `FencedError`.
 *
 * A fence without an epoch is the request side (create, input, resume): those states hold no
 * lease, and the request transaction's row lock is what keeps a concurrent worker out.
 */
/** A run-list row: the durable row plus the first line of its prompt (022). */
export interface AgentRunListRow extends AgentRun {
  readonly promptExcerpt: string;
}

/** A page of the run list, newest first, and where the next page starts (022 contracts § 2). */
export interface AgentRunPage {
  readonly nextCursor: string | null;
  readonly runs: AgentRunListRow[];
}

/**
 * `(created_at, id)` as one opaque token, the same encoding `CheckpointRepository` issues. Copied
 * rather than imported: `checkpoints` already depends on `agent`, so the reverse would be a cycle.
 */
function encodeCursor(row: Pick<AgentRun, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');

  if (id === undefined || Number.isNaN(at.getTime())) {
    throw new DomainError('bad-request', 'The cursor is not one this list issued.');
  }

  return { at, id };
}

export interface RunFence {
  readonly epoch?: number;
  readonly orgId: string;
  readonly runId: string;
}

/** A stale worker's write, refused. Never mapped to HTTP: it cannot reach a controller. */
export class FencedError extends DomainError {
  constructor(runId: string, statement: string, epoch: number | undefined) {
    super('conflict', `Run ${runId}: ${statement} refused; lease epoch ${String(epoch)} is stale.`);
  }
}

/** What `claim` hands `effect`: the ids, the model, the epoch it may write under, and where it starts. */
export interface Claim {
  readonly credentialChoice: 'organisation' | null;
  readonly epoch: number;
  readonly model: string;
  readonly userId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  /** After the claim: `starting` for a fresh run, else the state it stalled in. */
  readonly status: RunStatus;
}

/** What `claim` answers: the claim, or the moment the live lease that refused it runs out. */
export type ClaimResult = Claim | { readonly heldUntil: Date };

/** A row for `run_events`, as the batcher stamps it. */
export interface RunEventInput {
  readonly at: Date;
  readonly data: Record<string, unknown>;
  readonly seq: number;
  readonly type: DurableRunEventType;
}

export interface RunSnapshotRows {
  readonly committed: {
    readonly openStepId: string | null;
    readonly pauses: number;
    readonly toolEnds: number;
  };
  readonly lastSeq: number;
  readonly messages: RunMessage[];
}

/** A leased run the reaper found untouched past `staleAfterMs`. */
export interface StaleRun {
  readonly id: string;
  readonly leaseEpoch: number;
  readonly status: RunStatus;
}

/** The states a worker may claim: fresh, or stalled mid-flight. Waiting on a person is not one. */
const CLAIMABLE: readonly RunStatus[] = ['queued', 'starting', 'running', 'tool_error'];

/** The states a lease is held in — the only ones a stale lease can be found in. */
const LEASED: readonly RunStatus[] = ['starting', 'running', 'tool_error'];

@Injectable()
export class RunStore {
  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    // 031 R1: the project writer lock turn commits, saves and pulls already agree on.
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    // 031 R4: the starter's authority, checked when their run reaches the head of the line.
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
  ) {}

  /** 031 data-model § 1: the project's started, non-terminal run — at most one (R1a's index). */
  async holder(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<AgentRun | undefined> {
    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          isNotNull(agentRuns.startedAt),
          notInArray(agentRuns.status, [...TERMINAL]),
        ),
      )
      .limit(1);

    return row;
  }

  /** 031 data-model § 1: the never-started, non-terminal runs, in `(created_at, id)` order. */
  async line(tx: TenantTransaction, orgId: string, projectId: string): Promise<AgentRun[]> {
    return tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          isNull(agentRuns.startedAt),
          notInArray(agentRuns.status, [...TERMINAL]),
        ),
      )
      .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
  }

  /** A fresh `agent-run.requested` for a run (031 R2: the release consumer and the line sweep). */
  async dispatch(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string },
  ): Promise<void> {
    await this.outbox.append(tx, {
      aggregateId: run.runId,
      orgId: run.orgId,
      payload: run,
      type: 'agent-run.requested',
    });
  }

  /**
   * 031 R2: the heads of lines no run holds, created before `before` — the reaper's backstop for
   * an `agent-run.finished` whose release was lost. One row per project.
   */
  async staleHeads(
    tx: TenantTransaction,
    before: Date,
  ): Promise<{ id: string; projectId: string }[]> {
    const { rows } = await tx.execute<{ id: string; project_id: string }>(sql`
      select id, project_id from (
        select distinct on (w.project_id) w.id, w.project_id, w.created_at
        from ${agentRuns} w
        where w.started_at is null
          and w.status not in ('succeeded', 'failed', 'cancelled')
          and not exists (
            select 1 from ${agentRuns} h
            where h.org_id = w.org_id and h.project_id = w.project_id
              and h.started_at is not null
              and h.status not in ('succeeded', 'failed', 'cancelled')
          )
        order by w.project_id, w.created_at, w.id
      ) heads
      where heads.created_at < ${before.toISOString()}::timestamptz`);

    return rows.map((row) => ({ id: row.id, projectId: row.project_id }));
  }

  /** 031 R3: a run of this project that has never started and has not ended, locked for the cancel. */
  async waitingRun(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    runId: string,
  ): Promise<AgentRun | undefined> {
    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          eq(agentRuns.status, 'queued'),
          isNull(agentRuns.startedAt),
        ),
      )
      .for('update');

    return row;
  }

  /** 031 FR-019: one user's non-terminal runs on one project. */
  async liveRunsOf(
    tx: TenantTransaction,
    who: { orgId: string; projectId: string; userId: string },
  ): Promise<Pick<AgentRun, 'id' | 'startedAt' | 'status'>[]> {
    return tx
      .select({ id: agentRuns.id, startedAt: agentRuns.startedAt, status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, who.orgId),
          eq(agentRuns.projectId, who.projectId),
          eq(agentRuns.userId, who.userId),
          notInArray(agentRuns.status, [...TERMINAL]),
        ),
      );
  }

  async insertRun(
    tx: TenantTransaction,
    run: {
      credentialChoice?: 'organisation';
      /** Never `PLATFORM`: platform credits are retired; the enum keeps it for old rows only. */
      credentialMode?: 'BYOK' | 'BYOS';
      model: string;
      orgId: string;
      projectId: string;
      userId: string;
    },
  ): Promise<AgentRun> {
    const [row] = await tx.insert(agentRuns).values(run).returning();

    return row!;
  }

  /**
   * An answer's model switch (request side, like `input`'s transition: no lease to fence). The
   * caller's status-guarded `awaiting_input → queued` in the same transaction is what refuses a
   * run that moved on.
   */
  async setModel(tx: TenantTransaction, fence: RunFence, model: string): Promise<void> {
    await tx
      .update(agentRuns)
      .set({ model, updatedAt: this.clock.now() })
      .where(this.fenced(fence));
  }

  async insertMessage(
    tx: TenantTransaction,
    message: {
      content: string;
      orgId: string;
      role: RunMessage['role'];
      runId: string;
      toolCalls?: unknown[];
    },
  ): Promise<{ id: string }> {
    const [row] = await tx
      .insert(runMessages)
      .values({ ...message, at: this.clock.now(), toolCalls: message.toolCalls ?? [] })
      .returning({ id: runMessages.id });

    return row!;
  }

  /** `n` contiguous seqs; returns the first. The fence and the allocation are one statement (R3). */
  async allocateSeq(tx: TenantTransaction, fence: RunFence, n: number): Promise<number> {
    const [row] = await tx
      .update(agentRuns)
      .set({ nextSeq: sql`${agentRuns.nextSeq} + ${n}`, updatedAt: this.clock.now() })
      .where(this.fenced(fence))
      .returning({ nextSeq: agentRuns.nextSeq });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'allocateSeq', fence.epoch);
    }

    return row.nextSeq - n;
  }

  /** `insert … select … where exists (the run at this epoch)`: fenced, and one statement for the batch. */
  async appendEvents(
    tx: TenantTransaction,
    fence: RunFence,
    rows: readonly RunEventInput[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const epochClause =
      fence.epoch === undefined ? sql`` : sql`and ${agentRuns.leaseEpoch} = ${fence.epoch}`;
    const inserted = await tx.execute<{ seq: number }>(sql`
      insert into ${runEvents} (org_id, run_id, seq, type, data, at)
      select ${fence.orgId}::uuid, ${fence.runId}::uuid, e.seq, e.type, e.data, e.at
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        as e(seq integer, type text, data jsonb, at timestamptz)
      where exists (
        select 1 from ${agentRuns}
        where ${agentRuns.id} = ${fence.runId} and ${agentRuns.orgId} = ${fence.orgId} ${epochClause}
      )
      returning seq`);

    if (inserted.rows.length !== rows.length) {
      throw new FencedError(fence.runId, 'appendEvents', fence.epoch);
    }
  }

  /**
   * One status change: the row `where status = from [and lease_epoch = epoch]`, the state
   * machine's effects, one seq and the `state` event — all on the caller's transaction. A
   * transition that ends the run also appends `agent-run.finished` there (spec 029 T040), the
   * webhook fan-out's source for `run.completed`.
   */
  async transition(
    tx: TenantTransaction,
    change: RunFence & {
      failureClass?: RunFailureClass;
      from: RunStatus;
      /** A subscription run's structured failure, carried on the `state` event as the schema has it. */
      localAgentFailure?: Extract<RunEvent, { type: 'state' }>['data']['localAgentFailure'];
      reason?: string;
      /** 032 T046: a subscription limit's reset, carried on the `state` event as ISO. */
      resetsAt?: Date;
      to: RunStatus;
    },
  ): Promise<void> {
    const { failureClass, from, localAgentFailure, reason, resetsAt, to, ...fence } = change;
    const effects = effectsOf(from, to);
    const now = this.clock.now();
    const [row] = await tx
      .update(agentRuns)
      .set({
        status: to,
        updatedAt: now,
        ...(effects.endsRun ? { endedAt: now } : {}),
        ...(effects.releasesLease ? { leaseUntil: null } : {}),
        ...(effects.setsStartedAt ? { startedAt: now } : {}),
        ...(to === 'failed' ? { failureClass: failureClass ?? 'internal' } : {}),
      })
      .where(and(this.fenced(fence), eq(agentRuns.status, from)))
      .returning({ id: agentRuns.id, projectId: agentRuns.projectId });

    if (row === undefined) {
      throw new FencedError(fence.runId, `transition ${from} → ${to}`, fence.epoch);
    }

    const seq = await this.allocateSeq(tx, fence, 1);

    await this.appendEvents(tx, fence, [
      {
        at: now,
        data: {
          from,
          to,
          ...(reason === undefined ? {} : { reason }),
          ...(resetsAt === undefined ? {} : { resetsAt: resetsAt.toISOString() }),
          ...(localAgentFailure === undefined ? {} : { localAgentFailure }),
        },
        seq,
        type: 'state',
      },
    ]);

    if (effects.endsRun) {
      await this.outbox.append(tx, {
        aggregateId: fence.runId,
        orgId: fence.orgId,
        payload: {
          orgId: fence.orgId,
          outcome: to as 'cancelled' | 'failed' | 'succeeded',
          projectId: row.projectId,
          runId: fence.runId,
        },
        type: 'agent-run.finished',
      });
    }
  }

  /**
   * Compare-and-set the lease (research R5): `lease_epoch + 1`, a fresh `lease_until`, and
   * `queued → starting` with its `state` event when the run is fresh. `undefined` when the run is
   * terminal or waiting on a person; `{ heldUntil }` when a live lease holds it — the queue may
   * re-deliver a stalled run before its lease has run out, and the caller waits that out rather
   * than dropping the delivery. The `for update` read serialises two workers on the row, so
   * exactly one of them sees a claimable row.
   */
  async claim(
    tx: TenantTransaction,
    request: { leaseTtlMs: number; orgId: string; owner: string; runId: string },
  ): Promise<ClaimResult | undefined> {
    const { leaseTtlMs, orgId, owner, runId } = request;
    const now = this.clock.now();
    // `project_id` never changes, so it is safe to read before the lock that everything else
    // below is read under.
    const [peek] = await tx
      .select({ projectId: agentRuns.projectId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));

    if (peek === undefined) {
      return undefined;
    }

    // 031 R1 step 1: every claim on one project runs under one lock, so two cannot both see
    // "no holder" (FR-004).
    await this.checkpoints.lockProject(tx, { orgId, projectId: peek.projectId });

    const [before] = await tx
      .select({
        leaseUntil: agentRuns.leaseUntil,
        startedAt: agentRuns.startedAt,
        status: agentRuns.status,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
      .for('update');

    if (before === undefined || !CLAIMABLE.includes(before.status)) {
      return undefined;
    }

    // Step 2: a run with `started_at` is the holder (resumed, re-delivered, re-claimed) and
    // claims as before. Steps 3–4 are for a run that has never touched the project.
    if (
      before.startedAt === null &&
      !(await this.passesGate(tx, {
        orgId,
        projectId: peek.projectId,
        runId,
        userId: before.userId,
      }))
    ) {
      return undefined;
    }

    if (before.leaseUntil !== null && before.leaseUntil >= now) {
      return { heldUntil: before.leaseUntil };
    }

    const [row] = await tx
      .update(agentRuns)
      .set({
        leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + leaseTtlMs),
        startedAt: sql`coalesce(${agentRuns.startedAt}, ${now}::timestamptz)`,
        status: sql`case when ${agentRuns.status} = 'queued' then 'starting'::run_status else ${agentRuns.status} end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.orgId, orgId),
          inArray(agentRuns.status, [...CLAIMABLE]),
          or(isNull(agentRuns.leaseUntil), lt(agentRuns.leaseUntil, now)),
        ),
      )
      .returning({
        credentialChoice: agentRuns.credentialChoice,
        epoch: agentRuns.leaseEpoch,
        model: agentRuns.model,
        projectId: agentRuns.projectId,
        status: agentRuns.status,
        userId: agentRuns.userId,
      });

    if (row === undefined) {
      return undefined;
    }

    const claim: Claim = { ...row, orgId, runId };

    if (before.status === 'queued') {
      const fence = { epoch: claim.epoch, orgId, runId };
      const seq = await this.allocateSeq(tx, fence, 1);

      await this.appendEvents(tx, fence, [
        { at: now, data: { from: 'queued', to: 'starting' }, seq, type: 'state' },
      ]);
    }

    return claim;
  }

  /**
   * 031 R1 steps 3–4: the head of an unheld line, whose starter still may run the agent here.
   *
   * Fail-closed (plan § Constitution III): a head whose starter's resolved set lacks
   * `project:agent.run@<project>` — removed, downgraded, or the project archived (the resolver
   * drops archived projects, FR-009) — is cancelled with `reason: 'access-lost'` rather than run
   * on authority it no longer has. The transition emits `agent-run.finished`, so the next head
   * is tried.
   */
  private async passesGate(
    tx: TenantTransaction,
    run: { orgId: string; projectId: string; runId: string; userId: string },
  ): Promise<boolean> {
    const { orgId, projectId, runId, userId } = run;

    if ((await this.holder(tx, orgId, projectId)) !== undefined) {
      return false;
    }

    const [head] = await this.line(tx, orgId, projectId);

    if (head?.id !== runId) {
      return false;
    }

    const granted = await this.permissions.for(orgId, userId);

    if (!granted.has(scoped('project:agent.run', projectId))) {
      await this.transition(tx, {
        from: 'queued',
        orgId,
        reason: 'access-lost',
        runId,
        to: 'cancelled',
      });

      return false;
    }

    return true;
  }

  async heartbeat(tx: TenantTransaction, fence: RunFence, leaseTtlMs: number): Promise<void> {
    const now = this.clock.now();
    const [row] = await tx
      .update(agentRuns)
      .set({ leaseUntil: new Date(now.getTime() + leaseTtlMs), updatedAt: now })
      .where(this.fenced(fence))
      .returning({ id: agentRuns.id });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'heartbeat', fence.epoch);
    }
  }

  /** The leased runs of this tenant whose lease expired before `before` — the reaper's read (R5). */
  async staleRuns(tx: TenantTransaction, before: Date): Promise<StaleRun[]> {
    return tx
      .select({ id: agentRuns.id, leaseEpoch: agentRuns.leaseEpoch, status: agentRuns.status })
      .from(agentRuns)
      .where(and(inArray(agentRuns.status, [...LEASED]), lt(agentRuns.leaseUntil, before)));
  }

  /**
   * The reaper's fence: `lease_epoch + 1` under the epoch it read, so the stalled worker's every
   * later write is refused and the reaper's own transition runs under the new epoch. A worker
   * that re-claimed in between already moved the epoch on, and this is the `FencedError`.
   */
  async expireLease(tx: TenantTransaction, fence: RunFence): Promise<void> {
    const [row] = await tx
      .update(agentRuns)
      .set({ leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`, updatedAt: this.clock.now() })
      .where(this.fenced(fence))
      .returning({ id: agentRuns.id });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'expireLease', fence.epoch);
    }
  }

  /** 020 R6: the executor stamps what this attempt runs on, fenced like every worker write. */
  async setCredentialMode(
    tx: TenantTransaction,
    fence: RunFence,
    mode: AgentRun['credentialMode'],
  ): Promise<void> {
    const [row] = await tx
      .update(agentRuns)
      .set({ credentialMode: mode, updatedAt: this.clock.now() })
      .where(this.fenced(fence))
      .returning({ id: agentRuns.id });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'setCredentialMode', fence.epoch);
    }
  }

  /**
   * The `usage` roll-up onto the row, fenced like everything else the worker writes. 021 (R6):
   * the cache read and write tokens land in their own columns and in `input_tokens` too, so the
   * total stays comparable with 011's, which folded all three together.
   */
  async addUsage(
    tx: TenantTransaction,
    fence: RunFence,
    totals: {
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costMicros: number;
      inputTokens: number;
      outputTokens: number;
    },
  ): Promise<void> {
    const [row] = await tx
      .update(agentRuns)
      .set({
        cacheReadTokens: sql`${agentRuns.cacheReadTokens} + ${totals.cacheReadTokens}`,
        cacheWriteTokens: sql`${agentRuns.cacheWriteTokens} + ${totals.cacheWriteTokens}`,
        costMicros: sql`${agentRuns.costMicros} + ${totals.costMicros}`,
        inputTokens: sql`${agentRuns.inputTokens} + ${totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens}`,
        outputTokens: sql`${agentRuns.outputTokens} + ${totals.outputTokens}`,
        updatedAt: this.clock.now(),
      })
      .where(this.fenced(fence))
      .returning({ id: agentRuns.id });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'addUsage', fence.epoch);
    }
  }

  /** 021 R4: the running summary, the last row it covers and its token estimate, fenced. */
  async setSummary(
    tx: TenantTransaction,
    fence: RunFence,
    summary: { summary: string; throughMessageId: string; tokens: number },
  ): Promise<void> {
    const [row] = await tx
      .update(agentRuns)
      .set({
        summary: summary.summary,
        summaryThroughMessageId: summary.throughMessageId,
        summaryTokens: summary.tokens,
        updatedAt: this.clock.now(),
      })
      .where(this.fenced(fence))
      .returning({ id: agentRuns.id });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'setSummary', fence.epoch);
    }
  }

  /** 021 R7: one more skipped context step on the row, fenced. */
  async appendContextSkip(
    tx: TenantTransaction,
    fence: RunFence,
    skip: ContextSkip,
  ): Promise<void> {
    const [row] = await tx
      .update(agentRuns)
      .set({
        contextSkips: sql`${agentRuns.contextSkips} || ${JSON.stringify([skip])}::jsonb`,
        updatedAt: this.clock.now(),
      })
      .where(this.fenced(fence))
      .returning({ id: agentRuns.id });

    if (row === undefined) {
      throw new FencedError(fence.runId, 'appendContextSkip', fence.epoch);
    }
  }

  /** 021 R2: the tree state the project's map was built from; `undefined` until the first build. */
  async getProjectContext(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<ProjectContext | undefined> {
    const [row] = await tx
      .select()
      .from(projectContext)
      .where(and(eq(projectContext.orgId, orgId), eq(projectContext.projectId, projectId)));

    return row;
  }

  /** One row per project: insert or replace the map and the state it was built from. */
  async upsertProjectContext(tx: TenantTransaction, row: NewProjectContext): Promise<void> {
    const now = this.clock.now();

    await tx
      .insert(projectContext)
      .values({ ...row, updatedAt: now })
      .onConflictDoUpdate({
        set: {
          dirtyDigest: row.dirtyDigest,
          headSha: row.headSha,
          repoMap: row.repoMap,
          updatedAt: now,
        },
        target: [projectContext.orgId, projectContext.projectId],
      });
  }

  /**
   * The request side of cancel (R7): the flag set once — `coalesce` keeps the first ask — on a run
   * of this project that has not ended, answering the status it found and whether this ask was
   * the first. `undefined` is "no such live run": the caller reads the row to tell not-found from
   * a terminal state. No epoch: the request holds no lease, and the worker reads the flag at its
   * next boundary whatever it holds.
   */
  async requestCancel(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    runId: string,
  ): Promise<{ first: boolean; status: RunStatus } | undefined> {
    const now = this.clock.now();
    const [row] = await tx
      .update(agentRuns)
      .set({
        cancelRequestedAt: sql`coalesce(${agentRuns.cancelRequestedAt}, ${now}::timestamptz)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          notInArray(agentRuns.status, [...TERMINAL]),
        ),
      )
      .returning({ cancelRequestedAt: agentRuns.cancelRequestedAt, status: agentRuns.status });

    return row && { first: row.cancelRequestedAt?.getTime() === now.getTime(), status: row.status };
  }

  /** The row flag — the truth `cancelled()` falls back to when the control channel said nothing. */
  async cancelRequested(tx: TenantTransaction, orgId: string, runId: string): Promise<boolean> {
    const [row] = await tx
      .select({ at: agentRuns.cancelRequestedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));

    return row?.at != null;
  }

  async readRun(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    runId: string,
  ): Promise<AgentRun | undefined> {
    const [row] = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
        ),
      );

    return row;
  }

  /**
   * Newest first, keyset on `(created_at, id)` over the list index; `limit + 1` decides the cursor,
   * exactly as `CheckpointRepository.list` does. The excerpt rides along as a correlated subquery
   * over `run_messages` — one index seek per row on `(org_id, run_id, at)`, no second round trip.
   */
  async listRuns(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    page: { cursor?: string; limit: number },
  ): Promise<AgentRunPage> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const rows = await tx
      .select({
        ...getTableColumns(agentRuns),
        // Written out rather than interpolated: drizzle renders a column reference in a select
        // field unqualified, which would make the correlation `run_id = id` against the subquery's
        // own table. Identifiers only, no values, so there is nothing here to parameterise.
        promptExcerpt: sql<string>`coalesce((
          select left(btrim(split_part(m.content, chr(10), 1)), 120)
          from run_messages m
          where m.org_id = agent_runs.org_id and m.run_id = agent_runs.id and m.role = 'user'
          order by m.at, m.id
          limit 1
        ), '')`.as('prompt_excerpt'),
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          after === undefined
            ? undefined
            : or(
                lt(agentRuns.createdAt, after.at),
                and(eq(agentRuns.createdAt, after.at), lt(agentRuns.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(page.limit + 1);
    const runs = rows.slice(0, page.limit);

    return {
      nextCursor: rows.length > page.limit ? encodeCursor(runs.at(-1)!) : null,
      runs,
    };
  }

  /**
   * Settings → Usage: the runs `userId` started in the organisation, every project, newest first,
   * keyset exactly as `listRuns`. The project's name is joined on the composite FK rather than
   * asked of `ProjectService`, whose reads drop archived projects — a run's spend outlives that.
   * shortcut: no `(org_id, user_id, created_at)` index, so this filters the org's runs; add one
   * (an additive migration) once an organisation's run count makes the page slow.
   */
  async listUsage(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    page: { cursor?: string; limit: number },
  ): Promise<{ nextCursor: string | null; runs: (AgentRun & { projectName: string })[] }> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor);
    const rows = await tx
      .select({ ...getTableColumns(agentRuns), projectName: projects.name })
      .from(agentRuns)
      .innerJoin(
        projects,
        and(eq(projects.orgId, agentRuns.orgId), eq(projects.id, agentRuns.projectId)),
      )
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.userId, userId),
          after === undefined
            ? undefined
            : or(
                lt(agentRuns.createdAt, after.at),
                and(eq(agentRuns.createdAt, after.at), lt(agentRuns.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(page.limit + 1);
    const runs = rows.slice(0, page.limit);

    return {
      nextCursor: rows.length > page.limit ? encodeCursor(runs.at(-1)!) : null,
      runs,
    };
  }

  /** `seq > after`, ascending, at most `limit` — the primary key's prefix, never a scan. */
  async readEvents(
    tx: TenantTransaction,
    orgId: string,
    runId: string,
    after: number,
    limit: number,
  ): Promise<RunEventRow[]> {
    return tx
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.orgId, orgId), eq(runEvents.runId, runId), gt(runEvents.seq, after)))
      .orderBy(asc(runEvents.seq))
      .limit(limit);
  }

  /** The run's rows in conversation order — what `toMessages` and the summary marker index. */
  async listMessages(tx: TenantTransaction, orgId: string, runId: string): Promise<RunMessage[]> {
    return tx
      .select()
      .from(runMessages)
      .where(and(eq(runMessages.orgId, orgId), eq(runMessages.runId, runId)))
      .orderBy(asc(runMessages.at), asc(runMessages.id));
  }

  /** What a resuming executor positions itself by: the conversation and the committed tool steps. */
  async snapshot(tx: TenantTransaction, orgId: string, runId: string): Promise<RunSnapshotRows> {
    const messages = await this.listMessages(tx, orgId, runId);
    const events = await tx
      .select({ data: runEvents.data, seq: runEvents.seq, type: runEvents.type })
      .from(runEvents)
      .where(and(eq(runEvents.orgId, orgId), eq(runEvents.runId, runId)))
      .orderBy(asc(runEvents.seq));

    let toolEnds = 0;
    let pauses = 0;
    let openStepId: string | null = null;

    for (const event of events) {
      if (event.type === 'tool.start') {
        openStepId = String(event.data.stepId);
      } else if (event.type === 'tool.end') {
        toolEnds += 1;
        openStepId = null;
      } else if (event.type === 'state' && event.data.to === 'paused') {
        pauses += 1;
      }
    }

    return {
      committed: { openStepId, pauses, toolEnds },
      lastSeq: events.at(-1)?.seq ?? 0,
      messages,
    };
  }

  private fenced(fence: RunFence) {
    return and(
      eq(agentRuns.id, fence.runId),
      eq(agentRuns.orgId, fence.orgId),
      fence.epoch === undefined ? undefined : eq(agentRuns.leaseEpoch, fence.epoch),
    );
  }
}

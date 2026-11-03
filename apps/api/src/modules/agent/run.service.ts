import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SubscriptionRunTarget,
  RunEvent,
  RunEventsResponse,
  RunListResponse,
  RunResponse,
} from '@repo/contracts';
import type { AgentRun, RunEventRow } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { TenantContext } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { ProjectService } from '../tenancy/services/project.service';
import { RUN_LINE_LIMIT } from './agent.constants';
import { keyRefusal } from './byok/byok.errors';
import { subscriptionRefusal } from './byos/byos.errors';
import { CredentialResolver } from './byok/credential-resolver';
import { RunControl } from './run-control';
import { RunExecutorRegistry } from './run-executor-registry';
import { isLeased } from './run-state-machine';
import { RunStore } from './run-store';
import { RunStreamPublisher } from './run-stream-publisher';

/**
 * The request side of a run (spec 008 US1/US3/US4): create, read, list, events, cancel, input — every write
 * on the request's tenant transaction, every read under RLS. The worker side is `AgentRunConsumer`.
 */
@Injectable()
export class RunService {
  private readonly model: string;

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(RunControl) private readonly control: RunControl,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
    @Inject(RunStreamPublisher) private readonly publisher: RunStreamPublisher,
    // 020 R6: the refusal before any sandbox work; `kindOnly` never opens the sealed key.
    @Inject(CredentialResolver) private readonly resolver: CredentialResolver,
    // 031 R3: the line is counted under the project writer lock the claim takes.
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    // 041: admits a `subscription` target (empty when they are off). Required: whether a run
    // is local decides who may answer it, so it must never be skipped for want of the registry.
    @Inject(RunExecutorRegistry) private readonly executors: RunExecutorRegistry,
  ) {
    this.model = config.get('AGENT_DEFAULT_MODEL', { infer: true });
  }

  /**
   * The row in `queued`, the prompt as message 1, `seq` 1's `state` event, the audit row and the
   * `agent-run.requested` outbox row — one transaction, so the run is durable before the response
   * and dispatched only if it committed (research R1). `ProjectService.read` is the liveness
   * check the guard cannot make: an archived project answers `404` and nothing is written.
   */
  async create(
    orgId: string,
    projectId: string,
    userId: string,
    prompt: string,
    requestedModel?: string,
    credential?: 'organisation',
    subscription?: SubscriptionRunTarget,
  ): Promise<RunResponse> {
    const tx = this.tenant.tx;
    // 041: a subscription run is paid for by the person's own Claude sign-in in their cloud agent
    // home, so there is no credential to resolve; `model` is that CLI's id or alias, and the
    // provider's name stands for its default.
    const local = subscription === undefined ? undefined : this.executors.localAgent();

    if (subscription !== undefined && local === undefined) {
      throw new DomainError(
        'subscription-unavailable',
        'Running Claude Code on your own subscription is not available on this deployment.',
      );
    }

    const model = requestedModel ?? subscription?.provider ?? this.model;
    const resolution =
      local === undefined
        ? await this.resolver.kindOnly(
            tx,
            orgId,
            userId,
            model,
            credential === undefined ? {} : { credential },
          )
        : ({ kind: 'local' } as const);

    // 032 R7: the starter's subscription refuses rather than falling through (FR-014).
    if (
      resolution.kind === 'subscription-needs-reauth' ||
      resolution.kind === 'subscription-limited'
    ) {
      throw subscriptionRefusal(resolution);
    }

    if (resolution.kind === 'needs_reauth') {
      throw keyRefusal('needs-reauth', {
        keyLastFour: resolution.lastFour,
        provider: resolution.provider,
      });
    }

    if (resolution.kind === 'unknown-model' || resolution.kind === 'no-credential') {
      throw new DomainError('validation-failed', "model is not in the organisation's catalogue", {
        model,
      });
    }

    await this.projects.read(orgId, projectId);

    // 031 R3: the count and the insert under the project's writer lock, so two starts cannot
    // both see four waiting and make seven.
    await this.checkpoints.lockProject(tx, { orgId, projectId });

    if ((await this.store.line(tx, orgId, projectId)).length >= RUN_LINE_LIMIT) {
      throw new ConflictError(
        'Five runs are already waiting on this project. Try again when one has started.',
        { reason: 'queue-full' },
      );
    }

    const run = await this.store.insertRun(tx, {
      ...(credential === undefined ? {} : { credentialChoice: credential }),
      model,
      orgId,
      projectId,
      userId,
    });
    const fence = { orgId, runId: run.id };

    await this.store.insertMessage(tx, { content: prompt, orgId, role: 'user', runId: run.id });

    // Refuses (no agent home, not signed in) or records the target, in this transaction: a refused
    // run never committed.
    if (local !== undefined && subscription !== undefined) {
      await local.admitSubscription(tx, { orgId, projectId, runId: run.id, userId }, subscription);
    }

    const seq = await this.store.allocateSeq(tx, fence, 1);

    await this.store.appendEvents(tx, fence, [
      { at: this.clock.now(), data: { from: null, to: 'queued' }, seq, type: 'state' },
    ]);
    await this.audit.record(tx, {
      action: 'agent-run.created',
      actorId: userId,
      metadata: { model, projectId },
      orgId,
      target: run.id,
    });
    await this.outbox.append(tx, {
      aggregateId: run.id,
      orgId,
      payload: { orgId, projectId, runId: run.id },
      type: 'agent-run.requested',
    });
    // Seq 1 reaches the stream once it is committed (009 research R1), like cancel's publish.
    this.tenant.onCommit(() => this.publisher.sync(orgId, run.id).then(() => undefined));

    return toResponse({ ...run, nextSeq: seq + 1 });
  }

  /**
   * FR-021 / research R7: the flag is set once and the audit row written with it; the channel
   * message goes out after commit, so a worker that hears it always finds the flag on the row. A
   * repeat on a live run answers success again and writes nothing more; a run that has ended
   * answers conflict naming the state it is in, and nothing is written.
   */
  async cancel(orgId: string, projectId: string, runId: string, actorId: string): Promise<void> {
    const tx = this.tenant.tx;

    // 031 R3: a run that never started has nothing to stop cooperatively — it is cancelled here,
    // and the terminal transition's `agent-run.finished` releases whatever waits behind it.
    if ((await this.store.waitingRun(tx, orgId, projectId, runId)) !== undefined) {
      await this.store.transition(tx, {
        from: 'queued',
        orgId,
        reason: 'cancelled-waiting',
        runId,
        to: 'cancelled',
      });
      await this.audit.record(tx, {
        action: 'agent-run.cancel-requested',
        actorId,
        metadata: { projectId, status: 'queued' },
        orgId,
        target: runId,
      });
      this.tenant.onCommit(() => this.publisher.sync(orgId, runId).then(() => undefined));

      return;
    }

    const live = await this.store.requestCancel(tx, orgId, projectId, runId);

    if (live === undefined) {
      throw new ConflictError(`Run is ${(await this.row(orgId, projectId, runId)).status}.`);
    }

    // No worker holds a run waiting on a person, paused, or re-queued and not yet claimed, so none
    // would hear the channel: it ends here, under the row lock the flag's update took (a claim
    // waits on it and then finds the run over), and its `agent-run.finished` releases the line.
    // A repeat still ends it, so a run asked before this existed is not left holding the project.
    const held = isLeased(live.status);

    if (!held) {
      const fence = { orgId, runId };
      const local = (await this.executors.isLocal(tx, orgId, runId))
        ? this.executors.localAgent()
        : undefined;

      await this.store.transition(tx, {
        ...fence,
        from: live.status,
        reason: 'cancelled-waiting',
        to: 'cancelled',
      });
      this.tenant.onCommit(async () => {
        await this.publisher.sync(orgId, runId);
        // Best effort after commit: the run is already over, and the keys expire on their own.
        await local?.release(runId).catch(() => undefined);
      });
    }

    if (!live.first) {
      return;
    }

    await this.audit.record(tx, {
      action: 'agent-run.cancel-requested',
      actorId,
      metadata: { projectId, status: live.status },
      orgId,
      target: runId,
    });

    if (held) {
      this.tenant.onCommit(() => this.control.publish(runId, 'cancel'));
    }
  }

  /**
   * US4: the answer is message 2 and the run goes back through the queue — `awaiting_input →
   * queued` with no epoch (nobody holds the run in that state), a fresh `agent-run.requested`
   * row, and the executor picks the script up past the input it now has. Any other state is
   * conflict, naming it.
   *
   * 041: a subscription run takes input from its starter only — the prompt runs on their own
   * Claude sign-in — and none at all where subscription runs are off. (Cancel stays open to every
   * member with `project:agent.run`: stopping a run is always safe.)
   */
  async input(
    orgId: string,
    projectId: string,
    runId: string,
    actorId: string,
    message: string,
  ): Promise<void> {
    const executors = this.executors;

    if (await executors.isLocal(this.tenant.tx, orgId, runId)) {
      if (executors.localAgent() === undefined) {
        throw new ConflictError('Subscription runs are not enabled on this deployment.', {
          reason: 'local-agent-disabled',
        });
      }

      if ((await this.row(orgId, projectId, runId)).userId !== actorId) {
        throw new ForbiddenError(
          'Only the person who started this run can answer it: it runs on their own subscription.',
        );
      }
    }

    await this.requeue(orgId, projectId, runId, 'awaiting_input', async (tx) => {
      const inserted = await this.store.insertMessage(tx, {
        content: message,
        orgId,
        role: 'user',
        runId,
      });

      await this.audit.record(tx, {
        action: 'agent-run.input',
        actorId,
        metadata: { messageId: inserted.id, projectId },
        orgId,
        target: runId,
      });
    });
  }

  /** `paused → queued` and a new dispatch. No route until 019: the reaper and the suites call it. */
  async resume(orgId: string, projectId: string, runId: string): Promise<void> {
    await this.requeue(orgId, projectId, runId, 'paused');
  }

  private async requeue(
    orgId: string,
    projectId: string,
    runId: string,
    from: 'awaiting_input' | 'paused',
    before?: (tx: TenantTransaction) => Promise<void>,
  ): Promise<void> {
    const run = await this.row(orgId, projectId, runId);

    if (run.status !== from) {
      throw new ConflictError(`Run is ${run.status}.`);
    }

    const tx = this.tenant.tx;

    await before?.(tx);
    await this.store.transition(tx, { from, orgId, runId, to: 'queued' });
    await this.outbox.append(tx, {
      aggregateId: runId,
      orgId,
      payload: { orgId, projectId, runId },
      type: 'agent-run.requested',
    });
    this.tenant.onCommit(() => this.publisher.sync(orgId, runId).then(() => undefined));
  }

  /** `404` for an unknown run and for a run of another project alike: the path names the project. */
  async read(orgId: string, projectId: string, runId: string): Promise<RunResponse> {
    return toResponse(await this.row(orgId, projectId, runId));
  }

  /** Newest first, cursor-paged; each row carries the first line of its prompt (022). */
  async list(
    orgId: string,
    projectId: string,
    page: { cursor?: string; limit: number },
  ): Promise<RunListResponse> {
    const { nextCursor, runs } = await this.store.listRuns(this.tenant.tx, orgId, projectId, page);

    return { nextCursor, runs: runs.map((run) => toResponse(run, run.promptExcerpt)) };
  }

  async events(
    orgId: string,
    projectId: string,
    runId: string,
    after: number,
    limit: number,
  ): Promise<RunEventsResponse> {
    const run = await this.row(orgId, projectId, runId);
    const rows = await this.store.readEvents(this.tenant.tx, orgId, runId, after, limit);

    return { events: rows.map(toEvent), lastSeq: run.nextSeq - 1 };
  }

  private async row(orgId: string, projectId: string, runId: string): Promise<AgentRun> {
    const row = await this.store.readRun(this.tenant.tx, orgId, projectId, runId);

    if (row === undefined) {
      throw new NotFoundError('No such run.');
    }

    return row;
  }
}

/** The wire shape: no lease, no `next_seq` (as `lastSeq`), no credential mode, no cost. Exported for the stream reader's `stream.reset` snapshot (009). */
export function toResponse(run: AgentRun, promptExcerpt = ''): RunResponse {
  return {
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    contextSkips: run.contextSkips,
    createdAt: run.createdAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
    failureClass: run.failureClass,
    id: run.id,
    inputTokens: run.inputTokens,
    lastSeq: run.nextSeq - 1,
    model: run.model,
    outputTokens: run.outputTokens,
    projectId: run.projectId,
    promptExcerpt,
    startedAt: run.startedAt?.toISOString() ?? null,
    status: run.status,
    userId: run.userId,
  };
}

/** The store is the only writer and writes contract shapes, so the row is the envelope. */
export function toEvent(row: RunEventRow): RunEvent {
  return {
    at: row.at.toISOString(),
    data: row.data,
    run: row.runId,
    seq: row.seq,
    type: row.type,
  } as RunEvent;
}

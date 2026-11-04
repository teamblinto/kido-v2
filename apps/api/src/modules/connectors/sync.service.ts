import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SyncCommitRequest,
  SyncCommitResponse,
  SyncKind,
  SyncOperation as SyncOperationContract,
  SyncTrigger,
} from '@repo/contracts';

import { ConflictError, DomainError, NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import type { SandboxRef } from '../sandbox/sandbox.port';
import { ConnectionService } from './connection.service';
import { syncConflict } from './connectors.errors';
import { RepoLinkRepository } from './repo-link.repository';
import {
  isUniqueViolation,
  type SyncPage,
  type SyncRecord,
  SyncRepository,
} from './sync.repository';

/**
 * A push or pull request (spec 018 US2/US3, contracts § 3–4): every refusal of § 4 is decided
 * here, before a row exists (SC-011); what passes is one `queued` row and its `sync.requested`
 * on the same transaction. The consumers (T028, T034) do the work.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {}

  async request(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    kind: SyncKind,
  ): Promise<SyncOperationContract> {
    const project = await this.project(tx, ref);
    const link = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (link?.state !== 'linked') {
      throw syncConflict('not-linked', 'The project is not linked to a repository.');
    }

    await this.connections.ensureUsable(tx, ref.orgId);

    if (await this.operations.inFlightExists(tx, ref.orgId, ref.projectId)) {
      throw syncConflict('operation-in-flight', 'A push or pull is already in progress.');
    }

    if (kind === 'push' && (await this.checkpoints.head(tx, ref)) === null) {
      throw syncConflict('nothing-to-push', 'The project has no checkpoint yet.');
    }

    if (kind === 'pull') {
      if (project.archived) {
        throw new ConflictError('The project is archived.');
      }

      if (await this.checkpoints.activeRunExists(tx, ref)) {
        throw syncConflict('run-active', 'A run is in progress; a pull waits for it to end.');
      }
    }

    let id: string;

    try {
      id = (
        await this.operations.insertQueued(tx, {
          kind,
          linkId: link.id,
          orgId: ref.orgId,
          projectId: ref.projectId,
          requestedBy: actorId,
          trigger: 'manual',
        })
      ).id;
    } catch (error) {
      // R7: the partial unique index is the second net — a concurrent request took the slot.
      if (isUniqueViolation(error)) {
        throw syncConflict('operation-in-flight', 'A push or pull is already in progress.');
      }

      throw error;
    }

    return this.enqueued(tx, ref, id);
  }

  /**
   * Spec 044: a push that refuses nothing, the primitive under the automatic path and the one-click
   * commit. `null` when there is nothing to do: no link, no head, the head already pushed, or the
   * slot taken — a settling operation's trailing edge carries a head that found it so.
   */
  async requestPush(
    tx: TenantTransaction,
    ref: SandboxRef,
    { actorId, trigger }: { actorId: string; trigger: SyncTrigger },
  ): Promise<SyncOperationContract | null> {
    const link = await this.links.forProject(tx, ref.orgId, ref.projectId);
    const head = await this.checkpoints.head(tx, ref);

    if (link?.state !== 'linked' || head === null || link.lastPushedCheckpointId === head.id) {
      return null;
    }

    const row = await this.operations.insertQueuedIfFree(tx, {
      kind: 'push',
      linkId: link.id,
      orgId: ref.orgId,
      projectId: ref.projectId,
      requestedBy: actorId,
      trigger,
    });

    return row === undefined ? null : this.enqueued(tx, ref, row.id);
  }

  /**
   * Spec 044 decisions 1 and 3: the push nobody clicked. Never a refusal, only `null`: whoever calls
   * this is about something else, and must not fail for a connection that is down. A side push
   * leaves the link's pointer alone, so its row is what says that head has gone as far as it can.
   */
  async requestAuto(tx: TenantTransaction, ref: SandboxRef): Promise<SyncOperationContract | null> {
    const link = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (link?.state !== 'linked' || !link.autoSync) return null;

    try {
      await this.connections.ensureUsable(tx, ref.orgId);
    } catch (error) {
      // `ensureUsable` only reads: a refusal has no write to lose, and anything else is not one.
      if (!(error instanceof DomainError)) throw error;
      this.logger.log(`auto-sync skipped: project=${ref.projectId} type=${error.type}`);

      return null;
    }

    const head = await this.checkpoints.head(tx, ref);
    const last = await this.operations.latest(tx, ref, link.id, 'succeeded');

    // A row for a branch the link has since left says nothing about the branch it points at now,
    // and a pull's has none: a level pull already set `lastPushedCheckpointId`.
    const landed = last?.targetBranch === link.branch || last?.targetBranch === link.sideBranch;

    if (head === null || (landed && last?.toSha === head.gitSha)) return null;

    return this.requestPush(tx, ref, { actorId: link.linkedBy, trigger: 'auto' });
  }

  /**
   * Spec 044 decision 8: every refusal comes before the commit, because after it a refusal would
   * strand a commit the sandbox has already made. A clean tree still pushes; a taken slot is no
   * error, the commit stands and `operation` is null.
   */
  async commit(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    request: SyncCommitRequest,
  ): Promise<SyncCommitResponse> {
    const project = await this.project(tx, ref);
    const link = await this.links.forProject(tx, ref.orgId, ref.projectId);

    if (link?.state !== 'linked') {
      throw syncConflict('not-linked', 'The project is not linked to a repository.');
    }

    if (project.archived) {
      throw new ConflictError('The project is archived.');
    }

    await this.connections.ensureUsable(tx, ref.orgId);

    // Only auto-sync's trailing edge picks a commit up behind a busy slot; without it, refuse first.
    if (!link.autoSync && (await this.operations.inFlightExists(tx, ref.orgId, ref.projectId))) {
      throw syncConflict('operation-in-flight', 'A push or pull is already in progress.');
    }

    await this.transactions.runInTenantScope({ orgId: ref.orgId, userId: null }, (own) =>
      this.checkpoints.wake(own, ref),
    );

    const checkpoint = await this.checkpoints.commitWorkspace(ref, actorId, request, tx);
    const operation = await this.requestPush(tx, ref, { actorId, trigger: 'manual' });

    return { checkpointId: checkpoint?.id ?? null, operation };
  }

  /** A row of another project is as absent as no row (as the checkpoint read). */
  async byId(tx: TenantTransaction, ref: SandboxRef, id: string): Promise<SyncOperationContract> {
    const row = await this.operations.byId(tx, ref.orgId, id);

    if (row?.projectId !== ref.projectId) {
      throw new NotFoundError('No such sync operation.');
    }

    return this.toContract(row);
  }

  async list(
    tx: TenantTransaction,
    ref: SandboxRef,
    page: { cursor?: string; limit: number },
  ): Promise<SyncPage> {
    await this.project(tx, ref);

    return this.operations.list(tx, ref.orgId, ref.projectId, page);
  }

  toContract(row: SyncRecord): SyncOperationContract {
    return {
      commits: row.commits,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      fromSha: row.fromSha,
      id: row.id,
      kind: row.kind,
      projectId: row.projectId,
      reason: row.reason,
      requestedBy: { id: row.requestedBy, name: row.requestedByName },
      startedAt: row.startedAt?.toISOString() ?? null,
      state: row.state,
      targetBranch: row.targetBranch,
      toSha: row.toSha,
      trigger: row.trigger,
    };
  }

  /** The row's `sync.requested`, on the transaction that inserted it. */
  private async enqueued(
    tx: TenantTransaction,
    ref: SandboxRef,
    id: string,
  ): Promise<SyncOperationContract> {
    await this.outbox.append(tx, {
      aggregateId: id,
      orgId: ref.orgId,
      payload: { orgId: ref.orgId, projectId: ref.projectId, syncOperationId: id },
      type: 'sync.requested',
    });

    return this.byId(tx, ref, id);
  }

  private async project(tx: TenantTransaction, ref: SandboxRef): Promise<{ archived: boolean }> {
    const project = await this.links.project(tx, ref.orgId, ref.projectId);

    if (project === undefined) {
      throw new NotFoundError('No such project.');
    }

    return project;
  }
}

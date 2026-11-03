import { Inject, Injectable } from '@nestjs/common';
import type { SyncKind, SyncOperation as SyncOperationContract } from '@repo/contracts';

import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
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
  constructor(
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
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
        })
      ).id;
    } catch (error) {
      // R7: the partial unique index is the second net — a concurrent request took the slot.
      if (isUniqueViolation(error)) {
        throw syncConflict('operation-in-flight', 'A push or pull is already in progress.');
      }

      throw error;
    }

    await this.outbox.append(tx, {
      aggregateId: id,
      orgId: ref.orgId,
      payload: { orgId: ref.orgId, projectId: ref.projectId, syncOperationId: id },
      type: 'sync.requested',
    });

    return this.byId(tx, ref, id);
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
      toSha: row.toSha,
    };
  }

  private async project(tx: TenantTransaction, ref: SandboxRef): Promise<{ archived: boolean }> {
    const project = await this.links.project(tx, ref.orgId, ref.projectId);

    if (project === undefined) {
      throw new NotFoundError('No such project.');
    }

    return project;
  }
}

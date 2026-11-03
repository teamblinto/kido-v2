import { Inject, Injectable } from '@nestjs/common';
import type { Operation, OperationPage } from '@repo/contracts';
import type { ConnectorOperation, NewConnectorOperation } from '@repo/db';

import { NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { OutboxWriter } from '../outbox/outbox-writer';
import { OperationRepository } from './operation.repository';

/** What a request names; the row's state, reason and timestamps are the repository's. */
export type OperationRequest = Omit<NewConnectorOperation, 'id' | 'orgId' | 'reason' | 'state'>;

/**
 * Spec 030 R15, data-model § 5: a provider write is one `queued` row and its
 * `connector.op.requested` on the same transaction — the request commits with its event or not at
 * all. `ConnectorOpsConsumer` does the work. Refusals are decided by the caller before this runs
 * (contracts/bindings.md § 5); the partial unique index is the last net, answered as `in-flight`.
 */
@Injectable()
export class OperationService {
  constructor(
    @Inject(OperationRepository) private readonly operations: OperationRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {}

  async request(
    tx: TenantTransaction,
    orgId: string,
    request: OperationRequest,
  ): Promise<ConnectorOperation> {
    const row = await this.operations.insertQueued(tx, { ...request, orgId });

    await this.outbox.append(tx, {
      aggregateId: row.id,
      orgId,
      payload: { operationId: row.id, orgId },
      type: 'connector.op.requested',
    });

    return row;
  }

  /** An operation of another project is as absent as no operation (as the sync read). */
  async get(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    id: string,
  ): Promise<Operation> {
    const row = await this.operations.byId(tx, orgId, id);

    if (row?.projectId !== projectId) {
      throw new NotFoundError('No such connector operation.');
    }

    return this.toContract(row);
  }

  async list(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    page: { cursor?: string; kind?: ConnectorOperation['kind']; limit: number },
  ): Promise<OperationPage> {
    const { items, nextCursor } = await this.operations.listForProject(tx, orgId, projectId, page);

    return {
      items: items.map((row) => this.toContract(row)),
      ...(nextCursor === null ? {} : { nextCursor }),
    };
  }

  /** contracts/bindings.md § 4. */
  toContract(row: ConnectorOperation): Operation {
    return {
      bindingId: row.bindingId,
      createdAt: row.createdAt.toISOString(),
      deploymentId: row.deploymentId,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      id: row.id,
      kind: row.kind,
      projectId: row.projectId,
      providerState: row.providerState,
      reason: row.reason,
      requestedBy: row.requestedBy,
      startedAt: row.startedAt?.toISOString() ?? null,
      state: row.state,
    };
  }
}

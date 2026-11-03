import type { TestingModule } from '@nestjs/testing';

import { TenantTransactionRunner } from '../../src/database/tenant-transaction';
import { ConnectionService } from '../../src/modules/connectors/connection.service';
import { ConnectorOpsConsumer } from '../../src/modules/connectors/connector-ops.consumer';
import type { Envelope } from '../../src/modules/outbox/envelope';

/**
 * Spec 030 T041: a connector removal is requested (`connection_remove` queued) and finished by the
 * `connector.ops` consumer. Service-level suites drive both halves in-process — the request, then
 * the consumer's `handle` and `effect` for the queued operation — as the queue would.
 */
export async function removeConnection(
  moduleRef: TestingModule,
  orgId: string,
  userId: string,
  connectionId: string,
): Promise<void> {
  const transactions = moduleRef.get(TenantTransactionRunner, { strict: false });
  const connections = moduleRef.get(ConnectionService, { strict: false });
  const consumer = moduleRef.get(ConnectorOpsConsumer, { strict: false });

  const operation = await transactions.runInTenantTransaction(orgId, (tx) =>
    connections.requestRemoval(tx, orgId, userId, connectionId),
  );
  const event = {
    payload: { operationId: operation.id, orgId },
    type: 'connector.op.requested',
  } as unknown as Envelope<'connector.op.requested'>;
  const job = await transactions.runInTenantTransaction(orgId, (tx) => consumer.handle(event, tx));

  await consumer.effect(event, job);
}

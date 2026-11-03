import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { CONNECTOR_OPS_QUEUE } from './connector-ops.consumer';
import { OperationRepository } from './operation.repository';
import { OperationService } from './operation.service';
import { ResourceRepository } from './resource.repository';

type RemovingEvent = Envelope<'domain.removing'>;

/**
 * `domain.removing` (spec 028) → one `resource_release` operation for the DNS records the
 * Cloudflare connector wrote for that domain (spec 030 FR-012, R15, contracts/provider-adapters.md
 * § 7). On `connector.ops`, beside the ops consumer. 028's own removal is not delayed by it: this
 * only queues, and the release runs as any other operation.
 */
@Injectable()
export class ConnectorDomainConsumer extends EventConsumer<'domain.removing'> {
  readonly attempts = 3;
  /** The queue's worker runs at the lowest concurrency its consumers ask: the ops consumer's. */
  override readonly concurrency = 8;
  readonly name = 'connector-domain';
  override readonly profile = 'events' as const;
  readonly queue = CONNECTOR_OPS_QUEUE;
  readonly types = ['domain.removing'] as const;

  constructor(
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(OperationRepository) private readonly operationRows: OperationRepository,
    @Inject(OperationService) private readonly operations: OperationService,
  ) {
    super();
  }

  async handle(event: RemovingEvent, tx: TenantTransaction): Promise<void> {
    const { domainId, orgId, projectId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const live = (
      await this.resources.listForDomain(tx, orgId, domainId, { liveOnly: true })
    ).filter((row) => row.kind === 'cloudflare_dns_record');

    if (live.length === 0) return;

    // A redelivery finds the release it queued still open, and queues no second one.
    const open = (await this.operationRows.listForDomain(tx, orgId, domainId)).some(
      (row) =>
        row.kind === 'resource_release' && (row.state === 'queued' || row.state === 'running'),
    );

    if (open) return;

    // `resource_id` names the connection the records were written through (the consumer's lookup).
    await this.operations.request(tx, orgId, {
      domainId,
      kind: 'resource_release',
      projectId,
      requestedBy: null,
      resourceId: live[0]!.id,
    });
  }
}

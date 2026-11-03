import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { BindingService } from './binding.service';
import { CONNECTOR_OPS_QUEUE } from './connector-ops.consumer';

/**
 * `project.archived` → every binding of the project released as an unbind with `requestedBy`
 * null (spec 030 T075): its Neon branch deleted, its keys forgotten, then the row gone. On
 * `connector.ops`, beside the ops consumer; this only queues the releases.
 */
@Injectable()
export class ConnectorProjectConsumer extends EventConsumer<'project.archived'> {
  readonly attempts = 3;
  /** The queue's worker runs at the lowest concurrency its consumers ask: the ops consumer's. */
  override readonly concurrency = 8;
  readonly name = 'connector-project';
  override readonly profile = 'events' as const;
  readonly queue = CONNECTOR_OPS_QUEUE;
  readonly types = ['project.archived'] as const;

  constructor(@Inject(BindingService) private readonly bindings: BindingService) {
    super();
  }

  async handle(event: Envelope<'project.archived'>, tx: TenantTransaction): Promise<void> {
    const { orgId, projectId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    await this.bindings.releaseForArchivedProject(tx, orgId, projectId);
  }
}

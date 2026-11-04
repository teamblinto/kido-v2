import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { SyncService } from './sync.service';

export const CONNECTOR_AUTOSYNC_QUEUE = 'connector.autosync';

/**
 * `checkpoint.created` → a push nobody clicked (spec 044 decision 1). Both executors, a hand edit
 * and a revert all end in that event; a `pull` came from GitHub and never goes back. Its own queue
 * because `QueueRegistry` fans one event out by queue, as it does to `RepoMirrorConsumer`.
 *
 * Database work only, so the claim and the request commit together. A redelivery finds the head
 * pushed or the slot taken and `requestAuto` answers null.
 */
@Injectable()
export class AutoSyncConsumer extends EventConsumer<'checkpoint.created'> {
  readonly attempts = 3;
  readonly name = 'connector-autosync';
  override readonly profile = 'events' as const;
  readonly queue = CONNECTOR_AUTOSYNC_QUEUE;
  readonly types = ['checkpoint.created'] as const;

  constructor(
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
    @Inject(SyncService) private readonly syncs: SyncService,
  ) {
    super();
  }

  async handle(event: Envelope<'checkpoint.created'>, tx: TenantTransaction): Promise<void> {
    const { checkpointId, orgId, projectId } = event.payload;
    const ref = { orgId, projectId };

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const checkpoint = await this.checkpoints.byId(tx, ref, checkpointId);

    if (checkpoint.kind !== 'pull') await this.syncs.requestAuto(tx, ref);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { RunStore } from './run-store';

/**
 * The line's own queue, apart from `agent.run`: a release must not wait behind four long runs for
 * a slot, and the registry runs a queue at its slowest consumer's concurrency.
 */
export const AGENT_LINE_QUEUE = 'agent.line';

/**
 * Releases a project (spec 031 research R2): when a run ends, the head of its project's line is
 * dispatched — under the project writer lock, and only when nothing holds the project. The claim
 * gate re-checks all of it, so a spare dispatch is harmless; the processed row makes a duplicate
 * delivery a no-op. The reaper's line sweep is the backstop for a lost event.
 */
@Injectable()
export class RunQueueConsumer extends EventConsumer<'agent-run.finished'> {
  readonly attempts = 5;
  readonly name = 'run-queue';
  override readonly profile = 'agent' as const;
  readonly queue = AGENT_LINE_QUEUE;
  readonly types = ['agent-run.finished'] as const;

  constructor(
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
  ) {
    super();
  }

  async handle(event: Envelope<'agent-run.finished'>, tx: TenantTransaction): Promise<void> {
    const { orgId, projectId } = event.payload;

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    await this.checkpoints.lockProject(tx, { orgId, projectId });

    if ((await this.store.holder(tx, orgId, projectId)) !== undefined) {
      return;
    }

    const [head] = await this.store.line(tx, orgId, projectId);

    if (head !== undefined) {
      await this.store.dispatch(tx, { orgId, projectId, runId: head.id });
    }
  }
}

import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { RunControl } from './run-control';
import { AGENT_LINE_QUEUE } from './run-queue.consumer';
import { RunStore } from './run-store';
import { RunStreamPublisher } from './run-stream-publisher';

/** What `handle` changed, for `effect` to announce once it committed. */
export interface AccessRemovedEffects {
  /** Started runs asked to stop at their next boundary. */
  readonly cancelled: string[];
  /** Never-started runs cancelled outright. */
  readonly waiting: string[];
}

/**
 * Spec 031 FR-019 / research R4: a user removed from a project, or downgraded below
 * `project:agent.run`, loses their runs on it. Waiting runs are cancelled directly with
 * `reason: 'access-lost'`; a started run takes RunService.cancel's cooperative path — the flag on
 * the row here, the control-channel message once committed. The event comes from `tenancy`
 * (`tenancy → agent` would be a cycle).
 */
@Injectable()
export class RunAccessConsumer extends EventConsumer<
  'project.access-removed',
  AccessRemovedEffects
> {
  readonly attempts = 5;
  readonly name = 'run-access';
  override readonly profile = 'agent' as const;
  readonly queue = AGENT_LINE_QUEUE;
  readonly types = ['project.access-removed'] as const;

  constructor(
    @Inject(RunStore) private readonly store: RunStore,
    @Optional() @Inject(RunControl) private readonly control?: RunControl,
    @Optional() @Inject(RunStreamPublisher) private readonly publisher?: RunStreamPublisher,
  ) {
    super();
  }

  async handle(
    event: Envelope<'project.access-removed'>,
    tx: TenantTransaction,
  ): Promise<AccessRemovedEffects> {
    const { orgId, projectId, userId } = event.payload;
    const effects: AccessRemovedEffects = { cancelled: [], waiting: [] };

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    for (const run of await this.store.liveRunsOf(tx, { orgId, projectId, userId })) {
      if (run.startedAt === null && run.status === 'queued') {
        await this.store.transition(tx, {
          from: 'queued',
          orgId,
          reason: 'access-lost',
          runId: run.id,
          to: 'cancelled',
        });
        effects.waiting.push(run.id);
      } else if ((await this.store.requestCancel(tx, orgId, projectId, run.id)) !== undefined) {
        effects.cancelled.push(run.id);
      }
    }

    return effects;
  }

  override async effect(
    event: Envelope<'project.access-removed'>,
    effects: AccessRemovedEffects,
  ): Promise<void> {
    for (const runId of effects.cancelled) {
      await this.control?.publish(runId, 'cancel');
    }

    for (const runId of effects.waiting) {
      await this.publisher?.sync(event.payload.orgId, runId);
    }
  }
}

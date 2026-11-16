import { Inject, Injectable, Optional } from '@nestjs/common';
import { projects } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { parseRunConfig } from '../sandbox/run-config';
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
    @Optional() @Inject(OutboxWriter) private readonly outbox?: OutboxWriter,
  ) {
    super();
  }

  async handle(event: Envelope<'agent-run.finished'>, tx: TenantTransaction): Promise<void> {
    const { orgId, projectId } = event.payload;

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    await this.checkpoints.lockProject(tx, { orgId, projectId });
    await this.restartFailedPreview(tx, event.payload);

    if ((await this.store.holder(tx, orgId, projectId)) !== undefined) {
      return;
    }

    const [head] = await this.store.line(tx, orgId, projectId);

    if (head !== undefined) {
      await this.store.dispatch(tx, { orgId, projectId, runId: head.id });
    }
  }

  /**
   * Spec 047: a run that succeeded while the project's preview was failing (a repair run, or the
   * person's own fix) restarts the dev server now, rather than leaving it parked in the supervisor's
   * five-minute cold retry. `repairs > 0` is that failure streak: a `listening` report resets it.
   * The supervisor reinstalls first if the run changed the manifests.
   */
  private async restartFailedPreview(
    tx: TenantTransaction,
    { orgId, outcome, projectId }: Envelope<'agent-run.finished'>['payload'],
  ): Promise<void> {
    if (outcome !== 'succeeded' || this.outbox === undefined) return;

    const [project] = await tx
      .select({ runConfig: projects.runConfig })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
    if ((parseRunConfig(project?.runConfig)?.repairs ?? 0) === 0) return;

    await this.outbox.append(tx, {
      aggregateId: projectId,
      orgId,
      payload: { orgId, projectId },
      type: 'project.env.changed',
    });
  }
}

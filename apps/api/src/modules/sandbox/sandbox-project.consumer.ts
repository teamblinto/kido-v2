import { Inject, Injectable } from '@nestjs/common';
import { sandboxes } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { OutboxWriter } from '../outbox/outbox-writer';
import { SANDBOX_OPS_QUEUE } from './sandbox.constants';

/**
 * `project.archived` → the project's row goes `releasing` with a `release` op in the same
 * transaction (spec 014 contract § 4, data-model "any → releasing"). No `effect`: the op does the
 * Daytona call. Shares `sandbox.ops` with `SandboxOpsConsumer` — one worker, two types; the
 * registry refuses two consumers on one type, not on one queue — and matches its concurrency so
 * the shared worker keeps 16 (the registry takes the lowest asked for).
 */
@Injectable()
export class SandboxProjectConsumer extends EventConsumer<'project.archived'> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'sandbox-project';
  override readonly profile = 'events' as const;
  readonly queue = SANDBOX_OPS_QUEUE;
  readonly types = ['project.archived'] as const;

  constructor(
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  async handle(event: Envelope<'project.archived'>, tx: TenantTransaction): Promise<void> {
    const { orgId, projectId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const now = this.clock.now();
    const [row] = await tx
      .update(sandboxes)
      .set({ transition: 'releasing', transitionSince: now })
      .where(and(eq(sandboxes.orgId, orgId), eq(sandboxes.projectId, projectId)))
      .returning({ id: sandboxes.id });
    if (row === undefined) return;

    await this.outbox.append(tx, {
      aggregateId: row.id,
      orgId,
      payload: { op: 'release', orgId, sandboxId: row.id },
      type: 'sandbox.op.requested',
    });
  }
}

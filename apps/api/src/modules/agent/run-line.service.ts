import { Inject, Injectable } from '@nestjs/common';
import { RUN_LINE_LIMIT, type RunLineResponse } from '@repo/contracts';
import { users } from '@repo/db';
import { inArray } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { RunStore } from './run-store';

/** `GET …/runs/line` (spec 031 contracts/run-line.md § 2): the holder and who waits behind it. */
@Injectable()
export class RunLineService {
  constructor(@Inject(RunStore) private readonly store: RunStore) {}

  async read(tx: TenantTransaction, orgId: string, projectId: string): Promise<RunLineResponse> {
    const holder = await this.store.holder(tx, orgId, projectId);
    const line = (await this.store.line(tx, orgId, projectId)).slice(0, RUN_LINE_LIMIT);
    const ids = [...new Set([...(holder ? [holder.userId] : []), ...line.map((r) => r.userId)])];
    const emails = new Map<string, string>();

    if (ids.length > 0) {
      for (const row of await tx
        .select({ email: users.email, id: users.id })
        .from(users)
        .where(inArray(users.id, ids))) {
        emails.set(row.id, row.email);
      }
    }

    const startedBy = (userId: string) => ({ email: emails.get(userId) ?? '', userId });

    return {
      holder:
        holder === undefined
          ? null
          : { runId: holder.id, startedBy: startedBy(holder.userId), status: holder.status },
      waiting: line.map((run, index) => ({
        createdAt: run.createdAt.toISOString(),
        position: index + 1,
        runId: run.id,
        startedBy: startedBy(run.userId),
      })),
    };
  }
}

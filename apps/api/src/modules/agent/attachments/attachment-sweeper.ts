import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { RUN_PROFILES_TOKEN } from '../../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../../config/run-profiles';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { AttachmentService } from './attachment.service';

/** `pg_try_advisory_xact_lock` key for one sweep across cron replicas. */
export const ATTACHMENT_SWEEP_LOCK = 7_304_801n;
export const ATTACHMENT_SWEEP_MS = 60 * 60 * 1000;

/**
 * The hourly sweep of pending attachments (spec 048), in the `cron` profile only, under a
 * transaction-scoped advisory lock so two replicas never sweep at once — `AgentHomeScheduler`'s
 * shape. A timer rather than a `maintenance.due` job: the sweep computes from current state, so a
 * lost tick is simply the next one, and no queue is needed for it.
 */
@Injectable()
export class AttachmentSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AttachmentSweeper.name);
  private readonly active: boolean;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(RUN_PROFILES_TOKEN) profiles: ReadonlySet<RunProfile>,
  ) {
    this.active = profiles.has('cron');
  }

  onApplicationBootstrap(): void {
    if (!this.active) return;

    this.timer = setInterval(() => {
      this.inFlight = this.tick().catch((error: unknown) => {
        this.logger.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, ATTACHMENT_SWEEP_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
  }

  /** One sweep; `null` when another replica holds the lock. Public for the suites. */
  async tick(): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${ATTACHMENT_SWEEP_LOCK}) as locked`,
      );

      if (rows[0]?.locked !== true) return null;

      const swept = await this.attachments.sweep();
      if (swept > 0) this.logger.log(`deleted ${String(swept)} pending attachment(s)`);

      return swept;
    });
  }
}

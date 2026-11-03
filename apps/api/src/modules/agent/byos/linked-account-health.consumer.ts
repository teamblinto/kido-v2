import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { EventConsumer } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { ByosProviders } from './byos-providers';
import { ByosTokenService } from './byos-token.service';
import { LinkedAccountRepository } from './linked-account.repository';

export const BYOS_HEALTH_QUEUE = 'byos.health';
/** An account a use, a verify or a refresh checked this recently is not probed again. */
export const CHECKED_WITHIN_MS = 60 * 60_000;
export const SWEEP_PAGE = 500;

type DueEvent = Envelope<'maintenance.due'>;

/**
 * The `byos.verify` arm of `maintenance.due` (spec 032 US5, T044), modelled on
 * `ProviderKeyHealthConsumer`: every linked account of an offered provider not checked within the
 * hour goes through `ByosTokenService.verify`, which runs in that person's own user transaction, so
 * a revoked grant reads `needs_reauth` (and mails its owner once) after one tick. One row's
 * failure is logged by class and the sweep carries on; the sweep itself never throws, so a
 * provider answering 429 does not put the job into a tight retry loop — the next day's tick is
 * the retry.
 */
@Injectable()
export class LinkedAccountHealthConsumer extends EventConsumer<'maintenance.due', boolean> {
  readonly attempts = 3;
  readonly name = 'linked-account-health';
  override readonly profile = 'events' as const;
  readonly queue = BYOS_HEALTH_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(LinkedAccountHealthConsumer.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(ByosProviders) private readonly providers: ByosProviders,
    @Inject(LinkedAccountRepository) private readonly accounts: LinkedAccountRepository,
    @Inject(ByosTokenService) private readonly tokens: ByosTokenService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  /** BullMQ refuses `:` in a custom id, so the period is epoch ms. */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${Date.parse(event.payload.periodStart)}.health`;
  }

  handle(event: DueEvent): Promise<boolean> {
    return Promise.resolve(event.payload.job === 'byos.verify');
  }

  override async effect(_event: DueEvent, due: boolean): Promise<void> {
    if (!due) return;

    this.logger.log(`verified ${String(await this.sweep())} linked account(s)`);
  }

  /** One pass, a page at a time; the count of accounts asked about. */
  async sweep(): Promise<number> {
    const offered = await this.providers.offeredList();
    const olderThan = new Date(this.clock.now().getTime() - CHECKED_WITHIN_MS);
    const seen = new Set<string>();
    let verified = 0;

    for (;;) {
      // `linked_accounts` has no RLS (a root table); the worker reads across users here only.
      const page = await this.accounts.staleForSweep(this.db, offered, olderThan, SWEEP_PAGE);
      const fresh = page.filter((row) => !seen.has(row.id));
      if (fresh.length === 0) return verified;

      for (const row of fresh) {
        seen.add(row.id);
        try {
          await this.tokens.verify(row.userId, row.provider);
          verified += 1;
        } catch (error) {
          const kind = error instanceof Error ? error.name : 'unknown';
          this.logger.warn(
            `BYOS sweep skipped [user=${row.userId} provider=${row.provider} class=${kind}]`,
          );
        }
      }
      if (page.length < SWEEP_PAGE) return verified;
    }
  }
}

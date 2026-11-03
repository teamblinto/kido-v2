import { Inject, Injectable, Logger } from '@nestjs/common';
import { orgs } from '@repo/db';
import { isNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { EventConsumer } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { ProviderKeyService } from './provider-key.service';

export const BYOK_HEALTH_QUEUE = 'byok.health';
/** A key a use (or an on-demand check) verified this recently is not probed again by the sweep. */
export const VERIFIED_WITHIN_MS = 60 * 60_000;

type DueEvent = Envelope<'maintenance.due'>;

/**
 * The `byok.verify` arm of `maintenance.due` (spec 020 US4) on its own queue, on the `events`
 * lane, as `ConnectorHealthConsumer` is spec 018's: every organisation's provider keys put
 * through `ProviderKeyService.verify` — a key the provider now rejects reads `needs_reauth` after
 * one tick, the transition audited once. The period is `MAINTENANCE_JOBS['byok.verify']`'s day.
 *
 * `provider_keys` is under forced RLS and this process holds no bypass role, so the sweep walks
 * every live organisation and opens one tenant transaction each; an organisation without a key
 * lists nothing and costs one transaction.
 */
@Injectable()
export class ProviderKeyHealthConsumer extends EventConsumer<'maintenance.due', boolean> {
  readonly attempts = 3;
  readonly name = 'provider-key-health';
  override readonly profile = 'events' as const;
  readonly queue = BYOK_HEALTH_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(ProviderKeyHealthConsumer.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(ProviderKeyService) private readonly keys: ProviderKeyService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    super();
  }

  /** As `ConnectorHealthConsumer.jobId`: BullMQ refuses `:` in a custom id, so the period is epoch ms. */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${Date.parse(event.payload.periodStart)}.health`;
  }

  handle(event: DueEvent): Promise<boolean> {
    return Promise.resolve(event.payload.job === 'byok.verify');
  }

  override async effect(_event: DueEvent, due: boolean): Promise<void> {
    if (!due) return;

    this.logger.log(`verified ${String(await this.sweep())} provider key(s)`);
  }

  /** One pass over every live organisation; the count of keys asked about. */
  async sweep(): Promise<number> {
    const now = this.clock.now().getTime();
    let verified = 0;
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));

    for (const { id: orgId } of tenants) {
      // One organisation's failure rolls its own transaction back and the sweep carries on.
      try {
        await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          for (const row of await this.keys.list(tx, orgId)) {
            if (now - (row.lastVerifiedAt?.getTime() ?? 0) < VERIFIED_WITHIN_MS) continue;

            await this.keys.verify(tx, orgId, row.provider, null);
            verified += 1;
          }
        });
      } catch (error) {
        this.logger.warn(`sweep skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return verified;
  }
}

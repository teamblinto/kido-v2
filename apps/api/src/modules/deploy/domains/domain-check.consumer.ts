import { Inject, Injectable } from '@nestjs/common';

import { EventConsumer } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { DOMAIN_CHECK_QUEUE } from './domain.constants';
import { DomainChecker } from './domain-checker';

type CheckEvent = Envelope<'domain.check-requested' | 'domain.removing'>;

/**
 * `domain.check-requested` → the same claim/observe/settle as the sweep, for that one domain, at
 * once (spec 028 research R7, FR-012): check-now set its `next_check_at` to now, so the claim
 * finds it due. When a check was in flight, check-now left its lease alone and this finds the row
 * not due; that check's settle sees the request and checks the row again at once. The check is its own transactions and I/O, so `handle` prepares nothing and
 * `effect` runs it with no transaction held. A redelivery after the check settled finds the row
 * under its new `next_check_at` and checks nothing.
 *
 * `domain.removing` runs the same routine, so a removal is deregistered within seconds rather than
 * at the next tick (research R10): the removal set `next_check_at` to now as well.
 */
@Injectable()
export class DomainCheckConsumer extends EventConsumer<
  'domain.check-requested' | 'domain.removing'
> {
  readonly attempts = 3;
  readonly name = 'domain-check';
  override readonly profile = 'events' as const;
  readonly queue = DOMAIN_CHECK_QUEUE;
  readonly types = ['domain.check-requested', 'domain.removing'] as const;

  constructor(@Inject(DomainChecker) private readonly checker: DomainChecker) {
    super();
  }

  handle(): Promise<void> {
    return Promise.resolve();
  }

  override async effect(event: CheckEvent): Promise<void> {
    await this.checker.checkOne(event.payload.orgId, event.payload.domainId);
  }
}

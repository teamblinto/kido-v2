import { Inject, Injectable } from '@nestjs/common';

import type { TenantTransaction } from '../../../database/database.types';
import type { EventPayload } from '../../outbox/events';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { MembershipService } from '../../tenancy/services/membership.service';
import type { Domain } from './domain.repository';

/** The closed set of domain mails (`mail.domain`'s `notice`). */
export type DomainNotice = EventPayload<'mail.domain'>['notice'];

/**
 * The settle's side of a custom-domain notice (spec 028 research R14, FR-022).
 *
 * At each transition that notifies — `→ drifted`, the 7-day release warning, `→ removed` after a
 * drift release, and `→ failed` — the checker calls {@link append} on its settling transaction.
 * Recipients come from tenancy's exported `noticeRecipients` (accepted owners, plus `added_by` while
 * still an accepted member), never from a read of `memberships` here. One `mail.domain` event per
 * recipient, because `MailMessage` has one `to`; the events carry ids only, and
 * `DomainMailConsumer` resolves the address, the hostname and the project at send time.
 *
 * The events commit with the transition or not at all, and the consumer's `jobId` sends each
 * notice once per domain per recipient however often it is appended.
 */
@Injectable()
export class DomainNotices {
  constructor(
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {}

  /** Appends the notice for each recipient on `tx`, and answers who they were. */
  async append(
    tx: TenantTransaction,
    domain: Pick<Domain, 'addedBy' | 'id' | 'orgId'>,
    notice: DomainNotice,
  ): Promise<readonly string[]> {
    const recipients = await this.memberships.noticeRecipients(tx, domain.orgId, domain.addedBy);

    for (const recipient of recipients) {
      await this.outbox.append(tx, {
        aggregateId: domain.id,
        orgId: domain.orgId,
        payload: { domainId: domain.id, notice, recipient },
        type: 'mail.domain',
      });
    }

    return recipients;
  }
}

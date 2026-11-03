import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../../database/database.types';
import { EventConsumer } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { MembershipService } from '../../tenancy/services/membership.service';
import { WEBHOOK_NOTICE_QUEUE } from '../webhooks.constants';
import { EndpointRepository } from './endpoint.repository';

/**
 * The notice side of a pause (spec 029 research R9), 028's `DomainNotices` pattern on its own
 * queue: `webhook.endpoint-paused` becomes one `mail.webhook` per recipient of tenancy's
 * `noticeRecipients` (the accepted owners), appended on the consumer's transaction. The events
 * carry ids and the pause's time; `WebhookMailConsumer` reads the address and the endpoint at send
 * time. An endpoint no longer paused (re-enabled, or deleted) by the time this runs mails no one.
 */
@Injectable()
export class WebhookNoticeConsumer extends EventConsumer<'webhook.endpoint-paused'> {
  readonly attempts = 5;
  override readonly concurrency = 4;
  readonly name = 'webhook-notice';
  override readonly profile = 'events' as const;
  readonly queue = WEBHOOK_NOTICE_QUEUE;
  readonly types = ['webhook.endpoint-paused'] as const;

  constructor(
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {
    super();
  }

  async handle(event: Envelope<'webhook.endpoint-paused'>, tx: TenantTransaction): Promise<void> {
    const { endpointId, orgId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const endpoint = await this.endpoints.byId(tx, orgId, endpointId);
    if (endpoint?.state !== 'paused' || endpoint.pausedAt === null) return;

    const recipients = await this.memberships.noticeRecipients(tx, orgId, null);
    for (const recipientUserId of recipients) {
      await this.outbox.append(tx, {
        aggregateId: endpointId,
        orgId,
        payload: {
          endpointId,
          notice: 'paused',
          orgId,
          pausedAt: endpoint.pausedAt.toISOString(),
          recipientUserId,
        },
        type: 'mail.webhook',
      });
    }
  }
}

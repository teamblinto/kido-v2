import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { EventConsumer } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import type { EventType } from '../../outbox/events';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { DISPATCH_PER_ORG, WEBHOOK_FANOUT_QUEUE } from '../webhooks.constants';
import { EndpointRepository } from './endpoint.repository';
import { INTERNAL_SOURCES, serialiseEnvelope, toPublicEvent } from './public-event';
import { SendRepository } from './send.repository';

/**
 * Internal events → sends (spec 029 plan § Fan-out, FR-011). In the consumer's one transaction,
 * with the event's org set as the tenant: the public envelope is serialised once, one
 * `webhook_sends` row is inserted per matching endpoint (deduplicated on `(endpoint_id,
 * event_id)`, so a redelivered event adds nothing), and one `webhook.attempt-due` is appended per
 * `pending` row while the org's backlog is under `DISPATCH_PER_ORG` (research R9). A pending row
 * past it waits, due, for the next of the org's attempts to finish (which dispatches it) or for
 * the redelivery sweep. A `disabled` or `paused` endpoint gets a `not_sent` row and no attempt, so the log
 * still shows what it missed.
 */
@Injectable()
export class WebhookFanoutConsumer extends EventConsumer<EventType> {
  readonly attempts = 5;
  override readonly concurrency = 8;
  readonly name = 'webhook-fanout';
  override readonly profile = 'events' as const;
  readonly queue = WEBHOOK_FANOUT_QUEUE;
  readonly types = INTERNAL_SOURCES;
  private readonly siteDomain: string;

  constructor(
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(SendRepository) private readonly sends: SendRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    super();
    this.siteDomain = config.get('SITE_DOMAIN', { infer: true });
  }

  async handle(event: Envelope<EventType>, tx: TenantTransaction): Promise<void> {
    const orgId = event.orgId;
    if (orgId === null) return;

    const envelope = toPublicEvent(event, { siteDomain: this.siteDomain });
    if (envelope === null) return;

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const matched = await this.endpoints.matching(tx, orgId, envelope.type, envelope.projectId);
    if (matched.length === 0) return;
    // An endpoint deleted since the match is gone, not a failure: lock the matches in a delete's
    // order and keep the ones still there, so the insert never meets a missing foreign key.
    const present = new Set(
      await this.endpoints.lockPresent(
        tx,
        orgId,
        matched.map((endpoint) => endpoint.id),
      ),
    );
    const matches = matched.filter((endpoint) => present.has(endpoint.id));
    if (matches.length === 0) return;

    const now = this.clock.now();
    const body = serialiseEnvelope(envelope);
    const inserted = await this.sends.insertFanout(
      tx,
      matches.map((endpoint) => ({
        body,
        endpointId: endpoint.id,
        eventId: event.eventId,
        eventType: envelope.type,
        now,
        occurredAt: new Date(event.occurredAt),
        orgId,
        projectId: envelope.projectId,
        state: endpoint.state === 'enabled' ? ('pending' as const) : ('not_sent' as const),
      })),
    );

    const pending = inserted.filter((send) => send.state === 'pending');
    if (pending.length === 0) return;

    // Last, and held only to the commit: the budget check against the org's attempts finishing
    // (research R9). The backlog counts this event's own rows, which are due now.
    await this.sends.lockDispatch(tx, orgId);
    const waiting = (await this.sends.backlog(tx, orgId, now)) - pending.length;
    const budget = Math.max(0, DISPATCH_PER_ORG - waiting);
    for (const send of pending.slice(0, budget)) {
      await this.outbox.append(tx, {
        aggregateId: send.id,
        orgId,
        payload: { orgId, sendId: send.id },
        type: 'webhook.attempt-due',
      });
    }
  }
}

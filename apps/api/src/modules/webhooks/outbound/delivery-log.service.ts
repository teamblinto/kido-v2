import { Inject, Injectable } from '@nestjs/common';
import type {
  WebhookAttempt,
  WebhookAttemptFailure,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookDeliveryListQuery,
  WebhookDeliverySummary,
} from '@repo/contracts';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { NotFoundError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { webhookConflict } from '../webhook.errors';
import { EndpointRepository } from './endpoint.repository';
import { toSummary } from './endpoint.service';
import { type AttemptRow, SendRepository } from './send.repository';

/**
 * An endpoint's delivery log (spec 029 US4, research R11, contracts/webhook-endpoints.md):
 * `list`, `get` and `replay`, every one under its endpoint, so a delivery id read through another
 * endpoint is the same `404` as an unknown one. The log is the 30-day window (FR-028): a row the
 * retention sweep has not reached yet is already gone from here.
 */
@Injectable()
export class DeliveryLogService {
  constructor(
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(SendRepository) private readonly sends: SendRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** `GET …/deliveries`: 50 per page, newest first, filtered by state and event type. */
  async list(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    query: WebhookDeliveryListQuery,
  ): Promise<WebhookDeliveryList> {
    await this.requireEndpoint(tx, orgId, endpointId);
    const page = await this.sends.page(tx, orgId, endpointId, query, this.clock.now());

    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  /** `GET …/deliveries/:deliveryId`: the delivery, its body (null once expired) and its attempts. */
  async get(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    const found =
      isUuid(endpointId) && isUuid(deliveryId)
        ? await this.sends.withAttempts(tx, orgId, endpointId, deliveryId, this.clock.now())
        : undefined;
    if (found === undefined) throw notFound();

    return {
      ...toSummary(found.send),
      attemptLog: found.attempts.map(toAttempt),
      body: found.send.body,
    };
  }

  /**
   * `POST …/deliveries/:deliveryId/replay` (research R11). Refused when the body has expired, or
   * while the delivery is `pending` (an attempt is in flight or already on its way). Otherwise the
   * delivery goes back to `pending`, one manual `webhook.attempt-due` is appended and the replay is
   * audited, all on the caller's transaction. The attempt signs the same event id with a fresh
   * timestamp, is not counted in `attempts`, and a failure of it is final.
   */
  async replay(
    tx: TenantTransaction,
    orgId: string,
    actorId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDeliverySummary> {
    const now = this.clock.now();
    const send =
      isUuid(endpointId) && isUuid(deliveryId)
        ? await this.sends.lockForReplay(tx, orgId, endpointId, deliveryId, now)
        : undefined;
    if (send === undefined) throw notFound();
    if (send.state === 'pending') throw webhookConflict('delivery-in-flight');
    if (send.body === null) throw webhookConflict('delivery-expired');

    const replayed = await this.sends.markReplayed(tx, orgId, send.id, now);
    if (replayed === undefined) throw webhookConflict('delivery-in-flight');

    await this.outbox.append(tx, {
      aggregateId: send.id,
      orgId,
      payload: { manual: true, orgId, sendId: send.id },
      type: 'webhook.attempt-due',
    });
    await this.audit.record(tx, {
      action: 'webhook.send-replayed',
      actorId,
      metadata: { endpointId, eventType: send.eventType, previousState: send.state },
      orgId,
      target: send.id,
    });

    return toSummary(replayed);
  }

  private async requireEndpoint(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
  ): Promise<void> {
    const row = isUuid(endpointId) ? await this.endpoints.byId(tx, orgId, endpointId) : undefined;
    if (row === undefined) throw new NotFoundError('No such webhook endpoint.');
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('No such webhook delivery.');
}

/** A path id that is not a UUID names nothing: the same `404` as an unknown one. */
function isUuid(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

function toAttempt(row: AttemptRow): WebhookAttempt {
  return {
    address: row.address,
    attemptedAt: row.attemptedAt.toISOString(),
    durationMs: row.durationMs,
    failure: row.failure as WebhookAttemptFailure | null,
    manual: row.manual,
    responseBody: row.responseBody,
    responseHeaders: row.responseHeaders,
    status: row.status,
  };
}

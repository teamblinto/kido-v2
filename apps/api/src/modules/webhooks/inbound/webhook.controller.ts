import { Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { Public } from '../../identity/decorators/public.decorator';
import { OutboxWriter } from '../../outbox/outbox-writer';
import {
  GITHUB_WEBHOOK_DELIVERY,
  type GithubWebhookDelivery,
  GithubWebhookGuard,
} from './verifiers/github.verifier';
import { WebhookDeliveryRepository } from './inbound-delivery.repository';

/**
 * The four fields the *consumer* reads, and the one exception in this codebase to Principle II's
 * `strictObject` rule (contracts/webhook.md § 2, ADR 050).
 *
 * `z.object`, not `z.strictObject`, and every field optional. Three reasons, in short — the long
 * form is the ADR:
 *
 * 1. GitHub owns this shape and grows it without notice. Strict would make each addition a 422, the
 *    platform would start refusing valid deliveries, GitHub would disable the endpoint for failing,
 *    and the first symptom anybody saw would be projects quietly going stale.
 * 2. The signature is the security boundary here, not the schema. The bytes were already proved to
 *    come from GitHub before this ran. A shape check adds nothing to that.
 * 3. § 12: processing never happens in the request. Walking a full push payload to decide a 422 is
 *    processing.
 *
 * Unknown keys pass straight through and the **whole** body is stored as `jsonb`. A delivery
 * missing any of these is persisted and left for the consumer to mark `ignored` — never refused,
 * because a refusal tells GitHub the endpoint is broken when the truth is that this is an event we
 * do not act on.
 */
export const webhookEnvelopeSchema = z.object({
  after: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  ref: z.string().optional(),
  repository: z.object({ id: z.number() }).optional(),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

/**
 * `POST /api/v1/webhooks/github` — the inbound half of the connector (spec 026 US4).
 *
 * `@Public()` because there is no session and no principal; `GithubWebhookGuard` is what admits the
 * request, and it has already verified `X-Hub-Signature-256` over the raw bytes before this handler
 * exists. Exempt from CSRF by one exact entry in `SIGNATURE_VERIFIED_WEBHOOK_PATHS`. Outside the
 * tenant transaction entirely: there is no organisation yet to set `app.org_id` to, and finding one
 * would mean doing the lookup in the request.
 *
 * The handler does one thing. In a single transaction it inserts the delivery and appends the
 * outbox event, so "written down" and "enqueued" are one fact (R11) — which is what makes the
 * provider's retry safe by construction. `204` comes from that commit. A duplicate delivery id
 * conflicts, writes nothing, enqueues nothing and answers the same `204`: the provider gets one
 * answer meaning "I have it", and nothing about the response says whether this id has been seen
 * before.
 */
@ApiExcludeController()
@Public()
@UseGuards(GithubWebhookGuard)
@Controller({ path: 'webhooks/github', version: '1' })
export class WebhookController {
  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(WebhookDeliveryRepository) private readonly deliveries: WebhookDeliveryRepository,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Accept a signed delivery from GitHub' })
  @ApiResponse({ description: 'Accepted, or already held', status: 204 })
  @ApiResponse({ description: 'The signature did not verify', status: 401 })
  async receive(@Req() request: { body?: unknown }): Promise<void> {
    // Set by `GithubWebhookGuard`, which has already run: this handler is unreachable without it.
    const { deliveryId, eventType } = (
      request as unknown as Record<PropertyKey, GithubWebhookDelivery>
    )[GITHUB_WEBHOOK_DELIVERY]!;

    const body = isRecord(request.body) ? request.body : {};
    // `safeParse` and not `parse`: a body that does not match is a delivery to record, not a
    // request to refuse. What fails to parse simply carries no installation id, and the consumer
    // ignores it.
    const envelope = webhookEnvelopeSchema.safeParse(body);
    const installationId = envelope.success ? (envelope.data.installation?.id ?? null) : null;

    await this.db.transaction(async (tx) => {
      const id = await this.deliveries.insertIfNew(tx, {
        body,
        deliveryId,
        eventType,
        installationId,
        receivedAt: this.clock.now(),
      });

      // Zero rows: the provider is retrying something we already hold. Acknowledged, not enqueued —
      // enqueuing again would give the consumer a second chance to apply a change that has already
      // been applied, which is the whole thing the dedup key exists to prevent.
      if (id === undefined) return;

      await this.outbox.append(tx, {
        aggregateId: id,
        payload: { deliveryId: id },
        type: 'webhook.received',
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

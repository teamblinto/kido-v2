import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { verifyHmacSignature } from '../../../../common/crypto/hmac-signature';
import { DomainError } from '../../../../common/errors/domain-error';
import type { Environment } from '../../../../config/environment';

/** Where the guard leaves what it read, for the controller (`request[GITHUB_WEBHOOK_DELIVERY]`). */
export const GITHUB_WEBHOOK_DELIVERY = Symbol('forge.connectors.webhookDelivery');

/** The two header values the pipeline needs. Neither is covered by the signature; both are required. */
export interface GithubWebhookDelivery {
  readonly deliveryId: string;
  readonly eventType: string;
}

/** One sentence for every refusal. The reason is in the log, never on the wire (§ 10.7). */
export const WEBHOOK_REJECTION = 'A valid webhook signature is required for this request.';

/** The provider's header names. The verifier below knows none of them — this file is the adapter. */
const SIGNATURE_HEADER = 'x-hub-signature-256';
const DELIVERY_HEADER = 'x-github-delivery';
const EVENT_HEADER = 'x-github-event';

/**
 * The inbound gate (spec 026 contracts/webhook.md § 1 and § 3, research R9 and R10).
 *
 * **Module-scoped**, applied with `@UseGuards` on the one controller that needs it — never an
 * `APP_GUARD`. That is the shape `SandboxCallbackGuard` (spec 017) set for exactly this problem:
 * a route whose caller is a process holding a credential rather than a member holding a session.
 * Principle III's global guard order is not touched, reordered or extended by this feature.
 *
 * It reads `request.rawBody` — the bytes as received, kept by `rawBody: true` on the API factory
 * (ADR 049) — and never `request.body`. Verification happens **before anything parses**, which is
 * the sentence § 12 makes about this endpoint: a body that has not been proved to come from the
 * provider is not a body this application reads.
 *
 * Every way of failing is one `401` with one sentence: no signature, a malformed one, one of the
 * wrong length, one that simply does not match, a missing delivery id, a missing event name. Which
 * check refused measures how close a forgery got, so the sender is not told. The log line says,
 * because the operator is entitled to what the sender is not.
 */
@Injectable()
export class GithubWebhookGuard implements CanActivate {
  private readonly logger = new Logger(GithubWebhookGuard.name);
  private readonly secret: string;

  constructor(config: ConfigService<Environment, true>) {
    this.secret = config.get('GITHUB_WEBHOOK_SECRET', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      rawBody?: Buffer;
    }>();

    const signature = header(request.headers, SIGNATURE_HEADER);
    const deliveryId = header(request.headers, DELIVERY_HEADER);
    const eventType = header(request.headers, EVENT_HEADER);
    const raw = request.rawBody;

    // An absent `rawBody` is a misconfiguration, not an attack — the factory flag was dropped, or
    // a suite built the application without it. It is still refused, and identically: the endpoint
    // has no way to verify anything, so admitting the request would be admitting an unsigned one.
    const because =
      raw === undefined
        ? 'no-raw-body'
        : deliveryId === undefined
          ? 'no-delivery-id'
          : eventType === undefined
            ? 'no-event-type'
            : verifyHmacSignature(raw, signature, this.secret)
              ? undefined
              : 'signature';

    if (because !== undefined) {
      this.logger.warn(`webhook refused [because=${because}]`);

      throw new DomainError('unauthorized', WEBHOOK_REJECTION);
    }

    // Both are defined here: `because` is set when either is missing, and that threw above.
    (request as Record<PropertyKey, unknown>)[GITHUB_WEBHOOK_DELIVERY] = {
      deliveryId: deliveryId!,
      eventType: eventType!,
    } satisfies GithubWebhookDelivery;

    return true;
  }
}

/**
 * One header value, or nothing.
 *
 * A repeated header arrives as an array, and picking the first of them is how a smuggled second
 * signature gets to be the one that counts. There is exactly one right answer to "which signature
 * did you sign with", so more than one is no answer at all.
 */
function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

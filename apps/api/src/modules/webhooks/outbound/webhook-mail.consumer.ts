import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { MAILER, type MailMessage, type MailerPort } from '../../mail/mailer.port';
import { webhookPausedMail } from '../../mail/templates';
import { EventConsumer, classifyMailFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { MembershipService } from '../../tenancy/services/membership.service';
import { EndpointRepository } from './endpoint.repository';
import { SendRepository } from './send.repository';

type WebhookMail = Envelope<'mail.webhook'>;

/**
 * The `mail` lane's key for a webhook notice: `mail.webhook.{notice}.{endpointId}.{pausedAt ms}.
 * {sha256(recipient)}`. Each pause mails each recipient once however often it is appended; a later
 * pause of the same endpoint is a new key. Dots, not colons: BullMQ refuses `:` in a custom id.
 */
export function webhookMailJobId(event: WebhookMail): string {
  const { endpointId, notice, pausedAt, recipientUserId } = event.payload;
  const hashed = createHash('sha256').update(recipientUserId).digest('hex');

  return `mail.webhook.${notice}.${endpointId}.${String(Date.parse(pausedAt))}.${hashed}`;
}

/**
 * The consumer for the webhook-paused mail (spec 029 research R9), modelled on
 * `DomainMailConsumer`: queue `mail`, `events` profile, 5 attempts, concurrency 16.
 *
 * `handle` sets `app.org_id`, then reads what the event only names: the endpoint (still paused, by
 * the same pause), its latest failure and the recipient's current address. It renders; `effect`
 * sends after the commit, and a failed delivery is classified by `classifyMailFailure`. Anything
 * no longer true is skipped with a log line naming the reason, never the URL or the address (§05).
 */
@Injectable()
export class WebhookMailConsumer extends EventConsumer<'mail.webhook', MailMessage | undefined> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'webhook-mail';
  override readonly profile = 'events' as const;
  readonly queue = 'mail';
  readonly types = ['mail.webhook'] as const;

  private readonly appUrl: string;
  private readonly logger = new Logger(WebhookMailConsumer.name);

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(SendRepository) private readonly sends: SendRepository,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    super();
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  async handle(event: WebhookMail, tx: TenantTransaction): Promise<MailMessage | undefined> {
    const { endpointId, orgId, pausedAt, recipientUserId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const endpoint = await this.endpoints.byId(tx, orgId, endpointId);
    if (endpoint === undefined) return this.skip(event, 'no-endpoint');
    if (endpoint.state !== 'paused' || endpoint.pausedAt?.getTime() !== Date.parse(pausedAt)) {
      return this.skip(event, 'moved');
    }

    const to = await this.memberships.noticeAddress(tx, orgId, recipientUserId);
    if (to === undefined) return this.skip(event, 'not-a-member');

    return webhookPausedMail({
      appUrl: this.appUrl,
      endpointUrl: endpoint.url,
      lastFailure: await this.sends.lastFailure(tx, orgId, endpointId),
      to,
    });
  }

  override async effect(event: WebhookMail, message: MailMessage | undefined): Promise<void> {
    if (message === undefined) return;

    const delivery = await this.mailer.send(message);
    if (delivery.outcome === 'failed') {
      this.logger.warn(
        `${event.type} ${event.payload.notice} not delivered: reason=${delivery.failure.reason} ` +
          `retryable=${String(delivery.failure.retryable)}`,
      );
      classifyMailFailure(delivery.failure);
    }
  }

  override jobId(event: WebhookMail): string {
    return webhookMailJobId(event);
  }

  private skip(event: WebhookMail, reason: string): undefined {
    this.logger.warn(`${event.type} ${event.payload.notice} skipped: reason=${reason}`);
    return undefined;
  }
}

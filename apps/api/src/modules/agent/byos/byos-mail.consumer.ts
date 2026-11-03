import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { AccountService } from '../../identity/services/account.service';
import { MAILER, type MailMessage, type MailerPort } from '../../mail/mailer.port';
import { byosAccountMail } from '../../mail/templates';
import { EventConsumer, classifyMailFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';

type ByosMail = Envelope<'mail.byos'>;

/**
 * The consumer for the BYOS account mail (spec 032 contracts § 6, research R1/R10), modelled on
 * `WebhookMailConsumer`: queue `mail`, `events` profile, 5 attempts, concurrency 16.
 *
 * `handle` asks identity for the recipient's notice address (`AccountService.noticeAddress`, over
 * the existing `agent → identity` edge) and never reads `users` itself; no address — a deleted or
 * unverified account — records the event without a send. `effect` sends after the commit, and a
 * failed delivery is classified by `classifyMailFailure`. The job id is the event id: each
 * transition appends one event (R10), so each event mails once however often it is relayed.
 */
@Injectable()
export class ByosMailConsumer extends EventConsumer<'mail.byos', MailMessage | undefined> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'byos-mail';
  override readonly profile = 'events' as const;
  readonly queue = 'mail';
  readonly types = ['mail.byos'] as const;

  private readonly appUrl: string;
  private readonly logger = new Logger(ByosMailConsumer.name);

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    super();
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  async handle(event: ByosMail, _tx: TenantTransaction): Promise<MailMessage | undefined> {
    const { kind, provider, recipientUserId } = event.payload;
    const to = await this.accounts.noticeAddress(recipientUserId);

    if (to === undefined) {
      this.logger.warn(`${event.type} ${kind} skipped: reason=no-notice-address`);
      return undefined;
    }

    return byosAccountMail({ appUrl: this.appUrl, kind, provider, to });
  }

  override async effect(event: ByosMail, message: MailMessage | undefined): Promise<void> {
    if (message === undefined) return;

    const delivery = await this.mailer.send(message);
    if (delivery.outcome === 'failed') {
      this.logger.warn(
        `${event.type} ${event.payload.kind} not delivered: reason=${delivery.failure.reason} ` +
          `retryable=${String(delivery.failure.retryable)}`,
      );
      classifyMailFailure(delivery.failure);
    }
  }

  override jobId(event: ByosMail): string {
    return `mail.byos.${event.eventId}`;
  }
}

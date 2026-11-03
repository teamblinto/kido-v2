import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { AccountService } from '../identity/services/account.service';
import { MAILER, type MailMessage, type MailerPort } from '../mail/mailer.port';
import { localAgentPairedMail } from '../mail/templates';
import { classifyMailFailure, EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { LocalAgentRepository } from './local-agent.repository';

type PairedMail = Envelope<'mail.local-agent-paired'>;

/**
 * The pairing notice (spec 040 § 3 decision 3), modelled on `ByosMailConsumer`: queue `mail`,
 * `events` profile. `handle` reads the device's name and asks identity for the person's notice
 * address; a device already gone or revoked, or a person with no verified address, records the
 * event without a send. The job id is the event id, so each pairing mails once.
 */
@Injectable()
export class LocalAgentMailConsumer extends EventConsumer<
  'mail.local-agent-paired',
  MailMessage | undefined
> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'local-agent-mail';
  override readonly profile = 'events' as const;
  readonly queue = 'mail';
  readonly types = ['mail.local-agent-paired'] as const;

  private readonly appUrl: string;
  private readonly logger = new Logger(LocalAgentMailConsumer.name);

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(LocalAgentRepository) private readonly repository: LocalAgentRepository,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    super();
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  async handle(event: PairedMail, _tx: TenantTransaction): Promise<MailMessage | undefined> {
    const { deviceId, recipientUserId } = event.payload;
    const device = await this.repository.byId(deviceId);

    if (device?.userId !== recipientUserId || device.revokedAt !== null) {
      this.logger.warn(`${event.type} skipped: reason=device-gone`);
      return undefined;
    }

    const to = await this.accounts.noticeAddress(recipientUserId);

    if (to === undefined) {
      this.logger.warn(`${event.type} skipped: reason=no-notice-address`);
      return undefined;
    }

    return localAgentPairedMail({
      appUrl: this.appUrl,
      deviceName: device.name,
      platform: device.platform,
      to,
    });
  }

  override async effect(event: PairedMail, message: MailMessage | undefined): Promise<void> {
    if (message === undefined) return;

    const delivery = await this.mailer.send(message);
    if (delivery.outcome === 'failed') {
      this.logger.warn(
        `${event.type} not delivered: reason=${delivery.failure.reason} ` +
          `retryable=${String(delivery.failure.retryable)}`,
      );
      classifyMailFailure(delivery.failure);
    }
  }

  override jobId(event: PairedMail): string {
    return `mail.local-agent-paired.${event.eventId}`;
  }
}

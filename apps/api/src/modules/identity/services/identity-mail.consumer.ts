import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { MAILER, type MailMessage, type MailerPort } from '../../mail/mailer.port';
import { accountExistsMail, passwordResetMail, verificationMail } from '../../mail/templates';
import { EventConsumer, classifyMailFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import type { EventType } from '../../outbox/events';
import { TokenService } from './token.service';

export type IdentityMailType =
  'mail.account-exists' | 'mail.email-verification' | 'mail.password-reset';

/** Every `mail.*` entry carries its recipient; the id is derived from it and nothing else. */
type MailEventType = Extract<EventType, `mail.${string}`>;

/**
 * The `mail` lane's deduplication key (spec 006 research R3): template, hashed recipient, UTC
 * hour — `mail.<template>.<sha256>.<YYYY-MM-DDTHH>`. The hour is the envelope's `occurredAt`,
 * which the writer stamped from `ClockPort`, so the relay reads no clock and a suite's fake clock
 * moves the boundary. The address is hashed because a job id is a Redis key an operator lists.
 * Dots rather than the colons the design sketched: BullMQ refuses a custom id containing `:`.
 */
export function mailJobId(event: Envelope<MailEventType>): string {
  // `mail.webhook` (spec 029 data-model § 7) names its recipient `recipientUserId`;
  // `mail.project-invitation` (spec 031) carries no address, so the invitation id stands in.
  const { payload } = event;
  const to =
    'recipientUserId' in payload
      ? payload.recipientUserId
      : 'recipient' in payload
        ? payload.recipient
        : payload.invitationId;
  const recipient = createHash('sha256').update(to).digest('hex');

  return `${event.type}.${recipient}.${event.occurredAt.slice(0, 13)}`;
}

/**
 * The consumer for the three identity mails (spec 006, research R1/R5).
 *
 * `handle` is database work on the base's transaction: re-check the subject, issue the token,
 * write its hash row, render. It returns the message and touches no transport — the send is
 * `effect`, which the base runs after the commit with no connection held, so a slow provider
 * cannot hold the pool. A re-check that fails returns `undefined` and the base records the event
 * without a send: a user who verified between the request and the tick is not mailed a link they
 * cannot use.
 *
 * Verification writes the *requested* address, not the user's current one, because `confirm`
 * compares the two (research R2); a request whose address no longer matches is skipped for the
 * same reason. Lifetimes are the flows' own variables, read once here.
 */
@Injectable()
export class IdentityMailConsumer extends EventConsumer<IdentityMailType, MailMessage | undefined> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'identity-mail';
  readonly queue = 'mail';
  readonly types = [
    'mail.account-exists',
    'mail.email-verification',
    'mail.password-reset',
  ] as const;

  private readonly appUrl: string;
  private readonly logger = new Logger(IdentityMailConsumer.name);
  private readonly resetSeconds: number;
  private readonly verificationSeconds: number;

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly tokens: TokenService,
    config: ConfigService<Environment, true>,
  ) {
    super();
    this.appUrl = config.get('APP_URL', { infer: true });
    this.resetSeconds = config.get('PASSWORD_RESET_TTL_SECONDS', { infer: true });
    this.verificationSeconds = config.get('EMAIL_VERIFICATION_TTL_SECONDS', { infer: true });
  }

  async handle(
    event: Envelope<IdentityMailType>,
    tx: TenantTransaction,
  ): Promise<MailMessage | undefined> {
    const { next, recipient, userId } = event.payload;
    const [user] = await tx
      .select({ email: schema.users.email, emailVerifiedAt: schema.users.emailVerifiedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (user === undefined) {
      return this.skip(event.type, 'user-missing');
    }

    // `citext` in the table; the comparison the database would make is not the one `===` makes.
    if (user.email.toLowerCase() !== recipient.toLowerCase()) {
      return this.skip(event.type, 'address-changed');
    }

    switch (event.type) {
      case 'mail.email-verification': {
        if (user.emailVerifiedAt !== null) {
          return this.skip(event.type, 'already-verified');
        }

        const issued = this.tokens.issue(this.verificationSeconds);

        // The hash, never the token; the row commits before the send can start.
        await tx.insert(schema.emailVerificationTokens).values({
          email: recipient,
          expiresAt: issued.expiresAt,
          tokenHash: issued.tokenHash,
          userId,
        });

        return verificationMail({
          appUrl: this.appUrl,
          expiresInMinutes: Math.round(this.verificationSeconds / 60),
          ...(next === undefined ? {} : { next }),
          to: recipient,
          token: issued.token,
        });
      }
      case 'mail.password-reset': {
        const issued = this.tokens.issue(this.resetSeconds);

        await tx.insert(schema.passwordResetTokens).values({
          expiresAt: issued.expiresAt,
          tokenHash: issued.tokenHash,
          userId,
        });

        return passwordResetMail({
          appUrl: this.appUrl,
          expiresInMinutes: Math.round(this.resetSeconds / 60),
          to: recipient,
          token: issued.token,
        });
      }
      case 'mail.account-exists':
        return accountExistsMail({
          appUrl: this.appUrl,
          ...(next === undefined ? {} : { next }),
          to: recipient,
        });
    }
  }

  /** The send, with no transaction held. A refusal throws so the base retries or dead-letters. */
  override async effect(
    event: Envelope<IdentityMailType>,
    message: MailMessage | undefined,
  ): Promise<void> {
    if (message === undefined) {
      return;
    }

    const delivery = await this.mailer.send(message);

    if (delivery.outcome === 'failed') {
      // Template and reason: no address, no token, no link (§05, spec 006 FR-011).
      this.logger.warn(
        `${event.type} not delivered: reason=${delivery.failure.reason} ` +
          `retryable=${String(delivery.failure.retryable)}`,
      );

      classifyMailFailure(delivery.failure);
    }
  }

  override jobId(event: Envelope<IdentityMailType>): string {
    return mailJobId(event);
  }

  private skip(type: IdentityMailType, reason: string): undefined {
    this.logger.warn(`${type} skipped: reason=${reason}`);

    return undefined;
  }
}

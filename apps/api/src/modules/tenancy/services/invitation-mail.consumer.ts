import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { mailJobId } from '../../identity/services/identity-mail.consumer';
import { TokenService } from '../../identity/services/token.service';
import { MAILER, type MailMessage, type MailerPort } from '../../mail/mailer.port';
import { invitationMail } from '../../mail/templates';
import { EventConsumer, classifyMailFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';

/**
 * The consumer for the invitation mail (spec 006, research R1/R5) — in `tenancy` because the
 * token it rotates is `invitations.token_hash`, a row this module owns and reads under RLS.
 *
 * `handle` sets `app.org_id` on the base's transaction first — the statement
 * `TenantTransactionRunner` runs, transaction-scoped, not the runner itself, which would open a
 * second transaction — then re-checks the row is still open, rotates its hash to a token minted
 * now, reads the organisation's name and renders. The producer's insert wrote the hash of a token
 * it dropped on the floor (`token_hash` is `not null`); this rotation is what makes a link exist.
 * `effect` sends with no connection held.
 */
@Injectable()
export class InvitationMailConsumer extends EventConsumer<
  'mail.invitation',
  MailMessage | undefined
> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'invitation-mail';
  readonly queue = 'mail';
  readonly types = ['mail.invitation'] as const;

  private readonly appUrl: string;
  private readonly lifetimeSeconds: number;
  private readonly logger = new Logger(InvitationMailConsumer.name);

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly tokens: TokenService,
    config: ConfigService<Environment, true>,
  ) {
    super();
    this.appUrl = config.get('APP_URL', { infer: true });
    this.lifetimeSeconds = config.get('INVITATION_TTL_SECONDS', { infer: true });
  }

  async handle(
    event: Envelope<'mail.invitation'>,
    tx: TenantTransaction,
  ): Promise<MailMessage | undefined> {
    const { invitationId, recipient } = event.payload;
    const orgId = event.orgId;

    // The writer sets it from the producer's `orgId`; an envelope without one reads nothing under
    // RLS and there is no organisation to set, so it is skipped rather than searched for.
    if (orgId === null) {
      this.logger.warn(`${event.type} skipped: reason=no-org`);

      return undefined;
    }

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const issued = this.tokens.issue(this.lifetimeSeconds);
    const now = this.clock.now();
    // The re-check and the rotation are one statement, so a row accepted between two reads cannot
    // be handed a fresh link. An expired invitation keeps its expiry: the mail would say "expires
    // in a week" about a link that is already dead.
    const [rotated] = await tx
      .update(schema.invitations)
      .set({ tokenHash: issued.tokenHash, updatedAt: now })
      .where(
        and(
          eq(schema.invitations.id, invitationId),
          isNull(schema.invitations.acceptedAt),
          isNull(schema.invitations.revokedAt),
          gt(schema.invitations.expiresAt, now),
        ),
      )
      .returning({ role: schema.invitations.role });

    if (rotated === undefined) {
      this.logger.warn(`${event.type} skipped: reason=not-open`);

      return undefined;
    }

    const [org] = await tx
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    return invitationMail({
      appUrl: this.appUrl,
      expiresInMinutes: Math.round(this.lifetimeSeconds / 60),
      orgId,
      orgName: org?.name ?? 'your organisation',
      role: rotated.role,
      to: recipient,
      token: issued.token,
    });
  }

  override async effect(
    event: Envelope<'mail.invitation'>,
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

  override jobId(event: Envelope<'mail.invitation'>): string {
    return mailJobId(event);
  }
}

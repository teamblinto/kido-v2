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
import { projectInvitationMail } from '../../mail/templates';
import { EventConsumer, classifyMailFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';

/**
 * The project invitation mail (spec 031, contracts/sharing.md § 7), modelled on
 * `InvitationMailConsumer` and for the same reasons: the producer's insert wrote the hash of a
 * token nobody holds, and this rotation — one conditional update that re-checks the row is still
 * open — is what makes a link exist. A withdrawn, accepted or expired row is sent nothing.
 *
 * The payload is ids only (`{orgId, invitationId}`), so the recipient, role, project name and the
 * inviter's address are read here under the org's RLS context. `effect` sends with no connection
 * held.
 */
@Injectable()
export class ProjectInvitationMailConsumer extends EventConsumer<
  'mail.project-invitation',
  MailMessage | undefined
> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'project-invitation-mail';
  readonly queue = 'mail';
  readonly types = ['mail.project-invitation'] as const;

  private readonly appUrl: string;
  private readonly lifetimeSeconds: number;
  private readonly logger = new Logger(ProjectInvitationMailConsumer.name);

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
    event: Envelope<'mail.project-invitation'>,
    tx: TenantTransaction,
  ): Promise<MailMessage | undefined> {
    const { invitationId, orgId } = event.payload;

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const issued = this.tokens.issue(this.lifetimeSeconds);
    const now = this.clock.now();
    const invitations = schema.projectInvitations;
    const [rotated] = await tx
      .update(invitations)
      .set({ tokenHash: issued.tokenHash, updatedAt: now })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.orgId, orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .returning({
        email: invitations.email,
        invitedBy: invitations.invitedBy,
        projectId: invitations.projectId,
        role: invitations.role,
      });

    if (rotated === undefined) {
      this.logger.warn(`${event.type} skipped: reason=not-open`);

      return undefined;
    }

    const [project] = await tx
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, rotated.projectId))
      .limit(1);

    const [inviter] =
      rotated.invitedBy === null
        ? []
        : await tx
            .select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, rotated.invitedBy))
            .limit(1);

    return projectInvitationMail({
      appUrl: this.appUrl,
      expiresInMinutes: Math.round(this.lifetimeSeconds / 60),
      ...(inviter === undefined ? {} : { invitedBy: inviter.email }),
      orgId,
      projectName: project?.name ?? 'a project',
      role: rotated.role,
      to: rotated.email,
      token: issued.token,
    });
  }

  override async effect(
    event: Envelope<'mail.project-invitation'>,
    message: MailMessage | undefined,
  ): Promise<void> {
    if (message === undefined) {
      return;
    }

    const delivery = await this.mailer.send(message);

    if (delivery.outcome === 'failed') {
      // Template and reason: no address, no token, no link.
      this.logger.warn(
        `${event.type} not delivered: reason=${delivery.failure.reason} ` +
          `retryable=${String(delivery.failure.retryable)}`,
      );

      classifyMailFailure(delivery.failure);
    }
  }

  override jobId(event: Envelope<'mail.project-invitation'>): string {
    return mailJobId(event);
  }
}

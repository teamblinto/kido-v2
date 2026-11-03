import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { MAILER, type MailMessage, type MailerPort } from '../../mail/mailer.port';
import {
  type DomainNoticeMailInput,
  domainDriftedMail,
  domainFailedMail,
  domainReleaseWarningMail,
  domainReleasedMail,
} from '../../mail/templates';
import { EventConsumer, classifyMailFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { MembershipService } from '../../tenancy/services/membership.service';
import { ProjectService } from '../../tenancy/services/project.service';
import { RELEASE_AFTER_MS } from './domain.constants';
import { type Domain, decodeDomainCheck } from './domain.repository';
import type { DomainNotice } from './domain-notices';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The state a notice is still true in. A notice whose domain has moved on by the time it is sent
 * (a drift that recovered before the tick, a failed domain retried) is skipped rather than sent
 * stale: the mail would tell somebody to fix what is already fixed.
 */
const STILL_TRUE_IN = {
  drifted: 'drifted',
  failed: 'failed',
  'release-warning': 'drifted',
  released: 'removed',
} as const satisfies Record<DomainNotice, Domain['state']>;

/**
 * The `mail` lane's key for a domain notice (spec 028 research R14):
 * `mail.domain.{notice}.{domainId}.{sha256(recipient)}`. No hour, unlike `mailJobId`: each notice
 * goes once per domain per recipient (FR-022's "once per transition"), so an append repeated by a
 * retried settle sends nothing twice. The recipient is hashed because a job id is a Redis key an
 * operator lists.
 */
export function domainMailJobId(event: Envelope<'mail.domain'>): string {
  const { domainId, notice, recipient } = event.payload;
  const hashed = createHash('sha256').update(recipient).digest('hex');

  return `mail.domain.${notice}.${domainId}.${hashed}`;
}

/**
 * The consumer for the four custom-domain notices (spec 028 research R14, FR-022), modelled on
 * `InvitationMailConsumer`: queue `mail`, `events` profile, 5 attempts.
 *
 * `handle` sets `app.org_id` on the base's transaction, then reads what the event only names: the
 * domain row (still in the state the notice is about), the recipient's address (still an accepted
 * member, through tenancy's `noticeAddress`) and the project's name (tenancy's `deployTarget`). It
 * renders and returns the message; `effect` sends it after the commit with no connection held, and
 * a failed delivery is classified by `classifyMailFailure`. Anything no longer true is skipped with
 * a log line naming the reason — never the hostname or the address (§05).
 */
@Injectable()
export class DomainMailConsumer extends EventConsumer<'mail.domain', MailMessage | undefined> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'domain-mail';
  override readonly profile = 'events';
  readonly queue = 'mail';
  readonly types = ['mail.domain'] as const;

  private readonly appUrl: string;
  private readonly logger = new Logger(DomainMailConsumer.name);
  private readonly target: string | undefined;

  constructor(
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    super();
    this.appUrl = config.get('APP_URL', { infer: true });
    this.target = config.get('CUSTOM_HOSTNAME_TARGET', { infer: true });
  }

  async handle(
    event: Envelope<'mail.domain'>,
    tx: TenantTransaction,
  ): Promise<MailMessage | undefined> {
    const { domainId, notice, recipient } = event.payload;
    const orgId = event.orgId;

    if (orgId === null) {
      return this.skip(event, 'no-org');
    }

    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const [domain] = await tx
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.orgId, orgId), eq(schema.domains.id, domainId)))
      .limit(1);

    if (domain === undefined) {
      return this.skip(event, 'no-domain');
    }

    if (domain.state !== STILL_TRUE_IN[notice]) {
      return this.skip(event, 'moved');
    }

    const to = await this.memberships.noticeAddress(tx, orgId, recipient);

    if (to === undefined) {
      return this.skip(event, 'not-a-member');
    }

    const project = await this.projects.deployTarget(tx, { orgId, projectId: domain.projectId });
    const input: DomainNoticeMailInput = {
      appUrl: this.appUrl,
      hostname: domain.hostname,
      projectId: domain.projectId,
      projectName: project.name,
      target: this.target,
      to,
    };

    switch (notice) {
      case 'drifted':
        return domainDriftedMail(input);
      case 'release-warning':
        return domainReleaseWarningMail({
          ...input,
          releaseInDays: this.daysUntilRelease(domain.driftedAt),
        });
      case 'released':
        return domainReleasedMail(input);
      case 'failed': {
        if (domain.failureReason === null) {
          return this.skip(event, 'no-reason');
        }

        const check = decodeDomainCheck(domain.lastCheck);

        return domainFailedMail({
          ...input,
          caa:
            check?.caa.verdict === 'blocked'
              ? { record: check.caa.record, zone: check.caa.zone }
              : undefined,
          edgeMessage: check?.edgeMessage ?? null,
          reason: domain.failureReason,
        });
      }
    }
  }

  override async effect(
    event: Envelope<'mail.domain'>,
    message: MailMessage | undefined,
  ): Promise<void> {
    if (message === undefined) {
      return;
    }

    const delivery = await this.mailer.send(message);

    if (delivery.outcome === 'failed') {
      // Notice and reason: no address, no hostname (§05).
      this.logger.warn(
        `${event.type} ${event.payload.notice} not delivered: reason=${delivery.failure.reason} ` +
          `retryable=${String(delivery.failure.retryable)}`,
      );

      classifyMailFailure(delivery.failure);
    }
  }

  override jobId(event: Envelope<'mail.domain'>): string {
    return domainMailJobId(event);
  }

  /** Whole days left until the release, at least one: the warning is sent at 23 days drifted. */
  private daysUntilRelease(driftedAt: Date | null): number {
    if (driftedAt === null) {
      return Math.round(RELEASE_AFTER_MS / DAY_MS);
    }

    const left = driftedAt.getTime() + RELEASE_AFTER_MS - this.clock.now().getTime();

    return Math.max(1, Math.ceil(left / DAY_MS));
  }

  private skip(event: Envelope<'mail.domain'>, reason: string): undefined {
    this.logger.warn(`${event.type} ${event.payload.notice} skipped: reason=${reason}`);

    return undefined;
  }
}

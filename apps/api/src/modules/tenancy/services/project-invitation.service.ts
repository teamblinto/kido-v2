import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AcceptProjectInvitationResponse,
  InviteToProjectResponse,
  ProjectAccessResponse,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ForbiddenError, NotFoundError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { DeadTokenError, TokenService } from '../../identity/services/token.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { PermissionCache } from '../../rbac/permission-cache';
import type { ProjectRole } from '../../rbac/permissions';
import { INVITATION_LINK, SENT_TO_A_DIFFERENT_ADDRESS } from './invitation.service';

export interface ProjectInviteRequest {
  readonly actorId: string;
  readonly email: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly role: ProjectRole;
}

export interface ProjectWithdrawRequest {
  readonly actorId: string;
  readonly invitationId: string;
  readonly orgId: string;
  readonly projectId: string;
}

export interface ProjectAcceptRequest {
  readonly actorId: string;
  readonly orgId: string;
  readonly token: string;
}

/**
 * Inviting an address to one project (spec 031 US2, research R5, contracts/sharing.md §§ 1–4).
 *
 * It is `InvitationService` with a project in place of an organisation, and it keeps that class's
 * three structural properties rather than restating them differently:
 *
 * - **{@link invite} never reads `users` or `project_grants`** (FR-020, SC-007). The answer for an
 *   address with no account, one with an account and one that already has access is the same
 *   `202`, because nothing was looked up that could make it differ. An address that already has
 *   access can therefore be invited, and {@link accept} is a no-op-or-raise for them, never a lower.
 * - **The insert comes before the read**, so a double-clicked invite is resolved by the open-row
 *   partial unique index and the loser answers the winner's row.
 * - **The accept claim is a conditional update, first**, so two clicks spend a link once; a refusal
 *   later in the transaction rolls the claim back for the person the link was meant for.
 *
 * The refusals are the org accept's, imported: a dead link — unknown, expired, used or withdrawn —
 * is always `DeadTokenError('unknown', 'invitation link')`, one sentence naming neither project nor
 * organisation (the accept page shows exactly that, R7), and a link opened by another account is
 * the org flow's "sent to a different address".
 *
 * No inviter-rank check: `project:share.external` belongs to `owner` alone, the top project role,
 * so "a role above your own" cannot be asked for — and checking would mean reading `project_grants`
 * at invite time, which the first property forbids.
 */
@Injectable()
export class ProjectInvitationService {
  private readonly lifetimeSeconds: number;

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(PermissionCache) private readonly cache: PermissionCache,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    this.lifetimeSeconds = config.get('INVITATION_TTL_SECONDS', { infer: true });
  }

  /**
   * Who has this project, and who is invited to it (contracts § 1, research R8). Grants only —
   * an org member with no grant has no access and is not listed (FR-023).
   */
  async list(orgId: string, projectId: string): Promise<ProjectAccessResponse> {
    const grants = await this.tenant.tx
      .select({
        email: schema.users.email,
        role: schema.projectGrants.role,
        userId: schema.projectGrants.userId,
      })
      .from(schema.projectGrants)
      .innerJoin(schema.users, eq(schema.users.id, schema.projectGrants.userId))
      .where(
        and(eq(schema.projectGrants.orgId, orgId), eq(schema.projectGrants.projectId, projectId)),
      )
      .orderBy(asc(schema.users.email));

    const invitations = await this.tenant.tx
      .select({
        email: schema.projectInvitations.email,
        expiresAt: schema.projectInvitations.expiresAt,
        id: schema.projectInvitations.id,
        role: schema.projectInvitations.role,
      })
      .from(schema.projectInvitations)
      .where(and(this.open(), eq(schema.projectInvitations.projectId, projectId)))
      .orderBy(asc(schema.projectInvitations.createdAt));

    return {
      grants,
      invitations: invitations.map((row) => ({
        ...row,
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  }

  /** Issue an invitation, or answer the one already open for this address on this project. */
  async invite(request: ProjectInviteRequest): Promise<InviteToProjectResponse> {
    const { actorId, email, orgId, projectId, role } = request;
    const issued = this.tokens.issue(this.lifetimeSeconds);

    const [inserted] = await this.tenant.tx
      .insert(schema.projectInvitations)
      .values({
        email,
        expiresAt: issued.expiresAt,
        invitedBy: actorId,
        orgId,
        projectId,
        role,
        // A token nobody holds: the mail consumer rotates it before anything is sent (spec 006).
        tokenHash: issued.tokenHash,
      })
      .onConflictDoNothing()
      .returning({
        expiresAt: schema.projectInvitations.expiresAt,
        id: schema.projectInvitations.id,
      });

    if (inserted === undefined) {
      return this.openInvitation(orgId, projectId, email);
    }

    await this.audit.record(this.tenant.tx, {
      action: 'project-invitation.created',
      actorId,
      metadata: { email, projectId, role },
      orgId,
      target: inserted.id,
    });

    await this.outbox.append(this.tenant.tx, {
      aggregateId: inserted.id,
      orgId,
      payload: { invitationId: inserted.id, orgId },
      type: 'mail.project-invitation',
    });

    return {
      expiresAt: inserted.expiresAt.toISOString(),
      id: inserted.id,
      status: 'invitation-sent',
    };
  }

  /** Withdraw an open invitation. The token stops working when this commits. */
  async withdraw(request: ProjectWithdrawRequest): Promise<void> {
    const { actorId, invitationId, orgId, projectId } = request;
    const now = this.clock.now();

    const [revoked] = await this.tenant.tx
      .update(schema.projectInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.projectInvitations.orgId, orgId),
          eq(schema.projectInvitations.projectId, projectId),
          eq(schema.projectInvitations.id, invitationId),
          isNull(schema.projectInvitations.acceptedAt),
          isNull(schema.projectInvitations.revokedAt),
        ),
      )
      .returning({ email: schema.projectInvitations.email, role: schema.projectInvitations.role });

    if (revoked === undefined) {
      throw new NotFoundError('No such open invitation on this project.');
    }

    await this.audit.record(this.tenant.tx, {
      action: 'project-invitation.revoked',
      actorId,
      metadata: { email: revoked.email, projectId, role: revoked.role },
      orgId,
      target: invitationId,
    });
  }

  /**
   * Spend a project invitation link: claim, check the address, grant.
   *
   * The grant is an upsert that never lowers (data-model § 3). `project_role` is declared
   * `owner, editor, commenter, viewer`, and Postgres orders an enum by declaration, so the higher
   * of two roles is the *lesser* enum value — `least(existing, invited)` is `greatest` by rank.
   */
  async accept(request: ProjectAcceptRequest): Promise<AcceptProjectInvitationResponse> {
    const { actorId, orgId, token } = request;
    const now = this.clock.now();
    const tokenHash = this.tokens.fingerprint(token);

    const [claimed] = await this.tenant.tx
      .update(schema.projectInvitations)
      .set({ acceptedAt: now, acceptedBy: actorId, updatedAt: now })
      .where(and(this.open(now), eq(schema.projectInvitations.tokenHash, tokenHash)))
      .returning();

    if (claimed === undefined) {
      // Unknown, expired, used or withdrawn: one refusal, naming nothing (R7).
      throw new DeadTokenError('unknown', INVITATION_LINK);
    }

    const [caller] = await this.tenant.tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actorId))
      .limit(1);

    if (caller?.email.toLowerCase() !== claimed.email.toLowerCase()) {
      throw new ForbiddenError(SENT_TO_A_DIFFERENT_ADDRESS);
    }

    const grants = schema.projectGrants;

    await this.tenant.tx
      .insert(grants)
      .values({ orgId, projectId: claimed.projectId, role: claimed.role, userId: actorId })
      .onConflictDoUpdate({
        set: { role: sql`least(${grants.role}, excluded.role)`, updatedAt: now },
        target: [grants.orgId, grants.projectId, grants.userId],
      });

    await this.audit.record(this.tenant.tx, {
      action: 'project-invitation.accepted',
      actorId,
      metadata: { email: claimed.email, projectId: claimed.projectId, role: claimed.role },
      orgId,
      target: claimed.id,
    });

    // As `ProjectGrantService` does: the permission set is deleted after the commit (§09).
    this.tenant.onCommit(async () => {
      await this.cache.invalidate(orgId, actorId);
    });

    return { projectId: claimed.projectId };
  }

  /** Open ⇔ not accepted, not withdrawn, not expired (data-model § 2). */
  private open(now: Date = this.clock.now()) {
    return and(
      isNull(schema.projectInvitations.acceptedAt),
      isNull(schema.projectInvitations.revokedAt),
      gt(schema.projectInvitations.expiresAt, now),
    );
  }

  /** The row a conflicting insert lost to. */
  private async openInvitation(
    orgId: string,
    projectId: string,
    email: string,
  ): Promise<InviteToProjectResponse> {
    const [open] = await this.tenant.tx
      .select({
        expiresAt: schema.projectInvitations.expiresAt,
        id: schema.projectInvitations.id,
      })
      .from(schema.projectInvitations)
      .where(
        and(
          eq(schema.projectInvitations.orgId, orgId),
          eq(schema.projectInvitations.projectId, projectId),
          eq(schema.projectInvitations.email, email),
          isNull(schema.projectInvitations.acceptedAt),
          isNull(schema.projectInvitations.revokedAt),
        ),
      )
      .limit(1);

    if (open === undefined) {
      throw new NotFoundError('That invitation is no longer open. Try inviting the address again.');
    }

    return { expiresAt: open.expiresAt.toISOString(), id: open.id, status: 'invitation-sent' };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INVITATION_ACCEPTED,
  INVITATION_SENT,
  type AcceptInvitationResponse,
  type InvitationAcceptedResponse,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ForbiddenError, NotFoundError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { DeadTokenError, TokenService } from '../../identity/services/token.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import type { OrgRole } from '../../rbac/permissions';
import { MembershipService } from './membership.service';

/**
 * The noun {@link DeadTokenError} composes its three refusals from, for this flow. Exported for
 * spec 031's project invitation, whose refusals are this flow's, word for word.
 */
export const INVITATION_LINK = 'invitation link';

const LINK = INVITATION_LINK;

/** Said to a signed-in caller holding somebody else's link — here and for a project invitation. */
export const SENT_TO_A_DIFFERENT_ADDRESS = 'That invitation was sent to a different address.';

/**
 * The `owner ⊇ admin ⊇ member` ladder, as a number — the same one `MembershipService` uses, and for
 * the same question: may this actor confer that role. `billing` sits at the bottom because somebody
 * holding only it may confer nothing, including their own role.
 */
const RANK = Object.freeze({
  admin: 2,
  billing: 1,
  member: 1,
  owner: 3,
} as const satisfies Readonly<Record<OrgRole, number>>);

/** The same sentence `MembershipService` says, because it is the same refusal. */
const ABOVE_YOUR_OWN = 'You cannot confer or withdraw a role above your own.';

/** What issuing an invitation needs. The organisation comes from the route, never from the body. */
export interface InviteRequest {
  readonly actorId: string;
  readonly email: string;
  readonly orgId: string;
  readonly role: OrgRole;
}

/** What accepting one needs: the link's token, and the organisation the link carried beside it. */
export interface AcceptRequest {
  readonly actorId: string;
  readonly orgId: string;
  readonly token: string;
}

/**
 * Invitations (T29, success criterion 10) — the only way somebody joins an organisation they did
 * not create.
 *
 * ## Why this endpoint is not an account-existence oracle
 *
 * The requirement is that inviting an address must not reveal whether that address has a Forge
 * account. The usual answers to that are a constant response and a carefully equalised set of
 * branches, and both are the kind of property a later refactor quietly breaks.
 *
 * This one is structural instead: **{@link invite} never reads `users`.** It cannot leak what it
 * does not look up. An invitation is a row keyed by `(org_id, email)` and a mail to that address —
 * there is no account to find, no membership to compare against, and therefore no branch whose
 * outcome could differ between an address that has an account and one that does not. Everything
 * that needs a user id happens in {@link accept}, where the caller is the account holder and is
 * authenticated as themselves.
 *
 * The one thing that follows from it is worth stating plainly: an address that is already a member
 * *can* be issued an invitation, because nothing looked. {@link accept} therefore has to be a no-op
 * for somebody who is already in the organisation rather than a unique-key violation — the reader
 * clicked a link that was genuinely sent to them and must not get a 500 for it.
 *
 * ## The two writes, and the transaction they share
 *
 * Both entry points run inside the tenant transaction `TenantContextInterceptor` opened, so the
 * audit row lives or dies with the state change it records — the spec's "every write that a security
 * team would ask about calls `AuditService` in the same transaction". Acceptance adds the membership
 * through {@link MembershipService.add}, which is also where §11's permission-cache invalidation
 * happens, queued for after the commit. Reimplementing either here would be a second place for the
 * invalidation to be forgotten.
 *
 * ## Why the mail is an outbox row
 *
 * A mail is not transactional. Sending it inline would deliver a working link for an invitation that
 * a later statement in the same transaction rolled back — a link whose row does not exist. The
 * event is appended on the same transaction as the row and the audit entry (spec 006, ADR 030), so
 * it is published exactly when they commit; `InvitationMailConsumer` rotates `token_hash` to a
 * token it mints and mails it. The hash this class inserts belongs to a token nobody holds —
 * `token_hash` is `not null`, and a link exists only once the consumer has run.
 */
@Injectable()
export class InvitationService {
  private readonly lifetimeSeconds: number;

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    this.lifetimeSeconds = config.get('INVITATION_TTL_SECONDS', { infer: true });
  }

  /**
   * Issue an invitation, or hand back the one that is already open for this address.
   *
   * The insert comes before the read rather than after it, which is what makes a double-clicked
   * invite safe: `invitations_org_id_email_open_key` is a partial unique index over the open rows,
   * so two concurrent inserts are resolved by the database and the loser reads the winner's row.
   * Checking first and inserting second would leave a window in which both callers see nothing, and
   * `schema/rbac.ts` is explicit about what must not come out of it — "two links that both work".
   *
   * The token is minted before the insert and thrown away on every path: the column is `not null`
   * and the consumer rotates it before anything is mailed (spec 006). That costs 32 bytes of
   * entropy and nothing else.
   */
  async invite(request: InviteRequest): Promise<InvitationAcceptedResponse> {
    const { actorId, email, orgId, role } = request;
    const actor = await this.roleOf(orgId, actorId);

    // §11's second layer, and the rule `MembershipService.changeRole` holds for an existing member.
    // `org:members.invite` belongs to `admin`, so without this an admin could invite an accomplice
    // as `owner` and be outranked by their own invitation as soon as it was accepted.
    if (RANK[role] > RANK[actor]) {
      throw new ForbiddenError(ABOVE_YOUR_OWN);
    }

    const issued = this.tokens.issue(this.lifetimeSeconds);
    const [inserted] = await this.tenant.tx
      .insert(schema.invitations)
      .values({
        email,
        expiresAt: issued.expiresAt,
        invitedBy: actorId,
        orgId,
        role,
        // The digest, never the token. A database disclosure must not be a working invitation.
        tokenHash: issued.tokenHash,
      })
      .onConflictDoNothing()
      .returning({ expiresAt: schema.invitations.expiresAt, id: schema.invitations.id });

    if (inserted === undefined) {
      return this.openInvitation(orgId, email);
    }

    await this.audit.record(this.tenant.tx, {
      action: 'invitation.created',
      actorId,
      // The address belongs here — `AuditEntry.metadata` names it as an example, and an organisation's
      // owners reviewing the trail need to know who was invited. The token does not, and is absent.
      metadata: { email, role },
      orgId,
      target: inserted.id,
    });

    // After the audit row, on the same handle: the mail is accepted when the invitation is.
    await this.outbox.append(this.tenant.tx, {
      aggregateId: inserted.id,
      orgId,
      payload: { invitationId: inserted.id, recipient: email },
      type: 'mail.invitation',
    });

    return {
      expiresAt: inserted.expiresAt.toISOString(),
      id: inserted.id,
      status: INVITATION_SENT,
    };
  }

  /**
   * Spend an invitation link.
   *
   * The claim is a conditional update and it comes first, which is the whole of the single-use
   * story: two clicks at the same instant are two updates against `accepted_at is null`, one matches
   * a row and one does not. `TokenService` spells the statement out and argues the ordering; a
   * read-then-write would let both through, and the window is exactly as wide as a double-clicked
   * mail link.
   *
   * Claiming *before* checking who is asking looks backwards and is not. Everything here runs in one
   * transaction, so a refusal below rolls the claim back with it — the link is still open for the
   * person it was sent to, which is what `invitation.service.spec.ts` holds down. Doing the identity
   * check first would open a read-then-write window in the one statement that must not have one.
   */
  async accept(request: AcceptRequest): Promise<AcceptInvitationResponse> {
    const { actorId, orgId, token } = request;
    const now = this.clock.now();
    const tokenHash = this.tokens.fingerprint(token);

    const [claimed] = await this.tenant.tx
      .update(schema.invitations)
      .set({ acceptedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.invitations.tokenHash, tokenHash),
          isNull(schema.invitations.acceptedAt),
          isNull(schema.invitations.revokedAt),
          gt(schema.invitations.expiresAt, now),
        ),
      )
      .returning();

    if (claimed === undefined) {
      throw await this.refusal(tokenHash);
    }

    await this.requireInvitedAddress(actorId, claimed.email);

    const { joined, role } = await this.join(claimed.role, claimed.invitedBy, orgId, actorId);

    await this.audit.record(this.tenant.tx, {
      action: 'invitation.accepted',
      actorId,
      metadata: { email: claimed.email, role },
      orgId,
      target: claimed.id,
    });

    // Spec 029 T041: the webhook fan-out's source for `member.joined`. Only a new membership is a
    // join; somebody who was already a member accepted a link, and joined nothing.
    if (joined) {
      await this.outbox.append(this.tenant.tx, {
        aggregateId: actorId,
        orgId,
        payload: { orgId, role, userId: actorId },
        type: 'member.joined',
      });
    }

    return { orgId, role, status: INVITATION_ACCEPTED };
  }

  /**
   * Add the membership, unless there already is one.
   *
   * Returns whether a membership was added, and the role that is actually in force, which for somebody who was already a member is the
   * role they joined with and not the one the second invitation named. An invitation is not a
   * promotion: `org:members.role-change` is the route that exists for that, behind its own permission
   * and its own audit entry, and quietly re-roling somebody who clicked a link would bypass both.
   */
  private async join(
    role: OrgRole,
    invitedBy: string | null,
    orgId: string,
    userId: string,
  ): Promise<{ joined: boolean; role: OrgRole }> {
    const [existing] = await this.tenant.tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
      .limit(1);

    if (existing !== undefined) {
      return { joined: false, role: existing.role };
    }

    // `MembershipService` owns the insert, the `membership.created` entry and — the part that must
    // not be duplicated — §11's permission-cache invalidation, queued for after the commit.
    await this.memberships.add({ invitedBy, orgId, role, userId });

    return { joined: true, role };
  }

  /**
   * The invitation names an address and the token travels to it by mail. Binding the two is what
   * stops a forwarded link, or one pasted into a group chat, from being a membership: without it the
   * first authenticated person to open somebody else's link joins the organisation, and the audit row
   * names them as though they had been invited.
   *
   * Case-insensitive because both sides are `citext` in the database and normalised at their own
   * boundary; comparing the two raw strings would make an invitation to `Ada@…` unusable by the
   * account stored as `ada@…`.
   */
  private async requireInvitedAddress(userId: string, invited: string): Promise<void> {
    const [caller] = await this.tenant.tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (caller?.email.toLowerCase() !== invited.toLowerCase()) {
      // Deliberately says nothing about the address the invitation names. The caller is holding a
      // link that is not theirs, and telling them whose it is would make a forwarded invitation an
      // address-disclosure tool.
      throw new ForbiddenError(SENT_TO_A_DIFFERENT_ADDRESS);
    }
  }

  /** The row a conflicting insert lost to. Its absence would mean it was accepted in between. */
  private async openInvitation(orgId: string, email: string): Promise<InvitationAcceptedResponse> {
    const [open] = await this.tenant.tx
      .select({ expiresAt: schema.invitations.expiresAt, id: schema.invitations.id })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, orgId),
          eq(schema.invitations.email, email),
          isNull(schema.invitations.acceptedAt),
          isNull(schema.invitations.revokedAt),
        ),
      )
      .limit(1);

    if (open === undefined) {
      // The open row was accepted or withdrawn between the insert and this read. Rare, and a retry
      // is the honest answer: the next attempt inserts cleanly.
      throw new NotFoundError('That invitation is no longer open. Try inviting the address again.');
    }

    return { expiresAt: open.expiresAt.toISOString(), id: open.id, status: INVITATION_SENT };
  }

  /**
   * Why a token that claimed nothing claimed nothing — the follow-up select `TokenService` requires,
   * fed to the same four-way verdict the other two flows use.
   *
   * A withdrawn invitation is reported as one we do not recognise rather than as one already used.
   * The three slugs describe what the *holder* did with a link, and somebody whose invitation was
   * revoked did nothing; "already used" would send them looking for a click they never made, and the
   * organisation's decision to withdraw it is not this endpoint's to announce.
   */
  private async refusal(tokenHash: string): Promise<DeadTokenError> {
    const [record] = await this.tenant.tx
      .select({
        acceptedAt: schema.invitations.acceptedAt,
        expiresAt: schema.invitations.expiresAt,
        revokedAt: schema.invitations.revokedAt,
      })
      .from(schema.invitations)
      .where(eq(schema.invitations.tokenHash, tokenHash))
      .limit(1);

    if (record === undefined) {
      return new DeadTokenError('unknown', LINK);
    }

    if (record.revokedAt !== null) {
      return new DeadTokenError('unknown', LINK);
    }

    const verdict = this.tokens.verdict({
      consumedAt: record.acceptedAt,
      expiresAt: record.expiresAt,
    });

    // `valid` is unreachable: the claim ran against the same instant and the same two conditions, so
    // a row this select finds live is one the update would have taken. Mapped rather than asserted,
    // because a 500 is a poor answer to a race that resolves itself on the next click.
    return new DeadTokenError(verdict === 'valid' ? 'unknown' : verdict, LINK);
  }

  /** The caller's own role. Reached only from a route `@RequirePermission` already admitted. */
  private async roleOf(orgId: string, userId: string): Promise<OrgRole> {
    const [row] = await this.tenant.tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
      .limit(1);

    if (row === undefined) {
      throw new ForbiddenError(ABOVE_YOUR_OWN);
    }

    return row.role;
  }
}
